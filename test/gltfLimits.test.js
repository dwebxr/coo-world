import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  checkGLTF,
  readGLTF,
  createGLTFBudget,
  GLTF_LIMITS,
  GLTFLimitError,
  MTOON_TEXTURE_SLOTS,
  TEXTURE_TRANSFORM_SLOTS,
  jsonCopyBytes,
} from '../src/core/extras/gltfLimits.js'
import { MToonMaterial, VRMExpressionTextureTransformBind } from '@pixiv/three-vrm'
import { png, jpeg, gif } from './lib/imageBytes.mjs'

// Before parsing: the container and the document's structure, and three-vrm's work as its plugins expand it. (What
// the parser itself allocates is charged inside it: test/gltfBudget.test.js.) Tiny hand-written documents.
const MiB = 1024 * 1024
const text = json => new TextEncoder().encode(JSON.stringify(json))
const dataURI = bytes => `data:application/octet-stream;base64,${Buffer.alloc(bytes).toString('base64')}`
const doc = (extra = {}) => ({
  asset: { version: '2.0' },
  buffers: [{ byteLength: 36, uri: dataURI(36) }],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }],
  ...extra,
})
const refused = (json, reason, limits) => assert.throws(() => checkGLTF(text(json), limits), reason)

// a .glb: header, JSON chunk and, when given, a binary chunk of `bin` zeros
function glb(json, bin, { version = 2, length, extraChunks = [] } = {}) {
  const jsonBytes = text(json)
  const parts = [[0x4e4f534a, jsonBytes], ...extraChunks]
  if (bin !== undefined) parts.push([0x004e4942, new Uint8Array(bin)])
  const size = 12 + parts.reduce((sum, [, bytes]) => sum + 8 + bytes.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, version, true)
  view.setUint32(8, length ?? size, true)
  let at = 12
  for (const [type, bytes] of parts) {
    view.setUint32(at, bytes.length, true)
    view.setUint32(at + 4, type, true)
    out.set(bytes, at + 8)
    at += 8 + bytes.length
  }
  return out
}

test('the container: GLB header and chunks as the parser reads them, the JSON within its size and nesting', () => {
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 16 }],
    bufferViews: [{ buffer: 0, byteLength: 16 }],
  }
  assert.equal(readGLTF(glb(json, 16)).bin, 16)
  assert.ok(checkGLTF(glb(json, 16)))
  assert.throws(() => checkGLTF(glb(json)), /buffer 0 has no data in the file/)
  assert.throws(() => checkGLTF(glb(json, 16, { version: 1 })), /older than version 2/)
  assert.throws(() => checkGLTF(glb(json, 16, { length: 10000 })), /shorter than its header says/)
  assert.throws(() => checkGLTF(glb(json, 16).subarray(0, 10)), /header is cut short/)
  const cut = glb(json, 16)
  new DataView(cut.buffer).setUint32(12, 100000, true)
  assert.throws(() => checkGLTF(cut), /JSON chunk is cut short/)
  assert.throws(() => checkGLTF(glb(json, 16, { length: 12 })), /no JSON chunk/)
  assert.throws(
    () => checkGLTF(glb(json, 16), { ...GLTF_LIMITS, jsonBytes: 64 }),
    /JSON chunk is \d+ bytes, more than 64/
  )
  // nesting: 64 levels is the limit (deep extras would overflow recursive copies)
  let deep = 'x'
  for (let i = 0; i < 70; i++) deep = { deeper: deep }
  refused(doc({ extras: deep }), /the JSON nests 7\d deep, more than 64/)
  assert.ok(
    checkGLTF(new TextEncoder().encode(JSON.stringify(doc({ extras: { a: '{{{{{{{{{{[[[[[[[[' } })))),
    'brackets in strings do not count'
  )
  assert.throws(() => checkGLTF(new TextEncoder().encode('{"asset":')), /JSON does not parse/)
  assert.throws(() => checkGLTF(new TextEncoder().encode('[1]')), /JSON is not an object/)
  refused({ asset: { version: '1.0' } }, /not a glTF 2.0 document/)
  refused({ asset: { version: 2 } }, /not a glTF 2.0 document/)
  assert.ok(checkGLTF(new TextEncoder().encode('{"asset":{"version":"2.0"}}').buffer), 'an ArrayBuffer is accepted')
})

test('the structure: an index is a whole number in range (a string index is refused), a list is a real list', () => {
  for (const [extra, reason] of [
    // the string index the parser would coerce (texture.source "0" next to a KTX2 source)
    [
      {
        images: [{ uri: 'data:image/png;base64,AA==' }],
        textures: [{ source: '0', extensions: { KHR_texture_basisu: { source: 0 } } }],
      },
      /texture 0 source is not an index of images \("0"\)/,
    ],
    [{ textures: [{ source: 1.5 }], images: [{}, {}] }, /texture 0 source is not an index of images/],
    [{ textures: [{ source: -1 }] }, /not an index of images/],
    [{ scene: 3 }, /scene is not an index of scenes/],
    [{ nodes: [{ mesh: 0 }] }, /node 0 mesh is not an index of meshes/],
    [
      { meshes: [{ primitives: [{ attributes: { POSITION: '0' } }] }] },
      /attribute POSITION is not an index of accessors/,
    ],
    [
      { materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 2 } } }] },
      /material 0 baseColorTexture index is not an index of textures/,
    ],
    [
      { materials: [{ extensions: { KHR_materials_clearcoat: { clearcoatTexture: { index: '0' } } } }] },
      /clearcoatTexture index/,
    ],
    [{ skins: [{ joints: [0, 5] }], nodes: [{}] }, /skin 0 joint is not an index of nodes/],
    [
      { animations: [{ samplers: [{ input: 0, output: 9 }], channels: [] }] },
      /sampler 0 output is not an index of accessors/,
    ],
    [
      { animations: [{ samplers: [], channels: [{ sampler: 0, target: {} }] }] },
      /channel 0 sampler is not an index of its samplers/,
    ],
    // a `length` instead of a list: the parser used to loop over it (a billion writes from 279 bytes)
    [{ meshes: [{ weights: { length: 1e9 }, primitives: [] }] }, /mesh 0 weights is not a list/],
    [{ nodes: [{ weights: { length: 1e9 } }] }, /node 0 weights is not a list/],
    [{ meshes: [{ primitives: [{ attributes: {}, targets: { length: 1e9 } }] }] }, /targets is not a list/],
    [{ scenes: [{ nodes: { length: 5 } }] }, /scene 0 nodes is not a list/],
    [{ accessors: 'none' }, /accessors is not a list/],
    [{ nodes: [{ matrix: [1, 0, 0] }] }, /node 0 matrix does not have 16 numbers/],
    [{ nodes: [{ translation: [0, 'a', 0] }] }, /translation is not all numbers/],
    [{ meshes: [{ primitives: [{ attributes: {}, mode: 9 }] }] }, /unknown mode/],
    [{ accessors: [{ componentType: 5124, type: 'VEC3', count: 1 }] }, /invalid componentType or type/],
    [{ accessors: [{ componentType: 5126, type: 'VEC3' }] }, /accessor 0 has no count/],
    [{ accessors: [{ componentType: 5126, type: 'VEC3', count: -1 }] }, /accessor 0 count is not a whole number/],
    [
      {
        accessors: [
          {
            componentType: 5126,
            type: 'VEC3',
            count: 3,
            sparse: { count: 1, indices: { bufferView: 0, componentType: 5126 }, values: { bufferView: 0 } },
          },
        ],
      },
      /invalid sparse indices/,
    ],
    [{ bufferViews: [{ byteLength: 4 }] }, /bufferView 0 names no buffer/],
    [{ images: [{ uri: 'blob:https://world.example/1' }] }, /image 0 names a blob: URL/],
    [
      { buffers: [{ byteLength: 4, uri: 'https://elsewhere.example/big.bin' }] },
      /may not reference external files \(buffer 0\)/,
    ],
    [{ buffers: [{ byteLength: 4, uri: 'big.bin' }] }, /may not reference external files/],
  ]) {
    refused(doc(extra), reason)
  }
  // a list longer than the cap, and more morph targets on one primitive than the cap
  refused(doc({ nodes: Array(20).fill({}) }), /nodes has 20 entries, more than 16/, { ...GLTF_LIMITS, listLength: 16 })
  refused(
    doc({ meshes: [{ primitives: [{ attributes: {}, targets: Array(1025).fill({}) }] }] }),
    /targets has 1025 entries, more than 1024/
  )
  // a well-formed document with every kind of reference passes
  const full = doc({
    buffers: [{ byteLength: 140, uri: dataURI(140) }],
    bufferViews: [
      { buffer: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
      { buffer: 0, byteOffset: 44, byteLength: 64 },
      { buffer: 0, byteOffset: 108, byteLength: 8 },
      { buffer: 0, byteOffset: 116, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 },
      { bufferView: 1, componentType: 5123, type: 'SCALAR', count: 3 },
      { bufferView: 2, componentType: 5126, type: 'MAT4', count: 1 },
      { bufferView: 3, componentType: 5126, type: 'SCALAR', count: 2 },
      { bufferView: 4, componentType: 5126, type: 'VEC3', count: 2 },
    ],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { mesh: 0, children: [1], matrix: Array(16).fill(0) },
      { skin: 0, camera: 0, weights: [0.5] },
    ],
    meshes: [
      {
        weights: [0],
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4, targets: [{ POSITION: 0 }] }],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } },
        extensions: { KHR_materials_sheen: { sheenColorTexture: { index: 0 } } },
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{}],
    images: [{ bufferView: 0, mimeType: 'image/png' }],
    skins: [{ joints: [1], skeleton: 1, inverseBindMatrices: 2 }],
    cameras: [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }],
    animations: [
      { samplers: [{ input: 3, output: 4 }], channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }] },
    ],
  })
  assert.ok(checkGLTF(text(full)))
})

test('glTF 1.0 leftovers the vendored parser still honours are refused: animation parameters, buffer types', () => {
  // the parser resolves sampler input/output through `parameters` when it is there: other accessors than the ones
  // the sampler names
  refused(
    doc({ animations: [{ parameters: { TIME: 0 }, samplers: [], channels: [] }] }),
    /animation 0 has glTF 1.0 parameters/
  )
  refused(doc({ buffers: [{ byteLength: 36, uri: dataURI(36), type: 'arraybuffer' }] }), /buffer 0 has a glTF 1.0 type/)
})

test('required extensions must be ones this client loads; optional compression with fallback data is allowed', () => {
  for (const name of [
    'KHR_draco_mesh_compression',
    'EXT_meshopt_compression',
    'KHR_texture_basisu',
    'EXT_texture_avif',
    'MADE_UP_extension',
  ]) {
    refused(
      doc({ extensionsUsed: [name], extensionsRequired: [name] }),
      /requires an extension this client cannot load/
    )
  }
  for (const name of ['EXT_meshopt_compression', 'KHR_draco_mesh_compression', 'KHR_texture_basisu']) {
    assert.ok(checkGLTF(text(doc({ extensionsUsed: [name] }))), `optional ${name}`)
  }
  assert.ok(
    checkGLTF(text(doc({ extensionsUsed: ['KHR_texture_transform'], extensionsRequired: ['KHR_texture_transform'] })))
  )
  refused(doc({ extensionsRequired: [5] }), /extension name is not a string/)
  // each name once (the parser looks every used name up in the required list)
  refused(doc({ extensionsUsed: Array(3).fill('VRM') }), /an extension is named twice/)
  refused(doc({ extensionsUsed: ['VRM'], extensionsRequired: ['VRM', 'VRM'] }), /an extension is named twice/)
})

test('accessors are what the parser and three.js assume of them: animations, skins, primitives, strides', () => {
  // a document with two keyframes (times: accessor 0), a translation per keyframe (1), three per keyframe for
  // CUBICSPLINE (2), and a node whose mesh has two morph targets (accessors 3, 4)
  const floats = (type, count, bufferView, more = {}) => ({ bufferView, componentType: 5126, type, count, ...more })
  const animated = (sampler, path = 'translation', more = {}) =>
    doc({
      buffers: [{ byteLength: 400, uri: dataURI(400) }],
      bufferViews: [
        { buffer: 0, byteLength: 8 },
        { buffer: 0, byteOffset: 8, byteLength: 24 },
        { buffer: 0, byteOffset: 32, byteLength: 72 },
        { buffer: 0, byteOffset: 104, byteLength: 36 },
        { buffer: 0, byteOffset: 140, byteLength: 16 },
        { buffer: 0, byteOffset: 156, byteLength: 64 },
        { buffer: 0, byteOffset: 220, byteLength: 48 },
      ],
      accessors: [
        floats('SCALAR', 2, 0),
        floats('VEC3', 2, 1),
        floats('VEC3', 6, 2),
        floats('VEC3', 3, 3),
        floats('SCALAR', 4, 4),
        floats('MAT4', 1, 5),
        floats('VEC4', 3, 6),
      ],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 3 }, targets: [{ POSITION: 3 }, { POSITION: 3 }] }] }],
      animations: [
        { samplers: [{ input: 0, output: 1, ...sampler }], channels: [{ sampler: 0, target: { node: 0, path } }] },
      ],
      ...more,
    })
  assert.ok(checkGLTF(text(animated({}))))
  assert.ok(checkGLTF(text(animated({ interpolation: 'CUBICSPLINE', output: 2 }))))
  assert.ok(checkGLTF(text(animated({ interpolation: 'STEP' }))))
  assert.ok(checkGLTF(text(animated({ output: 4 }, 'weights'))), 'two weights per keyframe')
  // Codex's probe: 7 values for 2 CUBICSPLINE keyframes is a value size of 10.5, and three's interpolant looped on
  // `i !== 3.5` forever
  const seven = animated({ interpolation: 'CUBICSPLINE', output: 7 })
  seven.bufferViews.push({ buffer: 0, byteOffset: 268, byteLength: 84 })
  seven.accessors.push(floats('VEC3', 7, 7))
  refused(seven, /channel 0 output does not have 3 values per keyframe/)
  for (const [json, reason] of [
    [animated({ interpolation: 'CUBICSPLINE' }), /does not have 3 values per keyframe/],
    [animated({ output: 2 }), /does not have 1 values per keyframe/],
    [animated({ output: 1 }, 'weights'), /output is not SCALAR values for weights/],
    [animated({ output: 0 }, 'weights'), /does not have 2 values per keyframe/],
    [animated({ output: 1 }, 'rotation'), /output is not VEC4 values for rotation/],
    [animated({ output: 6 }, 'rotation'), /does not have 1 values per keyframe/],
    [animated({ output: 4 }, 'scale'), /output is not VEC3 values for scale/],
    [animated({}, 'colour'), /animates a path this client cannot play/],
    [animated({ input: 1 }), /sampler 0 input is not a float time per keyframe/],
    [animated({ input: 4 }), /does not have 1 values per keyframe/],
    [animated({ interpolation: 'SMOOTH' }), /sampler 0 has an unknown interpolation/],
    [animated({ input: undefined }), /sampler 0 has no input or output/],
  ]) {
    refused(json, reason)
  }
  refused(
    { ...animated({ output: 4 }, 'weights'), nodes: [{}] },
    /animates the weights of a node without morph targets/
  )
  // integer outputs only where the path allows them (normalized), not for translation
  const normalizedRotation = animated({ output: 6 }, 'rotation')
  normalizedRotation.accessors[6] = { bufferView: 6, componentType: 5122, type: 'VEC4', count: 2, normalized: true }
  assert.ok(checkGLTF(text(normalizedRotation)))
  const integerTranslation = animated({})
  integerTranslation.accessors[1] = { bufferView: 1, componentType: 5122, type: 'VEC3', count: 2, normalized: true }
  refused(integerTranslation, /output is not VEC3 values for translation/)
  // a channel without a node (KHR_animation_pointer's) is skipped by the parser, and not checked
  const pointer = animated({ output: 4 })
  pointer.animations[0].channels[0].target = { path: 'pointer' }
  assert.ok(checkGLTF(text(pointer)))

  // skins: a float 4x4 inverse bind matrix per joint
  const skinned = matrices => animated({}, 'translation', { skins: [{ joints: [0], inverseBindMatrices: matrices }] })
  assert.ok(checkGLTF(text(skinned(5))))
  refused(skinned(3), /skin 0 inverseBindMatrices are not a float 4x4 matrix per joint/)
  refused(
    animated({}, 'translation', { skins: [{ joints: [0, 0], inverseBindMatrices: 5 }] }),
    /not a float 4x4 matrix per joint/
  )
  // Codex's probe: times of 2 keyframes at a byteStride of 8 reached the track as 4 floats (with 6 CUBICSPLINE
  // values, a sample size of 1.5). An animation's accessors, and a skin's matrices, are read as their arrays: they
  // may not be interleaved (a stride equal to the element size is not interleaving)
  const interleaved = (view, accessor, more) => {
    const json = animated(more?.sampler ?? {}, 'translation', more?.extra)
    json.bufferViews[view] = {
      ...json.bufferViews[view],
      byteLength: json.bufferViews[view].byteLength * 2,
      ...accessor,
    }
    return json
  }
  refused(interleaved(0, { byteStride: 8 }), /animation 0 sampler 0 input or output is interleaved/)
  refused(interleaved(1, { byteStride: 16 }), /input or output is interleaved/)
  assert.ok(checkGLTF(text(interleaved(0, { byteStride: 4 }))), 'a stride of one element')
  refused(
    interleaved(5, { byteStride: 128 }, { extra: { skins: [{ joints: [0], inverseBindMatrices: 5 }] } }),
    /skin 0 inverseBindMatrices are interleaved/
  )

  // primitives: attributes of one count, targets of the same, indices unsigned and not interleaved, as many
  // targets on every primitive of a mesh
  const meshes = (primitives, more = {}) => animated({}, 'translation', { meshes: [{ primitives }], ...more })
  for (const [primitives, reason] of [
    [[{ attributes: { POSITION: 3, NORMAL: 1 } }], /primitive 0 attributes have different counts/],
    [
      [{ attributes: { POSITION: 3 }, targets: [{ POSITION: 1 }] }],
      /primitive 0 target 0 attributes have different counts/,
    ],
    [[{ attributes: { POSITION: 3 }, indices: 3 }], /indices are not unsigned whole numbers/],
    [[{ attributes: { POSITION: 3 }, indices: 0 }], /indices are not unsigned whole numbers/],
    [
      [
        { attributes: { POSITION: 3 }, targets: [{ POSITION: 3 }] },
        { attributes: { POSITION: 3 }, targets: [] },
      ],
      /mesh 0 primitives have different numbers of morph targets/,
    ],
    [[{}], /primitive 0 has no attributes/],
  ]) {
    refused(meshes(primitives), reason)
  }
  const interleavedIndices = meshes([{ attributes: { POSITION: 3 }, indices: 7 }])
  interleavedIndices.bufferViews.push({ buffer: 0, byteOffset: 268, byteLength: 12, byteStride: 4 })
  interleavedIndices.accessors.push({ bufferView: 7, componentType: 5123, type: 'SCALAR', count: 3 })
  refused(interleavedIndices, /primitive 0 indices are interleaved/)
  // instancing: one count of instances, transforms of their types
  const instanced = attributes =>
    animated({}, 'translation', { nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes } } }] })
  assert.ok(checkGLTF(text(instanced({ TRANSLATION: 1 }))))
  refused(instanced({ TRANSLATION: 1, SCALE: 3 }), /node 0 instancing attributes have different counts/)
  refused(instanced({ ROTATION: 1 }), /node 0 instancing ROTATION is not VEC4/)
  // the reviewer's probe: 100,000 instancing attributes on an empty accessor, for each of 100 primitives, made
  // 10,000,000 setAttribute calls for 6,462 steps. An accessor has at least one element, and a node at most 16
  // instancing attributes (the parser charges each, per primitive: gltfBudget.test.js)
  const many = instanced(Object.fromEntries(Array.from({ length: 17 }, (_, k) => [`_A${k}`, 1])))
  refused(many, /node 0 has 17 instancing attributes, more than 16/)
  assert.ok(checkGLTF(text(instanced(Object.fromEntries(Array.from({ length: 16 }, (_, k) => [`_A${k}`, 1]))))))
  refused(doc({ accessors: [{ componentType: 5126, type: 'VEC3', count: 0 }] }), /accessor 0 has no elements/)

  // strides and lengths: what fits in the bufferView as the parser reads it
  const strided = (view, accessor) =>
    doc({
      bufferViews: [{ buffer: 0, byteLength: 36, ...view }],
      accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, ...accessor }],
    })
  assert.ok(checkGLTF(text(strided({ byteStride: 12 }, {}))))
  assert.ok(
    checkGLTF(text(strided({ byteStride: 16 }, { count: 2 }))),
    'interleaved, the last element short of a stride'
  )
  for (const [view, accessor, reason] of [
    [{ byteStride: 2 }, {}, /bufferView 0 byteStride is not a multiple of 4 from 4 to 252/],
    [{ byteStride: 14 }, {}, /not a multiple of 4/],
    [{ byteStride: 256 }, {}, /not a multiple of 4/],
    [{ byteStride: 8 }, {}, /accessor 0 elements do not fit the byteStride of bufferView 0/],
    [{ byteStride: 12 }, { byteOffset: 4 }, /elements do not fit the byteStride/],
    [{}, { byteOffset: 2 }, /accessor 0 byteOffset is not a multiple of its component size/],
    [{}, { count: 4 }, /accessor 0 is longer than bufferView 0/],
    [{ byteStride: 16 }, {}, /accessor 0 is longer than bufferView 0/],
  ]) {
    refused(strided(view, accessor), reason)
  }
  refused(
    doc({ accessors: [{ componentType: 5126, type: 'VEC3', count: 3, byteOffset: 4 }] }),
    /byteOffset without a bufferView/
  )
  refused(
    doc({ accessors: [{ componentType: 5126, type: 'VEC3', count: 3, normalized: 1 }] }),
    /normalized is not true or false/
  )
  // sparse: no more entries than elements (the parser refuses indices that are not strictly increasing in range,
  // gltfBudget.test.js), indices and values within their bufferViews
  const sparse = (count, more = {}) =>
    doc({
      bufferViews: [
        { buffer: 0, byteLength: 12 },
        { buffer: 0, byteOffset: 12, byteLength: 24 },
      ],
      accessors: [
        {
          componentType: 5126,
          type: 'VEC3',
          count: 2,
          sparse: { count, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 }, ...more },
        },
      ],
    })
  assert.ok(checkGLTF(text(sparse(2))))
  refused(sparse(3), /accessor 0 has more sparse entries than elements/)
  refused(
    sparse(2, { values: { bufferView: 1, byteOffset: 4 } }),
    /accessor 0 sparse values are longer than their bufferView/
  )
  refused(
    sparse(2, { indices: { bufferView: 0, componentType: 5123, byteOffset: 1 } }),
    /sparse indices byteOffset is not aligned/
  )
})

test('the check is metered too, and linear in the document: no part of loading a file runs unmetered', t => {
  // given the file's budget, the check charges a step per entry it goes through, and looks at its clock
  const json = doc({ nodes: Array.from({ length: 1000 }, () => ({})), scenes: [{ nodes: [0] }] })
  const charged = new Map()
  const budget = createGLTFBudget({
    fileBytes: text(json).byteLength,
    onCharge: (kind, n, what) => kind === 'work' && charged.set(what, (charged.get(what) || 0) + n),
  })
  checkGLTF(text(json), GLTF_LIMITS, budget)
  assert.equal(charged.get('the JSON'), JSON.stringify(json).length)
  assert.equal(charged.get('nodes'), 1000)
  assert.equal(charged.get('node entries'), 1000)
  let now = 0
  const slow = createGLTFBudget({ now: () => (now += 1000), limits: { ...GLTF_LIMITS, work: 10 } })
  assert.throws(
    () => checkGLTF(text(json), GLTF_LIMITS, slow),
    /the parser would take more than 10 steps|took more than/
  )
  // (work looks at the clock each 65,536 steps: a document of 70,000 nodes)
  const late = createGLTFBudget({ now: () => (now += 20000) })
  const big = doc({ nodes: Array.from({ length: 70000 }, () => ({})) })
  assert.throws(() => checkGLTF(text(big), GLTF_LIMITS, late), /the parse took more than 10 s/)
  // the reviewer's probe: 4000 textures naming one image whose extras are 1 MB stringified it 4000 times (3 s; with
  // 300,000 textures, half an hour) before any budget existed. Each image's extras are measured once now (sized as
  // the image's userData, then as what a clone of its texture copies); extras are at most 64 KiB an object now
  const extras = doc({
    images: [{ uri: 'data:image/png;base64,AA==', extras: { s: 'x'.repeat(60000) } }],
    textures: Array.from({ length: 4000 }, () => ({ source: 0 })),
  })
  const extrasFile = text(extras)
  let measured = 0
  const stringify = JSON.stringify
  t.mock.method(JSON, 'stringify', (...args) => {
    const out = stringify(...args)
    if (out && out.length > 60000) measured++
    return out
  })
  checkGLTF(extrasFile)
  assert.equal(measured, 2, `the large extras were stringified ${measured} times`)
  t.mock.restoreAll()
  // nodes x primitives: 20,000 nodes using one mesh of 5,000 primitives were counted node by node, primitive by
  // primitive (100,000,000 steps, seconds)
  const wide = doc({
    nodes: Array.from({ length: 20000 }, () => ({ mesh: 0 })),
    meshes: [{ primitives: Array.from({ length: 5000 }, () => ({ attributes: { POSITION: 0 } })) }],
  })
  const started = performance.now()
  assert.ok(checkGLTF(text(wide)))
  assert.ok(performance.now() - started < 1500, 'counted per mesh, times its uses')
  // and the most joints on one object of 130,000 nodes (a spread of that many arguments overflowed the call)
  const many = doc({
    nodes: [{ children: Array.from({ length: 129999 }, (_, i) => i + 1) }, ...Array(129999).fill({})],
    extensions: { VRM: { secondaryAnimation: { boneGroups: [{ bones: [0] }] } } },
  })
  assert.throws(() => checkGLTF(text(many)), /three-vrm springJoints: 130000, more than 16384/)
})

test('the node hierarchy is a tree of bounded depth', () => {
  for (const nodes of [
    [{ children: [0] }],
    [{ children: [1] }, { children: [0] }],
    [{ children: [2] }, { children: [2] }, {}],
    [{}, { children: [2] }, { children: [3] }, { children: [1] }],
  ]) {
    refused(doc({ nodes }), /not a tree/)
  }
  const chain = n => Array.from({ length: n }, (_, i) => (i < n - 1 ? { children: [i + 1] } : {}))
  assert.equal(checkGLTF(text(doc({ nodes: chain(256) }))).nodes, 256)
  // a chain of thousands overflowed the parser's recursive node loading; it is refused cleanly instead
  refused(doc({ nodes: chain(3000) }), /the node hierarchy is more than 256 deep/)
  // a wide tree is fine (and checked in linear time)
  const wide = [{ children: Array.from({ length: 60000 }, (_, i) => i + 1) }, ...Array(60000).fill({})]
  assert.equal(checkGLTF(text(doc({ nodes: wide }))).nodes, 60001)
  // a scene's roots: each once, and a child of no node. The parser re-parents a root it meets again, a search and a
  // splice of its old parent's children each time (Codex's probe: 1000 roots listed twice shifted 999,000 entries);
  // such a scene never loaded as written. A root shared by two scenes is valid glTF (each move is charged:
  // gltfBudget.test.js loads one)
  const roots = (scenes, nodes = [{}, {}, {}]) => doc({ nodes, scenes: scenes.map(list => ({ nodes: list })) })
  assert.ok(checkGLTF(text(roots([[0, 1], [2]]))))
  assert.ok(
    checkGLTF(
      text(
        roots([
          [0, 1],
          [0, 2],
        ])
      )
    ),
    'a root in two scenes'
  )
  refused(roots([[0, 1, 0]]), /scene 0 lists node 0 twice/)
  refused(roots([[0, 1]], [{ children: [1] }, {}]), /scene 0 lists node 1, which is a child of another node/)
  const thousand = Array.from({ length: 1000 }, (_, i) => i)
  refused(roots([[...thousand, ...thousand]], Array(1000).fill({})), /scene 0 lists node 0 twice/)
})

test('three-vrm: expression binds, material binds and spring colliders are counted as the plugins expand them', () => {
  // VRM 0: a bind makes one object per node using its mesh (and walks every node to find them, then the subtree of
  // each: here a Group and its two meshes)
  const vrm0 = (binds, meshNodes, more = {}) => ({
    ...doc(),
    materials: [{ name: 'm' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }, { attributes: { POSITION: 0 } }] }],
    nodes: Array.from({ length: meshNodes }, () => ({ mesh: 0 })),
    extensions: {
      VRM: {
        blendShapeMaster: {
          blendShapeGroups: [{ binds: Array.from({ length: binds }, () => ({ mesh: 0, index: 0 })) }],
        },
        ...more,
      },
    },
  })
  const counted = checkGLTF(text(vrm0(100, 100))).vrm
  assert.equal(counted.expressionBinds, 10000, '100 binds x 100 nodes')
  assert.equal(counted.expressionPrimitives, 20000)
  assert.equal(counted.expressionWork, 100 * (100 + 100 * 3))
  refused(vrm0(200, 100), /three-vrm expressionBinds: 20000, more than 16384/)
  refused(vrm0(10, 100), /expressionBinds: 1000, more than 500/, {
    ...GLTF_LIMITS,
    vrm: { ...GLTF_LIMITS.vrm, expressionBinds: 500 },
  })
  // a material value walks the scene (300 objects, the humanoid rig's 64 and the expression), and looks each mesh
  // with a material of its name (and its outline copy: 200) up in the materials found so far; it binds each found
  const materialValues = {
    blendShapeMaster: { blendShapeGroups: [{ materialValues: Array(10).fill({ materialName: 'm' }) }] },
  }
  const withMaterials = checkGLTF(text({ ...vrm0(0, 100), extensions: { VRM: materialValues } })).vrm
  assert.equal(withMaterials.expressionWork, 10 * (300 + 64 + 1 + 200 * 200))
  assert.equal(withMaterials.expressionBinds, 10 * 200)
  // VRM 0 springs: each joint (every node below a listed bone) visits the colliders of its groups
  const springs0 = {
    secondaryAnimation: {
      colliderGroups: [{ node: 0, colliders: Array(10).fill({}) }],
      boneGroups: [{ bones: [0], colliderGroups: Array(200).fill(0) }],
    },
  }
  // (the node's object is a Group with its two meshes, and the ten colliders are added below it: 13 joints)
  const sprung = checkGLTF(text({ ...vrm0(0, 1), extensions: { VRM: springs0 } })).vrm
  assert.equal(sprung.springJoints, 13)
  assert.equal(sprung.springColliderWork, 13 * 200 * 10)
  // VRM 1: repeated collider group and collider references multiply what each joint visits
  const vrm1 = (joints, groupRefs, colliderRefs) => ({
    ...doc(),
    nodes: Array.from({ length: joints }, () => ({})),
    extensions: {
      VRMC_springBone: {
        colliders: [{ node: 0, shape: { sphere: {} } }],
        colliderGroups: [{ colliders: Array(colliderRefs).fill(0) }],
        springs: [
          { joints: Array.from({ length: joints }, (_, i) => ({ node: i })), colliderGroups: Array(groupRefs).fill(0) },
        ],
      },
    },
  })
  assert.equal(checkGLTF(text(vrm1(2, 100, 100))).vrm.springColliderWork, 10000, 'two joints are one spring bone')
  refused(vrm1(101, 200, 100), /springColliderWork: 2000000, more than 1048576/)
  // VRM 1 expressions, first person, constraints
  const expressions = {
    ...doc(),
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{}],
    extensions: {
      VRMC_vrm: {
        expressions: {
          custom: { a: { morphTargetBinds: [{ node: 0, index: 0 }], materialColorBinds: [{ material: 0 }] } },
        },
        firstPerson: { meshAnnotations: [{ node: 0 }, { node: 0 }] },
      },
    },
  }
  const v1 = checkGLTF(text(expressions)).vrm
  // first person: the node, its subtree, and the two annotations it searches
  assert.deepEqual([v1.expressions, v1.expressionBinds, v1.expressionPrimitives, v1.firstPersonWork], [1, 2, 1, 4])
  refused(
    {
      ...expressions,
      extensions: { VRMC_vrm: { expressions: { custom: { a: { morphTargetBinds: [{ node: 4 }] } } } } },
    },
    /morphTargetBind 0 node is not an index of nodes/
  )
  const constraints = {
    ...doc(),
    nodes: Array.from({ length: 5 }, () => ({
      extensions: { VRMC_node_constraint: { constraint: { roll: { source: 0 } } } },
    })),
  }
  assert.equal(checkGLTF(text(constraints)).vrm.constraints, 5)
  refused(constraints, /constraints: 5, more than 4/, { ...GLTF_LIMITS, vrm: { ...GLTF_LIMITS.vrm, constraints: 4 } })
})

test('strings are short, and strings where they are used as one: names, keys, URIs, kinds', () => {
  // what the parser and three-vrm keep, compare, concatenate, sanitise or use as a key once per object is a name of
  // the document: at most 1024 characters (the reviewer's probe: a 1,000,000-character mesh name sanitised and kept
  // for each of 1000 primitives, stopped only by the clock). The longest in the bundled files and VRoid's samples: 59
  const long = n => 'x'.repeat(n)
  const named = (where, n) => {
    const json = doc({
      nodes: [{ mesh: 0, name: 'n' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }], name: 'm' }],
      materials: [{ name: 'mat' }],
      animations: [{ name: 'a', samplers: [], channels: [] }],
      extensions: {
        KHR_lights_punctual: { lights: [{ type: 'point', name: 'l' }] },
        VRM: { blendShapeMaster: { blendShapeGroups: [{ name: 'g', presetName: 'joy' }] } },
        VRMC_springBone: { springs: [{ name: 's', joints: [] }] },
      },
    })
    where(json, long(n))
    return json
  }
  for (const [label, where, pattern] of [
    ['a node', (json, name) => (json.nodes[0].name = name), /nodes 0 name is 1025 characters long, more than 1024/],
    ['a mesh', (json, name) => (json.meshes[0].name = name), /meshes 0 name is 1025 characters long/],
    ['a material', (json, name) => (json.materials[0].name = name), /materials 0 name is 1025/],
    ['an animation', (json, name) => (json.animations[0].name = name), /animations 0 name is 1025/],
    [
      'a light',
      (json, name) => (json.extensions.KHR_lights_punctual.lights[0].name = name),
      /extension KHR_lights_punctual name is 1025/,
    ],
    [
      'a VRM 0 expression',
      (json, name) => (json.extensions.VRM.blendShapeMaster.blendShapeGroups[0].name = name),
      /extension VRM name is 1025/,
    ],
    [
      'a VRM 1 spring',
      (json, name) => (json.extensions.VRMC_springBone.springs[0].name = name),
      /extension VRMC_springBone name is 1025/,
    ],
    ['an extension used', (json, name) => (json.extensionsUsed = [name]), /extensionsUsed 0 extensionsUsed is 1025/],
  ]) {
    assert.ok(checkGLTF(text(named(where, 1024))), `${label}: 1024 characters`)
    refused(named(where, 1025), pattern)
  }
  // keys: an attribute's name (the primitive's key and three's attribute are made of it), an extension's, a VRM 1
  // expression's
  refused(
    doc({ meshes: [{ primitives: [{ attributes: { POSITION: 0, [long(1025)]: 0 } }] }] }),
    /meshes 0 has a key 1025 characters long, more than 1024/
  )
  refused(doc({ nodes: [{ extensions: { [long(1025)]: {} } }] }), /nodes 0 has a key 1025 characters long/)
  refused(
    doc({ extensions: { VRMC_vrm: { expressions: { custom: { [long(1025)]: {} } } } } }),
    /extension VRMC_vrm has a key 1025 characters long/
  )
  // a URI that is not a data: URI names a file (never fetched: the client refuses them) and is short; a data: URI is
  // the data itself, charged where it is decoded
  refused(
    doc({ images: [{ uri: `https://example.com/${long(2100)}.png` }] }),
    /images 0 uri is 2124 characters long, more than 2048/
  )
  assert.ok(checkGLTF(text(doc({ images: [{ uri: `https://example.com/${long(2000)}.png` }] }))))
  assert.ok(checkGLTF(text(doc({ buffers: [{ byteLength: 300000, uri: dataURI(300000) }] }))))
  // the asset's and the VRM meta's text is read once (a licence, credits): up to 16,384 characters
  assert.ok(checkGLTF(text(doc({ asset: { version: '2.0', copyright: long(16384) } }))))
  refused(
    doc({ asset: { version: '2.0', copyright: long(16385) } }),
    /asset copyright is 16385 characters long, more than 16384/
  )
  assert.ok(checkGLTF(text(doc({ extensions: { VRMC_vrm: { meta: { thirdPartyLicenses: long(16384) } } } }))))
  refused(
    doc({ extensions: { VRM: { meta: { title: long(16385) } } } }),
    /extension VRM title is 16385 characters long/
  )
  // (the VRM meta's room is the meta's: a name elsewhere in the extension is a name)
  refused(doc({ extensions: { VRM: { exporterVersion: long(1025) } } }), /extension VRM exporterVersion is 1025/)
  // extras, and extensions nothing here reads, are not read: their strings are not names (their size is what is
  // capped, below)
  assert.ok(
    checkGLTF(text(doc({ nodes: [{ extras: { note: long(5000) }, extensions: { X_note: { s: long(5000) } } }] })))
  )
  // a value the parser or three-vrm uses as a string is one: a list was joined into a string each time (a material's
  // name, for each outline three-vrm clones from it; a VRM 0 material value's name, for each material it compares)
  refused(doc({ materials: [{ name: ['a', 'b'] }] }), /materials 0 name is not a string/)
  refused(
    doc({
      extensions: { VRM: { blendShapeMaster: { blendShapeGroups: [{ materialValues: [{ materialName: [1] }] }] } } },
    }),
    /extension VRM materialName is not a string/
  )
  refused(
    doc({
      extensions: { VRMC_vrm: { expressions: { custom: { a: { materialColorBinds: [{ material: 0, type: [] }] } } } } },
    }),
    /extension VRMC_vrm type is not a string/
  )
  // and a number where the parser looks it up for every texture, or every use of an accessor
  refused(doc({ samplers: [{ magFilter: [9729] }] }), /sampler 0 magFilter is not a whole number/)
  refused(
    doc({ accessors: [{ bufferView: 0, componentType: [5126], type: 'VEC3', count: 3 }] }),
    /invalid componentType/
  )
})

test('a URI has no line break, and a data: URI the shape of one: its header a name', () => {
  // the reviewer's probe: a data: URI of 100,000 commas, a line break and one more character (98 KB). three.js's
  // resolveURL tests it with /^data:.*,.*$/i, which backtracked over every comma: 5 s on the main thread, minutes at
  // 1 MB. The check refuses it, in a single pass
  const hostile = doc({
    buffers: [{ byteLength: 36, uri: 'data:application/octet-stream,' + ','.repeat(100000) + '\n' + 'x' }],
  })
  const started = performance.now()
  refused(hostile, /buffers 0 uri has a line break/)
  assert.ok(performance.now() - started < 500, `${performance.now() - started} ms`)
  for (const lineBreak of ['\n', '\r', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) {
    refused(doc({ images: [{ uri: `data:image/png;base64,AAAA${lineBreak}AAAA` }] }), /images 0 uri has a line break/)
    refused(doc({ images: [{ uri: `https://example.com/a${lineBreak}.png` }] }), /images 0 uri has a line break/)
  }
  // the shape `data:[<type>/<subtype>][;<name>=<value>]...[;base64],<payload>`, the part before the comma at most
  // 1024 characters (a name)
  const image = uri => doc({ images: [{ uri }] })
  for (const uri of [
    'data:,',
    'data:;base64,AAAA',
    'data:image/png;base64,AAAA',
    'data:application/octet-stream;base64,AAAA',
    'data:application/gltf-buffer;base64,AAAA',
    'data:image/png;name=a.png;charset=utf-8;BASE64,AAAA',
    'data:text/plain,a,b,c',
    `data:image/png;base64,${'A'.repeat(300000)}`,
  ]) {
    assert.ok(checkGLTF(text(image(uri))), uri.slice(0, 60))
  }
  refused(image('data:image/png;base64'), /images 0 uri is a data: URI without a comma/)
  refused(image('data:image;base64,AAAA'), /media type is not a type\/subtype/)
  refused(image('data:image/png/x;base64,AAAA'), /media type is not a type\/subtype/)
  refused(image('data:im age/png,AAAA'), /media type is not a type\/subtype/)
  refused(image('data:image/png;base64;x=1,AAAA'), /a parameter that is not name=value/)
  refused(image('data:image/png;=1,AAAA'), /a parameter that is not name=value/)
  refused(image(`data:image/png;x=${'1'.repeat(1020)},AAAA`), /a data: header 1032 characters long, more than 1024/)
})

test('a texture has an image this client decodes: its own source, or a WebP one', () => {
  // the reviewer's probe: an optional KTX2 or AVIF texture with no fallback source failed in the parser with a
  // TypeError ("reading 'uri'"); it is refused with its reason
  const texture = def =>
    doc({ images: [{ uri: 'data:image/png;base64,AAAA' }, { uri: 'data:image/ktx2;base64,AAAA' }], textures: [def] })
  for (const name of ['KHR_texture_basisu', 'EXT_texture_avif']) {
    refused(texture({ extensions: { [name]: { source: 1 } } }), /texture 0 has no image this client decodes/)
    assert.ok(checkGLTF(text(texture({ source: 0, extensions: { [name]: { source: 1 } } }))), `${name} with a fallback`)
  }
  refused(texture({}), /texture 0 has no image this client decodes/)
  assert.ok(checkGLTF(text(texture({ extensions: { EXT_texture_webp: { source: 0 } } }))), 'a WebP image alone')
})

test('extras are small: each object’s, and all the parsed scene holds, as the userData every clone copies', () => {
  // extras and extensions become an object's userData, copied (as JSON) with every clone: at most 64 KiB of JSON an
  // object (the most in the bundled files and VRoid's samples: 1,957), counting every extension (which of them the
  // parser copies depends on the plugins registered)
  const fill = n => ({ s: 'x'.repeat(n - 8) }) // n characters of JSON
  const at = (place, n) => {
    const json = doc({
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, camera: 0, extensions: { KHR_lights_punctual: { light: 0 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{}],
      images: [{ uri: 'data:image/png;base64,AA==' }],
      cameras: [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }],
      extensions: { KHR_lights_punctual: { lights: [{ type: 'point' }] } },
    })
    place(json, fill(n))
    return json
  }
  for (const [label, place, pattern] of [
    [
      'a node',
      (json, extras) => (json.nodes[0].extras = extras),
      /node 0 has 65572 characters of extras and extensions, more than 65536/,
    ],
    ['a mesh', (json, extras) => (json.meshes[0].extras = extras), /mesh 0 has 65537/],
    ['a primitive', (json, extras) => (json.meshes[0].primitives[0].extras = extras), /mesh 0 primitive 0 has 65537/],
    ['a material', (json, extras) => (json.materials[0].extras = extras), /material 0 has 65537/],
    ['an image', (json, extras) => (json.images[0].extras = extras), /image 0 has 65537/],
    ['a scene', (json, extras) => (json.scenes[0].extras = extras), /scene 0 has 65537/],
    ['a camera', (json, extras) => (json.cameras[0].extras = extras), /camera 0 has 65537/],
    ['a light', (json, extras) => (json.extensions.KHR_lights_punctual.lights[0].extras = extras), /light 0 has 65537/],
    [
      'an unknown extension',
      (json, extras) => (json.materials[0].extensions = { X_data: extras }),
      /material 0 has \d+/,
    ],
  ]) {
    assert.ok(checkGLTF(text(at(place, 65536 - 100))), `${label}: under 64 KiB`)
    // (the node's light extension, and the unknown extension's name around the data, count too)
    refused(at(place, label === 'an unknown extension' ? 65537 - 11 : 65537), pattern)
  }
  // and all of it in the parsed scene, at most 8 MiB: a mesh's userData is on each of its primitives' meshes, for
  // each node using it, and every clone of the scene (an avatar's, for each player) copies all of it. The most in the
  // bundled files and VRoid's samples: 22,501
  const used = nodes =>
    doc({
      nodes: Array.from({ length: nodes }, () => ({ mesh: 0 })),
      meshes: [{ extras: fill(40000), primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 0 } }] }],
    })
  assert.equal(checkGLTF(text(used(104))).sceneUserData, 104 * 2 * 40000)
  refused(used(105), /the scene's userData is 8400000 characters of JSON, more than 8388608/)
  // the reviewer's instanced exports with Blender custom properties (1 MiB refused the first): one mesh of 5
  // materials with a 200-character property on 1000 nodes (56 KB); and 800 nodes, each with a 300-character
  // property of its own, using one mesh of 2 materials with a 500-character one
  const instanced = (primitives, nodes, meshProperty, nodeProperty) =>
    doc({
      asset: { version: '2.0', generator: 'Khronos glTF Blender I/O v4.2.70' },
      scenes: [{ nodes: [...Array(nodes).keys()] }],
      nodes: Array.from({ length: nodes }, (_, i) => ({
        name: `Tree.${i}`,
        mesh: 0,
        translation: [i, 0, 0],
        ...(nodeProperty ? { extras: { note: 'y'.repeat(nodeProperty) } } : {}),
      })),
      meshes: [
        {
          name: 'Tree',
          extras: { note: 'x'.repeat(meshProperty) },
          primitives: Array.from({ length: primitives }, (_, i) => ({ attributes: { POSITION: 0 }, material: i })),
        },
      ],
      materials: Array.from({ length: primitives }, (_, i) => ({ name: `mat${i}` })),
    })
  assert.equal(checkGLTF(text(instanced(5, 1000, 200))).sceneUserData, 1000 * 5 * 211)
  assert.ok(checkGLTF(text(instanced(2, 800, 500, 300))).sceneUserData > 1024 * 1024)
})

test('three-vrm walks are counted in objects of the scene graph, as the plugins walk them, not in nodes', () => {
  const vrmLimits = vrm => ({ ...GLTF_LIMITS, vrm: { ...GLTF_LIMITS.vrm, ...vrm } })
  // Codex's probe: one bone listed, on a node whose mesh has 21 primitives (a Group and 21 meshes), with one collider
  // added below it: 23 joints, each visiting the collider (counted as 1 and 1 before)
  const probe = {
    ...doc(),
    extensionsUsed: ['VRM'],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: Array.from({ length: 21 }, () => ({ attributes: { POSITION: 0 } })) }],
    extensions: {
      VRM: {
        secondaryAnimation: {
          colliderGroups: [{ node: 0, colliders: [{ radius: 1 }] }],
          boneGroups: [{ bones: [0], colliderGroups: [0] }],
        },
      },
    },
  }
  const springs = checkGLTF(text(probe)).vrm
  assert.deepEqual([springs.springJoints, springs.springColliderWork], [23, 23])
  refused(probe, /three-vrm springJoints: 23, more than 20/, vrmLimits({ springJoints: 20 }))
  // sorting the joints: each walks up from its parent and its collider (the object depth: the node, the Group, the
  // mesh), and at each object the joints there (each object below the one listing has one), then the scene down
  assert.equal(springs.springSortWork, 23 * (1 + 1) * 3 * (1 + 1) + 23 + 64)
  refused(probe, /springSortWork: \d+, more than 100/, vrmLimits({ springSortWork: 100 }))

  // expressions: a VRM 1 morph bind walks its node's subtree (here 101 objects), each one
  const below = binds => ({
    ...doc(),
    nodes: [{ mesh: 0, children: Array.from({ length: 100 }, (_, i) => i + 1) }, ...Array(100).fill({})],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] }] }],
    extensions: {
      VRMC_vrm: {
        expressions: { custom: { x: { morphTargetBinds: Array(binds).fill({ node: 0, index: 0 }) } } },
      },
    },
  })
  assert.equal(checkGLTF(text(below(10))).vrm.expressionWork, 10 * 101)
  refused(below(200), /expressionWork: 20200, more than 20000/, vrmLimits({ expressionWork: 20000 }))
  // first person: every node, and the subtree of each node with a mesh
  assert.equal(checkGLTF(text(below(0))).vrm.firstPersonWork, 101 + 101)

  // MToon outlines: an outlined primitive gets two draw groups on its geometry, which every mesh with the same
  // primitive shares; each use of such a mesh draws all of them (n meshes: n x 2n draws)
  const outlined = n => ({
    ...doc(),
    nodes: Array.from({ length: n }, (_, i) => ({ mesh: i })),
    materials: [
      { extensions: { VRMC_materials_mtoon: { outlineWidthMode: 'worldCoordinates', outlineWidthFactor: 1 } } },
    ],
    meshes: Array.from({ length: n }, () => ({ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] })),
  })
  assert.equal(checkGLTF(text(outlined(1))).vrm.outlineDraws, 2)
  assert.equal(checkGLTF(text(outlined(100))).vrm.outlineDraws, 100 * 200)
  refused(outlined(300), /three-vrm outlineDraws: 180000, more than 131072/)
  // without an outline, nothing is added
  const plain = outlined(300)
  plain.materials = [{}]
  assert.equal(checkGLTF(text(plain)).vrm.outlineDraws, 0)
  // and each outline material three-vrm clones copies its material's userData (extras, and the extensions the parser
  // does not handle, as JSON) and its textures' (their images' extras): Codex's probe, 50 outlined primitives on one
  // material with 1000 small objects in its extras, made 50 copies of them while nothing was charged
  const heavy = (n, objects = 1000) => {
    const json = outlined(1)
    json.meshes = [{ primitives: Array(n).fill({ attributes: { POSITION: 0 }, material: 0 }) }]
    json.materials[0].extras = { list: Array.from({ length: objects }, (_, i) => ({ i })) }
    return json
  }
  // (at what a JSON copy of them holds: jsonCopyBytes)
  const copied = value => jsonCopyBytes(JSON.stringify(value))
  const one = 8192 + copied(heavy(1).materials[0].extras) + copied(heavy(1).materials[0].extensions)
  assert.equal(checkGLTF(text(heavy(50))).vrm.outlineCopyBytes, 50 * one)
  // (200 on one geometry draw 80,000 groups, inside that cap; their copies are not)
  refused(heavy(200, 5000), /three-vrm outlineCopyBytes: \d+, more than 16777216/)
  // and each texture slot of MToon copies a texture's userData (an image's extras and its mimeType). Which image a
  // slot holds is not modelled: an extension's source, the parser's texture cache (keyed by uri or bufferView and
  // sampler) and VRM 0's slots may each resolve it to another image than the one it names. So every slot counts the
  // largest texture userData in the file, whether the material names a texture or not
  const textured = heavy(1)
  textured.textures = [{ source: 0 }, { source: 1 }]
  textured.images = [
    { bufferView: 0, mimeType: 'image/png', extras: { note: 'x'.repeat(100) } },
    { bufferView: 0, mimeType: 'image/png', extras: { note: 'x'.repeat(1000) } },
  ]
  textured.materials[0].extensions.VRMC_materials_mtoon.shadeMultiplyTexture = { index: 0 }
  // (its mimeType counted at the longest of the types an image may have: ten characters)
  const largest = copied({ note: 'x'.repeat(1000), mimeType: 'image/jpeg' })
  assert.equal(
    checkGLTF(text(textured)).vrm.outlineCopyBytes,
    8192 +
      copied(textured.materials[0].extras) +
      copied(textured.materials[0].extensions) +
      MTOON_TEXTURE_SLOTS * largest
  )
  // the reviewer's probe: a 100,000-character mimeType, copied in each of nine slots of 100 outline clones (180 MB
  // from a 0.11 MB file, 0.88 MB counted). A mimeType is one of a fixed list now: the three types this client
  // decodes, and the KTX2 and AVIF types a valid file carries for the images its extensions name (with a fallback)
  const mime = heavy(1)
  mime.images = [{ bufferView: 0, mimeType: 'image/png' + 'x'.repeat(100) }]
  refused(mime, /image 0 mimeType is not one of image\/png, image\/jpeg, image\/webp, image\/ktx2, image\/avif/)
  mime.images[0].mimeType = 'image/gif'
  refused(mime, /image 0 mimeType is not one of/)
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/ktx2', 'image/avif']) {
    mime.images[0].mimeType = type
    assert.ok(checkGLTF(text(mime)), type)
  }
  // texture-transform binds: each clones every texture slot of each material it binds (once per mesh using the
  // material, VRM 1; once per material found by name and its outline copy, VRM 0)
  const transforms = (binds, meshes = 3) => {
    const json = heavy(1)
    json.nodes = Array.from({ length: meshes }, () => ({ mesh: 0 }))
    json.textures = [{ source: 0 }]
    json.images = [{ bufferView: 0, mimeType: 'image/png', extras: { note: 'x'.repeat(1000) } }]
    json.extensions = {
      VRMC_vrm: {
        expressions: { custom: { a: { textureTransformBinds: Array(binds).fill({ material: 0, scale: [2, 2] }) } } },
      },
    }
    return json
  }
  assert.equal(
    checkGLTF(text(transforms(2))).vrm.textureBindCopyBytes,
    2 * 3 * TEXTURE_TRANSFORM_SLOTS * largest,
    'two binds, a material on three meshes, every slot'
  )
  refused(transforms(1000, 10), /three-vrm textureBindCopyBytes: \d+, more than 16777216/)
  // VRM 0: a material value for _MainTex_ST, on the materials named (two meshes, and their outline copies)
  const v0 = heavy(1)
  v0.nodes = [{ mesh: 0 }, { mesh: 0 }]
  v0.materials[0].name = 'skin'
  v0.textures = transforms(1).textures
  v0.images = transforms(1).images
  v0.extensions = {
    VRM: {
      blendShapeMaster: {
        blendShapeGroups: [{ materialValues: [{ materialName: 'skin', propertyName: '_MainTex_ST' }] }],
      },
    },
  }
  assert.equal(checkGLTF(text(v0)).vrm.textureBindCopyBytes, 2 * 2 * TEXTURE_TRANSFORM_SLOTS * largest)
  v0.extensions.VRM.blendShapeMaster.blendShapeGroups[0].materialValues[0].propertyName = '_Color'
  assert.equal(checkGLTF(text(v0)).vrm.textureBindCopyBytes, 0, 'a colour bind clones nothing')
})

test("the texture-transform copy bound counts the most texture slots three-vrm's bind clones on one material", () => {
  const kinds = Object.values(VRMExpressionTextureTransformBind._propertyNamesMap)
  assert.equal(Math.max(...kinds.map(slots => slots.length)), TEXTURE_TRANSFORM_SLOTS, JSON.stringify(kinds))
})

test("the outline copy bound counts every texture uniform three-vrm's MToon material has", () => {
  const material = new MToonMaterial()
  // (the shadow-map arrays are the renderer's, not the file's)
  const slots = Object.entries(material.uniforms)
    .filter(([name, uniform]) => /(^map|Map|Texture)$/.test(name) && !Array.isArray(uniform.value))
    .map(([name]) => name)
  assert.equal(slots.length, MTOON_TEXTURE_SLOTS, slots.join(', '))
  material.dispose()
})

test('VRM 0: UniVRM writes -1 for "none", accepted where three-vrm reads the field as absent', () => {
  // VRoid's samples Avatar_Orion and Darkness_Shibu have spring bone groups with `center: -1`, and were refused
  const vrm0 = more => ({
    ...doc(),
    nodes: [{ mesh: 0 }, {}],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    extensions: {
      VRM: {
        humanoid: { humanBones: [{ bone: 'hips', node: 1 }] },
        blendShapeMaster: { blendShapeGroups: [{ binds: [{ mesh: -1, index: 0 }] }] },
        secondaryAnimation: { colliderGroups: [], boneGroups: [{ bones: [1], center: -1 }] },
        firstPerson: { firstPersonBone: -1, meshAnnotations: [{ mesh: -1 }] },
        meta: { texture: -1 },
        ...more,
      },
    },
  })
  const counted = checkGLTF(text(vrm0())).vrm
  assert.equal(counted.expressionBinds, 0, 'a bind naming no mesh binds nothing')
  // where three-vrm would use it (a collider group's node, a bone), -1 is refused
  refused(
    vrm0({ secondaryAnimation: { colliderGroups: [{ node: -1, colliders: [] }], boneGroups: [] } }),
    /VRM colliderGroup 0 node is not an index of nodes/
  )
  refused(
    vrm0({ secondaryAnimation: { boneGroups: [{ bones: [-1] }] } }),
    /VRM boneGroup 0 bone is not an index of nodes/
  )
  // and a human bone's node: three-vrm takes only a missing node as absent, and looked node -1 up (a TypeError, the
  // reviewer's probe); a bone without a node is still accepted
  refused(vrm0({ humanoid: { humanBones: [{ bone: 'hips', node: -1 }] } }), /VRM humanBone 0 node is not an index/)
  assert.ok(checkGLTF(text(vrm0({ humanoid: { humanBones: [{ bone: 'leftEye' }] } }))))
})

test('the bundled avatar, emotes and models pass, with their three-vrm counts', () => {
  const avatar = checkGLTF(fs.readFileSync(new URL('../src/world/assets/avatar.vrm', import.meta.url)))
  assert.deepEqual(avatar.vrm, {
    expressions: 14,
    expressionBinds: 14,
    expressionPrimitives: 14,
    expressionWork: 868,
    springJoints: 0,
    springColliders: 0,
    springColliderWork: 0,
    springSortWork: 0,
    firstPersonWork: 62,
    constraints: 0,
    outlineDraws: 2,
    // 8 KiB, its material's extensions (`{}`: 100 bytes copied) and ten slots of a texture's userData (an image's
    // mimeType, counted at ten characters: `{"mimeType":"image/jpeg"}`, 202)
    outlineCopyBytes: 8192 + 100 + 10 * 202,
    textureBindCopyBytes: 0,
  })
  for (const name of [
    'world/assets/mp-idle.glb',
    'world/assets/emote-float.glb',
    'world/assets/crash-block.glb',
    'world/assets/ai.glb',
    'client/public/base-environment.glb',
  ]) {
    assert.ok(checkGLTF(fs.readFileSync(new URL(`../src/${name}`, import.meta.url))), name)
  }
})

test('the budget: bytes beyond twice the file, counts per kind, image decodes sized from their headers', () => {
  const charges = []
  const budget = createGLTFBudget({ fileBytes: MiB, onCharge: (...args) => charges.push(args) })
  assert.equal(budget.maxBytes, 322 * MiB)
  budget.bytes(322 * MiB, 'all of it')
  assert.throws(
    () => budget.bytes(1, 'one more'),
    error =>
      error instanceof GLTFLimitError &&
      error.isGLTFLimit &&
      /more than 337641472 bytes \(at one more\)/.test(error.message)
  )
  assert.equal(budget.refused.message, 'model file: the parser would allocate more than 337641472 bytes (at one more)')
  assert.throws(() => budget.bytes(0, 'after'), /more than/, 'every later charge is refused too')
  assert.throws(() => createGLTFBudget().bytes(NaN, 'x'), /impossible size/)
  assert.throws(() => createGLTFBudget().bytes(-1, 'x'), /impossible size/)
  // steps of work: one total per file
  const work = createGLTFBudget({ limits: { ...GLTF_LIMITS, work: 10 } })
  work.work(10, 'ten')
  assert.throws(() => work.work(1, 'one more'), /the parser would take more than 10 steps \(at one more\)/)
  assert.equal(GLTF_LIMITS.work, 2 ** 26)
  assert.equal(createGLTFBudget({ fileBytes: 1000 }).maxWork, 2 ** 26 + 1000, 'and a step per byte of the file')
  assert.throws(() => createGLTFBudget().work(NaN, 'x'), /impossible amount of work/)
  assert.throws(
    () => createGLTFBudget().refuse('a document rule', 'x'),
    error => error.isGLTFLimit && error.message === 'model file: a document rule'
  )
  // the time backstop: a monotonic clock, looked at by every charge (work each 65,536 steps); refused once
  let now = 0
  const timed = createGLTFBudget({ now: () => now })
  timed.bytes(1, 'early')
  now = GLTF_LIMITS.parseMilliseconds + 1
  assert.throws(() => timed.count('nodes'), /the parse took more than 10 s \(at nodes\)/)
  timed.count('nodes')
  timed.work(1, 'a step')
  const walks = createGLTFBudget({ now: () => now, limits: { ...GLTF_LIMITS, parseMilliseconds: 5 } })
  now += 10
  for (let i = 0; i < 65535; i++) walks.work(1, 'a walk')
  assert.throws(() => walks.work(1, 'a walk'), /the parse took more than 0.005 s/)
  const counts = createGLTFBudget()
  counts.count('scenes', 64)
  assert.throws(() => counts.count('scenes'), /scenes: 65, more than 64/)
  assert.throws(() => counts.count('unicorns'), /unknown count unicorns/)
  // images
  const images = createGLTFBudget()
  images.image(png(4096, 4096), 'image 0')
  assert.equal(images.used.pixels, 4096 * 4096)
  assert.equal(images.used.counts.images, 1)
  for (const [bytes, reason] of [
    [png(100000, 100000), /image 1 is larger than 36000000 pixels/],
    [png(0, 10), /has no width or height/],
    [gif(10, 10), /is not a PNG, JPEG or WebP image/],
    [png(10, 10).subarray(0, 20), /is a png cut short/],
    [
      jpeg(10, 10, {
        frames: [
          [1, 1],
          [10, 10],
        ],
      }),
      /is a malformed jpeg \(more than one frame header\)/,
    ],
  ]) {
    assert.throws(() => images.image(bytes, 'image 1'), reason)
  }
  // sixteen 4096 x 4096 decodes fit in a file, a seventeenth does not
  const file = createGLTFBudget()
  for (let i = 0; i < 16; i++) file.image(png(4096, 4096), `image ${i}`)
  assert.throws(() => file.image(png(64, 64), 'image 16'), /the images decoded would have more than 268435456 pixels/)
  // by URI: data: measured, blob: refused, other URLs left to the URL filter (nothing decodes them)
  const uris = createGLTFBudget()
  uris.imageURI(`data:image/png;base64,${Buffer.from(png(10, 10)).toString('base64')}`, 'image 0')
  assert.throws(
    () => uris.imageURI(`data:image/png;base64,${Buffer.from(png(9000, 9000)).toString('base64')}`, 'image 1'),
    /larger than/
  )
  assert.throws(() => uris.imageURI(' BLOB:https://x/1', 'image 2'), /names a blob: URL/)
  uris.imageURI('https://elsewhere.example/t.png', 'image 3')
  assert.equal(uris.used.counts.images, 1)
  // every charge and refusal is reported (the parser-level tests use this)
  assert.deepEqual(charges[0], ['bytes', 322 * MiB, 'all of it', 322 * MiB])
  assert.equal(charges.filter(c => c[0] === 'refused').length, 2)
})
