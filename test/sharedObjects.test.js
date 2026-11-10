import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { bundleProbe } from './lib/workerProbe.mjs'
import { eventPayload } from '../src/core/extras/eventPayload.js'

// Objects the engine used to hand to more than one app (or keep for itself while a script held them): each app
// now gets its own copy, so one app's changes (or accessors) reach nobody else.
let m
let bundle
before(async () => {
  bundle = await bundleProbe(`
    export { Apps } from './src/core/systems/Apps'
    export { ClientControls } from './src/core/systems/ClientControls'
    export { createNode } from './src/core/extras/createNode'
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

test("control.onTouch: an app's control gets a copy of the touch; the host's record and the player's stay", () => {
  const world = controls()
  const seen = {}
  world.controls.bind({
    priority: 2,
    object: { isApp: true, data: { id: 'a' } },
    onTouch: touch => {
      seen.app = touch
      touch.position.x = 999
      Object.defineProperty(touch.delta, 'x', { get: () => 'poison' })
    },
  })
  world.controls.bind({ priority: 1, onTouch: touch => (seen.host = touch) })
  world.controls.checkPointerChanges = () => {}
  world.controls.onPointerDown({ pointerType: 'touch', pointerId: 7, clientX: 5, clientY: 6, preventDefault() {} })
  const record = world.controls.touches.get(7)
  assert.equal(seen.host, record, 'the host control (the player) gets the live record')
  assert.notEqual(seen.app, record)
  assert.equal(record.position.x, 5)
  assert.equal(record.delta.x, 0)
})

test('control.camera: a script-held camera that throws or lies is contained per control', () => {
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
  Object.defineProperty(camera.position, 'x', {
    get() {
      throw new Error('poison')
    },
  })
  const original = console.error
  console.error = () => {}
  try {
    for (let i = 0; i < 3; i++) world.controls.postLateUpdate()
  } finally {
    console.error = original
  }
  assert.equal(app.crashed, true, 'the app crashes; the frame goes on')
  // a read-only camera gets numbers: a replaced set receives no host vector
  const other = world.controls.bind({ priority: 1, object: { isApp: true, data: { id: 'b' } } })
  const view = other.camera
  let received = null
  view.position.set = (...args) => (received = args)
  world.controls.postLateUpdate()
  assert.deepEqual(received, [1, 2, 3])
})

test('nodes: particles shape/bursts and sky sunDirection are copies, not shared defaults or script objects', () => {
  const a = m.createNode('particles').getProxy()
  const b = m.createNode('particles').getProxy()
  a.shape[1] = 999
  a.bursts.push({ time: 0, count: 5 })
  assert.equal(b.shape[1], 1, 'the default shape is not shared')
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
