import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// the real lockdown config (ses must be imported first, as in src/server/index.js)
import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'
import { createSweep } from './lib/sweepWorld.mjs'

// A mesh a script makes (`app.create('mesh')`) has no material: a script cannot set one. Given a geometry, a linked one
// (the default) crashed its app in Stage.insertLinked (it read the uuid of the missing material). Here, through the
// script's handle in the sweep world (the real App, Apps, Stage and Mesh node): such a mesh is drawn with the stage's
// fallback material, a white standard one, and an app's material-less meshes of one geometry share one batch, apart
// from the batch of a mesh with a real material and from another app's (a script can recolour the material).
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

// the app's model (sweepWorld's default) has two linked meshes, 'first' and 'last', of one 1x1x1 box geometry and
// one white standard material: one batch of two
async function run(code, { isServer = false } = {}) {
  const env = sweep.makeWorld({ isServer })
  const { world } = env
  const app = sweep.addApp(world, code)
  await sweep.tick()
  // a frame: the dirty nodes are cleaned (a geometry set after the add remounts there), then the batches
  world.stage.clean()
  world.stage.update()
  return { world, app }
}

const batches = world =>
  [...world.stage.models.values()].map(model => ({
    model,
    count: model.items.length,
    drawn: model.iMesh.count,
    inScene: world.stage.scene.children.includes(model.iMesh),
  }))
// (objects are compared with assert.ok: a failing assert.equal would print the whole world graph)
const ofNode = (world, node) => [...world.stage.models.values()].find(model => model.items.some(i => i.node === node))
const singles = world => world.stage.scene.children.filter(object => object.isMesh && !object.isInstancedMesh)
const white = material => material.isMeshStandardMaterial && material.color.getHexString() === 'ffffff'

const TYPES = {
  box: {
    options: `type: 'box', width: 2, height: 3, depth: 4`,
    shape: g =>
      g.type === 'BoxGeometry' && g.parameters.width === 2 && g.parameters.height === 3 && g.parameters.depth === 4,
  },
  sphere: {
    options: `type: 'sphere', radius: 2`,
    shape: g => g.type === 'SphereGeometry' && g.parameters.radius === 2,
  },
  // the geometry given: the model's 1x1x1 box
  geometry: { options: `type: 'geometry'`, shape: g => g.type === 'BoxGeometry' && g.parameters.width === 1 },
}
const WAYS = {
  'in the create options': (options, linked) =>
    `app.add((app.state.n = app.create('mesh', { ${options}, linked: ${linked}, geometry: app.get('first').geometry })))`,
  'set after the add': (options, linked) =>
    `const n = (app.state.n = app.create('mesh', { ${options}, linked: ${linked} })); app.add(n); n.geometry = app.get('first').geometry`,
}

for (const [type, spec] of Object.entries(TYPES)) {
  for (const [way, code] of Object.entries(WAYS)) {
    for (const linked of [true, false]) {
      for (const isServer of [false, true]) {
        test(`a script's mesh (${type}, geometry ${way}, linked ${linked}, ${isServer ? 'server' : 'client'}) is drawn white; its app runs on`, async () => {
          const { world, app } = await run(code(spec.options, linked), { isServer })
          assert.equal(app.crashed, false, `the app did not crash: ${app.scriptError?.message}`)
          const node = m.getNodeRef(app.data.state.n)
          assert.ok(node.mounted && node.handle, 'the mesh is mounted and inserted')
          if (linked) {
            const model = ofNode(world, node)
            assert.ok(model, 'a linked instance')
            assert.ok(model !== ofNode(world, app.root.get('first')), "not in the model's batch")
            assert.ok(white(model.iMesh.material), 'the fallback material: white standard')
            assert.ok(spec.shape(model.geometry), `the ${type} drawn`)
            assert.deepEqual(
              batches(world).map(b => [b.count, b.drawn, b.inScene]),
              [
                [2, 2, true],
                [1, 1, true],
              ]
            )
            assert.equal(singles(world).length, 0)
          } else {
            const [mesh, ...rest] = singles(world)
            assert.equal(rest.length, 0, 'one mesh of its own')
            assert.ok(white(mesh.material), 'a white standard material')
            assert.ok(spec.shape(mesh.geometry), `the ${type} drawn`)
          }
          // the handle has a material, as any drawn mesh has: the white one
          assert.equal(app.data.state.n.material?.color?.getHexString(), 'ffffff')
        })
      }
    }
  }
}

test("two of a script's meshes of one geometry share one batch, apart from a real material's; one removed leaves the other", async () => {
  const { world, app } = await run(`
    const geometry = app.get('first').geometry
    app.state.a = app.create('mesh', { type: 'geometry', geometry })
    app.state.b = app.create('mesh', { type: 'geometry', geometry })
    app.add(app.state.a)
    app.add(app.state.b)
  `)
  assert.equal(app.crashed, false, app.scriptError?.message)
  const a = m.getNodeRef(app.data.state.a)
  const b = m.getNodeRef(app.data.state.b)
  const model = ofNode(world, a)
  assert.ok(ofNode(world, b) === model, 'one batch')
  assert.equal(model.items.length, 2)
  assert.equal(model.iMesh.count, 2)
  // the same geometry as the model's meshes, which have a material of their own: a batch of their own
  const own = ofNode(world, app.root.get('first'))
  assert.ok(own !== model, 'a batch of their own')
  assert.ok(own.iMesh.material !== model.iMesh.material, 'and a material of their own')
  assert.equal(own.items.length, 2)
  // one material for the batch: both handles read it
  assert.ok(a.handle.material === b.handle.material, 'one material')
  assert.equal(world.stage.scene.children.filter(object => object.isInstancedMesh).length, 2)
  // one removed: the other stays, drawn
  a.parent.remove(a)
  world.stage.clean()
  world.stage.update()
  assert.ok(a.handle === null, 'the removed one is out')
  assert.equal(model.items.length, 1)
  assert.ok(model.items[0].node === b, 'the other one stays')
  assert.equal(model.iMesh.count, 1)
  assert.ok(world.stage.scene.children.includes(model.iMesh))
  assert.ok(world.stage.models.get(model.id) === model, 'the batch stays')
})

test("a hidden script's mesh (visible false) with a geometry is in the octree, and a ray through it does not throw", async () => {
  const { world, app } = await run(`
    app.add((app.state.n = app.create('mesh', { type: 'box', visible: false, geometry: app.get('first').geometry })))
  `)
  assert.equal(app.crashed, false, app.scriptError?.message)
  const node = m.getNodeRef(app.data.state.n)
  assert.ok(node.sItem, 'in the octree only')
  const raycaster = new m.THREE.Raycaster(new m.THREE.Vector3(0, 0, 5), new m.THREE.Vector3(0, 0, -1))
  const hits = world.stage.octree.raycast(raycaster, [])
  assert.ok(
    hits.some(hit => hit.node === node),
    'the ray hits it'
  )
})

test("a script's boxes of one size share a batch, as do its spheres of one radius; another size or shadow flag is another batch", async () => {
  const { world, app } = await run(`
    const geometry = app.get('first').geometry
    for (const options of [
      { type: 'box', width: 2 },
      { type: 'box', width: 2 },
      { type: 'box', width: 3 },
      { type: 'sphere', radius: 2 },
      { type: 'sphere', radius: 2 },
      { type: 'box', width: 2, castShadow: false },
    ]) app.add(app.create('mesh', { ...options, geometry }))
  `)
  assert.equal(app.crashed, false, app.scriptError?.message)
  // the model's batch of two, then the boxes of width 2, the box of width 3, the spheres, the box of width 2 that casts no
  // shadow (other shadow flags: another batch, with a material of its own)
  assert.deepEqual(
    batches(world).map(b => b.count),
    [2, 2, 1, 2, 1]
  )
  const [, boxes, , , unshadowed] = batches(world)
  assert.ok(boxes.model.iMesh.material !== unshadowed.model.iMesh.material)
  assert.ok(
    batches(world)
      .slice(1)
      .every(b => white(b.model.iMesh.material))
  )
})

// two apps of one blueprint's model: each app's material-less boxes are a batch of their own with a material of their
// own, so app A's recolour through its handle never reaches app B; the model's meshes (a real material) are still one
// batch for both apps. A's batch and its material go once A is removed and the batch has been empty for the idle time.
test("a script's fallback material is its app's own: a recolour stays in the app; it goes with the app's batch", async () => {
  const env = sweep.makeWorld()
  const { world } = env
  const code = recolour => `
    const geometry = app.get('first').geometry
    app.state.m1 = app.create('mesh', { type: 'box', width: 2, geometry })
    app.state.m2 = app.create('mesh', { type: 'box', width: 2, geometry })
    app.add(app.state.m1)
    app.add(app.state.m2)
    ${recolour ? `app.state.m1.material.color = 'red'` : ''}
  `
  const a = sweep.addApp(world, code(true), 'a')
  const b = sweep.addApp(world, code(false), 'b')
  await sweep.tick()
  world.stage.clean()
  world.stage.update()
  assert.equal(a.crashed, false, a.scriptError?.message)
  assert.equal(b.crashed, false, b.scriptError?.message)
  const batchA = ofNode(world, m.getNodeRef(a.data.state.m1))
  const batchB = ofNode(world, m.getNodeRef(b.data.state.m1))
  assert.ok(ofNode(world, m.getNodeRef(a.data.state.m2)) === batchA, 'within app A one batch')
  assert.ok(ofNode(world, m.getNodeRef(b.data.state.m2)) === batchB, 'within app B one batch')
  assert.ok(batchA !== batchB, 'a batch per app')
  assert.ok(batchA.iMesh.material !== batchB.iMesh.material, 'a material per app')
  assert.equal(batchA.iMesh.material.color.getHexString(), 'ff0000', "A's recolour")
  assert.equal(batchB.iMesh.material.color.getHexString(), 'ffffff', "B's material is as it was")
  assert.equal(b.data.state.m2.material.color.getHexString(), 'ffffff', "B's handle reads white")
  assert.equal(batchB.iMesh.instanceColor, null, 'no instance colour in B')
  assert.deepEqual([batchA.items.length, batchB.items.length], [2, 2])
  // the model's own meshes, one real material: one batch for both apps, as before
  const modelBatch = ofNode(world, a.root.get('first'))
  assert.ok(ofNode(world, b.root.get('first')) === modelBatch, "the model's batch is shared")
  assert.equal(modelBatch.items.length, 4)
  // A removed: its batch empties, and goes with its material after the idle time; B's stays
  const idA = batchA.id
  const fallbackA = world.stage.linkedMaterials.get(idA)
  assert.ok(fallbackA?.raw === batchA.iMesh.material, "A's fallback is the batch's material")
  let disposed = 0
  fallbackA.raw.addEventListener('dispose', () => disposed++)
  a.destroy()
  world.time = 0
  world.stage.update()
  assert.equal(batchA.items.length, 0)
  assert.ok(world.stage.models.get(idA) === batchA, 'kept through the idle time')
  world.time = 11
  world.stage.update()
  assert.equal(world.stage.models.has(idA), false, "A's batch released")
  assert.equal(world.stage.linkedMaterials.has(idA), false, "A's fallback material released")
  assert.equal(disposed, 1, 'and disposed, once')
  assert.ok(world.stage.models.get(batchB.id) === batchB, "B's batch stays")
  assert.ok(world.stage.linkedMaterials.get(batchB.id)?.raw === batchB.iMesh.material, "B's material stays")
  assert.equal(batchB.items.length, 2)
  assert.ok(world.stage.scene.children.includes(batchB.iMesh))
  assert.equal(modelBatch.items.length, 2, "the model's batch keeps B's")
  b.destroy()
})
