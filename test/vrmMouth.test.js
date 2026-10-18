import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { collectMouthBinds, createMouth } from '../src/core/extras/vrmMouth.js'

function morphMesh(name, targets = 2) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
  geometry.morphAttributes.position = Array.from(
    { length: targets },
    () => new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)
  )
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.name = name
  mesh.updateMorphTargets()
  return mesh
}

// a template like the factory's: a bone-ish group and two morph meshes
function template() {
  const scene = new THREE.Group()
  const root = new THREE.Group()
  root.name = 'Root'
  const face = morphMesh('Face', 3)
  const body = morphMesh('Body', 2)
  scene.add(root, face, body)
  return { scene, face, body }
}

const manager = expressions => ({ getExpression: name => (expressions[name] ? { binds: expressions[name] } : null) })
const influences = scene => {
  const out = {}
  scene.traverse(o => o.isMesh && (out[o.name] = [...o.morphTargetInfluences]))
  return out
}

test('mouth binds: first usable preset, by template traversal index', () => {
  const { scene, face, body } = template()
  // aa exists but has nothing usable, so oh drives the mouth
  const binds = collectMouthBinds(
    manager({
      aa: [{ primitives: [face], index: 9, weight: 1 }],
      oh: [{ primitives: [face, body], index: 1, weight: 0.8 }],
    }),
    scene
  )
  assert.deepEqual(binds, [
    { objectIndex: 2, morphIndex: 1, weight: 0.8 },
    { objectIndex: 3, morphIndex: 1, weight: 0.8 },
  ])
})

test('mouth binds: foreign meshes, bad indices, non-morph binds are skipped; duplicates sum and clamp', () => {
  const { scene, face } = template()
  const stranger = morphMesh('Stranger')
  const binds = collectMouthBinds(
    manager({
      aa: [
        { primitives: [stranger], index: 0, weight: 1 },
        { primitives: [face], index: -1, weight: 1 },
        { primitives: [face], index: 1.5, weight: 1 },
        { material: {}, type: 'color', targetValue: [1, 0, 0] },
        { primitives: [face], index: 2, weight: 0.7 },
        { primitives: [face], index: 2, weight: 0.6 },
        { primitives: [face], index: 0, weight: 0 },
      ],
    }),
    scene
  )
  assert.deepEqual(binds, [{ objectIndex: 2, morphIndex: 2, weight: 1 }])
})

test('mouth binds: no manager or no mouth expression gives a no-op mouth', () => {
  const { scene } = template()
  assert.deepEqual(collectMouthBinds(null, scene), [])
  assert.deepEqual(collectMouthBinds(manager({ blink: [] }), scene), [])
  const clone = scene.clone()
  const mouth = createMouth(clone, [])
  mouth.set(1)
  assert.deepEqual(influences(clone), { Face: [0, 0, 0], Body: [0, 0] })
})

test('mouth: writes only its own clone, by assignment; the template and other clones stay closed', () => {
  const { scene, face } = template()
  const binds = collectMouthBinds(manager({ aa: [{ primitives: [face], index: 1, weight: 0.5 }] }), scene)
  const a = scene.clone()
  const b = scene.clone()
  const mouthA = createMouth(a, binds)
  const mouthB = createMouth(b, binds)
  mouthA.set(1)
  mouthA.set(1)
  assert.deepEqual(influences(a).Face, [0, 0.5, 0])
  assert.deepEqual(influences(b).Face, [0, 0, 0])
  assert.deepEqual(influences(scene).Face, [0, 0, 0])
  mouthB.set(0.4)
  mouthA.set(0.2)
  assert.deepEqual(influences(a).Face, [0, 0.1, 0])
  assert.deepEqual(influences(b).Face, [0, 0.2, 0])
  mouthA.reset()
  assert.deepEqual(influences(a).Face, [0, 0, 0])
})

test('mouth: clamps and refuses non-finite values; unchanged values do not write', () => {
  const { scene, face } = template()
  const clone = scene.clone()
  const mouth = createMouth(
    clone,
    collectMouthBinds(manager({ aa: [{ primitives: [face], index: 0, weight: 1 }] }), scene)
  )
  const cloneFace = clone.getObjectByName('Face')
  mouth.set(5)
  assert.equal(cloneFace.morphTargetInfluences[0], 1)
  mouth.set(-2)
  assert.equal(cloneFace.morphTargetInfluences[0], 0)
  mouth.set(0.6)
  for (const bad of [NaN, Infinity, undefined, '1']) {
    mouth.set(bad)
    assert.equal(cloneFace.morphTargetInfluences[0], 0)
    mouth.set(0.6)
  }
  // an outside write survives a repeated identical value: no write happens
  cloneFace.morphTargetInfluences[0] = 0.25
  mouth.set(0.6)
  assert.equal(cloneFace.morphTargetInfluences[0], 0.25)
  mouth.dispose()
  mouth.set(1)
  assert.equal(cloneFace.morphTargetInfluences[0], 0.25)
})

test('mouth: a clone whose hierarchy changed after resolution keeps its resolved meshes', () => {
  // the factory resolves before removing the root bone; later hierarchy edits must not matter
  const { scene, face } = template()
  const binds = collectMouthBinds(manager({ aa: [{ primitives: [face], index: 2, weight: 1 }] }), scene)
  const clone = scene.clone()
  const mouth = createMouth(clone, binds)
  const root = clone.getObjectByName('Root')
  root.parent.remove(root)
  mouth.set(1)
  assert.deepEqual(influences(clone).Face, [0, 0, 1])
})
