import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { checkGLTF, readGLTF, createGLTFBudget, GLTF_LIMITS, GLTFLimitError } from '../src/core/extras/gltfLimits.js'
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
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { mesh: 0, children: [1], matrix: Array(16).fill(0) },
      { skin: 0, camera: 0, weights: [0.5] },
    ],
    meshes: [
      {
        weights: [0],
        primitives: [{ attributes: { POSITION: 0 }, indices: 0, material: 0, mode: 4, targets: [{ POSITION: 0 }] }],
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
    skins: [{ joints: [1], skeleton: 1, inverseBindMatrices: 0 }],
    cameras: [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }],
    animations: [
      { samplers: [{ input: 0, output: 0 }], channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }] },
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
})

test('three-vrm: expression binds, material binds and spring colliders are counted as the plugins expand them', () => {
  // VRM 0: a bind makes one object per node using its mesh (and walks every node to find them)
  const vrm0 = (binds, meshNodes, more = {}) => ({
    ...doc(),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 0 } }] }],
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
  assert.equal(counted.expressionWork, 10000)
  refused(vrm0(200, 100), /three-vrm expressionBinds: 20000, more than 16384/)
  refused(vrm0(10, 100), /expressionBinds: 1000, more than 500/, {
    ...GLTF_LIMITS,
    vrm: { ...GLTF_LIMITS.vrm, expressionBinds: 500 },
  })
  // a material value walks the scene, and may bind every material in it
  const materialValues = {
    blendShapeMaster: { blendShapeGroups: [{ materialValues: Array(10).fill({ materialName: 'm' }) }] },
  }
  const withMaterials = checkGLTF(text({ ...vrm0(0, 100), extensions: { VRM: materialValues } })).vrm
  assert.equal(withMaterials.expressionWork, 10 * (100 + 200))
  // VRM 0 springs: each joint (every node below a listed bone) visits the colliders of its groups
  const springs0 = {
    secondaryAnimation: {
      colliderGroups: [{ node: 0, colliders: Array(10).fill({}) }],
      boneGroups: [{ bones: [0], colliderGroups: Array(200).fill(0) }],
    },
  }
  const sprung = checkGLTF(text({ ...vrm0(0, 1), extensions: { VRM: springs0 } })).vrm
  assert.equal(sprung.springColliderWork, 1 * 200 * 10)
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
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
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
  assert.deepEqual([v1.expressions, v1.expressionBinds, v1.expressionPrimitives, v1.firstPersonWork], [1, 2, 1, 2])
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

test('the bundled avatar, emotes and models pass, with their three-vrm counts', () => {
  const avatar = checkGLTF(fs.readFileSync(new URL('../src/world/assets/avatar.vrm', import.meta.url)))
  assert.deepEqual(avatar.vrm, {
    expressions: 14,
    expressionBinds: 14,
    expressionPrimitives: 14,
    expressionWork: 854,
    springJoints: 0,
    springColliders: 0,
    springColliderWork: 0,
    firstPersonWork: 0,
    constraints: 0,
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
  assert.equal(budget.maxBytes, 66 * MiB)
  budget.bytes(66 * MiB, 'all of it')
  assert.throws(
    () => budget.bytes(1, 'one more'),
    error =>
      error instanceof GLTFLimitError &&
      error.isGLTFLimit &&
      /more than 69206016 bytes \(at one more\)/.test(error.message)
  )
  assert.throws(() => budget.bytes(0, 'after'), /more than/, 'every later charge is refused too')
  assert.throws(() => createGLTFBudget().bytes(NaN, 'x'), /impossible size/)
  assert.throws(() => createGLTFBudget().bytes(-1, 'x'), /impossible size/)
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
  assert.deepEqual(charges[0], ['bytes', 66 * MiB, 'all of it', 66 * MiB])
  assert.equal(charges.filter(c => c[0] === 'refused').length, 2)
})
