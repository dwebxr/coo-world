import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundleProbe } from './lib/workerProbe.mjs'

// The real avatar, emote and model helpers, bundled the way the client build does it, fed files that are
// legal-but-unusual or hostile. An avatar or model another user supplies is loaded by every client that sees it.
let bundle
let m

before(async () => {
  bundle = await bundleProbe(`
    export * as THREE from './src/core/extras/three'
    export { createVRMFactory } from './src/core/extras/createVRMFactory'
    export { createEmoteFactory } from './src/core/extras/createEmoteFactory'
    export { glbToNodes } from './src/core/extras/glbToNodes'
    export { getTrianglesFromGeometry } from './src/core/extras/getTrianglesFromGeometry'
  `)
  m = await import(bundle.url)
})

after(() => bundle?.destroy())

// a minimal VRM as three-vrm hands it over: a skinned mesh on a small skeleton and a humanoid that only lists
// the bones the file has
function makeVRM({ without = [] } = {}) {
  const { THREE } = m
  const names = ['hips', 'spine', 'neck', 'head', 'leftUpperArm', 'rightUpperArm'].filter(n => !without.includes(n))
  const bones = {}
  let parent = null
  const scene = new THREE.Group()
  for (const name of names) {
    const bone = new THREE.Bone()
    bone.name = `J_${name}`
    bone.position.y = 0.3
    if (parent && name !== 'leftUpperArm' && name !== 'rightUpperArm') parent.add(bone)
    else if (parent) bones.spine ? bones.spine.add(bone) : bones.hips.add(bone)
    else scene.add(bone)
    bones[name] = bone
    if (name !== 'leftUpperArm' && name !== 'rightUpperArm') parent = bone
  }
  const geometry = new THREE.BoxGeometry(0.4, 1.6, 0.2)
  const count = geometry.attributes.position.count
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(count * 4).fill(0.25), 4))
  geometry.computeBoundsTree = () => {}
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  scene.add(mesh)
  scene.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton(Object.values(bones)))
  const humanBones = Object.fromEntries(names.map(name => [name, { node: bones[name] }]))
  const humanoid = {
    humanBones,
    _rawHumanBones: { humanBones },
    _normalizedHumanBones: { humanBones },
    getRawBoneNode: name => humanBones[name]?.node ?? null,
    update() {},
  }
  return { scene, animations: [], userData: { vrm: { humanoid, meta: {}, expressionManager: null } } }
}

function makeHooks(loads) {
  const { THREE } = m
  const camera = new THREE.PerspectiveCamera()
  camera.updateMatrixWorld(true)
  return {
    scene: new THREE.Scene(),
    camera,
    octree: null,
    loader: {
      load(type, url) {
        loads.push(url)
        return Promise.reject(new Error('no such emote'))
      },
    },
  }
}

const silence = t => {
  const lines = []
  t.mock.method(console, 'warn', line => lines.push(String(line)))
  return lines
}

test('an avatar the engine cannot drive is refused while it loads, with the reason', () => {
  for (const bone of ['hips', 'head', 'leftUpperArm', 'rightUpperArm']) {
    assert.throws(() => m.createVRMFactory(makeVRM({ without: [bone] }), () => {}), new RegExp(`no ${bone} bone`))
  }
  assert.throws(() => m.createVRMFactory({ scene: new m.THREE.Group(), userData: {} }, () => {}), /not a VRM/)
  const noMesh = makeVRM()
  noMesh.scene.remove(noMesh.scene.children.find(child => child.isSkinnedMesh))
  assert.throws(() => m.createVRMFactory(noMesh, () => {}), /no skinned mesh/)
})

test('an avatar without a neck bone (optional in VRM 1.0) updates every frame without throwing', async t => {
  const warnings = silence(t)
  const { THREE } = m
  const factory = m.createVRMFactory(makeVRM({ without: ['neck'] }), () => {})
  const loads = []
  const instance = factory.create(new THREE.Matrix4(), makeHooks(loads), null)
  await new Promise(resolve => setImmediate(resolve)) // the locomotion clips fail to load: reported, not thrown
  instance.setLocomotion(0, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1))
  instance.updateRate?.()
  for (let frame = 0; frame < 5; frame++) instance.update(0.016)
  // first person hides the head when there is no neck, and can be switched back
  instance.setFirstPerson(true)
  instance.setFirstPerson(false)
  // a bone name from a script that is not a bone, or not even a string
  for (const name of ['constructor', '__proto__', 'toString', 'nope', undefined, 5]) {
    assert.equal(instance.getBoneTransform(name), null, String(name))
  }
  assert.ok(instance.getBoneTransform('head'))
  assert.ok(warnings.every(line => line.startsWith('[avatar] locomotion clip failed')))
  instance.destroy()
})

test('emotes a remote player keeps sending are bounded, and a failed one is forgotten and reported', async t => {
  const warnings = silence(t)
  const { THREE } = m
  const factory = m.createVRMFactory(makeVRM(), () => {})
  const loads = []
  const hooks = makeHooks(loads)
  const loaded = new Map()
  hooks.loader.load = (type, url) => {
    loads.push(url)
    if (url.includes('bad')) return Promise.reject(new Error('broken file'))
    const clip = new THREE.AnimationClip(url, 1, [])
    const promise = Promise.resolve({ toClip: () => clip })
    loaded.set(url, clip)
    return promise
  }
  const instance = factory.create(new THREE.Matrix4(), hooks, null)
  await new Promise(resolve => setImmediate(resolve))
  const base = loads.length
  for (let i = 0; i < 200; i++) instance.setEmote(`asset://emote.glb?s=${1 + i / 1000}`)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loads.length - base, 200)
  // only the most recent few stay mixed: asking for an old one loads it again, a recent one does not
  instance.setEmote('asset://emote.glb?s=1.199')
  instance.setEmote('asset://emote.glb?s=1.198')
  assert.equal(loads.length - base, 200, 'recent emotes are still held')
  instance.setEmote('asset://emote.glb?s=1')
  assert.equal(loads.length - base, 201, 'the oldest was dropped')
  // a broken emote: reported, and the next request tries again
  instance.setEmote('asset://bad.glb')
  await new Promise(resolve => setImmediate(resolve))
  instance.setEmote(null)
  instance.setEmote('asset://bad.glb')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loads.filter(url => url === 'asset://bad.glb').length, 2)
  assert.equal(warnings.filter(line => line.startsWith('[avatar] emote failed: broken file')).length, 2)
  // a url that does not parse has no options and does not throw
  instance.setEmote('not a url ?s=2')
  instance.update(0.016)
  instance.destroy()
})

test('an emote file without an animation or a scene root is a failed load, and odd tracks are tolerated', () => {
  const { THREE } = m
  assert.throws(() => m.createEmoteFactory({ animations: [], scene: new THREE.Group() }, 'x'), /no animation/)
  assert.throws(() => m.createEmoteFactory({ scene: new THREE.Group() }, 'x'), /no animation/)
  const clipOnly = new THREE.AnimationClip('a', 1, [])
  assert.throws(() => m.createEmoteFactory({ animations: [clipOnly], scene: new THREE.Group() }, 'x'), /no scene root/)
  // a track naming a node the file does not have, and one on the scene root
  const scene = new THREE.Group()
  const armature = new THREE.Group()
  armature.name = 'Armature'
  scene.add(armature)
  const hips = new THREE.Bone()
  hips.name = 'mixamorigHips'
  armature.add(hips)
  const clip = new THREE.AnimationClip('walk', 1, [
    new THREE.QuaternionKeyframeTrack('mixamorigHips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new THREE.QuaternionKeyframeTrack('Missing.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new THREE.QuaternionKeyframeTrack('Armature.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ])
  const factory = m.createEmoteFactory({ animations: [clip], scene }, 'x')
  assert.ok(factory.toClip({ rootToHips: 1, version: '1', getBoneName: () => 'hips' }))
})

test('a model with a wind material and no position bounds compiles its shader instead of throwing every frame', () => {
  const { THREE } = m
  const geometry = new THREE.BoxGeometry(1, 2, 1)
  geometry.boundingBox = null // what the loader leaves when the file gives no POSITION min/max
  const material = new THREE.MeshStandardMaterial()
  material.userData.wind = true
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'grass'
  const scene = new THREE.Group()
  scene.add(mesh)
  const uniform = { value: 0 }
  const world = {
    wind: {
      uniforms: {
        time: uniform,
        strength: uniform,
        direction: uniform,
        speed: uniform,
        noiseScale: uniform,
        ampScale: uniform,
        freqMultiplier: uniform,
      },
    },
  }
  m.glbToNodes({ scene }, world)
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '' }
  assert.doesNotThrow(() => material.onBeforeCompile(shader))
  assert.equal(shader.uniforms.height.value, 1) // half of the 2 m box
  // geometry with no positions at all
  const empty = new THREE.BufferGeometry()
  assert.equal(m.getTrianglesFromGeometry(empty), 0)
  assert.equal(m.getTrianglesFromGeometry(null), 0)
  assert.equal(m.getTrianglesFromGeometry(new THREE.BoxGeometry()), 12)
})
