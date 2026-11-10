import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { checkGLTF, readGLTF, GLTF_LIMITS } from '../src/core/extras/gltfLimits.js'
import { png, jpeg, webp, gif } from './lib/imageBytes.mjs'

// What a glTF file declares, checked before the parser allocates it: tiny hand-written documents.
const MiB = 1024 * 1024
const text = json => new TextEncoder().encode(JSON.stringify(json))
const dataURI = bytes => `data:application/octet-stream;base64,${Buffer.alloc(bytes).toString('base64')}`

// a document with one buffer of `bytes` (a data: URI) and whatever else is given
const doc = (extra = {}, bytes = 36) => ({
  asset: { version: '2.0' },
  buffers: [{ byteLength: bytes, uri: dataURI(bytes) }],
  bufferViews: [{ buffer: 0, byteLength: bytes }],
  ...extra,
})
const vec3 = (count, more = {}) => ({ componentType: 5126, type: 'VEC3', count, ...more })

// a .glb: header, JSON chunk and, when given, a binary chunk (`bin`: its bytes, or a length of zeros)
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

test('the 239-byte file: an accessor of a billion VEC3 floats with no data is refused', () => {
  const file = text({
    asset: { version: '2.0' },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    accessors: [vec3(1000000000)],
  })
  assert.ok(file.length < 240, `${file.length} bytes`)
  assert.throws(
    () => checkGLTF(file),
    /bytes the parser would allocate beyond the file: 12000000000, more than 67108864/
  )
})

test('accessors: valid type, component type and count; data that fits its view; whole arrays counted', () => {
  const refused = [
    [doc({ accessors: [{ componentType: 5126, type: 'VEC5', count: 1 }] }), /invalid type, componentType or count/],
    [doc({ accessors: [{ componentType: 5124, type: 'VEC3', count: 1 }] }), /invalid type, componentType or count/],
    [doc({ accessors: [vec3(-1)] }), /invalid type, componentType or count/],
    [doc({ accessors: [vec3(1.5)] }), /invalid type, componentType or count/],
    [doc({ accessors: [vec3('3')] }), /invalid type, componentType or count/],
    [doc({ accessors: [{ componentType: 5126, type: 'MAT4', count: 2 ** 50 }] }), /accessor 0 is too large/],
    [doc({ accessors: [vec3(4, { bufferView: 0 })] }), /accessor 0 does not fit in its bufferView/],
    [doc({ accessors: [vec3(3, { bufferView: 0, byteOffset: 4 })] }), /does not fit in its bufferView/],
    [doc({ accessors: [vec3(1, { bufferView: 7 })] }), /bufferView 7 does not exist/],
    [doc({ accessors: [vec3(1, { bufferView: 0, byteOffset: -4 })] }), /byteOffset is not a whole number/],
    // interleaved: whole strides from the stride the offset falls in
    [
      doc({ bufferViews: [{ buffer: 0, byteLength: 36, byteStride: 16 }], accessors: [vec3(3, { bufferView: 0 })] }),
      /does not fit/,
    ],
    [doc({ accessors: 'none' }), /accessors is not a list/],
  ]
  for (const [file, reason] of refused) assert.throws(() => checkGLTF(text(file)), reason)
  // fits: exactly, and interleaved
  assert.equal(checkGLTF(text(doc({ accessors: [vec3(3, { bufferView: 0 })] }))).expandedBytes, 0)
  const interleaved = doc(
    {
      bufferViews: [{ buffer: 0, byteLength: 48, byteStride: 16 }],
      accessors: [vec3(3, { bufferView: 0, byteOffset: 4 })],
    },
    48
  )
  assert.equal(checkGLTF(text(interleaved)).expandedBytes, 0)
  // no data: the parser allocates a zero-filled array, within the budget it is accepted and counted
  assert.equal(checkGLTF(text(doc({ accessors: [vec3(1000)] }))).expandedBytes, 12000)
  assert.equal(checkGLTF(text(doc({ accessors: [vec3(0)] }))).expandedBytes, 0)
  // the budget is for the whole file
  const halves = doc({ accessors: [vec3(2 * MiB), vec3(2 * MiB), vec3(2 * MiB)] })
  assert.throws(() => checkGLTF(text(halves)), /beyond the file: 75497472/)
})

test('sparse accessors: views that fit, a count within the accessor, and the expanded array counted', () => {
  const sparse = (more = {}, count = 4) => ({
    count,
    indices: { bufferView: 0, componentType: 5121 },
    values: { bufferView: 0, byteOffset: 4 },
    ...more,
  })
  const file = (accessor, bytes = 64) => text(doc({ accessors: [accessor] }, bytes))
  assert.equal(checkGLTF(file(vec3(100, { sparse: sparse() }))).expandedBytes, 1200)
  for (const [accessor, reason] of [
    [vec3(3, { sparse: sparse() }), /invalid sparse count/],
    [vec3(100, { sparse: sparse({}, 0) }), /invalid sparse count/],
    [vec3(100, { sparse: sparse({ indices: { bufferView: 0, componentType: 5126 } }) }), /invalid sparse indices/],
    [
      vec3(100, { sparse: sparse({ indices: { bufferView: 0, componentType: 5125, byteOffset: 60 } }) }),
      /indices do not fit/,
    ],
    [vec3(100, { sparse: sparse({ values: { bufferView: 0, byteOffset: 40 } }) }), /values do not fit/],
    [vec3(100, { sparse: sparse({ values: { bufferView: 3 } }) }), /bufferView 3 does not exist/],
    [vec3(100, { sparse: 'yes' }), /invalid sparse part/],
    // expanded to the full count even though only four values are given
    [vec3(10000000, { sparse: sparse() }), /beyond the file: 120000000/],
  ]) {
    assert.throws(() => checkGLTF(file(accessor)), reason)
  }
})

test('buffers hold what they declare; bufferViews fit their buffer; overlapping views are counted', () => {
  for (const [file, reason] of [
    [doc({ buffers: [{ byteLength: 100, uri: dataURI(36) }] }), /buffer 0 declares 100 bytes and holds 36/],
    [
      doc({ buffers: [{ byteLength: 36, uri: 'https://elsewhere.example/big.bin' }] }),
      /may not reference external files \(buffer 0\)/,
    ],
    [doc({ buffers: [{ byteLength: 36, uri: 'big.bin' }] }), /may not reference external files/],
    [doc({ buffers: [{ byteLength: 36 }] }), /buffer 0 has no data in the file/],
    [doc({ buffers: [{ uri: dataURI(36) }] }), /buffer 0 has no valid byteLength/],
    [doc({ bufferViews: [{ buffer: 0, byteLength: 40 }] }), /bufferView 0 does not fit in its buffer/],
    [doc({ bufferViews: [{ buffer: 0, byteOffset: 30, byteLength: 8 }] }), /does not fit in its buffer/],
    [doc({ bufferViews: [{ buffer: 1, byteLength: 4 }] }), /bufferView 0 names no buffer/],
    [doc({ bufferViews: [{ buffer: 0, byteLength: 4, byteStride: 300 }] }), /invalid byteStride/],
  ]) {
    assert.throws(() => checkGLTF(text(file)), reason)
  }
  // a percent-encoded data: URI holds one byte per escape
  const plain = {
    ...doc(),
    buffers: [{ byteLength: 3, uri: 'data:application/octet-stream,%00%01%02' }],
    bufferViews: [],
  }
  assert.ok(checkGLTF(text(plain)))
  // each view is copied out of its buffer: a hundred views over the same 1 MiB is 99 MiB beyond the file
  const views = Array.from({ length: 100 }, () => ({ buffer: 0, byteLength: MiB }))
  const overlapping = glb({ asset: { version: '2.0' }, buffers: [{ byteLength: MiB }], bufferViews: views }, MiB)
  assert.throws(() => checkGLTF(overlapping), /beyond the file: 103809024/)
  const once = glb(
    {
      asset: { version: '2.0' },
      buffers: [{ byteLength: MiB }],
      bufferViews: views.slice(0, 2).map((v, i) => ({ ...v, byteLength: MiB / 2, byteOffset: (i * MiB) / 2 })),
    },
    MiB
  )
  assert.equal(checkGLTF(once).expandedBytes, 0)
})

test('a .glb is read as the parser reads it: header, chunks, the binary chunk bounds the first buffer', () => {
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 16 }],
    bufferViews: [{ buffer: 0, byteLength: 16 }],
  }
  assert.equal(readGLTF(glb(json, 16)).bin, 16)
  assert.ok(checkGLTF(glb(json, 16)))
  assert.throws(() => checkGLTF(glb(json, 8)), /buffer 0 declares 16 bytes and holds 8/)
  assert.throws(() => checkGLTF(glb(json)), /buffer 0 has no data in the file/)
  assert.throws(() => checkGLTF(glb(json, 16, { version: 1 })), /older than version 2/)
  assert.throws(() => checkGLTF(glb(json, 16, { length: 10000 })), /shorter than its header says/)
  assert.throws(() => checkGLTF(glb(json, 16).subarray(0, 10)), /header is cut short/)
  const cut = glb(json, 16)
  new DataView(cut.buffer).setUint32(12, 100000, true) // a JSON chunk longer than the file
  assert.throws(() => checkGLTF(cut), /JSON chunk is cut short/)
  assert.throws(() => checkGLTF(glb(json, 16, { length: 12 })), /no JSON chunk/)
  // the last JSON chunk wins, as in the parser
  const second = text({ asset: { version: '2.0' }, accessors: [vec3(1e9)] })
  assert.throws(() => checkGLTF(glb(json, 16, { extraChunks: [[0x4e4f534a, second]] })), /beyond the file/)
  assert.throws(() => checkGLTF(new TextEncoder().encode('{"asset":')), /JSON does not parse/)
  assert.throws(() => checkGLTF(new TextEncoder().encode('[1]')), /JSON is not an object/)
  assert.ok(checkGLTF(new TextEncoder().encode('{"asset":{"version":"2.0"}}').buffer), 'an ArrayBuffer is accepted')
})

// a mesh of `primitives` primitives, each using accessor 0 (positions of `vertices` vertices, no data)
const meshDoc = ({ primitives = 1, vertices = 3, nodes = [{ mesh: 0 }], targets, extra = {} } = {}) =>
  doc({
    accessors: [vec3(vertices)],
    meshes: [{ primitives: Array.from({ length: primitives }, () => ({ attributes: { POSITION: 0 }, targets })) }],
    nodes,
    ...extra,
  })

test('counts that multiply: mesh instances, skin bindings, morph targets, GPU instances, animation tracks', () => {
  const limits = { ...GLTF_LIMITS, meshInstances: 10, skinBindings: 100, primitives: 8, nodes: 6 }
  // a mesh of 3 primitives used by 4 nodes is 12 meshes
  const fourNodes = Array.from({ length: 4 }, () => ({ mesh: 0 }))
  assert.throws(
    () => checkGLTF(text(meshDoc({ primitives: 3, nodes: fourNodes })), limits),
    /mesh instances: 12, more than 10/
  )
  assert.equal(checkGLTF(text(meshDoc({ primitives: 3, nodes: fourNodes.slice(0, 3) })), limits).meshInstances, 9)
  assert.throws(() => checkGLTF(text(meshDoc({ primitives: 9 })), limits), /primitives: 9, more than 8/)
  assert.throws(() => checkGLTF(text(meshDoc({ nodes: Array(7).fill({}) })), limits), /nodes: 7, more than 6/)
  // each skinned primitive binds every joint of its skin
  const skinned = meshDoc({
    primitives: 3,
    nodes: [{ mesh: 0, skin: 0 }, ...Array(5).fill({})],
    extra: {
      skins: [
        {
          joints: [
            1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4,
          ],
        },
      ],
    },
  })
  assert.throws(() => checkGLTF(text(skinned), limits), /skin bindings: 102, more than 100/)
  // morph targets that share one accessor: a texture of 16 bytes per vertex, target and attribute
  const targets = Array.from({ length: 1000 }, () => ({ POSITION: 0, NORMAL: 0 }))
  assert.throws(() => checkGLTF(text(meshDoc({ vertices: 2100, targets }))), /beyond the file: 67225200/)
  assert.equal(checkGLTF(text(meshDoc({ vertices: 10, targets }))).expandedBytes, 10 * 12 + 10 * 1000 * 2 * 16)
  // GPU instancing: a matrix of 64 bytes per instance and primitive
  const instanced = meshDoc({
    primitives: 10,
    nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } }],
    extra: { accessors: [vec3(3), vec3(110000)] },
  })
  assert.throws(() => checkGLTF(text(instanced)), /beyond the file: 71720036/)
  // animation tracks: the first use of a float accessor is a view, further uses and non-float data are copies
  const animation = channels => ({
    samplers: [{ input: 0, output: 1 }],
    channels: Array(channels).fill({ sampler: 0 }),
  })
  const animated = n =>
    doc({
      accessors: [{ componentType: 5126, type: 'SCALAR', count: 9, bufferView: 0 }, vec3(3, { bufferView: 0 })],
      animations: [animation(n)],
    })
  assert.equal(checkGLTF(text(animated(1))).expandedBytes, 0)
  assert.equal(checkGLTF(text(animated(3))).expandedBytes, 2 * (9 * 4 + 9 * 4))
  assert.throws(() => checkGLTF(text(animated(70000))), /animation channels: 70000, more than 65536/)
  const bytesOut = doc({
    accessors: [
      { componentType: 5126, type: 'SCALAR', count: 9, bufferView: 0 },
      { componentType: 5121, type: 'VEC4', count: 9, bufferView: 0, normalized: true },
    ],
    animations: [animation(1)],
  })
  assert.equal(checkGLTF(text(bytesOut)).expandedBytes, 9 * 4 * 4)
  // a reference to something that does not exist
  assert.throws(() => checkGLTF(text(meshDoc({ nodes: [{ mesh: 3 }] }))), /node 0 mesh 3 does not exist/)
  assert.throws(
    () => checkGLTF(text(doc({ animations: [{ samplers: [], channels: [{ sampler: 0 }] }] }))),
    /sampler 0 does not exist/
  )
})

test('the node hierarchy is a tree: one parent each, no cycles', () => {
  for (const nodes of [
    [{ children: [0] }],
    [{ children: [1] }, { children: [0] }],
    [{ children: [2] }, { children: [2] }, {}],
    [{}, { children: [2] }, { children: [3] }, { children: [1] }],
  ]) {
    assert.throws(() => checkGLTF(text(doc({ nodes }))), /not a tree/, JSON.stringify(nodes))
  }
  assert.throws(() => checkGLTF(text(doc({ nodes: [{ children: [5] }] }))), /child 5 does not exist/)
  // a long chain is fine (and checked in linear time)
  const chain = Array.from({ length: 60000 }, (_, i) => (i < 59999 ? { children: [i + 1] } : {}))
  assert.equal(checkGLTF(text(doc({ nodes: chain }))).nodes, 60000)
})

test('three-vrm: spring bone joints (a VRM 0 group spans each bone’s subtree), colliders and expression binds', () => {
  const limits = { ...GLTF_LIMITS, springJoints: 100, springColliders: 10, expressionBinds: 20 }
  // a chain of 30 nodes; a VRM 0 bone group naming its root four times makes 120 joints
  const nodes = Array.from({ length: 30 }, (_, i) => (i < 29 ? { children: [i + 1] } : {}))
  const v0 = group => doc({ nodes, extensions: { VRM: { secondaryAnimation: { boneGroups: [group] } } } })
  assert.throws(() => checkGLTF(text(v0({ bones: [0, 0, 0, 0] })), limits), /spring bone joints: 120, more than 100/)
  assert.equal(checkGLTF(text(v0({ bones: [0, 10, 20] })), limits).springJoints, 30 + 20 + 10)
  const colliders = doc({
    extensions: { VRM: { secondaryAnimation: { colliderGroups: [{ colliders: Array(11).fill({}) }] } } },
  })
  assert.throws(() => checkGLTF(text(colliders), limits), /spring bone colliders: 11, more than 10/)
  const v1 = doc({
    extensions: { VRMC_springBone: { springs: [{ joints: Array(101).fill({ node: 0 }) }], colliders: [] } },
  })
  assert.throws(() => checkGLTF(text(v1), limits), /spring bone joints: 101/)
  const binds = doc({
    extensions: {
      VRM: {
        blendShapeMaster: { blendShapeGroups: [{ binds: Array(15).fill({}), materialValues: Array(6).fill({}) }] },
      },
    },
  })
  assert.throws(() => checkGLTF(text(binds), limits), /expression binds: 21, more than 20/)
  const v1binds = doc({
    extensions: {
      VRMC_vrm: {
        expressions: {
          preset: { aa: { morphTargetBinds: Array(12).fill({}) } },
          custom: { x: { materialColorBinds: Array(9).fill({}) } },
        },
      },
    },
  })
  assert.throws(() => checkGLTF(text(v1binds), limits), /expression binds: 21/)
})

test('a file that needs a decoder this client does not have fails here, before anything is allocated', () => {
  for (const extensions of [
    { extensionsUsed: ['KHR_draco_mesh_compression'] },
    { extensionsUsed: ['EXT_meshopt_compression'] },
    { extensionsRequired: ['EXT_meshopt_compression'], extensionsUsed: ['EXT_meshopt_compression'] },
    { extensionsRequired: ['KHR_texture_basisu'], extensionsUsed: ['KHR_texture_basisu'] },
  ]) {
    assert.throws(() => checkGLTF(text(doc(extensions))), /needs a decoder this client does not have/)
  }
  // KTX2 textures with a fallback image load without the KTX2 one, as before
  assert.ok(checkGLTF(text(doc({ extensionsUsed: ['KHR_texture_basisu'] }))))
})

// a .glb whose binary chunk holds the given images one after another, each with its own bufferView and image entry
function withImages(headers, extra = {}) {
  const bin = new Uint8Array(headers.reduce((sum, bytes) => sum + bytes.length, 0))
  let offset = 0
  const bufferViews = headers.map(bytes => {
    bin.set(bytes, offset)
    offset += bytes.length
    return { buffer: 0, byteOffset: offset - bytes.length, byteLength: bytes.length }
  })
  const images = headers.map((_, i) => ({ bufferView: i, mimeType: 'image/png' }))
  return glb({ asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }], bufferViews, images, ...extra }, bin)
}

test('embedded images: PNG, JPEG or WebP by signature, a size from the header within the budget for one image', () => {
  assert.equal(GLTF_LIMITS.imagePixels, 36000000)
  // a header of 33 bytes declaring 100000 x 100000: refused before anything decodes it
  assert.throws(() => checkGLTF(withImages([png(100000, 100000)])), /image 0 is larger than 36000000 pixels/)
  assert.throws(() => checkGLTF(withImages([png(0, 10)])), /image 0 has no width or height/)
  assert.throws(() => checkGLTF(withImages([jpeg(9000, 5000)])), /larger than 36000000 pixels/)
  assert.throws(() => checkGLTF(withImages([webp(70000, 600, 'VP8X')])), /larger than 36000000 pixels/)
  // the declared mimeType does not matter: a GIF (or anything else) is refused, also when it says image/png
  assert.throws(
    () => checkGLTF(withImages([gif(10, 10)])),
    /image 0 is not a PNG, JPEG or WebP image with a readable size/
  )
  assert.throws(() => checkGLTF(withImages([png(10, 10).subarray(0, 20)])), /not a PNG, JPEG or WebP/)
  const fine = checkGLTF(
    withImages([png(2048, 2048), jpeg(1024, 1024, { before: [[0xe1, 2000]] }), webp(512, 512, 'VP8L')])
  )
  assert.ok(fine)
  // an image in a data: URI, and one in a data: buffer
  const dataImage = mime =>
    doc({ images: [{ uri: `data:${mime};base64,${Buffer.from(png(10000, 4000)).toString('base64')}` }] })
  assert.throws(() => checkGLTF(text(dataImage('image/png'))), /image 0 is larger than 36000000 pixels/)
  const header = png(100, 100)
  const inBuffer = {
    asset: { version: '2.0' },
    buffers: [
      {
        byteLength: header.length,
        uri: `data:application/octet-stream;base64,${Buffer.from(header).toString('base64')}`,
      },
    ],
    bufferViews: [{ buffer: 0, byteLength: header.length }],
    images: [{ bufferView: 0, mimeType: 'image/png' }],
  }
  assert.ok(checkGLTF(text(inBuffer)))
  const percent = {
    ...doc(),
    images: [
      { uri: `data:image/png,${[...png(20000, 20000)].map(b => `%${b.toString(16).padStart(2, '0')}`).join('')}` },
    ],
  }
  assert.throws(() => checkGLTF(text(percent)), /larger than 36000000 pixels/)
})

test('embedded images: their pixels together are within the budget for a file, each image entry counted', () => {
  assert.equal(GLTF_LIMITS.imagePixelsPerFile, 268435456)
  // sixteen 4096 x 4096 textures fit (256 Mi pixels), a seventeenth does not
  const sixteen = Array.from({ length: 16 }, () => png(4096, 4096))
  assert.ok(checkGLTF(withImages(sixteen)))
  assert.throws(
    () => checkGLTF(withImages([...sixteen, png(64, 64)])),
    /image pixels in the file: 268439552, more than 268435456/
  )
  // ten image entries on one bufferView are ten decodes
  const one = png(6000, 5000)
  const views = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: one.length }],
    bufferViews: [{ buffer: 0, byteLength: one.length }],
  }
  const entries = n => glb({ ...views, images: Array.from({ length: n }, () => ({ bufferView: 0 })) }, one)
  assert.ok(checkGLTF(entries(1)))
  assert.ok(checkGLTF(entries(8)))
  assert.throws(() => checkGLTF(entries(10)), /image pixels in the file: 300000000/)
})

test('embedded images not checked: named by URL (not fetched), only used through KTX2 (no decoder); a blob: URL is refused', () => {
  const ktx2 = Uint8Array.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
  const basis = { KHR_texture_basisu: { source: 0 } }
  assert.ok(
    checkGLTF(withImages([ktx2], { textures: [{ extensions: basis }] })),
    'a KTX2 image the client never decodes'
  )
  assert.throws(
    () => checkGLTF(withImages([ktx2], { textures: [{ source: 0, extensions: basis }] })),
    /not a PNG, JPEG or WebP/,
    'the same image as a texture source is decoded'
  )
  assert.throws(
    () => checkGLTF(withImages([png(9000, 9000)], { textures: [{ extensions: { EXT_texture_webp: { source: 0 } } }] })),
    /larger than 36000000 pixels/
  )
  assert.ok(checkGLTF(text(doc({ images: [{ uri: 'https://elsewhere.example/big.png' }, { uri: 'big.png' }, {}] }))))
  assert.throws(
    () => checkGLTF(text(doc({ images: [{ uri: 'blob:https://world.example/1234' }] }))),
    /image 0 names a blob: URL/
  )
  assert.throws(() => checkGLTF(text(doc({ images: [{ uri: ' BLOB:x' }] }))), /blob: URL/)
})

test('the bundled avatar, emotes and models (the e2e fixtures too) are within the limits', () => {
  // image pixels measured: the avatar's 512 x 512 and 2048 x 2048 PNGs, ai.glb's 256 x 256 WebP, ...
  for (const [name, imagePixels] of [
    ['world/assets/avatar.vrm', 512 * 512 + 2048 * 2048],
    ['world/assets/mp-idle.glb', 0],
    ['world/assets/emote-float.glb', 0],
    ['world/assets/crash-block.glb', 256 * 256],
    ['world/assets/ai.glb', 256 * 256],
    ['client/public/base-environment.glb', 1024 * 1024],
  ]) {
    const stats = checkGLTF(fs.readFileSync(new URL(`../src/${name}`, import.meta.url)))
    assert.ok(stats.expandedBytes < 8 * MiB, `${name}: ${JSON.stringify(stats)}`)
    assert.equal(stats.imagePixels, imagePixels, name)
  }
})
