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
const probe = (name, fn) => test(name, () => runRealPhysx(bundle, fn, undefined, { deadline: 60000 }))

probe(
  'stage: an idle Model is released after 10 s, its material and proxy outlive it, the uber hook is installed once',
  ({ B, world }) => {
    world.time = 0
    world.setupMaterial = () => {}
    const stage = new B.Stage(world)
    const geometry = new B.THREE.BoxGeometry(1, 1, 1)
    const material = new B.THREE.MeshStandardMaterial()
    const insert = () =>
      stage.insertLinked({
        geometry,
        material,
        uberShader: true,
        castShadow: true,
        receiveShadow: true,
        node: {},
        matrix: new B.THREE.Matrix4(),
      })
    const first = insert()
    const proxy = first.material
    proxy.color = 'red'
    const model = [...stage.models.values()][0]
    first.destroy()
    // a visible toggle or an LOD switch: back within the idle window keeps the Model
    world.time = 5
    stage.update()
    const again = insert()
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
    const rebuilt = insert()
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
    // geometry variants (a box Mesh whose width keeps changing) do not grow the kept materials past the limit
    for (let i = 0; i < 3000; i++) {
      const handle = stage.insertLinked({
        geometry: new B.THREE.BoxGeometry(1 + i, 1, 1),
        material,
        uberShader: true,
        castShadow: true,
        receiveShadow: true,
        node: {},
        matrix: new B.THREE.Matrix4(),
      })
      handle.destroy()
      world.time += 11
      stage.update()
      world.time += 11
      stage.update()
    }
    assert.ok(stage.linkedMaterials.size <= 2048, `${stage.linkedMaterials.size} kept materials`)
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
  }
)

probe('stage: prim geometry and material keys stay bounded', ({ B, world, root }) => {
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
})
