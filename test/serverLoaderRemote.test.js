import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import fs from 'fs-extra'
import { loadClient } from './lib/clientHarness.mjs'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'

// The server loader's remote side: what it fetches, what it refuses, and what it keeps.
// `assets` is the world's own assets origin (trusted); `other` is any other server on this machine, which stands
// for a private address a blueprint must not be able to reach.
let assets
let other
const requests = { assets: [], other: [] }
const emptyGltf = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] })
let failNext = false

const ServerLoader = loadClient('core/systems/ServerLoader.js', 'ServerLoader', {
  fs,
  path,
  RGBELoader: class {},
  GLTFLoader,
  System: class {
    constructor(world) {
      this.world = world
    }
  },
  createVRMFactory: () => ({}),
  glbToNodes: () => ({ clone: () => ({ cloned: true }) }),
  createNode: () => ({ add() {}, clone: () => ({ stub: true }) }),
  createEmoteFactory: () => ({ toClip: () => null }),
})

// the server with ASSETS=s3, or the node agent: no assets directory, assets come over HTTP
function makeLoader() {
  const world = {
    assetsUrl: `${assets}/assets`,
    resolveURL: url => (url.startsWith('asset://') ? url.replace('asset:/', `${assets}/assets`) : url),
    scripts: { evaluate: code => ({ code, exec() {} }) },
  }
  const loader = new ServerLoader(world)
  world.loader = loader
  return loader
}

const listen = handler =>
  new Promise(resolve => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })

let servers = []
before(async () => {
  const a = await listen((req, res) => {
    requests.assets.push(req.url)
    if (failNext) {
      failNext = false
      res.writeHead(503)
      return res.end('busy')
    }
    if (req.url === '/assets/script.js') return res.end('// SCRIPT')
    if (req.url === '/assets/model.gltf') return res.end(emptyGltf)
    if (req.url === '/assets/redirect.js') {
      res.writeHead(302, { location: `${other}/secret.js` })
      return res.end()
    }
    res.writeHead(404)
    res.end('<html>not found</html>')
  })
  const b = await listen((req, res) => {
    requests.other.push(req.url)
    res.end('// PRIVATE')
  })
  servers = [a, b]
  assets = `http://127.0.0.1:${a.address().port}`
  other = `http://127.0.0.1:${b.address().port}`
})

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})

test('assets load from the world’s own assets origin; an error status is a failed load, not a parsed error page', async () => {
  const loader = makeLoader()
  assert.equal((await loader.load('script', 'asset://script.js')).code, '// SCRIPT')
  assert.ok(await loader.load('model', 'asset://model.gltf'))
  // a 404 page used to be evaluated as the script
  await assert.rejects(loader.load('script', 'asset://missing.js'), /HTTP 404/)
  await assert.rejects(loader.load('model', 'asset://missing.glb'), /HTTP 404/)
})

test('a remote URL that is not public is refused without a request, also when a redirect leads to it', async () => {
  const loader = makeLoader()
  requests.other.length = 0
  for (const url of [
    `${other}/secret.js`,
    'http://127.0.0.1:1/x.js',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x.js',
    'http://10.0.0.5/x.js',
  ]) {
    await assert.rejects(loader.load('script', url), { code: 'address' }, url)
    await assert.rejects(loader.load('model', url), { code: 'address' }, url)
  }
  // the trusted assets origin redirecting elsewhere does not carry its trust along
  await assert.rejects(loader.load('script', 'asset://redirect.js'), { code: 'address' })
  assert.deepEqual(requests.other, [])
})

test('a failed load is not kept: the next request tries again', async () => {
  const loader = makeLoader()
  failNext = true
  await assert.rejects(loader.load('script', 'asset://script.js'), /HTTP 503/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loader.has('script', 'asset://script.js'), false)
  assert.equal((await loader.load('script', 'asset://script.js')).code, '// SCRIPT')
  assert.equal(loader.has('script', 'asset://script.js'), true)
  // a successful load is kept: no second request
  const before = requests.assets.length
  await loader.load('script', 'asset://script.js')
  assert.equal(requests.assets.length, before)
})

test('avatars share one entry whatever URL a player names', async () => {
  const loader = makeLoader()
  const first = await loader.load('avatar', 'https://example.invalid/a.vrm?n=0')
  for (let i = 1; i < 5000; i++) {
    assert.equal(await loader.load('avatar', `https://example.invalid/a.vrm?n=${i}`), first)
  }
  assert.equal(loader.promises.size, 1)
  assert.equal(loader.results.size, 1)
  assert.equal(loader.get('avatar', 'https://example.invalid/never-loaded.vrm'), first)
  assert.deepEqual(first.toNodes(), { stub: true })
})

test('the cache is bounded: the least recently used entries leave first', async () => {
  const loader = makeLoader()
  await loader.load('script', 'asset://script.js')
  for (let i = 0; i < 600; i++) {
    // refused loads never stay, successful ones do: mix both
    await loader.load('avatar', `https://example.invalid/${i}.vrm`)
    loader.promises.set(`script/fake-${i}`, Promise.resolve())
    loader.results.set(`script/fake-${i}`, {})
    if (i % 50 === 0) loader.get('script', 'asset://script.js') // keeps it recent
    loader.trim()
  }
  assert.ok(loader.promises.size <= 512, `promises ${loader.promises.size}`)
  assert.ok(loader.results.size <= 512, `results ${loader.results.size}`)
  assert.equal(loader.has('script', 'asset://script.js'), true, 'the entry in use stayed')
  assert.equal(loader.has('script', 'fake-0'), false, 'the oldest left')
  assert.equal(loader.has('script', 'fake-599'), true)
})

test('OUTBOUND_TRUSTED_ORIGINS lets the operator name further origins', async t => {
  const previous = process.env.OUTBOUND_TRUSTED_ORIGINS
  process.env.OUTBOUND_TRUSTED_ORIGINS = ` ${other} , not-a-url`
  t.after(() => {
    if (previous === undefined) delete process.env.OUTBOUND_TRUSTED_ORIGINS
    else process.env.OUTBOUND_TRUSTED_ORIGINS = previous
  })
  const loader = makeLoader()
  assert.equal((await loader.load('script', `${other}/secret.js`)).code, '// PRIVATE')
})
