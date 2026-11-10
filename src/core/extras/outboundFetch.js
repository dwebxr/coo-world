// The server's fetch for URLs it did not choose itself (Node only: the server and the node agent).
//
// App scripts call fetch() on the server, and blueprints name remote models and scripts the server loads. A
// builder picks those URLs, so without a policy the server can be pointed at its own loopback, its private
// network and cloud metadata addresses, and made to download without end. This fetch only reaches public
// addresses, and bounds time, size and concurrency:
//
//   - http and https only, no credentials in the URL
//   - the host is resolved once and every address it resolves to must be public; the connection is then made to
//     one of those addresses, not to the name, so a second DNS answer cannot redirect it (DNS rebinding). An IP
//     literal is checked directly (Node never calls a lookup hook for one), and the connected socket's remote
//     address is checked again
//   - redirects are followed here, at most `maxRedirects`, each hop through the same checks
//   - responses are decoded from gzip/deflate only (a Brotli body is refused, see fetchGuard.js), and reading
//     stops at `maxBytes` of decoded body; all responses in flight share `budgetBytes`
//   - one deadline covers the whole request, redirects and body included
//   - at most `concurrency` requests at once, and `perKey` per caller key (an app); more are refused, not queued
//
// Origins the operator configured (the world's own assets URL) are trusted: no address check, since in
// development and with a private object store they are local on purpose.
//
// Built on node:http/https directly: the checks sit at the socket, where the global fetch offers no hook.

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { lookup as dnsLookup } from 'node:dns'

export const OUTBOUND_DEFAULTS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxRequestBytes: 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 3,
  concurrency: 16,
  perKey: 4,
  budgetBytes: 64 * 1024 * 1024,
})

// addresses that are not on the public internet
const blocked = new net.BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (and some cloud-internal ranges)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
]) {
  blocked.addSubnet(address, prefix, 'ipv4')
}
for (const [address, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64: an IPv4 address behind it is not checked here, so the range is refused
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 23], // protocol assignments (Teredo, ORCHID, ...)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['fc00::', 7], // unique local (private networks, Fly's 6PN)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
]) {
  blocked.addSubnet(address, prefix, 'ipv6')
}

// whether an IP address (v4, v6, or v4-mapped v6) is one the server may connect to for an untrusted URL
export function isPublicAddress(address) {
  const family = net.isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6) return !blocked.check(address, 'ipv6') // BlockList applies the IPv4 rules to ::ffff:a.b.c.d
  return false
}

export class OutboundError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OutboundError'
    this.code = code
  }
}

const refuse = (code, message) => new OutboundError(code, `outbound request refused: ${message}`)

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
// set here or meaningless on a forwarded request
const DROPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'expect',
])
// not carried to another origin by a redirect
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie'])

const hostOf = url => (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname)

function resolveAll(lookup, host) {
  return new Promise((resolve, reject) => {
    lookup(host, { all: true }, (err, addresses) => {
      if (err) return reject(err)
      resolve(Array.isArray(addresses) ? addresses : [])
    })
  })
}

async function toBuffer(body) {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') return Buffer.from(body)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer()) // a Blob
  throw refuse('body', 'unsupported request body')
}

export function createOutboundFetch(options = {}) {
  const config = { ...OUTBOUND_DEFAULTS, ...options }
  const lookup = options.lookup || dnsLookup
  // tests reach a local server through this; production keeps the default
  const isAllowedAddress = options.isAllowedAddress || isPublicAddress
  const trusted = new Set()
  for (const origin of options.trustedOrigins || []) {
    try {
      trusted.add(new URL(origin).origin)
    } catch {
      // not a URL: trusts nothing
    }
  }
  let active = 0
  const activeByKey = new Map()
  let buffered = 0 // decoded response bytes held by requests in flight

  // where to connect for this URL: { address, family } for a checked address, or null for a trusted origin
  async function destination(url) {
    if (trusted.has(url.origin)) return null
    const host = hostOf(url)
    if (net.isIP(host)) {
      if (!isAllowedAddress(host)) throw refuse('address', 'the address is not public')
      return { address: host, family: net.isIP(host) }
    }
    let addresses
    try {
      addresses = await resolveAll(lookup, host)
    } catch (err) {
      throw new OutboundError('dns', `outbound request failed: could not resolve the host (${err?.code || 'error'})`)
    }
    if (!addresses.length) throw new OutboundError('dns', 'outbound request failed: the host has no address')
    // all of them: a name that also resolves to a private address is not one to pick an answer from
    for (const entry of addresses) {
      if (!isAllowedAddress(entry.address))
        throw refuse('address', 'the host resolves to an address that is not public')
    }
    return { address: addresses[0].address, family: addresses[0].family }
  }

  // one request/response exchange (no redirect handling): resolves { status, statusText, headers, body } with
  // the decoded body, or { redirect } for a redirect status with a Location
  function exchange(url, { method, headers, body, signal, deadline, onBytes }) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (err, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (err) {
          req?.destroy()
          reject(err)
        } else resolve(value)
      }
      const onAbort = () => finish(new OutboundError('aborted', 'outbound request aborted'))
      const timer = setTimeout(
        () => finish(new OutboundError('timeout', 'outbound request failed: it took too long')),
        Math.max(0, deadline - Date.now())
      )
      let req = null
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      destination(url).then(target => {
        if (settled) return
        const secure = url.protocol === 'https:'
        const requestOptions = {
          protocol: url.protocol,
          hostname: hostOf(url),
          port: url.port || (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers: { ...headers, host: url.host, 'accept-encoding': 'gzip, deflate' },
          agent: false, // one connection per request: no socket is reused across destinations
        }
        if (body) requestOptions.headers['content-length'] = String(body.length)
        if (target && !net.isIP(requestOptions.hostname)) {
          // connect to the address that was checked; the name still goes out as Host and TLS server name
          requestOptions.lookup = (hostname, opts, callback) => {
            if (opts?.all) callback(null, [{ address: target.address, family: target.family }])
            else callback(null, target.address, target.family)
          }
        }
        req = (secure ? https : http).request(requestOptions)
        req.on('socket', socket => {
          const check = () => {
            if (target && !isAllowedAddress(socket.remoteAddress || '')) {
              finish(refuse('address', 'connected to an address that is not public'))
            }
          }
          if (socket.connecting) socket.once('connect', check)
          else check()
        })
        req.on('error', err => {
          finish(new OutboundError('network', `outbound request failed: ${err?.code || 'network error'}`))
        })
        req.on('response', res => {
          const status = res.statusCode
          const location = res.headers.location
          if (REDIRECTS.has(status) && location) {
            res.resume()
            return finish(null, { redirect: location, status })
          }
          const encoding = String(res.headers['content-encoding'] || 'identity')
            .trim()
            .toLowerCase()
          let stream = res
          if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip())
          else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
          else if (encoding !== 'identity' && encoding !== '') {
            return finish(
              refuse('encoding', `content-encoding ${JSON.stringify(encoding.slice(0, 24))} is not accepted`)
            )
          }
          const chunks = []
          let size = 0
          stream.on('data', chunk => {
            if (settled) return
            size += chunk.length
            if (size > config.maxBytes) {
              return finish(refuse('too_large', `the response is larger than ${config.maxBytes} bytes`))
            }
            if (!onBytes(chunk.length)) {
              return finish(refuse('busy', 'too much response data is being held; try again later'))
            }
            chunks.push(chunk)
          })
          stream.on('error', () => finish(new OutboundError('network', 'outbound request failed: bad response body')))
          res.on('error', () => finish(new OutboundError('network', 'outbound request failed: connection lost')))
          res.on('aborted', () => finish(new OutboundError('network', 'outbound request failed: connection lost')))
          stream.on('end', () => {
            const responseHeaders = {}
            for (const [name, value] of Object.entries(res.headers)) {
              // the body is handed over decoded, so the headers that described its transfer no longer apply
              if (name === 'content-encoding' || name === 'content-length' || name === 'transfer-encoding') continue
              responseHeaders[name] = Array.isArray(value) ? value.join(', ') : String(value)
            }
            finish(null, {
              status,
              statusText: res.statusMessage || '',
              headers: responseHeaders,
              body: Buffer.concat(chunks, size),
            })
          })
        })
        if (body) req.write(body)
        req.end()
      }, finish)
    })
  }

  // fetch(url, init, { key }): `init` takes method, headers (a plain object of strings), body and signal.
  // Resolves a standard Response holding the whole decoded body; rejects with an OutboundError (`code`).
  return async function outboundFetch(input, init = {}, { key = null } = {}) {
    let url
    try {
      url = new URL(String(input))
    } catch {
      throw refuse('url', 'not a URL')
    }
    const method = String(init.method || 'GET').toUpperCase()
    if (!METHODS.has(method)) throw refuse('method', 'unsupported method')
    let headers = {}
    for (const [name, value] of Object.entries(init.headers || {})) {
      const lower = name.toLowerCase()
      if (typeof value !== 'string' || DROPPED_HEADERS.has(lower)) continue
      headers[lower] = value
    }
    let body = method === 'GET' || method === 'HEAD' ? null : await toBuffer(init.body)
    if (body && body.length > config.maxRequestBytes) {
      throw refuse('too_large', `the request body is larger than ${config.maxRequestBytes} bytes`)
    }
    if (active >= config.concurrency || (key !== null && (activeByKey.get(key) || 0) >= config.perKey)) {
      throw refuse('busy', 'too many requests in flight; try again later')
    }
    active++
    if (key !== null) activeByKey.set(key, (activeByKey.get(key) || 0) + 1)
    let held = 0
    const onBytes = bytes => {
      if (buffered + bytes > config.budgetBytes) return false
      buffered += bytes
      held += bytes
      return true
    }
    const deadline = Date.now() + config.timeoutMs
    try {
      let currentMethod = method
      for (let hop = 0; ; hop++) {
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
          throw refuse('scheme', 'only http and https are allowed')
        if (url.username || url.password) throw refuse('url', 'credentials in the URL are not allowed')
        // bytes held for a redirect response that was dropped are released before the next hop
        buffered -= held
        held = 0
        const result = await exchange(url, {
          method: currentMethod,
          headers,
          body,
          signal: init.signal,
          deadline,
          onBytes,
        })
        if (!result.redirect) {
          const empty =
            result.status === 204 || result.status === 205 || result.status === 304 || currentMethod === 'HEAD'
          return new Response(empty ? null : result.body, {
            status: result.status,
            statusText: result.statusText,
            headers: result.headers,
          })
        }
        if (hop >= config.maxRedirects) throw refuse('redirects', 'too many redirects')
        let next
        try {
          next = new URL(result.redirect, url)
        } catch {
          throw refuse('url', 'the redirect is not a URL')
        }
        // as fetch does: 303 always, and 301/302 for POST, continue as a GET without the body
        if (result.status === 303 || ((result.status === 301 || result.status === 302) && currentMethod === 'POST')) {
          if (currentMethod !== 'HEAD') currentMethod = 'GET'
          body = null
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith('content-')))
        }
        if (next.origin !== url.origin) {
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name)))
        }
        url = next
      }
    } finally {
      buffered -= held
      active--
      if (key !== null) {
        const count = (activeByKey.get(key) || 1) - 1
        if (count > 0) activeByKey.set(key, count)
        else activeByKey.delete(key)
      }
    }
  }
}
