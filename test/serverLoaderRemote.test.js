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

const context = {
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
}
const ServerLoader = loadClient('core/systems/ServerLoader.js', 'ServerLoader', context)

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

// the server with ASSETS=local: an assets directory, read through `readFile` (so a test decides when a read ends)
function makeLocalLoader(readFile) {
  const LocalLoader = loadClient('core/systems/ServerLoader.js', 'ServerLoader', { ...context, fs: { readFile } })
  const world = {
    assetsDir: path.join(path.sep, 'world', 'assets'),
    resolveURL: url => url,
    scripts: { evaluate: code => ({ code }) },
  }
  return new LocalLoader(world)
}

// reads that end when the test says so: `reads` lists { name, resolve, reject } in the order they started
function deferredReads() {
  const reads = []
  const readFile = file => new Promise((resolve, reject) => reads.push({ name: path.basename(file), resolve, reject }))
  return { reads, readFile }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const cached = loader => [...loader.results.keys()].every(key => loader.promises.has(key))

const listen = handler =>
  new Promise(resolve => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })

let servers = []
const held = [] // responses to /assets/hold-*, answered when a test says so
before(async () => {
  const a = await listen((req, res) => {
    requests.assets.push(req.url)
    if (req.url.startsWith('/assets/hold-')) return held.push(res)
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

test('the cache is bounded through load(): the least recently used entries leave first', async () => {
  const loader = makeLocalLoader(file => Promise.resolve(`// ${path.basename(file)}`))
  await loader.load('script', 'asset://keep.js')
  for (let i = 0; i < 600; i++) {
    assert.equal((await loader.load('script', `asset://s${i}.js`)).code, `// s${i}.js`)
    if (i % 50 === 0) assert.ok(loader.get('script', 'asset://keep.js'), 'keeps it recent')
  }
  assert.equal(loader.promises.size, 512)
  assert.equal(loader.results.size, 512)
  assert.equal(loader.has('script', 'asset://keep.js'), true, 'the entry in use stayed')
  assert.equal(loader.has('script', 'asset://s0.js'), false, 'the oldest left')
  assert.equal(loader.has('script', 'asset://s599.js'), true)
})

test('loads in progress are never dropped, and refused loads leave nothing behind', async () => {
  // 16 remote loads take every outbound slot; the next 600 are refused while those are in progress
  const loader = makeLoader()
  const admitted = Array.from({ length: 16 }, (_, i) => loader.load('script', `asset://hold-${i}.js`))
  while (held.length < 16) await tick()
  const refused = await Promise.allSettled(
    Array.from({ length: 600 }, (_, i) => loader.load('script', `asset://refused-${i}.js`))
  )
  assert.ok(refused.every(result => result.status === 'rejected' && result.reason.code === 'busy'))
  await tick()
  assert.equal(loader.promises.size, 16, 'the loads in progress are all still registered')
  assert.equal(loader.results.size, 0)
  held.forEach((res, i) => res.end(`// held ${i}`))
  held.length = 0
  assert.deepEqual(
    (await Promise.all(admitted)).map(script => script.code),
    Array.from({ length: 16 }, (_, i) => `// held ${i}`)
  )
  assert.equal(loader.promises.size, 16)
  assert.equal(loader.results.size, 16)
  assert.ok(cached(loader), 'every result belongs to an entry')
})

test('600 loads finishing together leave at most 512 entries, with results for kept entries only', async () => {
  const { reads, readFile } = deferredReads()
  const loader = makeLocalLoader(readFile)
  const loads = Array.from({ length: 600 }, (_, i) => loader.load('script', `asset://s${i}.js`))
  await tick()
  assert.equal(reads.length, 600)
  assert.equal(loader.promises.size, 600, 'none was dropped while in progress')
  for (const read of reads) read.resolve(`// ${read.name}`)
  const scripts = await Promise.all(loads)
  assert.deepEqual(
    scripts.map(script => script.code),
    reads.map(read => `// ${read.name}`)
  )
  assert.equal(loader.promises.size, 512)
  assert.ok(loader.results.size <= 512, `results ${loader.results.size}`)
  assert.ok(cached(loader), 'every result belongs to an entry')
  // a dropped load's result went to its caller only: asking again loads again
  assert.equal(loader.has('script', 'asset://s0.js'), false)
  assert.equal(loader.get('script', 'asset://s0.js'), undefined)
})

test('a load that finishes after destroy() writes nothing, and an older load never replaces a newer one', async () => {
  const { reads, readFile } = deferredReads()
  const loader = makeLocalLoader(readFile)
  const late = loader.load('script', 'asset://late.js')
  await tick()
  loader.destroy()
  reads[0].resolve('// late')
  assert.equal((await late).code, '// late', 'its caller still gets it')
  assert.equal(loader.promises.size, 0)
  assert.equal(loader.results.size, 0)

  // the same key loaded before and after destroy(): the newer load finishes first
  const older = loader.load('script', 'asset://same.js')
  await tick()
  loader.destroy()
  const newer = loader.load('script', 'asset://same.js')
  await tick()
  assert.notEqual(newer, older)
  reads[2].resolve('// newer')
  await newer
  reads[1].resolve('// older')
  await older
  assert.equal(loader.get('script', 'asset://same.js').code, '// newer')
  assert.equal(loader.load('script', 'asset://same.js'), newer)

  // an older load that fails does not drop the newer one either
  const failing = loader.load('script', 'asset://other.js')
  await tick()
  loader.destroy()
  const kept = loader.load('script', 'asset://other.js')
  await tick()
  reads[3].reject(new Error('gone'))
  await assert.rejects(failing, /gone/)
  assert.equal(loader.load('script', 'asset://other.js'), kept, 'still registered')
  reads[4].resolve('// kept')
  assert.equal((await kept).code, '// kept')
  assert.equal(loader.get('script', 'asset://other.js').code, '// kept')
})

test('one resource has one cache entry whatever its spelling; a query names another one', async () => {
  const loader = makeLoader()
  const first = loader.load('script', 'asset://script.js')
  await first
  const count = requests.assets.length
  // the asset:// name and the assets URL it maps to, with spaces, a fragment and a default port
  for (const spelling of [
    '  asset://script.js  ',
    `${assets}/assets/script.js`,
    `  ${assets}/assets/script.js#top `,
    `${assets}/assets/./script.js`,
  ]) {
    assert.equal(loader.load('script', spelling), first, spelling)
    assert.equal(loader.get('script', spelling), await first, spelling)
  }
  assert.equal(requests.assets.length, count, 'nothing was requested again')
  assert.equal(loader.key('script', 'http://Example.COM:80/a.js#x'), loader.key('script', 'http://example.com/a.js'))
  assert.equal(loader.key('model', 'https://example.com:443/m.glb'), loader.key('model', 'https://example.com/m.glb'))
  assert.notEqual(
    loader.key('script', 'https://example.com/a.js?v=2'),
    loader.key('script', 'https://example.com/a.js')
  )
  assert.notEqual(loader.key('script', 'asset://script.js'), loader.key('model', 'asset://script.js'))
  // in the world's store (an assets directory), the name is the location
  const local = makeLocalLoader(() => Promise.resolve(''))
  assert.equal(local.key('script', ' asset://a.js '), local.key('script', 'asset://a.js'))
  assert.equal(local.key('script', 'asset://../a.js'), 'script/asset://../a.js', 'a refused value keys as itself')
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
