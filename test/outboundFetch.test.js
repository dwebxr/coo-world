import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import v8 from 'node:v8'
import vm from 'node:vm'
import zlib from 'node:zlib'

import {
  OUTBOUND_DEFAULTS,
  OutboundError,
  createOutboundFetch,
  isPublicAddress,
} from '../src/core/extras/outboundFetch.js'

const unhandled = []
process.on('unhandledRejection', err => unhandled.push(err))
// a collection on demand, for the one test that needs one (skipped, and saying so, where it cannot be had)
const gc = (() => {
  try {
    v8.setFlagsFromString('--expose-gc')
    const collect = vm.runInNewContext('gc')
    return typeof collect === 'function' ? collect : null
  } catch {
    return null
  }
})()
// "at once": well before the deadlines (5 s) those requests would otherwise end at, even on a loaded machine
const AT_ONCE_MS = 2500

// a local server; `handler` gets (req, res). Connections are counted so a test can assert none was made.
async function serve(t, handler, options = {}) {
  const state = { requests: [], connections: 0, sockets: [] }
  const server = http.createServer(options, (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }
      state.requests.push(entry)
      handler(req, res, entry)
    })
  })
  server.on('connection', socket => {
    state.connections++
    state.sockets.push(socket)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  state.port = server.address().port
  state.origin = `http://127.0.0.1:${state.port}`
  return state
}

// production policy for everything except the one local test server
const allowLocal = address => address === '127.0.0.1' || isPublicAddress(address)
const code = expected => err => err instanceof OutboundError && err.code === expected
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate, ms, what) {
  const until = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

// A stand-in for node:dns's Resolver. `table[host]` is a list of addresses (split into A and AAAA by family),
// or { A, AAAA } where each is a list or an error code; a host not in the table is ENOTFOUND
const dnsError = errorCode => Object.assign(new Error(errorCode), { code: errorCode })
function resolverFor(table, calls = []) {
  const reply = (host, type, callback) => {
    calls.push(`${type} ${host}`)
    setImmediate(() => {
      const entry = table[host]
      if (entry === undefined) return callback(dnsError('ENOTFOUND'))
      const value = Array.isArray(entry)
        ? entry.filter(address => net.isIP(address) === (type === 'A' ? 4 : 6))
        : entry[type]
      if (typeof value === 'string') return callback(dnsError(value))
      if (!value || !value.length) return callback(dnsError('ENODATA'))
      callback(null, value)
    })
  }
  return () => ({
    resolve4: (host, callback) => reply(host, 'A', callback),
    resolve6: (host, callback) => reply(host, 'AAAA', callback),
    cancel() {},
  })
}

// The requests the module makes, seen through a wrapper around `module.request` (the module calls it through the
// same object): each one's socket, whether and when it closed, the bytes it read, and with `chunks` the
// response's own 'data' chunks
function watchRequests(t, { module = http, chunks = false } = {}) {
  const seen = []
  const original = module.request
  t.mock.method(module, 'request', function (...args) {
    const req = original.apply(this, args)
    const entry = { socket: null, closed: false, bytesRead: 0, chunks: [] }
    seen.push(entry)
    req.on('socket', socket => {
      entry.socket = socket
      socket.on('close', () => {
        entry.closed = true
        entry.bytesRead = socket.bytesRead
      })
    })
    if (chunks) req.on('response', res => res.on('data', chunk => entry.chunks.push(chunk)))
    return req
  })
  return seen
}

// a body written in three parts, apart, so that it arrives as several chunks
const PART = 100_000
const threeParts = (req, res) => {
  res.writeHead(200)
  res.write(Buffer.alloc(PART, 1))
  setTimeout(() => {
    res.write(Buffer.alloc(PART, 2))
    setTimeout(() => res.end(Buffer.alloc(PART, 3)), 10)
  }, 10)
}

test('the budget covers what a request holds: the body handed over is the chunks received, not a copy', async t => {
  const local = await serve(t, threeParts)
  const seen = watchRequests(t, { chunks: true })
  const concat = t.mock.method(Buffer, 'concat')
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal, maxBytes: 3 * PART, budgetBytes: 3 * PART })
  const response = await fetch(local.origin)
  const received = seen[0].chunks
  assert.ok(received.length >= 3, `${received.length} chunks`)
  const reader = response.body.getReader()
  const handed = []
  for (let read = await reader.read(); !read.done; read = await reader.read()) handed.push(read.value)
  // the very objects that arrived, in order: nothing was assembled or copied on the way
  assert.equal(handed.length, received.length)
  handed.forEach((chunk, i) => assert.equal(chunk, received[i], `chunk ${i}`))
  assert.ok(
    concat.mock.calls.every(call => call.result.length < PART),
    'no body was concatenated'
  )
  // charged once and released at the hand-over: the whole budget is free for the next request
  assert.equal((await (await fetch(local.origin)).arrayBuffer()).byteLength, 3 * PART)
})

test('isPublicAddress: private, loopback, link-local, metadata, mapped and special ranges are not public', () => {
  for (const address of [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    'fe80::1',
    'fe80::1%lo0',
    'fc00::1',
    'fdaa:0:1::3',
    'fec0::1',
    'ff02::1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    'not an address',
    '',
  ]) {
    assert.equal(isPublicAddress(address), false, address)
  }
  // public addresses in use (allocated space only)
  for (const address of [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2606:4700::1111',
    '2a00:1450:4001::1',
    '2a00:1450::1',
    '2400:cb00::1',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
  ]) {
    assert.equal(isPublicAddress(address), true, address)
  }
})

test('isPublicAddress: the edges of every excluded IPv6 range', () => {
  const last = prefix => `${prefix}:ffff:ffff:ffff:ffff:ffff:ffff`
  // [range, first address inside, last address inside, first address outside (allocated, so public), or null
  // where the next address belongs to another excluded range]
  for (const [range, first, end, outside] of [
    ['2001::/23', '2001::', last('2001:1ff'), '2001:200::'], // 2001:200::/23 is APNIC's
    ['2001:db8::/32', '2001:db8::', last('2001:db8'), '2001:db9::'], // in APNIC's 2001:c00::/23
    ['2002::/16', '2002::', last('2002:ffff'), '2003::'], // 2003::/18 is RIPE NCC's
    ['3ffe::/16', '3ffe::', last('3ffe:ffff'), null], // 3fff:: is documentation
    ['3fff::/20', '3fff::', last('3fff:fff'), null], // 3fff:1000:: is unallocated: see below
  ]) {
    assert.equal(isPublicAddress(first), false, `${range}: ${first}`)
    assert.equal(isPublicAddress(end), false, `${range}: ${end}`)
    if (outside) assert.equal(isPublicAddress(outside), true, `${range}: ${outside}`)
  }
  // global unicast itself: 2000::/3 is 2000:: to 3fff:ffff:..., and nothing either side of it
  assert.equal(isPublicAddress(last('1fff:ffff')), false)
  assert.equal(isPublicAddress('4000::'), false)
  // the policy keeps no allocation table inside 2000::/3: an unallocated block there is admitted (it has no route
  // on the public internet). These are the first addresses past 3fff::/20 and inside 2000::/3, both unallocated
  assert.equal(isPublicAddress('3fff:1000::'), true, 'not special-purpose, so not refused')
  assert.equal(isPublicAddress('2000::'), true, 'not special-purpose, so not refused')
})

test('isPublicAddress: IPv6 is public only in global unicast outside its special ranges, in every spelling', () => {
  // [literal, the form the WHATWG URL parser normalises it to]: both are refused
  for (const [literal, normalized] of [
    ['::127.0.0.1', '::7f00:1'], // IPv4-compatible
    ['::ffff:0:127.0.0.1', '::ffff:0:7f00:1'], // IPv4-translated
    ['::ffff:0:8.8.8.8', '::ffff:0:808:808'], // translated, whatever the IPv4 address
    ['::8.8.8.8', '::808:808'], // compatible, whatever the IPv4 address
    ['100:0:0:1::1', '100:0:0:1::1'], // dummy prefix
    ['100::1', '100::1'], // discard
    ['3fff::1', '3fff::1'], // documentation
    ['3fff:fff::1', '3fff:fff::1'], // documentation, the end of the /20
    ['3ffe::1', '3ffe::1'], // returned 6bone space
    ['3ffe:831f::7f00:1', '3ffe:831f::7f00:1'], // the historical Teredo test prefix
    ['3ffe:831f:0:0:0:0:127.0.0.1', '3ffe:831f::7f00:1'],
    ['5f00::1', '5f00::1'], // segment routing
    ['4000::1', '4000::1'], // reserved
    ['1::1', '1::1'], // reserved
    ['e000::1', 'e000::1'], // reserved
    ['::2', '::2'],
    ['0:0:0:0:0:0:0:1', '::1'], // loopback written out
    ['64:ff9b::127.0.0.1', '64:ff9b::7f00:1'], // NAT64
    ['64:ff9b:1::1', '64:ff9b:1::1'], // local NAT64
    ['2001::1', '2001::1'], // Teredo
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:0:4136:e378:8000:63bf:3fff:fdd2'], // Teredo, written out
    ['2001:2::1', '2001:2::1'], // benchmarking
    ['2001:20::1', '2001:20::1'], // ORCHIDv2
    ['2001:1ff::1', '2001:1ff::1'], // the end of 2001::/23
    ['2001:db8:85a3::8a2e:370:7334', '2001:db8:85a3::8a2e:370:7334'], // documentation
    ['2002:c0a8:101::1', '2002:c0a8:101::1'], // 6to4 of 192.168.1.1
    ['2002:808:808::1', '2002:808:808::1'], // 6to4, whatever the IPv4 address
    ['FE80::1', 'fe80::1'],
    ['0:0:0:0:0:ffff:127.0.0.1', '::ffff:7f00:1'], // IPv4-mapped loopback
  ]) {
    assert.equal(new URL(`http://[${literal}]/`).hostname, `[${normalized}]`, literal)
    assert.equal(isPublicAddress(literal), false, literal)
    assert.equal(isPublicAddress(normalized), false, normalized)
  }
})

test('with the production policy an address that is not public is refused before any connection', async t => {
  const local = await serve(t, (req, res) => res.end('secret'))
  const fetch = createOutboundFetch()
  for (const url of [
    `http://127.0.0.1:${local.port}/`,
    `http://localhost.:${local.port}/`, // resolved by the real resolver
    `http://2130706433:${local.port}/`, // 127.0.0.1 as one number
    `http://0x7f.0.0.1:${local.port}/`,
    `http://127.1:${local.port}/`,
    `http://[::1]:${local.port}/`,
    `http://[::ffff:127.0.0.1]:${local.port}/`,
    `http://[::ffff:7f00:1]:${local.port}/`,
    `http://[::127.0.0.1]:${local.port}/`,
    `http://[::ffff:0:127.0.0.1]:${local.port}/`,
    `http://[64:ff9b::127.0.0.1]:${local.port}/`,
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://[fdaa::3]/',
    'http://0.0.0.0/',
    'http://[3fff::1]/',
    'http://[3ffe:831f::7f00:1]/',
    'http://[4000::1]/',
  ]) {
    await assert.rejects(
      fetch(url),
      err => err instanceof OutboundError && (err.code === 'address' || err.code === 'dns'),
      url
    )
  }
  assert.equal(local.connections, 0)
})

test('a name is refused when any of its addresses is not public, and the answer that was checked is the one used', async t => {
  const local = await serve(t, (req, res) => res.end('ok'))
  const calls = []
  const resolver = resolverFor(
    {
      'mixed.test': ['8.8.8.8', '127.0.0.1'],
      'mixed6.test': { A: ['8.8.8.8'], AAAA: ['fd00::1'] },
      'private.test': ['10.1.2.3'],
      'mapped.test': { A: 'ENODATA', AAAA: ['::ffff:127.0.0.1'] },
      'compatible.test': { A: 'ENODATA', AAAA: ['::7f00:1'] },
      'empty.test': { A: 'ENODATA', AAAA: 'ENODATA' },
      'broken.test': { A: 'ESERVFAIL', AAAA: 'ENODATA' },
    },
    calls
  )
  const fetch = createOutboundFetch({ resolver })
  for (const host of ['mixed.test', 'mixed6.test', 'private.test', 'mapped.test', 'compatible.test']) {
    await assert.rejects(fetch(`http://${host}:${local.port}/`), code('address'), host)
  }
  await assert.rejects(
    fetch(`http://empty.test:${local.port}/`),
    err => code('dns')(err) && /no address/.test(err.message)
  )
  await assert.rejects(
    fetch(`http://gone.test:${local.port}/`),
    err => code('dns')(err) && /ENOTFOUND/.test(err.message)
  )
  await assert.rejects(
    fetch(`http://broken.test:${local.port}/`),
    err => code('dns')(err) && /ESERVFAIL/.test(err.message)
  )
  assert.equal(local.connections, 0)
  // both families are asked for every name
  assert.deepEqual(calls.slice(0, 2).sort(), ['A mixed.test', 'AAAA mixed.test'])

  // rebinding: the resolver answers a public address first and a private one afterwards. The name is resolved
  // once, and the connection goes to the address that passed the check
  let resolutions = 0
  const rebinding = () => {
    resolutions++
    return resolverFor({ 'rebind.test': [resolutions === 1 ? '127.0.0.1' : '10.9.9.9'] })()
  }
  const pinned = createOutboundFetch({ resolver: rebinding, isAllowedAddress: allowLocal })
  const response = await pinned(`http://rebind.test:${local.port}/x`)
  assert.equal(await response.text(), 'ok')
  assert.equal(resolutions, 1)
  assert.equal(local.requests[0].headers.host, `rebind.test:${local.port}`)

  // the first IPv4 answer is used when there is one; a family that fails or has no data leaves the other one
  const connected = []
  const record = address => {
    connected.push(address)
    return address === '127.0.0.1' || address === '::1'
  }
  const both = createOutboundFetch({
    resolver: resolverFor({
      'both.test': ['::1', '127.0.0.1'],
      'v4.test': { A: ['127.0.0.1'], AAAA: 'ETIMEOUT' },
    }),
    isAllowedAddress: record,
  })
  assert.equal(await (await both(`http://both.test:${local.port}/`)).text(), 'ok')
  assert.equal(connected.at(-1), '127.0.0.1', 'the socket check saw the IPv4 address')
  assert.equal(await (await both(`http://v4.test:${local.port}/`)).text(), 'ok')
})

test('only http and https, no credentials in the URL, known methods', async () => {
  const fetch = createOutboundFetch()
  await assert.rejects(fetch('file:///etc/passwd'), code('scheme'))
  await assert.rejects(fetch('ftp://example.com/x'), code('scheme'))
  await assert.rejects(fetch('data:text/plain,hi'), code('scheme'))
  await assert.rejects(fetch('not a url'), code('url'))
  await assert.rejects(fetch('http://user:pass@8.8.8.8/'), code('url'))
  await assert.rejects(fetch('http://8.8.8.8/', { method: 'CONNECT' }), code('method'))
  await assert.rejects(fetch('http://8.8.8.8/', { method: 'TRACE' }), code('method'))
  await assert.rejects(fetch('http://8.8.8.8/', { method: 5 }), code('method'))
})

test('a request reaches a permitted server with its method, headers and body, and the response is a standard Response', async t => {
  const local = await serve(t, (req, res, entry) => {
    res.writeHead(201, 'Made', { 'content-type': 'application/json', 'x-seen': entry.headers['x-custom'] || '' })
    res.end(JSON.stringify({ method: entry.method, body: entry.body, host: entry.headers.host }))
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  const response = await fetch(`${local.origin}/path?q=1`, {
    method: 'post',
    headers: { 'X-Custom': 'yes', Host: 'evil.example', 'Content-Length': '999', Connection: 'upgrade' },
    body: 'hello',
  })
  assert.equal(response instanceof Response, true)
  assert.equal(response.status, 201)
  assert.equal(response.ok, true)
  assert.equal(response.statusText, 'Made')
  assert.equal(response.headers.get('x-seen'), 'yes')
  assert.deepEqual(await response.json(), { method: 'POST', body: 'hello', host: `127.0.0.1:${local.port}` })
  const sent = local.requests[0]
  assert.equal(sent.url, '/path?q=1')
  assert.equal(sent.headers['content-length'], '5')
  assert.equal(sent.headers['accept-encoding'], 'gzip, deflate')
  // typed arrays, DataViews, ArrayBuffers and Blobs are accepted as bodies
  const bytes = new Uint8Array([0, 104, 105, 0])
  for (const body of [
    new Uint8Array([104, 105]),
    new Uint8Array([104, 105]).buffer,
    bytes.subarray(1, 3),
    new DataView(bytes.buffer, 1, 2),
    new Blob(['hi']),
  ]) {
    assert.equal((await (await fetch(local.origin, { method: 'PUT', body })).json()).body, 'hi')
  }
})

test('request options as fetch has them: redirect modes, the inferred Content-Type, OPTIONS; anything else is refused', async t => {
  const local = await serve(t, (req, res, entry) => {
    if (req.url === '/moved') return res.writeHead(302, { location: '/final' }).end('moved here')
    res.end(JSON.stringify({ url: req.url, method: entry.method, type: entry.headers['content-type'] || null }))
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  const json = async (path, init) => (await fetch(`${local.origin}${path}`, init)).json()

  // follow (the default) follows; manual hands the redirect back as received; error rejects
  assert.equal((await json('/moved')).url, '/final')
  assert.equal((await json('/moved', { redirect: 'follow' })).url, '/final')
  const requests = local.requests.length
  const manual = await fetch(`${local.origin}/moved`, { redirect: 'manual' })
  assert.equal(manual.status, 302)
  assert.equal(manual.headers.get('location'), '/final')
  assert.equal(await manual.text(), 'moved here')
  await assert.rejects(fetch(`${local.origin}/moved`, { redirect: 'error' }), code('redirect'))
  assert.equal(local.requests.length, requests + 2, 'neither followed the redirect')

  // Content-Type as fetch infers it, unless the caller set one
  assert.equal((await json('/', { method: 'POST', body: 'text' })).type, 'text/plain;charset=UTF-8')
  assert.equal(
    (await json('/', { method: 'POST', body: new Blob(['{}'], { type: 'application/json' }) })).type,
    'application/json'
  )
  assert.equal((await json('/', { method: 'POST', body: new Blob(['x']) })).type, null)
  assert.equal((await json('/', { method: 'POST', body: new Uint8Array([1]) })).type, null)
  assert.equal(
    (await json('/', { method: 'POST', body: 'x', headers: { 'Content-Type': 'application/x-thing' } })).type,
    'application/x-thing'
  )

  // OPTIONS is a method; mode, credentials and cache mean nothing on the server and are ignored
  assert.equal((await json('/', { method: 'OPTIONS' })).method, 'OPTIONS')
  assert.equal((await json('/', { mode: 'cors', credentials: 'include', cache: 'no-store' })).method, 'GET')
  assert.equal((await json('/', { keepalive: undefined })).method, 'GET')

  for (const init of [
    { redirect: 'bogus' },
    { keepalive: true },
    { integrity: 'sha256-x' },
    { referrer: 'https://example.com/' },
    { signal: {} },
    { duplex: 'half' },
  ]) {
    await assert.rejects(fetch(local.origin, init), code('option'), JSON.stringify(init))
  }
  await assert.rejects(fetch(local.origin, 'not options'), code('option'))
  await assert.rejects(fetch(local.origin, { body: 'x' }), code('body'), 'GET with a body')
  await assert.rejects(fetch(local.origin, { method: 'HEAD', body: 'x' }), code('body'))
})

test('headers are validated and bounded before anything is sent; a bad one is a clear refusal, not a timeout', async t => {
  const local = await serve(t, (req, res, entry) => res.end(JSON.stringify(entry.headers)))
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal, timeoutMs: 5000 })
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x-h${i}`, 'v']))
  for (const headers of [
    { 'x-bad': 'a\nb' },
    { 'x-bad': 'a\rb' },
    { 'x-bad': 'a\u0000b' },
    { 'x-bad': 'café☃' },
    { 'bad name': 'v' },
    { 'x-number': 5 },
    many,
    { 'x-large': 'v'.repeat(16 * 1024) },
    'x-not: headers',
  ]) {
    const started = Date.now()
    await assert.rejects(fetch(local.origin, { headers }), code('header'), JSON.stringify(headers).slice(0, 40))
    assert.ok(Date.now() - started < AT_ONCE_MS, 'refused at once')
  }
  assert.equal(local.connections, 0)
  // 64 headers in all, counting the ones sent with every request: Host and Accept-Encoding leave 62 to a GET,
  // and Content-Length and the inferred Content-Type take two more from a POST of a string
  const caller = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [`x-h${i}`, 'v']))
  assert.equal((await (await fetch(local.origin, { headers: caller(62) })).json())['x-h61'], 'v')
  await assert.rejects(fetch(local.origin, { headers: caller(63) }), code('header'))
  const post = count => ({ method: 'POST', body: 'x', headers: caller(count) })
  assert.equal((await (await fetch(local.origin, post(60))).json())['content-type'], 'text/plain;charset=UTF-8')
  await assert.rejects(fetch(local.origin, post(61)), code('header'))
  const seen = await (
    await fetch(local.origin, { headers: { 'X-A': ' one \t', 'x-a': 'two', 'x-trailing': 'value\r\n' } })
  ).json()
  assert.equal(seen['x-a'], 'one, two')
  assert.equal(seen['x-trailing'], 'value')
  // a Headers object and [name, value] pairs work as they do with fetch
  assert.equal((await (await fetch(local.origin, { headers: new Headers({ 'x-b': '1' }) })).json())['x-b'], '1')
  assert.equal((await (await fetch(local.origin, { headers: [['x-c', '2']] })).json())['x-c'], '2')
  await sleep(20)
  assert.deepEqual(unhandled, [])
})

test('repeated headers are combined as the platform combines them: Cookie with "; ", others with ", "', async t => {
  const local = await serve(t, (req, res, entry) => res.end(JSON.stringify(entry.headers)))
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  const sent = async headers => (await fetch(local.origin, { headers })).json()
  const cookies = new Headers()
  cookies.append('cookie', 'session=one')
  cookies.append('cookie', 'pref=two')
  for (const headers of [
    [
      ['cookie', 'session=one'],
      ['Cookie', 'pref=two'],
    ],
    { Cookie: 'session=one', cookie: 'pref=two' },
    cookies,
  ]) {
    assert.equal((await sent(headers)).cookie, 'session=one; pref=two', JSON.stringify([...new Headers(headers)]))
  }
  const ordinary = await sent([
    ['x-list', 'a'],
    ['X-List', 'b'],
    ['host', 'evil.example'],
    ['Connection', 'upgrade'],
  ])
  assert.equal(ordinary['x-list'], 'a, b')
  assert.equal(ordinary.host, `127.0.0.1:${local.port}`, 'a dropped header stays dropped')
  assert.equal(ordinary.connection, 'close')
  // the combined headers stay within the size bound: 64 one-letter names and their values are 16 KiB exactly,
  // and the 63 separators that combining adds take them past it
  const repeated = Array.from({ length: 64 }, () => ['a', 'v'.repeat(255)])
  await assert.rejects(fetch(local.origin, { headers: repeated }), code('header'))
  assert.equal((await sent(repeated.slice(1))).a.length, 63 * 255 + 62 * 2)
})

test('a throw while making, writing or ending the request ends it at once, and its slot comes back', async t => {
  const local = await serve(t, (req, res) => res.end('ok'))
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal, concurrency: 1, timeoutMs: 5000 })
  const original = http.request
  const thrown = name => Object.assign(new Error(name), { code: `E_TEST_${name.toUpperCase()}` })
  let fault = null
  t.mock.method(http, 'request', function (...args) {
    if (fault === 'request') throw thrown('request')
    const req = original.apply(this, args)
    if (fault === 'write') {
      req.write = () => {
        throw thrown('write')
      }
    }
    if (fault === 'end') {
      req.end = () => {
        throw thrown('end')
      }
    }
    return req
  })
  for (fault of ['request', 'write', 'end']) {
    const started = Date.now()
    await assert.rejects(
      fetch(local.origin, { method: 'POST', body: 'x' }),
      err => code('network')(err) && err.message.includes(`E_TEST_${fault.toUpperCase()}`),
      fault
    )
    assert.ok(Date.now() - started < AT_ONCE_MS, `${fault}: at once, not at the deadline`)
  }
  fault = null
  assert.equal(await (await fetch(local.origin)).text(), 'ok', 'the only slot is free again')
  await sleep(20)
  assert.deepEqual(unhandled, [])
})

test('the inferred Content-Type is counted and validated with every other header', async t => {
  const local = await serve(t, (req, res, entry) => res.end(JSON.stringify(entry.headers)))
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  // a 100,000-character type on a one-byte Blob: past the 16 KiB of headers, refused before any connection
  await assert.rejects(
    fetch(local.origin, { method: 'POST', body: new Blob(['x'], { type: 'a'.repeat(100_000) }) }),
    code('header')
  )
  // a Blob whose type carries CR/LF (a Blob made by the platform cannot: it empties such a type)
  class InjectingBlob extends Blob {
    get type() {
      return 'text/plain\r\nx-injected: 1'
    }
  }
  await assert.rejects(fetch(local.origin, { method: 'POST', body: new InjectingBlob(['x']) }), code('header'))
  assert.equal(local.connections, 0)
  // as fetch: the platform's Blob drops a type with characters outside U+0020-U+007E, so none is sent
  const emptied = await (
    await fetch(local.origin, { method: 'POST', body: new Blob(['x'], { type: 'a\r\nb' }) })
  ).json()
  assert.equal(emptied['content-type'], undefined)
  // and a type with spaces and other non-token characters is a valid header value, sent as given (lower-cased)
  const typed = await (
    await fetch(local.origin, { method: 'POST', body: new Blob(['x'], { type: 'Text/Plain; Charset="A B"' }) })
  ).json()
  assert.equal(typed['content-type'], 'text/plain; charset="a b"')
})

// A connect that fails at once, inside libuv's connect() (ENETUNREACH where a family has no route) or one tick
// later, through the real http/https stack. In a child process, so a crash is an exit code
const childScript = `
  import os from 'node:os'
  process.noDeprecation = true
  const { createOutboundFetch } = await import(${JSON.stringify(new URL('../src/core/extras/outboundFetch.js', import.meta.url).href)})
  const { TCP } = process.binding('tcp_wrap')
  const failure = -os.constants.errno.ENETUNREACH
  for (const method of ['connect', 'connect6']) {
    TCP.prototype[method] =
      process.env.WHEN === 'at once'
        ? () => failure
        : function (req) {
            process.nextTick(() => req.oncomplete(failure, this, req, false, false))
            return 0
          }
  }
  const answer = (callback, addresses) =>
    setImmediate(() => (addresses ? callback(null, addresses) : callback(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }))))
  const table = { 'one.test': [['8.8.8.8'], null], 'two.test': [['8.8.8.8'], ['2606:4700::1111']] }
  const resolver = () => ({
    resolve4: (host, callback) => answer(callback, table[host][0]),
    resolve6: (host, callback) => answer(callback, table[host][1]),
    cancel() {},
  })
  const fetch = createOutboundFetch({ resolver, timeoutMs: 5000 })
  const results = {}
  for (const url of ['http://one.test/', 'https://one.test/', 'http://8.8.8.8/', 'https://8.8.8.8/', 'http://two.test/', 'https://two.test/']) {
    try {
      await fetch(url)
      results[url] = 'resolved'
    } catch (err) {
      results[url] = err.code + ': ' + err.message
    }
  }
  await new Promise(resolve => setTimeout(resolve, 50))
  console.log(JSON.stringify(results))
`

test('a connection that fails at once is a network error, not a crash', () => {
  for (const when of ['at once', 'a tick later']) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
      encoding: 'utf8',
      env: { ...process.env, WHEN: when },
      timeout: 60_000,
    })
    assert.equal(run.status, 0, `${when}: the process ended with ${run.status}\n${run.stderr.slice(0, 2000)}`)
    const results = JSON.parse(run.stdout.trim().split('\n').at(-1))
    for (const [url, outcome] of Object.entries(results)) {
      // the connect's own error, also on https (where an unchecked socket used to read as "could not send")
      assert.match(outcome, /^network: outbound request failed: (ENETUNREACH|ETIMEDOUT)/, `${when} ${url}`)
    }
    assert.equal(Object.keys(results).length, 6)
  }
})

test('an error an exchange’s emitters raise after it settled is ignored, never thrown', async t => {
  const local = await serve(t, (req, res) => {
    if (req.url === '/moved') return res.writeHead(302, { location: '/gzip' }).end('moved')
    if (req.method === 'HEAD') return res.writeHead(200, { 'content-length': '5' }).end()
    res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync('compressed'))
  })
  const emitters = []
  const original = http.request
  t.mock.method(http, 'request', function (...args) {
    const req = original.apply(this, args)
    emitters.push(['request', req])
    req.on('socket', socket => emitters.push(['socket', socket]))
    req.on('response', res => emitters.push(['response', res]))
    return req
  })
  const createGunzip = zlib.createGunzip
  t.mock.method(zlib, 'createGunzip', (...args) => {
    const decoder = createGunzip(...args)
    emitters.push(['decoder', decoder])
    return decoder
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  assert.equal(await (await fetch(`${local.origin}/moved`)).text(), 'compressed')
  await fetch(local.origin, { method: 'HEAD' })
  await sleep(20)
  const kinds = new Set(emitters.map(([kind]) => kind))
  assert.deepEqual([...kinds].sort(), ['decoder', 'request', 'response', 'socket'])
  const uncaught = []
  const onUncaught = err => uncaught.push(err)
  process.on('uncaughtException', onUncaught)
  t.after(() => process.off('uncaughtException', onUncaught))
  for (const [kind, emitter] of emitters) {
    assert.doesNotThrow(() => emitter.emit('error', new Error(`late ${kind} error`)), kind)
  }
  await sleep(20)
  assert.deepEqual(uncaught, [])
  assert.deepEqual(unhandled, [])
})

test('a request body is admitted, sized and read under the deadline; only the listed types are accepted', async t => {
  const local = await serve(t, (req, res, entry) => res.end(entry.body))
  const fetch = createOutboundFetch({
    isAllowedAddress: allowLocal,
    maxRequestBytes: 10,
    concurrency: 1,
    timeoutMs: 150,
  })
  // sizes are checked before a body is converted: a string by its UTF-8 length, a Blob before it is read
  await assert.rejects(fetch(local.origin, { method: 'POST', body: 'x'.repeat(11) }), code('too_large'))
  await assert.rejects(fetch(local.origin, { method: 'POST', body: 'é'.repeat(6) }), code('too_large'))
  await assert.rejects(fetch(local.origin, { method: 'POST', body: new Uint8Array(11) }), code('too_large'))
  let reads = 0
  class CountingBlob extends Blob {
    arrayBuffer() {
      reads++
      return super.arrayBuffer()
    }
  }
  await assert.rejects(
    fetch(local.origin, { method: 'POST', body: new CountingBlob(['x'.repeat(11)]) }),
    code('too_large')
  )
  assert.equal(reads, 0, 'the Blob was not read')
  assert.equal(
    await (await fetch(local.origin, { method: 'POST', body: new CountingBlob(['0123456789']) })).text(),
    '0123456789'
  )
  for (const body of [{ not: 'bytes' }, new URLSearchParams('a=b'), { arrayBuffer: async () => new ArrayBuffer(1) }]) {
    await assert.rejects(fetch(local.origin, { method: 'POST', body }), code('body'))
  }
  assert.equal(local.connections, 1)

  // a body that never finishes reading holds the request's slot, and the deadline and the caller's abort end it
  class StuckBlob extends Blob {
    arrayBuffer() {
      return new Promise(() => {})
    }
  }
  const started = Date.now()
  const stuck = fetch(local.origin, { method: 'POST', body: new StuckBlob(['x']) })
  await assert.rejects(fetch(local.origin), code('busy'), 'the stuck request holds the only slot')
  await assert.rejects(stuck, code('timeout'))
  assert.ok(Date.now() - started < AT_ONCE_MS)
  const controller = new AbortController()
  const aborted = fetch(local.origin, { method: 'POST', body: new StuckBlob(['x']), signal: controller.signal })
  controller.abort()
  await assert.rejects(aborted, code('aborted'))
  const preAborted = AbortSignal.abort()
  await assert.rejects(
    fetch(local.origin, { method: 'POST', body: new StuckBlob(['x']), signal: preAborted }),
    code('aborted')
  )
  // every slot came back
  assert.equal(await (await fetch(local.origin, { method: 'POST', body: 'ok' })).text(), 'ok')
})

test('gzip and deflate are decoded; Brotli and unknown encodings are refused', async t => {
  const local = await serve(t, (req, res) => {
    const kind = req.url.slice(1)
    const text = 'x'.repeat(1000)
    if (kind === 'gzip') return res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync(text))
    if (kind === 'deflate') return res.writeHead(200, { 'content-encoding': 'deflate' }).end(zlib.deflateSync(text))
    if (kind === 'br') return res.writeHead(200, { 'content-encoding': 'br' }).end(zlib.brotliCompressSync(text))
    if (kind === 'bad') return res.writeHead(200, { 'content-encoding': 'gzip' }).end('not gzip')
    if (kind === 'plain') return res.writeHead(200, { 'content-length': '1000' }).end(text)
    res.writeHead(200, { 'content-encoding': 'zstd' }).end(text)
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  for (const kind of ['gzip', 'deflate']) {
    const response = await fetch(`${local.origin}/${kind}`)
    assert.equal((await response.text()).length, 1000)
    // the body is handed over decoded: its transfer's encoding and length no longer apply
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(response.headers.get('content-length'), null)
  }
  assert.equal((await fetch(`${local.origin}/plain`)).headers.get('content-length'), '1000')
  await assert.rejects(fetch(`${local.origin}/br`), code('encoding'))
  await assert.rejects(fetch(`${local.origin}/zstd`), code('encoding'))
  await assert.rejects(fetch(`${local.origin}/bad`), code('network'))
})

test('a response without a body is not decoded, whatever its Content-Encoding says', async t => {
  const local = await serve(t, (req, res) => {
    const status = Number(req.url.slice(1)) || 200
    res.writeHead(status, { 'content-encoding': 'gzip', 'content-length': status === 200 ? '20' : '0', etag: '"v1"' })
    res.end()
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  const head = await fetch(`${local.origin}/`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  // the headers describe the representation and stay as received
  assert.equal(head.headers.get('content-encoding'), 'gzip')
  assert.equal(head.headers.get('content-length'), '20')
  for (const status of [204, 205, 304]) {
    const response = await fetch(`${local.origin}/${status}`)
    assert.equal(response.status, status)
    assert.equal(await response.text(), '')
    assert.equal(response.headers.get('etag'), '"v1"')
  }
})

test('the decoded body is capped: a large response and a compression bomb both stop at the limit', async t => {
  const local = await serve(t, (req, res) => {
    if (req.url === '/bomb') {
      // 16 MiB of zeros in about 16 KiB
      return res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync(Buffer.alloc(16 * 1024 * 1024)))
    }
    if (req.url === '/endless') {
      res.writeHead(200)
      const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 1)
      res.on('close', () => clearInterval(timer))
      return
    }
    res.end(Buffer.alloc(Number(req.url.slice(1))))
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal, maxBytes: 100_000 })
  assert.equal((await (await fetch(`${local.origin}/100000`)).arrayBuffer()).byteLength, 100_000)
  await assert.rejects(fetch(`${local.origin}/100001`), code('too_large'))
  await assert.rejects(fetch(`${local.origin}/bomb`), code('too_large'))
  await assert.rejects(fetch(`${local.origin}/endless`), code('too_large'))
  await assert.rejects(
    fetch(local.origin, { method: 'POST', body: Buffer.alloc(OUTBOUND_DEFAULTS.maxRequestBytes + 1) }),
    code('too_large')
  )
})

test('one deadline covers connecting, redirects and the body; a caller can abort', async t => {
  const local = await serve(t, (req, res) => {
    if (req.url === '/never') return // no response
    if (req.url === '/slow-body') {
      res.writeHead(200)
      res.write('start')
      return
    }
    if (req.url === '/hop') {
      return setTimeout(() => res.writeHead(302, { location: '/hop' }).end(), 60)
    }
    res.end('ok')
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal, timeoutMs: 200, maxRedirects: 50 })
  for (const path of ['/never', '/slow-body', '/hop']) {
    const started = Date.now()
    await assert.rejects(fetch(`${local.origin}${path}`), code('timeout'), path)
    assert.ok(Date.now() - started < AT_ONCE_MS, `${path} ended near its deadline`)
  }
  const controller = new AbortController()
  const pending = fetch(`${local.origin}/never`, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, code('aborted'))
  await assert.rejects(fetch(`${local.origin}/ok`, { signal: controller.signal }), code('aborted'))
})

test('the deadline covers a connection that never completes its handshake', async t => {
  // accepts TCP and never answers TLS: the request is never even sent
  const accepted = []
  const server = net.createServer(socket => {
    const entry = { closed: false }
    accepted.push(entry)
    socket.resume() // reads the ClientHello, so the client's close is seen
    socket.on('close', () => (entry.closed = true))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address()
  const seen = watchRequests(t, { module: https })
  // a deadline long enough for a slow machine to accept the connection, and a wide margin past it
  const timeoutMs = 1000
  const fetch = createOutboundFetch({
    resolver: resolverFor({ 'stall.test': ['127.0.0.1'] }),
    isAllowedAddress: allowLocal,
    timeoutMs,
  })
  const started = Date.now()
  await assert.rejects(fetch(`https://stall.test:${port}/`), code('timeout'))
  const elapsed = Date.now() - started
  assert.ok(elapsed >= timeoutMs - 50 && elapsed < timeoutMs + 3000, `ended at ${elapsed} ms`)
  // the client's connection is closed at the deadline, and the server sees it go
  assert.equal(seen.length, 1)
  await waitFor(() => seen[0].closed, 3000, 'the client connection to close')
  await waitFor(() => accepted.length === 1 && accepted[0].closed, 3000, 'the server to see the close')
})

test('the deadline covers resolving the name: a slow answer is cancelled, and its slot comes back only once it has ended', async () => {
  let outstanding = 0
  let cancels = 0
  const resolver = () => {
    const queries = []
    const query = (host, callback) => {
      outstanding++
      queries.push(callback)
    }
    return {
      resolve4: query,
      resolve6: query,
      cancel() {
        cancels++
        // c-ares answers a cancel with ECANCELLED for every query, a little later
        setTimeout(() => {
          for (const callback of queries.splice(0)) {
            outstanding--
            callback(dnsError('ECANCELLED'))
          }
        }, 100)
      },
    }
  }
  const fetch = createOutboundFetch({ resolver, concurrency: 1, timeoutMs: 100 })
  const started = Date.now()
  await assert.rejects(fetch('http://slow.test/'), code('timeout'))
  assert.ok(Date.now() - started < AT_ONCE_MS, 'the caller hears of the timeout at the deadline')
  assert.equal(cancels, 1)
  assert.equal(outstanding, 2)
  // the queries are still running: the request still holds its slot
  await assert.rejects(fetch('http://10.0.0.1/'), code('busy'))
  await waitFor(() => outstanding === 0, 1000, 'the cancelled queries to end')
  await sleep(0)
  // admitted again (and refused for its own reason)
  await assert.rejects(fetch('http://10.0.0.1/'), code('address'))

  // repeated timeouts and aborts leave nothing running behind them
  for (let i = 0; i < 5; i++) {
    await assert.rejects(fetch(`http://slow-${i}.test/`), code('timeout'))
    await waitFor(() => outstanding === 0, 1000, 'the queries to end')
    await sleep(0)
  }
  const controller = new AbortController()
  const aborted = fetch('http://slow.test/', { signal: controller.signal })
  await waitFor(() => outstanding === 2, 1000, 'the queries to start')
  controller.abort()
  await assert.rejects(aborted, code('aborted'))
  await waitFor(() => outstanding === 0, 1000, 'the aborted queries to end')
  assert.equal(cancels, 7)
})

test('a resolver that answers or throws at once still has its other query counted, cancelled and waited for', async t => {
  const local = await serve(t, (req, res) => res.end('ok'))
  let cancels = 0
  // resolve4 answers inside the call (or throws); resolve6 ends only when cancelled
  const resolverWith = first => () => {
    const pending = []
    return {
      resolve4: first,
      resolve6: (host, callback) => pending.push(callback),
      cancel() {
        cancels++
        setTimeout(() => pending.splice(0).forEach(callback => callback(dnsError('ECANCELLED'))), 20)
      },
    }
  }
  for (const [what, first] of [
    ['answers at once', (host, callback) => callback(null, ['127.0.0.1'])],
    [
      'throws',
      () => {
        throw new Error('resolver broke')
      },
    ],
  ]) {
    const fetch = createOutboundFetch({
      resolver: resolverWith(first),
      isAllowedAddress: allowLocal,
      concurrency: 1,
      timeoutMs: 100,
    })
    const before = cancels
    await assert.rejects(fetch('http://slow6.test/'), code('timeout'), what)
    assert.equal(cancels, before + 1, `${what}: the other query was cancelled`)
    await sleep(60)
    // the slot came back once that query ended: the next request is admitted (and refused for its own reason)
    await assert.rejects(fetch('http://10.0.0.1/'), code('address'), what)
  }
  // both answering inside the call: the request goes ahead normally
  const immediate = createOutboundFetch({
    resolver: () => ({
      resolve4: (host, callback) => callback(null, ['127.0.0.1']),
      resolve6: (host, callback) => callback(dnsError('ENODATA')),
      cancel() {},
    }),
    isAllowedAddress: allowLocal,
    concurrency: 1,
  })
  for (let i = 0; i < 3; i++) assert.equal(await (await immediate(`http://now.test:${local.port}/`)).text(), 'ok')
})

test('a request gives its slot back as soon as it has ended, DNS included: requests one after another always fit', async t => {
  const local = await serve(t, (req, res) => res.end('ok'))
  const fetch = createOutboundFetch({
    resolver: resolverFor({ 'private.test': ['10.0.0.1'], 'local.test': ['127.0.0.1'] }),
    isAllowedAddress: allowLocal,
    concurrency: 1,
  })
  const outcomes = []
  for (let i = 0; i < 3; i++) {
    try {
      await fetch('http://private.test/')
      outcomes.push('fetched')
    } catch (err) {
      outcomes.push(err.code)
    }
  }
  for (let i = 0; i < 3; i++) {
    try {
      const response = await fetch(`http://local.test:${local.port}/`)
      outcomes.push(response.status)
    } catch (err) {
      outcomes.push(err.code)
    }
  }
  assert.deepEqual(outcomes, ['address', 'address', 'address', 200, 200, 200])
})

test('when the checked address does not connect, one more checked answer is tried, of the other family first', async t => {
  const allowLoopback = address => /^127\.0\.0\.\d+$/.test(address) || address === '::1'
  // a server on IPv6 loopback only: the IPv4 answer is refused there, and the IPv6 one connects
  const v6 = http.createServer((req, res) => res.end(`via ${req.socket.localAddress}`))
  const listening = await new Promise(resolve => {
    v6.once('error', () => resolve(false))
    v6.listen({ port: 0, host: '::1', ipv6Only: true }, () => resolve(true))
  })
  t.after(() => v6.close())
  if (listening) {
    const connected = []
    const fetch = createOutboundFetch({
      resolver: resolverFor({ 'both.test': ['127.0.0.1', '::1'] }),
      isAllowedAddress: address => (connected.push(address), allowLoopback(address)),
    })
    assert.equal(await (await fetch(`http://both.test:${v6.address().port}/`)).text(), 'via ::1')
    assert.equal(connected.at(-1), '::1', 'the socket check saw the fallback')
  } else {
    t.diagnostic('no IPv6 loopback here: the cross-family case is skipped')
  }

  // the same family when there is no other: 127.0.0.2 does not answer (a hang on macOS, a refusal on Linux)
  const local = await serve(t, (req, res) => res.end('reached'))
  const sameFamily = createOutboundFetch({
    resolver: resolverFor({ 'two.test': ['127.0.0.2', '127.0.0.1'] }),
    isAllowedAddress: allowLoopback,
    timeoutMs: 3000,
  })
  // reached at all is within the one deadline: past it the request rejects with `timeout`
  assert.equal(await (await sameFamily(`http://two.test:${local.port}/`)).text(), 'reached')
  // one more, not every answer: the third address is never tried
  const connections = local.connections
  const failing = createOutboundFetch({
    resolver: resolverFor({ 'three.test': ['127.0.0.2', '127.0.0.3', '127.0.0.1'] }),
    isAllowedAddress: allowLoopback,
    timeoutMs: 1000,
  })
  await assert.rejects(failing(`http://three.test:${local.port}/`), err => code('timeout')(err) || code('network')(err))
  await sleep(50)
  assert.equal(local.connections, connections, 'nothing reached 127.0.0.1')
})

test('the connected address is checked again before anything is sent', async t => {
  const local = await serve(t, (req, res) => res.end('reached'))
  // the answer passes and the connection does not: it stands for a destination that changed in between
  let checks = 0
  const isAllowedAddress = address => address === '127.0.0.1' && ++checks === 1
  const fetch = createOutboundFetch({ resolver: resolverFor({ 'pinned.test': ['127.0.0.1'] }), isAllowedAddress })
  await assert.rejects(
    fetch(`http://pinned.test:${local.port}/`),
    err => code('address')(err) && /connected to an address/.test(err.message)
  )
  assert.equal(checks, 2)
  await waitFor(() => local.connections === 1, 1000, 'the server to see the connection')
  await sleep(50)
  assert.equal(local.requests.length, 0, 'no request was written to the connection')

  // a check that throws ends the request at once instead of escaping as an exception
  const throwing = createOutboundFetch({
    resolver: resolverFor({ 'pinned.test': ['127.0.0.1'] }),
    isAllowedAddress: () => {
      if (++checks > 3) throw new Error('broken policy')
      return true
    },
    timeoutMs: 5000,
  })
  const started = Date.now()
  await assert.rejects(throwing(`http://pinned.test:${local.port}/`), code('network'))
  assert.ok(Date.now() - started < AT_ONCE_MS)
})

test('every request has a connection of its own', async t => {
  const local = await serve(t, (req, res) => res.end('ok'), { keepAlive: true, keepAliveTimeout: 5000 })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  for (let i = 0; i < 3; i++) assert.equal(await (await fetch(local.origin)).text(), 'ok')
  assert.equal(local.connections, 3)
  assert.ok(local.requests.every(request => request.headers.connection === 'close'))
  await waitFor(() => local.sockets.every(socket => socket.destroyed), 1000, 'the connections to close')
})

test('a redirect that is followed is not read: its connection closes at once, whatever its body', async t => {
  const redirects = {}
  const local = await serve(t, (req, res) => {
    if (req.url === '/endless' || req.url === '/large') {
      // a redirect whose body never ends, and one whose body is far larger than maxBytes
      const length = req.url === '/large' ? { 'content-length': String(256 * 1024 * 1024) } : {}
      res.writeHead(302, { location: '/final', ...length })
      const state = { closed: false }
      redirects[req.url] = state
      const chunk = Buffer.alloc(64 * 1024)
      const pump = () => {
        while (!res.destroyed && res.write(chunk));
      }
      res.on('drain', pump)
      res.on('close', () => (state.closed = true))
      return pump()
    }
    res.end('final')
  })
  const seen = watchRequests(t)
  const maxBytes = 4 * 1024 * 1024
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal, maxBytes, budgetBytes: maxBytes, timeoutMs: 5000 })
  for (const [i, path] of ['/endless', '/large'].entries()) {
    assert.equal(await (await fetch(`${local.origin}${path}`)).text(), 'final', path)
    const redirect = seen[2 * i] // the redirect's exchange, then the final one's
    await waitFor(() => redirect.closed, 2000, `the ${path} redirect's connection to close`)
    // what the client took in: the headers and whatever came with them in its first read, nothing after
    assert.ok(redirect.bytesRead < 1024 * 1024, `${path}: the client read ${redirect.bytesRead} bytes`)
    await waitFor(() => redirects[path].closed, 2000, `the server to see the ${path} redirect's connection close`)
  }
})

test('redirects are followed here, hop by hop through the same checks', async t => {
  const other = await serve(t, (req, res, entry) => res.end(JSON.stringify({ at: 'other', headers: entry.headers })))
  const local = await serve(t, (req, res, entry) => {
    const [path, arg] = req.url.slice(1).split('?')
    if (path === 'to-private') return res.writeHead(302, { location: 'http://10.0.0.1/secret' }).end()
    if (path === 'to-metadata') return res.writeHead(307, { location: 'http://169.254.169.254/latest/' }).end()
    if (path === 'to-compatible') return res.writeHead(307, { location: 'http://[::127.0.0.1]/' }).end()
    if (path === 'to-file') return res.writeHead(302, { location: 'file:///etc/passwd' }).end()
    if (path === 'to-other') return res.writeHead(302, { location: `http://localhost:${other.port}/landed` }).end()
    if (path === 'loop') return res.writeHead(302, { location: `/loop?${Number(arg || 0) + 1}` }).end()
    if (path === 'see-other') return res.writeHead(303, { location: '/final' }).end()
    if (path === 'keep') return res.writeHead(307, { location: '/final' }).end()
    if (path === 'bad') return res.writeHead(302, { location: 'http://[' }).end()
    if (path === 'nowhere') return res.writeHead(302).end('no location')
    if (path === 'here') return res.writeHead(302, { location: '' }).end('an empty Location')
    res.writeHead(200, { 'x-method': entry.method })
    res.end(JSON.stringify({ method: entry.method, body: entry.body, type: entry.headers['content-type'] || null }))
  })
  const resolver = resolverFor({ localhost: ['127.0.0.1'] })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal, resolver, maxRedirects: 3 })
  await assert.rejects(fetch(`${local.origin}/to-private`), code('address'))
  await assert.rejects(fetch(`${local.origin}/to-metadata`), code('address'))
  await assert.rejects(fetch(`${local.origin}/to-compatible`), code('address'))
  await assert.rejects(fetch(`${local.origin}/to-file`), code('scheme'))
  await assert.rejects(fetch(`${local.origin}/bad`), code('url'))
  await assert.rejects(fetch(`${local.origin}/loop`), code('redirects'))
  assert.equal(local.requests.filter(r => r.url.startsWith('/loop')).length, 4) // the first and three redirects
  // a redirect status without a Location is the response
  const nowhere = await fetch(`${local.origin}/nowhere`)
  assert.equal(nowhere.status, 302)
  assert.equal(await nowhere.text(), 'no location')
  // an empty Location is this same URL, as fetch reads it: followed until the limit, or handed back when manual
  const before = local.requests.length
  await assert.rejects(fetch(`${local.origin}/here`), code('redirects'))
  assert.equal(local.requests.length - before, 4)
  assert.ok(local.requests.slice(before).every(request => request.url === '/here'))
  const manual = await fetch(`${local.origin}/here`, { redirect: 'manual' })
  assert.equal(manual.status, 302)
  assert.equal(manual.headers.get('location'), '')
  // 303 keeps a HEAD a HEAD
  const head = await fetch(`${local.origin}/see-other`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('x-method'), 'HEAD')
  // 303 turns a POST into a GET without its body; 307 keeps both
  const init = { method: 'POST', body: 'data', headers: { 'content-type': 'text/plain' } }
  assert.deepEqual(await (await fetch(`${local.origin}/see-other`, init)).json(), {
    method: 'GET',
    body: '',
    type: null,
  })
  assert.deepEqual(await (await fetch(`${local.origin}/keep`, init)).json(), {
    method: 'POST',
    body: 'data',
    type: 'text/plain',
  })
  // the GET loses fetch's request-body headers only; other content-* headers stay
  const echo = await serve(t, (req, res, entry) => {
    if (req.url === '/see-other') return res.writeHead(303, { location: '/final' }).end()
    res.end(JSON.stringify(entry.headers))
  })
  const rewritten = await (
    await fetch(`${echo.origin}/see-other`, {
      method: 'POST',
      body: 'data',
      headers: {
        'content-type': 'text/plain',
        'content-encoding': 'identity',
        'content-language': 'en',
        'content-location': '/data',
        'content-range': 'bytes 0-3/4',
        'content-x-app': 'kept',
      },
    })
  ).json()
  for (const name of ['content-type', 'content-encoding', 'content-language', 'content-location', 'content-length']) {
    assert.equal(rewritten[name], undefined, name)
  }
  assert.equal(rewritten['content-range'], 'bytes 0-3/4')
  assert.equal(rewritten['content-x-app'], 'kept')
  // credentials do not follow a redirect to another origin; other headers do
  const landed = await (
    await fetch(`${local.origin}/to-other`, {
      headers: { authorization: 'Bearer secret', cookie: 'a=b', 'x-keep': '1' },
    })
  ).json()
  assert.equal(landed.at, 'other')
  assert.equal(landed.headers.authorization, undefined)
  assert.equal(landed.headers.cookie, undefined)
  assert.equal(landed.headers['x-keep'], '1')
  assert.equal(landed.headers.host, `localhost:${other.port}`)
})

test('concurrency: a cap for all callers and one per key; over it a request is refused, and slots come back', async t => {
  const waiting = []
  const local = await serve(t, (req, res) => waiting.push(res))
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal, concurrency: 3, perKey: 2 })
  const a1 = fetch(local.origin, {}, { key: 'a' })
  const a2 = fetch(local.origin, {}, { key: 'a' })
  await assert.rejects(fetch(local.origin, {}, { key: 'a' }), code('busy'))
  const b1 = fetch(local.origin, {}, { key: 'b' })
  await assert.rejects(fetch(local.origin, {}, { key: 'c' }), code('busy'))
  await assert.rejects(fetch(local.origin), code('busy'))
  while (waiting.length < 3) await sleep(5)
  for (const res of waiting) res.end('done')
  assert.deepEqual(await Promise.all([a1, a2, b1].map(async p => (await p).text())), ['done', 'done', 'done'])
  // every slot is free again, also after failures
  await assert.rejects(fetch('http://10.0.0.1/', {}, { key: 'a' }), code('address'))
  await assert.rejects(fetch(local.origin, { headers: { 'x-bad': 'a\nb' } }, { key: 'a' }), code('header'))
  const again = [
    fetch(local.origin, {}, { key: 'a' }),
    fetch(local.origin, {}, { key: 'a' }),
    fetch(local.origin, {}, { key: 'b' }),
  ]
  while (waiting.length < 6) await sleep(5)
  for (const res of waiting.slice(3)) res.end('again')
  assert.deepEqual(await Promise.all(again.map(async p => (await p).text())), ['again', 'again', 'again'])
})

test('all responses in flight share one memory budget', async t => {
  const waiting = []
  const local = await serve(t, (req, res) => {
    res.writeHead(200)
    res.write(Buffer.alloc(60_000))
    waiting.push(res)
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal, maxBytes: 80_000, budgetBytes: 100_000 })
  const first = fetch(local.origin)
  while (waiting.length < 1) await sleep(5)
  // the second response's 60,000 bytes do not fit next to the first's
  await assert.rejects(fetch(local.origin), code('busy'))
  waiting[0].end()
  assert.equal((await (await first).arrayBuffer()).byteLength, 60_000)
  // released: the same request fits now
  const third = fetch(local.origin)
  while (waiting.length < 3) await sleep(5)
  waiting[2].end()
  assert.equal((await (await third).arrayBuffer()).byteLength, 60_000)
})

test('the body handed over still follows the caller’s signal, as fetch’s does', async t => {
  const local = await serve(t, threeParts)
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  const isAbortError = err => err?.name === 'AbortError'
  // aborted before the body is read: reading it rejects with an AbortError, as native fetch's body does
  const first = new AbortController()
  const unread = await fetch(local.origin, { signal: first.signal })
  first.abort()
  await assert.rejects(unread.text(), isAbortError)
  // the reason given to abort() is the error
  const second = new AbortController()
  const withReason = await fetch(local.origin, { signal: second.signal })
  const reason = new Error('enough')
  second.abort(reason)
  await assert.rejects(withReason.arrayBuffer(), err => err === reason)
  // partly read: the rest is not delivered
  const third = new AbortController()
  const partly = await fetch(local.origin, { signal: third.signal })
  const reader = partly.body.getReader()
  assert.equal((await reader.read()).done, false)
  third.abort()
  await assert.rejects(reader.read(), isAbortError)
  // read to the end first: a later abort changes nothing, and nothing is left listening
  const fourth = new AbortController()
  const whole = await fetch(local.origin, { signal: fourth.signal })
  assert.equal((await whole.arrayBuffer()).byteLength, 3 * PART)
  assert.equal(getEventListeners(fourth.signal, 'abort').length, 0)
  fourth.abort()
})

test('an empty body is abortable after the hand-over too; HEAD, 204 and 304 have no body at all', async t => {
  const local = await serve(t, (req, res) => {
    const status = Number(req.url.slice(1)) || 200
    res.writeHead(status, { 'content-length': '0' }).end()
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  // a 200 with no bytes: nothing is read ahead, so the body is still open when the caller gets it
  const controller = new AbortController()
  const empty = await fetch(local.origin, { signal: controller.signal })
  assert.notEqual(empty.body, null)
  controller.abort()
  await assert.rejects(empty.text(), err => err?.name === 'AbortError')
  // read, it is empty
  assert.equal(await (await fetch(local.origin)).text(), '')
  for (const [path, init] of [
    ['/', { method: 'HEAD' }],
    ['/204', {}],
    ['/304', {}],
  ]) {
    const aborting = new AbortController()
    const response = await fetch(`${local.origin}${path}`, { ...init, signal: aborting.signal })
    assert.equal(response.body, null, path)
    aborting.abort()
    assert.equal(await response.text(), '', `${path}: nothing to abort`)
  }
})

test('one long-lived signal for many requests keeps no listener behind', async t => {
  const local = await serve(t, (req, res) => res.end('ok'))
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  const warnings = []
  const onWarning = warning => warnings.push(warning)
  process.on('warning', onWarning)
  t.after(() => process.off('warning', onWarning))
  const { signal } = new AbortController()
  for (let i = 0; i < 1000; i++) assert.equal(await (await fetch(local.origin, { signal })).text(), 'ok')
  assert.equal(getEventListeners(signal, 'abort').length, 0)
  // a refused request, a body cancelled unread and one without a body leave none either
  await assert.rejects(fetch('http://10.0.0.1/', { signal }), code('address'))
  await (await fetch(local.origin, { signal })).body.cancel()
  await fetch(local.origin, { signal, method: 'HEAD' })
  assert.equal(getEventListeners(signal, 'abort').length, 0)
  await sleep(0)
  assert.deepEqual(
    warnings.filter(warning => warning.name === 'MaxListenersExceededWarning'),
    [],
    'no listener build-up'
  )
})

test(
  'a body nobody reads holds its abort listener weakly: once it is collected, the listener goes too',
  { skip: gc ? false : 'gc cannot be exposed in this process, so collection cannot be driven' },
  async t => {
    const local = await serve(t, (req, res) => res.end('ok'))
    const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
    const { signal } = new AbortController()
    const dropUnread = async () => {
      for (let i = 0; i < 8; i++) await fetch(local.origin, { signal })
    }
    await dropUnread()
    assert.equal(getEventListeners(signal, 'abort').length, 8)
    // collections and turns of the event loop until the registry has run, with a generous deadline: when its
    // callbacks run after a collection is up to the engine
    const until = Date.now() + 20_000
    while (getEventListeners(signal, 'abort').length > 0 && Date.now() < until) {
      gc()
      await sleep(20)
    }
    assert.equal(getEventListeners(signal, 'abort').length, 0, 'the collected bodies took their listeners along')
  }
)

test('a trusted origin (the configured assets URL) is reached without the address check; nothing else is', async t => {
  const local = await serve(t, (req, res) => {
    if (req.url === '/out') return res.writeHead(302, { location: 'http://10.0.0.1/x' }).end()
    res.end('asset')
  })
  const other = await serve(t, (req, res) => res.end('other'))
  const fetch = createOutboundFetch({ trustedOrigins: [`${local.origin}/assets`, 'not a url'] })
  assert.equal(await (await fetch(`${local.origin}/assets/a.glb`)).text(), 'asset')
  await assert.rejects(fetch(`${other.origin}/`), code('address')) // same host, another port: another origin
  await assert.rejects(fetch(`${local.origin}/out`), code('address')) // a redirect leaves the trusted origin
  assert.equal(other.connections, 0)
})

test('responses without a body, error statuses and a dropped connection', async t => {
  const local = await serve(t, (req, res) => {
    if (req.url === '/204') return res.writeHead(204).end()
    if (req.url === '/500') return res.writeHead(500).end('broken')
    if (req.url === '/drop') return res.destroy()
    if (req.url === '/head') return res.writeHead(200, { 'content-length': '5' }).end()
    res.writeHead(200, { 'content-length': '100' })
    res.write('partial')
    setTimeout(() => res.destroy(), 20)
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  const empty = await fetch(`${local.origin}/204`)
  assert.equal(empty.status, 204)
  assert.equal(await empty.text(), '')
  const failed = await fetch(`${local.origin}/500`)
  assert.equal(failed.ok, false)
  assert.equal(await failed.text(), 'broken')
  const head = await fetch(`${local.origin}/head`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  await assert.rejects(fetch(`${local.origin}/drop`), code('network'))
  await assert.rejects(fetch(`${local.origin}/cut`), code('network'))
  await sleep(20)
  assert.deepEqual(unhandled, [])
})
