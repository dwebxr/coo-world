import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import v8 from 'node:v8'
import vm from 'node:vm'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { Object3D, SkinnedMesh, Texture } from 'three'
import {
  checkGLTF,
  createGLTFBudget,
  GLTF_LIMITS,
  GLTFLimitError,
  jsonCopyBytes,
} from '../src/core/extras/gltfLimits.js'
import { png, jpeg } from './lib/imageBytes.mjs'
import { glb } from './lib/glb.mjs'

// The vendored GLTFLoader with a per-file budget: the limits are charged where the parser allocates, copies,
// clones or creates objects, and where it is about to decode an image (its COO_BUDGET sites). Each probe drives the
// real parser (the structure check before it is not run here) and records every charge: the refusal must come at
// the charge made just before the allocation that passes the limit, and nothing is charged after it.
const MiB = 1024 * 1024
const globals = {}
let decoded = 0

before(() => {
  for (const name of ['self', 'createImageBitmap', 'ProgressEvent']) globals[name] = globalThis[name]
  globalThis.self = globalThis // the parser reads self.URL
  // Node has no image decoder: a decode is counted and reports a small size
  globalThis.createImageBitmap = async () => {
    decoded++
    return { width: 64, height: 64, close() {} }
  }
  globalThis.ProgressEvent ??= class extends Event {
    constructor(type, init) {
      super(type)
      Object.assign(this, init)
    }
  }
})

after(() => {
  for (const [name, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[name]
    else globalThis[name] = value
  }
})

// parses with a budget that records each charge; resolves to { gltf, budget, charges } or rejects with the error
// (which carries the charges)
async function parse(file, { limits = GLTF_LIMITS, vrm = false, check = false } = {}) {
  const charges = []
  const budget = createGLTFBudget({
    fileBytes: file.byteLength,
    limits,
    onCharge: (kind, n, what, total) => charges.push({ kind, n, what, total }),
  })
  // `check`: as the client loads a file, the check first, charged to the same budget
  if (check) checkGLTF(file, limits, budget)
  const loader = new GLTFLoader()
  if (vrm) loader.register(parser => new VRMLoaderPlugin(parser))
  try {
    const gltf = await loader.parseAsync(file, '', budget)
    return { gltf, budget, charges }
  } catch (err) {
    err.charges = charges
    err.budget = budget
    throw err
  }
}

// the first refusal was this one, and every allocation charged before it was within the limit (what other parts of
// the parse still charge afterwards of the kind refused is refused too: it allocates, or walks, nothing more)
async function refusedAt(file, what, reason, options) {
  const limits = options?.limits ?? GLTF_LIMITS
  const err = await parse(file, options).then(
    () => assert.fail('the parse was not refused'),
    error => error
  )
  assert.equal(err.isGLTFLimit, true, String(err))
  assert.match(err.message, reason)
  const first = err.charges.findIndex(c => c.kind === 'refused')
  const at = err.charges[first].what
  if (what instanceof RegExp) assert.match(at, what, `refused at ${at}`)
  else assert.equal(at, what, `refused at ${at}`)
  // the charge that passed the limit is recorded just before its refusal (a document rule has none)
  const cause = err.charges[first - 1]?.what === at && err.charges[first - 1].kind !== 'refused' ? first - 1 : first
  const bytes = err.charges.slice(0, cause).filter(c => c.kind === 'bytes')
  assert.ok((bytes.at(-1)?.total ?? 0) <= err.budget.maxBytes, 'no allocation before the refusal passed the limit')
  const limitOf = c =>
    c.kind === 'bytes' ? err.budget.maxBytes : c.kind === 'work' ? limits.work : limits.counts[c.what]
  const passed = cause < first && err.charges[cause].kind !== 'pixels' ? err.charges[cause] : null
  if (passed && passed.total > limitOf(passed)) {
    const limit = limitOf(passed)
    const later = err.charges
      .slice(first + 1)
      .filter(c => c.kind === passed.kind && (c.kind !== 'count' || c.what === passed.what))
    assert.ok(
      later.every(c => c.total > limit),
      `every ${passed.kind} charge after it is refused`
    )
  }
  err.before = err.charges.slice(0, first).filter(c => c.kind !== 'refused')
  return err
}

const vec3 = (count, more = {}) => ({ componentType: 5126, type: 'VEC3', count, ...more })
const scene = { scene: 0, scenes: [{ nodes: [0] }] }

test('weights the parser iterates are real lists, and no further than the targets', async () => {
  // (a `length` of a billion is refused before parsing, see gltfLimits.test.js; here the parser's own guard, with
  // lengths small enough that a regression only grows the array)
  const positions = new Uint8Array(36)
  const file = glb(
    {
      asset: { version: '2.0' },
      ...scene,
      nodes: [{ mesh: 0, weights: { length: 50 } }],
      meshes: [
        { weights: Array(50).fill(1), primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] }] },
      ],
      accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    },
    positions
  )
  const { gltf, charges } = await parse(file)
  const mesh = gltf.scene.getObjectByProperty('isMesh', true)
  assert.equal(mesh.morphTargetInfluences.length, 1, 'the influences were not extended')
  assert.equal(mesh.morphTargetInfluences[0], 1)
  // the node's weights walk its own objects (the mesh): a step each
  assert.equal(charges.filter(c => c.what === 'node weights walk').length, 1)
})

test('an accessor without data is charged its whole zero-filled array before it is made', async () => {
  const file = glb({
    asset: { version: '2.0' },
    ...scene,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [vec3(2000000, { min: [0, 0, 0], max: [0, 0, 0] })],
  })
  const limits = { ...GLTF_LIMITS, allocatedBytes: 4 * MiB }
  const err = await refusedAt(file, 'accessor without data', /would allocate more than/, { limits })
  assert.equal(err.before.at(-1).n, 24000000)
})

test('a strip or fan conversion is charged (the geometry copy and its index) before it is made', async () => {
  // Codex's probe: a million zero-filled positions and 100 triangle-strip primitives, each converted into a copy of
  // the geometry (1.2 GB). The same charge at a tenth of the size, with a 4 MiB budget
  const file = glb({
    asset: { version: '2.0' },
    ...scene,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: Array.from({ length: 20 }, () => ({ attributes: { POSITION: 0 }, mode: 5 })) }],
    accessors: [vec3(100000, { min: [0, 0, 0], max: [0, 0, 0] })],
  })
  const limits = { ...GLTF_LIMITS, allocatedBytes: 4 * MiB }
  const err = await refusedAt(file, 'strip or fan conversion', /would allocate more than/, { limits })
  const conversions = err.before.filter(c => c.what === 'strip or fan conversion')
  assert.equal(conversions.length, 1, 'refused at the first conversion')
  // the conversion of one: positions (1.2 MB), the generated index and the triangle list
  assert.ok(conversions[0].n >= 1200000 + 3 * 99998 * 4)
})

test('a sparse accessor on an interleaved view is charged the whole interleaved array it copies', async () => {
  // stride 252, 1000 elements: each sparse accessor copies 252,000 bytes (not count x 12)
  const stride = 252
  const bin = new Uint8Array(stride * 1000 + 16)
  const accessors = Array.from({ length: 300 }, () =>
    vec3(1000, {
      bufferView: 0,
      min: [0, 0, 0],
      max: [0, 0, 0],
      sparse: { count: 1, indices: { bufferView: 1, componentType: 5121 }, values: { bufferView: 2 } },
    })
  )
  const file = glb(
    {
      asset: { version: '2.0' },
      ...scene,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: accessors.map((_, i) => ({ attributes: { POSITION: i } })) }],
      accessors,
      bufferViews: [
        { buffer: 0, byteLength: stride * 1000, byteStride: stride },
        { buffer: 0, byteOffset: stride * 1000, byteLength: 4 },
        { buffer: 0, byteOffset: stride * 1000 + 4, byteLength: 12 },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  )
  // a 4 MiB budget keeps the test small: the charge is the same
  const limits = { ...GLTF_LIMITS, allocatedBytes: 4 * MiB }
  const err = await refusedAt(file, 'sparse accessor copy', /would allocate more than/, { limits })
  const copies = err.before.filter(c => c.what === 'sparse accessor copy')
  assert.ok(
    copies.every(c => c.n === stride * 1000),
    'each copy is charged the whole interleaved array'
  )
  assert.ok(copies.length < 20)
})

test('each instance of a mesh is counted: its clone, its morph influences and its copy of the extras', async () => {
  const positions = new Uint8Array(36)
  const base = (instances, meshExtras) => ({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: Array.from({ length: instances }, (_, i) => i) }],
    nodes: Array.from({ length: instances }, () => ({ mesh: 0 })),
    meshes: [
      {
        extras: meshExtras,
        primitives: [{ attributes: { POSITION: 0 }, targets: Array.from({ length: 1000 }, () => ({ POSITION: 0 })) }],
      },
    ],
    accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  })
  // 1000 targets on 300 instances: 300,000 influences, more than 262,144
  const err = await refusedAt(glb(base(300), positions), 'influences', /influences: \d+, more than 262144/)
  assert.ok(err.before.filter(c => c.what === 'meshInstances').length > 200)
  // each clone is a step of work per object copied (the mesh is made once, then cloned for every use)
  assert.equal(
    err.before.filter(c => c.what === 'clone').length,
    err.before.filter(c => c.what === 'meshInstances').length - 1
  )
  // and a step per morph influence it copies
  assert.ok(err.before.filter(c => c.what === 'clone influences').every(c => c.kind === 'work' && c.n === 1000))
  assert.ok(err.before.filter(c => c.what === 'clone influences').length > 200)
  // 20,000 characters of extras copied into every instance (as JSON, with each clone)
  const extras = { text: 'x'.repeat(20000) }
  const limits = { ...GLTF_LIMITS, allocatedBytes: 4 * MiB }
  const copies = await refusedAt(glb(base(200, extras), positions), 'userData copy', /would allocate more than/, {
    limits,
  })
  // at what a JSON copy of the userData holds (its text, a property, an object: jsonCopyBytes)
  const userData = JSON.stringify(extras)
  assert.ok(
    copies.before
      .filter(c => c.what === 'userData copy' && c.kind === 'bytes')
      .every(c => c.n === jsonCopyBytes(userData) && c.n >= 40000)
  )
  // each copy also goes through every character of it: a step each
  const copied = copies.before.filter(c => c.what === 'userData copy')
  for (let i = 0; i + 1 < copied.length; i += 2)
    assert.deepEqual([copied[i + 1].kind, copied[i + 1].n], ['work', userData.length])
})

test('scenes, cameras and other collections the parser creates eagerly are counted', async () => {
  const scenes = glb({ asset: { version: '2.0' }, scenes: Array.from({ length: 1000 }, () => ({})) })
  const err = await refusedAt(scenes, 'scenes', /scenes: 65, more than 64/)
  assert.equal(err.before.filter(c => c.what === 'scenes').length, 65, 'the 65th scene was refused before it was made')
  // the parser starts every scene (each start is guarded, so none is left without a handler) and each later one is
  // refused at its charge, before it is made
  assert.equal(err.charges.filter(c => c.kind === 'refused' && c.what === 'scenes').length, 1000 - 64)
  const cameras = glb({
    asset: { version: '2.0' },
    cameras: Array.from({ length: 2000 }, () => ({ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } })),
  })
  await refusedAt(cameras, 'cameras', /cameras: 1025, more than 1024/)
  const animations = glb({
    asset: { version: '2.0' },
    animations: Array.from({ length: 2000 }, () => ({ channels: [], samplers: [] })),
  })
  await refusedAt(animations, 'animations', /animations: 1025/)
})

test('an image is sized from its header at the decode, whatever references it (a string index, a KTX2 fallback)', async () => {
  const header = png(100000, 100000)
  const json = {
    asset: { version: '2.0' },
    ...scene,
    extensionsUsed: ['KHR_texture_basisu'],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    // the source as a string, and a KTX2 source this client cannot decode: the parser decodes image 0 all the same
    textures: [{ source: '0', extensions: { KHR_texture_basisu: { source: 0 } } }],
    images: [{ bufferView: 1, mimeType: 'image/png' }],
    accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
    bufferViews: [
      { buffer: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: header.length },
    ],
    buffers: [{ byteLength: 36 + header.length }],
  }
  const bin = new Uint8Array(36 + header.length)
  bin.set(header, 36)
  decoded = 0
  await refusedAt(glb(json, bin), 'image 0', /image 0 is larger than 36000000 pixels/)
  assert.equal(decoded, 0, 'nothing was decoded')
  // a JPEG with a second frame header in front: malformed, refused before a decoder sees it
  const double = jpeg(4096, 4096, {
    frames: [
      [1, 1],
      [4096, 4096],
    ],
  })
  const json2 = {
    ...json,
    textures: [{ source: 0 }],
    bufferViews: [json.bufferViews[0], { buffer: 0, byteOffset: 36, byteLength: double.length }],
  }
  const bin2 = new Uint8Array(36 + double.length)
  bin2.set(double, 36)
  await refusedAt(
    glb({ ...json2, buffers: [{ byteLength: bin2.length }] }, bin2),
    'image 0',
    /malformed jpeg \(more than one frame header\)/
  )
  assert.equal(decoded, 0)
})

test('an optional KTX2 or AVIF image with a fallback: the parser decides what it decodes, as it did', async t => {
  // a KTX2 or AVIF image's mimeType is one of the fixed list a file may carry. The parser decides whether it is
  // decoded, as before the list: a KTX2 image (no decoder) is skipped for its PNG fallback, which is the one decoded
  // and charged; the file loads. A file that requires the extension is refused before parsing (not loadable)
  const ktx2 = Uint8Array.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const avif = Uint8Array.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0])
  const withFallback = (extension, mimeType, bytes, required = false) => {
    const b = chunks()
    const positions = b.view(new Uint8Array(36))
    const variant = b.view(bytes)
    const fallback = b.view(png(16, 16))
    const { bin, bufferViews, buffers } = b.done()
    return glb(
      {
        asset: { version: '2.0' },
        ...scene,
        extensionsUsed: [extension],
        ...(required ? { extensionsRequired: [extension] } : {}),
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        textures: [{ source: 1, extensions: { [extension]: { source: 0 } } }],
        images: [
          { bufferView: variant, mimeType },
          { bufferView: fallback, mimeType: 'image/png' },
        ],
        accessors: [vec3(3, { bufferView: positions, min: [0, 0, 0], max: [0, 0, 0] })],
        bufferViews,
        buffers,
      },
      bin
    )
  }
  const loaded = async file => {
    decoded = 0
    const { gltf, charges } = await parse(file, { check: true }) // as the client loads it
    let map = null
    gltf.scene.traverse(o => o.isMesh && (map = o.material.map))
    return { map, charges }
  }
  const basisu = await loaded(withFallback('KHR_texture_basisu', 'image/ktx2', ktx2))
  assert.equal(decoded, 1, 'the fallback, once')
  assert.equal(basisu.map.userData.mimeType, 'image/png')
  assert.deepEqual(
    basisu.charges.filter(c => c.kind === 'pixels').map(c => c.what),
    ['image 1'],
    'only the fallback charged'
  )
  assert.ok(!basisu.charges.some(c => c.what === 'image 0'), 'the KTX2 image never charged')
  assert.throws(
    () => checkGLTF(withFallback('KHR_texture_basisu', 'image/ktx2', ktx2, true)),
    /requires an extension this client cannot load \(KHR_texture_basisu\)/
  )
  // AVIF: the parser asks the browser whether it decodes AVIF. Where it does not, the fallback is decoded and
  // charged, the AVIF image never; where it does, the parser takes the AVIF image and the budget refuses it at its
  // decode, as any image that is not PNG, JPEG or WebP (as before the list)
  const image = supported =>
    class {
      set src(value) {
        setTimeout(() => {
          this.height = supported ? 1 : 0
          ;(supported ? this.onload : this.onerror)?.()
        })
      }
    }
  t.after(() => delete globalThis.Image)
  globalThis.Image = image(false)
  const fallback = await loaded(withFallback('EXT_texture_avif', 'image/avif', avif))
  assert.equal(decoded, 1)
  assert.equal(fallback.map.userData.mimeType, 'image/png')
  assert.deepEqual(
    fallback.charges.filter(c => c.kind === 'pixels').map(c => c.what),
    ['image 1']
  )
  assert.ok(!fallback.charges.some(c => c.what === 'image 0'), 'the AVIF image never charged')
  globalThis.Image = image(true)
  decoded = 0
  await assert.rejects(
    parse(withFallback('EXT_texture_avif', 'image/avif', avif), { check: true }),
    /image 0 is not a PNG, JPEG or WebP image/
  )
  assert.equal(decoded, 0)
})

test('image decodes are charged as the parser makes them: ten entries on one view and sampler are one decode', async () => {
  const header = png(4096, 4096)
  const bin = new Uint8Array(36 + header.length)
  bin.set(header, 36)
  const file = glb(
    {
      asset: { version: '2.0' },
      ...scene,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: Array.from({ length: 10 }, (_, i) => ({ attributes: { POSITION: 0 }, material: i })) }],
      materials: Array.from({ length: 10 }, (_, i) => ({ pbrMetallicRoughness: { baseColorTexture: { index: i } } })),
      textures: Array.from({ length: 10 }, (_, i) => ({ source: i })),
      images: Array.from({ length: 10 }, () => ({ bufferView: 1, mimeType: 'image/png' })),
      accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
      bufferViews: [
        { buffer: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: header.length },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  )
  decoded = 0
  const { budget } = await parse(file)
  assert.equal(decoded, 1)
  assert.equal(budget.used.counts.images, 1)
  assert.equal(budget.used.pixels, 4096 * 4096)
})

test('shared float animation arrays are not charged as copies; converted ones are', async () => {
  // 1000 nodes animated by one CUBICSPLINE sampler with float times and values: the tracks share the arrays
  const times = new Float32Array([0, 1])
  const values = new Float32Array(2 * 3 * 4)
  const bin = new Uint8Array(times.byteLength + values.byteLength)
  bin.set(new Uint8Array(times.buffer), 0)
  bin.set(new Uint8Array(values.buffer), times.byteLength)
  const json = normalized => ({
    asset: { version: '2.0' },
    nodes: Array.from({ length: 1000 }, () => ({})),
    scene: 0,
    scenes: [{ nodes: Array.from({ length: 1000 }, (_, i) => i) }],
    animations: [
      {
        samplers: [{ input: 0, output: 1, interpolation: 'CUBICSPLINE' }],
        channels: Array.from({ length: 1000 }, (_, i) => ({ sampler: 0, target: { node: i, path: 'rotation' } })),
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, type: 'SCALAR', count: 2, min: [0], max: [1] },
      normalized
        ? { bufferView: 1, componentType: 5121, type: 'VEC4', count: 6, normalized: true }
        : { bufferView: 1, componentType: 5126, type: 'VEC4', count: 6 },
    ],
    bufferViews: [
      { buffer: 0, byteLength: times.byteLength },
      { buffer: 0, byteOffset: times.byteLength, byteLength: values.byteLength },
    ],
    buffers: [{ byteLength: bin.length }],
  })
  const { gltf, budget, charges } = await parse(glb(json(false), bin))
  assert.equal(gltf.animations[0].tracks.length, 1000)
  assert.equal(budget.used.counts.tracks, 1000)
  assert.equal(charges.filter(c => /copy|normalised/.test(c.what)).length, 0, 'no copies charged')
  // normalised byte values become a float copy per channel
  const normalized = await parse(glb(json(true), bin))
  assert.equal(normalized.charges.filter(c => c.what === 'normalised animation values').length, 1000)
})

test('an optional meshopt or Draco extension without a decoder loads the fallback data', async () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const bin = new Uint8Array(positions.buffer)
  const compressed = `data:application/octet-stream;base64,${Buffer.from(new Uint8Array(8)).toString('base64')}`
  const meshopt = {
    asset: { version: '2.0' },
    ...scene,
    extensionsUsed: ['EXT_meshopt_compression'],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [1, 1, 0] })],
    bufferViews: [
      {
        buffer: 0,
        byteLength: 36,
        extensions: {
          EXT_meshopt_compression: { buffer: 1, byteLength: 8, byteStride: 12, count: 3, mode: 'ATTRIBUTES' },
        },
      },
    ],
    buffers: [{ byteLength: 36 }, { byteLength: 8, uri: compressed }],
  }
  const loaded = await parse(glb(meshopt, bin))
  assert.deepEqual(
    [...loaded.gltf.scene.getObjectByProperty('isMesh', true).geometry.attributes.position.array],
    [...positions]
  )
  const draco = {
    ...meshopt,
    extensionsUsed: ['KHR_draco_mesh_compression'],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } },
          },
        ],
      },
    ],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  }
  const dracoLoaded = await parse(glb(draco, bin))
  assert.equal(dracoLoaded.gltf.scene.getObjectByProperty('isMesh', true).geometry.attributes.position.count, 3)
  // Codex's probe: two primitives with the same Draco extension and different fallbacks each get their own geometry
  // (the geometry cache keyed them by the Draco data, which is not decoded, and gave both the first one's)
  const second = new Float32Array([5, 5, 5, 6, 5, 5, 5, 6, 5])
  const twoBin = new Uint8Array(72)
  twoBin.set(bin, 0)
  twoBin.set(new Uint8Array(second.buffer), 36)
  const primitive = POSITION => ({ attributes: { POSITION }, extensions: draco.meshes[0].primitives[0].extensions })
  const two = await parse(
    glb(
      {
        ...draco,
        meshes: [{ primitives: [primitive(0), primitive(1)] }],
        accessors: [draco.accessors[0], vec3(3, { bufferView: 1, min: [5, 5, 5], max: [6, 6, 5] })],
        bufferViews: [
          { buffer: 0, byteLength: 36 },
          { buffer: 0, byteOffset: 36, byteLength: 36 },
        ],
        buffers: [{ byteLength: 72 }],
      },
      twoBin
    )
  )
  const meshes = []
  two.gltf.scene.traverse(object => object.isMesh && meshes.push(object))
  assert.notEqual(meshes[0].geometry, meshes[1].geometry)
  assert.deepEqual([...meshes[0].geometry.attributes.position.array], [...positions])
  assert.deepEqual([...meshes[1].geometry.attributes.position.array], [...second])
  assert.equal(two.budget.used.counts.primitives, 2)
})

test('sparse indices are strictly increasing inside the accessor, and each entry is a step of work', async () => {
  // an accessor of `count` elements (`accessors` of them) with the sparse entries given, over views shared by all
  const sparseFile = (indices, count, accessors = 1) => {
    const n = indices.length
    const valuesAt = Math.ceil(n / 4) * 4
    const bin = new Uint8Array(valuesAt + n * 12)
    bin.set(indices, 0)
    new Float32Array(bin.buffer, valuesAt, n * 3).set(Array.from({ length: n * 3 }, (_, i) => i + 1))
    const sparse = { count: n, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } }
    const list = Array.from({ length: accessors }, () => vec3(count, { min: [0, 0, 0], max: [0, 0, 0], sparse }))
    return glb(
      {
        asset: { version: '2.0' },
        ...scene,
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: list.map((_, i) => ({ attributes: { POSITION: i } })) }],
        accessors: list,
        bufferViews: [
          { buffer: 0, byteLength: n },
          { buffer: 0, byteOffset: valuesAt, byteLength: n * 12 },
        ],
        buffers: [{ byteLength: bin.length }],
      },
      bin
    )
  }
  // written where the indices say, a step charged per entry
  const { gltf, charges } = await parse(sparseFile([1, 3], 4))
  const position = gltf.scene.getObjectByProperty('isMesh', true).geometry.attributes.position
  assert.deepEqual([...position.array], [0, 0, 0, 1, 2, 3, 0, 0, 0, 4, 5, 6])
  assert.deepEqual(
    charges.filter(c => c.what === 'sparse entries').map(c => [c.kind, c.n]),
    [['work', 2]]
  )
  // Codex's probe, scaled down: accessors of one element, each writing index 0 a thousand times from the shared views
  // (12 bytes charged an accessor, and 200 of them wrote 20,000,000 times)
  await refusedAt(
    sparseFile(new Array(1000).fill(0), 1, 50),
    'sparse entries',
    /accessor \d+ has sparse indices that are not strictly increasing inside it/
  )
  // decreasing, repeated, outside the accessor
  for (const indices of [
    [2, 1],
    [1, 1],
    [0, 4],
  ]) {
    await refusedAt(sparseFile(indices, 4), 'sparse entries', /not strictly increasing inside it/)
  }
  // without a budget (the server) the rule holds all the same
  await assert.rejects(
    new GLTFLoader().parseAsync(sparseFile([1, 1], 4), ''),
    /THREE.GLTFLoader: accessor 0 has sparse indices that are not strictly increasing/
  )
})

test('a weights channel walks the subtree of its node: a step of work for each object visited', async () => {
  // Codex's probe: 2000 weights channels on a node with 2000 descendants walked 4,000,000 objects and charged
  // nothing. n channels on a node (a mesh with one morph target) with n - 1 children
  const walk = n => {
    const bin = new Uint8Array(52)
    bin.set(new Uint8Array(new Float32Array([0, 1]).buffer), 0)
    bin.set(new Uint8Array(new Float32Array([0, 1]).buffer), 8)
    return glb(
      {
        asset: { version: '2.0' },
        ...scene,
        nodes: [{ mesh: 0, children: Array.from({ length: n - 1 }, (_, i) => i + 1) }, ...Array(n - 1).fill({})],
        meshes: [{ primitives: [{ attributes: { POSITION: 2 }, targets: [{ POSITION: 2 }] }] }],
        animations: [
          {
            samplers: [{ input: 0, output: 1 }],
            channels: Array(n).fill({ sampler: 0, target: { node: 0, path: 'weights' } }),
          },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, type: 'SCALAR', count: 2, min: [0], max: [1] },
          { bufferView: 1, componentType: 5126, type: 'SCALAR', count: 2 },
          vec3(3, { bufferView: 2, min: [0, 0, 0], max: [0, 0, 0] }),
        ],
        bufferViews: [
          { buffer: 0, byteLength: 8 },
          { buffer: 0, byteOffset: 8, byteLength: 8 },
          { buffer: 0, byteOffset: 16, byteLength: 36 },
        ],
        buffers: [{ byteLength: 52 }],
      },
      bin
    )
  }
  const { gltf, charges } = await parse(walk(100))
  assert.equal(gltf.animations[0].tracks.length, 100, 'a track per channel (one mesh with morph targets)')
  assert.equal(charges.filter(c => c.what === 'weights channel walk').length, 100 * 100)
  // (the walks and the tracks' keyframes are charged in turn, channel by channel: either may be the step past the
  // limit, which is 20,000 steps plus one per byte of the file)
  const limits = { ...GLTF_LIMITS, work: 20000 }
  const file = walk(200)
  await refusedAt(
    file,
    /^(weights channel walk|track keyframes)$/,
    new RegExp(`more than ${20000 + file.byteLength} steps`),
    {
      limits,
    }
  )
})

// a skinned mesh of `primitives` primitives, all on the same `vertices`-vertex accessors (one shared geometry);
// `weights` and `joints`: those accessors' counts
function skinned({ primitives, vertices, weights = vertices, joints = vertices }) {
  const bin = new Uint8Array(vertices * 12 + joints * 4 + weights * 16 + 64)
  new Float32Array(bin.buffer, vertices * 12 + joints * 4, weights * 4).fill(0.25)
  new Float32Array(bin.buffer, bin.length - 64, 16).set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  return glb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0, skin: 0 }, {}],
      skins: [{ joints: [1], inverseBindMatrices: 3 }],
      meshes: [{ primitives: Array(primitives).fill({ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }) }],
      accessors: [
        vec3(vertices, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] }),
        { bufferView: 1, componentType: 5121, type: 'VEC4', count: joints },
        { bufferView: 2, componentType: 5126, type: 'VEC4', count: weights },
        { bufferView: 3, componentType: 5126, type: 'MAT4', count: 1 },
      ],
      bufferViews: [
        { buffer: 0, byteLength: vertices * 12 },
        { buffer: 0, byteOffset: vertices * 12, byteLength: joints * 4 },
        { buffer: 0, byteOffset: vertices * 12 + joints * 4, byteLength: weights * 16 },
        { buffer: 0, byteOffset: bin.length - 64, byteLength: 64 },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  )
}

test('each mesh made is charged every accessor its primitives use, even when they share one geometry', async t => {
  // Codex's probe: 50 skinned primitives on one shared 2000-vertex geometry normalised 100,000 skin weights while 270
  // steps were charged. Each primitive's accessors are charged for each mesh made of them: 50 x 2000 x (3 + 4 + 4)
  let normalised = 0
  const normalize = SkinnedMesh.prototype.normalizeSkinWeights
  t.mock.method(SkinnedMesh.prototype, 'normalizeSkinWeights', function () {
    normalised += this.geometry.attributes.skinWeight.count
    return normalize.call(this)
  })
  const { budget, charges } = await parse(skinned({ primitives: 50, vertices: 2000 }))
  assert.equal(normalised, 50 * 2000)
  assert.equal(budget.used.counts.primitives, 1, 'one geometry')
  assert.deepEqual(
    charges.filter(c => c.what === 'mesh accessors').map(c => c.n),
    [50 * 2000 * (3 + 4 + 4)]
  )
  // ten times the primitives, within a smaller limit: refused before the meshes are made
  normalised = 0
  const limits = { ...GLTF_LIMITS, work: 500000 }
  await refusedAt(
    skinned({ primitives: 500, vertices: 200 }),
    'mesh accessors',
    /the parser would take more than \d+ steps/,
    {
      limits,
    }
  )
  assert.equal(normalised, 0, 'nothing normalised')
  // and a skinned primitive's joints and weights are one per vertex, on the real attributes (not checked before)
  await refusedAt(
    skinned({ primitives: 1, vertices: 30, weights: 20 }),
    'skinned mesh',
    /mesh 0 is skinned without joints and weights for each vertex/
  )
})

test('an animation track gets whole keyframes from tight arrays, asserted on the arrays themselves', async () => {
  // Codex's probe: times of 2 keyframes at a byteStride of 8 reached the track as 4 floats; with 6 CUBICSPLINE VEC3
  // values that is a sample size of 1.5, and three's interpolant looped on `i !== 1.5`. checkGLTF refuses the layout
  // (gltfLimits.test.js); the parser refuses it too, on the arrays it would hand three.js
  const bin = new Uint8Array(16 + 72)
  new Float32Array(bin.buffer, 0, 4).set([0, 99, 1, 99])
  const animatedJSON = (timesView, interpolation = 'CUBICSPLINE', values = 6) => ({
    asset: { version: '2.0' },
    ...scene,
    nodes: [{ name: 'n' }],
    animations: [
      {
        samplers: [{ input: 0, output: 1, interpolation }],
        channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, type: 'SCALAR', count: 2, min: [0], max: [1] },
      { bufferView: 1, componentType: 5126, type: 'VEC3', count: values },
    ],
    bufferViews: [timesView, { buffer: 0, byteOffset: 16, byteLength: 72 }],
    buffers: [{ byteLength: bin.length }],
  })
  const animated = (...args) => glb(animatedJSON(...args), bin)
  await refusedAt(
    animated({ buffer: 0, byteLength: 16, byteStride: 8 }),
    'animation track',
    /an animation channel of node 0 has no whole number of values per keyframe/
  )
  // a fractional value size from counts alone (5 values for 2 LINEAR keyframes), past a missing check
  await refusedAt(animated({ buffer: 0, byteLength: 8 }, 'LINEAR', 5), 'animation track', /no whole number of values/)
  // interleaved times whose ratio happens to be whole (4 floats, 4 LINEAR values): the times are not the keyframes'
  await refusedAt(
    animated({ buffer: 0, byteLength: 16, byteStride: 8 }, 'LINEAR', 4),
    'animation track',
    /no whole number/
  )
  // and a sparse time accessor on an interleaved view: the parser copies the whole interleaved array into a plain
  // attribute (4 floats, its count 4), so the times are checked against the 2 the document declares
  const sparseTimes = animatedJSON({ buffer: 0, byteLength: 16, byteStride: 8 }, 'LINEAR', 4)
  sparseTimes.accessors[0].sparse = {
    count: 1,
    indices: { bufferView: 2, componentType: 5121 },
    values: { bufferView: 3 },
  }
  sparseTimes.bufferViews.push(
    { buffer: 0, byteOffset: 80, byteLength: 1 },
    { buffer: 0, byteOffset: 84, byteLength: 4 }
  )
  await refusedAt(glb(sparseTimes, bin), 'animation track', /no whole number of values per keyframe/)
  // tight times: the track is made, and its keyframes are charged as work
  const { gltf, charges } = await parse(animated({ buffer: 0, byteLength: 8 }))
  assert.equal(gltf.animations[0].tracks[0].getValueSize(), 9)
  assert.deepEqual(
    charges.filter(c => c.what === 'track keyframes').map(c => c.n),
    [2 + 18]
  )
})

test('placing an object is charged what three.js goes through to take it from its old parent', async () => {
  // Codex's probe: a scene listing 1000 empty roots twice re-parented each one, a search and a splice of the scene's
  // 1000 children each time (999,000 entries shifted), for one step per root. checkGLTF refuses the repeated roots
  // (gltfLimits.test.js); the parser charges each placement at its cost all the same
  const repeated = n =>
    glb({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [...Array(n).keys(), ...Array(n).keys()] }],
      nodes: Array(n).fill({}),
    })
  const { charges } = await parse(repeated(100))
  const placed = charges.filter(c => c.what === 'placing an object').map(c => c.n)
  assert.deepEqual(placed.slice(0, 100), Array(100).fill(1), 'the first time: nothing to take it from')
  assert.deepEqual(placed.slice(100), Array(100).fill(101), 'the second: the scene and its 100 children')
  const limits = { ...GLTF_LIMITS, work: 100000 }
  await refusedAt(repeated(1000), 'placing an object', /more than \d+ steps \(at placing an object\)/, { limits })
  // a root shared by two scenes (valid glTF, and passed by checkGLTF) loads: it ends in the second, its move charged
  const shared = glb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }, { nodes: [0, 2] }],
    nodes: [{ name: 'shared' }, {}, {}],
  })
  checkGLTF(shared)
  const sharedParse = await parse(shared)
  assert.equal(sharedParse.gltf.scenes.length, 2)
  assert.equal(sharedParse.gltf.scenes[1].getObjectByName('shared')?.parent, sharedParse.gltf.scenes[1])
})

test('instancing: each instanced mesh is charged the attributes it reads, and emptying the group its splices', async () => {
  // a node of 4 primitives, instanced 10 times: each instanced mesh reads the 10 translations (30 floats), and the
  // group of the primitives is emptied (each child taken out with a search and a splice of the rest: 4 + 3 + 2 + 1)
  const bin = new Uint8Array(36 + 120)
  const file = glb(
    {
      asset: { version: '2.0' },
      extensionsUsed: ['EXT_mesh_gpu_instancing'],
      ...scene,
      nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } }],
      meshes: [{ primitives: Array(4).fill({ attributes: { POSITION: 0 } }) }],
      accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] }), vec3(10, { bufferView: 1 })],
      bufferViews: [
        { buffer: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 120 },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  )
  const { gltf, charges } = await parse(file)
  assert.equal(gltf.scene.getObjectByProperty('isInstancedMesh', true).count, 10)
  assert.deepEqual(
    charges.filter(c => c.what === 'instancing attributes').map(c => c.n),
    [1 + 30, 1 + 30, 1 + 30, 1 + 30]
  )
  assert.deepEqual(
    charges.filter(c => c.what === 'emptying a group').map(c => c.n),
    [4 + 3 + 2 + 1]
  )
  // the reviewer's probe, scaled down: many instancing attributes on an empty accessor (refused before parsing,
  // gltfLimits.test.js), each charged for each primitive all the same
  const keys = Object.fromEntries(Array.from({ length: 200 }, (_, k) => [`_A${k}`, 2]))
  const empty = JSON.parse(new TextDecoder().decode(new Uint8Array(file, 20, new DataView(file).getUint32(12, true))))
  empty.nodes[0].extensions.EXT_mesh_gpu_instancing.attributes = keys
  empty.accessors.push({ componentType: 5126, type: 'SCALAR', count: 0 })
  const emptied = await parse(glb(empty, bin))
  const perKey = emptied.charges.filter(c => c.what === 'instancing attributes')
  assert.equal(perKey.length, 4 * 200)
  assert.ok(perKey.every(c => c.n === 1))
})

test('a skin has an inverse bind matrix for each joint in a plain array, asserted on the array itself', async () => {
  // two joints and one matrix: the parser would read the second joint's past the array (not checked before here)
  const file = skinned({ primitives: 1, vertices: 3 })
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(file, 20, new DataView(file).getUint32(12, true))))
  json.skins[0].joints = [1, 1]
  const binStart = 28 + new DataView(file).getUint32(12, true)
  await refusedAt(glb(json, new Uint8Array(file, binStart)), 'skin', /skin 0 has no inverse bind matrix for each joint/)
})

test('a VRM 0 spring bone group with UniVRM\u2019s center -1 loads, with no center', async t => {
  t.mock.method(console, 'warn', () => {})
  const positions = new Uint8Array(36)
  const file = glb(
    {
      asset: { version: '2.0' },
      extensionsUsed: ['VRM'],
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, children: [1] }, { name: 'hair' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
      extensions: { VRM: { secondaryAnimation: { boneGroups: [{ bones: [1], center: -1 }], colliderGroups: [] } } },
    },
    positions
  )
  checkGLTF(file)
  const { gltf } = await parse(file, { vrm: true })
  const [joint] = gltf.userData.vrmSpringBoneManager.joints
  assert.equal(joint.bone.name, 'hair')
  assert.equal(joint.center ?? null, null)
})

test('a refused texture of an MToon material leaves no rejection unhandled (three-vrm never awaits its wrapper)', async () => {
  // three-vrm's MToon plugin wraps each texture it assigns in a promise nothing awaits, and sets the colour space of
  // what was assigned: a refusal there was an unhandled rejection (VRoid's AvatarSample_A, refused by the earlier
  // byte limit, left 18). The refused texture is an empty placeholder in the material, and the parse fails with the
  // refusal all the same (budget.refused)
  const header = png(100000, 100000)
  const bin = new Uint8Array(36 + header.length)
  bin.set(header, 36)
  const file = glb(
    {
      asset: { version: '2.0' },
      extensionsUsed: ['VRMC_materials_mtoon'],
      ...scene,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
          extensions: { VRMC_materials_mtoon: { specVersion: '1.0', shadeMultiplyTexture: { index: 0 } } },
        },
      ],
      textures: [{ source: 0 }],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
      accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
      bufferViews: [
        { buffer: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: header.length },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  )
  const unhandled = []
  const listener = error => unhandled.push(error)
  process.on('unhandledRejection', listener)
  try {
    await assert.rejects(parse(file, { vrm: true }), /image 0 is larger than 36000000 pixels/)
    await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    process.off('unhandledRejection', listener)
  }
  assert.deepEqual(unhandled.map(String), [])
})

test('a data: URI that does not decode is refused like any image that is not one: the model does not load', async () => {
  // the reviewer's probe: its decode threw outside the budget's refusal, so the parse had not failed (budget.refused
  // was not set), the texture became the placeholder kept for refused textures, and the model loaded without it. It
  // is a refusal of the budget now: with a plain material and with MToon, the parse fails, and nothing is unhandled
  const textured = (image, mtoon) =>
    glb(
      {
        asset: { version: '2.0' },
        extensionsUsed: mtoon ? ['VRMC_materials_mtoon'] : [],
        ...scene,
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        materials: [
          mtoon
            ? {
                pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
                extensions: { VRMC_materials_mtoon: { specVersion: '1.0', shadeMultiplyTexture: { index: 0 } } },
              }
            : { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        ],
        textures: [{ source: 0 }],
        images: [image],
        accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
        bufferViews: [{ buffer: 0, byteLength: 36 }],
        buffers: [{ byteLength: 36 }],
      },
      new Uint8Array(36)
    )
  const unhandled = []
  const listener = error => unhandled.push(error)
  process.on('unhandledRejection', listener)
  try {
    for (const mtoon of [false, true]) {
      const file = textured({ uri: 'data:image/png;base64,@@@@not-base64@@@@' }, mtoon)
      const err = await parse(file, { vrm: true }).then(
        () => assert.fail(`loaded (${mtoon ? 'MToon' : 'plain'})`),
        error => error
      )
      assert.match(err.message, /image 0 is a data: URI that does not decode/)
      assert.equal(err.budget.refused, err)
      // a data: URI that does decode loads, its texture in the material
      const good = `data:image/png;base64,${Buffer.from(png(16, 16)).toString('base64')}`
      const { gltf } = await parse(textured({ uri: good }, mtoon), { vrm: true })
      gltf.scene.traverse(o => o.isMesh && assert.ok([o.material].flat()[0].map?.image, 'the texture loaded'))
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    process.off('unhandledRejection', listener)
  }
  assert.deepEqual(unhandled.map(String), [])
})

test('the placeholder for a refused texture is put in only once the parse has failed; other errors go on', async () => {
  // a limit error with the parse not failed (budget.refused not set: a budget that throws without refusing) is not
  // swallowed as a placeholder: the texture's error fails the material, and the parse, as it did before
  const file = glb(
    {
      asset: { version: '2.0' },
      ...scene,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ uri: `data:image/png;base64,${Buffer.from(png(16, 16)).toString('base64')}` }],
      accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    },
    new Uint8Array(36)
  )
  const budget = createGLTFBudget({ fileBytes: file.byteLength })
  budget.imageURI = () => {
    throw new GLTFLimitError('a refusal the budget did not record')
  }
  await assert.rejects(new GLTFLoader().parseAsync(file, '', budget), /a refusal the budget did not record/)
  assert.equal(budget.refused, null)
})

test('a data: URI is the image, not its name: its textures are cached by the image, and names are charged', async () => {
  // the reviewer's probe: an 8 MB data: URI named by 2000 textures built and looked up a key of the whole URI for
  // each (2.4 s). The key is the image's index now (and an image shared by textures is still decoded once)
  const uri = `data:image/png;base64,${Buffer.from(png(16, 16)).toString('base64')}`
  const file = glb(
    {
      asset: { version: '2.0' },
      ...scene,
      nodes: [{ mesh: 0, name: 'n'.repeat(1000) }],
      meshes: [
        {
          name: 'm'.repeat(1000),
          primitives: Array.from({ length: 50 }, (_, i) => ({ attributes: { POSITION: 0 }, material: i % 2 })),
        },
      ],
      materials: [0, 1].map(i => ({ pbrMetallicRoughness: { baseColorTexture: { index: i } } })),
      textures: [{ source: 0 }, { source: 0, sampler: 0 }],
      samplers: [{ magFilter: 9728 }],
      images: [{ uri }],
      animations: [
        { samplers: [{ input: 1, output: 0 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] },
      ],
      accessors: [
        vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] }),
        { bufferView: 1, componentType: 5126, type: 'SCALAR', count: 3, min: [0], max: [0] },
      ],
      bufferViews: [
        { buffer: 0, byteLength: 36 },
        { buffer: 0, byteLength: 12 },
      ],
      buffers: [{ byteLength: 36 }],
    },
    new Uint8Array(36)
  )
  const before = decoded
  const { gltf, charges } = await parse(file)
  const keys = Object.keys(gltf.parser.textureCache)
  assert.deepEqual(keys.sort(), ['image 0:0', 'image 0:undefined'])
  assert.equal(decoded - before, 1, 'one decode for the image both textures use')
  // each object named: its name sanitised and kept (a step and two bytes a character); the mesh's name for each of
  // its 50 primitives (at most 1024 characters: checkGLTF)
  const names = charges.filter(c => c.what === 'names')
  assert.equal(names.filter(c => c.kind === 'work' && c.n === 1001).length, 51)
  assert.equal(names.filter(c => c.kind === 'bytes' && c.n === 2000).length, 51)
  // and a track's name, the node's with its path, for each track
  assert.deepEqual(
    charges.filter(c => c.what === 'track name').map(c => [c.kind, c.n]),
    [['bytes', 2 * (1000 + 16)]]
  )
})

test('a userData copy is charged at least what it holds: the heap of the worst shapes, through the parser', async () => {
  // the reviewer's probe: a list of empty objects held 11.7 times the two bytes a character it was charged (68 clones
  // within the work limit held 1.6 GB, 135 MB charged). Measured here, on this Node, with extras just under the 64 KiB
  // an object may have, over eleven clones: the bytes charged for each copy are at least two thirds of what it holds
  // (jsonCopyBytes holds 0.51 for this shape, 0.87 for many keys of one object, 1.01 for a long two-byte string)
  v8.setFlagsFromString('--expose_gc')
  const gc = vm.runInNewContext('gc')
  const room = GLTF_LIMITS.userDataLength - 100
  const shapes = {
    'a list of empty objects': { l: Array(Math.floor(room / 3)).fill({}) },
    'many keys of one object': Object.fromEntries(
      Array.from({ length: Math.floor(room / 10) }, (_, i) => [`k${i}`, 0])
    ),
    'a string of two-byte characters': { s: 'あ'.repeat(room - 10) },
  }
  const file = (extras, uses) =>
    glb(
      {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [...Array(uses).keys()] }],
        nodes: Array(uses).fill({ mesh: 0 }),
        meshes: [{ extras, primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
        bufferViews: [{ buffer: 0, byteLength: 36 }],
        buffers: [{ byteLength: 36 }],
      },
      new Uint8Array(36)
    )
  const held = async (extras, uses) => {
    const data = file(extras, uses)
    gc()
    const base = process.memoryUsage().heapUsed
    const parsed = await parse(data, { check: true })
    gc()
    const heap = process.memoryUsage().heapUsed - base
    const charged = parsed.charges.filter(c => c.what === 'userData copy' && c.kind === 'bytes')
    return { heap, charged: charged.reduce((sum, c) => sum + c.n, 0), copies: charged.length, parsed }
  }
  for (const [shape, extras] of Object.entries(shapes)) {
    const one = await held(extras, 1)
    const eleven = await held(extras, 11)
    // (a mesh used by more than one node is cloned for each of them: eleven copies)
    const copies = eleven.copies - one.copies
    assert.equal(copies, 11, shape)
    const heapPerCopy = (eleven.heap - one.heap) / copies
    const chargedPerCopy = (eleven.charged - one.charged) / copies
    assert.ok(chargedPerCopy >= heapPerCopy / 1.5, `${shape}: ${chargedPerCopy} charged, ${heapPerCopy} held`)
    // (two bytes a character, the charge before, was far below it for the list of empty objects)
    if (shape === 'a list of empty objects') {
      const text = JSON.stringify(extras).length
      assert.ok(2 * text < heapPerCopy / 5, `${2 * text} at two bytes a character, ${heapPerCopy} held`)
    }
  }
})

test('an expression’s texture-transform binds clone the textures checkGLTF counts, at most', async t => {
  // three-vrm's VRMExpressionTextureTransformBind clones every texture slot of each material it binds (once per mesh
  // using the material): each clone copies the texture's userData, which checkGLTF counts before the plugin runs
  t.mock.method(console, 'warn', () => {})
  const header = png(16, 16)
  const bin = new Uint8Array(84 + header.length)
  bin.set(header, 84)
  const file = tangents =>
    glb(
      {
        asset: { version: '2.0' },
        extensionsUsed: ['VRMC_vrm', 'VRMC_materials_mtoon'],
        ...scene,
        scenes: [{ nodes: [0, 1, 2] }],
        nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 0 }],
        meshes: [
          {
            primitives: [
              {
                // (normals and tangents: the parser makes no variant of the material, so every texture clone here
                // is three-vrm's)
                attributes: tangents ? { POSITION: 0, NORMAL: 0, TANGENT: 1 } : { POSITION: 0, NORMAL: 0 },
                material: 0,
              },
            ],
          },
        ],
        materials: [
          {
            pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
            extensions: {
              VRMC_materials_mtoon: {
                specVersion: '1.0',
                shadeMultiplyTexture: { index: 0 },
                rimMultiplyTexture: { index: 0 },
              },
            },
          },
        ],
        textures: [{ source: 0 }],
        images: [{ bufferView: 2, mimeType: 'image/png', extras: { list: Array(300).fill({}) } }],
        accessors: [
          vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] }),
          { bufferView: 1, componentType: 5126, type: 'VEC4', count: 3 },
        ],
        bufferViews: [
          { buffer: 0, byteLength: 36 },
          { buffer: 0, byteOffset: 36, byteLength: 48 },
          { buffer: 0, byteOffset: 84, byteLength: header.length },
        ],
        buffers: [{ byteLength: bin.length }],
        extensions: {
          VRMC_vrm: {
            specVersion: '1.0',
            expressions: {
              custom: { a: { textureTransformBinds: [{ material: 0, scale: [2, 2] }, { material: 0 }] } },
            },
          },
        },
      },
      bin
    )
  const { textureBindCopyBytes } = checkGLTF(file(true)).vrm
  let copied = 0
  let clones = 0
  const clone = Texture.prototype.clone
  t.mock.method(Texture.prototype, 'clone', function () {
    clones++
    copied += jsonCopyBytes(JSON.stringify(this.userData))
    return clone.call(this)
  })
  await parse(file(true), { vrm: true })
  // (two binds, the material on three meshes, three of its slots holding a texture)
  assert.equal(clones, 2 * 3 * 3)
  assert.ok(textureBindCopyBytes >= copied, `${textureBindCopyBytes} counted, ${copied} copied`)
  // without tangents the parser makes a variant of the material (a clone): MToon's clone clones each texture in its
  // uniforms too, each with its copy of the texture's userData, charged where it is made
  clones = 0
  const { charges } = await parse(file(false), { vrm: true })
  assert.equal(clones, 3 + 2 * 3 * 3)
  const textureCopy = jsonCopyBytes(JSON.stringify({ list: Array(300).fill({}), mimeType: 'image/png' }))
  const variant = charges.filter(c => c.what === 'userData copy' && c.kind === 'bytes' && c.n === textureCopy)
  assert.equal(variant.length, 3, 'each texture of the variant')
  assert.equal(charges.filter(c => c.kind === 'count' && c.what === 'textures').length, 1 + 3)
})

test('a parse past its time limit is refused at the next charge (a monotonic clock, checked as it goes)', async () => {
  // a clock that moves 1 s per look: the bundled avatar's parse (a few milliseconds here) would pass 10 s
  let time = 0
  const bytes = fs.readFileSync(new URL('../src/world/assets/avatar.vrm', import.meta.url))
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const charges = []
  const budget = createGLTFBudget({
    fileBytes: file.byteLength,
    now: () => (time += 1000),
    onCharge: (kind, n, what, total) => charges.push({ kind, what, total }),
  })
  const loader = new GLTFLoader()
  loader.register(parser => new VRMLoaderPlugin(parser))
  await assert.rejects(loader.parseAsync(file, '', budget), /the parse took more than 10 s \(at /)
  assert.equal(charges.filter(c => c.kind === 'refused' && /took more than/.test(c.total)).length, 1, 'refused once')
  // and on a real clock the avatar is far inside it
  const started = performance.now()
  const real = createGLTFBudget({ fileBytes: file.byteLength })
  const timed = new GLTFLoader()
  timed.register(parser => new VRMLoaderPlugin(parser))
  await timed.parseAsync(file, '', real)
  assert.ok(performance.now() - started < GLTF_LIMITS.parseMilliseconds / 10)
})

test('three-vrm makes what checkGLTF counts: joints over the parsed objects, morph binds walking subtrees', async t => {
  t.mock.method(console, 'warn', () => {})
  const positions = new Uint8Array(36)
  const buffers = {
    accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  }
  // Codex's probe: one bone listed on a node whose mesh has 21 primitives, and a collider below it (counted as one
  // joint and one collider visit; three-vrm made 23 of each)
  const springs = glb(
    {
      asset: { version: '2.0' },
      extensionsUsed: ['VRM'],
      ...scene,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: Array.from({ length: 21 }, () => ({ attributes: { POSITION: 0 } })) }],
      ...buffers,
      extensions: {
        VRM: {
          secondaryAnimation: {
            colliderGroups: [{ node: 0, colliders: [{ radius: 1 }] }],
            boneGroups: [{ bones: [0], colliderGroups: [0] }],
          },
        },
      },
    },
    positions
  )
  const counted = checkGLTF(springs).vrm
  const { gltf } = await parse(springs, { vrm: true })
  const manager = gltf.userData.vrmSpringBoneManager
  let visits = 0
  for (const joint of manager.joints) for (const group of joint.colliderGroups) visits += group.colliders.length
  assert.deepEqual([manager.joints.size, visits], [counted.springJoints, counted.springColliderWork])
  assert.equal(manager.joints.size, 23)

  // VRM 1 morph binds on a node with 50 children: each bind walks the node's 51 objects (and first person once more)
  const binds = 20
  const expressions = glb(
    {
      asset: { version: '2.0' },
      extensionsUsed: ['VRMC_vrm'],
      ...scene,
      nodes: [
        { name: 'walked', mesh: 0, children: Array.from({ length: 50 }, (_, i) => i + 1) },
        ...Array(50).fill({}),
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] }] }],
      ...buffers,
      extensions: {
        VRMC_vrm: {
          specVersion: '1.0',
          expressions: { custom: { x: { morphTargetBinds: Array(binds).fill({ node: 0, index: 0 }) } } },
        },
      },
    },
    positions
  )
  const { expressionWork, firstPersonWork } = checkGLTF(expressions).vrm
  assert.equal(expressionWork, binds * 51)
  // the objects visited by walks from that node, while three-vrm runs
  let walked = 0
  const traverse = Object3D.prototype.traverse
  t.mock.method(Object3D.prototype, 'traverse', function (callback) {
    if (this.name !== 'walked' || callback.counted) return traverse.call(this, callback)
    const counting = object => {
      walked++
      callback(object)
    }
    counting.counted = true
    return traverse.call(this, counting)
  })
  await parse(expressions, { vrm: true })
  assert.equal(walked, (binds + 1) * 51)
  assert.equal(firstPersonWork, 51 + 51)

  // Codex's probe: outlined MToon primitives on one material whose extras hold many small objects; three-vrm clones
  // the material for each, and each clone copies its userData, and its textures' (an image's extras and its
  // mimeType: the reviewer's probe, whose mimeType was a document's string of any length). checkGLTF counts those
  // copies (at what a JSON copy holds, with 8 KiB for the uniforms) before the plugin runs: at least what they hold
  const header = png(16, 16)
  const bin = new Uint8Array(36 + header.length)
  bin.set(header, 36)
  const outlined = glb(
    {
      asset: { version: '2.0' },
      extensionsUsed: ['VRMC_materials_mtoon'],
      ...scene,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: Array(20).fill({ attributes: { POSITION: 0 }, material: 0 }) }],
      materials: [
        {
          extras: { list: Array.from({ length: 200 }, (_, i) => ({ i })) },
          pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
          extensions: {
            VRMC_materials_mtoon: {
              specVersion: '1.0',
              outlineWidthMode: 'worldCoordinates',
              outlineWidthFactor: 0.01,
              shadeMultiplyTexture: { index: 0 },
              matcapTexture: { index: 0 },
            },
          },
        },
      ],
      textures: [{ source: 0 }],
      images: [{ bufferView: 1, mimeType: 'image/png', extras: { list: Array(300).fill({}) } }],
      accessors: buffers.accessors,
      bufferViews: [
        { buffer: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: header.length },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  )
  const { outlineCopyBytes } = checkGLTF(outlined).vrm
  const parsed = await parse(outlined, { vrm: true })
  const copies = new Set()
  parsed.gltf.scene.traverse(object => [object.material ?? []].flat().forEach(m => m.isOutline && copies.add(m)))
  let copied = 0
  let textures = 0
  for (const material of copies) {
    copied += jsonCopyBytes(JSON.stringify(material.userData))
    for (const uniform of Object.values(material.uniforms)) {
      if (!uniform.value?.isTexture) continue
      assert.equal(uniform.value.userData.mimeType, 'image/png')
      copied += jsonCopyBytes(JSON.stringify(uniform.value.userData))
      textures++
    }
  }
  assert.equal(copies.size, 20)
  assert.equal(textures, 20 * 3, 'three texture slots of each outline')
  assert.ok(outlineCopyBytes >= copied, `${outlineCopyBytes} counted, ${copied} copied`)
})

// a binary chunk built view by view (each 4-byte aligned)
function chunks() {
  const parts = []
  const bufferViews = []
  let length = 0
  return {
    view(array) {
      length = Math.ceil(length / 4) * 4
      bufferViews.push({ buffer: 0, byteOffset: length, byteLength: array.byteLength })
      parts.push([length, new Uint8Array(array.buffer, array.byteOffset, array.byteLength)])
      length += array.byteLength
      return bufferViews.length - 1
    },
    done() {
      const bin = new Uint8Array(length)
      for (const [at, bytes] of parts) bin.set(bytes, at)
      return { bin, bufferViews, buffers: [{ byteLength: length }] }
    },
  }
}

// the mesh shape of VRoid's AvatarSample_A, the largest of the sample avatars measured: a face of 10 primitives
// sharing 2054 vertices and 56 morph targets (positions and normals), and a hair mesh of 73 primitives sharing
// 8056 vertices, all skinned; each primitive its own indices (so its own geometry, and its own morph texture)
function vroidShaped() {
  const b = chunks()
  const accessors = []
  const add = (array, def) => accessors.push({ bufferView: b.view(array), ...def }) - 1
  const skinnedMesh = (vertices, primitiveCount, targetCount) => {
    const weights = new Float32Array(vertices * 4)
    for (let i = 0; i < vertices; i++) weights[i * 4] = 1
    const attributes = {
      POSITION: add(new Float32Array(vertices * 3), vec3(vertices, { min: [0, 0, 0], max: [0, 0, 0] })),
      NORMAL: add(new Float32Array(vertices * 3), vec3(vertices)),
      TEXCOORD_0: add(new Float32Array(vertices * 2), { componentType: 5126, type: 'VEC2', count: vertices }),
      JOINTS_0: add(new Uint16Array(vertices * 4), { componentType: 5123, type: 'VEC4', count: vertices }),
      WEIGHTS_0: add(weights, { componentType: 5126, type: 'VEC4', count: vertices }),
    }
    const targets = Array.from({ length: targetCount }, () => ({
      POSITION: add(new Float32Array(vertices * 3), vec3(vertices, { min: [0, 0, 0], max: [0, 0, 0] })),
      NORMAL: add(new Float32Array(vertices * 3), vec3(vertices)),
    }))
    const triangles = Math.floor(vertices / primitiveCount / 3) * 3
    return {
      primitives: Array.from({ length: primitiveCount }, (_, p) => ({
        attributes,
        indices: add(
          Uint32Array.from({ length: triangles }, (_, i) => (p * triangles + i) % vertices),
          {
            componentType: 5125,
            type: 'SCALAR',
            count: triangles,
          }
        ),
        ...(targetCount ? { targets } : {}),
        material: 0,
      })),
      ...(targetCount ? { weights: Array(targetCount).fill(0) } : {}),
    }
  }
  const face = skinnedMesh(2054, 10, 56)
  const hair = skinnedMesh(8056, 73, 0)
  const inverse = add(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), {
    componentType: 5126,
    type: 'MAT4',
    count: 1,
  })
  const { bin, bufferViews, buffers } = b.done()
  return glb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 1, 2] }],
      nodes: [{ name: 'Face', mesh: 0, skin: 0 }, { name: 'Hair', mesh: 1, skin: 0 }, { name: 'Head' }],
      skins: [{ joints: [2], inverseBindMatrices: inverse }],
      meshes: [face, hair],
      materials: [{}],
      accessors,
      bufferViews,
      buffers,
    },
    bin
  )
}

test('an avatar of VRoid’s shape loads within the limits, with three times its cost to spare on each meter', async () => {
  // measured on VRoid's sample avatars (see the CHANGELOG): this one's morph textures are its largest cost. Ten face
  // geometries, each 2054 x 2 texels (positions, normals) over 56 layers: past a 4096-texel row, so with the renderer's
  // maximum texture size not known the charge is the most any size would take (two rows), 7,340,032 bytes each
  const file = vroidShaped()
  checkGLTF(file, GLTF_LIMITS, createGLTFBudget({ fileBytes: file.byteLength }))
  const { gltf, budget, charges } = await parse(file, { vrm: true })
  assert.equal(gltf.scene.getObjectByName('Face').children.length, 10)
  const morph = charges.filter(c => c.what === 'morph target texture')
  assert.deepEqual(
    morph.map(c => c.n),
    Array(10).fill(8192 * 16 * 56)
  )
  assert.ok(budget.used.bytes - 2 * file.byteLength <= GLTF_LIMITS.allocatedBytes / 3, `${budget.used.bytes} bytes`)
  assert.ok(budget.used.work <= budget.maxWork / 3, `${budget.used.work} steps of ${budget.maxWork}`)
  // with the renderer's size known (16384), one row each: 4108 texels
  const sized = createGLTFBudget({ fileBytes: file.byteLength, maxTextureSize: 16384, onCharge: () => {} })
  await new GLTFLoader().parseAsync(file, '', sized)
  assert.equal(sized.used.bytes - budget.used.bytes, 10 * (4108 - 8192) * 16 * 56)
  // three.js's texels per vertex: 1 for positions, 2 once there are normals, 3 once there are colours (the slots
  // before the last are kept whether used or not): normals alone are 2
  const positions = new Uint8Array(36)
  const normalsOnly = glb(
    {
      asset: { version: '2.0' },
      ...scene,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 0 }, targets: [{ NORMAL: 0 }, { NORMAL: 0 }] }] }],
      accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    },
    positions
  )
  const normals = await parse(normalsOnly)
  assert.deepEqual(
    normals.charges.filter(c => c.what === 'morph target texture').map(c => c.n),
    [3 * 2 * 16 * 2]
  )
})

test('the bundled files parse within the budget, and what they are charged is the same every time', async t => {
  t.mock.method(console, 'warn', () => {})
  // measured with this parser and three-vrm 3.3.3, as the client loads a file (the check, then the parse, charged to
  // one budget, with the VRM plugin registered); a change in what is charged (a parser update that adds or bypasses
  // a charged path) shows here
  for (const [name, expected] of [
    [
      'world/assets/avatar.vrm',
      {
        bytes: 17764666,
        pixels: 4194304,
        work: 1035591,
        counts: {
          scenes: 1,
          meshes: 1,
          textures: 1,
          primitives: 1,
          skins: 1,
          joints: 59,
          nodes: 61,
          images: 1,
          materials: 2,
          meshInstances: 1,
          influences: 57,
        },
      },
    ],
    [
      'world/assets/mp-idle.glb',
      {
        bytes: 183188,
        pixels: 0,
        work: 93996,
        counts: { scenes: 1, animations: 1, channels: 198, nodes: 67, tracks: 198 },
      },
    ],
    [
      'world/assets/crash-block.glb',
      {
        bytes: 9392,
        pixels: 65536,
        work: 1633,
        counts: {
          scenes: 1,
          meshes: 1,
          textures: 1,
          primitives: 1,
          images: 1,
          materials: 2,
          meshInstances: 1,
          nodes: 1,
        },
      },
    ],
  ]) {
    const bytes = fs.readFileSync(new URL(`../src/${name}`, import.meta.url))
    const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const { budget } = await parse(file, { vrm: true, check: true }) // as the client loads every file
    assert.equal(budget.used.bytes, expected.bytes, `${name} bytes`)
    assert.equal(budget.used.pixels, expected.pixels, `${name} pixels`)
    assert.equal(budget.used.work, expected.work, `${name} work`)
    assert.deepEqual(budget.used.counts, expected.counts, `${name} counts`)
    assert.ok(budget.used.bytes <= budget.maxBytes)
  }
})
