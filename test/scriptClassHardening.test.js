import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// the real lockdown config (ses must be imported first, as in src/server/index.js)
import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'

// The real Scripts system, the real THREE and every node type, bundled the way the server build does it.
// Constructing Scripts hardens the classes, exactly as a world does at start-up.
let bundle
let m
let scripts

before(async () => {
  bundle = await bundleProbe(`
    export { Scripts } from './src/core/systems/Scripts'
    export * as THREE from './src/core/extras/three'
    export { Vector3 as StockVector3, Matrix3, Object3D } from 'three'
    export { Keyframe } from './src/core/extras/Curve'
    export { createNode } from './src/core/extras/createNode'
    export * as Nodes from './src/core/nodes'
    export { Stage } from './src/core/systems/Stage'
    export { PointerState, createPointerEvent } from './src/core/systems/ClientPointer'
    export { setVectorFromPoint, setQuaternionFromPoint } from './src/core/extras/xrPose'
  `)
  m = await import(bundle.url)
  scripts = new m.Scripts({})
})

after(() => bundle?.destroy())

// runs script source inside a real script compartment; `host` is what the script sees as its `world` argument
function run(code, host) {
  return scripts.evaluate(code).exec(host)
}

const ENDOWMENTS = [
  'BufferedLerpQuaternion',
  'BufferedLerpVector3',
  'Curve',
  'DEG2RAD',
  'Date',
  'Euler',
  'LerpQuaternion',
  'LerpVector3',
  'Math',
  'Matrix4',
  'Quaternion',
  'RAD2DEG',
  'URL',
  'Vector3',
  'clamp',
  'console',
  'eval',
  'harden',
  'lockdown',
  'num',
  'prng',
  'uuid',
]

test('the endowment set is exactly the pinned list (no Object3D, nothing new without a review)', () => {
  const endowments = scripts.createEndowments()
  assert.deepEqual(Object.keys(endowments).sort(), ENDOWMENTS)
  for (const name of ['eval', 'harden', 'lockdown']) assert.equal(endowments[name], undefined)
  assert.equal(run('return typeof Object3D'), 'undefined')
})

test('every endowed value is frozen, and so is every class prototype and constructor', () => {
  const endowments = scripts.createEndowments()
  for (const [name, value] of Object.entries(endowments)) {
    if (value === undefined || (typeof value !== 'object' && typeof value !== 'function')) continue
    assert.equal(Object.isFrozen(value), true, `${name} is frozen`)
    if (typeof value === 'function' && value.prototype) {
      assert.equal(Object.isFrozen(value.prototype), true, `${name}.prototype is frozen`)
    }
  }
  for (const cls of [m.StockVector3, m.Matrix3, m.Keyframe, m.THREE.Color]) {
    assert.equal(Object.isFrozen(cls), true)
    assert.equal(Object.isFrozen(cls.prototype), true)
  }
})

// each attack runs in its own compartment; all of them changed the host before the classes were hardened
const ATTACKS = {
  'replace a method': `Vector3.prototype.add = function () { return 42 }`,
  'add a property (a mailbox between scripts)': `Vector3.prototype.mailbox = { secret: 1 }`,
  'redefine a method': `Object.defineProperty(Matrix4.prototype, 'copy', { value() { return this } })`,
  'redefine an accessor': `Object.defineProperty(Vector3.prototype, 'x', { get() { return 1 } })`,
  'delete a method': `delete Quaternion.prototype.multiply`,
  'replace the change callback every instance inherits': `Quaternion.prototype._onChangeCallback = function () { throw new Error('hooked') }`,
  'Reflect.set with the prototype as receiver': `if (!Reflect.set(Euler.prototype, 'set', function () {}, Euler.prototype)) throw new TypeError('refused')`,
  'swap the prototype chain': `Object.setPrototypeOf(Vector3.prototype, { add() { return 42 } })`,
  'replace the iterator': `Vector3.prototype[Symbol.iterator] = function* () { yield 'x' }`,
  'replace the constructor link': `Vector3.prototype.constructor = function () {}`,
  'change a static': `Euler.DEFAULT_ORDER = 'ZYX'`,
  'add a static': `Vector3.shared = {}`,
  'through the prototype of a live host object': `Object.getPrototypeOf(world.position).copy = function () { return this }`,
  'through the constructor of a live host object': `world.position.constructor.prototype.sub = function () { return this }`,
  'through a host matrix': `Object.getPrototypeOf(world.matrix).multiply = function () { return this }`,
  'a lerp class': `BufferedLerpVector3.prototype.update = function () { return this }`,
  'a curve': `Curve.prototype.evaluate = function () { return 1 }`,
  'a keyframe, reached through a curve': `Object.getPrototypeOf(new Curve().add({ time: 0, value: 0 }).keyframes[0]).set = function () { return this }`,
  'a method object itself': `Vector3.prototype.add.call = function () { return 42 }`,
  'a keyframe method object': `new Curve().add({ time: 0, value: 0 }).keyframes[0].set.shared = 1`,
  'the stock Vector3 the lerp classes use': `new LerpVector3(new Vector3(), 0.2).previous.constructor.prototype.add = function () { return this }`,
  'a color, reached through a material': `Object.getPrototypeOf(world.color).set = function () { return this }`,
  'the color class through its constructor': `world.color.constructor.prototype.copy = function () { return 'patched' }`,
  'the shared colour name table': `world.color.constructor.NAMES.red = 0x00ff00`,
}

for (const [name, code] of Object.entries(ATTACKS)) {
  test(`a script cannot change a shared class: ${name}`, () => {
    const host = {
      position: new m.THREE.Vector3(1, 2, 3),
      matrix: new m.THREE.Matrix4(),
      color: new m.THREE.Color('white'),
    }
    assert.throws(() => run(`'use strict'; ${code}`, host), TypeError)
    // the engine's view of the classes is unchanged
    assert.equal(new m.THREE.Vector3(1, 0, 0).add(new m.THREE.Vector3(1, 0, 0)).x, 2)
    assert.equal(new m.THREE.Vector3(5, 0, 0).x, 5)
    assert.equal('mailbox' in m.THREE.Vector3.prototype, false)
    assert.deepEqual([...new m.THREE.Vector3(1, 2, 3)], [1, 2, 3])
    assert.equal(m.THREE.Euler.DEFAULT_ORDER, 'XYZ')
    assert.equal(new m.THREE.Quaternion().multiply(new m.THREE.Quaternion()).w, 1)
    const q = new m.THREE.Quaternion()
    q.x = 0.5 // would throw 'hooked' if the inherited callback had been replaced
    assert.equal(new m.THREE.Matrix4().makeTranslation(1, 2, 3).multiply(new m.THREE.Matrix4()).elements[12], 1)
    assert.equal(new m.THREE.Color('red').getHex(), 0xff0000)
    assert.equal(new m.THREE.Color().copy(new m.THREE.Color('blue')).getHex(), 0x0000ff)
    assert.equal(new m.StockVector3(1, 0, 0).add(new m.StockVector3(1, 0, 0)).x, 2)
    assert.equal(new m.Keyframe().set({ time: 0.5, value: 2 }).value, 2)
    assert.equal(
      Function.prototype.call.call(m.THREE.Vector3.prototype.add, new m.THREE.Vector3(1), new m.THREE.Vector3(1)).x,
      2
    )
  })
}

// What the engine hands a script once things are mounted and running, beyond bare node proxies.
test('a material proxy gives out only frozen-class objects', () => {
  const stage = new m.Stage({ rig: new m.Object3D(), camera: new m.Object3D(), setupMaterial() {} })
  const material = stage.createMaterial()
  const color = run(`return world.color`, material.proxy)
  assert.equal(color instanceof m.THREE.Color, true)
  assert.equal(Object.isFrozen(Object.getPrototypeOf(color)), true)
  assert.throws(() => run(`'use strict'; Object.getPrototypeOf(world.color).set = () => {}`, material.proxy), TypeError)
  // the documented use still works
  run(`world.color = 'red'`, material.proxy)
  assert.equal(material.raw.color.getHex(), 0xff0000)
})

test('pointer callbacks get a new frozen event each time, and nothing of the engine through it', () => {
  globalThis.document = { body: { style: {} } }
  try {
    const seen = []
    const leaf = { parent: null, cursor: null }
    const root = { parent: null, cursor: null }
    leaf.parent = root
    const record = name => event => {
      seen.push({ name, event })
      // what a hostile callback tries
      for (const attempt of [
        () => (event.type = 'forged'),
        () => (event.stopPropagation = () => {}),
        () => (Object.getPrototypeOf(event).set = () => {}),
        () => (event.extra = 1),
      ]) {
        assert.throws(() => {
          'use strict'
          attempt()
        }, TypeError)
      }
    }
    leaf.onPointerEnter = record('leaf-enter')
    root.onPointerEnter = record('root-enter')
    leaf.onPointerDown = event => {
      seen.push({ name: 'leaf-down', event })
      event.stopPropagation()
    }
    root.onPointerDown = record('root-down')
    leaf.onPointerUp = record('leaf-up')
    leaf.onPointerLeave = record('leaf-leave')
    const state = new m.PointerState()
    state.update({ node: leaf }, false, false)
    state.update({ node: leaf }, true, false)
    state.update({ node: leaf }, false, true)
    state.update(null, false, false)
    assert.deepEqual(
      seen.map(entry => `${entry.name}:${entry.event.type}`),
      [
        'root-enter:pointerenter',
        'leaf-enter:pointerenter',
        'leaf-down:pointerdown',
        'leaf-up:pointerup',
        'leaf-leave:pointerleave',
      ]
    )
    // root never saw the press: the leaf stopped it. every call got its own plain, frozen object
    assert.equal(new Set(seen.map(entry => entry.event)).size, seen.length)
    for (const { event } of seen) {
      assert.equal(Object.isFrozen(event), true)
      assert.equal(Object.isFrozen(event.stopPropagation), true)
      assert.equal(Object.getPrototypeOf(event), Object.prototype)
      assert.deepEqual(Object.keys(event), ['type', 'stopPropagation'])
    }
  } finally {
    delete globalThis.document
  }
})

test('an XR pose reaches script-held objects as numbers, never as the browser object', () => {
  const point = { x: 1, y: 2, z: 3, w: 4, isDOMPoint: true }
  const received = []
  // a script that replaced the methods of a pose object it holds
  const position = new m.THREE.Vector3()
  position.copy = value => received.push(['copy', value])
  const set = position.set
  position.set = (...args) => {
    received.push(['set', ...args])
    return set.apply(position, args)
  }
  m.setVectorFromPoint(position, point)
  assert.deepEqual(received, [['set', 1, 2, 3]])
  assert.deepEqual([...position], [1, 2, 3])
  const quaternion = new m.THREE.Quaternion()
  quaternion.copy = value => received.push(['copy', value])
  m.setQuaternionFromPoint(quaternion, point)
  assert.deepEqual([quaternion.x, quaternion.y, quaternion.z, quaternion.w], [1, 2, 3, 4])
  assert.equal(
    received.some(entry => entry.includes(point)),
    false
  )
})

test('what one script leaves on a shared class cannot be seen by another, because it cannot be left', () => {
  assert.throws(() => run(`'use strict'; Vector3.prototype.note = 'from A'`), TypeError)
  assert.equal(run(`return new Vector3().note`), undefined)
  assert.equal(run(`return Object.isFrozen(Vector3) && Object.isFrozen(Vector3.prototype)`), true)
})

test('the internal temporaries of the math classes are instances of frozen classes', () => {
  // Matrix4.decompose hands its module-level matrix to whatever is passed as the quaternion
  const leaked = run(`
    let temp
    new Matrix4().decompose(new Vector3(), { setFromRotationMatrix(matrix) { temp = matrix } }, new Vector3())
    return temp
  `)
  assert.equal(leaked instanceof m.THREE.Matrix4, true)
  assert.equal(Object.isFrozen(Object.getPrototypeOf(leaked)), true)
  // Euler.reorder passes its temporary quaternion to the receiver's setFromQuaternion
  const quaternion = run(`
    let temp
    Euler.prototype.reorder.call({ _x: 0, _y: 0, _z: 0, _order: 'XYZ', setFromQuaternion(q) { temp = q } }, 'ZYX')
    return temp
  `)
  assert.equal(quaternion instanceof m.THREE.Quaternion, true)
  assert.equal(Object.isFrozen(Object.getPrototypeOf(quaternion)), true)
})

test('scripts use the classes as before', () => {
  const result = run(`
    let changes = 0
    const v = new Vector3(1, 2, 3).add(new Vector3(1, 1, 1)).multiplyScalar(2)
    v._onChange(() => changes++)
    v.x = 9
    const q = new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0))
    const m4 = new Matrix4().compose(v, q, new Vector3(1, 1, 1))
    const lerp = new BufferedLerpVector3(new Vector3(), 0.2)
    lerp.push(new Vector3(1, 0, 0))
    lerp.update(0.1)
    const curve = new Curve()
    curve.add({ time: 0, value: 0 })
    curve.add({ time: 1, value: 1 })
    // an instance may still carry its own data and even its own method
    v.tag = 'mine'
    v.toJSON = () => 'custom'
    return JSON.stringify({
      v: [...v], changes, qy: Math.round(q.y * 1000), tx: m4.elements[12], tag: v.tag, json: v.toJSON(),
      curve: typeof curve.evaluate(0.5),
    })
  `)
  assert.deepEqual(JSON.parse(result), {
    v: [9, 6, 8],
    changes: 1,
    qy: 707,
    tx: 9,
    tag: 'mine',
    json: 'custom',
    curve: 'number',
  })
})

test('the engine keeps working after hardening: THREE objects, change callbacks, instance overrides', () => {
  const { THREE } = m
  // every Object3D registers change callbacks on its rotation and quaternion while it is constructed
  const scene = new THREE.Scene()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
  const group = new THREE.Group()
  group.add(mesh)
  scene.add(group, new THREE.PerspectiveCamera(), new THREE.DirectionalLight(), new THREE.Bone(), new THREE.LOD())
  scene.add(new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
  scene.add(new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 2))
  mesh.rotation.set(0.1, 0.2, 0.3)
  assert.notEqual(mesh.quaternion.w, 1) // the rotation callback updated the quaternion
  mesh.quaternion.set(0, 0, 0, 1)
  assert.ok(Math.abs(mesh.rotation.x) < 1e-12)
  mesh.position.set(1, 2, 3)
  scene.updateMatrixWorld(true)
  assert.equal(mesh.matrixWorld.elements[12], 1)
  assert.equal(scene.clone(true).children.length, scene.children.length)
  assert.equal(new m.Object3D().up.y, 1)
  // our Vector3, THREE's own, and the flags their constructors write
  const ours = new THREE.Vector3(1, 2, 3)
  assert.equal(ours.isVector3 && ours.isVector3Enhanced, true)
  assert.equal(new m.StockVector3().isVector3, true)
  assert.equal(new THREE.Matrix4().isMatrix4, true)
  assert.equal(new m.Matrix3().isMatrix3, true)
  let changes = 0
  ours._onChange(() => changes++)
  ours.set(4, 5, 6)
  assert.equal(changes, 1)
  // an instance-level override on a math object does not throw and stays on that instance
  const q = new THREE.Quaternion()
  q.clone = () => 'own'
  assert.equal(q.clone(), 'own')
  assert.equal(new THREE.Quaternion().clone().w, 1)
})

test('every node type still constructs, clones and exposes its proxy', () => {
  for (const type of Object.keys(m.Nodes)) {
    const node = m.createNode(type, { id: `n-${type}` })
    assert.equal(typeof node.getProxy(), 'object', type)
    node.position.set(1, 2, 3)
    node.rotation.set(0.1, 0.2, 0.3)
    node.quaternion.set(0, 0, 0, 1)
    assert.ok(Math.abs(node.rotation.x) < 1e-12, `${type}: rotation follows quaternion`)
    assert.equal(node.clone(true).position.x, 1, type)
  }
  // an in-place edit of a ui offset marks the node for a rebuild (it used to overwrite the vector's _onChange method)
  const ui = m.createNode('ui', { id: 'ui' })
  ui.needsRebuild = false
  ui.offset.x = 5
  assert.equal(ui.needsRebuild, true)
  assert.equal(typeof ui.offset._onChange, 'function')
  const copy = ui.clone(true)
  assert.notEqual(copy.offset, ui.offset)
  assert.equal(copy.offset.x, 5)
})

// Everything a script can reach from its globals, from instances of the classes it is given and from node
// proxies must hang off frozen prototypes, and none of it may be a THREE scene object. What is shared between
// scripts (the globals and everything under them) must itself be frozen; an instance or a node proxy belongs to
// the script that made it and stays mutable.
test('reachability: no mutable shared prototype and no Object3D within reach of a script', () => {
  const seen = new Set()
  const problems = []
  const isObject = value => (typeof value === 'object' && value !== null) || typeof value === 'function'
  function visit(value, trail, depth, shared) {
    if (!isObject(value) || seen.has(value)) return
    seen.add(value)
    if (shared && !Object.isFrozen(value)) problems.push(`${trail}: shared and not frozen`)
    if (value.isObject3D) problems.push(`${trail}: an Object3D`)
    for (let proto = Object.getPrototypeOf(value); proto; proto = Object.getPrototypeOf(proto)) {
      if (!Object.isFrozen(proto)) {
        problems.push(`${trail}: prototype ${proto.constructor?.name ?? '?'} is not frozen`)
        break
      }
    }

    if (depth >= 5) return
    for (const key of Reflect.ownKeys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key)
      let child
      if ('value' in desc) child = desc.value
      else if (desc.get) {
        try {
          child = desc.get.call(value)
        } catch {
          continue // a getter that needs a mounted node
        }
      }
      visit(child, `${trail}.${String(key)}`, depth + 1, shared)
    }
  }
  const endowments = scripts.createEndowments()
  for (const [name, value] of Object.entries(endowments)) visit(value, name, 0, true)
  const { THREE } = m
  const instances = {
    Vector3: new THREE.Vector3(),
    Quaternion: new THREE.Quaternion(),
    Euler: new THREE.Euler(),
    Matrix4: new THREE.Matrix4(),
    LerpVector3: new endowments.LerpVector3(new THREE.Vector3(), 0.2),
    LerpQuaternion: new endowments.LerpQuaternion(new THREE.Quaternion(), 0.2),
    BufferedLerpVector3: new endowments.BufferedLerpVector3(new THREE.Vector3(), 0.2),
    BufferedLerpQuaternion: new endowments.BufferedLerpQuaternion(new THREE.Quaternion(), 0.2),
    Curve: new endowments.Curve().add({ time: 0, value: 0 }),
  }
  for (const [name, value] of Object.entries(instances)) visit(value, `new ${name}`, 0, false)
  for (const type of Object.keys(m.Nodes)) {
    visit(m.createNode(type, { id: `r-${type}` }).getProxy(), `node(${type})`, 0, false)
  }
  assert.deepEqual(problems, [])
  assert.ok(seen.size > 500, `walked ${seen.size} objects`)
})
