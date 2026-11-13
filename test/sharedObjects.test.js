import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { bundleProbe } from './lib/workerProbe.mjs'
import { eventPayload } from '../src/core/extras/eventPayload.js'
import { callEntry, callScript } from '../src/core/extras/callScript.js'
import { loadClient } from './lib/clientHarness.mjs'
import { loadNetwork, makeNetwork } from './lib/network.mjs'

// Objects the engine used to hand to more than one app (or keep for itself while a script held them): each app
// now gets its own copy, so one app's changes (or accessors) reach nobody else.
const net = await loadNetwork()

let m
let bundle
before(async () => {
  bundle = await bundleProbe(`
    export { Apps } from './src/core/systems/Apps'
    export { ClientControls } from './src/core/systems/ClientControls'
    export { createNode } from './src/core/extras/createNode'
    export { PlayerRemote } from './src/core/entities/PlayerRemote'
    export { PointerState } from './src/core/systems/ClientPointer'
    export * as THREE from './src/core/extras/three'
  `)
  m = await import(bundle.url)
})
after(() => bundle?.destroy())

test('world.overlapSphere: every call returns new plain records, whatever the physics system reuses', () => {
  const handle = { tag: 'door', playerId: null }
  const pooled = [{ actor: {}, handle, proxy: { tag: 'pooled' } }]
  const world = { network: {}, events: {}, physics: { overlapSphere: () => pooled } }
  const apps = new m.Apps(world)
  const origin = new m.THREE.Vector3()
  const a = apps.worldMethods.overlapSphere({}, 1, origin)
  Object.defineProperty(a[0], 'tag', { get: () => 'attacker-controlled' })
  a[0].playerId = 'forged'
  const b = apps.worldMethods.overlapSphere({}, 1, origin)
  assert.notEqual(a[0], b[0])
  assert.deepEqual(b, [{ tag: 'door', playerId: null }])
  assert.equal(pooled[0].proxy.tag, 'pooled', 'the pool is only read')
  // a tag that is not a primitive string never reaches another app
  handle.tag = new String('boxed')
  assert.deepEqual(apps.worldMethods.overlapSphere({}, 1, origin), [{ tag: null, playerId: null }])
  assert.throws(() => (m.createNode('rigidbody').getProxy().tag = new String('boxed')), /tag not a string/)
})

test('world.get: each read is a copy; the stored value cannot be patched through it', () => {
  const stored = { score: 1, list: [1] }
  const world = { network: {}, events: {}, storage: { get: () => stored } }
  const apps = new m.Apps(world)
  const a = apps.worldMethods.get({}, 'k')
  a.score = 99
  a.list.push(2)
  Object.defineProperty(a, 'trap', { get: () => 'x', enumerable: true })
  const b = apps.worldMethods.get({}, 'k')
  assert.deepEqual(b, { score: 1, list: [1] })
  assert.deepEqual(stored, { score: 1, list: [1] })
})

function controls() {
  const world = Object.assign(new EventEmitter(), {
    rig: {
      position: new m.THREE.Vector3(1, 2, 3),
      quaternion: new m.THREE.Quaternion(),
      rotation: new m.THREE.Euler(),
    },
    camera: { position: new m.THREE.Vector3(0, 0, 5) },
    ui: { suppressReticle: () => () => {} },
    entities: {},
  })
  world.controls = new m.ClientControls(world)
  return world
}

test('control.pointer: each read is a new vector made from numbers; nothing reaches a replaced method', () => {
  const world = controls()
  const control = world.controls.bind({ priority: 1, object: { isApp: true, data: { id: 'a' } } })
  world.controls.pointer.position.set(10, 20, 0)
  const first = control.pointer.position
  let leaked = null
  first.copy = value => (leaked = value)
  first.set = value => (leaked = value)
  const second = control.pointer.position
  assert.equal(leaked, null)
  assert.notEqual(first, second)
  assert.notEqual(second, world.controls.pointer.position)
  assert.deepEqual(second.toArray(), [10, 20, 0])
  assert.notEqual(control.pointer.coords, control.pointer.coords)
  assert.notEqual(control.pointer.delta, world.controls.pointer.delta)
})

test("control.onTouch: an app's control gets one stable touch facade; the host keeps the live record", () => {
  const world = controls()
  const seen = {}
  world.controls.bind({
    priority: 2,
    object: { isApp: true, data: { id: 'a' } },
    onTouch: touch => {
      seen.start = touch
      touch.position.x = 999 // a copy: changes nothing
      assert.throws(() => Object.defineProperty(touch, 'position', { get: () => 'poison' }), TypeError)
    },
    onTouchEnd: touch => {
      seen.end = touch // (returning a truthy value would consume the touch)
    },
  })
  world.controls.bind({
    priority: 1,
    onTouch: touch => (seen.host = touch),
    onTouchEnd: touch => (seen.hostEnd = touch),
  })
  world.controls.checkPointerChanges = () => {}
  world.controls.viewport = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }
  const event = (x, y) => ({
    pointerType: 'touch',
    pointerId: 7,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
    movementX: 0,
    movementY: 0,
    preventDefault() {},
  })
  world.controls.onPointerDown(event(5, 6))
  const record = world.controls.touches.get(7)
  assert.equal(seen.host, record, 'the host control (the player) gets the live record')
  assert.notEqual(seen.start, record)
  assert.equal(record.position.x, 5)
  // the kept facade follows the touch as it moves
  world.controls.onPointerMove(event(15, 6))
  assert.equal(seen.start.position.x, 15)
  assert.equal(seen.start.delta.x, 10)
  assert.notEqual(seen.start.position, seen.start.position, 'each read is a new vector')
  world.controls.onPointerUp(event(15, 6))
  assert.equal(seen.end, seen.start, 'the same object at the end, so it can be compared')
  assert.equal(seen.hostEnd, record)
  assert.equal(seen.start.id, 7)
  assert.equal(world.controls.touchFacades.size, 0, 'an ended touch leaves nothing in the host cache')
})

test('control.onTouch: a kept touch facade keeps no released control (or app) in the host cache', () => {
  const world = controls()
  const kept = {}
  const bind = (id, priority) =>
    world.controls.bind({
      priority,
      object: { isApp: true, data: { id } },
      onTouch: touch => {
        kept[id] = touch // (returns nothing: the touch is not consumed, so both controls get it)
      },
    })
  const a = bind('a', 2)
  const b = bind('b', 1)
  world.controls.checkPointerChanges = () => {}
  world.controls.viewport = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }
  const event = x => ({
    pointerType: 'touch',
    pointerId: 3,
    clientX: x,
    clientY: 4,
    pageX: x,
    pageY: 4,
    movementX: 0,
    movementY: 0,
    preventDefault() {},
  })
  world.controls.onPointerDown(event(5))
  const record = world.controls.touches.get(3)
  assert.equal(world.controls.touchFacades.get(record).size, 2)
  world.controls.onPointerMove(event(9))
  a.release()
  assert.equal(world.controls.touchFacades.get(record).size, 1, "a released control's entry goes")
  b.release()
  assert.equal(world.controls.touchFacades.get(record).size, 0)
  // the touch goes on, then ends: the facade A kept answers with the values it had when its control was released
  world.controls.onPointerMove(event(30))
  world.controls.onPointerUp(event(30))
  assert.equal(world.controls.touchFacades.size, 0, 'nothing is cached for the touch')
  assert.equal(world.controls.touches.size, 0)
  assert.equal(kept.a.position.x, 9)
  assert.equal(kept.a.delta.x, 4)
  assert.equal(kept.a.id, 3)
  assert.equal(kept.a.pointerType, 'touch')
  assert.equal(kept.b.position.x, 9)
})

// the real lock path, with the browser's pointer lock simulated: a request, then the lock-change event it fires
function pointerLock(world) {
  const calls = { request: 0, exit: 0 }
  world.controls.viewport = { requestPointerLock: async () => calls.request++ }
  const original = globalThis.document
  globalThis.document = { exitPointerLock: () => calls.exit++ }
  return { calls, granted: () => world.controls.onPointerLockStart(), restore: () => (globalThis.document = original) }
}

test("control.pointer: a control's pointer lock ends with it, whether or not its onRelease unlocks", () => {
  for (const unlockInCallback of [true, false]) {
    const world = controls()
    const lock = pointerLock(world)
    try {
      // the review's sequence: the callback unlocks (and sees it done)
      let lockedAfterCallbackUnlock
      const c = world.controls.bind({
        priority: 1,
        object: { isApp: true, data: { id: 'a' } },
        onRelease: unlockInCallback
          ? () => {
              c.pointer.unlock()
              lockedAfterCallbackUnlock = c.pointer.locked
            }
          : undefined,
      })
      c.pointer.lock()
      lock.granted()
      assert.equal(c.pointer.locked, true)
      c.release()
      const label = `unlock in onRelease: ${unlockInCallback}`
      if (unlockInCallback) assert.equal(lockedAfterCallbackUnlock, false, 'the callback itself unlocked')
      assert.equal(world.controls.pointer.locked, false, label)
      assert.equal(world.controls.pointer.shouldLock, false, label)
      assert.equal(lock.calls.exit, 1, `exactly one browser unlock (${label})`)
    } finally {
      lock.restore()
    }
  }
})

test("control.pointer: releasing one control leaves another control's pointer lock alone", () => {
  const world = controls()
  const lock = pointerLock(world)
  try {
    const a = world.controls.bind({ priority: 2, object: { isApp: true, data: { id: 'a' } } })
    const b = world.controls.bind({ priority: 1, object: { isApp: true, data: { id: 'b' } } })
    a.pointer.lock()
    lock.granted()
    b.release()
    assert.equal(world.controls.pointer.locked, true)
    assert.equal(lock.calls.exit, 0)
    // a released control's pointer changes nothing (it neither locks nor unlocks)
    b.pointer.lock()
    b.pointer.unlock()
    assert.equal(lock.calls.request, 1)
    assert.equal(world.controls.pointer.locked, true)
    a.release()
    assert.equal(world.controls.pointer.locked, false)
    assert.equal(lock.calls.exit, 1)
  } finally {
    lock.restore()
  }
})

test('XR ray smoothing: same pose values as before, with the smoothing state kept from the script', () => {
  const world = controls()
  world.rig.position.set(1, 0, 2)
  world.rig.quaternion.setFromAxisAngle(new m.THREE.Vector3(0, 1, 0), 0.5)
  const control = world.controls.bind({ priority: 1, object: { isApp: true, data: { id: 'a' } } })
  const poses = { Left: control.xrLeftRayPose, Right: control.xrRightRayPose }
  // the poses a script holds are sealed engine objects (sealMath.js): it cannot put its own methods or accessors on them
  for (const pose of Object.values(poses)) {
    for (const target of [pose.position, pose.quaternion]) {
      assert.ok(Object.isSealed(target))
      assert.throws(() => {
        target.set = () => {}
      }, TypeError)
      assert.throws(() => Object.defineProperty(target, 'x', { get: () => 0 }), TypeError)
    }
  }
  const frames = [
    { Left: [0.1, 1.5, -0.2, 0, 0, 0, 1], Right: [0.3, 1.4, -0.1, 0, 0.1, 0, 0.995] },
    { Left: [0.15, 1.52, -0.25, 0, 0.05, 0, 0.99875], Right: [0.31, 1.41, -0.12, 0, 0.12, 0, 0.9928] },
    { Left: [0.2, 1.55, -0.3, 0, 0.1, 0, 0.995], Right: [0.32, 1.42, -0.15, 0, 0.15, 0, 0.9887] },
  ]
  // the reference: the previous implementation's arithmetic, on plain engine objects
  const factor = 1 - 0.6
  const reference = {}
  for (const frame of frames) {
    for (const side of ['Left', 'Right']) {
      const [x, y, z, qx, qy, qz, qw] = frame[side]
      const point = new m.THREE.Vector3(x, y, z)
      const rotation = new m.THREE.Quaternion(qx, qy, qz, qw)
      if (!reference[side]) reference[side] = { position: point.clone(), quaternion: rotation.clone() }
      reference[side].position.lerp(point, factor)
      reference[side].quaternion.slerp(rotation, factor)
    }
  }
  const world2 = { position: world.rig.position, quaternion: world.rig.quaternion }
  const expected = {}
  for (const side of ['Left', 'Right']) {
    const local = new m.THREE.Matrix4().compose(
      reference[side].position,
      reference[side].quaternion,
      new m.THREE.Vector3(1, 1, 1)
    )
    const rig = new m.THREE.Matrix4().compose(world2.position, world2.quaternion, new m.THREE.Vector3(1, 1, 1))
    local.premultiply(rig)
    const position = new m.THREE.Vector3()
    const quaternion = new m.THREE.Quaternion()
    local.decompose(position, quaternion, new m.THREE.Vector3())
    expected[side] = [...position.toArray(), ...quaternion.toArray()]
  }
  // drive the real XR path: three frames, both hands
  let current
  world.graphics = { renderer: { xr: { getReferenceSpace: () => ({}), getFrame: () => current } } }
  const source = side => ({
    handedness: side.toLowerCase(),
    targetRaySpace: side,
    gamepad: { axes: [0, 0, 0, 0], buttons: Array.from({ length: 6 }, () => ({ value: 0, pressed: false })) },
  })
  world.controls.xrSession = { inputSources: [source('Left'), source('Right')] }
  for (const frame of frames) {
    current = {
      getPose: space => {
        const [x, y, z, qx, qy, qz, qw] = frame[space]
        return { transform: { position: { x, y, z }, orientation: { x: qx, y: qy, z: qz, w: qw } } }
      },
    }
    world.controls.preFixedUpdate()
    world.controls.applyXRRig(world.rig)
  }
  for (const side of ['Left', 'Right']) {
    const pose = poses[side]
    const actual = [...pose.position.toArray(), ...pose.quaternion.toArray()]
    actual.forEach((value, i) => assert.ok(Math.abs(value - expected[side][i]) < 1e-12, `${side} ${i}`))
    assert.equal('lPosition' in pose, false, 'no smoothing state on the script-visible pose')
  }
  // the smoothing state is the host's and leaves with its control (the script keeps its poses)
  assert.equal(world.controls.raySmoothing.size, 2)
  control.release()
  assert.equal(world.controls.raySmoothing.size, 0)
})

test("controls: an app's control is inert once its run has ended, even if it was never released", () => {
  const world = controls()
  const lock = pointerLock(world)
  try {
    world.ui = { suppressors: 0, suppressReticle: () => (world.ui.suppressors++, () => world.ui.suppressors--) }
    const entity = { isApp: true, data: { id: 'a' }, deadHook: { dead: false } }
    let pressed = 0
    const c = world.controls.bind({ priority: 1, object: entity }, { entity, run: entity.deadHook })
    c.keyE.onPress = () => pressed++
    // the run ends (App.unbuild replaces the hook) and nothing releases the control
    entity.deadHook = { dead: false }
    c.pointer.lock()
    c.hideReticle()
    c.setActions([{ type: 'keyE', label: 'Use' }])
    world.controls.onKeyDown({ code: 'KeyE', repeat: false, target: {}, preventDefault() {} })
    assert.equal(lock.calls.request, 0)
    assert.equal(world.ui.suppressors, 0)
    assert.deepEqual(world.controls.actions, [])
    assert.equal(pressed, 0)
    // a control of the current run works
    const live = world.controls.bind({ priority: 1, object: entity }, { entity, run: entity.deadHook })
    live.keyE.onPress = () => pressed++
    live.pointer.lock()
    live.hideReticle()
    world.controls.onKeyDown({ code: 'KeyE', repeat: false, target: {}, preventDefault() {} })
    assert.equal(lock.calls.request, 1)
    assert.equal(world.ui.suppressors, 1)
    assert.equal(pressed, 1)
  } finally {
    lock.restore()
  }
})

test('controls: what the host keeps per touch, control and pose goes when the world is destroyed', () => {
  const world = controls()
  world.controls.bind({ priority: 2, object: { isApp: true, data: { id: 'a' } }, onTouch: () => {} })
  const host = world.controls.bind({ priority: 1 })
  world.controls.checkPointerChanges = () => {}
  world.controls.onPointerDown({ pointerType: 'touch', pointerId: 1, clientX: 1, clientY: 1, preventDefault() {} })
  world.controls.raySmoothing.set(host.xrLeftRayPose, { position: null, quaternion: null })
  world.controls.pointerOwner = {}
  assert.equal(world.controls.touchFacades.size, 1)
  world.controls.destroy()
  assert.equal(world.controls.touchFacades.size, 0)
  assert.equal(world.controls.touches.size, 0)
  assert.equal(world.controls.raySmoothing.size, 0)
  assert.equal(world.controls.pointerOwner, null)
})

test('pointer callbacks of an app run that has ended are not delivered (a leave on the next frame included)', () => {
  const original = globalThis.document
  globalThis.document = { body: { style: {} } }
  try {
    const seen = []
    const entity = { isApp: true, deadHook: { dead: false } }
    const node = m.createNode('group')
    node.ctx = { entity, run: entity.deadHook }
    node.onPointerEnter = () => seen.push('enter')
    node.onPointerLeave = () => seen.push('leave')
    const state = new m.PointerState()
    state.update({ node }, false, false)
    entity.deadHook = { dead: false }
    state.update(null, false, false)
    assert.deepEqual(seen, ['enter'])
    assert.equal(node.getProxy().onPointerLeave, null)
  } finally {
    globalThis.document = original
  }
})

test('control.camera: a script-held camera can neither throw nor lie (its entry is sealed); values that are not finite never reach the rig', () => {
  const world = controls()
  const app = {
    isApp: true,
    data: { id: 'a' },
    crashed: false,
    crash() {
      this.crashed = true
    },
  }
  const control = world.controls.bind({ priority: 2, object: app })
  const camera = control.camera
  camera.write = true
  camera.position.x = NaN
  world.controls.postLateUpdate()
  assert.deepEqual(world.rig.position.toArray(), [1, 2, 3], 'a non-finite camera never reaches the rig')
  // its vectors are sealed (no accessor can be put on them), and so is the camera entry: no getter on its fields, no
  // other vector in place of the engine's
  assert.throws(() => Object.defineProperty(camera.position, 'x', { get: () => 0 }), TypeError)
  for (const key of ['zoom', 'write']) {
    assert.throws(
      () =>
        Object.defineProperty(camera, key, {
          get() {
            throw new Error('poison')
          },
        }),
      TypeError
    )
  }
  assert.throws(() => (camera.position = new m.THREE.Vector3(9, 9, 9)), TypeError)
  // a zoom that is not a number is not converted: the camera stays for that frame, and the app runs on
  camera.position.x = 1
  camera.zoom = {
    valueOf() {
      throw new Error('poison')
    },
  }
  for (let i = 0; i < 3; i++) world.controls.postLateUpdate()
  assert.equal(app.crashed, false)
  assert.deepEqual(world.rig.position.toArray(), [1, 2, 3], 'a zoom that is not a number never moves the camera')
  // a read-only camera gets numbers, and no method of its vectors can be replaced
  const other = world.controls.bind({ priority: 1, object: { isApp: true, data: { id: 'b' } } })
  const view = other.camera
  assert.throws(() => {
    view.position.set = () => {}
  }, TypeError)
  world.controls.postLateUpdate()
  assert.deepEqual(view.position.toArray(), [1, 2, 3])
})

test('nodes: particles shape/bursts and sky sunDirection are copies, not shared defaults or script objects', () => {
  const a = m.createNode('particles').getProxy()
  const b = m.createNode('particles').getProxy()
  // each node keeps its own frozen copy: nothing can be put into it, nor into another node's through it
  assert.throws(() => (a.shape[1] = 999), TypeError)
  assert.throws(() => a.bursts.push({ time: 0, count: 5 }), TypeError)
  assert.notEqual(a.shape, b.shape, 'the default shape is not shared')
  assert.equal(b.shape[1], 1)
  assert.deepEqual(b.bursts, [])
  const shape = ['sphere', 2, 1]
  b.shape = shape
  shape[1] = 50
  assert.equal(b.shape[1], 2, 'the node keeps its own copy')
  const sky = m.createNode('sky').getProxy()
  const direction = new m.THREE.Vector3(0, -1, 0)
  sky.sunDirection = direction
  direction.set(1, 0, 0)
  assert.deepEqual(sky.sunDirection.toArray(), [0, -1, 0])
  sky.sunDirection.set(5, 5, 5)
  assert.deepEqual(sky.sunDirection.toArray(), [0, -1, 0], 'reads are copies')
  assert.throws(() => (sky.sunDirection = new m.THREE.Vector3(NaN, 0, 0)), /sunDirection not a Vector3/)
  const view = m.createNode('uiview').getProxy()
  const margin = [1, 2, 3, 4]
  view.margin = margin
  margin[0] = 100
  assert.deepEqual(view.margin, [1, 2, 3, 4])
  assert.ok(Object.isFrozen(view.margin), 'the node keeps a frozen copy')
})

test('engine world events: enter, leave, health and command payloads are frozen copies', () => {
  const args = ['go', { deep: [1] }]
  const payload = eventPayload({ playerId: 'p', args })
  assert.ok(Object.isFrozen(payload))
  assert.ok(Object.isFrozen(payload.args))
  assert.ok(Object.isFrozen(payload.args[1].deep))
  assert.notEqual(payload.args, args)
  assert.throws(() => {
    'use strict'
    payload.playerId = 'forged'
  })
  assert.equal(eventPayload({ fn() {}, x: 1 }).fn, undefined)
  const proto = eventPayload(JSON.parse('{"__proto__":{"polluted":true}}'))
  assert.equal({}.polluted, undefined)
  assert.equal(Object.getPrototypeOf(proto), Object.prototype)
})

// what each engine producer emitted, through the real code that emits it
function capture() {
  const emitted = []
  return { emitted, events: { emit: (name, data) => emitted.push([name, data]) } }
}

function assertFrozenPayload([name, data], expectedName) {
  assert.equal(name, expectedName)
  assert.ok(Object.isFrozen(data), `${name} payload is frozen`)
  for (const value of Object.values(data)) if (value && typeof value === 'object') assert.ok(Object.isFrozen(value))
}

test('engine world events from their real producers: enter, leave, health and command are frozen', async t => {
  // enter, on a client, when a remote player is added
  const enter = capture()
  const Entities = loadClient('core/systems/Entities.js', 'Entities', {
    App: class {},
    PlayerLocal: class {},
    PlayerRemote: class {
      constructor(_world, data) {
        this.data = data
      }
    },
    preflightPacket: () => true,
  })
  const entities = new Entities({ network: { isClient: true, id: 'me' }, events: enter.events, emit() {} })
  entities.add({ type: 'player', id: 'p', owner: 'other' })
  assertFrozenPayload(enter.emitted[0], 'enter')
  // health and leave, from a remote player
  const player = capture()
  const remote = Object.create(m.PlayerRemote.prototype)
  Object.assign(remote, {
    data: { id: 'p' },
    nametag: {},
    base: { deactivate() {} },
    aura: { deactivate() {} },
    world: {
      events: player.events,
      emit() {},
      setHot() {},
      entities: { remove() {} },
      network: { send() {} },
    },
  })
  remote.modify({ health: 50 })
  remote.destroy()
  assertFrozenPayload(player.emitted[0], 'health')
  assertFrozenPayload(player.emitted[1], 'leave')
  // command, from the client's chat input
  const client = capture()
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const chat = new Chat({ network: { isServer: false, id: 'me', send() {} }, events: client.events })
  chat.command('/dance now')
  assertFrozenPayload(client.emitted[0], 'command')
  assert.deepEqual(client.emitted[0][1].args, ['dance', 'now'])
  // command, on the server, from a client's packet
  const network = makeNetwork(t, { net })
  const server = capture()
  network.world.events = server.events
  // (a list with something in it that is not a word is no command: nothing is emitted for it)
  await network.onCommand({ id: 'p', player: { data: { id: 'p' } } }, { args: ['dance', { deep: [1] }] })
  assert.deepEqual(server.emitted, [])
  const packet = { cmd: 'dance', value: 'now', args: ['dance', 'now'] }
  await network.onCommand({ id: 'p', player: { data: { id: 'p' } } }, packet)
  assertFrozenPayload(server.emitted[0], 'command')
  assert.deepEqual(server.emitted[0][1], { playerId: 'p', cmd: 'dance', value: 'now', args: ['dance', 'now'] })
  // a copy: the packet's own list is not what scripts hold
  assert.notEqual(server.emitted[0][1].args, packet.args)
})

test('shared defaults: action default callbacks are frozen; engine calls never look up call/apply on a callback', () => {
  const a = m.createNode('action').getProxy()
  const b = m.createNode('action').getProxy()
  for (const key of ['onStart', 'onTrigger', 'onCancel']) {
    assert.equal(a[key], b[key], 'one default function for every action node')
    assert.ok(Object.isFrozen(a[key]))
    assert.throws(() =>
      Object.defineProperty(a[key], 'call', {
        value() {
          throw new Error('other action poisoned')
        },
      })
    )
  }
  const fn = function (x) {
    return ['real', this, x]
  }
  // defined, not assigned: under lockdown an assignment over the frozen Function.prototype.call throws, a
  // definition still makes an own property (proxyCopiesHardened.test.js runs the same in a compartment)
  Object.defineProperty(fn, 'call', { value: () => 'replaced call' })
  Object.defineProperty(fn, 'apply', { value: () => 'replaced apply' })
  assert.equal(fn.call(), 'replaced call')
  assert.deepEqual(callScript(fn, 1), ['real', undefined, 1])
  const entry = {
    onPress() {
      return this
    },
  }
  Object.defineProperty(entry.onPress, 'call', { value: () => 'replaced call' })
  assert.equal(callEntry(entry, 'onPress'), entry)
  // a pointer callback is invoked the same way
  const original = globalThis.document
  globalThis.document = { body: { style: {} } }
  try {
    const seen = []
    const onPointerDown = event => seen.push(event.type)
    Object.defineProperty(onPointerDown, 'call', { value: () => seen.push('replaced call') })
    const node = { parent: null, cursor: null, onPointerDown }
    new m.PointerState().update({ node }, true, false)
    assert.deepEqual(seen, ['pointerdown'])
  } finally {
    globalThis.document = original
  }
})
