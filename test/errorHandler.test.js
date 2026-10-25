import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import compress from '@fastify/compress'
import statics from '@fastify/static'
import { compressOptions } from '../src/server/compressOptions.js'
import { errorHandler } from '../src/server/errorHandler.js'

// the same wiring as src/server/index.js: compress, a public static tree at '/', the root error handler
async function server(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'error-handler-'))
  fs.writeFileSync(path.join(root, 'index.css'), 'body{}')
  const fastify = Fastify()
  await fastify.register(compress, compressOptions())
  fastify.register(statics, { root, prefix: '/', decorateReply: false })
  fastify.post('/echo', async request => ({ body: request.body }))
  fastify.get('/boom', async () => {
    throw new Error('boom')
  })
  fastify.get('/teapot', async () => {
    throw Object.assign(new Error('server-side 503'), { statusCode: 503 })
  })
  fastify.setErrorHandler(errorHandler)
  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const logged = []
  const original = console.error
  console.error = (...args) => logged.push(args)
  t.after(async () => {
    console.error = original
    await fastify.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { fastify, logged, port: fastify.server.address().port }
}

// a raw request: inject() parses the URL first, which collapses `/./` and `/../` before the server sees them
const raw = (port, rawPath) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath }, res => {
      let body = ''
      res.on('data', chunk => (body += chunk))
      res.on('end', () => resolve({ statusCode: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })

test('errorHandler: client errors keep their 4xx status and are not logged', async t => {
  const { fastify, logged, port } = await server(t)
  assert.equal((await raw(port, '/index.css')).statusCode, 200)
  // @fastify/static 10 refuses non-canonical paths with 403
  for (const url of ['//index.css', '/./index.css', '/x/../index.css']) {
    const r = await raw(port, url)
    assert.equal(r.statusCode, 403, url)
    assert.equal(r.body, '', url)
  }
  const json = { method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' } }
  assert.equal((await fastify.inject({ ...json, payload: '{"broken"' })).statusCode, 400)
  const br = { ...json, headers: { ...json.headers, 'content-encoding': 'br' }, payload: '{}' }
  assert.equal((await fastify.inject(br)).statusCode, 415)
  assert.equal(logged.length, 0)
})

test('errorHandler: anything else is logged and answered 500 with no body', async t => {
  const { fastify, logged } = await server(t)
  for (const url of ['/boom', '/teapot']) {
    const r = await fastify.inject(url)
    assert.equal(r.statusCode, 500, url)
    assert.equal(r.body, '', url)
  }
  assert.deepEqual(
    logged.map(([err]) => err.message),
    ['boom', 'server-side 503']
  )
})
