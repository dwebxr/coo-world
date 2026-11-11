// The engine's number rule (src/core/extras/engineNumber.js) at the script boundary, in the real App, Stage, nodes,
// controls and builder (a bundle made after lockdown, scripts in real compartments: lib/sweepWorld.mjs):
//   - what a number slot keeps: a number; a string, a boolean or null converted; undefined, a Symbol, a BigInt and
//     any object as NaN, without being converted (setters, copy/set/fromArray, views, the transform guard, the Stage's
//     instance reads);
//   - an object a script planted in its node's own transform (past the setters) is never converted by the engine:
//     not by the app's network interpolation, not by the builder's grab and gizmo targets, not by a change callback
//     that fires while a copy is made;
//   - a control's entries are sealed: a script can write its fields, not replace the engine's parts;
//   - a setter of one node class called on another class's handle is refused with a node error.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'
import { createSweep } from './lib/sweepWorld.mjs'

let bundle
let m
let scripts
let sweep
const realDocument = globalThis.document
const requests = []

before(async () => {
  bundle = await bundleProbe(`
    export { Scripts } from './src/core/systems/Scripts'
    export { App } from './src/core/entities/App'
    export { Apps } from './src/core/systems/Apps'
    export { Anchors } from './src/core/systems/Anchors'
    export { Blueprints } from './src/core/systems/Blueprints'
    export { ClientControls } from './src/core/systems/ClientControls'
    export { ServerLiveKit } from './src/core/systems/ServerLiveKit'
    export { Stage } from './src/core/systems/Stage'
    export { ClientBuilder } from './src/core/systems/ClientBuilder'
    export { LerpVector3 } from './src/core/extras/LerpVector3'
    export { LerpQuaternion } from './src/core/extras/LerpQuaternion'
    export { isScriptView } from './src/core/extras/sealMath'
    export { createNode } from './src/core/extras/createNode'
    export * as Nodes from './src/core/nodes'
    export * as THREE from './src/core/extras/three'
    export { Object3D, PerspectiveCamera } from 'three'
  `)
  m = await import(bundle.url)
  scripts = new m.Scripts({})
  sweep = createSweep({ m, scripts, requests })
})
after(() => {
  globalThis.document = realDocument
  bundle?.destroy()
})

// what a script plants: every conversion of it is recorded
const PLANTED = `
  const calls = (app.state.calls = [])
  const planted = label => ({
    valueOf() { calls.push(label + ' valueOf'); return 0 },
    toString() { calls.push(label + ' toString'); return 'XYZ' },
    [Symbol.toPrimitive]() { calls.push(label + ' toPrimitive'); return 0 },
  })
`

// ---- a node's own transform, planted past the setters -----------------------------------------------------------

test("the app's network interpolation never converts what its script planted in the root's transform", async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  // planted while the script runs, before the build makes the interpolators from the root
  const app = sweep.addApp(
    world,
    `${PLANTED}
    app.position._x = planted('position')
    app.quaternion._x = planted('quaternion')
    app.rotation._order = planted('rotation order')
    app.scale._x = planted('scale')
    app.state.plant = () => {
      app.position._y = planted('position again')
      app.quaternion._w = planted('quaternion again')
    }
  `
  )
  await sweep.tick()
  assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
  const calls = app.data.state.calls
  assert.deepEqual([...calls], [], 'building the interpolators converted nothing')
  for (const [name, lerp] of [
    ['position', app.networkPos],
    ['quaternion', app.networkQuat],
    ['scale', app.networkSca],
  ]) {
    for (const key of ['previous', 'current']) {
      assert.equal(typeof lerp[key].x, 'number', `the ${name} interpolator's ${key} holds numbers`)
    }
  }
  // someone else moves the app: network updates arrive, and every frame interpolates into the root
  app.data.mover = 'someone-else'
  app.modify({ position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] })
  app.update(0.05)
  app.data.state.plant()
  app.modify({ position: [2, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] })
  app.update(0.05)
  world.stage.clean()
  app.root.clean()
  assert.deepEqual([...calls], [], 'no frame of the interpolation converted a planted object')
  assert.equal(typeof app.root.position.y, 'number')
  app.destroy()
})

// (the interpolators themselves, given a vector or quaternion with planted components: what the app's network
// interpolation is made from)
test('the network interpolators keep numbers of what they are made from, and convert nothing when they run', () => {
  const calls = []
  const planted = label => ({
    valueOf() {
      calls.push(label + ' valueOf')
      return 0
    },
  })
  const position = Object.assign(new m.THREE.Vector3(), { _x: planted('position') })
  const quaternion = Object.assign(new m.THREE.Quaternion(), { _x: planted('quaternion'), _w: planted('w') })
  const pos = new m.LerpVector3(position, 0.1)
  const quat = new m.LerpQuaternion(quaternion, 0.1)
  for (const lerp of [pos, quat]) {
    for (const key of ['previous', 'current']) assert.equal(typeof lerp[key].x, 'number', key)
  }
  pos.pushArray([1, 2, 3])
  quat.pushArray([0, 0, 0, 1])
  pos.update(0.05)
  quat.update(0.05)
  pos.snap()
  quat.clear()
  assert.deepEqual(calls, [])
})

test('the real path: a builder elsewhere starts moving the app, its script plants again, the network moves it', async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const app = sweep.addApp(
    world,
    `${PLANTED}
    app.position._x = planted('position')
    app.scale._z = planted('scale')
  `
  )
  await sweep.tick()
  app.modify({ mover: 'someone-else' })
  await sweep.tick()
  assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
  assert.equal(app.mode, 'moving')
  app.modify({ position: [1, 0, 0] })
  app.update(0.05)
  world.stage.clean()
  assert.deepEqual([...app.data.state.calls], [])
  app.destroy()
})

test("the builder's grab and gizmo targets copy a moved app's root through the guard (nothing planted is converted)", async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const app = sweep.addApp(
    world,
    `${PLANTED}
    app.state.plant = () => {
      app.position._x = planted('position')
      app.quaternion._x = planted('quaternion')
      app.scale._y = planted('scale')
    }
  `
  )
  await sweep.tick()
  assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
  const calls = app.data.state.calls
  // the builder's own methods, on a builder made without its client systems (no viewport, no XR menu)
  const builder = Object.create(m.ClientBuilder.prototype)
  builder.world = { ...world, camera: new m.PerspectiveCamera() }
  builder.viewport = {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
    getRootNode() {
      return this.ownerDocument
    },
  }
  builder.localSpace = false
  builder.target = new m.Object3D()
  builder.target.rotation.reorder('YXZ')
  builder.selected = app
  builder.mode = 'none'
  builder.control = { keyC: {}, scrollDelta: {} }
  builder.updateActions = () => {}
  // grab: the target (three's own Object3D) takes the root's transform; its matrix is composed every frame
  app.data.state.plant()
  builder.setMode('grab')
  builder.target.updateMatrix()
  assert.equal(typeof builder.target.position.x, 'number', 'the grab target holds numbers')
  // translate: the gizmo's target takes it too
  app.data.state.plant()
  builder.attachGizmo(app, 'translate')
  builder.gizmoTarget.updateMatrix()
  assert.equal(typeof builder.gizmoTarget.quaternion.x, 'number', 'the gizmo target holds numbers')
  builder.detachGizmo()
  assert.deepEqual([...calls], [], 'neither target converted a planted object')
  app.destroy()
})

// the copy family itself: what a copy, set or fromArray reads from another object is a number before the target's
// change callback runs (an Object3D sets its rotation from its quaternion there, and the other way round)
test('copy, set and fromArray store numbers before the change callback runs', () => {
  const calls = []
  const planted = label => ({
    valueOf() {
      calls.push(label + ' valueOf')
      return 0
    },
    toString() {
      calls.push(label + ' toString')
      return 'XYZ'
    },
  })
  const { Quaternion, Euler, Vector3, Matrix4 } = m.THREE
  const sources = {
    quaternion: () => Object.assign(new Quaternion(), { _x: planted('q._x'), _w: planted('q._w') }),
    euler: () => Object.assign(new Euler(), { _y: planted('e._y'), _order: planted('e._order') }),
    vector: () => Object.assign(new Vector3(), { _x: planted('v._x') }),
  }
  const seen = []
  const target = () => {
    const object = new m.Object3D()
    // what the callbacks see: three's own callbacks run after these (each converts what it reads)
    const quaternionChanged = object.quaternion._onChangeCallback
    object.quaternion._onChange(() => {
      seen.push(typeof object.quaternion._x, typeof object.quaternion._w)
      quaternionChanged()
    })
    const rotationChanged = object.rotation._onChangeCallback
    object.rotation._onChange(() => {
      seen.push(typeof object.rotation._y, typeof object.rotation._order)
      rotationChanged()
    })
    return object
  }
  target().quaternion.copy(sources.quaternion())
  target().quaternion.fromArray([planted('[0]'), 0, 0, planted('[3]')])
  target().quaternion.set(planted('x'), 0, 0, 1)
  target().rotation.copy(sources.euler())
  target().rotation.fromArray([0, planted('[1]'), 0, planted('[3] order')])
  target().rotation.set(0, planted('y'), 0, planted('order'))
  const vector = new Vector3()
  vector.copy(sources.vector())
  vector.fromArray([planted('[0]'), 0, 0])
  vector.setFromEuler(sources.euler())
  vector.setFromMatrixPosition(Object.assign(new Matrix4(), { elements: [...new Array(12).fill(0), planted('e12'), 0, 0, 1] }))
  assert.deepEqual(calls, [], 'nothing read from another object was converted')
  assert.ok(seen.length > 0 && seen.every(type => type === 'number' || type === 'string'), seen.join(','))
  assert.ok(Number.isNaN(vector.x))
})

// ---- what a number slot keeps --------------------------------------------------------------------------------------

test('a Symbol or a BigInt in any engine number slot is NaN, and no frame throws', async () => {
  for (const isServer of [false, true]) {
    const env = sweep.makeWorld({ isServer })
    const { world } = env
    const app = sweep.addApp(
      world,
      `
      const r = (app.state.r = [])
      const record = (label, read) => { try { r.push([label, typeof read()]) } catch (e) { r.push([label, 'threw ' + e.message]) } }
      const odd = [Symbol('s'), 10n]
      const node = app.create('group')
      app.add(node)
      for (const value of odd) {
        const tag = typeof value
        node.position.x = value
        record(tag + ' position.x =', () => node.position.x)
        node.position.set(1, value, 1)
        record(tag + ' position.set', () => node.position.y)
        node.position.fromArray([1, 1, value])
        record(tag + ' position.fromArray', () => node.position.z)
        node.scale.setScalar(value)
        record(tag + ' scale.setScalar', () => node.scale.x)
        node.position.copy({ x: value, y: 0, z: 0 })
        record(tag + ' position.copy', () => node.position.x)
        node.quaternion.w = value
        record(tag + ' quaternion.w =', () => node.quaternion.w)
        node.quaternion.set(0, 0, 0, value)
        record(tag + ' quaternion.set', () => node.quaternion.w)
        node.quaternion.fromArray([value, 0, 0, 1])
        record(tag + ' quaternion.fromArray', () => node.quaternion.x)
        node.rotation.y = value
        record(tag + ' rotation.y =', () => node.rotation.y)
        node.rotation.set(value, 0, 0)
        record(tag + ' rotation.set', () => node.rotation.x)
        // past the setters: read through the guard
        node.scale._z = value
        node.clean()
        record(tag + ' scale._z (planted)', () => node.scale._z)
        // views
        const ui = app.create('ui')
        ui.offset.x = value
        record(tag + ' ui.offset.x =', () => ui.offset.x)
        const joint = app.create('joint')
        joint.offset0.y = value
        record(tag + ' joint.offset0.y =', () => joint.offset0.y)
        const bone = app.get('skinned').getBone('hip')
        bone.position.x = value
        record(tag + ' bone.position.x =', () => bone.position.x)
        const first = app.get('first')
        first.matrixWorld.elements[1] = value
        record(tag + ' matrixWorld.elements[1] =', () => first.matrixWorld.elements[1])
        first.matrixWorld.elements.fill(value, 2, 3)
        record(tag + ' matrixWorld.elements.fill', () => first.matrixWorld.elements[2])
        const control = app.control()
        control.camera.position.z = value
        record(tag + ' control.camera.position.z =', () => control.camera.position.z)
        record(tag + ' new Vector3', () => new Vector3(value, 0, 0).x)
      }
    `
    )
    await sweep.tick()
    assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
    const kept = app.data.state.r.filter(([, type]) => type !== 'number')
    assert.deepEqual(kept, [], `every slot holds a number (NaN); ${isServer ? 'server' : 'client'}`)
    // a frame of the engine's passes over the nodes, and the stage's
    world.stage.clean()
    world.stage.update(0.016)
    app.root.clean()
    app.destroy()
  }
})

test("a value that is not a number in a linked instance's matrix is read as NaN: the Stage never throws, other apps' instances stay right", async () => {
  for (const isServer of [false, true]) {
    const env = sweep.makeWorld({ isServer })
    const { world } = env
    // one app plants a Symbol (and a BigInt) in a linked mesh's matrix through its view; another adds instances of the
    // same model in the same frame, so the model grows its buffer in Stage.update and reads every instance's matrix
    const hostile = sweep.addApp(
      world,
      `const first = app.get('first')
       app.state.go = () => {
         let last
         for (let i = 0; i < 9; i++) { last = first.clone(); app.add(last) }
         last.matrixWorld.elements[0] = Symbol('s')
         last.matrixWorld.elements[5] = 1n
       }`,
      'c'
    )
    const benign = sweep.addApp(
      world,
      `const first = app.get('first')
       app.state.go = () => { for (let i = 0; i < 5; i++) { const n = first.clone(); n.position.x = 100 + i; app.add(n) } }`,
      'd'
    )
    await sweep.tick()
    world.stage.update(0.016)
    world.stage.clean()
    hostile.data.state.go()
    benign.data.state.go()
    // and a value no view lets through, planted by the host in a node's own matrix (what a path past the views would
    // leave there): the read keeps it out of the buffer too
    const model = [...world.stage.models.values()][0]
    const size = model.iMesh.instanceMatrix.array.length / 16
    const planted = model.items.findLast(item => item.node.ctx.entity === hostile)
    assert.ok(model.items.indexOf(planted) >= size, "(an instance the grown buffer reads)")
    planted.matrix.elements[10] = Symbol('host')
    planted.matrix.elements[11] = 5n
    assert.doesNotThrow(() => world.stage.update(0.016), 'the stage reads every matrix')
    assert.doesNotThrow(() => world.stage.update(0.016))
    const array = model.iMesh.instanceMatrix.array
    // (the other app's clones, placed at x 100 to 104)
    const ours = model.items
      .map((item, i) => [item, i])
      .filter(([item]) => item.node.ctx.entity === benign && item.node.position.x >= 100)
    assert.equal(ours.length, 5)
    for (const [item, i] of ours) {
      assert.equal(array[i * 16 + 12], item.node.matrixWorld.elements[12], "the other app's instance is where its node is")
    }
    assert.deepEqual(
      ours.map(([item]) => item.node.matrixWorld.elements[12]).sort((a, b) => a - b),
      [100, 101, 102, 103, 104]
    )
    const slot = model.items.indexOf(planted)
    assert.ok(Number.isNaN(array[slot * 16 + 10]) && Number.isNaN(array[slot * 16 + 11]), 'read as NaN')
    hostile.destroy()
    benign.destroy()
  }
})

// ---- compatibility: what scripts write that still works -----------------------------------------------------------

test('strings, booleans and null given to a transform or a view are numbers there; boxed values and orders are not', async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    const r = (app.state.r = {})
    const t = (label, fn) => { try { r[label] = fn() } catch (e) { r[label] = 'threw ' + e.message } }
    const group = () => { const n = app.create('group'); app.add(n); return n }
    const worldX = n => { n.clean(); return n.matrixWorld.elements[12] }
    t('position.x = "2"', () => { const n = group(); n.position.x = '2'; return worldX(n) })
    t('position.set("1", "2", "3")', () => { const n = group(); n.position.set('1', '2', '3'); return worldX(n) })
    t('position.fromArray("1,2,3".split(","))', () => { const n = group(); n.position.fromArray('1,2,3'.split(',')); return worldX(n) })
    t('position.copy({ x: "1" })', () => { const n = group(); n.position.copy({ x: '1', y: 0, z: 0 }); return worldX(n) })
    t('position.x = true', () => { const n = group(); n.position.x = true; return worldX(n) })
    t('position.x = null', () => { const n = group(); n.position.x = 5; n.position.x = null; return worldX(n) })
    t('position.x = "abc"', () => { const n = group(); n.position.x = 'abc'; return n.position.x })
    t('scale.setScalar("2")', () => { const n = group(); n.scale.setScalar('2'); n.clean(); return n.matrixWorld.elements[0] })
    t('rotation.y = "1.57"', () => { const n = group(); n.rotation.y = '1.57'; return n.quaternion.y })
    t('quaternion.set(0, 0, 0, "1")', () => { const n = group(); n.quaternion.set(0, 0, 0, '1'); n.clean(); return n.matrixWorld.elements[0] })
    t('new Vector3("1", "2", "3").y', () => new Vector3('1', '2', '3').y)
    // views
    t('ui.offset.x = "3"', () => { const u = app.create('ui'); u.offset.x = '3'; return u.offset.x })
    t('joint.offset0.set("1", 0, 0)', () => { const j = app.create('joint'); j.offset0.set('1', 0, 0); return j.offset0.x })
    t('bone.position.x = "2"', () => { const b = app.get('skinned').getBone('hip'); b.position.x = '2'; return b.position.x })
    t('matrixWorld.elements[0] = "1"', () => { const n = app.get('first'); n.matrixWorld.elements[0] = '1'; return n.matrixWorld.elements[0] })
    t('control.camera.position.x = "4"', () => { const c = app.control(); c.camera.position.x = '4'; return c.camera.position.x })
    // boxed values are objects: NaN in math (never converted), refused by node setters
    t('position.x = new Number(2)', () => { const n = group(); n.position.x = new Number(2); return Number.isNaN(n.position.x) })
    t('material.color = new String("red")', () => { app.get('first').material.color = new String('red'); return 'kept' })
    // an order that is not a string leaves the order (a planted one is read as 'YXZ')
    t('rotation.set(0, 1, 0, new String("XYZ"))', () => { const n = group(); n.rotation.set(0, 1, 0, new String('XYZ')); return n.rotation.order })
    t('rotation.order = 5', () => { const n = group(); n.rotation.order = 'XYZ'; n.rotation.order = 5; return n.rotation.order })
    t('position._x = "2" (planted), then a frame', () => { const n = group(); n.position._x = '2'; n.position.y = 0; return worldX(n) })
    t('scale._y = true (planted), then a frame', () => { const n = group(); n.scale._y = true; n.position.y = 0; n.clean(); return n.matrixWorld.elements[5] })
    t('rotation._order = {} (planted), then a frame', () => { const n = group(); n.rotation._order = {}; n.position.x = 1; n.clean(); return n.rotation.order })
  `
  )
  await sweep.tick()
  assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
  const r = app.data.state.r
  assert.deepEqual(r, {
    'position.x = "2"': 2,
    'position.set("1", "2", "3")': 1,
    'position.fromArray("1,2,3".split(","))': 1,
    'position.copy({ x: "1" })': 1,
    'position.x = true': 1,
    'position.x = null': 0,
    'position.x = "abc"': NaN,
    'scale.setScalar("2")': 2,
    'rotation.y = "1.57"': Math.sin(1.57 / 2),
    'quaternion.set(0, 0, 0, "1")': 1,
    'new Vector3("1", "2", "3").y': 2,
    'ui.offset.x = "3"': 3,
    'joint.offset0.set("1", 0, 0)': 1,
    'bone.position.x = "2"': 2,
    'matrixWorld.elements[0] = "1"': 1,
    'control.camera.position.x = "4"': 4,
    'position.x = new Number(2)': true,
    'material.color = new String("red")': 'threw [material] color must be a string (e.g. "red", "#ff0000", "rgb(255,0,0)")',
    'rotation.set(0, 1, 0, new String("XYZ"))': 'YXZ',
    'rotation.order = 5': 'XYZ',
    'position._x = "2" (planted), then a frame': 2,
    'scale._y = true (planted), then a frame': 1,
    'rotation._order = {} (planted), then a frame': 'YXZ',
  })
  app.destroy()
})

// ---- control entries -----------------------------------------------------------------------------------------------

test("a control's entries are sealed: their fields can be written, the engine's parts not replaced", async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    const calls = (app.state.calls = [])
    const r = (app.state.r = [])
    const t = (label, fn) => { try { fn(); r.push(label + ': allowed') } catch (e) { r.push(label + ': ' + e.name) } }
    const c = (app.state.control = app.control())
    t('camera.position replaced', () => { c.camera.position = { set() { calls.push('set') }, get x() { calls.push('x'); return 0 }, y: 0, z: 0 } })
    t('camera.quaternion replaced', () => { c.camera.quaternion = { x: 0, y: 0, z: 0, get w() { calls.push('w'); return 1 } } })
    t('camera.write redefined as a getter', () => Object.defineProperty(c.camera, 'write', { get() { calls.push('write getter'); return false } }))
    t('camera.zoom redefined as a getter', () => Object.defineProperty(c.camera, 'zoom', { get() { calls.push('zoom getter'); return 1 } }))
    t('camera: a property added', () => { c.camera.extra = 1 })
    t('camera.$camera changed', () => { c.camera.$camera = false })
    t('mouseLeft.$button changed', () => { c.mouseLeft.$button = false })
    t('mouseLeft.down redefined as a getter', () => Object.defineProperty(c.mouseLeft, 'down', { get() { calls.push('down getter'); return true } }))
    t('mouseLeft.pressed deleted', () => { delete c.mouseLeft.pressed })
    t('touchStick.value replaced', () => { c.touchStick.value = { set x(v) { calls.push('stick x') } } })
    t('xrLeftRayPose.position replaced', () => { c.xrLeftRayPose.position = { set() { calls.push('pose set') } } })
    t('scrollDelta.value redefined as a getter', () => Object.defineProperty(c.scrollDelta, 'value', { get() { calls.push('scroll getter'); return 0 } }))
    t('pointer.lock replaced', () => { c.pointer.lock = () => calls.push('lock') })
    t('screen.width redefined', () => Object.defineProperty(c.screen, 'width', { value: 1 }))
    // what scripts write
    t('mouseLeft.capture = true', () => { c.mouseLeft.capture = true })
    t('mouseLeft.onPress = fn', () => { c.mouseLeft.onPress = () => {} })
    t('scrollDelta.capture = true', () => { c.scrollDelta.capture = true })
    t('camera.zoom = { valueOf }', () => { c.camera.zoom = { valueOf() { calls.push('zoom valueOf'); return 2 } } })
    t('camera.write = true', () => { c.camera.write = true })
    t('camera.position.set(1, 2, 3)', () => c.camera.position.set(1, 2, 3))
  `
  )
  await sweep.tick()
  assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
  const { calls, r, control } = app.data.state
  assert.deepEqual(r, [
    'camera.position replaced: TypeError',
    'camera.quaternion replaced: TypeError',
    'camera.write redefined as a getter: TypeError',
    'camera.zoom redefined as a getter: TypeError',
    'camera: a property added: TypeError',
    'camera.$camera changed: TypeError',
    'mouseLeft.$button changed: TypeError',
    'mouseLeft.down redefined as a getter: TypeError',
    'mouseLeft.pressed deleted: TypeError',
    'touchStick.value replaced: TypeError',
    'xrLeftRayPose.position replaced: TypeError',
    'scrollDelta.value redefined as a getter: TypeError',
    'pointer.lock replaced: TypeError',
    'screen.width redefined: TypeError',
    'mouseLeft.capture = true: allowed',
    'mouseLeft.onPress = fn: allowed',
    'scrollDelta.capture = true: allowed',
    'camera.zoom = { valueOf }: allowed',
    'camera.write = true: allowed',
    'camera.position.set(1, 2, 3): allowed',
  ])
  // a frame: the engine reads the entries (the zoom is not a number: the camera stays for this frame)
  world.controls.preFixedUpdate()
  world.controls.postLateUpdate()
  assert.deepEqual([...calls], [], 'no script code ran in the engine')
  assert.equal(world.rig.position.x, 0, 'a camera with a zoom that is not a number does not move')
  control.camera.zoom = 2
  world.controls.postLateUpdate()
  assert.deepEqual([world.rig.position.x, world.rig.position.y, world.rig.position.z], [1, 2, 3], 'written camera moves the rig')
  app.destroy()
})

// ---- setters -------------------------------------------------------------------------------------------------------

test("a node class's setter called on another class's handle is refused with a node error", async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    const r = (app.state.r = [])
    const set = Object.getOwnPropertyDescriptor(app.create('mesh'), 'castShadow').set
    for (const receiver of [app.create('group'), Object.create(app.create('ui'))]) {
      try { Reflect.apply(set, receiver, [true]); r.push('set') } catch (e) { r.push(e.name + ': ' + e.message) }
    }
    try { Reflect.apply(set, {}, [true]) } catch (e) { r.push(e.name + ': ' + e.message) }
    const mesh = app.create('mesh')
    Reflect.apply(set, mesh, [true])
    r.push(mesh.castShadow)
  `
  )
  await sweep.tick()
  assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
  assert.deepEqual(app.data.state.r, [
    'TypeError: [node] a group node has no castShadow to set',
    'TypeError: [node] a ui node has no castShadow to set',
    'TypeError: [node] not a node',
    true,
  ])
  app.destroy()
})
