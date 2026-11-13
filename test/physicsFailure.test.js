import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { bundleRealPhysx } from './lib/realPhysx.mjs'
import { loadNetwork, makeNetwork } from './lib/network.mjs'

let bundle, B
before(async () => {
  globalThis.self = { postMessage() {} }
  bundle = await bundleRealPhysx()
  B = await import(bundle.url)
})
after(() => bundle?.destroy())

function appFixture() {
  const world = new B.World()
  world.network = { id: 0, isServer: true }
  const blueprint = { id: 'bp', version: 0, model: 'cached.glb', scene: true }
  world.blueprints.get = () => blueprint
  const glb = { toNodes: () => new B.Node() }
  world.loader = { get: () => glb }
  const app = new B.App(world, { id: 'app', blueprint: 'bp' })
  return { app, world, blueprint, glb }
}

function clock(t) {
  const tasks = new Map()
  let id = 0
  t.mock.method(globalThis, 'setTimeout', fn => {
    tasks.set(++id, fn)
    return id
  })
  t.mock.method(globalThis, 'clearTimeout', key => tasks.delete(key))
  return {
    tasks,
    fire() {
      const [key, fn] = tasks.entries().next().value
      tasks.delete(key)
      fn()
    },
  }
}

test('Server.tick continues after throw and start is idempotent', t => {
  const timers = clock(t)
  const logs = []
  t.mock.method(console, 'error', line => logs.push(line))
  let ticks = 0
  const server = new B.Server({
    tick() {
      ticks++
      throw new Error('boom')
    },
  })
  server.start()
  server.start()
  assert.equal(ticks, 1)
  assert.equal(timers.tasks.size, 1)
  timers.fire()
  assert.equal(ticks, 2)
  assert.equal(timers.tasks.size, 1)
  assert.equal(logs.length, 1)
  server.destroy()
  assert.equal(timers.tasks.size, 0)
})

test('Server.tick never re-arms if destroy occurs during a throwing tick', t => {
  const timers = clock(t)
  t.mock.method(console, 'error', () => {})
  const server = new B.Server({
    tick() {
      server.destroy()
      throw new Error('destroyed')
    },
  })
  server.start()
  assert.equal(server.running, false)
  assert.equal(timers.tasks.size, 0)
  server.tick()
  assert.equal(timers.tasks.size, 0)
})

test('Server.tick error dedupe is capped at 32 messages', t => {
  const timers = clock(t)
  const logs = []
  t.mock.method(console, 'error', line => logs.push(line))
  let ticks = 0
  const server = new B.Server({
    tick() {
      throw new Error(`failure ${ticks++}`)
    },
  })
  server.start()
  for (let i = 0; i < 100; i++) timers.fire()
  assert.equal(logs.length, 32)
  assert.equal(server.tickErrors.size, 32)
  server.destroy()
})

test('crash immediately suppresses every recipient, world events and timers; failed presentation stays latched', async t => {
  const timers = clock(t)
  t.mock.method(console, 'error', () => {})
  const { app, world } = appFixture()
  const seen = []
  app.on('update', () => {
    app.crash()
    seen.push('first')
  })
  app.on('update', () => seen.push('second'))
  app.onWorldEvent('test', () => seen.push('world'))
  app.setTimeout(() => seen.push('timer'), 0)
  world.loader = {
    get: () => null,
    load: async () => {
      throw new Error('unavailable')
    },
  }
  app.emit('update')
  world.events.emit('test')
  assert.deepEqual(seen, ['first'])
  assert.equal(timers.tasks.size, 0)
  assert.throws(() => app.setTimeout(() => {}, 0), /this app has stopped/)
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(app.crashed, true)
  assert.equal(app.building, false)
})

test('only a current replacement script after cleanup resets the crash latch', async t => {
  t.mock.method(console, 'error', () => {})
  const { app, world, blueprint, glb } = appFixture()
  app.crash()
  await Promise.resolve()
  assert.equal(app.crashed, true)
  let resolveOld
  const old = new Promise(resolve => {
    resolveOld = resolve
  })
  blueprint.script = 'old.js'
  world.loader = { get: type => (type === 'script' ? null : glb), load: () => old }
  const stale = app.build()
  blueprint.script = 'new.js'
  let cleanups = 0
  const unbuild = app.unbuild.bind(app)
  app.unbuild = () => {
    cleanups++
    unbuild()
  }
  let runs = 0
  const script = {
    exec() {
      assert.equal(cleanups, 1)
      runs++
    },
  }
  world.loader = { get: type => (type === 'script' ? script : glb) }
  await app.build()
  assert.equal(app.crashed, false)
  assert.equal(runs, 1)
  app.crash()
  resolveOld(script)
  await stale
  assert.equal(app.crashed, true, 'stale completion cannot reopen the latch')
  assert.equal(runs, 1)
  await Promise.resolve()
})

test('script boundaries classify identity before conversion and block further native work', t => {
  t.mock.method(console, 'error', () => {})
  for (const boundary of [
    'call',
    'method',
    'getter',
    'setter',
    'active',
    'grounded',
    'ceiling',
    'sleeping',
    'push',
    'teleport',
  ]) {
    const { app, world } = appFixture()
    app.build = async () => {}
    const trap = new WebAssembly.RuntimeError('native')
    let nativeCalls = 0
    const fail = () => {
      nativeCalls++
      throw trap
    }
    let invoke
    if (boundary === 'call') invoke = () => B.callForScript(fail, { ctx: { entity: app, world } }, [])
    if (['method', 'getter', 'setter'].includes(boundary)) {
      const proxy = B.createEntityProxy(app, {
        getters: { value: fail },
        setters: { value: fail },
        methods: { method: fail },
      })
      invoke =
        boundary === 'method'
          ? () => proxy.method()
          : boundary === 'getter'
            ? () => proxy.value
            : () => {
                proxy.value = 1
              }
    }
    if (['active', 'grounded', 'ceiling', 'sleeping'].includes(boundary)) {
      // No wasm work: instantiate only the proxy under test, then inject a native getter failure.
      const Ctor = boundary === 'active' ? B.Node : boundary === 'sleeping' ? B.RigidBody : B.Controller
      const node = Object.create(Ctor.prototype)
      node.ctx = { entity: app, world }
      const key = boundary === 'grounded' ? 'isGrounded' : boundary === 'ceiling' ? 'isCeiling' : boundary
      Object.defineProperty(node, key, { get: fail, set: fail })
      const proxy = node.getProxy()
      invoke =
        boundary === 'active'
          ? () => {
              proxy.active = true
            }
          : () => proxy[key]
    }
    if (['push', 'teleport'].includes(boundary)) {
      world.network = { id: 1, isClient: true, enqueue: fail }
      const player = { world, data: { id: 1, owner: 1 }, push: fail }
      const proxy = B.createPlayerProxy(app, player)
      invoke = () => proxy[boundary](new B.THREE.Vector3(1, 0, 0))
    }
    const before = B.getPhysicsTrapCount()
    assert.throws(
      invoke,
      err => err !== trap && !(err instanceof WebAssembly.RuntimeError) && err.name === 'RuntimeError'
    )
    assert.equal(app.crashed, true, boundary)
    assert.equal(B.getPhysicsTrapCount(), before + 1)
    assert.throws(invoke, /disabled/)
    assert.equal(nativeCalls, 1)
  }
  const { app } = appFixture()
  assert.throws(() =>
    B.callForScript(
      () => {
        throw { name: 'RuntimeError' }
      },
      app,
      []
    )
  )
  assert.equal(app.crashed, false, 'name spoof does not classify as a trap')
})

test('Stage.clean and Physics.preUpdate containment classify traps', t => {
  t.mock.method(console, 'error', () => {})
  for (const stage of [true, false]) {
    const { app, world } = appFixture()
    app.build = async () => {}
    const node = new B.Node()
    node.ctx = { entity: app, world }
    const err = new WebAssembly.RuntimeError('native')
    if (stage) world.stage.containCleanFailures([{ node, err }])
    else world.physics.containInterpolateFailures([{ handle: { node }, err }])
    assert.equal(app.crashed, true)
    assert.equal(world.physics.needsProbe, true)
  }
})

test('probe scheduling is once per tick, uses fetch success and vector allocation, and persists at 64 traps', t => {
  t.mock.method(console, 'error', () => {})
  const previous = globalThis.PHYSX
  t.after(() => {
    globalThis.PHYSX = previous
  })
  let allocations = 0,
    destroys = 0,
    steps = 0,
    fetches = 0,
    fatal = 0
  globalThis.PHYSX = {
    PxVec3: class {
      constructor() {
        allocations++
      }
    },
    destroy() {
      destroys++
    },
  }
  const world = {
    fatal() {
      fatal++
      this.fatalError = true
    },
  }
  const physics = new B.Physics(world)
  world.physics = physics
  physics.probeScene = {
    simulate() {
      steps++
    },
    fetchResults(wait) {
      assert.equal(wait, true)
      fetches++
      return true
    },
  }
  physics.needsProbe = true
  physics.preTick()
  physics.checkHealth()
  physics.needsProbe = true
  physics.postTick()
  assert.equal(steps, 1)
  physics.preTick()
  assert.equal(steps, 2)
  while (B.getPhysicsTrapCount() < 64) B.handlePhysicsFailure(new WebAssembly.RuntimeError(), { world })
  physics.preTick()
  physics.preTick()
  assert.equal(steps, 4)
  assert.equal(fetches, allocations)
  assert.equal(allocations, destroys)
  physics.probeScene.fetchResults = () => false
  physics.preTick()
  assert.equal(fatal, 1)
  physics.preTick()
  assert.equal(fatal, 1)
})

test('any interrupted main simulate/fetchResults is fatal and the scene is never reentered', t => {
  t.mock.method(console, 'error', () => {})
  for (const phase of ['simulate', 'fetchResults']) {
    let fatal = 0,
      calls = 0
    const world = {
      fatal() {
        fatal++
        this.fatalError = true
      },
    }
    const physics = new B.Physics(world)
    physics.pendingCallbacks = []
    physics.callbackFailures = []
    physics.probe = () => true
    physics.scene = {
      simulate() {
        calls++
        if (phase === 'simulate') throw new TypeError('interrupted')
      },
      fetchResults() {
        calls++
        throw 42
      },
    }
    physics.postFixedUpdate(1 / 60)
    physics.postFixedUpdate(1 / 60)
    assert.equal(fatal, 1)
    assert.equal(calls, phase === 'simulate' ? 1 : 2)
  }
})

test('fatal stops the current fixed loop and subsequent tick entry', t => {
  t.mock.method(console, 'error', () => {})
  const world = new B.World()
  world.network = { isServer: false }
  world.maxDeltaTime = 1
  const calls = []
  world.systems = []
  world.hot.add({
    fixedUpdate() {
      calls.push('first')
      world.fatal('test')
    },
  })
  world.hot.add({
    fixedUpdate() {
      calls.push('second')
    },
  })
  world.tick(100)
  world.tick(200)
  assert.deepEqual(calls, ['first'])
})

test('client fatal stops animation, worker and visibility restart; close cannot flush mutations', t => {
  t.mock.method(console, 'error', () => {})
  const previous = { window: globalThis.window, document: globalThis.document, Worker: globalThis.Worker }
  t.after(() => Object.assign(globalThis, previous))
  globalThis.window = {}
  const listeners = new Set()
  globalThis.document = {
    hidden: true,
    addEventListener: (name, fn) => listeners.add(fn),
    removeEventListener: (name, fn) => listeners.delete(fn),
  }
  let worker
  globalThis.Worker = class {
    constructor() {
      worker = this
      this.messages = []
    }
    postMessage(value) {
      this.messages.push(value)
    }
    terminate() {
      this.terminated = true
    }
  }
  const world = new B.World()
  const loops = []
  world.graphics = { renderer: { setAnimationLoop: value => loops.push(value) } }
  world.network = { isServer: false }
  world.client = new B.Client(world)
  let shown = 0
  world.on('fatal', () => shown++)
  world.client.start()
  world.client.onVisibilityChange()
  const pendingMessage = worker.onmessage
  const visibility = world.client.onVisibilityChange
  world.fatal('test')
  world.fatal('again')
  assert.equal(shown, 1)
  assert.equal(loops.at(-1), null)
  assert.equal(worker.terminated, true)
  assert.equal(listeners.size, 0)
  const loopCount = loops.length
  globalThis.document.hidden = false
  visibility()
  pendingMessage()
  assert.equal(loops.length, loopCount)
  const network = new B.ClientNetwork(world)
  // (counted and asserted after the close, whatever the close catches)
  let flushed = 0
  network.flush = () => flushed++
  network.onClose(1006)
  assert.equal(flushed, 0, 'fatal close flushed queued mutations')
})

test('fatal stop suppresses save rearming and refuses mutating packets', async t => {
  // the real network (test/lib/network.mjs), against the REAL_PHYSX_SOURCE_ROOT checkout when it is set (where this
  // test read the class from before); it saves on a timer (SAVE_INTERVAL 60), which the stop must not set again. The
  // token gate's module and the EVM sign-in's are stand-ins (below)
  const SOLANA = 'src/server/solana-gating.js'
  const EVM = 'src/server/evm-gating.js'
  const net = await loadNetwork({
    sourceRoot: process.env.REAL_PHYSX_SOURCE_ROOT,
    env: { SAVE_INTERVAL: 60 },
    standIns: [SOLANA, EVM],
  })
  t.after(() => net.destroy())
  const handlers = [
    'onBlueprintAdded',
    'onBlueprintModified',
    'onEntityAdded',
    'onEntityModified',
    'onEntityRemoved',
    'onEntityEvent',
    'onSettingsModified',
    'onSpawnModified',
    'onAi',
    'onRequestBuilderNonce',
    'onRequestBuilderByToken',
    'onRequestBuilderRecheck',
    'onTokenBalanceRequest',
    'onRevokeBuilderByToken',
    'onRequestEvmNonce',
    'onRequestEvmVerify',
    'onRevokeEvmWallet',
    'onSetEvmTipReceive',
    'onRequestEvmTipIntent',
    'onEvmTip',
  ]
  // Once stopped, a handler returns before it touches anything: the connection, the payload and its meta, the world
  // and the gating modules (the token gate's, the EVM sign-in's and tips') fail the test when they are read or called
  // (and are recorded, for a handler that catches the throw), and so does a line of the network's log (a packet the
  // flush took would be refused with one).
  // (The class this test cut out of its file before had none of these, and a handler that went on threw there.)
  const touched = []
  const tripwire = label =>
    new Proxy(function () {}, {
      get(_, key) {
        touched.push(`${label}.${String(key)}`)
        throw new Error(`${label} was touched while stopping`)
      },
      has(_, key) {
        touched.push(`${String(key)} in ${label}`)
        throw new Error(`${label} was touched while stopping`)
      },
      apply() {
        touched.push(`${label}()`)
        throw new Error(`${label} was called while stopping`)
      },
    })
  let stopped = false
  // until the stop, the real module's values (init() reads its switch)
  const gating = new Proxy(
    {},
    {
      has: () => stopped,
      get(_, key) {
        touched.push(`solanaGating.${String(key)}`)
        throw new Error('the token gate was read while stopping')
      },
    }
  )
  const evmGating = new Proxy(
    {},
    {
      has: () => stopped,
      get(_, key) {
        touched.push(`evmGating.${String(key)}`)
        throw new Error('the EVM sign-in was read while stopping')
      },
    }
  )
  const timers = clock(t)
  const network = makeNetwork(t, {
    net,
    modules: { [SOLANA]: gating, [EVM]: evmGating },
    log: line => touched.push(`log: ${line}`),
  })
  network.stopForFatal()
  stopped = true
  network.world = tripwire('world')
  await network.save()
  assert.equal(timers.tasks.size, 0, 'the existing save does not rearm during shutdown')
  assert.equal(network.admit(), false)
  assert.equal(network.enqueue(), false)
  network.scheduler = { flush: fn => fn({}, {}) }
  network.flush()
  // (two handlers check the payload's type first: they are given one of that type, an id and an event, which a
  // handler that went on would look up in the world. The EVM and tip handlers check that the payload is a plain object
  // of their fields, which a function is not: they are given one each, of the shape they take, so that a handler that
  // went on would read on, the gating module first)
  const payloads = {
    onEntityRemoved: 'app',
    onEntityEvent: ['app', 0, 'probe', null],
    onRequestEvmNonce: { address: `0x${'12'.repeat(20)}`, attempt: 1 },
    onRequestEvmVerify: {
      address: `0x${'12'.repeat(20)}`,
      signature: `0x${'ab'.repeat(65)}`,
      nonce: 'a'.repeat(64),
      attempt: 1,
    },
    onRevokeEvmWallet: {},
    onSetEvmTipReceive: { enabled: true },
    onRequestEvmTipIntent: { id: 1, to: 'other', token: 'JPYC', amount: '100' },
    onEvmTip: { ticket: 'a'.repeat(32), txHash: `0x${'cd'.repeat(32)}` },
  }
  for (const name of handlers) {
    await network[name](tripwire('socket'), payloads[name] ?? tripwire('data'), tripwire('meta'))
  }
  // a tip announcement that waits is not sent once the network has stopped, and no timer is set for it: the drain
  // (which the announcement's timer runs) returns before it reads the clock, the world or the gating module
  network.tipAnnounce.queue.push('a tipped b 100 JPYC')
  network.tipAnnounce.tokens = 3
  network.drainTipAnnouncements()
  assert.deepEqual(network.tipAnnounce.queue, ['a tipped b 100 JPYC'])
  assert.equal(network.tipAnnounce.timer, null)
  assert.equal(timers.tasks.size, 0)
  assert.deepEqual(touched, [])
})

test('latched apps cannot dispatch pointer or control callbacks', () => {
  const { app, world } = appFixture()
  app.build = async () => {}
  let calls = 0
  const node = new B.Node()
  node.ctx = { entity: app, world }
  node.onPointerDown = () => calls++
  const controls = new B.ClientControls(world)
  const control = controls.bind({ object: app, onRelease: () => calls++ })
  const other = controls.bind({ object: {}, priority: -1 })
  let otherCalls = 0
  other.keyA.onPress = () => otherCalls++
  control.keyA.capture = true
  control.keyA.onPress = () => calls++
  control.keyA.onRelease = () => calls++
  controls.simulateButton('keyA', true)
  assert.equal(calls, 1)
  app.crash()
  assert.equal(node.onPointerDown, null)
  controls.simulateButton('keyA', false)
  controls.simulateButton('keyA', true)
  control.release()
  assert.equal(calls, 1)
  assert.equal(otherCalls, 1, 'latched controls do not capture another app’s input')
})

test('headless client fatal stops and cannot rearm its timer', t => {
  const timers = clock(t)
  const world = {
    tick() {
      this.fatalError = true
      client.stopForFatal()
    },
  }
  const client = new B.NodeClient(world)
  client.start()
  assert.equal(timers.tasks.size, 0)
  client.tick()
  assert.equal(timers.tasks.size, 0)
})
