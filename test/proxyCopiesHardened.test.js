import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// the real lockdown config (ses must be imported first, as in src/server/index.js)
import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'

// Review finding 5: the player proxy and the raycast hand out fresh copies, but a copy was made by calling a
// prototype method a script could replace (`Vector3.prototype.copy`), which then received the host's live object.
// With the script classes hardened (Scripts hardens them when it is constructed), check inside a real compartment
// that no replacement can be installed and that a fresh copy cannot have been prepared beforehand.
let bundle
let m
let scripts

before(async () => {
  bundle = await bundleProbe(`
    export { Scripts } from './src/core/systems/Scripts'
    export * as THREE from './src/core/extras/three'
    export { createPlayerProxy } from './src/core/extras/createPlayerProxy'
    export { Apps } from './src/core/systems/Apps'
    export { Stage } from './src/core/systems/Stage'
    export { createNode } from './src/core/extras/createNode'
    export { callEntry, callScript } from './src/core/extras/callScript'
    export { Object3D } from 'three'
  `)
  m = await import(bundle.url)
  scripts = new m.Scripts({})
})

after(() => bundle?.destroy())

const run = (code, host) => scripts.evaluate(code).exec(host)

function host() {
  const base = {
    position: new m.THREE.Vector3(1, 2, 3),
    quaternion: new m.THREE.Quaternion(0, 0, 0, 1),
    rotation: new m.THREE.Euler(0, 0, 0, 'YXZ'),
  }
  const head = new m.THREE.Matrix4().makeTranslation(0, 1.6, 0)
  const player = {
    world: { network: { isServer: false, isClient: true, id: 'me' } },
    data: { id: 'p', owner: 'me' },
    base,
    avatar: { getBoneTransform: () => head },
  }
  const entity = { deadHook: { dead: false } }
  const hit = { point: new m.THREE.Vector3(4, 5, 6), normal: new m.THREE.Vector3(0, 1, 0), distance: 1, handle: {} }
  const apps = new m.Apps({ network: {}, events: {}, physics: { raycast: () => hit } })
  const world = {
    player: m.createPlayerProxy(entity, player),
    raycast: () => apps.worldMethods.raycast({}, new m.THREE.Vector3(), new m.THREE.Vector3(0, -1, 0)),
    leaked: [],
  }
  return { world, base, head, hit }
}

const PROTOTYPE_ATTACKS = [
  `Vector3.prototype.copy = function (v) { world.leaked.push(v); return this }`,
  `Quaternion.prototype.copy = function (v) { world.leaked.push(v); return this }`,
  `Euler.prototype.copy = function (v) { world.leaked.push(v); return this }`,
  `Matrix4.prototype.copy = function (m) { world.leaked.push(m); return this }`,
  `Object.getPrototypeOf(world.player.position).copy = function (v) { world.leaked.push(v); return this }`,
  `world.player.position.constructor.prototype.copy = function (v) { world.leaked.push(v); return this }`,
  `Object.getPrototypeOf(world.player.getBoneTransform('head')).copy = function (m) { world.leaked.push(m); return this }`,
  `Object.defineProperty(Vector3.prototype, 'x', { set(v) { world.leaked.push(v) } })`,
]

for (const code of PROTOTYPE_ATTACKS) {
  test(`a script cannot install a copy hook on a shared class: ${code.slice(0, 60)}`, () => {
    const { world, base, head } = host()
    assert.throws(() => run(`'use strict'; ${code}`, world), TypeError)
    // the next copies are made by the frozen class methods: nothing reaches the script
    run(
      `world.player.position; world.player.quaternion; world.player.rotation; world.player.getBoneTransform('head'); world.raycast()`,
      world
    )
    assert.deepEqual(world.leaked, [])
    assert.deepEqual(base.position.toArray(), [1, 2, 3])
    assert.equal(head.elements[13], 1.6)
  })
}

test('a fresh copy cannot have been prepared: per-object hooks stay on the object the script already had', () => {
  const { world, base, hit } = host()
  const result = run(
    `
    const first = world.player.position
    first.copy = v => { world.leaked.push(v); return first }
    first.set = v => { world.leaked.push(v); return first }
    const matrix = world.player.getBoneTransform('head')
    matrix.copy = m => { world.leaked.push(m); return matrix }
    const hit = world.raycast()
    hit.point.copy = v => { world.leaked.push(v); return hit.point }
    const second = world.player.position
    const again = world.raycast()
    return {
      distinct: first !== second && matrix !== world.player.getBoneTransform('head') && hit.point !== again.point,
      ownKeys: Object.keys(second).filter(key => !['x', 'y', 'z'].includes(key) && typeof second[key] === 'function'),
      protoFrozen: Object.isFrozen(Object.getPrototypeOf(second)),
      values: [second.x, second.y, second.z, again.point.x],
    }
  `,
    world
  )
  assert.equal(result.distinct, true)
  assert.deepEqual(result.ownKeys, [], 'a new object carries no script method')
  assert.equal(result.protoFrozen, true)
  assert.deepEqual(result.values, [1, 2, 3, 4])
  assert.deepEqual(world.leaked, [], 'no host object reached a script function')
  assert.deepEqual(base.position.toArray(), [1, 2, 3])
  assert.deepEqual(hit.point.toArray(), [4, 5, 6])
})

test("a material's color is a copy: the renderer's own Color stays out of reach; setters take primitives only", () => {
  const stage = new m.Stage({ rig: new m.Object3D(), camera: new m.Object3D(), setupMaterial() {} })
  const material = stage.createMaterial()
  material.raw.color.set('#336699')
  const result = run(
    `
    const a = world.color
    const b = world.color
    Object.defineProperty(a, 'r', { get() { throw new Error('render poison') } })
    a.g = 99
    return { distinct: a !== b, hex: b.getHexString(), r: b.r }
  `,
    material.proxy
  )
  assert.equal(result.distinct, true)
  assert.equal(result.hex, '336699')
  assert.ok(Math.abs(result.r - material.raw.color.r) < 1e-12)
  // the renderer's colour is untouched and readable
  assert.equal(material.raw.color.getHexString(), '336699')
  const r = Object.getOwnPropertyDescriptor(material.raw.color, 'r')
  assert.equal(r.get, undefined, 'still a plain number, no accessor')
  assert.equal(typeof r.value, 'number')
  // the documented way to change it still works
  run(`world.color = 'red'`, material.proxy)
  assert.equal(material.raw.color.getHex(), 0xff0000)
  // hostile values never reach the renderer
  for (const code of [
    `world.color = new String('blue')`,
    `world.color = { toString() { return 'blue' } }`,
    `world.textureX = Object.defineProperty(new Number(1), 'valueOf', { value() { throw new Error('poison') } })`,
    `world.textureY = NaN`,
    `world.emissiveIntensity = new Number(2)`,
    `world.emissiveIntensity = Infinity`,
    `world.fog = 'yes'`,
  ]) {
    assert.throws(() => run(code, material.proxy), /must be a string|not a number|not a boolean/, code)
  }
  assert.equal(material.raw.color.getHex(), 0xff0000)
  run(`world.textureX = 0.5; world.emissiveIntensity = 2; world.fog = false`, material.proxy)
  assert.equal(material.raw.emissiveIntensity, 2)
  assert.equal(material.raw.fog, false)
})

// a world with the real Stage and two apps, each with a mounted mesh of the same linked material
function linkedMeshes() {
  const world = { rig: new m.Object3D(), camera: new m.Object3D(), setupMaterial() {} }
  world.stage = new m.Stage(world)
  const geometry = new m.THREE.BoxGeometry(1, 1, 1)
  const material = new m.THREE.MeshStandardMaterial({ color: 'white' })
  const app = id => ({ isApp: true, data: { id }, world, deadHook: { dead: false }, liveNodes: 0 })
  const mount = entity => {
    const node = m.createNode('mesh', { type: 'geometry', geometry, material, linked: true })
    node.activate({ world, entity, run: entity.deadHook })
    return node
  }
  // what App.unbuild does to the run: its nodes unmount, then the run's hook is replaced
  const end = (entity, nodes) => {
    for (const node of nodes) node.deactivate()
    entity.deadHook.dead = true
    entity.deadHook = { dead: false }
  }
  return { app, mount, end }
}

test("a mesh's material belongs to its app run: kept past the app's teardown it cannot change a shared material", () => {
  const { app, mount, end } = linkedMeshes()
  const a = app('a')
  const b = app('b')
  const meshA = mount(a)
  const meshA2 = mount(a)
  const meshB = mount(b)
  assert.equal(meshA.material, meshB.material, 'one linked material (and host facade) for both apps')
  const host = { mesh: meshA.getProxy(), other: meshA2.getProxy() }
  const result = run(
    `'use strict'
    const material = world.mesh.material
    const attempts = []
    for (const attack of [
      () => Object.defineProperty(material, 'color', { get() { return 'poison' } }),
      () => { material.extra = 1 },
      () => { delete material.color },
      () => { Object.getOwnPropertyDescriptor(material, 'color').set.extra = 1 },
      () => Object.setPrototypeOf(material, {}),
    ]) {
      try {
        attack()
        attempts.push('allowed')
      } catch (err) {
        attempts.push(err.name)
      }
    }
    // kept: called from a late promise after the app is gone
    world.late = () => { material.color = 'red' }
    world.destroy = () => { material.color = 'blue' }
    world.material = material
    return {
      same: material === world.mesh.material,
      sameMaterial: material === world.other.material,
      frozen: Object.isFrozen(material),
      attempts,
    }
  `,
    host
  )
  assert.equal(result.same, true, 'the same object within the run')
  assert.equal(result.sameMaterial, true, 'and for another mesh of the run with that material')
  assert.equal(result.frozen, true)
  assert.deepEqual(result.attempts, ['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError'])
  assert.notEqual(meshB.getProxy().material, host.material, "the other app's run gets its own")
  // the app's own (synchronous) destroy handler still runs inside its run
  host.destroy()
  assert.equal(meshB.material.color.getHex(), 0x0000ff)
  end(a, [meshA, meshA2])
  assert.throws(() => host.late(), /this app has stopped/)
  assert.equal(meshB.material.color.getHex(), 0x0000ff, "the other app's material is unchanged")
  // reading still answers
  assert.equal(run(`return world.material.color.getHex()`, host), 0x0000ff)
  // the other app's run still writes
  run(`world.mesh.material.color = 'lime'`, { mesh: meshB.getProxy() })
  assert.equal(meshB.material.color.getHexString(), '00ff00')
})

test("a video's material is bound to its app run the same way", () => {
  const entity = { isApp: true, data: { id: 'v' }, deadHook: { dead: false } }
  const video = m.createNode('video')
  // what mounting gives it: its app run and its own mesh
  const offset = new m.THREE.Vector2()
  video.ctx = { entity, run: entity.deadHook }
  video.mesh = { material: { uniforms: { uOffset: { value: offset } } } }
  const host = { video: video.getProxy() }
  const result = run(
    `'use strict'
    const material = world.video.material
    world.material = material
    material.textureX = 0.25
    let redefined = 'allowed'
    try {
      Object.defineProperty(material, 'textureX', { set() {} })
    } catch (err) {
      redefined = err.name
    }
    return { same: material === world.video.material, frozen: Object.isFrozen(material), redefined }
  `,
    host
  )
  assert.deepEqual(result, { same: true, frozen: true, redefined: 'TypeError' })
  assert.equal(offset.x, 0.25)
  entity.deadHook.dead = true
  entity.deadHook = { dead: false }
  assert.throws(() => run(`world.material.textureY = 0.5`, host), /this app has stopped/)
  assert.equal(offset.y, 0)
  assert.equal(run(`return world.material.textureX`, host), 0.25)
})

test('callbacks: a call or apply a script defines on its function is never what the engine invokes', () => {
  const host = { effects: [] }
  run(
    `'use strict'
    const seen = []
    const fn = function (x) {
      seen.push(['real', this === undefined, x])
    }
    // assignment over the frozen Function.prototype.call throws under lockdown; a definition does not
    Object.defineProperty(fn, 'call', { value: () => seen.push('replaced call') })
    Object.defineProperty(fn, 'apply', { value: () => seen.push('replaced apply') })
    const entry = { onPress() { seen.push(['entry', this === entry]) } }
    Object.defineProperty(entry.onPress, 'call', { value: () => seen.push('replaced call') })
    world.fn = fn
    world.entry = entry
    world.seen = seen
  `,
    host
  )
  m.callScript(host.fn, 1)
  m.callEntry(host.entry, 'onPress')
  // an effect's onEnd, called by the player handle when the effect ends
  const player = {
    world: { network: { isServer: false, isClient: true, id: 'me', send() {} } },
    data: { id: 'me', owner: 'me' },
    setEffect: (effect, onEnd) => (host.onEnd = onEnd),
  }
  const entity = { deadHook: { dead: false } }
  const proxy = m.createPlayerProxy(entity, player)
  proxy.applyEffect({ freeze: true, duration: 1, onEnd: host.fn })
  host.onEnd()
  assert.deepEqual(host.seen, [
    ['real', true, 1],
    ['entry', true],
    ['real', true, undefined],
  ])
})
