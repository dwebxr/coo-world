// The server's fetch for URLs it did not choose itself (Node only: the server and the node agent).
//
// Blueprints name remote models, emotes and scripts the server loads (ServerLoader), and app scripts' fetch()
// will be routed here as well. A builder picks those URLs, so without a policy the server can be pointed at its
// own loopback, its private network and cloud metadata addresses, and made to download without end. This fetch
// only reaches public addresses, and bounds time, size and concurrency:
//
//   - http and https only, no credentials in the URL
//   - the host is resolved once, through DNS, and every address it resolves to must be public; the connection is
//     then made to one of those addresses, not to the name, so a second DNS answer cannot redirect it (DNS
//     rebinding). An IP literal is checked directly, and the connected socket's remote address is checked again
//     before anything is written to it
//   - redirects are followed here (`redirect: 'follow'`, at most `maxRedirects`), each hop through the same
//     checks. A followed redirect's own body is never read: its connection is closed. `'manual'` hands the
//     redirect back as received and `'error'` rejects
//   - responses are decoded from gzip/deflate only (a Brotli body is refused, see src/server/fetchGuard.js), and
//     reading stops at `maxBytes` of decoded body
//   - all responses in flight share `budgetBytes`. The budget covers a request until its Response is handed over:
//     the body is kept as the chunks received, so no copy is made to assemble it, and what the caller reads or
//     keeps afterwards is the caller's memory
//   - one deadline covers the whole request: its body, resolving, connecting, redirects and the response body
//   - at most `concurrency` requests at once, and `perKey` per caller key (an app); more are refused, not queued.
//     A request keeps its slot until its DNS queries have really ended, also after a timeout or an abort
//   - request headers are validated and bounded (`maxHeaders`, `maxHeaderBytes`); a body may be a string, an
//     ArrayBuffer, a typed array or DataView, or a Blob, of at most `maxRequestBytes`
//
// The request options are fetch's where they mean something here: method (GET, HEAD, POST, PUT, PATCH, DELETE,
// OPTIONS), headers, body, signal and redirect. mode, credentials and cache describe a browser's request and are
// ignored; any other option is refused rather than ignored.
//
// Origins the operator configured (the world's own assets URL) are trusted: no address check, and their names are
// resolved by the system (hosts file included), since in development and with a private object store they are
// local on purpose.
//
// Built on node:http/https directly: the checks sit at the socket, where the global fetch offers no hook.

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { Resolver } from 'node:dns'
import { previewValue } from './assetURL.js'

export const OUTBOUND_DEFAULTS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxRequestBytes: 1024 * 1024,
  maxHeaders: 64,
  maxHeaderBytes: 16 * 1024, // names and values together
  timeoutMs: 15_000,
  maxRedirects: 3,
  concurrency: 16,
  perKey: 4,
  budgetBytes: 64 * 1024 * 1024,
})

// IPv4 addresses that are not on the public internet
const blockedIPv4 = new net.BlockList()
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
  blockedIPv4.addSubnet(address, prefix, 'ipv4')
}

// IPv6 is an allow list: an address is public only in global unicast (2000::/3) and outside the special-purpose
// ranges IANA lists inside it (https://www.iana.org/assignments/iana-ipv6-special-registry). That refuses
// loopback, unspecified, link-local, unique-local, multicast, NAT64, discard, segment routing, the reserved and
// unassigned space, and every form that embeds an IPv4 address (compatible ::a.b.c.d, translated
// ::ffff:0:a.b.c.d, 6to4), except IPv4-mapped ::ffff:a.b.c.d, which the IPv4 rules decide.
// Prefixes are [16-bit groups, length]
const GLOBAL_UNICAST = [[0x2000], 3]
const SPECIAL_IPV6 = [
  [[0x2001, 0x0000], 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID, AMT, anycast services, ...
  [[0x2001, 0x0db8], 32], // documentation
  [[0x2002], 16], // 6to4: embeds an IPv4 address
  [[0x3fff, 0x0000], 20], // documentation
]

// the eight 16-bit groups of an address net.isIP() called IPv6 (without a zone index)
function ipv6Groups(address) {
  let text = address.toLowerCase()
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number)
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const zeros = halves.length > 1 ? 8 - left.length - right.length : 0
  return [...left, ...new Array(Math.max(zeros, 0)).fill('0'), ...right].map(group => parseInt(group, 16))
}

function inPrefix(groups, prefix, length) {
  for (let i = 0, bits = length; bits > 0; i++, bits -= 16) {
    const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff
    if (((groups[i] ^ (prefix[i] || 0)) & mask) !== 0) return false
  }
  return true
}

const isPublicIPv4 = address => !blockedIPv4.check(address, 'ipv4')

function isPublicIPv6(address) {
  if (address.includes('%')) return false // a zone index scopes the address to a local link
  const groups = ipv6Groups(address)
  if (groups.length !== 8 || groups.some(group => !(group >= 0 && group <= 0xffff))) return false
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return isPublicIPv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`)
  }
  if (!inPrefix(groups, ...GLOBAL_UNICAST)) return false
  return !SPECIAL_IPV6.some(([prefix, length]) => inPrefix(groups, prefix, length))
}

// whether an IP address (v4, v6, or v4-mapped v6) is one the server may connect to for an untrusted URL
export function isPublicAddress(address) {
  if (typeof address !== 'string') return false
  const family = net.isIP(address)
  if (family === 4) return isPublicIPv4(address)
  if (family === 6) return isPublicIPv6(address)
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
const failed = (code, message) => new OutboundError(code, `outbound request failed: ${message}`)

const REDIRECTS = new Set([301, 302, 303, 307, 308])
// responses without a body, whatever their headers say (fetch's null body statuses, and any answer to HEAD)
const NULL_BODY = new Set([204, 205, 304])
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const REDIRECT_MODES = new Set(['follow', 'manual', 'error'])
const OPTIONS = new Set(['method', 'headers', 'body', 'signal', 'redirect'])
// a browser's notions with no meaning for the server's request: accepted and ignored
const IGNORED_OPTIONS = new Set(['mode', 'credentials', 'cache'])
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

// A and AAAA through c-ares (node:dns Resolver): DNS only, so the hosts file is not consulted (a name that only
// resolves on this machine is not a public one); off libuv's thread pool, where dns.lookup()'s getaddrinfo would
// hold one of four threads shared with the server's file I/O for as long as a builder's name takes to answer; and
// cancellable. One resolver per request, so a cancel ends that request's queries only
const createDnsResolver = () => new Resolver({ timeout: 3_000, tries: 2 })

// the addresses `host` resolves to, IPv4 first. `holds` receives a promise that settles once both queries have
// ended (answered, failed or cancelled): the request keeps its slot until then
function resolveHost(createResolver, host, stop, holds) {
  const resolver = createResolver()
  const cancel = () => {
    try {
      resolver.cancel()
    } catch {
      // nothing left to cancel
    }
  }
  const query = method =>
    new Promise(resolve => {
      try {
        resolver[method](host, (err, addresses) => {
          resolve({ err, addresses: !err && Array.isArray(addresses) ? addresses : [] })
        })
      } catch (err) {
        resolve({ err, addresses: [] })
      }
    })
  const ended = Promise.all([query('resolve4'), query('resolve6')])
  holds.push(ended)
  stop.addEventListener('abort', cancel, { once: true })
  if (stop.aborted) cancel()
  ended.then(() => stop.removeEventListener('abort', cancel))
  return ended.then(([v4, v6]) => {
    const answers = [...v4.addresses, ...v6.addresses].map(address => ({
      address: String(address),
      family: net.isIP(String(address)),
    }))
    if (answers.length) return answers
    // "no data" for one family is an empty answer; a name with no address at all, or a failed query, ends here
    const failure = [v4.err, v6.err].find(err => err && err.code !== 'ENODATA')
    if (failure) throw failed('dns', `could not resolve the host (${failure.code || 'error'})`)
    throw failed('dns', 'the host has no address')
  })
}

const isHttpWhitespace = code => code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20

// as fetch normalises a header value: leading and trailing HTTP whitespace removed (a loop: a regex here can
// backtrack quadratically on a long value)
function trimHttpWhitespace(value) {
  let start = 0
  let end = value.length
  while (start < end && isHttpWhitespace(value.charCodeAt(start))) start++
  while (end > start && isHttpWhitespace(value.charCodeAt(end - 1))) end--
  return value.slice(start, end)
}

// the caller's headers as a lower-case map: a plain object of strings, a Headers object or [name, value] pairs.
// Bounded and validated as Node will send them, so a bad value is refused here instead of throwing mid-request
function prepareHeaders(input, { maxHeaders, maxHeaderBytes }) {
  const headers = Object.create(null)
  if (input === undefined || input === null) return headers
  let entries
  if (input instanceof Headers) entries = input.entries()
  else if (Array.isArray(input)) entries = input
  else if (typeof input === 'object') entries = Object.entries(input)
  else throw refuse('header', 'the headers must be an object of strings')
  let count = 0
  let bytes = 0
  for (const entry of entries) {
    if (++count > maxHeaders) throw refuse('header', `more than ${maxHeaders} request headers`)
    const [name, value] = Array.isArray(entry) && entry.length === 2 ? entry : []
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw refuse('header', 'a header name and value must be strings')
    }
    bytes += name.length + value.length
    if (bytes > maxHeaderBytes) throw refuse('header', `the request headers are larger than ${maxHeaderBytes} bytes`)
    const normalized = trimHttpWhitespace(value)
    try {
      http.validateHeaderName(name)
      http.validateHeaderValue(name, normalized)
    } catch {
      throw refuse('header', `the header ${previewValue(name)} has an invalid name or value`)
    }
    const lower = name.toLowerCase()
    if (DROPPED_HEADERS.has(lower)) continue
    headers[lower] = lower in headers ? `${headers[lower]}, ${normalized}` : normalized
  }
  return headers
}

const withoutHeaders = (headers, drop) => {
  const kept = Object.create(null)
  for (const [name, value] of Object.entries(headers)) if (!drop(name)) kept[name] = value
  return kept
}

// the request body as bytes, and the Content-Type fetch infers for it. Sizes are checked before anything is
// converted or copied
async function prepareBody(body, limit) {
  if (body === undefined || body === null) return { bytes: null, type: null }
  const tooLarge = () => refuse('too_large', `the request body is larger than ${limit} bytes`)
  if (typeof body === 'string') {
    if (body.length > limit || Buffer.byteLength(body) > limit) throw tooLarge()
    return { bytes: Buffer.from(body), type: 'text/plain;charset=UTF-8' }
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    if (body.byteLength > limit) throw tooLarge()
    const view = ArrayBuffer.isView(body)
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      : new Uint8Array(body)
    return { bytes: Buffer.from(view), type: null } // a copy, as fetch takes one
  }
  if (body instanceof Blob) {
    if (body.size > limit) throw tooLarge()
    const bytes = Buffer.from(await body.arrayBuffer())
    if (bytes.length > limit) throw tooLarge()
    return { bytes, type: body.type || null }
  }
  throw refuse('body', 'the body must be a string, an ArrayBuffer, a typed array or DataView, or a Blob')
}

// the options of a request, checked before it takes a slot (nothing here waits or allocates much)
function readInit(init) {
  if (init === undefined || init === null) init = {}
  if (typeof init !== 'object') throw refuse('option', 'the request options must be an object')
  for (const name of Object.keys(init)) {
    if (init[name] === undefined || OPTIONS.has(name) || IGNORED_OPTIONS.has(name)) continue
    throw refuse('option', `the request option ${previewValue(name)} is not supported`)
  }
  const method = init.method === undefined ? 'GET' : typeof init.method === 'string' ? init.method.toUpperCase() : ''
  if (!METHODS.has(method)) throw refuse('method', 'unsupported method')
  const redirect = init.redirect === undefined ? 'follow' : init.redirect
  if (!REDIRECT_MODES.has(redirect)) throw refuse('option', 'redirect must be "follow", "manual" or "error"')
  const signal = init.signal ?? null
  if (signal !== null && !(signal instanceof AbortSignal)) throw refuse('option', 'signal must be an AbortSignal')
  if ((method === 'GET' || method === 'HEAD') && init.body !== undefined && init.body !== null) {
    throw refuse('body', `a ${method} request cannot have a body`)
  }
  return { method, redirect, signal, headers: init.headers, body: init.body }
}

// settles as `promise` does, or rejects with the stop reason when the request stops first
function untilStopped(promise, stop) {
  return new Promise((resolve, reject) => {
    const onStop = () => reject(stop.reason)
    if (stop.aborted) return onStop()
    stop.addEventListener('abort', onStop, { once: true })
    promise.then(
      value => {
        stop.removeEventListener('abort', onStop)
        resolve(value)
      },
      err => {
        stop.removeEventListener('abort', onStop)
        reject(err)
      }
    )
  })
}

// the response's headers, repeated ones kept as fetch keeps them. A body handed over decoded no longer has the
// encoding and length its transfer had; a response without a body keeps them (they describe the representation)
function responseHeaders(res, decoded) {
  const headers = new Headers()
  const raw = res.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i].toLowerCase()
    if (name === 'transfer-encoding') continue
    if (decoded && (name === 'content-encoding' || name === 'content-length')) continue
    try {
      headers.append(name, raw[i + 1])
    } catch {
      // a value fetch would not accept is left out
    }
  }
  return headers
}

// a body over the chunks as received: handing it over copies nothing, and a chunk is let go once it is read
function chunkStream(chunks) {
  let next = 0
  return new ReadableStream({
    pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(chunks[next])
        chunks[next++] = null
      } else {
        controller.close()
      }
    },
  })
}

function toResponse({ status, statusText, headers, chunks }) {
  try {
    return new Response(chunks ? chunkStream(chunks) : null, { status, statusText, headers })
  } catch {
    // a reason phrase the Response constructor does not accept is left out
    return new Response(chunks ? chunkStream(chunks) : null, { status, headers })
  }
}

export function createOutboundFetch(options = {}) {
  const config = { ...OUTBOUND_DEFAULTS, ...options }
  // a Resolver-shaped object per request: resolve4(host, cb), resolve6(host, cb), cancel()
  const createResolver = options.resolver || createDnsResolver
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
  async function destination(url, stop, holds) {
    if (trusted.has(url.origin)) return null
    const host = hostOf(url)
    if (net.isIP(host)) {
      if (!isAllowedAddress(host)) throw refuse('address', 'the address is not public')
      return { address: host, family: net.isIP(host) }
    }
    const answers = await resolveHost(createResolver, host, stop, holds)
    // all of them: a name that also resolves to a private address is not one to pick an answer from
    for (const answer of answers) {
      if (!isAllowedAddress(answer.address)) {
        throw refuse('address', 'the host resolves to an address that is not public')
      }
    }
    return answers[0] // the first IPv4 answer if there is one, otherwise the first IPv6 one
  }

  // One request/response exchange. Resolves { status, statusText, headers, chunks } (chunks null for a response
  // without a body), or { redirect, status } for a redirect to follow. However it settles, its connection is
  // closed then: nothing of an exchange outlives it
  function exchange(url, { method, headers, body, redirect, maxBytes, onBytes, stop, holds }) {
    return new Promise((resolve, reject) => {
      let settled = false
      let req = null
      let res = null
      let decoder = null
      const finish = (err, value) => {
        if (settled) return
        settled = true
        stop.removeEventListener('abort', onStop)
        decoder?.destroy()
        res?.destroy()
        req?.destroy()
        if (err) reject(err)
        else resolve(value)
      }
      const fail = err =>
        finish(err instanceof OutboundError ? err : failed('network', err?.code || 'could not send the request'))
      const onStop = () => finish(stop.reason)
      if (stop.aborted) return onStop()
      stop.addEventListener('abort', onStop, { once: true })

      const receive = () => {
        const status = res.statusCode
        if (REDIRECTS.has(status) && redirect === 'error') {
          return finish(refuse('redirect', 'the response is a redirect and the request allows none'))
        }
        if (REDIRECTS.has(status) && redirect === 'follow' && res.headers.location) {
          return finish(null, { redirect: res.headers.location, status })
        }
        if (!(status >= 200 && status <= 599)) return finish(failed('network', 'invalid response status'))
        const statusText = res.statusMessage || ''
        if (method === 'HEAD' || NULL_BODY.has(status)) {
          // nothing to read or decode, whatever Content-Encoding says
          return finish(null, { status, statusText, headers: responseHeaders(res, false), chunks: null })
        }
        const encoding = String(res.headers['content-encoding'] || 'identity')
          .trim()
          .toLowerCase()
        if (encoding === 'gzip' || encoding === 'x-gzip') decoder = zlib.createGunzip()
        else if (encoding === 'deflate') decoder = zlib.createInflate()
        else if (encoding !== 'identity' && encoding !== '') {
          return finish(refuse('encoding', `content-encoding ${JSON.stringify(encoding.slice(0, 24))} is not accepted`))
        }
        const stream = decoder ? res.pipe(decoder) : res
        const chunks = []
        let size = 0
        stream.on('data', chunk => {
          if (settled) return
          size += chunk.length
          if (size > maxBytes) return finish(refuse('too_large', `the response is larger than ${maxBytes} bytes`))
          if (!onBytes(chunk.length)) {
            return finish(refuse('busy', 'too much response data is being held; try again later'))
          }
          chunks.push(chunk)
        })
        decoder?.on('error', () => finish(failed('network', 'bad response body')))
        res.on('error', () => finish(failed('network', 'connection lost')))
        res.on('aborted', () => finish(failed('network', 'connection lost')))
        stream.on('end', () => {
          finish(null, { status, statusText, headers: responseHeaders(res, Boolean(decoder)), chunks })
        })
      }

      const send = target => {
        const secure = url.protocol === 'https:'
        const host = hostOf(url)
        const requestOptions = {
          protocol: url.protocol,
          hostname: host,
          port: url.port || (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers: { ...headers, host: url.host, 'accept-encoding': 'gzip, deflate' },
          agent: false, // a connection of its own: no socket is reused, across requests or destinations
        }
        if (body) requestOptions.headers['content-length'] = String(body.length)
        if (!net.isIP(host)) {
          // the TLS server name, and the name the certificate is verified for, is the URL's host, never the address
          if (secure) requestOptions.servername = host
          if (target) {
            // connect to the address that was checked; the name still goes out as Host and TLS server name
            requestOptions.lookup = (hostname, opts, callback) => {
              if (opts?.all) callback(null, [{ address: target.address, family: target.family }])
              else callback(null, target.address, target.family)
            }
          }
        }
        req = (secure ? https : http).request(requestOptions)
        req.on('error', fail)
        req.on('socket', socket => {
          if (!target) return
          // ahead of the request's own writes: nothing is sent to a peer that is not the checked address
          const check = () => {
            try {
              if (!isAllowedAddress(socket.remoteAddress || '')) {
                finish(refuse('address', 'connected to an address that is not public'))
              }
            } catch (err) {
              fail(err)
            }
          }
          if (socket.connecting) socket.prependOnceListener('connect', check)
          else check()
        })
        req.on('response', response => {
          res = response
          try {
            receive()
          } catch (err) {
            fail(err)
          }
        })
        if (body) req.write(body)
        req.end()
      }

      destination(url, stop, holds).then(target => {
        if (settled) return
        try {
          send(target)
        } catch (err) {
          fail(err)
        }
      }, fail)
    })
  }

  // fetch(url, init, { key, maxBytes, timeoutMs }): `init` takes method, headers, body, signal and redirect
  // (see the top of this file). Resolves a standard Response holding the whole decoded body; rejects with an
  // OutboundError (`code`). `maxBytes` and `timeoutMs` may be set per call (a model load allows more than a
  // script's request)
  return async function outboundFetch(
    input,
    init = {},
    { key = null, maxBytes = config.maxBytes, timeoutMs = config.timeoutMs } = {}
  ) {
    let url
    try {
      url = new URL(String(input))
    } catch {
      throw refuse('url', 'not a URL')
    }
    const request = readInit(init)
    if (active >= config.concurrency || (key !== null && (activeByKey.get(key) || 0) >= config.perKey)) {
      throw refuse('busy', 'too many requests in flight; try again later')
    }
    active++
    if (key !== null) activeByKey.set(key, (activeByKey.get(key) || 0) + 1)
    const holds = [] // work that keeps the slot until it has really ended (DNS queries)
    let held = 0
    const onBytes = bytes => {
      if (buffered + bytes > config.budgetBytes) return false
      buffered += bytes
      held += bytes
      return true
    }
    // the request's own stop: its deadline or the caller's signal, whichever comes first
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(failed('timeout', 'it took too long')), timeoutMs)
    const onAbort = () => stop.abort(new OutboundError('aborted', 'outbound request aborted'))
    const { signal } = request
    try {
      if (signal?.aborted) throw new OutboundError('aborted', 'outbound request aborted')
      signal?.addEventListener('abort', onAbort, { once: true })
      let headers = prepareHeaders(request.headers, config)
      const prepared = await untilStopped(prepareBody(request.body, config.maxRequestBytes), stop.signal)
      let body = prepared.bytes
      if (prepared.type && headers['content-type'] === undefined) headers['content-type'] = prepared.type
      let method = request.method
      for (let hop = 0; ; hop++) {
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw refuse('scheme', 'only http and https are allowed')
        }
        if (url.username || url.password) throw refuse('url', 'credentials in the URL are not allowed')
        const result = await exchange(url, {
          method,
          headers,
          body,
          redirect: request.redirect,
          maxBytes,
          onBytes,
          stop: stop.signal,
          holds,
        })
        if (!result.redirect) return toResponse(result)
        if (hop >= config.maxRedirects) throw refuse('redirects', 'too many redirects')
        let next
        try {
          next = new URL(result.redirect, url)
        } catch {
          throw refuse('url', 'the redirect is not a URL')
        }
        // as fetch does: 303 for anything but GET/HEAD, and 301/302 for POST, continue as a GET without the body
        if (
          (result.status === 303 && method !== 'GET' && method !== 'HEAD') ||
          ((result.status === 301 || result.status === 302) && method === 'POST')
        ) {
          method = 'GET'
          body = null
          headers = withoutHeaders(headers, name => name.startsWith('content-'))
        }
        if (next.origin !== url.origin) headers = withoutHeaders(headers, name => CREDENTIAL_HEADERS.has(name))
        url = next
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // whatever still runs for this request ends now (a DNS query is cancelled)
      stop.abort(new OutboundError('aborted', 'outbound request ended'))
      // the budget covers the request in flight: a handed-over body is the caller's from here
      buffered -= held
      held = 0
      const release = () => {
        active--
        if (key !== null) {
          const count = (activeByKey.get(key) || 1) - 1
          if (count > 0) activeByKey.set(key, count)
          else activeByKey.delete(key)
        }
      }
      if (holds.length) Promise.all(holds).then(release)
      else release()
    }
  }
}
