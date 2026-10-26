import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { bundleRealPhysx, runRealPhysx } from './lib/realPhysx.mjs'

// Phase 3b-2b-2: Stage Models with no instances are released after a while, the materials they render with outlive
// them (so scripts' material proxies and their edits survive), the uber-shader hook is installed once, and prim
// geometry/material keys stay bounded. Uses a real Stage (the physics test world stubs it).
let bundle
before(async () => {
  bundle = await bundleRealPhysx()
})
after(() => bundle?.destroy())
const probe = (name, fn) => test(name, () => runRealPhysx(bundle, fn, undefined, { deadline: 120000 }))

probe(
  'stage: idle Models are released, kept materials and proxies outlive them, the uber hook is installed once',
  ({ B, world }) => {
    world.time = 0
    world.setupMaterial = () => {}
    const stage = new B.Stage(world)
    const geometry = new B.THREE.BoxGeometry(1, 1, 1)
    const material = new B.THREE.MeshStandardMaterial()
    const linked = (geo = geometry) =>
      stage.insertLinked({
        geometry: geo,
        material,
        uberShader: true,
        castShadow: true,
        receiveShadow: true,
        node: {},
        matrix: new B.THREE.Matrix4(),
      })
    const first = linked()
    const proxy = first.material
    proxy.color = 'red'
    const model = [...stage.models.values()][0]
    first.destroy()
    // a visible toggle or an LOD switch: back within the idle window keeps the Model
    world.time = 5
    stage.update()
    const again = linked()
    assert.equal([...stage.models.values()][0], model, 'the same Model is reused within the idle window')
    again.destroy()
    world.time = 6
    stage.update()
    // idle since 6
    world.time = 15
    stage.update()
    assert.equal(stage.models.size, 1, 'not yet: 9 s idle')
    world.time = 17
    stage.update()
    assert.equal(stage.models.size, 0, 'released after 10 s with no instances')
    // a rebuilt Model renders with the same material: the proxy and its edit survive
    const rebuilt = linked()
    assert.equal(rebuilt.material, proxy, 'the same material proxy')
    assert.equal(proxy.color.getHexString(), 'ff0000', 'the edit survives the rebuild')
    // the uber-shader hook declares the instance attributes once, however often the Model was rebuilt
    const raw = [...stage.linkedMaterials.values()][0].raw
    const shader = {
      vertexShader: '#include <color_pars_vertex>\n#include <color_vertex>',
      fragmentShader: '#include <color_pars_fragment>\nvec3 totalEmissiveRadiance = emissive;',
    }
    raw.onBeforeCompile(shader)
    assert.equal(shader.vertexShader.split('attribute vec3 instanceEmissive;').length - 1, 1)
    // geometry variants (a box Mesh whose width keeps changing) do not grow the kept materials past the limit; a small
    // limit stands in for the real 8192
    stage.linkedMaterialLimit = 16
    for (let i = 0; i < 100; i++) {
      linked(new B.THREE.BoxGeometry(1 + i, 1, 1)).destroy()
      world.time += 11
      stage.update()
      world.time += 11
      stage.update()
    }
    assert.ok(stage.linkedMaterials.size <= 16, `${stage.linkedMaterials.size} kept materials`)
    // past the limit with every Model alive: nothing in use is trimmed, the newest included
    for (let i = 0; i < 24; i++) linked(new B.THREE.BoxGeometry(1, 1 + i, 1))
    for (const live of stage.models.values()) {
      assert.ok(stage.linkedMaterials.has(live.id), 'every live Model keeps its material')
    }
    // an unlinked mesh disposes the material it cloned
    let disposed = 0
    const before = new Set(stage.scene.children)
    const single = stage.insertSingle({
      geometry,
      material,
      castShadow: false,
      receiveShadow: false,
      node: {},
      matrix: new B.THREE.Matrix4(),
    })
    const clone = stage.scene.children.find(child => !before.has(child))?.material
    assert.ok(clone && clone !== material, 'the unlinked mesh renders a clone')
    clone.addEventListener('dispose', () => disposed++)
    single.destroy()
    assert.equal(disposed, 1, 'the unlinked clone is disposed')
    // teardown disposes each kept material exactly once
    const disposals = new Map()
    for (const kept of stage.linkedMaterials.values()) {
      kept.raw.addEventListener('dispose', () => disposals.set(kept, (disposals.get(kept) ?? 0) + 1))
    }
    const keptCount = stage.linkedMaterials.size
    stage.destroy()
    assert.equal(disposals.size, keptCount, 'every kept material disposed at teardown')
    assert.ok(
      [...disposals.values()].every(count => count === 1),
      'exactly once'
    )
    assert.equal(stage.models.size, 0)
  }
)

probe('stage: prim geometry and material keys stay bounded', async ({ B, world, root }) => {
  world.time = 0
  world.setupMaterial = () => {}
  world.stage = new B.Stage(world)
  const keys = () => {
    const geometries = new Set()
    const materials = new Set()
    for (const id of world.stage.models.keys()) {
      const [geometry, material] = id.split('/')
      geometries.add(geometry)
      materials.add(material)
    }
    return { geometries: geometries.size, materials: materials.size }
  }
  // 1000 tapered cylinders with both radii and both signs varying, and 1000 tori with negative tubes
  for (let i = 0; i < 1000; i++) {
    const a = Math.sin(i * 12.9898) * 2
    const b = Math.cos(i * 78.233) * 2
    root.add(new B.Prim({ type: 'cylinder', size: [a, b, 1] }))
    root.add(new B.Prim({ type: 'torus', size: [1, -0.001 - (i % 997) * 0.37] }))
  }
  const shapes = keys()
  assert.ok(shapes.geometries <= 512 + 323, `${shapes.geometries} geometry keys`)
  assert.ok(shapes.geometries > 300, `the prims rendered (${shapes.geometries} geometry keys)`)
  // 2000 distinct metalness / roughness / opacity combinations
  for (let i = 0; i < 2000; i++) {
    root.add(
      new B.Prim({
        type: 'box',
        size: [1, 1, 1],
        metalness: (i % 97) / 97,
        roughness: (i % 89) / 89,
        opacity: 0.05 + ((i % 19) / 19) * 0.9,
      })
    )
  }
  const all = keys()
  assert.ok(all.materials <= 21 * 21 * 21 * 2, `${all.materials} material keys`)
  // untextured materials are a fixed palette: however many came first, a prim gets the metalness/roughness it asked
  // for (rounded to 0.05), so every process renders it the same
  const target = new B.Prim({ type: 'box', size: [1, 1, 1], metalness: 1, roughness: 1 })
  root.add(target)
  const model = [...world.stage.models.values()].find(m => m.items.some(item => item.node === target))
  assert.ok(model, 'the target prim rendered')
  assert.deepEqual([model.material.raw.metalness, model.material.raw.roughness], [1, 1])
  // only canonical primitives make keys: a boxed boolean is refused
  assert.throws(
    () => new B.Prim({ type: 'box', size: [1, 1, 1], doubleside: new Boolean(true) }),
    /doubleside must be boolean/
  )
  // textures are first come: at most 256 distinct texture strings get one
  world.loader = { get: () => new B.THREE.Texture(), load: async () => new B.THREE.Texture() }
  const textured = []
  for (let i = 0; i < 300; i++) {
    const prim = new B.Prim({ type: 'box', size: [1, 1, 1], texture: `asset://texture-${i}.png` })
    root.add(prim)
    textured.push(prim)
  }
  await new Promise(resolve => setTimeout(resolve, 50))
  let withMap = 0
  for (const m of world.stage.models.values()) {
    if (m.items.some(item => textured.includes(item.node)) && m.material.raw.map) withMap++
  }
  assert.ok(withMap <= 256 && withMap > 200, `${withMap} textured models`)
})
