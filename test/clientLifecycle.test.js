// Client lifetime defects (P13): what a video source waits for and lets go of, what the audio system, the local
// player, physics and the client systems leave behind when they are destroyed, what a dropped file or URL is taken
// for, and what two editor components kept after they were closed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import * as THREE from 'three'
import { transformSync } from 'esbuild'
import { loadClient } from './lib/clientHarness.mjs'
import { bundleRealPhysx, runRealPhysx } from './lib/realPhysx.mjs'
import { importApp, exportApp, INVALID_HYP } from '../src/core/extras/appTools.js'
import { fetchDroppedLink, LINK_TOO_LARGE } from '../src/core/extras/droppedLink.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

// whether a promise has settled by now, and how
async function stateOf(promise) {
  let state = 'pending'
  promise.then(
    () => (state = 'resolved'),
    () => (state = 'rejected')
  )
  await tick()
  return state
}

// something that takes listeners, as far as the code under test uses one: who listens for what, and a dispatch
function listening(fields = {}) {
  const listeners = new Map()
  return Object.assign(
    {
      listeners,
      addEventListener(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name).add(fn)
      },
      removeEventListener(name, fn) {
        listeners.get(name)?.delete(fn)
      },
      dispatch(name, event) {
        for (const fn of [...(listeners.get(name) ?? [])]) fn(event)
      },
      count() {
        let total = 0
        for (const set of listeners.values()) total += set.size
        return total
      },
    },
    fields
  )
}

// --- the video factory (ClientLoader.js) ---

// a <video> element as far as the factory uses one
function videoElement(log) {
  const elem = listening({
    style: {},
    calls: [],
    paused: true,
    currentTime: 0,
    videoWidth: 0,
    videoHeight: 0,
    duration: 0,
    error: null,
    canPlayType: () => '',
    play() {
      elem.calls.push('play')
    },
    pause() {
      elem.calls.push('pause')
    },
    load() {
      elem.calls.push('load')
    },
    // the element has its first frame
    loaded(width, height, duration = 10) {
      elem.videoWidth = width
      elem.videoHeight = height
      elem.duration = duration
      elem.dispatch('loadeddata')
    },
    failed(code = 4) {
      elem.error = { code }
      elem.dispatch('error')
    },
  })
  log.elements.push(elem)
  return elem
}

function videoFactory(url = 'https://world.example/assets/clip.mp4', { hlsSupported = true } = {}) {
  const log = { elements: [], body: [], hls: [], disconnected: 0, waiting: [] }
  class Hls {
    static Events = { ERROR: 'hlsError' }
    static isSupported = () => hlsSupported
    constructor() {
      this.handlers = new Map()
      this.destroyed = 0
      log.hls.push(this)
    }
    on(name, fn) {
      this.handlers.set(name, fn)
    }
    loadSource(source) {
      this.source = source
    }
    attachMedia(elem) {
      this.media = elem
    }
    destroy() {
      this.destroyed++
    }
  }
  const document = {
    createElement: () => videoElement(log),
    body: {
      appendChild: elem => log.body.push(elem),
      removeChild(elem) {
        const index = log.body.indexOf(elem)
        if (index === -1) throw new Error('not a child')
        log.body.splice(index, 1)
      },
    },
  }
  const stub = () => ({})
  const { createVideoFactory, prepareVideoElement } = loadClient(
    'core/systems/ClientLoader.js',
    '{ createVideoFactory, prepareVideoElement }',
    {
      THREE,
      document,
      Hls,
      RGBELoader: class {},
      GLTFLoader: class {},
      VRMLoaderPlugin: class {},
      createNode: stub,
      createVRMFactory: stub,
      glbToNodes: stub,
      createEmoteFactory: stub,
      formatBytes: String,
      imageElementsPlugin: stub,
      checkGLTF: stub,
      createGLTFBudget: () => null,
      GLTF_LIMITS: {},
      isDataURI: () => false,
      isAppleMobile: () => false,
      emoteUrls: [],
      IMAGE_HEADER_BYTES: 0,
      MAX_IMAGE_PIXELS: 0,
      readImageHeader: stub,
    }
  )
  const world = {
    audio: {
      ctx: { createMediaElementSource: () => ({ disconnect: () => log.disconnected++ }) },
      // (as ClientAudio.ready before the first touch: kept until the context is unlocked)
      ready: fn => log.waiting.push(fn),
    },
    graphics: { maxAnisotropy: 1 },
  }
  return { factory: createVideoFactory(world, url), log, prepareVideoElement }
}

test('video: each source waits for its own element, and has its own dimensions', async () => {
  const { factory, log } = videoFactory()
  const first = factory.get('default')
  const second = factory.get('other')
  assert.equal(log.elements.length, 2)
  assert.notEqual(first.prepare, second.prepare, 'the second source used to be handed the wait of the first')
  // the first has its data: the second, whose element has none yet, goes on waiting
  log.elements[0].loaded(640, 360, 12)
  assert.equal(await stateOf(first.prepare), 'resolved')
  assert.equal(first.ready, true)
  assert.equal(await stateOf(second.prepare), 'pending')
  assert.equal(second.ready, false)
  assert.equal(second.width, undefined)
  log.elements[1].loaded(1920, 1080, 30)
  assert.equal(await stateOf(second.prepare), 'resolved')
  assert.deepEqual([second.width, second.height, second.duration, second.ready], [1920, 1080, 30, true])
  assert.deepEqual([first.width, first.height, first.duration], [640, 360, 12])
  // the same key is the same source: one element, one wait
  assert.equal(factory.get('default'), first)
  assert.equal(log.elements.length, 2)
})

test('video: a source let go before it had loaded does not keep the later ones waiting', async () => {
  const { factory, log } = videoFactory()
  const first = factory.get('a')
  first.release()
  const second = factory.get('b')
  log.elements[1].loaded(320, 240)
  assert.equal(await stateOf(second.prepare), 'resolved', 'it used to wait for the element that was let go')
  assert.equal(second.ready, true)
  assert.equal(second.width, 320)
})

test('video: a source that is let go ends its wait, drops its listeners and is not unmuted afterwards', async () => {
  const { factory, log } = videoFactory()
  const handle = factory.get('a')
  const elem = log.elements[0]
  assert.equal(log.body.length, 1)
  assert.ok(elem.count() > 0)
  handle.release()
  assert.equal(log.body.length, 0)
  assert.equal(log.disconnected, 1)
  assert.equal(elem.src, '')
  assert.equal(elem.count(), 0, 'no listener is left on the element')
  // the wait is over (resolved: nobody is told of a failure), and the source never became ready
  assert.equal(await stateOf(handle.prepare), 'resolved')
  assert.equal(handle.ready, false)
  // emptying an element makes it report an error, and data may still arrive: neither does anything now
  const before = elem.calls.length
  elem.failed()
  elem.dispatch('loadedmetadata')
  elem.loaded(640, 360)
  assert.equal(elem.calls.length, before, 'the element that was let go is not played or paused')
  assert.equal(handle.ready, false)
  // the audio unlock (the first touch) comes later: the element that was let go stays muted
  for (const fn of log.waiting) fn()
  assert.equal(elem.muted, true)
  // the key gets a new source afterwards
  const again = factory.get('a')
  assert.notEqual(again, handle)
  for (const fn of log.waiting) fn()
  assert.equal(log.elements[1].muted, false)
})

test('video: a source is let go when its last holder releases it, once', async () => {
  const { factory, log } = videoFactory()
  const one = factory.get('a')
  const two = factory.get('a')
  assert.equal(one, two)
  one.release()
  assert.equal(log.body.length, 1, 'still held')
  two.release()
  assert.equal(log.body.length, 0)
  // a release too many does not clean up again (removing the element a second time would throw)
  assert.doesNotThrow(() => two.release())
  assert.equal(log.disconnected, 1)
})

test('video: an element that fails to load ends the wait with a reason', async () => {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const { factory, log } = videoFactory()
    const handle = factory.get('a')
    log.elements[0].failed(4)
    await assert.rejects(handle.prepare, /the video could not be loaded \(media error 4\)/)
    assert.equal(handle.ready, false)
    assert.equal(log.elements[0].count(), 0)
    // one that nobody waits for is not an unhandled rejection (before the world is ready the page counts one as a
    // failed start)
    factory.get('b')
    log.elements[1].failed()
    await tick()
    await tick()
    assert.deepEqual(unhandled, [])
    // a failure after the data came changes nothing
    const fine = factory.get('c')
    log.elements[2].loaded(64, 64)
    log.elements[2].failed()
    assert.equal(await stateOf(fine.prepare), 'resolved')
    assert.equal(fine.ready, true)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('video: a screen share element (prepareVideoElement) waits the same way', async () => {
  const { prepareVideoElement, log } = videoFactory()
  const state = { ready: false }
  const elem = videoElement(log)
  const prepare = prepareVideoElement(elem, state, { forcePlayOnMetadata: false })
  assert.ok(prepare instanceof Promise)
  elem.dispatch('loadedmetadata')
  assert.deepEqual(elem.calls, [], 'not played to get its data')
  elem.loaded(800, 600)
  await prepare
  assert.deepEqual(state, { ready: true, width: 800, height: 600 })
  const failing = videoElement(log)
  const failed = prepareVideoElement(failing, { ready: false })
  failing.failed(2)
  await assert.rejects(failed, /media error 2/)
})

test('video: a stream is played to get its first data, then paused', async () => {
  const { factory, log } = videoFactory()
  const handle = factory.get('a')
  const elem = log.elements[0]
  elem.dispatch('loadedmetadata')
  assert.deepEqual(elem.calls, ['play'])
  elem.loaded(640, 360)
  assert.deepEqual(elem.calls, ['play', 'pause'])
  await handle.prepare
})

test('video: the HLS player of a source is destroyed with it, and a stream it gives up on ends the wait', async () => {
  const { factory, log } = videoFactory('https://world.example/live/stream.m3u8')
  const handle = factory.get('a')
  assert.equal(log.hls.length, 1)
  const hls = log.hls[0]
  assert.equal(hls.source, 'https://world.example/live/stream.m3u8')
  assert.equal(hls.media, log.elements[0])
  // an error hls.js recovers from by itself is not the end
  hls.handlers.get('hlsError')('hlsError', { fatal: false, type: 'networkError', details: 'fragLoadError' })
  assert.equal(await stateOf(handle.prepare), 'pending')
  hls.handlers.get('hlsError')('hlsError', { fatal: true, type: 'networkError', details: 'manifestLoadError' })
  await assert.rejects(handle.prepare, /the video stream could not be loaded \(manifestLoadError\)/)
  assert.equal(hls.destroyed, 0)
  handle.release()
  assert.equal(hls.destroyed, 1, 'its loaders, buffers and worker used to stay')
  // a browser that plays HLS itself gets no player
  const native = videoFactory('https://world.example/live/stream.m3u8', { hlsSupported: false })
  native.factory.get('a').release()
  assert.equal(native.log.hls.length, 0)
  assert.equal(native.log.body.length, 0)
})

// --- the audio system and the voice room ---

function audioSystem({ state = 'suspended' } = {}) {
  const page = listening({ createElement: () => ({ play: async () => {}, pause() {}, remove() {} }) })
  const log = { disconnected: 0, closed: 0, resumed: 0 }
  const node = () => ({ gain: { value: 1 }, connect() {}, disconnect: () => log.disconnected++ })
  class AudioContext {
    constructor() {
      this.state = state
      this.destination = {}
      this.listener = { setPosition() {}, setOrientation() {} }
      log.ctx = this
    }
    createGain = node
    async resume() {
      log.resumed++
      if (this.state === 'closed') throw new Error('InvalidStateError: the context is closed')
      await log.resuming
      if (this.state !== 'closed') this.state = 'running'
    }
    close() {
      log.closed++
      if (this.state === 'closed') return Promise.reject(new Error('InvalidStateError: already closed'))
      this.state = 'closed'
      return Promise.resolve()
    }
  }
  const ClientAudio = loadClient('core/systems/ClientAudio.js', 'ClientAudio', {
    THREE,
    AudioContext,
    document: page,
    console: { log() {}, error: (...line) => (log.errors ??= []).push(line.join(' ')) },
  })
  const world = { prefs: Object.assign(new EventEmitter(), { music: 1, sfx: 1, voice: 1 }) }
  return { audio: new ClientAudio(world), page, log, world }
}

test('audio: destroy takes the unlock listeners off the page and stops following the prefs', async () => {
  const { audio, page, log, world } = audioSystem()
  await audio.init()
  assert.equal(page.count(), 3, 'click, touchstart and keydown')
  assert.equal(world.prefs.listenerCount('change'), 1)
  const started = []
  audio.ready(() => started.push('queued before'))
  audio.destroy()
  assert.equal(page.count(), 0, 'they used to stay: the next click resumed a closed context')
  assert.equal(world.prefs.listenerCount('change'), 0)
  assert.equal(log.closed, 1)
  // nothing is started afterwards, whether it was waiting or comes now
  audio.ready(() => started.push('after'))
  assert.equal(audio.queue.length, 0)
  page.dispatch('click')
  await tick()
  assert.equal(log.resumed, 0)
  assert.deepEqual(started, [])
  // a second destroy does not close the context again (that rejects)
  audio.destroy()
  assert.equal(log.closed, 1)
  assert.equal(log.disconnected, 4)
})

test('audio: a system destroyed while its context is resuming starts nothing', async () => {
  const { audio, page, log } = audioSystem()
  let resumed
  log.resuming = new Promise(resolve => (resumed = resolve))
  const started = []
  audio.ready(() => started.push('queued'))
  // the click that unlocks is under way when the world is destroyed
  page.dispatch('click')
  await tick()
  assert.equal(log.resumed, 1)
  audio.destroy()
  audio.queue.push(() => started.push('pushed by hand'))
  resumed()
  await tick()
  await tick()
  assert.deepEqual(started, [])
  assert.equal(audio.unlocked, false)
  assert.equal(log.errors, undefined, 'and reports nothing')
})

test('audio: a context that was never suspended has no listeners, and destroy works on it and before init', () => {
  const { audio, page, log, world } = audioSystem({ state: 'running' })
  assert.equal(page.count(), 0)
  const started = []
  audio.ready(() => started.push('now'))
  assert.deepEqual(started, ['now'])
  // (init() was not called: the prefs were never followed)
  assert.equal(world.prefs.listenerCount('change'), 0)
  audio.destroy()
  audio.destroy()
  assert.equal(log.closed, 1)
  audio.ready(() => started.push('after'))
  assert.deepEqual(started, ['now'])
})

test('audio: the unlock still starts what waited, and takes its listeners off', async () => {
  const { audio, page } = audioSystem()
  const started = []
  audio.ready(() => started.push('one'))
  audio.ready(() => started.push('two'))
  page.dispatch('keydown')
  await tick()
  await tick()
  assert.deepEqual(started.sort(), ['one', 'two'])
  assert.equal(audio.unlocked, true)
  assert.equal(page.count(), 0)
})

function voiceRoom({ connect }) {
  const log = { errors: [], disconnected: 0, statuses: [] }
  class Room extends EventEmitter {
    constructor() {
      super()
      this.localParticipant = new EventEmitter()
    }
    connect = connect
    async disconnect() {
      log.disconnected++
    }
  }
  const names = new Proxy({}, { get: (_target, key) => key })
  const ClientLiveKit = loadClient('core/systems/ClientLiveKit.js', 'ClientLiveKit', {
    ParticipantEvent: names,
    RoomEvent: names,
    Room,
    ScreenSharePresets: { h1080fps30: {} },
    THREE,
    isBoolean: v => typeof v === 'boolean',
    prepareVideoElement: () => {},
    createVoiceTap: () => null,
    screenTarget: () => null,
    console: { log() {}, error: (...line) => log.errors.push(line.map(String).join(' ')) },
  })
  const world = new EventEmitter()
  world.settings = Object.assign(new EventEmitter(), { voice: 'spatial' })
  world.network = { id: 'me' }
  const waiting = []
  world.audio = { ctx: {}, ready: fn => waiting.push(fn) }
  const livekit = new ClientLiveKit(world)
  livekit.on('status', status => log.statuses.push({ ...status }))
  livekit.start()
  const join = () => livekit.deserialize({ wsUrl: 'wss://voice.example', token: 't', muted: new Set(), levels: {} })
  // the first touch: the audio system runs what waited, and awaits none of it
  const unlock = () => waiting.map(fn => fn())
  return { livekit, world, log, join, unlock }
}

test('voice: a voice room that cannot be reached is reported, not an unhandled rejection', async () => {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const { livekit, log, join, unlock } = voiceRoom({
      connect: async () => {
        throw new Error('could not establish signal connection')
      },
    })
    await join()
    const results = unlock()
    await Promise.all(results)
    await tick()
    await tick()
    assert.deepEqual(unhandled, [])
    assert.equal(log.errors.length, 1)
    assert.match(log.errors[0], /\[livekit\] could not connect to the voice room: Error: could not establish signal/)
    assert.equal(livekit.status.connected, false)
    assert.equal(log.statuses.filter(status => status.connected).length, 0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('voice: a room left while it was connecting is disconnected; one that connects is reported connected', async () => {
  let connected
  const slow = voiceRoom({ connect: () => new Promise(resolve => (connected = resolve)) })
  await slow.join()
  const results = slow.unlock()
  slow.world.emit('disconnect')
  const before = slow.log.disconnected
  connected()
  await Promise.all(results)
  assert.equal(slow.log.disconnected, before + 1)
  assert.equal(slow.livekit.status.connected, false)
  // a failure after leaving is not reported: the room was given up already
  let fail
  const gone = voiceRoom({ connect: () => new Promise((_resolve, reject) => (fail = reject)) })
  await gone.join()
  const pending = gone.unlock()
  gone.world.emit('kick', 'kicked')
  fail(new Error('aborted'))
  await Promise.all(pending)
  assert.deepEqual(gone.log.errors, [])
  const fine = voiceRoom({ connect: async () => {} })
  await fine.join()
  await Promise.all(fine.unlock())
  assert.equal(fine.livekit.status.connected, true)
  assert.deepEqual(fine.log.errors, [])
})

// --- physics and the local player, on the real PhysX wasm ---
//
// Live allocations in the PhysX heap are counted exactly (test/lib/physxHeap.mjs), over a window that starts after a
// few warm-up rounds: PhysX's own pools grow on first use.
let physx
before(async () => {
  physx = await bundleRealPhysx()
})
after(() => physx?.destroy())
const probe = (name, fn, args) => test(name, () => runRealPhysx(physx, fn, args, { deadline: 120000 }))

probe(
  'physics: destroy gives back everything init allocated, and a second call does nothing',
  async ({ B, world, liveChunks }) => {
    const make = async () => {
      const physics = new B.Physics(world)
      await physics.init()
      return physics
    }
    const V = (x, y, z) => new B.THREE.Vector3(x, y, z)
    const round = async () => {
      const physics = await make()
      // used as a world uses it: materials, a step, the queries
      for (let i = 0; i < 40; i++) physics.getMaterial(i / 100, 0.2, 0.3)
      physics.postFixedUpdate(1 / 50)
      physics.raycast(V(0, 5, 0), V(0, -1, 0), 10, 0xffffffff)
      physics.overlapSphere(1, V(0, 0, 0), 0xffffffff)
      physics.destroy()
      physics.destroy()
      return physics
    }
    for (let i = 0; i < 5; i++) await round()
    // (two worlds at once are part of the warm-up: the SDK's own list of scenes grows once for them)
    const both = [await make(), await make()]
    for (const physics of both) physics.destroy()
    const start = liveChunks()
    let last
    for (let i = 0; i < 20; i++) last = await round()
    assert.equal(liveChunks() - start, 0, 'nothing is left in the heap after 20 worlds')
    assert.equal(last.scene, null)
    assert.equal(last.probeScene, null)
    assert.equal(last.defaultMaterial, null)
    assert.equal(last.materials.size, 0)
    // what one world costs when it is not destroyed (what was left behind per world before)
    const kept = await make()
    assert.ok(liveChunks() - start > 100, `a world's physics holds ${liveChunks() - start} allocations`)
    kept.destroy()
    assert.equal(liveChunks() - start, 0)
    // the SDK object is the process's one, shared by every world: it is not released
    const a = await make()
    const b = await make()
    assert.equal(a.physics.ptr, b.physics.ptr)
    a.destroy()
    const material = b.getMaterial(0.5, 0.5, 0.5)
    assert.ok(material.ptr, 'another world goes on working')
    b.postFixedUpdate(1 / 50)
    b.destroy()
    assert.equal(liveChunks() - start, 0)
  }
)

probe(
  'physics: a system that never started, or whose init stopped half way, is destroyed without a throw',
  async ({ B, PHYSX, world, liveChunks }) => {
    const never = new B.Physics(world)
    never.destroy()
    never.destroy()
    assert.equal(never.destroyed, true)
    // init stops when the scene description cannot be made: what it had allocated by then is given back
    const round = async () => {
      const physics = new B.Physics(world)
      const Original = PHYSX.PxSceneDesc
      PHYSX.PxSceneDesc = function () {
        throw new Error('no scene description')
      }
      try {
        await assert.rejects(physics.init(), /no scene description/)
      } finally {
        PHYSX.PxSceneDesc = Original
      }
      assert.equal(physics.scene, null)
      assert.ok(physics.defaultMaterial, 'it got as far as its default material')
      physics.destroy()
      physics.destroy()
    }
    for (let i = 0; i < 3; i++) await round()
    const start = liveChunks()
    for (let i = 0; i < 10; i++) await round()
    assert.equal(liveChunks() - start, 0)
  }
)

probe(
  'physics: after destroy a frame that still runs touches nothing, and a node that mounts fails in JavaScript',
  async ({ B, world, root, liveChunks }) => {
    const traps = B.getPhysicsTrapCount()
    const physics = new B.Physics(world)
    await physics.init()
    const real = world.physics
    world.physics = physics
    try {
      physics.destroy()
      const start = liveChunks()
      const V = (x, y, z) => new B.THREE.Vector3(x, y, z)
      // a tick that was already under way goes through every phase
      physics.needsProbe = true
      physics.preTick()
      physics.preFixedUpdate(true)
      physics.postFixedUpdate(1 / 50)
      physics.preUpdate(0.5)
      physics.postTick()
      assert.equal(physics.needsProbe, true, 'no health probe ran on the released probe scene')
      assert.equal(physics.steps, undefined, 'no step')
      assert.equal(physics.raycast(V(0, 5, 0), V(0, -1, 0), 10, 0xffffffff), null)
      assert.equal(physics.sweep(null, V(0, 5, 0), V(0, -1, 0), 10, 0xffffffff), null)
      assert.deepEqual(physics.overlapSphere(1, V(0, 0, 0), 0xffffffff), [])
      assert.throws(() => physics.getMaterial(0.1, 0.2, 0.3), /the world was destroyed/)
      assert.throws(() => physics.addActor({ ptr: 1 }, {}), /the world was destroyed/)
      // a body that mounts now: refused by the system, and what the node had made is let go of
      const rb = new B.RigidBody({ type: 'dynamic' })
      rb.add(new B.Collider({ type: 'box', width: 1, height: 1, depth: 1 }))
      assert.throws(() => root.add(rb), /the world was destroyed/)
      // and nothing is cooked for it
      const geometry = new B.THREE.BoxGeometry(1, 1, 1)
      assert.equal(B.geometryToPxMesh(world, geometry, true), null)
      assert.equal(B.getPhysicsTrapCount(), traps, 'no native trap')
      assert.ok(liveChunks() - start <= 4, `at most the refused body is left (${liveChunks() - start})`)
    } finally {
      world.physics = real
    }
  }
)

probe(
  'physics: destroyed with a body still registered, the scene is kept and the body can still be let go',
  async ({ B, world }) => {
    const physics = new B.Physics(world)
    await physics.init()
    const real = world.physics
    world.physics = physics
    const warnings = []
    const warn = console.warn
    console.warn = line => warnings.push(String(line))
    try {
      const entity = { isApp: true, data: { id: 'late' }, deadHook: { dead: false } }
      const root = new B.Node()
      root.activate({ world, entity, moving: false })
      const rb = new B.RigidBody({ type: 'dynamic' })
      rb.add(new B.Collider({ type: 'box', width: 1, height: 1, depth: 1 }))
      root.add(rb)
      const controller = new B.Controller({ radius: 0.4, height: 1 })
      root.add(controller)
      assert.equal(physics.handles.size, 2)
      physics.destroy()
      assert.deepEqual(warnings, ['[physics] destroyed with 2 actors still registered: its scene is kept'])
      assert.ok(physics.scene, 'the scene is not released under what is still in it')
      assert.ok(physics.controllerManager, 'nor the manager that would free the controller')
      assert.equal(physics.defaultMaterial, null, 'what nothing in the scene depends on is released')
      // whoever holds them lets them go later: out of the kept scene, without a throw or a trap
      const traps = B.getPhysicsTrapCount()
      root.remove(rb)
      root.remove(controller)
      assert.equal(physics.handles.size, 0)
      assert.equal(B.getPhysicsTrapCount(), traps)
      physics.destroy()
      assert.ok(physics.scene, 'a second call does not come back for it')
    } finally {
      console.warn = warn
      world.physics = real
    }
  }
)

probe(
  'physics: a body kept past destroy is not moved or snapped through its handle, and is still let go of',
  async ({ B, PHYSX, world, root }) => {
    const physics = new B.Physics(world)
    await physics.init()
    const real = { physics: world.physics, clean: world.stage.clean }
    world.physics = physics
    let cleans = 0
    world.stage.clean = () => cleans++
    const warn = console.warn
    console.warn = () => {}
    try {
      const rb = new B.RigidBody({ type: 'dynamic' })
      rb.add(new B.Collider({ type: 'box', width: 1, height: 1, depth: 1 }))
      root.add(rb)
      const handle = rb.actorHandle
      const at = () => {
        const p = rb.actor.getGlobalPose().p
        return [p.x, p.y, p.z]
      }
      physics.destroy()
      assert.ok(physics.scene, 'the scene is kept')
      assert.equal(physics.transform, null, 'the scratch transform move() used is freed')
      const traps = B.getPhysicsTrapCount()
      // the node moves: its commit hands the move to the handle (this threw on the freed transform)
      rb.position.x = 3
      rb.clean()
      handle.move(rb.matrixWorld)
      assert.deepEqual(at(), [0, 0, 0], 'the body is not moved')
      // (the local player snaps its capsule through the handle)
      const pose = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
      pose.p.y = 5
      handle.snap(pose)
      PHYSX.destroy(pose)
      assert.deepEqual(at(), [0, 0, 0], 'nor snapped')
      // a frame that still runs does not clean the stage, which commits moved nodes to their handles
      physics.preUpdate(0.5)
      assert.equal(cleans, 0)
      // the handle's own teardown still works: the actor leaves the kept scene and is released by its node
      root.remove(rb)
      assert.equal(physics.handles.size, 0)
      assert.equal(physics.scene.getNbActors(PHYSX.PxActorTypeFlagEnum.eRIGID_DYNAMIC), 0)
      assert.equal(rb.actor, null)
      assert.equal(B.getPhysicsTrapCount(), traps)
    } finally {
      console.warn = warn
      world.physics = real.physics
      world.stage.clean = real.clean
    }
  }
)

probe(
  'physics: a world destroyed from a contact or trigger callback ends the step there, without a trap or a fatal error',
  async ({ B, world, root, body }) => {
    const traps = B.getPhysicsTrapCount()
    const real = world.physics
    world.fatalError = null
    world.fatal = reason => (world.fatalError = reason)
    const warn = console.warn
    console.warn = () => {}
    const fresh = async () => {
      const physics = new B.Physics(world)
      await physics.init()
      world.physics = physics
      return physics
    }
    try {
      // a contact callback unmounts its bodies and destroys the world: the scene is released under the step, which
      // went on to read the scene's active actors (a trap: memory access out of bounds)
      let physics = await fresh()
      let calls = 0
      const unmountAndDestroy = () => {
        calls++
        root.remove(a)
        root.remove(b)
        physics.destroy()
      }
      const a = body('RigidBody', { type: 'static', onContactStart: unmountAndDestroy })
      const b = body('RigidBody', { position: [1.5, 0, 0], onContactStart: unmountAndDestroy })
      physics.postFixedUpdate(1 / 50)
      physics.preUpdate(0.5)
      physics.postTick()
      assert.equal(calls, 1)
      assert.equal(physics.scene, null, 'the scene was released')
      assert.equal(world.fatalError, null)
      // destroyed from a callback queued before the step (the end of a contact whose other body was let go of): the
      // step went on to simulate the released scene, and that was reported as a fatal physics failure
      physics = await fresh()
      let ends = 0
      const c = body('RigidBody', {
        type: 'static',
        onContactEnd: () => {
          ends++
          root.remove(c)
          physics.destroy()
        },
      })
      const d = body('RigidBody', { position: [1.5, 0, 0] })
      physics.postFixedUpdate(1 / 50)
      root.remove(d)
      physics.postFixedUpdate(1 / 50)
      assert.equal(ends, 1)
      assert.equal(physics.scene, null)
      assert.equal(physics.steps, 1, 'no step after the destroy')
      assert.equal(world.fatalError, null, 'no fatal error')
      // destroyed with its bodies still in it (the scene is kept): the other recipients of the step, here the other
      // body of the contact and a trigger, are not called
      physics = await fresh()
      const seen = []
      const destroyOnce = name => () => {
        seen.push(name)
        if (!physics.destroyed) physics.destroy()
      }
      const e = body('RigidBody', { type: 'static', onContactStart: destroyOnce('e') })
      const f = body('RigidBody', { position: [1.5, 0, 0], onContactStart: destroyOnce('f') })
      const g = body('RigidBody', {
        type: 'static',
        position: [1.5, 1.5, 0],
        trigger: true,
        onTriggerEnter: destroyOnce('trigger'),
      })
      physics.postFixedUpdate(1 / 50)
      assert.equal(seen.length, 1, `one callback, then none (${seen})`)
      assert.ok(physics.scene, 'the scene is kept')
      for (const node of [e, f, g]) root.remove(node)
      assert.equal(physics.handles.size, 0)
      assert.equal(B.getPhysicsTrapCount(), traps, 'no native trap')
      assert.equal(world.fatalError, null)
    } finally {
      console.warn = warn
      world.physics = real
    }
  }
)

probe(
  'physics: destroyed while its init waits for PhysX, it makes nothing, and a frame or a query on it is harmless',
  async ({ B, world, liveChunks }) => {
    const round = async () => {
      const physics = new B.Physics(world)
      const pending = physics.init()
      physics.destroy()
      await pending
      physics.destroy()
      return physics
    }
    await round()
    const start = liveChunks()
    let last
    for (let i = 0; i < 5; i++) last = await round()
    assert.equal(liveChunks() - start, 0, 'no scene was made for a destroyed system')
    assert.equal(last.scene, null)
    assert.equal(last.version, undefined, 'init stopped once PhysX had loaded')
    const V = (x, y, z) => new B.THREE.Vector3(x, y, z)
    last.needsProbe = true
    last.preTick()
    last.preFixedUpdate(true)
    last.postFixedUpdate(1 / 50)
    last.preUpdate(0.5)
    last.postTick()
    assert.equal(last.raycast(V(0, 5, 0), V(0, -1, 0), 10, 0xffffffff), null)
    assert.equal(last.sweep(null, V(0, 5, 0), V(0, -1, 0), 10, 0xffffffff), null)
    assert.deepEqual(last.overlapSphere(1, V(0, 0, 0), 0xffffffff), [])
    assert.throws(() => last.getMaterial(0.1, 0.2, 0.3), /the world was destroyed/)
    assert.throws(() => last.addActor({ ptr: 1 }, {}), /the world was destroyed/)
    assert.equal(liveChunks() - start, 0)
    // (control: an init that is not interrupted makes its scene)
    const made = new B.Physics(world)
    await made.init()
    assert.ok(made.scene)
    made.destroy()
    assert.equal(liveChunks() - start, 0)
  }
)

// a world as the node client makes one (createNodeClientWorld), with what a local player reads of it
const nodeWorld = `
  const makeNodeWorld = async ({ preloader } = {}) => {
    const w = new B.World()
    w.register('client', B.NodeClient)
    w.register('controls', B.ClientControls)
    w.register('network', B.ClientNetwork)
    await w.physics.init()
    w.loader = { preloader, load: () => new Promise(() => {}), destroy() {} }
    w.network.id = 'me'
    w.network.send = () => {}
    w.readyCount = 0
    w.on('ready', () => w.readyCount++)
    return w
  }
  const playerData = () => ({
    id: 'p1',
    type: 'player',
    owner: 'me',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    name: 'Agent',
    health: 100,
    rank: 0,
  })
`
const withNodeWorld = fn =>
  new Function(
    'context',
    'args',
    `${nodeWorld}\nconst { B } = context\nreturn (${fn})(context, makeNodeWorld, playerData, args)`
  )

probe(
  'local player: removed, it leaves nothing in the scene, the controls, the frame loop or the heap',
  withNodeWorld(async ({ B, liveChunks }, makeNodeWorld, playerData) => {
    const w = await makeNodeWorld()
    const before = { controls: w.controls.controls.length, handles: w.physics.handles.size }
    const player = w.entities.add(playerData())
    assert.equal(player.constructor, B.PlayerLocal)
    assert.ok(player.capsule && player.capsuleHandle && player.control && player.material)
    assert.equal(w.readyCount, 1)
    assert.equal(w.hot.has(player), true)
    assert.equal(w.physics.handles.size, before.handles + 1)
    assert.equal(w.controls.controls.length, before.controls + 1)
    assert.equal(w.listenerCount('xrSession'), 1)
    assert.equal(w.physics.scene.getNbActors(PHYSX.PxActorTypeFlagEnum.eRIGID_DYNAMIC), 1)
    player.chat('hello')
    w.entities.remove('p1')
    assert.equal(player.destroyed, true)
    assert.equal(w.hot.has(player), false, 'out of the frame loop')
    assert.equal(w.physics.handles.size, before.handles)
    assert.equal(
      w.physics.scene.getNbActors(PHYSX.PxActorTypeFlagEnum.eRIGID_DYNAMIC),
      0,
      'its body is out of the scene'
    )
    assert.equal(w.controls.controls.length, before.controls, 'its control is released')
    assert.equal(w.listenerCount('xrSession'), 0)
    assert.deepEqual(
      [player.capsule, player.capsuleHandle, player.capsuleShape, player.material, player.control],
      [null, null, null, null, null]
    )
    assert.equal(player.groundSweepGeometry, null)
    assert.equal(player.base.mounted, false)
    assert.equal(player.aura.mounted, false)
    // the chat bubble's timer is cleared (it would put the name back on a player that is gone)
    assert.equal(player.chatTimer._destroyed, true)
    // a second destroy, and what the network may still call for this player, do nothing native
    player.destroy()
    player.teleport({ position: [1, 2, 3] })
    // the heap: a player that comes and goes, with a frame in between, leaves no allocation
    const round = () => {
      const p = w.entities.add(playerData())
      p.fixedUpdate(1 / 50)
      w.physics.postFixedUpdate(1 / 50)
      p.update(1 / 50)
      w.entities.remove('p1')
    }
    for (let i = 0; i < 20; i++) round()
    const start = liveChunks()
    for (let i = 0; i < 100; i++) round()
    assert.equal(liveChunks() - start, 0)
    w.destroy()
  })
)

probe(
  'local player: removed while the first assets load, it is not set up when the wait ends',
  withNodeWorld(async ({ liveChunks }, makeNodeWorld, playerData) => {
    let loaded
    const w = await makeNodeWorld({ preloader: new Promise(resolve => (loaded = resolve)) })
    const controls = w.controls.controls.length
    const start = liveChunks()
    const player = w.entities.add(playerData())
    assert.equal(player.capsule, undefined, 'init() is waiting')
    assert.equal(player.base.mounted, true)
    w.entities.remove('p1')
    assert.equal(player.base.mounted, false)
    assert.equal(player.groundSweepGeometry, null)
    loaded()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(player.capsule, null, 'no body is made for a player that is gone')
    assert.equal(player.control, null)
    assert.equal(w.controls.controls.length, controls)
    assert.equal(w.physics.handles.size, 0)
    assert.equal(w.hot.has(player), false)
    assert.equal(w.listenerCount('xrSession'), 0)
    assert.equal(w.readyCount, 0, 'and the world is not told it is ready')
    assert.equal(player.avatarLoad, undefined, 'no avatar is asked for')
    assert.equal(liveChunks() - start, 0)
    // (control: a player that stays is set up when the wait ends)
    let loadedToo
    const other = await makeNodeWorld({ preloader: new Promise(resolve => (loadedToo = resolve)) })
    const staying = other.entities.add(playerData())
    loadedToo()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(staying.capsule)
    assert.equal(other.readyCount, 1)
    other.destroy()
    w.destroy()
  })
)

probe(
  'world: a client that makes a new world for each connection leaves nothing of the old one in the heap',
  withNodeWorld(async ({ B, liveChunks }, makeNodeWorld, playerData) => {
    const round = async () => {
      const w = await makeNodeWorld()
      const player = w.entities.add(playerData())
      w.tick(0)
      w.tick(40)
      w.tick(80)
      assert.ok(w.physics.steps > 0, 'the world stepped')
      w.destroy()
      assert.equal(player.destroyed, true)
      assert.equal(w.physics.destroyed, true)
      assert.equal(w.physics.scene, null)
      // a frame of the old world that was already scheduled, and a second destroy
      w.client.tick()
      assert.equal(w.client.timerId, null)
      w.destroy()
      return w
    }
    for (let i = 0; i < 3; i++) await round()
    const start = liveChunks()
    for (let i = 0; i < 10; i++) await round()
    assert.equal(liveChunks() - start, 0)
    // a world that never started (its connection failed before init) is destroyed without a throw
    const never = new B.World()
    never.register('client', B.NodeClient)
    never.register('controls', B.ClientControls)
    never.register('network', B.ClientNetwork)
    never.destroy()
    never.destroy()
    assert.equal(liveChunks() - start, 0)
  })
)

test('world: destroy goes on to every system after one throws, and throws the first failure at the end', () => {
  const World = loadClient('core/World.js', 'World', { EventEmitter })
  const world = Object.create(World.prototype)
  const order = []
  const first = new Error('settings broke')
  class Settings {
    destroy() {
      order.push('settings')
      throw first
    }
  }
  const second = new Error('chat broke')
  class Chat {
    destroy() {
      order.push('chat')
      throw second
    }
  }
  class Physics {
    destroy() {
      order.push('physics')
    }
  }
  world.systems = [new Settings(), new Chat(), new Physics()]
  const errors = []
  const error = console.error
  console.error = (...args) => errors.push(args)
  let thrown
  try {
    world.destroy()
  } catch (err) {
    thrown = err
  } finally {
    console.error = error
  }
  assert.equal(thrown, first, 'the first failure is thrown')
  // (it stopped at the first: chat and physics were never destroyed)
  assert.deepEqual(order, ['settings', 'chat', 'physics'])
  assert.deepEqual(errors, [['[world] Chat.destroy() failed:', second]], 'the later failures are logged')
  // systems that all let go: nothing is thrown or logged
  world.systems = [new Physics()]
  world.destroy()
  assert.equal(errors.length, 1)
})

probe(
  'stage: an instanced model is found through the octree; its mesh carries no entity lookup of its own',
  ({ B }) => {
    const stage = new B.Stage({ setupMaterial() {} })
    const node = { ctx: { entity: { id: 'app' } } }
    const handle = stage.insert({
      linked: true,
      matrix: new B.THREE.Matrix4(),
      node,
      geometry: new B.THREE.BoxGeometry(),
      material: new B.THREE.MeshBasicMaterial(),
    })
    const [model] = [...stage.models.values()]
    assert.ok(model.iMesh)
    // (it logged "TODO: remove if you dont ever see this"; nothing reads an entity from the mesh or the model)
    assert.equal(model.iMesh.getEntity, undefined)
    assert.equal(model.getEntity, undefined)
    const hits = stage.octree.raycast(
      new B.THREE.Raycaster(new B.THREE.Vector3(0, 0, 5), new B.THREE.Vector3(0, 0, -1))
    )
    assert.equal(hits[0].getEntity(), node.ctx.entity)
    handle.destroy()
  }
)

// --- the node client's tick ---

test('node client: a world destroyed from inside its own tick is not scheduled again, and a late timer does nothing', () => {
  const timers = new Set()
  const NodeClient = loadClient('core/systems/NodeClient.js', 'NodeClient', {
    num() {},
    setTimeout: fn => {
      const timer = { fn }
      timers.add(timer)
      return timer
    },
    clearTimeout: timer => timers.delete(timer),
  })
  const world = { ticks: 0, fatalError: null }
  const client = new NodeClient(world)
  world.tick = () => world.ticks++
  client.start()
  assert.equal(world.ticks, 1)
  assert.equal(timers.size, 1)
  const [scheduled] = timers
  // the connection ends while the world is ticking (the agent destroys the world there)
  world.tick = () => {
    world.ticks++
    client.destroy()
  }
  scheduled.fn()
  timers.delete(scheduled)
  assert.equal(world.ticks, 2)
  assert.equal(timers.size, 0, 'it used to be scheduled again after destroy() had cleared its timer')
  // a timer that fires all the same (it was already due) does not tick a destroyed world
  client.tick()
  assert.equal(world.ticks, 2)
  assert.equal(timers.size, 0)
  client.destroy()
  // destroyed between two ticks: the timer that waits is cleared
  const idle = new NodeClient({ tick() {}, fatalError: null })
  idle.start()
  assert.equal(timers.size, 1)
  idle.destroy()
  assert.equal(timers.size, 0)
})

// --- the listeners of the client systems ---

function clientWorldStub() {
  const world = new EventEmitter()
  world.prefs = Object.assign(new EventEmitter(), { stats: true })
  world.settings = new EventEmitter()
  world.graphics = new EventEmitter()
  world.rig = { quaternion: new THREE.Quaternion() }
  world.stage = { scene: { add() {}, remove() {} } }
  return world
}
const listeners = world => ({
  world: world
    .eventNames()
    .map(name => `${name}:${world.listenerCount(name)}`)
    .sort(),
  prefs: world.prefs.listenerCount('change'),
  settings: world.settings.listenerCount('change'),
  graphics: world.graphics.listenerCount('resize'),
})
const NONE = { world: [], prefs: 0, settings: 0, graphics: 0 }

test('graphics: destroy takes its listeners off, once, and works on a system that was never initialised', () => {
  const ClientGraphics = loadClient('core/systems/ClientGraphics.js', 'ClientGraphics', { THREE })
  const world = clientWorldStub()
  const never = new ClientGraphics(world)
  assert.doesNotThrow(() => never.destroy(), 'it used to read the observer init() makes')
  const graphics = new ClientGraphics(world)
  // as init() leaves it: the canvas in the viewport, the observer, the prefs followed
  const log = { disconnected: 0, removed: 0 }
  const canvas = {}
  const viewport = {
    removeChild(child) {
      assert.equal(child.parentNode, viewport, 'removed only while it is in the viewport')
      child.parentNode = null
      log.removed++
    },
  }
  canvas.parentNode = viewport
  graphics.viewport = viewport
  graphics.renderer = { domElement: canvas }
  graphics.resizer = { disconnect: () => log.disconnected++ }
  world.prefs.on('change', graphics.onPrefsChange)
  graphics.start()
  assert.deepEqual(listeners(world), { world: ['xrSession:1'], prefs: 1, settings: 1, graphics: 0 })
  graphics.destroy()
  assert.deepEqual(listeners(world), NONE)
  assert.deepEqual(log, { disconnected: 1, removed: 1 })
  graphics.destroy()
  assert.deepEqual(log, { disconnected: 1, removed: 1 })
})

test('environment, stats, nametags, particles: destroy takes off what start() listens to, twice and before start', async () => {
  const world = clientWorldStub()
  // environment
  const ClientEnvironment = loadClient('core/systems/ClientEnvironment.js', 'ClientEnvironment', {
    THREE,
    CSM: class {},
    isNumber: v => typeof v === 'number',
    isString: v => typeof v === 'string',
  })
  new ClientEnvironment(world).destroy()
  const environment = new ClientEnvironment(world)
  environment.buildCSM = () => {}
  environment.updateSky = () => {}
  await environment.start()
  assert.deepEqual(listeners(world), { world: [], prefs: 1, settings: 0, graphics: 1 })
  environment.destroy()
  environment.destroy()
  assert.deepEqual(listeners(world), NONE)

  // stats
  const ClientStats = loadClient('core/systems/ClientStats.js', 'ClientStats', {
    StatsGL: class {},
    Panel: class {},
    isBoolean: v => typeof v === 'boolean',
  })
  new ClientStats(world).destroy()
  const stats = new ClientStats(world)
  const panel = { shown: 0 }
  stats.init({ ui: { appendChild: () => panel.shown++, removeChild: () => panel.shown-- } })
  stats.stats = { dom: {} }
  stats.start()
  assert.deepEqual(listeners(world), { world: ['ready:1', 'ui:1'], prefs: 1, settings: 0, graphics: 0 })
  world.emit('ready')
  assert.equal(panel.shown, 1)
  stats.destroy()
  assert.equal(panel.shown, 0)
  assert.deepEqual(listeners(world), NONE)
  // what used to put the panel back on a destroyed system
  world.emit('ready')
  world.prefs.emit('change', { stats: { value: true } })
  world.emit('ui', { visible: true })
  assert.equal(panel.shown, 0)
  stats.destroy()

  // nametags
  const Nametags = loadClient('core/systems/Nametags.js', 'Nametags', {
    THREE,
    CustomShaderMaterial: class extends THREE.Material {},
    fillRoundRect() {},
    document: { createElement: () => ({ getContext: () => ({}) }) },
  })
  new Nametags(world).destroy()
  const nametags = new Nametags(world)
  nametags.start()
  assert.deepEqual(listeners(world).world, ['xrSession:1'])
  nametags.destroy()
  nametags.destroy()
  assert.deepEqual(listeners(world), NONE)

  // particles: the worker is the page's one, shared by every Particles system made from this module
  const workers = []
  const Particles = loadClient('core/systems/Particles.js', 'Particles', {
    THREE,
    CustomShaderMaterial: class {},
    nodeFailed() {},
    Worker: class {
      constructor() {
        workers.push(this)
      }
    },
    window: { PARTICLES_PATH: '/particles.js' },
  })
  new Particles(world).destroy()
  const particles = new Particles(world)
  particles.init()
  particles.start()
  assert.equal(workers.length, 1)
  assert.equal(workers[0].onmessage, particles.onMessage)
  assert.deepEqual(listeners(world).world, ['xrSession:1'])
  particles.destroy()
  particles.destroy()
  assert.deepEqual(listeners(world), NONE)
  assert.equal(workers[0].onmessage, null)
  assert.equal(workers[0].onerror, null)
  // a system made later owns the worker's handlers: an older one that is destroyed leaves them alone
  const older = new Particles(world)
  older.init()
  const newer = new Particles(world)
  newer.init()
  assert.equal(workers.length, 1)
  older.destroy()
  assert.equal(workers[0].onmessage, newer.onMessage)
  assert.equal(workers[0].onerror, newer.onError)
})

// --- what is dropped on the world: .hyp files and links ---

// a .hyp file with this header (an object, or the text to put there) and payload
function hypFile(header, payload = new Uint8Array(0), { headerSize } = {}) {
  const text = new TextEncoder().encode(typeof header === 'string' ? header : JSON.stringify(header))
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, headerSize ?? text.length, true)
  return new File([size, text, payload], 'app.hyp')
}
const bytesOf = async file => [...new Uint8Array(await file.arrayBuffer())]

test('importApp: what exportApp wrote comes back, and the files shipped with the world still import', async () => {
  const files = {
    'asset://model.glb': new File([new Uint8Array([1, 2, 3, 4, 5])], 'model.glb', { type: 'model/gltf-binary' }),
    'asset://script.js': new File(['app.on("update", () => {})'], 'script.js', { type: 'text/javascript' }),
    'asset://pic.png': new File([new Uint8Array([9, 8, 7])], 'pic.png', { type: 'image/png' }),
  }
  const blueprint = {
    id: 'bp',
    name: 'Thing',
    model: 'asset://model.glb',
    script: 'asset://script.js',
    props: { picture: { type: 'texture', url: 'asset://pic.png' }, text: 'hi' },
  }
  const file = await exportApp(blueprint, async url => files[url])
  const app = await importApp(file)
  assert.deepEqual(app.blueprint, blueprint)
  assert.deepEqual(
    app.assets.map(asset => [asset.type, asset.url, asset.file.name, asset.file.type]),
    [
      ['model', 'asset://model.glb', 'model.glb', 'model/gltf-binary'],
      ['script', 'asset://script.js', 'script.js', 'text/javascript'],
      ['texture', 'asset://pic.png', 'pic.png', 'image/png'],
    ]
  )
  for (const asset of app.assets) assert.deepEqual(await bytesOf(asset.file), await bytesOf(files[asset.url]))
  // the server reads these at start (collections.js, db.js)
  const shipped = ['collections/default/Image.hyp', 'collections/default/Model.hyp', 'collections/default/Text.hyp']
  for (const name of [...shipped, 'collections/default/Video.hyp', 'scene.hyp']) {
    const buffer = fs.readFileSync(new URL(`../src/world/${name}`, import.meta.url))
    const imported = await importApp(new File([buffer], name))
    assert.equal(typeof imported.blueprint, 'object', name)
    const headerSize = buffer.readUInt32LE(0)
    const total = imported.assets.reduce((sum, asset) => sum + asset.file.size, 0)
    assert.equal(4 + headerSize + total, buffer.length, `${name}: its assets are the rest of the file`)
  }
})

test('importApp: a header that is not what exportApp writes is refused with a reason', async () => {
  const payload = new Uint8Array(1000).fill(7)
  const blueprint = { name: 'x' }
  const asset = fields => ({ type: 'model', url: 'asset://a.glb', size: 10, mime: 'model/gltf-binary', ...fields })
  // (with a code: the server leaves such a file out of its collection)
  const refused = async (header, reason, options) =>
    assert.rejects(importApp(hypFile(header, payload, options)), {
      name: 'Error',
      code: INVALID_HYP,
      message: `not a valid .hyp file: ${reason}`,
    })
  // sizes: each used to be taken as it came. Alternating +n and -n gave every asset the same bytes again, each a
  // copy of the whole payload
  await refused(
    { blueprint, assets: [asset({ size: 1000 }), asset({ size: -1000 }), asset({ size: 1000 })] },
    'an asset has no size'
  )
  await refused({ blueprint, assets: [asset({ size: '10' })] }, 'an asset has no size')
  await refused({ blueprint, assets: [asset({ size: 1.5 })] }, 'an asset has no size')
  await refused({ blueprint, assets: [asset({ size: null })] }, 'an asset has no size')
  await refused({ blueprint, assets: [asset({ size: 1e300 })] }, 'an asset has no size')
  await refused({ blueprint, assets: [asset({ size: 1001 })] }, 'an asset is longer than the file')
  await refused({ blueprint, assets: [asset({ size: 600 }), asset({ size: 401 })] }, 'an asset is longer than the file')
  await refused({ blueprint, assets: [asset({ url: 5 })] }, 'an asset has no url')
  await refused({ blueprint, assets: [null] }, 'an asset has no url')
  await refused({ blueprint, assets: ['asset://a.glb'] }, 'an asset has no url')
  await refused({ blueprint, assets: { length: 1 } }, 'it has no list of assets')
  await refused({ blueprint }, 'it has no list of assets')
  await refused({ blueprint: null, assets: [] }, 'it has no blueprint')
  await refused({ blueprint: [], assets: [] }, 'it has no blueprint')
  await refused({ assets: [] }, 'it has no blueprint')
  await refused([], 'it has no blueprint')
  await refused('null', 'it has no blueprint')
  await refused('{ not json', 'its header cannot be read')
  await refused({ blueprint, assets: [] }, 'its header is longer than the file', { headerSize: 5000 })
  await assert.rejects(importApp(new File([new Uint8Array(3)], 'short.hyp')), {
    code: INVALID_HYP,
    message: 'not a valid .hyp file: it is too short',
  })
  // what is accepted: assets one after another, to the end of the file at most; a mime that is not text is dropped
  const fine = await importApp(
    hypFile(
      { blueprint, assets: [asset({ size: 600, mime: { toString: 1 } }), asset({ size: 400 }), asset({ size: 0 })] },
      payload
    )
  )
  assert.deepEqual(
    fine.assets.map(a => [a.file.size, a.file.type]),
    [
      [600, ''],
      [400, 'model/gltf-binary'],
      [0, 'model/gltf-binary'],
    ]
  )
  assert.deepEqual(fine.blueprint, blueprint)
  const empty = await importApp(hypFile({ blueprint, assets: [] }))
  assert.deepEqual(empty.assets, [])
})

// an answer whose body is `chunks` of `chunkBytes` (or endless), counting what was read and whether it was cancelled
function linkAnswer({ status = 200, headers = {}, chunks = 1, chunkBytes = 1024 } = {}) {
  const log = { pulled: 0, cancelled: 0, requested: [] }
  const body = new ReadableStream(
    {
      pull(controller) {
        if (log.pulled >= chunks) return controller.close()
        log.pulled++
        controller.enqueue(new Uint8Array(chunkBytes).fill(log.pulled))
      },
      cancel() {
        log.cancelled++
      },
    },
    { highWaterMark: 0 }
  )
  const fetchLink = async url => {
    log.requested.push(url)
    return new Response(body, { status, headers })
  }
  return { log, fetchLink }
}
const MiB = 1024 * 1024

test('a dropped link: an error answer is not taken for the file, and a body larger than an upload is not read', async () => {
  const missing = linkAnswer({ status: 404 })
  await assert.rejects(
    fetchDroppedLink('https://files.example/thing.glb', MiB, missing.fetchLink),
    /^Error: the dropped link answered 404$/
  )
  assert.deepEqual(missing.log, { pulled: 0, cancelled: 1, requested: ['https://files.example/thing.glb'] })
  // declared larger than the limit: refused before any of it is read
  const declared = linkAnswer({ headers: { 'content-length': String(MiB + 1) }, chunks: Infinity })
  await assert.rejects(fetchDroppedLink('https://files.example/big.glb', MiB, declared.fetchLink), err => {
    assert.equal(err.code, LINK_TOO_LARGE)
    return true
  })
  assert.equal(declared.log.pulled, 0)
  assert.equal(declared.log.cancelled, 1)
  // not declared (or declared smaller than it is): reading stops at the chunk that passes the limit
  for (const headers of [{}, { 'content-length': '10' }]) {
    const endless = linkAnswer({ headers, chunks: Infinity, chunkBytes: 64 * 1024 })
    await assert.rejects(fetchDroppedLink('https://files.example/endless.glb', MiB, endless.fetchLink), err => {
      assert.equal(err.code, LINK_TOO_LARGE)
      return true
    })
    assert.equal(endless.log.pulled, 17, 'sixteen chunks are the limit; the seventeenth passes it')
    assert.equal(endless.log.cancelled, 1)
  }
})

test('a dropped link: an answer within the limit is the file, named after the path', async () => {
  const fine = linkAnswer({ headers: { 'content-type': 'model/gltf-binary' }, chunks: 16, chunkBytes: 64 * 1024 })
  const file = await fetchDroppedLink('https://files.example/models/thing.glb?v=2', MiB, fine.fetchLink)
  assert.equal(file.name, 'thing.glb')
  assert.equal(file.type, 'model/gltf-binary')
  assert.equal(file.size, MiB, 'exactly the limit is accepted')
  const bytes = new Uint8Array(await file.arrayBuffer())
  assert.equal(bytes[0], 1)
  assert.equal(bytes[MiB - 1], 16)
  // no limit known (the server has not said its upload size): nothing is refused for its size, as before
  const unknown = linkAnswer({ chunks: 40, chunkBytes: 64 * 1024 })
  const large = await fetchDroppedLink('https://files.example/large.vrm', NaN, unknown.fetchLink)
  assert.equal(large.size, 40 * 64 * 1024)
  assert.equal(large.type, '')
})

// the builder with its real constructor, and stand-ins for what a drop reaches after the file is known
function builder({ answer, maxUploadSize = 1 } = {}) {
  const log = { errors: [], toasts: [], chat: [], added: [] }
  // a node that answers anything (the XR menu the constructor builds)
  const anything = new Proxy(function () {}, {
    get: (_target, key) => (key === 'then' || key === Symbol.toPrimitive ? undefined : anything),
    set: () => true,
    apply: () => anything,
    construct: () => anything,
  })
  const Builder = loadClient('core/systems/ClientBuilder.js', 'ClientBuilder', {
    THREE,
    TransformControls: class {},
    hashFile: async () => 'hash',
    ControlPriorities: {},
    importApp,
    fetchDroppedLink: (url, maxBytes) => fetchDroppedLink(url, maxBytes, answer.fetchLink),
    LINK_TOO_LARGE,
    createNode: () => anything,
    setTimeout: fn => queueMicrotask(fn),
    console: { log() {}, error: (...line) => log.errors.push(line.map(String).join(' ')) },
  })
  const world = new EventEmitter()
  world.settings = new EventEmitter()
  world.network = { id: 'me', maxUploadSize }
  world.chat = { add: message => log.chat.push(message.body) }
  world.on('toast', text => log.toasts.push(text))
  const instance = new Builder(world)
  instance.canBuild = () => true
  instance.toggle = () => {}
  instance.getSpawnTransform = () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] })
  instance.addModel = async file => log.added.push(['model', file.name, file.size])
  instance.addAvatar = async file => log.added.push(['avatar', file.name, file.size])
  const dropOf = item => ({ preventDefault() {}, dataTransfer: { items: [item] } })
  const link = url => dropOf({ kind: 'string', type: 'text/uri-list', getAsString: fn => fn(`${url}\n`) })
  const file = f => dropOf({ kind: 'file', type: '', getAsFile: () => f })
  return { instance, log, link, file, world }
}

test('builder: a dropped link that is too large is said like a file that is, and one that fails is reported', async () => {
  const big = builder({ answer: linkAnswer({ headers: { 'content-length': String(2 * MiB) }, chunks: Infinity }) })
  await big.instance.drop(big.link('https://files.example/big.glb'))
  assert.deepEqual(big.log.chat, ['File size too large (>1mb)'])
  assert.deepEqual(big.log.added, [])
  assert.deepEqual(big.log.toasts, [])
  // a file that is too large, as before
  const file = builder()
  await file.instance.drop(file.file(new File([new Uint8Array(MiB + 1)], 'big.glb')))
  assert.deepEqual(file.log.chat, ['File size too large (>1mb)'])
  assert.deepEqual(file.log.added, [])
  // a link that answers with an error: the drop fails, and through the listener that is reported and said
  const missing = builder({ answer: linkAnswer({ status: 404 }) })
  await assert.rejects(missing.instance.drop(missing.link('https://files.example/gone.glb')), /answered 404/)
  assert.deepEqual(missing.log.added, [], 'the error page used to be added as gone.glb')
  // a link that answers with the file goes on to be added
  const fine = builder({ answer: linkAnswer({ chunks: 2 }) })
  await fine.instance.drop(fine.link('https://files.example/models/thing.glb'))
  assert.deepEqual(fine.log.added, [['model', 'thing.glb', 2048]])
  assert.deepEqual(fine.log.chat, [])
})

test('builder: a drop that fails is not an unhandled rejection', async () => {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    // a .hyp file that is not one: importApp refuses it inside addApp, which nothing awaited
    const broken = builder()
    const drop = broken.file(new File([new Uint8Array([200, 0, 0, 0, 1, 2, 3])], 'broken.hyp'))
    assert.equal(broken.instance.onDrop(drop), undefined)
    for (let i = 0; i < 5; i++) await tick()
    assert.deepEqual(unhandled, [])
    assert.deepEqual(broken.log.toasts, ['That could not be added.'])
    assert.equal(broken.log.errors.length, 1)
    assert.match(broken.log.errors[0], /\[builder\] a drop failed: Error: not a valid \.hyp file: its header is longer/)
    // a link that cannot be fetched
    const offline = builder({
      answer: {
        fetchLink: async () => {
          throw new TypeError('Failed to fetch')
        },
      },
    })
    offline.instance.onDrop(offline.link('https://files.example/thing.glb'))
    for (let i = 0; i < 5; i++) await tick()
    assert.deepEqual(unhandled, [])
    assert.deepEqual(offline.log.toasts, ['That could not be added.'])
    assert.match(offline.log.errors[0], /Failed to fetch/)
    // (control: a drop that works says nothing)
    const fine = builder()
    fine.instance.onDrop(fine.file(new File([new Uint8Array(10)], 'ok.vrm')))
    for (let i = 0; i < 5; i++) await tick()
    assert.deepEqual(fine.log.added, [['avatar', 'ok.vrm', 10]])
    assert.deepEqual(fine.log.toasts, [])
    assert.deepEqual(fine.log.errors, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

// --- two editor components ---

// The actual component source, rendered without a DOM (as tipForm.test.js does): hooks keep their slots across
// renders, an effect runs when its dependencies change (its previous cleanup first), and unmount() runs the cleanups.
function mountComponent(file, name, context, props) {
  const source = fs.readFileSync(new URL(`../src/client/components/${file}`, import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '').replace(/^export /gm, ''), {
    loader: 'jsx',
    jsxFactory: 'element',
  }).code
  const slots = []
  const effects = []
  let cursor = 0
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => (slots[index] = typeof value === 'function' ? value(slots[index]) : value)]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous && deps && deps.every((dep, i) => dep === previous.deps[i])) return
      slots[index] = { effect: true, deps: deps ?? [], cleanup: previous?.cleanup }
      effects.push(() => {
        slots[index].cleanup?.()
        slots[index].cleanup = effect()
      })
    },
    css: () => '',
    // (a ref is given its element when the tree is made)
    element: (type, elementProps) => {
      if (elementProps?.ref && context.refs?.[elementProps.className]) {
        elementProps.ref.current = context.refs[elementProps.className]
      }
      return { type, props: elementProps }
    },
  }
  const all = { ...hooks, ...context }
  const Component = new Function(...Object.keys(all), `${code}\nreturn ${name}`)(...Object.values(all))
  const render = () => {
    cursor = 0
    Component(props)
    while (effects.length) {
      for (const effect of effects.splice(0)) effect()
      cursor = 0
      Component(props)
    }
  }
  render()
  return {
    render,
    unmount() {
      for (const slot of slots) if (slot?.effect) slot.cleanup?.()
    },
  }
}

function scriptEditor(app) {
  const editors = []
  const monaco = {
    Uri: { parse: uri => uri },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
    editor: {
      getModel: () => null,
      createModel: code => ({ code }),
      create(_mount, options) {
        const editor = {
          disposed: false,
          value: options.model.code,
          setValue(value) {
            if (editor.disposed) throw new Error('setValue on a disposed editor')
            editor.value = value
          },
          getValue: () => editor.value,
          getModel: () => options.model,
          saveViewState: () => ({}),
          updateOptions() {},
          onDidChangeModelContent() {},
          addAction() {},
          dispose() {
            editor.disposed = true
          },
        }
        editors.push(editor)
        return editor
      },
    },
  }
  const mounted = mountComponent(
    'ScriptEditor.js',
    'ScriptEditor',
    {
      hashFile: async () => 'hash',
      createMonacoLoader: () => async () => monaco,
      // (Monaco is there: the editor is made in the effect's own turn)
      monacoFor: (_load, { closed, use }) => {
        if (!closed()) use(monaco)
      },
      refs: { 'editor-mount': {} },
    },
    { app, onHandle() {} }
  )
  return { ...mounted, editors }
}

test('script editor: a closed editor no longer watches the app, and a newer editor of the app keeps its own watch', () => {
  const app = {
    data: { id: 'app-1' },
    script: { code: 'one' },
    world: { prefs: Object.assign(new EventEmitter(), { ui: 1 }) },
  }
  const first = scriptEditor(app)
  assert.equal(first.editors.length, 1)
  assert.equal(typeof app.onScript, 'function')
  // a change of the script while the editor is open reaches it
  app.script = { code: 'two' }
  app.onScript()
  assert.equal(first.editors[0].value, 'two')
  first.unmount()
  assert.equal(first.editors[0].disposed, true)
  assert.equal(app.onScript, null, 'the app kept the watcher of the disposed editor')
  // App.onScriptChanged-style call after the pane is closed: nothing to call, nothing thrown
  app.script = { code: 'three' }
  assert.doesNotThrow(() => app.onScript?.())
  assert.equal(app.world.prefs.listenerCount('change'), 0)
  // the editor is opened again before the old one's cleanup runs (a remount): the newer watch stays
  const older = scriptEditor(app)
  const newer = scriptEditor(app)
  const watch = app.onScript
  older.unmount()
  assert.equal(app.onScript, watch, 'the newer editor still watches')
  app.script = { code: 'four' }
  app.onScript()
  assert.equal(newer.editors[0].value, 'four')
  newer.unmount()
  assert.equal(app.onScript, null)
})

test('curve pane: a new curve replaces the chart, and closing the pane takes it out', () => {
  const container = { offsetWidth: 300, offsetHeight: 200, children: [] }
  container.appendChild = elem => {
    container.children.push(elem)
    elem.parent = container
  }
  let made = 0
  const curveManager = options => {
    const elem = {
      id: ++made,
      curve: options.curve,
      remove() {
        const index = elem.parent.children.indexOf(elem)
        if (index !== -1) elem.parent.children.splice(index, 1)
      },
    }
    return { elem }
  }
  const props = { curve: { name: 'first' }, title: 'Curve' }
  const pane = mountComponent(
    'CurvePane.js',
    'CurvePane',
    { curveManager, usePane() {}, refs: { 'curvepane-container': container } },
    props
  )
  assert.deepEqual(
    container.children.map(elem => elem.curve.name),
    ['first']
  )
  // the same curve again: nothing is made
  pane.render()
  assert.equal(made, 1)
  props.curve = { name: 'second' }
  pane.render()
  assert.deepEqual(
    container.children.map(elem => elem.curve.name),
    ['second'],
    'the first chart used to stay under it'
  )
  props.curve = { name: 'third' }
  pane.render()
  assert.equal(container.children.length, 1)
  pane.unmount()
  assert.equal(container.children.length, 0)
})
