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

const tick = () => new Promise(resolve => setImmediate(resolve))

// every mixer and action the real AnimationMixer hands out while a test runs
function recordMixers(t) {
  const { THREE } = m
  const record = { mixers: [], actions: [] }
  const clipAction = THREE.AnimationMixer.prototype.clipAction
  THREE.AnimationMixer.prototype.clipAction = function (clip, ...rest) {
    const action = clipAction.call(this, clip, ...rest)
    if (!record.mixers.includes(this)) record.mixers.push(this)
    record.actions.push({ name: clip.name, action })
    return action
  }
  t.after(() => (THREE.AnimationMixer.prototype.clipAction = clipAction))
  return record
}

const skinnedMeshOf = scene => {
  let mesh
  scene.traverse(node => {
    if (!mesh && node.isSkinnedMesh) mesh = node
  })
  return mesh
}

test('an avatar the engine cannot drive is refused while it loads, with the reason', () => {
  const { THREE } = m
  for (const bone of ['hips', 'head', 'leftUpperArm', 'rightUpperArm']) {
    assert.throws(() => m.createVRMFactory(makeVRM({ without: [bone] }), () => {}), new RegExp(`no ${bone} bone`))
  }
  assert.throws(() => m.createVRMFactory({ scene: new THREE.Group(), userData: {} }, () => {}), /not a VRM/)
  const noMesh = makeVRM()
  noMesh.scene.remove(noMesh.scene.children.find(child => child.isSkinnedMesh))
  assert.throws(() => m.createVRMFactory(noMesh, () => {}), /no skinned mesh/)
  // the skeleton the runtime drives (the first skinned mesh's) must be usable
  const broken = change => {
    const vrm = makeVRM()
    change(vrm, skinnedMeshOf(vrm.scene))
    return () => m.createVRMFactory(vrm, () => {})
  }
  assert.throws(
    broken((vrm, mesh) => (mesh.skeleton.bones = [])),
    /has no bones/
  )
  assert.throws(
    broken((vrm, mesh) => (mesh.skeleton = undefined)),
    /has no bones/
  )
  // a root bone without a parent, and a bone the scene does not hold (a clone would lose it)
  assert.throws(
    broken((vrm, mesh) => mesh.skeleton.bones.unshift(new THREE.Bone())),
    /not in the scene/
  )
  assert.throws(
    broken((vrm, mesh) => mesh.skeleton.bones.push(new THREE.Bone())),
    /not in the scene/
  )
  assert.throws(
    broken((vrm, mesh) => (mesh.skeleton.bones = [vrm.scene])),
    /root bone has no parent/
  )
  // the head is in the humanoid and the scene but only in a second mesh's skeleton: lookups use the first
  assert.throws(
    broken((vrm, mesh) => {
      const second = mesh.clone()
      second.bind(new THREE.Skeleton([...mesh.skeleton.bones]))
      mesh.bind(new THREE.Skeleton(mesh.skeleton.bones.filter(bone => bone.name !== 'J_head')))
      vrm.scene.add(second)
    }),
    /head bone is not in the skeleton/
  )
  // several skinned meshes with Skeleton objects of their own over the same bones (common in real VRMs) are fine,
  // as is a skinned mesh in a node the factory removes ('secondary') before it reads the skeleton
  const several = makeVRM()
  const first = skinnedMeshOf(several.scene)
  for (let i = 0; i < 3; i++) {
    const mesh = first.clone()
    mesh.bind(new THREE.Skeleton([...first.skeleton.bones]))
    several.scene.add(mesh)
  }
  const secondary = new THREE.Group()
  secondary.name = 'secondary'
  const stray = first.clone()
  stray.bind(new THREE.Skeleton([]))
  secondary.add(stray)
  several.scene.children.unshift(secondary)
  secondary.parent = several.scene
  const hooks = makeHooks([])
  const instance = m.createVRMFactory(several, () => {}).create(new THREE.Matrix4(), hooks, null)
  instance.destroy()
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

// an emote clip with real tracks on the test avatar's bones; the locomotion clips have none
const emoteClip = url => {
  const { THREE } = m
  return new THREE.AnimationClip(url, 1, [
    new THREE.QuaternionKeyframeTrack('J_head.quaternion', [0, 1], [0, 0, 0, 1, 0, 0.38, 0, 0.92]),
    new THREE.VectorKeyframeTrack('J_hips.position', [0, 1], [0, 0.3, 0, 0, 0.35, 0]),
  ])
}

test('emotes a remote player keeps sending are bounded: a dropped one leaves the mixer; a failed one is forgotten and reported', async t => {
  const warnings = silence(t)
  const { THREE } = m
  const record = recordMixers(t)
  const factory = m.createVRMFactory(makeVRM(), () => {})
  const loads = []
  const hooks = makeHooks(loads)
  const clips = new Map()
  hooks.loader.load = (type, url) => {
    loads.push(url)
    if (url.includes('bad')) return Promise.reject(new Error('broken file'))
    const clip = url.includes('emote.glb') ? emoteClip(url) : new THREE.AnimationClip(url, 1, [])
    clips.set(url, clip)
    return Promise.resolve({ toClip: () => clip })
  }
  const instance = factory.create(new THREE.Matrix4(), hooks, null)
  instance.disableRateCheck()
  await tick()
  const mixer = record.mixers[0]
  const locomotion = mixer.stats.actions.total
  assert.equal(locomotion, 13)
  const base = loads.length
  // each emote is loaded, mixed and playing (its tracks bound to the bones) before the next one replaces it, all
  // within one frame (a remote player cycling emotes the loader already holds), so each replaced one is still
  // fading out when it is dropped
  for (let i = 0; i < 200; i++) {
    instance.setEmote(`asset://emote.glb?s=${1 + i / 1000}`)
    await tick()
  }
  assert.equal(loads.length - base, 200)
  // what stays in the mixer: the locomotion actions and the 16 most recent emotes, with their binding references
  // (uncacheAction) and their fade interpolants (stop)
  const references = () => mixer._bindings.reduce((sum, binding) => sum + binding.referenceCount, 0)
  assert.equal(mixer.stats.actions.total, locomotion + 16)
  assert.equal(mixer.stats.bindings.total, 2)
  assert.equal(references(), 16 * 2)
  assert.ok(mixer.stats.controlInterpolants.inUse <= locomotion + 16, `${mixer.stats.controlInterpolants.inUse}`)
  assert.equal(mixer.existingAction(clips.get('asset://emote.glb?s=1')), null, 'the oldest left the mixer')
  assert.ok(mixer.existingAction(clips.get('asset://emote.glb?s=1.199')).isRunning(), 'the current one plays')
  instance.update(0.016)
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

test('emote and locomotion playback options: a finite speed in [0.01, 100] or 1; l and g are exact flags', async t => {
  silence(t)
  const { THREE } = m
  // every action the real mixer hands out, with the clip it was made for
  const { actions } = recordMixers(t)
  const hooks = makeHooks([])
  hooks.loader.load = async (type, url) => ({ toClip: () => new THREE.AnimationClip(url, 1, []) })
  const instance = m.createVRMFactory(makeVRM(), () => {}).create(new THREE.Matrix4(), hooks, null)
  await tick()
  // the head turns toward the gaze direction during an emote only when its url says g=1
  instance.disableRateCheck()
  instance.updateRate()
  instance.setLocomotion(0, new THREE.Vector3(), new THREE.Vector3(1, 0, 0))
  const head = skinnedMeshOf(instance.raw.scene).skeleton.getBoneByName('J_head')
  const identity = new THREE.Quaternion()
  const gazes = () => {
    head.quaternion.identity()
    instance.update(0.016)
    return !head.quaternion.equals(identity)
  }
  // with no emote the avatar looks where it is told
  instance.setEmote(null)
  assert.equal(gazes(), true, 'locomotion gazes')
  // the built-in locomotion clips carry their speed in the url (asset://mp-walk.glb?s=1.5)
  const walk = actions.find(entry => entry.name === 'asset://mp-walk.glb?s=1.5')
  assert.equal(walk.action.timeScale, 1.5)
  assert.equal(actions.find(entry => entry.name === 'asset://mp-idle.glb').action.timeScale, 1)
  for (const [speed, expected] of [
    [undefined, 1],
    ['', 1],
    ['NaN', 1],
    ['Infinity', 1],
    ['1e309', 1],
    ['-Infinity', 1],
    ['0', 1],
    ['-1', 1],
    ['0.009', 1],
    ['100.001', 1],
    ['0.01', 0.01],
    ['100', 100],
    ['2.5', 2.5],
  ]) {
    for (const [flags, loop, gaze] of [
      ['', true, false],
      ['&l=0&g=1', false, true],
      ['&l=false&g=true', true, false],
    ]) {
      const url = `asset://wave.glb?${speed === undefined ? '' : `s=${speed}`}${flags}`
      instance.setEmote(null)
      instance.setEmote(url)
      await tick()
      const { action } = actions.findLast(entry => entry.name === url)
      assert.equal(action.timeScale, expected, url)
      assert.equal(action.loop, loop ? THREE.LoopRepeat : THREE.LoopOnce, url)
      assert.equal(action.clampWhenFinished, !loop, url)
      assert.equal(gazes(), gaze, `${url}: gaze`)
    }
  }
  instance.destroy()
})

test('destroy(): clips that arrive afterwards are not mixed or played, and the mixer lets go of what it had', async t => {
  const warnings = silence(t)
  const { THREE } = m
  const record = recordMixers(t)
  const factory = m.createVRMFactory(makeVRM(), () => {})
  // every load waits until the test lets it finish
  const pending = []
  const hooks = makeHooks([])
  hooks.loader.load = (type, url) =>
    new Promise((resolve, reject) =>
      pending.push(fail => (fail ? reject(new Error('gone')) : resolve({ toClip: () => emoteClip(url) })))
    )
  const instance = factory.create(new THREE.Matrix4(), hooks, null)
  instance.setEmote('asset://wave.glb')
  assert.equal(pending.length, 14, '13 locomotion clips and the emote are loading')
  instance.destroy()
  instance.setEmote('asset://later.glb')
  assert.equal(pending.length, 14, 'a destroyed avatar loads nothing new')
  pending.forEach((finish, i) => finish(i === 0))
  await tick()
  assert.equal(record.actions.length, 0, 'nothing was mixed after destroy')
  assert.equal(warnings.length, 0, 'and nothing is reported for an avatar that is gone')
  // one destroyed after its clips arrived: actions, bindings and fade interpolants are released
  pending.length = 0
  const second = factory.create(new THREE.Matrix4(), hooks, null)
  second.setEmote('asset://wave.glb')
  pending.forEach(finish => finish())
  await tick()
  second.setEmote('asset://dance.glb')
  pending.at(-1)()
  await tick()
  const mixer = record.mixers.at(-1)
  assert.equal(mixer.stats.actions.total, 15)
  assert.ok(mixer.stats.bindings.total > 0 && mixer.stats.controlInterpolants.inUse > 0)
  second.destroy()
  assert.equal(mixer.stats.actions.total, 0)
  assert.equal(mixer.stats.actions.inUse, 0)
  assert.equal(mixer.stats.bindings.total, 0)
  assert.equal(mixer.stats.controlInterpolants.inUse, 0)
  second.destroy() // twice is harmless
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
