import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// the real lockdown config (ses must be imported first, as in src/server/index.js)
import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'
import { createSweep } from './lib/sweepWorld.mjs'

// COMPAT-1, found in production: a script that set a property a material does not have (`material.opacity = …`, a
// portal fading its particles in its update handler) crashed its app. Until #47 a script's material was a plain
// object, where the write made a property nobody read; #47 made it a frozen object, where the write throws in a
// script (scripts are strict), so the update handler threw and the app was shown as the crash block. Now such a write
// is ignored and the app's console says so once per app run and property name; everything #47 established stays.
// Each test runs the script in a real compartment with the real Stage, Mesh node and material handle; the last one
// runs a script like the portal's in the sweep world (the real App, Apps, Stage and nodes).
let bundle
let m
let scripts
let sweep
const realDocument = globalThis.document

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
    export { createNode } from './src/core/extras/createNode'
    export { getNodeRef } from './src/core/nodes/refs'
    export { MATERIAL_REPORT_LIMIT } from './src/core/extras/scriptMaterial'
    export * as Nodes from './src/core/nodes'
    export * as THREE from './src/core/extras/three'
    export { Object3D } from 'three'
  `)
  m = await import(bundle.url)
  scripts = new m.Scripts({})
  sweep = createSweep({ m, scripts, requests: [] })
})

after(() => {
  globalThis.document = realDocument
  bundle?.destroy()
})

const run = (code, host) => scripts.evaluate(`'use strict'\n${code}`).exec(host)
const STOPPED = /\[app\] this app has stopped/

// the warnings the host writes while fn runs (the console object is frozen by lockdown; the global binding is not,
// so it is swapped for the call)
function warningsOf(fn) {
  const warnings = []
  const realConsole = globalThis.console
  globalThis.console = { ...realConsole, warn: (...args) => warnings.push(args.join(' ')) }
  try {
    fn()
  } finally {
    globalThis.console = realConsole
  }
  return warnings
}

// a world with the real Stage and apps whose mounted meshes use linked materials (proxyCopiesHardened.test.js)
function linkedMeshes() {
  const world = { rig: new m.Object3D(), camera: new m.Object3D(), setupMaterial() {} }
  world.stage = new m.Stage(world)
  const geometry = new m.THREE.BoxGeometry(1, 1, 1)
  const white = new m.THREE.MeshStandardMaterial({ color: 'white' })
  const app = id => ({ isApp: true, data: { id }, world, deadHook: { dead: false }, liveNodes: 0 })
  const mount = (entity, material = white) => {
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
  // the material the renderer draws with (the stage's clone of the model's)
  const rendered = () => [...world.stage.linkedMaterials.values()].map(material => material.raw)
  return { world, app, mount, end, rendered }
}

test('a write of a property a material does not have is ignored: nothing is stored, the material is as it was', () => {
  const { app, mount, rendered } = linkedMeshes()
  const a = app('a')
  const mesh = mount(a)
  const facade = mesh.material
  let result
  const warnings = warningsOf(() => {
    result = run(
      `
      const material = world.mesh.material
      const keys = Reflect.ownKeys(material)
      const proto = Object.getPrototypeOf(material)
      material.opacity = 0.25
      material.transparent = true
      material[Symbol.for('mine')] = 1
      material.zero = 0
      return {
        opacity: material.opacity,
        transparent: material.transparent,
        symbol: material[Symbol.for('mine')],
        has: 'opacity' in material || Object.hasOwn(material, 'opacity'),
        keys: Reflect.ownKeys(material).length === keys.length && Reflect.ownKeys(material).every((k, i) => k === keys[i]),
        proto: Object.getPrototypeOf(material) === proto,
        frozen: Object.isFrozen(material),
        color: material.color.getHexString(),
      }
    `,
      { mesh: mesh.getProxy() }
    )
  })
  assert.deepEqual(result, {
    opacity: undefined,
    transparent: undefined,
    symbol: undefined,
    has: false,
    keys: true,
    proto: true,
    frozen: true,
    color: 'ffffff',
  })
  // the write reached nothing of the host's: not the shared facade, not the material the renderer draws with
  assert.equal('opacity' in facade, false)
  assert.equal(Object.isFrozen(facade), true)
  for (const raw of rendered()) {
    assert.equal(raw.opacity, 1)
    assert.equal(raw.transparent, false)
  }
  assert.equal(warnings.length, 4, 'one warning per property name')
})

test("the app's console is told once per app run and property name, naming the property and what a material has", () => {
  const { app, mount, end } = linkedMeshes()
  const a = app('a')
  const b = app('b')
  const other = new m.THREE.MeshStandardMaterial({ color: 'red' })
  const first = mount(a)
  const second = mount(a, other)
  const write = (mesh, code) => run(code, { material: mesh.getProxy().material })
  const inRun = warningsOf(() => {
    write(first, `world.material.opacity = 0.1; world.material.opacity = 0.2; world.material.opacity = 0.3`)
    // another material of the same run: the same name is not told again, a new one is
    write(second, `world.material.opacity = 0.4; world.material.alpha = 1`)
  })
  assert.deepEqual(inRun, [
    '[material] opacity not set: a material has no such property (it has id, textureX, textureY, color, emissiveIntensity, fog)',
    '[material] alpha not set: a material has no such property (it has id, textureX, textureY, color, emissiveIntensity, fog)',
  ])
  // another app's run, and this app's next run, are told again
  const otherApp = warningsOf(() => write(mount(b), `world.material.opacity = 1`))
  assert.equal(otherApp.length, 1)
  end(a, [first, second])
  const nextRun = warningsOf(() => write(mount(a), `world.material.opacity = 1`))
  assert.equal(nextRun.length, 1)
  assert.match(nextRun[0], /^\[material\] opacity not set/)
  // a run that writes a new name every time says it a bounded number of times, then once that it goes on
  const many = warningsOf(() =>
    write(mount(b), `for (let i = 0; i < ${m.MATERIAL_REPORT_LIMIT + 20}; i++) world.material['p' + i] = i`)
  )
  // (b's run has told `opacity` already: the limit counts its names)
  assert.equal(many.length, m.MATERIAL_REPORT_LIMIT)
  assert.match(many.at(-1), /without a further warning/)
  // a long name is cut, a symbol is named
  const long = warningsOf(() =>
    write(mount(app('c')), `world.material['x'.repeat(500)] = 1; world.material[Symbol('s')] = 1`)
  )
  assert.equal(
    long[0],
    `[material] ${'x'.repeat(64)} not set: a material has no such property (it has id, textureX, textureY, color, emissiveIntensity, fog)`
  )
  assert.match(long[1], /^\[material\] Symbol\(s\) not set/)
})

test("a material's own accessors cannot be replaced, redefined or deleted; its prototype cannot be changed", () => {
  const { app, mount } = linkedMeshes()
  const mesh = mount(app('a'))
  let result
  const warnings = warningsOf(() => {
    result = run(
      `
    const material = world.mesh.material
    const proto = Object.getPrototypeOf(material)
    const attempts = {}
    for (const [name, attack] of Object.entries({
      redefine: () => Object.defineProperty(material, 'color', { get() { return 'poison' } }),
      define: () => Object.defineProperty(material, 'opacity', { value: 1 }),
      delete: () => { delete material.color },
      accessor: () => { Object.getOwnPropertyDescriptor(material, 'color').set.extra = 1 },
      setPrototypeOf: () => Object.setPrototypeOf(material, {}),
      protoWrite: () => { proto.opacity = 1 },
      protoDefine: () => Object.defineProperty(proto, 'opacity', { value: 1 }),
      protoSetPrototypeOf: () => Object.setPrototypeOf(proto, {}),
      protoOf: () => { material.__proto__ = {} },
    })) {
      try {
        attack()
        attempts[name] = 'allowed'
      } catch (err) {
        attempts[name] = err.name
      }
    }
    material.color = 'lime'
    return {
      attempts,
      proto: Object.getPrototypeOf(material) === proto,
      protoFrozen: Object.isFrozen(proto),
      protoHas: 'opacity' in proto,
      color: material.color.getHexString(),
      accessorFrozen: Object.isFrozen(Object.getOwnPropertyDescriptor(material, 'color').set),
    }
  `,
      { mesh: mesh.getProxy() }
    )
  })
  assert.deepEqual(warnings.length, 1, 'the ignored write of __proto__')
  assert.deepEqual(result.attempts, {
    redefine: 'TypeError',
    define: 'TypeError',
    delete: 'TypeError',
    accessor: 'TypeError',
    setPrototypeOf: 'TypeError',
    protoWrite: 'TypeError',
    protoDefine: 'TypeError',
    protoSetPrototypeOf: 'TypeError',
    // a write of `__proto__`, which the material does not have: ignored, as any other
    protoOf: 'allowed',
  })
  assert.equal(result.proto, true)
  assert.equal(result.protoFrozen, true)
  assert.equal(result.protoHas, false)
  assert.equal(result.accessorFrozen, true, 'what the script reaches through the material is hardened')
  assert.equal(result.color, '00ff00', 'the setters still act')
  assert.equal(mesh.material.color.getHexString(), '00ff00')
})

test('a write to a getter-only property still throws, as it did before #47', () => {
  const { app, mount } = linkedMeshes()
  const mesh = mount(app('a'))
  const id = mesh.material.id
  let warnings
  for (const code of [`world.mesh.material.id = 'mine'`, `world.mesh.material._ref = {}`]) {
    warnings = warningsOf(() =>
      assert.throws(() => run(code, { mesh: mesh.getProxy() }), /Cannot set property .* which has only a getter/, code)
    )
    assert.deepEqual(warnings, [], code)
  }
  assert.equal(run(`return world.mesh.material.id`, { mesh: mesh.getProxy() }), id)
})

test("once the app's run has ended, a kept material refuses every write; its own destroy handler still writes", () => {
  const { app, mount, end } = linkedMeshes()
  const a = app('a')
  const mesh = mount(a)
  const facade = mesh.material
  const host = { mesh: mesh.getProxy() }
  run(
    `
    const material = world.mesh.material
    world.destroy = () => { material.color = 'blue'; material.opacity = 0 }
    world.lateColor = () => { material.color = 'red' }
    world.lateUnknown = () => { material.opacity = 1 }
  `,
    host
  )
  // (the synchronous destroy handler runs inside the run)
  const during = warningsOf(() => host.destroy())
  assert.equal(during.length, 1)
  assert.equal(mesh.material.color.getHexString(), '0000ff')
  end(a, [mesh])
  const late = warningsOf(() => {
    assert.throws(() => host.lateColor(), STOPPED)
    assert.throws(() => host.lateUnknown(), STOPPED)
  })
  assert.deepEqual(late, [], 'a refused write is not reported as ignored')
  assert.equal(facade.color.getHexString(), '0000ff', 'the material is unchanged')
})

test('nothing a script writes on its material is visible to another app or to another run', () => {
  const { app, mount, end } = linkedMeshes()
  const a = app('a')
  const b = app('b')
  const meshA = mount(a)
  const meshB = mount(b)
  assert.equal(meshA.material, meshB.material, 'one linked material (one host facade) for both apps')
  warningsOf(() =>
    run(`world.material.opacity = 0.5; world.material.note = 'from A'`, { material: meshA.getProxy().material })
  )
  const read = mesh =>
    run(
      `const material = world.mesh.material
      return { opacity: material.opacity, note: material.note, protoNote: Object.getPrototypeOf(material).note }`,
      { mesh: mesh.getProxy() }
    )
  const nothing = { opacity: undefined, note: undefined, protoNote: undefined }
  assert.deepEqual(read(meshB), nothing, 'another app')
  assert.notEqual(meshB.getProxy().material, meshA.getProxy().material, "the other app's run has its own material")
  end(a, [meshA])
  const next = mount(a)
  assert.deepEqual(read(next), nothing, 'the next run')
  assert.deepEqual(read(meshB), nothing)
})

test("a script's own object that inherits from a material keeps what is written on it", () => {
  const { app, mount } = linkedMeshes()
  const mesh = mount(app('a'))
  let result
  const warnings = warningsOf(() => {
    result = run(
      `
      const material = world.mesh.material
      const mine = Object.create(material)
      mine.opacity = 0.5
      mine.color = 'red'
      return { own: Object.hasOwn(mine, 'opacity') && mine.opacity, material: material.opacity, color: material.color.getHexString() }
    `,
      { mesh: mesh.getProxy() }
    )
  })
  assert.deepEqual(result, { own: 0.5, material: undefined, color: 'ff0000' })
  assert.deepEqual(warnings, [])
})

test('a material is the same object for the same material within a run; a mesh still takes no material', () => {
  const { app, mount } = linkedMeshes()
  const a = app('a')
  const mesh = mount(a)
  const other = mount(a)
  const result = run(
    `
    const material = world.mesh.material
    let set
    try {
      world.mesh.material = material
      set = 'allowed'
    } catch (err) {
      set = err.message
    }
    return { same: material === world.mesh.material, shared: material === world.other.material, set }
  `,
    { mesh: mesh.getProxy(), other: other.getProxy() }
  )
  assert.deepEqual(result, { same: true, shared: true, set: '[mesh] set material not supported' })
})

test("a script like the portal's: particles cloned from a mesh, with fields of their own, fading their material every frame, keep running", async () => {
  const { world } = sweep.makeWorld({})
  const code = `
    const source = app.get('first')
    const particles = []
    for (let i = 0; i < 3; i++) {
      const particle = source.clone(true)
      // fields of the script's own, on the node's handle
      particle.velocity = new Vector3(0, 1 + i, 0)
      particle.age = 0
      particle.lifetime = 1 + i
      app.add(particle)
      particles.push(particle)
    }
    app.state.frames = 0
    app.on('update', delta => {
      app.state.frames++
      for (const particle of particles) {
        particle.age += delta
        particle.position.y += particle.velocity.y * delta
        const fade = Math.max(0, 1 - particle.age / particle.lifetime)
        particle.material.opacity = fade * 0.7
      }
      app.state.ages = particles.map(particle => particle.age)
      app.state.opacity = particles[0].material.opacity
    })
  `
  let app
  const warnings = []
  const realConsole = globalThis.console
  globalThis.console = { ...realConsole, warn: (...args) => warnings.push(args.join(' ')) }
  try {
    app = sweep.addApp(world, code)
    await sweep.tick()
    for (let i = 0; i < 120; i++) app.update(1 / 60)
    await sweep.tick()
  } finally {
    globalThis.console = realConsole
  }
  assert.equal(app.crashed, false, `the app runs: ${app.scriptError?.message}`)
  assert.equal(app.data.state.frames, 120)
  assert.ok(Math.abs(app.data.state.ages[0] - 2) < 1e-9, "the particles' own fields are kept on their handles")
  assert.equal(app.data.state.opacity, undefined, 'the material has no opacity')
  assert.deepEqual(warnings, [
    '[material] opacity not set: a material has no such property (it has id, textureX, textureY, color, emissiveIntensity, fog)',
  ])
})
