import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import * as THREE from 'three'
import { loadClient, Blueprints } from './lib/clientHarness.mjs'
import { Entity } from '../src/core/entities/Entity.js'
import { createEventQueue } from '../src/core/extras/appEventQueue.js'
import { createScriptTimers, TIMER_LIMIT } from '../src/core/extras/scriptTimers.js'
import { createEntityProxy } from '../src/core/extras/createEntityProxy.js'
import { assertScriptActive, handlePhysicsFailure } from '../src/core/extras/physicsFailure.js'
import { createScriptResponse, toHostFetchOptions } from '../src/core/extras/scriptFetch.js'
import { OUTBOUND_DEFAULTS } from '../src/core/extras/outboundFetch.js'
import { callForScript } from '../src/core/extras/scriptValues.js'
import { serializeError } from '../src/core/extras/serializeError.js'
import { readVec3, warnOnce } from '../src/core/extras/physxConvert.js'
import { sanitizePlayerSelfModify } from '../src/core/extras/entityModifyPolicy.js'

const root = () => ({
  position: { fromArray() {} },
  quaternion: { fromArray() {} },
  scale: { fromArray() {} },
  activate() {},
  deactivate() {},
  traverse() {},
  getProxy: () => ({}),
})

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

// one app running `script` with the real App, Apps and proxies; the host fetch is `hostFetch`
function makeApp(script, hostFetch = () => assert.fail('no fetch expected')) {
  const Apps = loadClient('core/systems/Apps.js', 'Apps')
  const App = loadClient('core/entities/App.js', 'App', {
    Entity,
    createEventQueue,
    createScriptTimers,
    createNode: root,
    createEntityProxy,
    registerAppProxy() {},
    LerpVector3: class {},
    LerpQuaternion: class {},
    assertScriptActive,
    handlePhysicsFailure,
    createScriptResponse,
    toHostFetchOptions,
    serializeError,
  })
  const world = Object.assign(new EventEmitter(), {
    network: { isServer: true, isClient: false, id: 0, send: () => true, asScript: fn => fn() },
    entities: {
      items: new Map(),
      remove: id => world.entities.items.delete(id),
      // (the join budget's record of a rebuilt app's emptied state, Entities.stateEmptied)
      stateEmptied() {},
    },
    events: { emit() {}, on() {}, off() {} },
    setHot() {},
    loader: {
      get: type => (type === 'script' ? { exec: script } : { toNodes: root }),
      scriptFetch: (...args) => hostFetch(...args),
    },
  })
  world.apps = new Apps(world)
  world.blueprints = new Blueprints(world)
  world.blueprints.add({ id: 'bp', version: 0, name: 'Shop', model: 'm.glb', script: 's.js', props: {} })
  const app = new App(world, { id: 'a', blueprint: 'bp', position: [], quaternion: [], scale: [], state: {} })
  world.entities.items.set('a', app)
  return { world, app, App }
}

function captureErrors() {
  const lines = []
  const original = console.error
  console.error = (...args) => lines.push(args.map(String).join(' '))
  return { lines, restore: () => (console.error = original) }
}

test('app.fetch: a failed request rejects with a built-in error (it used to resolve undefined)', async () => {
  let fetchFn
  makeApp(
    (_w, _a, fetch) => (fetchFn = fetch),
    async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { secret: true } })
    }
  )
  const errors = captureErrors()
  try {
    const err = await fetchFn('https://example.invalid/x').then(
      () => assert.fail('resolved'),
      e => e
    )
    assert.equal(Object.getPrototypeOf(err), TypeError.prototype)
    assert.equal(err.message, 'fetch failed')
    assert.equal('cause' in err, false)
    assert.deepEqual(errors.lines, [], 'nothing is logged for the script')
  } finally {
    errors.restore()
  }
})

test('app.fetch: a successful request resolves with the whitelisted response; the host sees only allowed options', async () => {
  let fetchFn
  const seen = []
  makeApp(
    (_w, _a, fetch) => (fetchFn = fetch),
    async (url, init) => {
      seen.push({ url, init })
      return new Response('{"a":1}', { status: 201, headers: { 'content-type': 'application/json' } })
    }
  )
  const resp = await fetchFn('https://example.com/x', { method: 'POST', body: 'b', signal: 'nope', keepalive: true })
  assert.deepEqual(Object.keys(resp).sort(), [
    'arrayBuffer',
    'blob',
    'headers',
    'json',
    'ok',
    'status',
    'statusText',
    'text',
  ])
  assert.equal(resp.status, 201)
  assert.deepEqual(await resp.json(), { a: 1 })
  assert.equal(seen.length, 1)
  assert.deepEqual(Object.keys(seen[0].init).sort(), ['body', 'method', 'signal'])
  assert.ok(seen[0].init.signal instanceof AbortSignal)
})

// A script's request is the world's to make: App.fetchFor asks the world's loader (ServerLoader.scriptFetch on the
// server and the node agent: public addresses only, bounded; the browser's fetch on a client), never the global
// fetch, and names the app as the caller.

// the global fetch replaced by one that counts its calls (a call that was caught still counts)
function countGlobalFetch() {
  const real = globalThis.fetch
  const counter = { calls: 0, restore: () => (globalThis.fetch = real) }
  globalThis.fetch = () => {
    counter.calls++
    throw new Error('the global fetch was called')
  }
  return counter
}

test('app.fetch: the request is made by the world loader, for this app; the global fetch is never called', async () => {
  let fetchFn
  const seen = []
  const globalFetch = countGlobalFetch()
  try {
    makeApp(
      (_w, _a, fetch) => (fetchFn = fetch),
      async (...args) => {
        seen.push(args)
        return new Response('ok')
      }
    )
    assert.equal(await (await fetchFn('https://example.com/x')).text(), 'ok')
    assert.equal(seen.length, 1)
    assert.equal(seen[0][0], 'https://example.com/x')
    assert.deepEqual(seen[0][2], { key: 'a' })
    assert.equal(globalFetch.calls, 0)
  } finally {
    globalFetch.restore()
  }
})

test('app.fetch: a world whose loader makes no outbound requests starts none (the promise rejects)', async () => {
  let fetchFn
  const globalFetch = countGlobalFetch()
  try {
    const { world } = makeApp((_w, _a, fetch) => (fetchFn = fetch))
    delete world.loader.scriptFetch
    const err = await fetchFn('https://example.com/x').then(
      () => assert.fail('resolved'),
      e => e
    )
    assert.equal(Object.getPrototypeOf(err), TypeError.prototype)
    assert.equal(globalFetch.calls, 0)
  } finally {
    globalFetch.restore()
  }
})

// With the real server loader (its scriptFetch getter and the policy it makes, outboundFetch.js) behind two apps of
// one world: a script cannot reach the server's own loopback or a private address (nothing connects), and each
// app's requests in flight are bounded on their own.
const ServerLoader = loadClient('core/systems/ServerLoader.js', 'ServerLoader', {
  fs: {},
  path: {},
  RGBELoader: class {},
  GLTFLoader: class {},
  System: class {
    constructor(world) {
      this.world = world
    }
  },
  createVRMFactory: () => ({}),
  glbToNodes: () => ({}),
  createNode: () => ({}),
  createEmoteFactory: () => ({}),
})

// two apps ('a' and 'b') of one world whose script requests go through a real ServerLoader for `assetsUrl`
function twoAppsOnAServer(assetsUrl) {
  const fetches = []
  const { world, App } = makeApp((_w, _a, fetch) => fetches.push(fetch))
  // (the loader's constructor puts stand-ins for a browser's globals in place, for its model parser: not kept here)
  const globals = ['self', 'window', 'document'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  const serverLoader = new ServerLoader({ assetsUrl })
  for (const [name, desc] of globals) {
    if (desc) Object.defineProperty(globalThis, name, desc)
    else delete globalThis[name]
  }
  Object.defineProperty(world.loader, 'scriptFetch', { get: () => serverLoader.scriptFetch })
  const second = new App(world, { id: 'b', blueprint: 'bp', position: [], quaternion: [], scale: [], state: {} })
  world.entities.items.set('b', second)
  assert.equal(fetches.length, 2)
  return fetches
}

// waits for `condition`, for at most two seconds (a request that was refused never arrives)
async function until(condition, what) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await tick()
  }
}

async function localServer(t) {
  const state = { connections: 0, waiting: [] }
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/hold')) state.waiting.push(res)
    else res.end('local')
  })
  server.on('connection', () => state.connections++)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  state.base = `http://127.0.0.1:${server.address().port}`
  return state
}

test('app.fetch on the server: loopback and private addresses are refused before anything connects', async t => {
  const local = await localServer(t)
  const globalFetch = countGlobalFetch()
  try {
    // (the world's assets are elsewhere, so this machine is not a trusted origin)
    const [fetchFn] = twoAppsOnAServer('https://assets.example/assets')
    for (const url of [
      `${local.base}/x`,
      'http://[::1]/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://[::ffff:127.0.0.1]/',
      'file:///etc/hosts',
    ]) {
      const err = await fetchFn(url).then(
        () => assert.fail(`${url} resolved`),
        e => e
      )
      // as fetch reports a request it cannot make: a TypeError; the message says why, and nothing else comes along
      assert.equal(Object.getPrototypeOf(err), TypeError.prototype, url)
      assert.match(err.message, /^outbound request refused: /, url)
      assert.deepEqual(Object.keys(err), [], url)
    }
    assert.equal(local.connections, 0, 'nothing connected to the local server')
    assert.equal(globalFetch.calls, 0)
  } finally {
    globalFetch.restore()
  }
})

test('app.fetch on the server: each app has its own four requests in flight; one more is refused, not queued', async t => {
  const local = await localServer(t)
  // (the world's assets origin is trusted: this machine is reachable, as it is in development)
  const [fetchA, fetchB] = twoAppsOnAServer(`${local.base}/assets`)
  assert.equal(await (await fetchA(`${local.base}/x`)).text(), 'local')
  const refusedFor = fetchFn =>
    fetchFn(`${local.base}/x`).then(
      () => assert.fail('one more request in flight was admitted'),
      err => {
        assert.equal(Object.getPrototypeOf(err), TypeError.prototype)
        assert.match(err.message, /too many requests in flight/)
      }
    )
  const heldA = Array.from({ length: OUTBOUND_DEFAULTS.perKey }, () => fetchA(`${local.base}/hold-a`))
  await until(() => local.waiting.length >= OUTBOUND_DEFAULTS.perKey, "the first app's requests")
  await refusedFor(fetchA)
  // the other app is not held up by the first one's requests, and has the same bound of its own
  assert.equal(await (await fetchB(`${local.base}/x`)).text(), 'local')
  const heldB = Array.from({ length: OUTBOUND_DEFAULTS.perKey }, () => fetchB(`${local.base}/hold-b`))
  await until(() => local.waiting.length >= 2 * OUTBOUND_DEFAULTS.perKey, "the second app's requests")
  await refusedFor(fetchB)
  await refusedFor(fetchA)
  for (const res of local.waiting) res.end('late')
  const bodies = await Promise.all([...heldA, ...heldB].map(request => request.then(resp => resp.text())))
  assert.deepEqual(bodies, new Array(2 * OUTBOUND_DEFAULTS.perKey).fill('late'))
  // and both apps' slots are free again
  assert.equal(await (await fetchA(`${local.base}/x`)).text(), 'local')
  assert.equal(await (await fetchB(`${local.base}/x`)).text(), 'local')
})

test('app.fetch: a request outliving its run is aborted silently and never settles', async () => {
  let fetchFn
  let release
  const { app } = makeApp(
    (_w, _a, fetch) => (fetchFn = fetch),
    (_url, init) =>
      new Promise((resolve, reject) => {
        release = resolve
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
  )
  const errors = captureErrors()
  try {
    let settled = false
    fetchFn('https://example.com/slow').then(
      () => (settled = true),
      () => (settled = true)
    )
    app.destroy()
    await tick()
    release(new Response('late'))
    await tick()
    assert.equal(settled, false)
    // a fetch called after the app is gone does nothing at all
    let late = false
    fetchFn('https://example.com/after').then(
      () => (late = true),
      () => (late = true)
    )
    await tick()
    assert.equal(late, false)
    assert.deepEqual(errors.lines, [])
  } finally {
    errors.restore()
  }
})

test('app.fetch: a body read cut off by the end of the run stays pending', async () => {
  let fetchFn
  let controller
  const { world } = makeApp(
    (_w, _a, fetch) => (fetchFn = fetch),
    async (_url, init) => {
      const body = new ReadableStream({ start: c => (controller = c) })
      init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      return new Response(body)
    }
  )
  const resp = await fetchFn('https://example.com/stream')
  let settled = false
  resp.text().then(
    () => (settled = true),
    () => (settled = true)
  )
  world.blueprints.modify({ id: 'bp', version: 1 }) // rebuild: the old run ends
  await tick()
  assert.equal(settled, false)
})

test('app.fetch: a read that succeeds after the run ended, or starts after it, never settles', async () => {
  for (const variant of ['text', 'json', 'arrayBuffer', 'blob']) {
    let fetchFn
    let release
    const { world } = makeApp(
      (_w, _a, fetch) => (fetchFn = fetch),
      // a body that is complete and readable whatever the abort signal does
      async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => new Promise(resolve => (release = () => resolve('payload'))),
        json: () => new Promise(resolve => (release = () => resolve({ a: 1 }))),
        arrayBuffer: () => new Promise(resolve => (release = () => resolve(new ArrayBuffer(1)))),
        blob: () => new Promise(resolve => (release = () => resolve(new Blob(['x'])))),
      })
    )
    const resp = await fetchFn('https://example.com/x')
    const results = []
    resp[variant]().then(
      value => results.push(['during', value]),
      err => results.push(['during error', err.message])
    )
    world.blueprints.modify({ id: 'bp', version: world.blueprints.get('bp').version + 1 }) // the run ends
    release()
    await tick()
    resp[variant]().then(
      value => results.push(['after', value]),
      err => results.push(['after error', err.message])
    )
    await tick()
    assert.deepEqual(results, [], `${variant}: nothing reaches the old run`)
  }
})

test('setTimeout: at most 1024 pending timers per app; the limit frees as timers fire or the run ends', async () => {
  let setTimeoutFn
  const { app } = makeApp((_w, _a, _f, _p, setTimeout) => (setTimeoutFn = setTimeout))
  for (let i = 0; i < TIMER_LIMIT; i++) setTimeoutFn(() => {}, 1)
  assert.throws(() => setTimeoutFn(() => {}, 1), /more than 1024 pending timers/)
  assert.equal(app.timers.size, TIMER_LIMIT)
  await tick()
  assert.equal(app.timers.size, 0)
  let fired = 0
  setTimeoutFn(() => fired++, 1)
  await tick()
  assert.equal(fired, 1)
})

test('a removed app is stopped: script calls after its destroy event throw; during it they still work', async () => {
  let world
  let resume
  const during = []
  const { app } = makeApp((w, a) => {
    world = w
    a.on('destroy', () => {
      during.push(w.getTime ? 'ok' : 'missing')
      during.push(typeof w.chat)
      w.chat({ body: 'bye' }) // a non-cleanup call is still allowed while the destroy event runs
    })
    resume = () => w.getTimestamp()
  })
  app.world.network.getTime = () => 1
  app.world.chat = { add() {} }
  app.destroy()
  assert.deepEqual(during, ['ok', 'function'])
  assert.throws(() => resume(), /\[app\] this app has stopped/)
  assert.throws(() => world.chat({ body: 'late' }), /\[app\] this app has stopped/)
  // the same rule as a crashed app: the guard itself
  assert.throws(() => assertScriptActive({ destroyed: true }), /this app has stopped/)
  assert.doesNotThrow(() => assertScriptActive({ destroyed: true, destroying: true }))
  assert.throws(() => callForScript(() => 1, { destroyed: true, world: {} }, []), /this app has stopped/)
})

test('world.raycast: every call returns a new result with new vectors', () => {
  const Apps = loadClient('core/systems/Apps.js', 'Apps', { readVec3, isFiniteF32: Number.isFinite, warnOnce })
  const shared = {
    point: new THREE.Vector3(1, 2, 3),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 4,
    handle: { tag: 't' },
  }
  const world = { network: {}, events: {}, physics: { raycast: () => shared } }
  const apps = new Apps(world)
  const origin = new THREE.Vector3()
  const dir = new THREE.Vector3(0, -1, 0)
  const a = apps.worldMethods.raycast({}, origin, dir)
  // app A tampers with its result
  Object.defineProperty(a.point, 'x', { get: () => 999 })
  a.normal.set(9, 9, 9)
  a.distance = -1
  const b = apps.worldMethods.raycast({}, origin, dir)
  assert.notEqual(a, b)
  assert.notEqual(a.point, b.point)
  assert.deepEqual(b.point.toArray(), [1, 2, 3])
  assert.deepEqual(b.normal.toArray(), [0, 1, 0])
  assert.equal(b.distance, 4)
  assert.equal(b.tag, 't')
  assert.deepEqual(shared.point.toArray(), [1, 2, 3], 'the physics result is only read')
})

test('player proxy: transforms and bone matrices are fresh copies, never the host objects', () => {
  const createPlayerProxy = loadClient('core/extras/createPlayerProxy.js', 'createPlayerProxy', {
    callForScript,
    readVec3,
    warnOnce,
    sanitizePlayerSelfModify,
    getRef() {},
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  })
  const head = new THREE.Matrix4().makeTranslation(0, 1.6, 0)
  const base = {
    position: new THREE.Vector3(1, 2, 3),
    rotation: new THREE.Euler(0, 1, 0, 'YXZ'),
    quaternion: new THREE.Quaternion(),
  }
  const player = {
    world: { network: { isServer: false, isClient: true, id: 'me' } },
    data: { id: 'p' },
    base,
    avatar: { getBoneTransform: name => (name === 'head' ? head : null) },
  }
  const proxy = createPlayerProxy({}, player)
  const p1 = proxy.position
  // a script replaces a method on its copy; the next read must not call it with the live transform
  let leaked = null
  p1.copy = value => {
    leaked = value
    return p1
  }
  const p2 = proxy.position
  assert.equal(leaked, null)
  assert.notEqual(p1, p2)
  assert.notEqual(p2, base.position)
  assert.deepEqual(p2.toArray(), [1, 2, 3])
  assert.notEqual(proxy.rotation, proxy.rotation)
  assert.equal(proxy.rotation.order, 'YXZ')
  assert.notEqual(proxy.quaternion, base.quaternion)
  const m1 = proxy.getBoneTransform('head')
  assert.notEqual(m1, head)
  m1.elements[13] = 99
  assert.equal(head.elements[13], 1.6)
  assert.equal(proxy.getBoneTransform('missing'), null)
})

// (the node budget during App.build is tested with real nodes in appTeardown.test.js)
