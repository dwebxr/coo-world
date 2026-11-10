import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'

import {
  OUTBOUND_DEFAULTS,
  OutboundError,
  createOutboundFetch,
  isPublicAddress,
} from '../src/core/extras/outboundFetch.js'

// a local server; `handler` gets (req, res). Connections are counted so a test can assert none was made.
async function serve(t, handler) {
  const state = { requests: [], connections: 0 }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }
      state.requests.push(entry)
      handler(req, res, entry)
    })
  })
  server.on('connection', () => state.connections++)
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
    'fc00::1',
    'fdaa:0:1::3',
    'ff02::1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    'not an address',
    '',
  ]) {
    assert.equal(isPublicAddress(address), false, address)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(address), true, address)
  }
})

test('with the production policy an address that is not public is refused before any connection', async t => {
  const local = await serve(t, (req, res) => res.end('secret'))
  const fetch = createOutboundFetch()
  for (const url of [
    `http://127.0.0.1:${local.port}/`,
    `http://localhost.:${local.port}/`, // resolved by the real resolver below
    `http://2130706433:${local.port}/`, // 127.0.0.1 as one number
    `http://0x7f.0.0.1:${local.port}/`,
    `http://127.1:${local.port}/`,
    `http://[::1]:${local.port}/`,
    `http://[::ffff:127.0.0.1]:${local.port}/`,
    `http://[::ffff:7f00:1]:${local.port}/`,
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://[fdaa::3]/',
    'http://0.0.0.0/',
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
  const answers = {
    'mixed.test': [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    'private.test': [{ address: '10.1.2.3', family: 4 }],
    'mapped.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
    'empty.test': [],
  }
  const lookups = []
  const lookup = (host, options, callback) => {
    lookups.push(host)
    if (host === 'gone.test') return callback(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }))
    callback(null, answers[host])
  }
  const fetch = createOutboundFetch({ lookup })
  for (const host of ['mixed.test', 'private.test', 'mapped.test']) {
    await assert.rejects(fetch(`http://${host}:${local.port}/`), code('address'), host)
  }
  await assert.rejects(fetch(`http://empty.test:${local.port}/`), code('dns'))
  await assert.rejects(fetch(`http://gone.test:${local.port}/`), code('dns'))
  assert.equal(local.connections, 0)

  // rebinding: the resolver answers a public address first and a private one afterwards. The name is resolved
  // once, and the connection goes to the address that passed the check
  let calls = 0
  const rebinding = (host, options, callback) => {
    calls++
    callback(null, [{ address: calls === 1 ? '127.0.0.1' : '10.9.9.9', family: 4 }])
  }
  const pinned = createOutboundFetch({ lookup: rebinding, isAllowedAddress: allowLocal })
  const response = await pinned(`http://rebind.test:${local.port}/x`)
  assert.equal(await response.text(), 'ok')
  assert.equal(calls, 1)
  assert.equal(local.requests[0].headers.host, `rebind.test:${local.port}`)
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
})

test('a request reaches a permitted server with its method, headers and body, and the response is a standard Response', async t => {
  const local = await serve(t, (req, res, entry) => {
    res.writeHead(201, 'Made', { 'content-type': 'application/json', 'x-seen': entry.headers['x-custom'] || '' })
    res.end(JSON.stringify({ method: entry.method, body: entry.body, host: entry.headers.host }))
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  const response = await fetch(`${local.origin}/path?q=1`, {
    method: 'post',
    headers: { 'X-Custom': 'yes', Host: 'evil.example', 'Content-Length': '999', Connection: 'upgrade', skipped: 5 },
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
  assert.equal(sent.headers.skipped, undefined)
  // typed arrays, ArrayBuffers and Blobs are accepted as bodies
  for (const body of [new Uint8Array([104, 105]), new Uint8Array([104, 105]).buffer, new Blob(['hi'])]) {
    assert.equal((await (await fetch(local.origin, { method: 'PUT', body })).json()).body, 'hi')
  }
  await assert.rejects(fetch(local.origin, { method: 'POST', body: { not: 'bytes' } }), code('body'))
})

test('gzip and deflate are decoded; Brotli and unknown encodings are refused', async t => {
  const local = await serve(t, (req, res) => {
    const kind = req.url.slice(1)
    const text = 'x'.repeat(1000)
    if (kind === 'gzip') return res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync(text))
    if (kind === 'deflate') return res.writeHead(200, { 'content-encoding': 'deflate' }).end(zlib.deflateSync(text))
    if (kind === 'br') return res.writeHead(200, { 'content-encoding': 'br' }).end(zlib.brotliCompressSync(text))
    if (kind === 'bad') return res.writeHead(200, { 'content-encoding': 'gzip' }).end('not gzip')
    res.writeHead(200, { 'content-encoding': 'zstd' }).end(text)
  })
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal })
  for (const kind of ['gzip', 'deflate']) {
    const response = await fetch(`${local.origin}/${kind}`)
    assert.equal((await response.text()).length, 1000)
    assert.equal(response.headers.get('content-encoding'), null)
  }
  await assert.rejects(fetch(`${local.origin}/br`), code('encoding'))
  await assert.rejects(fetch(`${local.origin}/zstd`), code('encoding'))
  await assert.rejects(fetch(`${local.origin}/bad`), code('network'))
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
    assert.ok(Date.now() - started < 1500, `${path} ended near its deadline`)
  }
  const controller = new AbortController()
  const pending = fetch(`${local.origin}/never`, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, code('aborted'))
  await assert.rejects(fetch(`${local.origin}/ok`, { signal: controller.signal }), code('aborted'))
})

test('redirects are followed here, hop by hop through the same checks', async t => {
  const other = await serve(t, (req, res, entry) => res.end(JSON.stringify({ at: 'other', headers: entry.headers })))
  const local = await serve(t, (req, res, entry) => {
    const [path, arg] = req.url.slice(1).split('?')
    if (path === 'to-private') return res.writeHead(302, { location: 'http://10.0.0.1/secret' }).end()
    if (path === 'to-metadata') return res.writeHead(307, { location: 'http://169.254.169.254/latest/' }).end()
    if (path === 'to-file') return res.writeHead(302, { location: 'file:///etc/passwd' }).end()
    if (path === 'to-other') return res.writeHead(302, { location: `http://localhost:${other.port}/landed` }).end()
    if (path === 'loop') return res.writeHead(302, { location: `/loop?${Number(arg || 0) + 1}` }).end()
    if (path === 'see-other') return res.writeHead(303, { location: '/final' }).end()
    if (path === 'keep') return res.writeHead(307, { location: '/final' }).end()
    if (path === 'bad') return res.writeHead(302, { location: 'http://[' }).end()
    res.end(JSON.stringify({ method: entry.method, body: entry.body, type: entry.headers['content-type'] || null }))
  })
  const lookup = (host, options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }])
  const fetch = createOutboundFetch({ isAllowedAddress: allowLocal, lookup, maxRedirects: 3 })
  await assert.rejects(fetch(`${local.origin}/to-private`), code('address'))
  await assert.rejects(fetch(`${local.origin}/to-metadata`), code('address'))
  await assert.rejects(fetch(`${local.origin}/to-file`), code('scheme'))
  await assert.rejects(fetch(`${local.origin}/bad`), code('url'))
  await assert.rejects(fetch(`${local.origin}/loop`), code('redirects'))
  assert.equal(local.requests.filter(r => r.url.startsWith('/loop')).length, 4) // the first and three redirects
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
  while (waiting.length < 3) await new Promise(resolve => setTimeout(resolve, 5))
  for (const res of waiting) res.end('done')
  assert.deepEqual(await Promise.all([a1, a2, b1].map(async p => (await p).text())), ['done', 'done', 'done'])
  // every slot is free again, also after failures
  await assert.rejects(fetch('http://10.0.0.1/', {}, { key: 'a' }), code('address'))
  const again = [
    fetch(local.origin, {}, { key: 'a' }),
    fetch(local.origin, {}, { key: 'a' }),
    fetch(local.origin, {}, { key: 'b' }),
  ]
  while (waiting.length < 6) await new Promise(resolve => setTimeout(resolve, 5))
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
  while (waiting.length < 1) await new Promise(resolve => setTimeout(resolve, 5))
  // the second response's 60,000 bytes do not fit next to the first's
  await assert.rejects(fetch(local.origin), code('busy'))
  waiting[0].end()
  assert.equal((await (await first).arrayBuffer()).byteLength, 60_000)
  // released: the same request fits now
  const third = fetch(local.origin)
  while (waiting.length < 3) await new Promise(resolve => setTimeout(resolve, 5))
  waiting[2].end()
  assert.equal((await (await third).arrayBuffer()).byteLength, 60_000)
})

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
})
