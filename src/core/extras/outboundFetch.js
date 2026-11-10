// The server's fetch for URLs it did not choose itself (Node only: the server and the node agent).
//
// Blueprints name remote models, emotes and scripts the server loads (ServerLoader), and app scripts' fetch()
// will be routed here as well. A builder picks those URLs, so without a policy the server can be pointed at its
// own loopback, its private network and cloud metadata addresses, and made to download without end. This fetch
// only reaches public addresses, and bounds time, size and concurrency:
//
//   - http and https only, no credentials in the URL
//   - the host is resolved once, through DNS, and every address it resolves to must be public (see the address
//     rules below); the connection is then made to one of those addresses, not to the name, so a second DNS answer
//     cannot redirect it (DNS rebinding). When connecting to it fails, one more of the checked answers is tried,
//     of the other family when there is one. An IP literal is checked directly, and the connected socket's remote
//     address is checked again before anything is written to it
//   - redirects are followed here (`redirect: 'follow'`, at most `maxRedirects`), each hop through the same
//     checks. A followed redirect's own body is never read: its connection is closed. `'manual'` hands the
//     redirect back as received and `'error'` rejects
//   - responses are decoded from gzip/deflate only (a Brotli body is refused, see src/server/fetchGuard.js), and
//     reading stops at `maxBytes` of decoded body
//   - all responses in flight share `budgetBytes`. The budget covers a request until its Response is handed over:
//     the body is kept as the chunks received, so no copy is made to assemble it, and what the caller reads or
//     keeps afterwards is the caller's memory. The handed-over body still follows the caller's signal, as fetch's
//     does: an abort errors an unread body
//   - one deadline covers the whole request: its body, resolving, connecting, redirects and the response body
//   - at most `concurrency` requests at once, and `perKey` per caller key (an app); more are refused, not queued.
//     A request keeps its slot until its DNS queries have really ended, also after a timeout or an abort
//   - every request header sent is validated and counted against `maxHeaders` and `maxHeaderBytes` before
//     anything is resolved or sent: the caller's, an inferred Content-Type, and Host, Accept-Encoding, Connection
//     and Content-Length, which are set here explicitly, so the set handed to Node is the set sent; a body may be
//     a string, an ArrayBuffer, a typed array or DataView, or a Blob, of at most `maxRequestBytes`
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

// IPv6: an address is refused when it is not global unicast (2000::/3) or when it is in a special-purpose range
// inside global unicast (https://www.iana.org/assignments/iana-ipv6-special-registry) or in returned 3ffe::/16.
// Outside 2000::/3 that refuses loopback, unspecified, link-local, unique-local, multicast, NAT64, discard, segment
// routing and every form that embeds an IPv4 address (compatible ::a.b.c.d, translated ::ffff:0:a.b.c.d), except
// IPv4-mapped ::ffff:a.b.c.d, which the IPv4 rules decide. Inside 2000::/3 no allocation table is kept: an
// unallocated block there is admitted (it has no route on the public internet), since a stale table would refuse
// real address space once it is allocated. Prefixes are [16-bit groups, length]
const GLOBAL_UNICAST = [[0x2000], 3]
const SPECIAL_IPV6 = [
  [[0x2001, 0x0000], 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID, AMT, anycast services, ...
  [[0x2001, 0x0db8], 32], // documentation
  [[0x2002], 16], // 6to4: embeds an IPv4 address
  [[0x3ffe], 16], // the 6bone's, returned to IANA (the historical Teredo test prefix 3ffe:831f::/32 is in it)
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
// fetch's request-body header names: dropped with the body when a redirect turns a request into a GET
const REQUEST_BODY_HEADERS = new Set(['content-encoding', 'content-language', 'content-location', 'content-type'])

const hostOf = url => (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname)
const ignore = () => {}

// A and AAAA through c-ares (node:dns Resolver): DNS only, so the hosts file is not consulted (a name that only
// resolves on this machine is not a public one); off libuv's thread pool, where dns.lookup()'s getaddrinfo would
// hold one of four threads shared with the server's file I/O for as long as a builder's name takes to answer; and
// cancellable. One resolver per request, so a cancel ends that request's queries only
const createDnsResolver = () => new Resolver({ timeout: 3_000, tries: 2 })

// The DNS queries a request has running. The request keeps its slot while there are any: `idle` is called once,
// from the callback of the last one to end (answered, failed or cancelled)
function createDnsWork() {
  return { outstanding: 0, idle: null }
}

// the addresses `host` resolves to, IPv4 first; `work` counts the queries until their callbacks have run
function resolveHost(createResolver, host, stop, work) {
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
      let ended = false
      const end = (err, addresses) => {
        if (ended) return
        ended = true
        resolve({ err, addresses: !err && Array.isArray(addresses) ? addresses : [] })
        if (--work.outstanding === 0) {
          stop.removeEventListener('abort', cancel)
          const idle = work.idle
          work.idle = null
          idle?.()
        }
      }
      try {
        resolver[method](host, end)
      } catch (err) {
        end(err) // a resolver method that throws is that query failing
      }
    })
  // both counted before either starts: a first query that answers at once must not leave the second uncounted
  // (and uncancellable)
  work.outstanding += 2
  stop.addEventListener('abort', cancel, { once: true })
  const ended = Promise.all([query('resolve4'), query('resolve6')])
  if (stop.aborted) cancel()
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

// The caller's headers as a lower-case map: a plain object of strings, a Headers object or [name, value] pairs.
// Bounded (so reading them is) and validated as Node will send them, so a bad value is refused here instead of
// throwing mid-request. Repeated names are combined by the platform's Headers, with its rules (Cookie with "; ",
// others with ", "). What is finally sent is bounded again, all of it, by outgoingHeaders()
function prepareHeaders(input, { maxHeaders, maxHeaderBytes }) {
  const headers = Object.create(null)
  if (input === undefined || input === null) return headers
  let entries
  if (input instanceof Headers) entries = input.entries()
  else if (Array.isArray(input)) entries = input
  else if (typeof input === 'object') entries = Object.entries(input)
  else throw refuse('header', 'the headers must be an object of strings')
  const tooLarge = () => refuse('header', `the request headers are larger than ${maxHeaderBytes} bytes`)
  const combined = new Headers()
  let count = 0
  let bytes = 0
  for (const entry of entries) {
    if (++count > maxHeaders) throw refuse('header', `more than ${maxHeaders} request headers`)
    const [name, value] = Array.isArray(entry) && entry.length === 2 ? entry : []
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw refuse('header', 'a header name and value must be strings')
    }
    bytes += name.length + value.length
    if (bytes > maxHeaderBytes) throw tooLarge()
    const normalized = trimHttpWhitespace(value)
    try {
      http.validateHeaderName(name)
      http.validateHeaderValue(name, normalized)
      if (!DROPPED_HEADERS.has(name.toLowerCase())) combined.append(name, normalized)
    } catch {
      throw refuse('header', `the header ${previewValue(name)} has an invalid name or value`)
    }
  }
  for (const [name, value] of combined) headers[name] = name in headers ? `${headers[name]}, ${value}` : value
  return headers
}

// the methods Node sends Content-Length: 0 for when they have no body
const EMPTY_LENGTH_METHODS = new Set(['POST', 'PUT', 'PATCH'])

// Every header a request sends, in one place and as the very strings that are sent: the caller's (combined), the
// Content-Type inferred from its body, and the ones set here, all explicitly so that Node adds none of its own:
// Host, Accept-Encoding, Connection: close, and Content-Length for a body (0 for a POST, PUT or PATCH without
// one, as Node would send it). Counted and sized together against maxHeaders and maxHeaderBytes, then validated,
// before anything is resolved or sent: the set handed to http.request is this one
function outgoingHeaders(headers, url, method, body, { maxHeaders, maxHeaderBytes }) {
  const outgoing = { ...headers, host: url.host, 'accept-encoding': 'gzip, deflate', connection: 'close' }
  if (body) outgoing['content-length'] = String(body.length)
  else if (EMPTY_LENGTH_METHODS.has(method)) outgoing['content-length'] = '0'
  const entries = Object.entries(outgoing)
  let bytes = 0
  for (const [name, value] of entries) {
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw refuse('header', 'a header name and value must be strings')
    }
    bytes += name.length + value.length
  }
  if (!(entries.length <= maxHeaders)) throw refuse('header', `more than ${maxHeaders} request headers`)
  if (!Number.isSafeInteger(bytes) || !(bytes <= maxHeaderBytes)) {
    throw refuse('header', `the request headers are larger than ${maxHeaderBytes} bytes`)
  }
  for (const [name, value] of entries) {
    try {
      http.validateHeaderName(name)
      http.validateHeaderValue(name, value)
    } catch {
      throw refuse('header', `the header ${previewValue(name)} has an invalid name or value`)
    }
  }
  return outgoing
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
    // each read once: this type is the very string that is counted, validated and sent (the platform's Blob has
    // a string type by definition; a subclass's getter may return anything, or something new on every read)
    const size = body.size
    const type = body.type
    if (typeof type !== 'string') throw refuse('body', 'the Blob type is not a string')
    if (!(size <= limit)) throw tooLarge()
    const bytes = Buffer.from(await body.arrayBuffer())
    if (!(bytes.length <= limit)) throw tooLarge()
    return { bytes, type: type || null }
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

// A body nobody reads any more takes its abort listener with it: the listener holds the body only weakly, and
// this removes it once the body is collected
const bodyListeners = new FinalizationRegistry(({ signal, listener }) => signal.removeEventListener('abort', listener))

// made outside chunkStream, so its closure holds the WeakRef and the signal, not the chunks
const abortListener = (ref, signal) => () => ref.deref()?.abort(signal.reason)

// A body over the chunks as received: handing it over copies nothing, and a chunk is let go once it is read. As
// fetch's body, it follows the caller's signal: an abort before it is read to the end errors it with the signal's
// reason (an AbortError for a plain abort(); whatever was passed to abort(reason) otherwise) and lets the unread
// chunks go. The listener leaves when the body is read to the end, cancelled or errored
function chunkStream(chunks, signal) {
  const body = { chunks, next: 0, controller: null, listener: null }
  const detach = () => {
    if (!body.listener) return
    signal.removeEventListener('abort', body.listener)
    bodyListeners.unregister(body)
    body.listener = null
  }
  body.abort = reason => {
    body.chunks = []
    detach()
    try {
      body.controller.error(reason)
    } catch {
      // already closed or errored
    }
  }
  const source = {
    start(controller) {
      body.controller = controller
      if (!signal) return
      if (signal.aborted) return body.abort(signal.reason)
      body.listener = abortListener(new WeakRef(body), signal)
      signal.addEventListener('abort', body.listener, { once: true })
      bodyListeners.register(body, { signal, listener: body.listener }, body)
    },
    pull(controller) {
      if (body.next < body.chunks.length) {
        controller.enqueue(body.chunks[body.next])
        body.chunks[body.next++] = null
      } else {
        controller.close()
        detach()
      }
    },
    cancel() {
      body.chunks = []
      detach()
    },
  }
  // nothing is pulled before the caller reads: an empty body is still open (and abortable) when handed over
  return new ReadableStream(source, { highWaterMark: 0 })
}

// the reason phrases the Response constructor accepts
const REASON_PHRASE = /^[\t\x20-\x7e\x80-\xff]*$/

function toResponse({ status, statusText, headers, chunks }, signal) {
  const init = { status, headers }
  if (REASON_PHRASE.test(statusText)) init.statusText = statusText // any other is left out
  return new Response(chunks ? chunkStream(chunks, signal) : null, init)
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

  // Where to connect for this URL: { address, family, fallback } for checked addresses, or null for a trusted
  // origin. `fallback` is one more checked answer, of the other family when there is one: it is tried only when
  // connecting to the first fails
  async function destination(url, stop, dns) {
    if (trusted.has(url.origin)) return null
    const host = hostOf(url)
    if (net.isIP(host)) {
      if (!isAllowedAddress(host)) throw refuse('address', 'the address is not public')
      return { address: host, family: net.isIP(host), fallback: null }
    }
    const answers = await resolveHost(createResolver, host, stop, dns)
    // all of them: a name that also resolves to a private address is not one to pick an answer from
    for (const answer of answers) {
      if (!isAllowedAddress(answer.address)) {
        throw refuse('address', 'the host resolves to an address that is not public')
      }
    }
    const [first] = answers // the first IPv4 answer if there is one, otherwise the first IPv6 one
    const fallback =
      answers.find(answer => answer.family !== first.family) ||
      answers.find(answer => answer.address !== first.address) ||
      null
    return { address: first.address, family: first.family, fallback }
  }

  // One request/response exchange. Resolves { status, statusText, headers, chunks } (chunks null for a response
  // without a body), or { redirect, status } for a redirect to follow. However it settles, its connection is
  // closed then: nothing of an exchange outlives it
  function exchange(url, { method, headers, body, redirect, maxBytes, onBytes, stop, deadline, dns }) {
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
        // an empty Location is a reference to this same URL, as fetch reads it
        if (REDIRECTS.has(status) && redirect === 'follow' && res.headers.location !== undefined) {
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
        // listened to from its creation, for its whole life (after settling an error is ignored)
        decoder?.on('error', () => finish(failed('network', 'bad response body')))
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
          headers, // as outgoingHeaders() checked them
          agent: false, // a connection of its own: no socket is reused, across requests or destinations
        }
        if (!net.isIP(host)) {
          // the TLS server name, and the name the certificate is verified for, is the URL's host, never the address
          if (secure) requestOptions.servername = host
          if (target) {
            // Connect to the addresses that were checked; the name still goes out as Host and TLS server name.
            // With a fallback, Node's connect tries the first address for a third of the time left (at least
            // 250 ms) or until it fails to connect, then the fallback for the rest: one more checked address, never
            // an unchecked one, and only before anything was sent. The request's deadline still ends it all, so a
            // deadline shorter than the first attempt leaves no time for the second
            const candidates = [target, target.fallback].filter(Boolean).map(({ address, family }) => ({
              address,
              family,
            }))
            // Never synchronously: a connect that fails at once (ENETUNREACH where a family has no route) must
            // report after http has put its error listeners on the socket. Node's callback starts the first
            // connect attempt, so a throw from it ends this request. What is contained: every error Node reports
            // through an event or an errno, on every attempt. What is not: a JavaScript exception thrown inside
            // Node's own later attempts (a fallback started from its timer or completion callback), which no
            // code here runs around
            requestOptions.lookup = (hostname, opts, callback) => {
              process.nextTick(() => {
                try {
                  if (opts?.all) callback(null, candidates)
                  else callback(null, target.address, target.family)
                } catch (err) {
                  fail(err)
                }
              })
            }
            if (candidates.length > 1) {
              requestOptions.autoSelectFamily = true
              requestOptions.autoSelectFamilyAttemptTimeout = Math.max(250, Math.floor((deadline - Date.now()) / 3))
            }
          }
        }
        // Every emitter of the exchange has an 'error' listener from the moment it is ours until it is gone, also
        // after the exchange settled (finish() ignores what comes later): the request here, its socket below (http
        // forwards a socket's errors to the request, and this listener stays when http's goes), the response and
        // the decoder in receive()
        req = (secure ? https : http).request(requestOptions)
        req.on('error', fail)
        req.on('socket', socket => {
          socket.on('error', ignore)
          if (!target) return
          // ahead of the request's own writes: nothing is sent to a peer that is not the checked address
          const check = () => {
            // a socket that failed to connect is not checked: its own error is the outcome
            if (socket.destroyed) return
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
          res.on('error', () => finish(failed('network', 'connection lost')))
          res.on('aborted', () => finish(failed('network', 'connection lost')))
          try {
            receive()
          } catch (err) {
            fail(err)
          }
        })
        if (body) req.write(body)
        req.end()
      }

      destination(url, stop, dns).then(target => {
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
    const dns = createDnsWork() // keeps the slot until its queries have really ended
    let held = 0
    const onBytes = bytes => {
      if (buffered + bytes > config.budgetBytes) return false
      buffered += bytes
      held += bytes
      return true
    }
    // the request's own stop: its deadline or the caller's signal, whichever comes first
    const stop = new AbortController()
    const deadline = Date.now() + timeoutMs
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
          headers: outgoingHeaders(headers, url, method, body, config),
          body,
          redirect: request.redirect,
          maxBytes,
          onBytes,
          stop: stop.signal,
          deadline,
          dns,
        })
        // the returned body still follows the caller's signal, as fetch's does
        if (result.redirect === undefined) return toResponse(result, signal)
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
          headers = withoutHeaders(headers, name => REQUEST_BODY_HEADERS.has(name))
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
      // at once when its DNS queries have ended (the usual case), otherwise from the last one's callback
      if (dns.outstanding === 0) release()
      else dns.idle = release
    }
  }
}
