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

test('a load that is no longer the one registered for its key writes nothing, without a destroy() in between', async () => {
  // the entry is replaced while the loader lives on (as dropping an entry for a reload would): only the check that
  // a load is still the registered one tells the two apart
  const { reads, readFile } = deferredReads()
  const loader = makeLocalLoader(readFile)
  const key = loader.key('script', 'asset://swap.js')
  const replaced = loader.load('script', 'asset://swap.js')
  await tick()
  loader.promises.delete(key)
  const current = loader.load('script', 'asset://swap.js')
  await tick()
  reads[1].resolve('// current')
  await current
  reads[0].resolve('// replaced')
  await replaced
  assert.equal(loader.get('script', 'asset://swap.js').code, '// current')
  assert.equal(loader.promises.get(key), current)

  // nor does a replaced load that fails remove the current one
  const failing = loader.load('script', 'asset://swap-2.js')
  await tick()
  loader.promises.delete(loader.key('script', 'asset://swap-2.js'))
  const kept = loader.load('script', 'asset://swap-2.js')
  await tick()
  reads[2].reject(new Error('gone'))
  await assert.rejects(failing, /gone/)
  assert.equal(loader.has('script', 'asset://swap-2.js'), true)
  reads[3].resolve('// kept')
  assert.equal((await kept).code, '// kept')
  // and one that is dropped and not replaced leaves no result behind
  const dropped = loader.load('script', 'asset://gone.js')
  await tick()
  loader.promises.delete(loader.key('script', 'asset://gone.js'))
  reads[4].resolve('// dropped')
  await dropped
  assert.equal(loader.get('script', 'asset://gone.js'), undefined)
  assert.ok(cached(loader), 'every result belongs to an entry')
})

test('at most four models or emotes are read and parsed at once; the others wait without having started', async () => {
  const { reads, readFile } = deferredReads()
  const loader = makeLocalLoader(readFile)
  // the real parser, counted
  const parse = loader.gltfLoader.parse.bind(loader.gltfLoader)
  let parsing = 0
  let most = 0
  loader.gltfLoader.parse = (data, base, onLoad, onError) => {
    most = Math.max(most, ++parsing)
    const done = callback => value => {
      parsing--
      callback(value)
    }
    parse(data, base, done(onLoad), done(onError))
  }
  const loads = Array.from({ length: 10 }, (_, i) => loader.load(i % 2 ? 'emote' : 'model', `asset://m${i}.gltf`))
  await tick()
  assert.equal(reads.length, 4, 'four files are being read; the six other loads have read nothing')
  // each one that finishes lets the next one start, in the order asked
  for (let i = 0; i < 10; i++) {
    for (let wait = 0; reads.length <= i && wait < 100; wait++) await tick()
    assert.equal(reads[i].name, `m${i}.gltf`)
    assert.ok(reads.length <= i + 4, `${reads.length} reads started while ${i} have finished`)
    reads[i].resolve(Buffer.from(emptyGltf))
  }
  assert.equal((await Promise.all(loads)).length, 10)
  assert.ok(most <= 4, `${most} parsed at once`)
  assert.equal(loader.turns.active.size, 0)
})

// parses held by the test: `parses` lists { onLoad, onError } in the order they started
function heldParses(loader) {
  const parses = []
  loader.gltfLoader.parse = (data, base, onLoad, onError) => parses.push({ onLoad, onError })
  return parses
}
const settled = async (promise, ticks = 5) => {
  let state = 'pending'
  promise.then(
    () => (state = 'resolved'),
    () => (state = 'rejected')
  )
  for (let i = 0; i < ticks; i++) await tick()
  return state
}

test('a turn is held through the parse: a fifth read waits until one of four parses ends, in the order asked', async () => {
  const { reads, readFile } = deferredReads()
  const loader = makeLocalLoader(readFile)
  const parses = heldParses(loader)
  const loads = Array.from({ length: 7 }, (_, i) => loader.load('model', `asset://p${i}.glb`))
  await tick()
  assert.equal(reads.length, 4)
  // the four reads end; their parses do not
  for (const read of reads) read.resolve(Buffer.from('glb'))
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(parses.length, 4, 'four parses running')
  assert.equal(reads.length, 4, 'the fifth read has not started: parsing keeps the turn')
  // a parse that succeeds gives its turn to the next load asked
  parses[0].onLoad({})
  assert.equal(await settled(loads[0]), 'resolved')
  assert.equal(reads.length, 5)
  assert.equal(reads[4].name, 'p4.glb')
  // and one that fails does too
  parses[2].onError(new Error('not a model'))
  assert.equal(await settled(loads[2]), 'rejected')
  await assert.rejects(loads[2], /not a model/)
  assert.equal(reads.length, 6)
  assert.equal(reads[5].name, 'p5.glb')
  assert.equal(await settled(loads[1]), 'pending', 'the others are untouched')
  assert.equal(loader.turns.active.size, 4)
  assert.equal(loader.turns.waiting.length, 1)
  loader.destroy()
})

test('a read or a parse that never ends is given up at its deadline, and destroy() releases every turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reads, readFile } = deferredReads()
  const loader = makeLocalLoader(readFile)
  const parses = heldParses(loader)
  const loads = Array.from({ length: 6 }, (_, i) => loader.load('emote', `asset://s${i}.glb`))
  await tick()
  for (const read of reads) read.resolve(Buffer.from('glb'))
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(parses.length, 4)
  // four parses that never end: just before their deadline nothing has moved, at it the four loads fail
  t.mock.timers.tick(59_999)
  assert.equal(await settled(loads[0]), 'pending')
  t.mock.timers.tick(1)
  for (const load of loads.slice(0, 4)) await assert.rejects(load, /parse took longer than 60 s/)
  for (let i = 0; i < 5; i++) await tick()
  // their turns went to the two waiting loads, whose reads never end
  assert.equal(reads.length, 6)
  t.mock.timers.tick(30_000)
  for (const load of loads.slice(4)) await assert.rejects(load, /read took longer than 30 s/)
  assert.equal(loader.turns.active.size, 0)
  // a parse that ends after its load was given up changes nothing
  parses[0].onLoad({})
  assert.equal(loader.results.size, 0)

  // destroy(): the loads reading or parsing fail at once and give their turns back; the waiting ones never start
  const more = Array.from({ length: 6 }, (_, i) => loader.load('model', `asset://d${i}.glb`))
  await tick()
  assert.equal(reads.length, 10)
  reads[6].resolve(Buffer.from('glb'))
  for (let i = 0; i < 5; i++) await tick()
  loader.destroy()
  for (const load of more) await assert.rejects(load, /destroyed/)
  assert.equal(loader.turns.active.size, 0)
  assert.equal(loader.turns.waiting.length, 0)
  for (const read of reads.slice(7)) read.resolve(Buffer.from('glb'))
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(reads.length, 10, 'nothing else was read')
  assert.equal(parses.length, 5, 'a read that ends after destroy() parses nothing')
  // the loader goes on: a new load gets a turn at once
  const after = loader.load('model', 'asset://after.glb')
  await tick()
  assert.equal(reads.length, 11)
  reads[10].resolve(Buffer.from('glb'))
  for (let i = 0; i < 5; i++) await tick()
  parses.at(-1).onLoad({})
  assert.ok(await after)
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
  // in the world's store (an assets directory), the name is the location; the assets URL is another resource
  const local = makeLocalLoader(() => Promise.resolve(''))
  assert.equal(local.key('script', ' asset://a.js '), local.key('script', 'asset://a.js'))
  assert.notEqual(local.key('script', 'asset://a.js'), local.key('script', 'https://example.com/assets/a.js'))
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
