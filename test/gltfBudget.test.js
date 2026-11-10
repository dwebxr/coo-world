import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { Object3D, SkinnedMesh } from 'three'
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
  assert.ok(copies.before.filter(c => c.what === 'userData copy' && c.kind === 'bytes').every(c => c.n >= 40000))
  // each copy also goes through every character of it: a step each
  const copied = copies.before.filter(c => c.what === 'userData copy')
  for (let i = 0; i + 1 < copied.length; i += 2)
    assert.deepEqual([copied[i + 1].kind, copied[i + 1].n], ['work', copied[i].n / 2])
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
  const animated = (timesView, interpolation = 'CUBICSPLINE', values = 6) =>
    glb(
      {
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
      },
      bin
    )
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
    [30, 30, 30, 30]
  )
  assert.deepEqual(
    charges.filter(c => c.what === 'emptying a group').map(c => c.n),
    [4 + 3 + 2 + 1]
  )
})

test('a skin has an inverse bind matrix for each joint in a plain array, asserted on the array itself', async () => {
  // two joints and one matrix: the parser would read the second joint's past the array (not checked before here)
  const file = skinned({ primitives: 1, vertices: 3 })
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(file, 20, new DataView(file).getUint32(12, true))))
  json.skins[0].joints = [1, 1]
  const binStart = 28 + new DataView(file).getUint32(12, true)
  await refusedAt(glb(json, new Uint8Array(file, binStart)), 'skin', /skin 0 has no inverse bind matrix for each joint/)
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
  // the material for each, and each clone copies its userData. checkGLTF counts those copies (as JSON text, with 8 KiB
  // for the uniforms) before the plugin runs: at least what the clones hold
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
          extensions: {
            VRMC_materials_mtoon: {
              specVersion: '1.0',
              outlineWidthMode: 'worldCoordinates',
              outlineWidthFactor: 0.01,
            },
          },
        },
      ],
      ...buffers,
    },
    positions
  )
  const { outlineCopyBytes } = checkGLTF(outlined).vrm
  const parsed = await parse(outlined, { vrm: true })
  const copies = new Set()
  parsed.gltf.scene.traverse(object => [object.material ?? []].flat().forEach(m => m.isOutline && copies.add(m)))
  let copied = 0
  for (const material of copies) copied += 2 * JSON.stringify(material.userData).length
  assert.equal(copies.size, 20)
  assert.ok(outlineCopyBytes >= copied, `${outlineCopyBytes} counted, ${copied} copied`)
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
        work: 981151,
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
        work: 25993,
        counts: { scenes: 1, animations: 1, channels: 198, nodes: 67, tracks: 198 },
      },
    ],
    [
      'world/assets/crash-block.glb',
      {
        bytes: 9356,
        pixels: 65536,
        work: 244,
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
