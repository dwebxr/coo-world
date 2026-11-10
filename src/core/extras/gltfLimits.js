// Limits for a glTF file (a .glb, or a .gltf with its buffers inside as data: URIs) that another user supplies.
// Pure (no three.js, no DOM), so the server loader can use it too. Two parts:
//
// - checkGLTF(data): before parsing. The container and the document's structure: chunk lengths, the JSON's size and
//   nesting, every index a non-negative integer in range, every list a real list within a length, the node
//   hierarchy a tree of bounded depth, no glTF 1.0 leftovers the parser still honours, required extensions this
//   client can load, and three-vrm's work counted the way its plugins expand it (three-vrm is not vendored, so it is
//   bounded before it runs).
// - createGLTFBudget(): the per-file budget the vendored GLTFLoader (src/core/libs/gltfloader/GLTFLoader.js, see its
//   COO_BUDGET sites) charges where it allocates, copies, clones or creates objects, and where it is about to decode
//   an image. Nothing is predicted: what the parser does is what is counted.
//
// Both throw a GLTFLimitError with the reason.

import { MAX_IMAGE_PIXELS, readImageHeader } from './imageHeader.js'

const MiB = 1024 * 1024

export const GLTF_LIMITS = Object.freeze({
  // structure (checkGLTF). The bundled avatar's JSON is 44 KB and nests 8 deep, its node tree 12 deep (the emotes': 14)
  jsonBytes: 16 * MiB, // a GLB's JSON chunk
  jsonDepth: 64, // objects and lists inside each other
  nodeDepth: 256, // the parser loads a node's children recursively; a chain of thousands overflowed its stack
  listLength: 1 << 20, // any list in the document
  targets: 1024, // morph targets of one primitive
  // the parser (createGLTFBudget): bytes it allocates, beyond twice the file's own size (the GLB's binary chunk and
  // the bufferViews are each a copy of the file's data). The bundled avatar's parse allocates 17.8 MB: twice its
  // 4.8 MB, and 8.1 MB more (its face's morph-target texture and the copy of its texture image)
  allocatedBytes: 64 * MiB,
  // objects it creates, per file, counting every clone (a mesh used by several nodes is instantiated per node)
  counts: Object.freeze({
    scenes: 64,
    cameras: 1024,
    lights: 1024,
    nodes: 65536,
    meshes: 16384,
    primitives: 65536, // geometries
    meshInstances: 65536, // Mesh, Line, Points objects
    skins: 1024,
    joints: 262144, // a bone inverse matrix each
    animations: 1024,
    channels: 65536,
    tracks: 65536,
    materials: 16384,
    textures: 16384,
    images: 1024, // decodes
    influences: 262144, // morph target influences, on every mesh and clone
  }),
  // images it decodes, sized from their headers before the decode: each within the budget for a stand-alone image,
  // and all of a file's decodes together within 256 Mi pixels (sixteen 4096 x 4096 textures, about 1 GiB decoded
  // RGBA, a third more once mipmapped on the GPU). The bundled avatar decodes 4 Mi (its 2048 x 2048 texture)
  imagePixels: MAX_IMAGE_PIXELS,
  imagePixelsPerFile: 256 * MiB,
  // three-vrm, counted before it runs as its plugins expand it (@pixiv/three-vrm 3.3.3)
  vrm: Object.freeze({
    expressions: 1024, // a VRMExpression object each, added to the scene
    expressionBinds: 16384, // bind objects: a morph bind per node using its mesh, a material bind per material
    expressionPrimitives: 262144, // primitives those binds refer to
    expressionWork: 16 * MiB, // iterations: each VRM 0 bind walks every node, each material bind every material
    springJoints: 16384,
    springColliders: 4096,
    springColliderWork: 1 * MiB, // joints x the colliders of their groups (what each spring update visits)
    firstPersonWork: 1 * MiB, // nodes with a mesh x mesh annotations (each node searches the annotations)
    constraints: 4096,
  }),
})

export class GLTFLimitError extends Error {
  constructor(reason) {
    super(`model file: ${reason}`)
    this.name = 'GLTFLimitError'
    this.isGLTFLimit = true
  }
}

const refuse = reason => {
  throw new GLTFLimitError(reason)
}
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

// how deeply objects and lists nest in a JSON text (strings skipped)
function jsonDepth(text) {
  let depth = 0
  let deepest = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    if (inString) {
      if (char === 92) {
        i++ // backslash: skip the escaped character
      } else if (char === 34) inString = false
    } else if (char === 34) {
      inString = true
    } else if (char === 123 || char === 91) {
      depth++
      if (depth > deepest) deepest = depth
    } else if (char === 125 || char === 93) {
      depth--
    }
  }
  return deepest
}

// the JSON of a .glb (its header and chunks, read as GLTFLoader reads them: the last JSON and BIN chunks win) or of
// a .gltf, and the length of the GLB's binary chunk (null without one)
export function readGLTF(data, limits = GLTF_LIMITS) {
  const bytes =
    data instanceof Uint8Array
      ? data
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let text
  let bin = null
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
        if (chunkLength > limits.jsonBytes) {
          refuse(`the JSON chunk is ${chunkLength} bytes, more than ${limits.jsonBytes}`)
        }
        text = new TextDecoder().decode(bytes.subarray(start, start + chunkLength))
      } else if (type === CHUNK_BIN) {
        bin = Math.max(0, Math.min(chunkLength, bytes.byteLength - start))
      }
      position = start + chunkLength
    }
    if (text === undefined) refuse('the GLB has no JSON chunk')
  } else {
    text = new TextDecoder().decode(bytes)
  }
  const depth = jsonDepth(text)
  if (depth > limits.jsonDepth) refuse(`the JSON nests ${depth} deep, more than ${limits.jsonDepth}`)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    refuse('the JSON does not parse')
  }
  if (!isObject(json)) refuse('the JSON is not an object')
  return { json, bin }
}

// the bytes of a data: URI (base64 or percent-encoded)
export function decodeDataURI(uri) {
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

// extensions a file may require: the ones this client's parser and plugins implement. Draco, meshopt and KTX2 need
// decoders it does not have, and AVIF images are refused at decode; any of them may be optional (the parser then
// reads the fallback data)
const LOADABLE_EXTENSIONS = new Set([
  'KHR_materials_unlit',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
  'KHR_lights_punctual',
  'KHR_materials_emissive_strength',
  'KHR_materials_clearcoat',
  'KHR_materials_dispersion',
  'KHR_materials_iridescence',
  'KHR_materials_sheen',
  'KHR_materials_transmission',
  'KHR_materials_volume',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_materials_anisotropy',
  'KHR_materials_bump',
  'EXT_texture_webp',
  'EXT_mesh_gpu_instancing',
  'VRM',
  'VRMC_vrm',
  'VRMC_springBone',
  'VRMC_springBone_extended_collider',
  'VRMC_node_constraint',
  'VRMC_materials_mtoon',
  'VRMC_materials_hdr_emissiveMultiplier',
  'VRMC_vrm_animation',
])

const COMPONENT_TYPES = [5120, 5121, 5122, 5123, 5125, 5126]
const ACCESSOR_TYPES = ['SCALAR', 'VEC2', 'VEC3', 'VEC4', 'MAT2', 'MAT3', 'MAT4']

export function checkGLTF(data, limits = GLTF_LIMITS) {
  const { json, bin } = readGLTF(data, limits)
  if (!isObject(json.asset) || typeof json.asset.version !== 'string' || !/^2\./.test(json.asset.version)) {
    refuse('not a glTF 2.0 document')
  }

  // the structure: lists, objects, indices
  const list = (value, where, max = limits.listLength) => {
    if (value === undefined) return []
    if (!Array.isArray(value)) refuse(`${where} is not a list`)
    if (value.length > max) refuse(`${where} has ${value.length} entries, more than ${max}`)
    return value
  }
  const object = (value, where) => {
    if (value === undefined) return {}
    if (!isObject(value)) refuse(`${where} is not an object`)
    return value
  }
  const items = (value, where) =>
    list(value, where).map((entry, i) => {
      if (!isObject(entry)) refuse(`${where} ${i} is not an object`)
      return entry
    })
  const whole = (value, where, min = 0) => {
    if (value === undefined) return
    if (!Number.isSafeInteger(value) || value < min) refuse(`${where} is not a whole number`)
  }
  const numbers = (value, where, length) => {
    const values = list(value, where)
    if (length !== undefined && value !== undefined && values.length !== length) {
      refuse(`${where} does not have ${length} numbers`)
    }
    if (!values.every(Number.isFinite)) refuse(`${where} is not all numbers`)
  }

  const collections = {}
  for (const name of [
    'accessors',
    'animations',
    'buffers',
    'bufferViews',
    'cameras',
    'images',
    'materials',
    'meshes',
    'nodes',
    'samplers',
    'scenes',
    'skins',
    'textures',
  ]) {
    collections[name] = items(json[name], name)
  }
  const extensions = object(json.extensions, 'extensions')
  const lightsExtension = object(extensions.KHR_lights_punctual, 'KHR_lights_punctual')
  collections.lights = items(lightsExtension.lights, 'KHR_lights_punctual lights')
  // an index into one of the collections (a string is refused: the parser would coerce it)
  const index = (value, collection, where) => {
    if (value === undefined) return
    if (!Number.isSafeInteger(value) || value < 0 || value >= collections[collection].length) {
      refuse(`${where} is not an index of ${collection} (${JSON.stringify(value).slice(0, 20)})`)
    }
  }
  const indexMap = (value, collection, where) => {
    for (const [key, entry] of Object.entries(object(value, where))) index(entry, collection, `${where} ${key}`)
  }

  const used = list(json.extensionsUsed, 'extensionsUsed')
  const required = list(json.extensionsRequired, 'extensionsRequired')
  if (!used.every(name => typeof name === 'string') || !required.every(name => typeof name === 'string')) {
    refuse('an extension name is not a string')
  }
  for (const name of required) {
    if (!LOADABLE_EXTENSIONS.has(name)) {
      refuse(`it requires an extension this client cannot load (${name.slice(0, 60)})`)
    }
  }

  index(json.scene, 'scenes', 'scene')
  collections.scenes.forEach((scene, i) => {
    for (const node of list(scene.nodes, `scene ${i} nodes`)) index(node, 'nodes', `scene ${i} node`)
  })
  collections.buffers.forEach((buffer, i) => {
    if (buffer.type !== undefined) refuse(`buffer ${i} has a glTF 1.0 type`)
    whole(buffer.byteLength, `buffer ${i} byteLength`)
    // a GLB's first buffer is its binary chunk; any other buffer must be a data: URI
    if (buffer.uri === undefined) {
      if (i !== 0 || bin === null) refuse(`buffer ${i} has no data in the file`)
    } else if (typeof buffer.uri !== 'string' || !buffer.uri.startsWith('data:')) {
      refuse(`a model may not reference external files (buffer ${i})`)
    }
  })
  collections.bufferViews.forEach((view, i) => {
    if (view.buffer === undefined) refuse(`bufferView ${i} names no buffer`)
    index(view.buffer, 'buffers', `bufferView ${i} buffer`)
    whole(view.byteOffset, `bufferView ${i} byteOffset`)
    whole(view.byteLength, `bufferView ${i} byteLength`)
    whole(view.byteStride, `bufferView ${i} byteStride`, 1)
    const meshopt = object(object(view.extensions, `bufferView ${i} extensions`).EXT_meshopt_compression, 'meshopt')
    index(meshopt.buffer, 'buffers', `bufferView ${i} meshopt buffer`)
    for (const key of ['byteOffset', 'byteLength', 'byteStride', 'count'])
      whole(meshopt[key], `bufferView ${i} meshopt ${key}`)
  })
  collections.accessors.forEach((accessor, i) => {
    index(accessor.bufferView, 'bufferViews', `accessor ${i} bufferView`)
    whole(accessor.byteOffset, `accessor ${i} byteOffset`)
    whole(accessor.count, `accessor ${i} count`)
    if (accessor.count === undefined) refuse(`accessor ${i} has no count`)
    if (!COMPONENT_TYPES.includes(accessor.componentType) || !ACCESSOR_TYPES.includes(accessor.type)) {
      refuse(`accessor ${i} has an invalid componentType or type`)
    }
    numbers(accessor.min, `accessor ${i} min`)
    numbers(accessor.max, `accessor ${i} max`)
    if (accessor.sparse !== undefined) {
      const sparse = object(accessor.sparse, `accessor ${i} sparse`)
      whole(sparse.count, `accessor ${i} sparse count`, 1)
      for (const part of ['indices', 'values']) {
        const def = object(sparse[part], `accessor ${i} sparse ${part}`)
        if (def.bufferView === undefined) refuse(`accessor ${i} sparse ${part} has no bufferView`)
        index(def.bufferView, 'bufferViews', `accessor ${i} sparse ${part} bufferView`)
        whole(def.byteOffset, `accessor ${i} sparse ${part} byteOffset`)
      }
      if (![5121, 5123, 5125].includes(sparse.indices.componentType)) refuse(`accessor ${i} has invalid sparse indices`)
    }
  })
  collections.images.forEach((image, i) => {
    index(image.bufferView, 'bufferViews', `image ${i} bufferView`)
    if (image.uri !== undefined && typeof image.uri !== 'string') refuse(`image ${i} uri is not a string`)
    // a blob: URL is no file's own data, and the client's URL filter lets blob: through (for embedded images)
    if (typeof image.uri === 'string' && image.uri.trim().toLowerCase().startsWith('blob:')) {
      refuse(`image ${i} names a blob: URL`)
    }
  })
  collections.textures.forEach((texture, i) => {
    index(texture.source, 'images', `texture ${i} source`)
    index(texture.sampler, 'samplers', `texture ${i} sampler`)
    const textureExtensions = object(texture.extensions, `texture ${i} extensions`)
    for (const name of ['EXT_texture_webp', 'EXT_texture_avif', 'KHR_texture_basisu']) {
      index(object(textureExtensions[name], name).source, 'images', `texture ${i} ${name} source`)
    }
  })
  // every texture reference in a material, its extensions included: a `...Texture` object with an index
  collections.materials.forEach((material, i) => {
    const visit = (value, where) => {
      if (Array.isArray(value)) return value.forEach((entry, k) => visit(entry, `${where} ${k}`))
      if (!isObject(value)) return
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'extras') continue
        if (/Texture$/.test(key) && entry !== undefined) {
          const info = object(entry, `material ${i} ${key}`)
          if (info.index === undefined) refuse(`material ${i} ${key} has no index`)
          index(info.index, 'textures', `material ${i} ${key} index`)
          whole(info.texCoord, `material ${i} ${key} texCoord`)
        }
        visit(entry, `${where} ${key}`)
      }
    }
    visit(material, `material ${i}`)
  })
  collections.meshes.forEach((mesh, i) => {
    numbers(mesh.weights, `mesh ${i} weights`)
    items(mesh.primitives, `mesh ${i} primitives`).forEach((primitive, k) => {
      const where = `mesh ${i} primitive ${k}`
      indexMap(primitive.attributes, 'accessors', `${where} attribute`)
      index(primitive.indices, 'accessors', `${where} indices`)
      index(primitive.material, 'materials', `${where} material`)
      whole(primitive.mode, `${where} mode`)
      if (primitive.mode > 6) refuse(`${where} has an unknown mode`)
      items(list(primitive.targets, `${where} targets`, limits.targets), `${where} targets`).forEach((target, t) =>
        indexMap(target, 'accessors', `${where} target ${t}`)
      )
      const draco = object(object(primitive.extensions, `${where} extensions`).KHR_draco_mesh_compression, 'draco')
      index(draco.bufferView, 'bufferViews', `${where} draco bufferView`)
    })
  })
  collections.cameras.forEach((camera, i) => {
    if (typeof camera.type !== 'string') refuse(`camera ${i} has no type`)
  })
  collections.skins.forEach((skin, i) => {
    for (const joint of list(skin.joints, `skin ${i} joints`)) index(joint, 'nodes', `skin ${i} joint`)
    index(skin.skeleton, 'nodes', `skin ${i} skeleton`)
    index(skin.inverseBindMatrices, 'accessors', `skin ${i} inverseBindMatrices`)
  })
  collections.animations.forEach((animation, i) => {
    // glTF 1.0: the vendored parser still reads accessors through `parameters` when it is there
    if (animation.parameters !== undefined) refuse(`animation ${i} has glTF 1.0 parameters`)
    const samplers = items(animation.samplers, `animation ${i} samplers`)
    samplers.forEach((sampler, k) => {
      index(sampler.input, 'accessors', `animation ${i} sampler ${k} input`)
      index(sampler.output, 'accessors', `animation ${i} sampler ${k} output`)
    })
    items(animation.channels, `animation ${i} channels`).forEach((channel, k) => {
      if (!Number.isSafeInteger(channel.sampler) || channel.sampler < 0 || channel.sampler >= samplers.length) {
        refuse(`animation ${i} channel ${k} sampler is not an index of its samplers`)
      }
      index(
        object(channel.target, `animation ${i} channel ${k} target`).node,
        'nodes',
        `animation ${i} channel ${k} node`
      )
    })
  })

  // nodes: references, then the hierarchy (a tree of bounded depth)
  const nodes = collections.nodes
  const parents = new Array(nodes.length).fill(-1)
  const children = nodes.map(() => [])
  nodes.forEach((node, i) => {
    for (const child of list(node.children, `node ${i} children`)) {
      index(child, 'nodes', `node ${i} child`)
      if (parents[child] !== -1 || child === i) refuse('the node hierarchy is not a tree')
      parents[child] = i
      children[i].push(child)
    }
    index(node.mesh, 'meshes', `node ${i} mesh`)
    index(node.skin, 'skins', `node ${i} skin`)
    index(node.camera, 'cameras', `node ${i} camera`)
    numbers(node.matrix, `node ${i} matrix`, 16)
    numbers(node.translation, `node ${i} translation`, 3)
    numbers(node.rotation, `node ${i} rotation`, 4)
    numbers(node.scale, `node ${i} scale`, 3)
    numbers(node.weights, `node ${i} weights`)
    const nodeExtensions = object(node.extensions, `node ${i} extensions`)
    index(object(nodeExtensions.KHR_lights_punctual, 'light').light, 'lights', `node ${i} light`)
    indexMap(
      object(nodeExtensions.EXT_mesh_gpu_instancing, 'instancing').attributes,
      'accessors',
      `node ${i} instancing`
    )
  })
  // parents before children, from the roots; with one parent each, a node the roots do not reach is in a cycle
  const order = []
  const depth = new Array(nodes.length).fill(1)
  for (let i = 0; i < nodes.length; i++) if (parents[i] === -1) order.push(i)
  for (let k = 0; k < order.length; k++) {
    for (const child of children[order[k]]) {
      depth[child] = depth[order[k]] + 1
      if (depth[child] > limits.nodeDepth) refuse(`the node hierarchy is more than ${limits.nodeDepth} deep`)
      order.push(child)
    }
  }
  if (order.length !== nodes.length) refuse('the node hierarchy is not a tree')

  return checkVRM(json, collections, parents, order, limits, { list, object, items, index })
}

// three-vrm's work, counted as its plugins (version 3.3.3) expand it. VRM 0 (`extensions.VRM`) and VRM 1
// (`VRMC_vrm`, `VRMC_springBone`, `VRMC_node_constraint`)
function checkVRM(json, collections, parents, order, limits, { list, object, items, index }) {
  const caps = limits.vrm
  const extensions = object(json.extensions, 'extensions')
  const nodes = collections.nodes
  const primitivesOf = mesh => (mesh === undefined ? 0 : list(collections.meshes[mesh].primitives, 'primitives').length)
  const nodesUsingMesh = new Map()
  let meshNodes = 0
  let meshInstances = 0
  nodes.forEach(node => {
    if (node.mesh === undefined) return
    nodesUsingMesh.set(node.mesh, (nodesUsingMesh.get(node.mesh) || 0) + 1)
    meshNodes++
    meshInstances += primitivesOf(node.mesh)
  })
  // the objects of the parsed scene (nodes and their meshes), what a scene traversal visits
  const sceneObjects = nodes.length + meshInstances
  const counts = {
    expressions: 0,
    expressionBinds: 0,
    expressionPrimitives: 0,
    expressionWork: 0,
    springJoints: 0,
    springColliders: 0,
    springColliderWork: 0,
    firstPersonWork: 0,
    constraints: 0,
  }

  const v0 = extensions.VRM === undefined ? null : object(extensions.VRM, 'VRM')
  if (v0) {
    const humanoid = object(v0.humanoid, 'VRM humanoid')
    items(humanoid.humanBones, 'VRM humanBones').forEach((bone, i) =>
      index(bone.node, 'nodes', `VRM humanBone ${i} node`)
    )
    // expressions: a bind walks every node for those using its mesh, then binds each; a material value walks the
    // scene for its materials
    const master = object(v0.blendShapeMaster, 'VRM blendShapeMaster')
    for (const [g, group] of items(master.blendShapeGroups, 'VRM blendShapeGroups').entries()) {
      counts.expressions++
      for (const [b, bind] of items(group.binds, `VRM blendShapeGroup ${g} binds`).entries()) {
        index(bind.mesh, 'meshes', `VRM blendShapeGroup ${g} bind ${b} mesh`)
        const using = nodesUsingMesh.get(bind.mesh) || 0
        counts.expressionWork += nodes.length
        counts.expressionBinds += using
        counts.expressionPrimitives += using * primitivesOf(bind.mesh)
      }
      for (const value of items(group.materialValues, `VRM blendShapeGroup ${g} materialValues`)) {
        if (value === undefined) continue
        counts.expressionWork += sceneObjects
        counts.expressionBinds += meshInstances // at most one bind per material in the scene
      }
    }
    // spring bones: a bone group makes a joint for every node below each bone it lists; each joint visits the
    // colliders of the group's collider groups
    const secondary = object(v0.secondaryAnimation, 'VRM secondaryAnimation')
    const colliderGroups = items(secondary.colliderGroups, 'VRM colliderGroups')
    const collidersIn = colliderGroups.map((group, i) => {
      index(group.node, 'nodes', `VRM colliderGroup ${i} node`)
      const colliders = list(group.colliders, `VRM colliderGroup ${i} colliders`).length
      counts.springColliders += colliders
      return colliders
    })
    const below = new Array(nodes.length).fill(1)
    for (let k = order.length - 1; k >= 0; k--)
      if (parents[order[k]] !== -1) below[parents[order[k]]] += below[order[k]]
    items(secondary.boneGroups, 'VRM boneGroups').forEach((group, g) => {
      let joints = 0
      for (const bone of list(group.bones, `VRM boneGroup ${g} bones`)) {
        index(bone, 'nodes', `VRM boneGroup ${g} bone`)
        joints += below[bone]
      }
      index(group.center, 'nodes', `VRM boneGroup ${g} center`)
      let colliders = 0
      for (const ref of list(group.colliderGroups, `VRM boneGroup ${g} colliderGroups`)) {
        if (!Number.isSafeInteger(ref) || ref < 0 || ref >= colliderGroups.length) {
          refuse(`VRM boneGroup ${g} colliderGroup is not an index`)
        }
        colliders += collidersIn[ref]
      }
      counts.springJoints += joints
      counts.springColliderWork += joints * colliders
    })
    // first person: each node with a mesh searches the annotations
    const firstPerson = object(v0.firstPerson, 'VRM firstPerson')
    index(firstPerson.firstPersonBone, 'nodes', 'VRM firstPersonBone')
    const annotations = items(firstPerson.meshAnnotations, 'VRM meshAnnotations')
    annotations.forEach((annotation, i) => index(annotation.mesh, 'meshes', `VRM meshAnnotation ${i} mesh`))
    counts.firstPersonWork += meshNodes * annotations.length
    const meta = object(v0.meta, 'VRM meta')
    index(meta.texture, 'textures', 'VRM meta texture')
  }

  const vrm1 = extensions.VRMC_vrm === undefined ? null : object(extensions.VRMC_vrm, 'VRMC_vrm')
  if (vrm1) {
    const humanBones = object(object(vrm1.humanoid, 'VRMC_vrm humanoid').humanBones, 'VRMC_vrm humanBones')
    for (const [name, bone] of Object.entries(humanBones))
      index(object(bone, name).node, 'nodes', `VRMC_vrm humanBone ${name}`)
    index(object(vrm1.meta, 'VRMC_vrm meta').thumbnailImage, 'images', 'VRMC_vrm thumbnailImage')
    const expressions = object(vrm1.expressions, 'VRMC_vrm expressions')
    for (const group of ['preset', 'custom']) {
      for (const [name, expression] of Object.entries(object(expressions[group], `VRMC_vrm expressions ${group}`))) {
        if (expression === null || expression === undefined) continue
        const where = `VRMC_vrm expression ${name.slice(0, 40)}`
        const def = object(expression, where)
        counts.expressions++
        for (const [b, bind] of items(def.morphTargetBinds, `${where} morphTargetBinds`).entries()) {
          index(bind.node, 'nodes', `${where} morphTargetBind ${b} node`)
          counts.expressionBinds++
          counts.expressionPrimitives += bind.node === undefined ? 0 : primitivesOf(nodes[bind.node].mesh)
        }
        const materialBinds = [
          ...items(def.materialColorBinds, `${where} materialColorBinds`),
          ...items(def.textureTransformBinds, `${where} textureTransformBinds`),
        ]
        if (materialBinds.length > 0) counts.expressionWork += sceneObjects // the scene walked for its materials
        materialBinds.forEach((bind, b) => {
          index(bind.material, 'materials', `${where} material bind ${b} material`)
          counts.expressionWork += meshInstances // each bind filters every material in the scene
          counts.expressionBinds += meshInstances // a bind per mesh using the material, at most
        })
      }
    }
    const firstPerson = object(vrm1.firstPerson, 'VRMC_vrm firstPerson')
    const annotations = items(firstPerson.meshAnnotations, 'VRMC_vrm meshAnnotations')
    annotations.forEach((annotation, i) => index(annotation.node, 'nodes', `VRMC_vrm meshAnnotation ${i} node`))
    counts.firstPersonWork += meshNodes * annotations.length
  }

  const springs =
    extensions.VRMC_springBone === undefined ? null : object(extensions.VRMC_springBone, 'VRMC_springBone')
  if (springs) {
    const colliders = items(springs.colliders, 'VRMC_springBone colliders')
    colliders.forEach((collider, i) => index(collider.node, 'nodes', `VRMC_springBone collider ${i} node`))
    counts.springColliders += colliders.length
    // a collider group lists colliders (repeats are kept), a spring lists collider groups (repeats are kept)
    const collidersIn = items(springs.colliderGroups, 'VRMC_springBone colliderGroups').map((group, i) => {
      const refs = list(group.colliders, `VRMC_springBone colliderGroup ${i} colliders`)
      for (const ref of refs) {
        if (!Number.isSafeInteger(ref) || ref < 0 || ref >= colliders.length) {
          refuse(`VRMC_springBone colliderGroup ${i} collider is not an index`)
        }
      }
      return refs.length
    })
    items(springs.springs, 'VRMC_springBone springs').forEach((spring, s) => {
      const joints = items(spring.joints, `VRMC_springBone spring ${s} joints`)
      joints.forEach((joint, j) => index(joint.node, 'nodes', `VRMC_springBone spring ${s} joint ${j} node`))
      index(spring.center, 'nodes', `VRMC_springBone spring ${s} center`)
      let groupColliders = 0
      for (const ref of list(spring.colliderGroups, `VRMC_springBone spring ${s} colliderGroups`)) {
        if (!Number.isSafeInteger(ref) || ref < 0 || ref >= collidersIn.length) {
          refuse(`VRMC_springBone spring ${s} colliderGroup is not an index`)
        }
        groupColliders += collidersIn[ref]
      }
      const made = Math.max(0, joints.length - 1)
      counts.springJoints += made
      counts.springColliderWork += made * groupColliders
    })
  }

  nodes.forEach((node, i) => {
    const constraint = object(node.extensions, `node ${i} extensions`).VRMC_node_constraint
    if (constraint === undefined) return
    counts.constraints++
    const def = object(object(constraint, `node ${i} constraint`).constraint, `node ${i} constraint`)
    for (const kind of ['roll', 'aim', 'rotation'])
      index(object(def[kind], kind).source, 'nodes', `node ${i} ${kind} source`)
  })

  for (const [name, value] of Object.entries(counts)) {
    if (value > caps[name]) refuse(`three-vrm ${name}: ${value}, more than ${caps[name]}`)
  }
  return { nodes: nodes.length, vrm: counts }
}

// The per-file budget the parser charges (see the COO_BUDGET sites in the vendored GLTFLoader). `fileBytes`: the
// file's size (its data is copied twice: the GLB's binary chunk, then the bufferViews). `onCharge(kind, n, what,
// total)`: told of every charge (tests)
export function createGLTFBudget({ fileBytes = 0, limits = GLTF_LIMITS, onCharge } = {}) {
  const maxBytes = limits.allocatedBytes + 2 * fileBytes
  const used = { bytes: 0, pixels: 0, counts: {} }
  // every later charge is refused too (the totals stay past the limit), so a part of the parse still running after
  // the refusal allocates nothing more
  const fail = (what, reason) => {
    onCharge?.('refused', 0, what, reason)
    refuse(reason)
  }
  const budget = {
    used,
    maxBytes,
    bytes(n, what) {
      if (!Number.isFinite(n) || n < 0) fail(what, `${what}: an impossible size`)
      used.bytes += n
      onCharge?.('bytes', n, what, used.bytes)
      if (used.bytes > maxBytes) fail(what, `the parser would allocate more than ${maxBytes} bytes (at ${what})`)
    },
    count(kind, n = 1) {
      const limit = limits.counts[kind]
      if (limit === undefined) throw new Error(`gltf budget: unknown count ${kind}`)
      const total = (used.counts[kind] || 0) + n
      used.counts[kind] = total
      onCharge?.('count', n, kind, total)
      if (total > limit) fail(kind, `${kind}: ${total}, more than ${limit}`)
    },
    // an image about to be decoded, sized from its header (embedded images must be PNG, JPEG or WebP)
    image(bytes, what) {
      const header = readImageHeader(bytes)
      if (!header) fail(what, `${what} is not a PNG, JPEG or WebP image`)
      if (header.malformed) fail(what, `${what} is a malformed ${header.type} (${header.malformed})`)
      if (header.incomplete) fail(what, `${what} is a ${header.type} cut short`)
      if (!(header.width > 0 && header.height > 0)) fail(what, `${what} has no width or height`)
      const pixels = header.width * header.height
      if (pixels > limits.imagePixels) fail(what, `${what} is larger than ${limits.imagePixels} pixels`)
      budget.count('images')
      used.pixels += pixels
      onCharge?.('pixels', pixels, what, used.pixels)
      if (used.pixels > limits.imagePixelsPerFile) {
        fail(what, `the images decoded would have more than ${limits.imagePixelsPerFile} pixels (at ${what})`)
      }
    },
    // an image named by URI: a data: URI is measured as embedded bytes; a blob: URL is refused; any other URL is
    // refused by the client's URL filter before a fetch, so nothing decodes it
    imageURI(uri, what) {
      if (typeof uri !== 'string') return
      const scheme = uri.trim().toLowerCase()
      if (scheme.startsWith('data:')) return budget.image(decodeDataURI(uri), what)
      if (scheme.startsWith('blob:')) fail(what, `${what} names a blob: URL`)
    },
  }
  return budget
}
