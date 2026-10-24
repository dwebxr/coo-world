import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import { BrotliRefusedError, encodingsOf, installFetchBrotliGuard, withoutBrotli } from '../src/server/fetchGuard.js'

// node --test runs each file in its own process, so installing the guard here affects only this file
const DISPATCHER = Symbol.for('undici.globalDispatcher.1')
const decoders = { br: 0 }
const original = zlib.createBrotliDecompress
let server
let base
const seen = []

before(async () => {
  // a spy that undici calls at decode time (the export is read-only, so redefine it), set before any fetch
  Object.defineProperty(zlib, 'createBrotliDecompress', {
    configurable: true,
    value: (...args) => {
      decoders.br++
      return original(...args)
    },
  })
  installFetchBrotliGuard()
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, acceptEncoding: req.headers['accept-encoding'] })
    const send = (headers, body) => {
      res.writeHead(200, headers)
      res.end(body)
    }
    switch (req.url) {
      case '/br':
        return send({ 'content-encoding': 'br' }, zlib.brotliCompressSync('hello-br'))
      case '/BR':
        return send({ 'content-encoding': 'BR' }, zlib.brotliCompressSync('hello-br'))
      case '/gzip-br':
        return send({ 'content-encoding': 'gzip, br' }, zlib.brotliCompressSync(zlib.gzipSync('x')))
      case '/two-lines':
        res.writeHead(200, [
          ['content-encoding', 'gzip'],
          ['content-encoding', 'br'],
        ])
        return res.end(zlib.brotliCompressSync(zlib.gzipSync('x')))
      case '/gzip':
        return send({ 'content-encoding': 'gzip' }, zlib.gzipSync('hello-gzip'))
      case '/deflate':
        return send({ 'content-encoding': 'deflate' }, zlib.deflateSync('hello-deflate'))
      case '/plain':
        return send({}, 'hello-plain')
      case '/big-gzip':
        return send({ 'content-encoding': 'gzip' }, zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024, 7)))
      case '/to-br':
        res.writeHead(302, { location: '/br' })
        return res.end()
      case '/to-gzip':
        res.writeHead(302, { location: '/gzip' })
        return res.end()
      default:
        res.writeHead(404)
        return res.end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  Object.defineProperty(zlib, 'createBrotliDecompress', { configurable: true, value: original })
  await new Promise(resolve => server.close(resolve))
})

const refused = async path => {
  const before = decoders.br
  const err = await fetch(base + path).then(
    () => null,
    e => e
  )
  assert.ok(err instanceof TypeError, `${path}: fetch rejects`)
  assert.ok(err.cause instanceof BrotliRefusedError, `${path}: cause is BrotliRefusedError (${err.cause})`)
  assert.equal(decoders.br, before, `${path}: no Brotli decoder was created`)
}

test('fetch guard: pure helpers', () => {
  assert.equal(withoutBrotli(undefined), 'gzip, deflate')
  assert.equal(withoutBrotli('br, gzip, deflate'), 'gzip, deflate')
  assert.equal(withoutBrotli('BR;q=1, gzip'), 'gzip')
  assert.equal(withoutBrotli('br'), 'identity')
  assert.equal(withoutBrotli('*'), 'identity')
  assert.equal(withoutBrotli('identity'), 'identity')
  assert.equal(withoutBrotli('gzip;q=0.5, br;q=1, *;q=0.1'), 'gzip;q=0.5')
  assert.deepEqual(encodingsOf([Buffer.from('Content-Encoding'), Buffer.from('gzip, BR')]), ['gzip', 'br'])
  assert.deepEqual(encodingsOf(['content-encoding', 'gzip', 'x-other', 'br', 'CONTENT-ENCODING', 'br']), ['gzip', 'br'])
  assert.deepEqual(encodingsOf(null), [])
})

test('fetch guard: Brotli responses are refused before any decoder exists', async () => {
  for (const path of ['/br', '/BR', '/gzip-br', '/two-lines', '/to-br']) await refused(path)
})

test('fetch guard: gzip, deflate, plain and redirected responses still decode', async () => {
  assert.equal(await (await fetch(base + '/gzip')).text(), 'hello-gzip')
  assert.equal(await (await fetch(base + '/deflate')).text(), 'hello-deflate')
  assert.equal(await (await fetch(base + '/plain')).text(), 'hello-plain')
  assert.equal(await (await fetch(base + '/to-gzip')).text(), 'hello-gzip')
  // a large streamed body arrives intact (onData / onComplete forwarding)
  const big = Buffer.from(await (await fetch(base + '/big-gzip')).arrayBuffer())
  assert.equal(big.length, 4 * 1024 * 1024)
  assert.ok(big.every(b => b === 7))
  assert.equal(decoders.br, 0)
})

test('fetch guard: requests never advertise Brotli; Range keeps identity', async () => {
  seen.length = 0
  await (await fetch(base + '/plain')).text()
  await (await fetch(base + '/plain', { headers: { 'Accept-Encoding': 'br' } })).text()
  await (await fetch(base + '/plain', { headers: { 'ACCEPT-ENCODING': 'br, gzip' } })).text()
  await (await fetch(base + '/plain', { headers: { range: 'bytes=0-3' } })).text()
  assert.deepEqual(
    seen.map(s => s.acceptEncoding),
    ['gzip, deflate', 'identity', 'gzip', 'identity']
  )
})

test('fetch guard: installing twice keeps a single wrapper', () => {
  const first = globalThis[DISPATCHER]
  assert.equal(installFetchBrotliGuard(), first)
  assert.equal(globalThis[DISPATCHER], first)
  assert.ok(Object.isFrozen(first))
})
