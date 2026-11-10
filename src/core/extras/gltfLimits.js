// What a glTF file (a .glb, or a .gltf with its buffers inside as data: URIs) makes its parser allocate, read from
// its JSON before three's GLTFLoader and three-vrm run. The parser trusts the counts it is given: an accessor with
// `count: 1000000000` and no data is a 12 GB zero-filled array from a file of a few hundred bytes. A file is
// refused here when what it declares does not fit in the bytes it carries, or when what the parser would make on
// top of those bytes is beyond the limits below.
//
// Pure (no three.js, no DOM), so the server loader can use it too. Throws an Error with the reason; returns the
// counts it measured.

import { MAX_IMAGE_PIXELS, readImageHeader } from './imageHeader.js'

const MiB = 1024 * 1024

export const GLTF_LIMITS = Object.freeze({
  // Bytes the parser allocates that are not a view of the file: accessors without data (zero-filled), sparse
  // accessors (expanded to their full size), bufferViews that overlap (each is copied out of its buffer), GPU
  // instancing matrices (64 bytes per instance and primitive), animation tracks that need their own copy (a
  // non-float or normalized output, an accessor shared by several channels) and morph-target textures (16 bytes
  // per vertex, target and attribute, which the renderer builds). Data inside the file is already bounded by the
  // download limit; this bounds what the file can make out of it. The bundled avatar needs about 3.6 MiB of it
  // (its face morphs) and the bundled emotes none.
  expandedBytes: 64 * MiB,
  // objects: each node, mesh instance and binding is a three.js object (or a matrix) of its own, from a few
  // bytes of JSON. A mesh used by several nodes is instantiated once per node, and a skin once per skinned primitive
  nodes: 65536,
  primitives: 65536,
  meshInstances: 65536, // nodes x the primitives of their mesh
  skinBindings: 262144, // skinned mesh instances x the joints of their skin (a bone inverse matrix each)
  animationChannels: 65536,
  images: 1024,
  // embedded images, read from their headers: each must be a PNG, JPEG or WebP within the per-image budget the
  // loader applies to stand-alone images, and all of a file's images together within 256 Mi pixels: sixteen
  // 4096 x 4096 textures, about 1 GiB decoded (RGBA), a third more once mipmapped on the GPU. The bundled avatar
  // has 4.5 Mi. Each image entry counts, also several on one bufferView (each is decoded on its own)
  imagePixels: MAX_IMAGE_PIXELS,
  imagePixelsPerFile: 256 * MiB,
  textures: 4096,
  materials: 16384,
  // three-vrm: VRM 0 spring bone groups make a joint for every node below each listed bone; expression binds
  // make an object per node using the mesh, and each material bind walks the whole scene
  springJoints: 16384,
  springColliders: 4096,
  expressionBinds: 4096,
})

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
const SPARSE_INDEX_TYPES = [5121, 5123, 5125]
const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
// extensions whose data only a decoder this client does not have can read
const DECODER_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression']

const refuse = reason => {
  throw new Error(`model file: ${reason}`)
}
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = value => Number.isSafeInteger(value) && value >= 0
const list = (value, name) => {
  if (value === undefined) return []
  if (!Array.isArray(value)) refuse(`${name} is not a list`)
  return value
}
const entry = (items, index, name) => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= items.length || !isObject(items[index])) {
    refuse(`${name} ${String(index).slice(0, 20)} does not exist`)
  }
  return items[index]
}
const optionalCount = (value, name) => {
  if (value === undefined) return 0
  if (!isCount(value)) refuse(`${name} is not a whole number`)
  return value
}

// the JSON of a .glb (its header and chunks, read as GLTFLoader reads them: the last JSON and BIN chunks win) or of
// a .gltf, and the length and bytes of the GLB's binary chunk (null without one)
export function readGLTF(data) {
  const bytes =
    data instanceof Uint8Array
      ? data
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let text
  let bin = null
  let binBytes = null
  if (bytes.byteLength >= 4 && view.getUint32(0, true) === GLB_MAGIC) {
    if (bytes.byteLength < 12) refuse('the GLB header is cut short')
    if (view.getUint32(4, true) < 2) refuse('a GLB older than version 2')
    const length = view.getUint32(8, true)
    if (length > bytes.byteLength) refuse('the GLB is shorter than its header says')
    let position = 12
    while (position < length) {
      if (position + 8 > bytes.byteLength) refuse('a GLB chunk header is cut short')
      const chunkLength = view.getUint32(position, true)
      const type = view.getUint32(position + 4, true)
      const start = position + 8
      if (type === CHUNK_JSON) {
        if (start + chunkLength > bytes.byteLength) refuse('the GLB JSON chunk is cut short')
        text = new TextDecoder().decode(bytes.subarray(start, start + chunkLength))
      } else if (type === CHUNK_BIN) {
        bin = Math.max(0, Math.min(chunkLength, bytes.byteLength - start))
        binBytes = bytes.subarray(start, start + bin)
      }
      position = start + chunkLength
    }
    if (text === undefined) refuse('the GLB has no JSON chunk')
  } else {
    text = new TextDecoder().decode(bytes)
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    refuse('the JSON does not parse')
  }
  if (!isObject(json)) refuse('the JSON is not an object')
  return { json, bin, binBytes }
}

// the bytes a data: URI holds once decoded (at most: percent escapes are counted as one byte each)
// the bytes of a data: URI (base64 or percent-encoded)
function dataURIDecode(uri) {
  const comma = uri.indexOf(',')
  const payload = comma < 0 ? '' : uri.slice(comma + 1)
  if (/;base64$/i.test(uri.slice(5, Math.max(comma, 5)))) {
    let text
    try {
      text = atob(payload.replace(/[\t\n\f\r ]/g, ''))
    } catch {
      refuse('a data: URI is not valid base64')
    }
    return Uint8Array.from(text, char => char.charCodeAt(0))
  }
  const out = []
  for (let i = 0; i < payload.length; i++) {
    const hex = payload[i] === '%' ? payload.slice(i + 1, i + 3) : ''
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      out.push(parseInt(hex, 16))
      i += 2
    } else {
      out.push(payload.charCodeAt(i) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

function dataURIBytes(uri) {
  const comma = uri.indexOf(',')
  if (comma < 0) return 0
  const payload = uri.slice(comma + 1)
  if (!/;base64$/i.test(uri.slice(5, comma))) return payload.length - 2 * (payload.match(/%[0-9a-f]{2}/gi) || []).length
  const digits = payload.replace(/[\t\n\f\r ]/g, '').replace(/=+$/, '').length
  return Math.floor((digits * 3) / 4)
}

export function checkGLTF(data, limits = GLTF_LIMITS) {
  const { json, bin, binBytes } = readGLTF(data)
  const used = list(json.extensionsUsed, 'extensionsUsed')
  const required = list(json.extensionsRequired, 'extensionsRequired')
  for (const name of DECODER_EXTENSIONS) {
    if (used.includes(name) || required.includes(name)) refuse(`it needs a decoder this client does not have (${name})`)
  }
  if (required.includes('KHR_texture_basisu'))
    refuse('it needs a decoder this client does not have (KHR_texture_basisu)')

  let expanded = 0
  const over = (value, limit, what) => {
    if (value > limit) refuse(`${what}: ${value}, more than ${limit}`)
  }

  // buffers: data the file carries. A GLB's first buffer is its binary chunk; any other buffer must be a data: URI
  // (anything else is an external file, which the client refuses), and none may declare more than it holds
  const buffers = list(json.buffers, 'buffers').map((buffer, i) => {
    if (!isObject(buffer)) refuse(`buffer ${i} is not an object`)
    if (!isCount(buffer.byteLength)) refuse(`buffer ${i} has no valid byteLength`)
    let holds
    if (buffer.uri === undefined) {
      if (i !== 0 || bin === null) refuse(`buffer ${i} has no data in the file`)
      holds = bin
    } else if (typeof buffer.uri === 'string' && buffer.uri.startsWith('data:')) {
      holds = dataURIBytes(buffer.uri)
    } else {
      refuse(`a model may not reference external files (buffer ${i})`)
    }
    if (buffer.byteLength > holds) refuse(`buffer ${i} declares ${buffer.byteLength} bytes and holds ${holds}`)
    return buffer.byteLength
  })
  const bufferTotal = buffers.reduce((sum, bytes) => sum + bytes, 0)

  // bufferViews inside their buffer; each one the parser reads is copied out, so overlapping views cost extra
  const views = list(json.bufferViews, 'bufferViews')
  let viewTotal = 0
  views.forEach((view, i) => {
    if (!isObject(view)) refuse(`bufferView ${i} is not an object`)
    if (!Number.isSafeInteger(view.buffer) || view.buffer < 0 || view.buffer >= buffers.length) {
      refuse(`bufferView ${i} names no buffer`)
    }
    const offset = optionalCount(view.byteOffset, `bufferView ${i} byteOffset`)
    if (!isCount(view.byteLength)) refuse(`bufferView ${i} has no valid byteLength`)
    if (
      view.byteStride !== undefined &&
      (!Number.isSafeInteger(view.byteStride) || view.byteStride < 1 || view.byteStride > 252)
    ) {
      refuse(`bufferView ${i} has an invalid byteStride`)
    }
    if (offset + view.byteLength > buffers[view.buffer]) refuse(`bufferView ${i} does not fit in its buffer`)
    viewTotal += view.byteLength
  })
  expanded += Math.max(0, viewTotal - bufferTotal)

  // accessors: element size, count, and where the data is. With a bufferView the parser makes a view of it, which
  // must fit; without one, and for sparse accessors, it allocates the whole array
  const accessors = list(json.accessors, 'accessors')
  const sizes = accessors.map((accessor, i) => {
    if (!isObject(accessor)) refuse(`accessor ${i} is not an object`)
    const itemSize = TYPE_SIZES[accessor.type]
    const elementBytes = COMPONENT_BYTES[accessor.componentType]
    if (!itemSize || !elementBytes || !isCount(accessor.count))
      refuse(`accessor ${i} has an invalid type, componentType or count`)
    const itemBytes = itemSize * elementBytes
    const bytes = accessor.count * itemBytes
    if (!Number.isSafeInteger(bytes)) refuse(`accessor ${i} is too large`)
    if (accessor.bufferView !== undefined) {
      const view = entry(views, accessor.bufferView, `accessor ${i} bufferView`)
      const offset = optionalCount(accessor.byteOffset, `accessor ${i} byteOffset`)
      const stride = view.byteStride
      // an interleaved view is read as whole strides from the stride the offset falls in (GLTFLoader)
      const end =
        stride && stride !== itemBytes ? (Math.floor(offset / stride) + accessor.count) * stride : offset + bytes
      if (!Number.isSafeInteger(end) || end > view.byteLength) refuse(`accessor ${i} does not fit in its bufferView`)
    } else if (accessor.sparse === undefined) {
      expanded += bytes
    }
    if (accessor.sparse !== undefined) {
      const sparse = accessor.sparse
      if (!isObject(sparse) || !isObject(sparse.indices) || !isObject(sparse.values))
        refuse(`accessor ${i} has an invalid sparse part`)
      if (!Number.isSafeInteger(sparse.count) || sparse.count < 1 || sparse.count > accessor.count) {
        refuse(`accessor ${i} has an invalid sparse count`)
      }
      if (!SPARSE_INDEX_TYPES.includes(sparse.indices.componentType)) refuse(`accessor ${i} has invalid sparse indices`)
      const fits = (part, bytesPer, name) => {
        const view = entry(views, part.bufferView, `accessor ${i} sparse ${name} bufferView`)
        const offset = optionalCount(part.byteOffset, `accessor ${i} sparse ${name} byteOffset`)
        if (offset + sparse.count * bytesPer > view.byteLength)
          refuse(`accessor ${i} sparse ${name} do not fit in their bufferView`)
      }
      fits(sparse.indices, COMPONENT_BYTES[sparse.indices.componentType], 'indices')
      fits(sparse.values, itemBytes, 'values')
      expanded += bytes
    }
    return { count: accessor.count, itemSize, float: accessor.componentType === 5126 && accessor.normalized !== true }
  })
  const accessorAt = (index, name) => {
    entry(accessors, index, name)
    return sizes[index]
  }

  // meshes and primitives; morph targets become a texture of 16 bytes per vertex, target and attribute
  const meshes = list(json.meshes, 'meshes')
  let primitiveTotal = 0
  const primitivesOf = meshes.map((mesh, i) => {
    if (!isObject(mesh)) refuse(`mesh ${i} is not an object`)
    const primitives = list(mesh.primitives, `mesh ${i} primitives`)
    primitiveTotal += primitives.length
    for (const primitive of primitives) {
      if (!isObject(primitive) || !isObject(primitive.attributes)) refuse(`mesh ${i} has an invalid primitive`)
      for (const index of Object.values(primitive.attributes)) accessorAt(index, `mesh ${i} attribute accessor`)
      if (primitive.indices !== undefined) accessorAt(primitive.indices, `mesh ${i} indices accessor`)
      const targets = list(primitive.targets, `mesh ${i} targets`)
      if (targets.length > 0) {
        const vertices = primitive.attributes.POSITION === undefined ? 0 : sizes[primitive.attributes.POSITION].count
        const kinds = new Set()
        for (const target of targets) {
          if (!isObject(target)) refuse(`mesh ${i} has an invalid morph target`)
          for (const [name, index] of Object.entries(target)) {
            accessorAt(index, `mesh ${i} morph target accessor`)
            if (name === 'POSITION' || name === 'NORMAL' || name === 'COLOR_0') kinds.add(name)
          }
        }
        expanded += vertices * targets.length * kinds.size * 16
      }
    }
    return primitives.length
  })
  over(primitiveTotal, limits.primitives, 'primitives')

  // nodes: a tree (one parent each, no cycles), each mesh instantiated per node, each skin bound per primitive
  const nodes = list(json.nodes, 'nodes')
  over(nodes.length, limits.nodes, 'nodes')
  const skins = list(json.skins, 'skins')
  const parents = new Array(nodes.length).fill(-1)
  const children = nodes.map(() => [])
  let meshInstances = 0
  let skinBindings = 0
  nodes.forEach((node, i) => {
    if (!isObject(node)) refuse(`node ${i} is not an object`)
    for (const child of list(node.children, `node ${i} children`)) {
      entry(nodes, child, `node ${i} child`)
      if (parents[child] !== -1 || child === i) refuse('the node hierarchy is not a tree')
      parents[child] = i
      children[i].push(child)
    }
    if (node.mesh !== undefined) {
      entry(meshes, node.mesh, `node ${i} mesh`)
      const primitives = primitivesOf[node.mesh]
      meshInstances += primitives
      if (node.skin !== undefined) {
        const skin = entry(skins, node.skin, `node ${i} skin`)
        skinBindings += primitives * list(skin.joints, `skin ${node.skin} joints`).length
      }
      const instancing = node.extensions?.EXT_mesh_gpu_instancing?.attributes
      if (isObject(instancing)) {
        const first = Object.values(instancing)[0]
        if (first !== undefined) expanded += accessorAt(first, `node ${i} instancing accessor`).count * primitives * 64
      }
    }
  })
  // parents before children, from the roots; with one parent each, a node the roots do not reach is in a cycle
  const order = []
  for (let i = 0; i < nodes.length; i++) if (parents[i] === -1) order.push(i)
  for (let k = 0; k < order.length; k++) for (const child of children[order[k]]) order.push(child)
  if (order.length !== nodes.length) refuse('the node hierarchy is not a tree')
  over(meshInstances, limits.meshInstances, 'mesh instances')
  over(skinBindings, limits.skinBindings, 'skin bindings')
  for (const [i, skin] of skins.entries()) {
    if (!isObject(skin)) refuse(`skin ${i} is not an object`)
    for (const joint of list(skin.joints, `skin ${i} joints`)) entry(nodes, joint, `skin ${i} joint`)
    if (skin.inverseBindMatrices !== undefined) accessorAt(skin.inverseBindMatrices, `skin ${i} inverseBindMatrices`)
  }

  // animations: a track is a view of its accessors the first time a float accessor is used; any other use is a copy
  let channels = 0
  const viewed = new Set()
  const trackBytes = index => {
    const size = accessorAt(index, 'animation accessor')
    if (size.float && !viewed.has(index)) {
      viewed.add(index)
      return 0
    }
    return size.count * size.itemSize * 4
  }
  for (const [i, animation] of list(json.animations, 'animations').entries()) {
    if (!isObject(animation)) refuse(`animation ${i} is not an object`)
    const samplers = list(animation.samplers, `animation ${i} samplers`)
    for (const channel of list(animation.channels, `animation ${i} channels`)) {
      channels++
      if (!isObject(channel)) refuse(`animation ${i} has an invalid channel`)
      const sampler = entry(samplers, channel.sampler, `animation ${i} sampler`)
      expanded += trackBytes(sampler.input) + trackBytes(sampler.output)
    }
  }
  over(channels, limits.animationChannels, 'animation channels')
  const imagePixels = checkImages(json, views, binBytes, limits, over)
  over(list(json.textures, 'textures').length, limits.textures, 'textures')
  over(list(json.materials, 'materials').length, limits.materials, 'materials')

  const vrm = checkVRM(json, parents, order, limits, over)
  over(expanded, limits.expandedBytes, 'bytes the parser would allocate beyond the file')
  return {
    expandedBytes: expanded,
    nodes: nodes.length,
    primitives: primitiveTotal,
    meshInstances,
    skinBindings,
    channels,
    imagePixels,
    ...vrm,
  }
}

// Embedded images (a bufferView, or a data: URI): the client decodes each image entry, so each must be a PNG, JPEG
// or WebP (by its signature, whatever mimeType it declares) with a size from its header within the budgets. Not
// checked: an image the file names by URL (the client does not fetch it; its material goes without), one with
// neither (the parser skips it), and one only KHR_texture_basisu uses (this client has no KTX2 decoder, so the
// parser takes the fallback). A blob: URL is refused: it is no file's own data and would be decoded unchecked.
function checkImages(json, views, binBytes, limits, over) {
  const images = list(json.images, 'images')
  over(images.length, limits.images, 'images')
  const decoded = new Set()
  const basisOnly = new Set()
  for (const texture of list(json.textures, 'textures')) {
    if (!isObject(texture)) continue
    if (texture.source !== undefined) decoded.add(texture.source)
    const extensions = isObject(texture.extensions) ? texture.extensions : {}
    for (const name of ['EXT_texture_webp', 'EXT_texture_avif']) {
      if (isObject(extensions[name])) decoded.add(extensions[name].source)
    }
    if (isObject(extensions.KHR_texture_basisu)) basisOnly.add(extensions.KHR_texture_basisu.source)
  }
  const buffers = list(json.buffers, 'buffers')
  const bufferBytes = new Map()
  const bytesOfBuffer = index => {
    if (!bufferBytes.has(index)) {
      const uri = buffers[index].uri
      bufferBytes.set(index, uri === undefined ? binBytes : dataURIDecode(uri))
    }
    return bufferBytes.get(index)
  }
  let pixels = 0
  images.forEach((image, i) => {
    if (!isObject(image)) refuse(`image ${i} is not an object`)
    if (basisOnly.has(i) && !decoded.has(i)) return
    let bytes
    if (image.bufferView !== undefined) {
      const view = entry(views, image.bufferView, `image ${i} bufferView`)
      const offset = view.byteOffset ?? 0
      bytes = bytesOfBuffer(view.buffer).subarray(offset, offset + view.byteLength)
    } else if (typeof image.uri === 'string' && image.uri.startsWith('data:')) {
      bytes = dataURIDecode(image.uri)
    } else if (typeof image.uri === 'string' && image.uri.trim().toLowerCase().startsWith('blob:')) {
      refuse(`image ${i} names a blob: URL`)
    } else {
      return
    }
    const header = readImageHeader(bytes)
    if (!header) refuse(`image ${i} is not a PNG, JPEG or WebP image with a readable size`)
    if (!(header.width > 0 && header.height > 0)) refuse(`image ${i} has no width or height`)
    const size = header.width * header.height
    if (size > limits.imagePixels) refuse(`image ${i} is larger than ${limits.imagePixels} pixels`)
    pixels += size
  })
  over(pixels, limits.imagePixelsPerFile, 'image pixels in the file')
  return pixels
}

// three-vrm's spring bones and expressions (VRM 0 and VRM 1)
function checkVRM(json, parents, order, limits, over) {
  const extensions = isObject(json.extensions) ? json.extensions : {}
  let springJoints = 0
  let springColliders = 0
  let expressionBinds = 0
  const v0 = isObject(extensions.VRM) ? extensions.VRM : null
  if (v0) {
    // a VRM 0 bone group makes a joint for every node below each bone it lists (the bone included)
    const below = new Array(parents.length).fill(1)
    for (let k = order.length - 1; k >= 0; k--) {
      const node = order[k]
      if (parents[node] !== -1) below[parents[node]] += below[node]
    }
    const secondary = isObject(v0.secondaryAnimation) ? v0.secondaryAnimation : {}
    for (const group of list(secondary.boneGroups, 'VRM boneGroups')) {
      if (!isObject(group)) continue
      for (const bone of list(group.bones, 'VRM boneGroup bones')) {
        if (Number.isSafeInteger(bone) && bone >= 0 && bone < parents.length) springJoints += below[bone]
      }
    }
    for (const group of list(secondary.colliderGroups, 'VRM colliderGroups')) {
      if (isObject(group)) springColliders += list(group.colliders, 'VRM colliders').length
    }
    const master = isObject(v0.blendShapeMaster) ? v0.blendShapeMaster : {}
    for (const group of list(master.blendShapeGroups, 'VRM blendShapeGroups')) {
      if (!isObject(group)) continue
      expressionBinds += list(group.binds, 'VRM binds').length + list(group.materialValues, 'VRM materialValues').length
    }
  }
  const springs = isObject(extensions.VRMC_springBone) ? extensions.VRMC_springBone : null
  if (springs) {
    for (const spring of list(springs.springs, 'VRMC springs')) {
      if (isObject(spring)) springJoints += list(spring.joints, 'VRMC spring joints').length
    }
    springColliders += list(springs.colliders, 'VRMC colliders').length
  }
  const v1 =
    isObject(extensions.VRMC_vrm) && isObject(extensions.VRMC_vrm.expressions) ? extensions.VRMC_vrm.expressions : null
  if (v1) {
    for (const group of [v1.preset, v1.custom]) {
      if (!isObject(group)) continue
      for (const expression of Object.values(group)) {
        if (!isObject(expression)) continue
        for (const key of ['morphTargetBinds', 'materialColorBinds', 'textureTransformBinds']) {
          expressionBinds += list(expression[key], `VRMC ${key}`).length
        }
      }
    }
  }
  over(springJoints, limits.springJoints, 'spring bone joints')
  over(springColliders, limits.springColliders, 'spring bone colliders')
  over(expressionBinds, limits.expressionBinds, 'expression binds')
  return { springJoints, springColliders, expressionBinds }
}
