import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import Fastify from 'fastify'
import compress from '@fastify/compress'
import { compressOptions } from '../src/server/compressOptions.js'

async function server() {
  const fastify = Fastify()
  await fastify.register(compress, compressOptions())
  const seen = []
  fastify.post('/echo', async request => {
    seen.push(request.body)
    return { body: request.body }
  })
  await fastify.ready()
  return { fastify, seen }
}

const body = JSON.stringify({ hello: 'world' })
const post = (fastify, payload, encoding) =>
  fastify.inject({
    method: 'POST',
    url: '/echo',
    headers: { 'content-type': 'application/json', ...(encoding ? { 'content-encoding': encoding } : {}) },
    payload,
  })

test('compress: a Brotli request body is refused with 415 before it is decoded or handled', async t => {
  const { fastify, seen } = await server()
  t.after(() => fastify.close())
  const decode = t.mock.method(zlib, 'createBrotliDecompress')
  const response = await post(fastify, zlib.brotliCompressSync(body), 'br')
  assert.equal(response.statusCode, 415)
  assert.equal(seen.length, 0)
  assert.equal(decode.mock.callCount(), 0)
})

test('compress: gzip, deflate and plain request bodies still work', async t => {
  const { fastify, seen } = await server()
  t.after(() => fastify.close())
  for (const [payload, encoding] of [
    [zlib.gzipSync(body), 'gzip'],
    [zlib.deflateSync(body), 'deflate'],
    [body, undefined],
  ]) {
    const response = await post(fastify, payload, encoding)
    assert.equal(response.statusCode, 200, encoding ?? 'identity')
    assert.deepEqual(response.json(), { body: { hello: 'world' } })
  }
  assert.equal(seen.length, 3)
})

test('compress: responses are still Brotli-compressed for clients that ask', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  await fastify.register(compress, compressOptions())
  fastify.get('/big', async () => ({ text: 'x'.repeat(4096) }))
  const response = await fastify.inject({ method: 'GET', url: '/big', headers: { 'accept-encoding': 'br' } })
  assert.equal(response.headers['content-encoding'], 'br')
  assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(response.rawPayload)), { text: 'x'.repeat(4096) })
})

test('compress: each call returns a fresh options object', () => {
  const a = compressOptions()
  a.requestEncodings.push('br')
  assert.deepEqual(compressOptions().requestEncodings, ['gzip', 'deflate'])
})
