import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { createGLTFBudget, GLTF_LIMITS } from '../src/core/extras/gltfLimits.js'
import { png, jpeg } from './lib/imageBytes.mjs'

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

// a .glb of the JSON and binary chunk given
function glb(json, bin = new Uint8Array(0)) {
  const pad = (bytes, fill) => {
    const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill)
    out.set(bytes)
    return out
  }
  const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const binBytes = pad(bin, 0)
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  view.setUint32(20 + jsonBytes.length, binBytes.length, true)
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true)
  out.set(binBytes, 28 + jsonBytes.length)
  return out.buffer
}

// parses with a budget that records each charge; resolves to { gltf, budget, charges } or rejects with the error
// (which carries the charges)
async function parse(file, { limits = GLTF_LIMITS, vrm = false } = {}) {
  const charges = []
  const budget = createGLTFBudget({
    fileBytes: file.byteLength,
    limits,
    onCharge: (kind, n, what, total) => charges.push({ kind, n, what, total }),
  })
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
// the parse still charge afterwards is refused too, and allocates nothing)
async function refusedAt(file, what, reason, options) {
  const err = await parse(file, options).then(
    () => assert.fail('the parse was not refused'),
    error => error
  )
  assert.equal(err.isGLTFLimit, true, String(err))
  assert.match(err.message, reason)
  const first = err.charges.findIndex(c => c.kind === 'refused')
  assert.equal(err.charges[first].what, what, `refused at ${err.charges[first].what}`)
  // the charge that passed the limit is recorded just before its refusal
  const cause = err.charges[first - 1]?.what === what && err.charges[first - 1].kind !== 'refused' ? first - 1 : first
  const bytes = err.charges.slice(0, cause).filter(c => c.kind === 'bytes')
  assert.ok((bytes.at(-1)?.total ?? 0) <= err.budget.maxBytes, 'no allocation before the refusal passed the limit')
  const later = err.charges.slice(first + 1).filter(c => c.kind === 'bytes')
  assert.ok(
    later.every(c => c.total > err.budget.maxBytes),
    'every byte charge after it is refused'
  )
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
  const { gltf } = await parse(file)
  const mesh = gltf.scene.getObjectByProperty('isMesh', true)
  assert.equal(mesh.morphTargetInfluences.length, 1, 'the influences were not extended')
  assert.equal(mesh.morphTargetInfluences[0], 1)
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
  // 20,000 characters of extras copied into every instance (as JSON, with each clone)
  const extras = { text: 'x'.repeat(20000) }
  const limits = { ...GLTF_LIMITS, allocatedBytes: 4 * MiB }
  const copies = await refusedAt(glb(base(200, extras), positions), 'userData copy', /would allocate more than/, {
    limits,
  })
  assert.ok(copies.before.filter(c => c.what === 'userData copy').every(c => c.n >= 40000))
})

test('scenes, cameras and other collections the parser creates eagerly are counted', async () => {
  const scenes = glb({ asset: { version: '2.0' }, scenes: Array.from({ length: 1000 }, () => ({})) })
  const err = await refusedAt(scenes, 'scenes', /scenes: 65, more than 64/)
  assert.equal(err.before.filter(c => c.what === 'scenes').length, 65, 'the 65th scene was refused before it was made')
  assert.equal(err.budget.used.counts.scenes, 65)
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
})

test('the bundled files parse within the budget, and what they are charged is the same every time', async t => {
  t.mock.method(console, 'warn', () => {})
  // measured with this parser and three-vrm 3.3.3; a change in what is charged (a parser update that adds or
  // bypasses a charged path) shows here
  for (const [name, expected] of [
    [
      'world/assets/avatar.vrm',
      {
        bytes: 17762942,
        pixels: 4194304,
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
      { bytes: 165608, pixels: 0, counts: { scenes: 1, animations: 1, channels: 198, nodes: 67, tracks: 198 } },
    ],
    [
      'world/assets/crash-block.glb',
      {
        bytes: 9356,
        pixels: 65536,
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
    const { budget } = await parse(file, { vrm: name.endsWith('.vrm') })
    assert.equal(budget.used.bytes, expected.bytes, `${name} bytes`)
    assert.equal(budget.used.pixels, expected.pixels, `${name} pixels`)
    assert.deepEqual(budget.used.counts, expected.counts, `${name} counts`)
    assert.ok(budget.used.bytes <= budget.maxBytes)
  }
})
