import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createScriptResponse, toHostFetchOptions } from '../src/core/extras/scriptFetch.js'
import { createScriptBlob } from '../src/core/extras/scriptBlob.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('toHostFetchOptions: only whitelisted keys reach the host, copied', () => {
  const headers = { Accept: 'application/json', 'X-Num': 1, nested: { a: 1 } }
  const options = {
    method: 'POST',
    mode: 'cors',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    headers,
    body: 'payload',
    signal: { aborted: true },
    integrity: 'sha256-x',
    keepalive: true,
    priority: 'high',
    referrer: 'x',
    window: null,
    duplex: 'half',
  }
  const init = toHostFetchOptions(options)
  assert.deepEqual(Object.keys(init).sort(), ['body', 'cache', 'credentials', 'headers', 'method', 'mode', 'redirect'])
  assert.deepEqual(init.headers, { Accept: 'application/json' })
  assert.notEqual(init.headers, headers)
  assert.equal(init.body, 'payload')
  // non-string values for string options are dropped
  assert.deepEqual(toHostFetchOptions({ method: 1, mode: {}, headers: 'x' }), {})
  assert.deepEqual(toHostFetchOptions(), {})
  assert.deepEqual(toHostFetchOptions(null), {})
  assert.deepEqual(toHostFetchOptions('GET'), {})
})

test('toHostFetchOptions: bodies may be strings, buffers, views or facades; anything else is dropped', async () => {
  const buffer = new Uint8Array([7, 8, 9, 10]).buffer
  const copied = toHostFetchOptions({ body: buffer }).body
  assert.notEqual(copied, buffer) // a copy, never the script's own buffer
  assert.deepEqual([...new Uint8Array(copied)], [7, 8, 9, 10])
  const view = new Uint8Array([1, 2, 3])
  assert.deepEqual([...new Uint8Array(toHostFetchOptions({ body: view }).body)], [1, 2, 3])
  const dataView = new DataView(buffer)
  assert.deepEqual([...new Uint8Array(toHostFetchOptions({ body: dataView }).body)], [7, 8, 9, 10])
  const facade = await createScriptBlob(new Blob(['abc'], { type: 'text/plain' }))
  const body = toHostFetchOptions({ body: facade }).body
  assert.ok(body instanceof Blob)
  assert.equal(await body.text(), 'abc')
  for (const bad of [{}, [], 1, true, new Blob(['host']), { ...facade }, () => {}]) {
    assert.equal('body' in toHostFetchOptions({ body: bad }), false)
  }
})

test('createScriptResponse: plain values and four body readers, nothing else from the host response', async () => {
  const resp = new Response('{"a":1}', {
    status: 201,
    statusText: 'Created',
    headers: { 'content-type': 'application/json' },
  })
  const out = createScriptResponse(resp)
  assert.deepEqual(Object.keys(out).sort(), [
    'arrayBuffer',
    'blob',
    'headers',
    'json',
    'ok',
    'status',
    'statusText',
    'text',
  ])
  assert.equal(out.ok, true)
  assert.equal(out.status, 201)
  assert.equal(out.statusText, 'Created')
  assert.equal(Object.getPrototypeOf(out.headers), Object.prototype)
  assert.equal(out.headers['content-type'], 'application/json')
  assert.deepEqual(await out.json(), { a: 1 })
  // a second read fails inside the host; the script sees an intrinsic error without a cause
  const err = await out.text().then(
    () => null,
    e => e
  )
  assert.ok([Error.prototype, TypeError.prototype].includes(Object.getPrototypeOf(err)))
  assert.equal('cause' in err, false)
  const blob = await createScriptResponse(new Response('x', { headers: { 'content-type': 'text/html' } })).blob()
  assert.equal(Object.isFrozen(blob), true)
  assert.equal(blob instanceof Blob, false)
  assert.equal(blob.type, 'text/html')
})

test('source scan: App.fetch exposes only the whitelisted shape and no resp.* passthrough', () => {
  const app = read('src/core/entities/App.js')
  const fetchBlock = app.slice(
    app.indexOf('fetch = async (url, options = {}) =>'),
    app.indexOf('setTimeout = (fn, ms) =>')
  )
  assert.ok(fetchBlock.length > 0)
  assert.match(fetchBlock, /\.\.\.toHostFetchOptions\(options\)/)
  assert.doesNotMatch(fetchBlock, /\.\.\.options\b/)
  assert.match(fetchBlock, /return createScriptResponse\(resp\)/)
  assert.doesNotMatch(fetchBlock, /resp\.(?!ok|status|statusText|headers|json|text|blob|arrayBuffer)/)
  const scriptFetch = read('src/core/extras/scriptFetch.js')
  const passthrough = [...scriptFetch.matchAll(/resp\.([A-Za-z]+)/g)].map(m => m[1])
  assert.deepEqual([...new Set(passthrough)].sort(), [
    'arrayBuffer',
    'blob',
    'headers',
    'json',
    'ok',
    'status',
    'statusText',
    'text',
  ])
  assert.match(scriptFetch, /createScriptBlob\(await resp\.blob\(\)\)/)
})

test('toHostFetchOptions: every script property is read once, so a changing getter cannot slip a second value in', () => {
  let methodReads = 0
  let headerReads = 0
  const options = {
    get method() {
      methodReads++
      return methodReads === 1 ? 'POST' : { not: 'a string' }
    },
    get headers() {
      headerReads++
      return headerReads === 1 ? { ok: 'yes' } : 'nope'
    },
  }
  const init = toHostFetchOptions(options)
  assert.equal(init.method, 'POST')
  assert.deepEqual(init.headers, { ok: 'yes' })
  assert.equal(methodReads, 1)
  assert.equal(headerReads, 1)
  // a header value whose getter changes its mind is read once as well
  let valueReads = 0
  const headers = {
    get accept() {
      valueReads++
      return valueReads === 1 ? 'text/plain' : ['not', 'a', 'string']
    },
  }
  assert.deepEqual(toHostFetchOptions({ headers }).headers, { accept: 'text/plain' })
  assert.equal(valueReads, 1)
})

test('toHostFetchOptions: throwing getters and deceptive Proxies contribute nothing', () => {
  const throwing = {
    get method() {
      throw new Error('nope')
    },
    get headers() {
      throw new Error('nope')
    },
    get body() {
      throw new Error('nope')
    },
    mode: 'cors',
  }
  assert.deepEqual(toHostFetchOptions(throwing), { mode: 'cors' })
  const proxy = new Proxy(
    { method: 'GET' },
    {
      get: (t, k) => (k === 'method' ? 'GET' : k === 'headers' ? { 'x-a': 'b' } : undefined),
    }
  )
  assert.deepEqual(toHostFetchOptions(proxy), { method: 'GET', headers: { 'x-a': 'b' } })
  const hostileHeaders = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('nope')
      },
    }
  )
  assert.deepEqual(toHostFetchOptions({ headers: hostileHeaders }), { headers: {} })
})

test('toHostFetchOptions: buffers and views are copied through brand checks, look-alikes are dropped', () => {
  const buffer = new Uint8Array([1, 2, 3, 4]).buffer
  const copied = toHostFetchOptions({ body: buffer }).body
  assert.ok(copied instanceof ArrayBuffer)
  assert.notEqual(copied, buffer)
  assert.deepEqual([...new Uint8Array(copied)], [1, 2, 3, 4])
  // a view copies exactly its window, even when own properties shadow the view accessors
  const view = new Uint8Array(buffer, 1, 2)
  Object.defineProperty(view, 'buffer', { value: new Uint8Array([9, 9, 9, 9]).buffer })
  Object.defineProperty(view, 'byteOffset', { value: 0 })
  Object.defineProperty(view, 'byteLength', { value: 4 })
  const fromView = toHostFetchOptions({ body: view }).body
  assert.ok(fromView instanceof ArrayBuffer)
  assert.deepEqual([...new Uint8Array(fromView)], [2, 3])
  const dataView = new DataView(buffer, 2)
  assert.deepEqual([...new Uint8Array(toHostFetchOptions({ body: dataView }).body)], [3, 4])
  class Sub extends Float32Array {}
  const sub = new Sub([1.5])
  assert.equal(toHostFetchOptions({ body: sub }).body.byteLength, 4)
  // prototype look-alikes and detached buffers contribute no body
  for (const bad of [
    Object.create(ArrayBuffer.prototype),
    Object.create(Uint8Array.prototype),
    Object.create(DataView.prototype),
  ]) {
    assert.equal('body' in toHostFetchOptions({ body: bad }), false)
  }
  const detached = new ArrayBuffer(4)
  if (typeof detached.transfer === 'function') {
    detached.transfer()
    assert.equal('body' in toHostFetchOptions({ body: detached }), false)
  }
})
