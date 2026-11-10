import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { Object3D } from 'three'
import { checkGLTF, createGLTFBudget, GLTF_LIMITS } from '../src/core/extras/gltfLimits.js'
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
  assert.equal(err.charges[first].what, what, `refused at ${err.charges[first].what}`)
  // the charge that passed the limit is recorded just before its refusal (a document rule has none)
  const cause = err.charges[first - 1]?.what === what && err.charges[first - 1].kind !== 'refused' ? first - 1 : first
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
  const limits = { ...GLTF_LIMITS, work: 20000 }
  await refusedAt(walk(200), 'weights channel walk', /the parser would take more than 20000 steps \(at weights/, {
    limits,
  })
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
        work: 673,
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
        bytes: 165608,
        pixels: 0,
        work: 603,
        counts: { scenes: 1, animations: 1, channels: 198, nodes: 67, tracks: 198 },
      },
    ],
    [
      'world/assets/crash-block.glb',
      {
        bytes: 9356,
        pixels: 65536,
        work: 15,
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
    assert.equal(budget.used.work, expected.work, `${name} work`)
    assert.deepEqual(budget.used.counts, expected.counts, `${name} counts`)
    assert.ok(budget.used.bytes <= budget.maxBytes)
  }
})
