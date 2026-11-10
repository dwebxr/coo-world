// Limits for a glTF file (a .glb, or a .gltf with its buffers inside as data: URIs) that another user supplies.
// Pure (no three.js, no DOM), so the server loader can use it too. Two parts:
//
// - checkGLTF(data): before parsing. The container and the document's structure: chunk lengths, the JSON's size and
//   nesting, every index a non-negative integer in range, every list a real list within a length, the node
//   hierarchy a tree of bounded depth, a scene's roots each once and in one scene, no glTF 1.0 leftovers the parser
//   still honours, required extensions this client can load; every string and key the parser or three-vrm reads
//   short, and a string where they treat it as one (what they copy, scan, concatenate or use as a key once per object
//   is then small: a document-sized value is data, never a name), the extras and extensions copied into userData
//   small, per object and in the parsed scene; the accessors what the parser and three.js assume of
//   them (an animation's keyframe times and values per keyframe, not interleaved, a skin's matrices, a primitive's
//   counts and indices, strides and lengths: a fractional value size made three's interpolants loop forever); and
//   three-vrm's work counted in the units its plugins iterate (three-vrm is not vendored, so it is bounded before
//   it runs, by upper bounds computed from the document).
// - createGLTFBudget(): the per-file budget the vendored GLTFLoader (src/core/libs/gltfloader/GLTFLoader.js, see its
//   COO_BUDGET and COO_WORK sites) charges before it allocates, copies, clones, creates or decodes; work charged by
//   reference (each use of an accessor at its size, each object placed under a parent at what moving it costs,
//   each clone at what it copies, each loop or walk the document sizes); and a wall-clock limit, looked at by every
//   charge. Nothing is predicted: what the parser does is what is counted.
//
// The contract, as it is: the limits bound what the vendored parser itself allocates, creates and decodes, and the
// work it and this check do, charged before it happens, and the time they take. The parser's charges are measured
// at that moment: an allocation at its real size, an accessor's use at its declared size (elements x components),
// a morph-target texture by three.js's own formula (for the renderer's texture size, or the largest any size would
// take while that is not known), a JSON copy of userData at what the copy holds (jsonCopyBytes, from the measured
// heap of the worst shapes). The three-vrm counts before parsing are bounds, each at least what it stands for
// (checkVRM says which are exact). Cost inside three.js and three-vrm that is proportional to the charges is
// covered by them; cost there that multiplies in ways the charges do not capture is not proven absent. The time
// limit refuses at the next charge after it, but cannot interrupt one long loop inside a library. The server
// parses with the same vendored parser without this check, a budget or a time limit.
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
  instancingAttributes: 16, // EXT_mesh_gpu_instancing attributes of one node (TRANSLATION, ROTATION, SCALE, a few more)
  // strings, short by rule: every string and every key the parser or three-vrm reads (names, kinds, extension and
  // attribute names, bone and expression names: kept, compared, concatenated, sanitised or used as a key, once per
  // object), outside extras and the extensions nothing here reads (those are copied, and sized below). In the bundled
  // files and VRoid's seven samples the longest is 59 characters (an animation's name), the longest key 31
  nameLength: 1024,
  uriLength: 2048, // a URI that is not a data: URI (the client fetches none: a data: URI is the data, charged as such)
  // the asset's and the VRM meta's text (generator, copyright, licence, credits): read once, never per object. The
  // longest in those files: 51 characters
  textLength: 16384,
  // extras, and extensions, which the parser puts in an object's userData (and three.js copies, as JSON, with every
  // clone): each object's (node, mesh, primitive, material, image, scene, camera, light), in characters of JSON; and
  // all the userData the parsed scene holds (a mesh's for each of its primitives and each node using it), which every
  // clone of the scene copies. The most in those files: 1,957 for one object (a VRoid primitive's morph target
  // names), 22,501 in a scene (VRM1_Constraint_Twist_Sample)
  userDataLength: 64 * 1024,
  sceneUserDataLength: 1024 * 1024,
  // the parser (createGLTFBudget): bytes it allocates, beyond twice the file's own size (the GLB's binary chunk and
  // the bufferViews are each a copy of the file's data). Most of it, for an avatar, is the morph-target textures
  // three.js builds: one per geometry, and a VRoid face is ten geometries sharing one set of vertices and targets.
  // VRoid's AvatarSample_A (15.1 MB) is charged 110.8 MB, 80.6 MB more than twice its size, where the renderer's
  // maximum texture size is 4096 or not known yet (74.2 MB at 16384): under a third of its limit with this. The
  // bundled avatar is charged 17.8 MB
  allocatedBytes: 320 * MiB,
  // steps of work, beyond one per byte of the file: every use of an accessor at its size (elements x components),
  // each object placed under a parent at what three.js goes through to move it, each clone at what it copies, and
  // the loops and walks the document sizes (sparse entries, subtree walks, the entries of each list the parser goes
  // through), and checkGLTF's own steps (the client charges both to one budget). The accessors of a VRoid avatar's
  // face and hair are used by every primitive sharing them: VRoid's AvatarSample_B (15.4 MB) takes 20.1 million
  // steps, a quarter of its limit; the bundled avatar 1,035,591, an emote 58,170 to 122,087 (the check and the parse
  // as the client runs them, with the VRM plugin registered as for every file; the check alone, 53,516 and 53,750 to
  // 66,470 of those)
  work: 1 << 26,
  // the parse's wall time, checked at every charge (the backstop for what multiplies past the charges). It cannot
  // interrupt one long loop inside three.js or three-vrm, only refuse at the next charge after it. The bundled
  // avatar's check and parse take about 3 ms in Node on a desktop (a browser also waits for its image decode)
  parseMilliseconds: 10000,
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
  // three-vrm, counted before it runs in the units its plugins iterate (@pixiv/three-vrm 3.3.3): most walk the
  // parsed scene graph, so an object is anything the parser or a plugin puts in it (a node's object, a mesh per
  // primitive and the Group holding them, a camera, a light and its target, a spring collider, an expression)
  vrm: Object.freeze({
    expressions: 1024, // a VRMExpression object each, added to the scene
    expressionBinds: 16384, // bind objects: a morph bind per node using its mesh, a material bind per mesh material
    expressionPrimitives: 262144, // primitives those binds refer to (what each expression update writes)
    // steps: objects walked (a morph bind's subtree; the scene, per material value or expression with material
    // binds), nodes searched, materials filtered or looked up
    expressionWork: 16 * MiB,
    springJoints: 16384, // VRM 0: every object below each bone listed; VRM 1: each two consecutive joints listed
    springColliders: 4096,
    springColliderWork: 1 * MiB, // joints x the colliders of their groups (what each spring update visits)
    springSortWork: 16 * MiB, // sorting the joints: per dependency (parent, colliders) a walk up, and the joints there
    firstPersonWork: 1 * MiB, // every node, the subtree of each with a mesh, and each annotation it searches
    constraints: 4096,
    outlineDraws: 131072, // draws outlines add: two per outlined mesh sharing a geometry, for each use of it
    // what the outline material three-vrm clones for each outlined primitive copies: the material's userData (its
    // extras and the extensions the parser does not handle) and each texture's (its image's extras and mimeType), at
    // what a JSON copy holds (jsonCopyBytes)
    outlineCopyBytes: 16 * MiB,
    // what an expression's texture-transform binds copy: each clones every texture slot of each material it binds
    // (the texture's userData, at what a JSON copy holds)
    textureBindCopyBytes: 16 * MiB,
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

// The bytes a JSON copy of a value holds, at most, from its JSON text. three.js copies userData as JSON (the parse of
// its stringify) with every clone of an object, material or texture, and the copy holds more than its text: 2 bytes a
// character (a string's characters, two bytes each once any is past Latin-1), 24 more per `,` or `:` (each value
// after the first in a list, each property: its slot, a number's box) and 96 more per `{` or `[` (each object or
// list: its header and its backing store), counted outside strings. On Node 24, copies of 64 KiB of JSON of twenty
// shapes held at most 0.87 of this (many keys of one object), a list of empty objects 0.51 (it was 10.7 times the
// two bytes a character charged before), and one long string of two-byte characters 1.01 (its characters are two
// bytes each, its header and object on top): test/gltfBudget.test.js measures the worst of them through the parser
export function jsonCopyBytes(text) {
  let separators = 0
  let containers = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    if (inString) {
      if (char === 92) {
        i++ // backslash: skip the escaped character
      } else if (char === 34) inString = false
    } else if (char === 34) {
      inString = true
    } else if (char === 44 || char === 58) {
      separators++
    } else if (char === 123 || char === 91) {
      containers++
    }
  }
  return 2 * text.length + 24 * separators + 96 * containers
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
  return { json, bin, jsonLength: text.length }
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
// extensions whose content the parser or a plugin reads: the loadable ones, and those it reads to find their
// fallback. Any other extension's content is read by nothing: on an object it is kept in the object's userData (and
// sized, with the extras, as what clones copy), on the document in the document's userData, once
const READ_EXTENSIONS = new Set([
  ...LOADABLE_EXTENSIONS,
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_texture_basisu',
  'EXT_texture_avif',
])
// keys whose values the parser or three-vrm treat as strings (a list there was joined into one string each time
// it was compared, concatenated or looked up: a material's name, for each outline cloned from it)
const STRING_KEYS = new Set([
  'name',
  'type',
  'uri',
  'mimeType',
  'path',
  'interpolation',
  'alphaMode',
  'materialName',
  'propertyName',
  'presetName',
  'bone',
  'shader',
  'specVersion',
])
// the image media types a valid file may carry: the three this client decodes, and the two the vendored parser's
// plugins name for images reached through an extension (KHR_texture_basisu's image/ktx2, EXT_texture_avif's
// image/avif; getImageURIMimeType and the AVIF support check). A fixed list, so the mimeType each texture's userData
// keeps (and each clone copies) is ten characters at most. Whether an image is decoded is the parser's decision, as
// before: a KTX2 image is skipped for its fallback (no decoder), and a refused one is refused at its decode
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/ktx2', 'image/avif']

// componentType: bytes of a component; type: components of an element
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
const FLOAT = 5126
const UNSIGNED_INDICES = [5121, 5123, 5125]
const NORMALIZED_INTEGERS = [5120, 5121, 5122, 5123]
const INTERPOLATIONS = ['LINEAR', 'STEP', 'CUBICSPLINE']
// what an animation channel's output holds, by path (the parser makes a track of each of them)
const ANIMATION_OUTPUTS = {
  translation: { type: 'VEC3', normalized: false },
  scale: { type: 'VEC3', normalized: false },
  rotation: { type: 'VEC4', normalized: true },
  weights: { type: 'SCALAR', normalized: true },
}

const place = (top, at) => (at === undefined ? top : `${top} ${at}`)

// The document's strings and keys, outside extras and the extensions nothing here reads: each one short (the names
// and kinds the parser and three-vrm read, once per object: GLTF_LIMITS.nameLength), a URI short unless it is a data:
// URI (its bytes are charged where they are decoded), the asset's and the VRM meta's text within textLength; and
// the values the parser and three-vrm treat as strings, strings (STRING_KEYS). A step per value
function checkText(json, limits, step) {
  let values = 0
  // `top`: the document's entry the value is in (a collection's, with `at`: its index), named only when refused
  const visit = (value, key, top, at, cap, depth) => {
    values++
    if (STRING_KEYS.has(key) && typeof value !== 'string') refuse(`${place(top, at)} ${key} is not a string`)
    if (typeof value === 'string') {
      const max = key === 'uri' ? (value.startsWith('data:') ? Infinity : limits.uriLength) : cap
      if (value.length > max) refuse(`${place(top, at)} ${key} is ${value.length} characters long, more than ${max}`)
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) visit(value[i], key, top, depth === 1 ? i : at, cap, depth + 1)
    } else if (isObject(value)) {
      for (const name of Object.keys(value)) {
        if (name.length > limits.nameLength) {
          refuse(`${place(top, at)} has a key ${name.length} characters long, more than ${limits.nameLength}`)
        }
        // extras are not read, but copied: sized below, with the extensions nothing reads
        if (name === 'extras' || (key === 'extensions' && !READ_EXTENSIONS.has(name))) continue
        const text = (depth === 0 && name === 'asset') || (name === 'meta' && (key === 'VRM' || key === 'VRMC_vrm'))
        const extension = depth === 1 && key === 'extensions'
        visit(
          value[name],
          name,
          depth === 0 ? name : extension ? `extension ${name}` : top,
          depth === 0 || extension ? undefined : at,
          text ? limits.textLength : cap,
          depth + 1
        )
      }
    }
  }
  visit(json, '', 'the document', undefined, limits.nameLength, 0)
  step(values, 'strings and keys')
}

// `budget`: the file's budget (createGLTFBudget), made before the check: the check's own loops are charged to it as
// work and look at its clock, so no part of loading a file runs unmetered. Every loop here is linear in the size of
// the document (each entry visited a bounded number of times)
export function checkGLTF(data, limits = GLTF_LIMITS, budget = null) {
  const step = (n, what) => {
    if (budget) budget.work(n, what)
  }
  const { json, bin, jsonLength } = readGLTF(data, limits)
  step(jsonLength, 'the JSON')
  if (!isObject(json.asset) || typeof json.asset.version !== 'string' || !/^2\./.test(json.asset.version)) {
    refuse('not a glTF 2.0 document')
  }
  checkText(json, limits, step)

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
    step(collections[name].length, name)
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
  // each named once (the specification's rule): the parser looks every used name up in the required list
  if (new Set(used).size !== used.length || new Set(required).size !== required.length) {
    refuse('an extension is named twice in extensionsUsed or extensionsRequired')
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
    // the specification's byteStride: 4 to 252, a multiple of 4 (so a whole number of any component type)
    if (view.byteStride !== undefined && (view.byteStride < 4 || view.byteStride > 252 || view.byteStride % 4 !== 0)) {
      refuse(`bufferView ${i} byteStride is not a multiple of 4 from 4 to 252`)
    }
    const meshopt = object(object(view.extensions, `bufferView ${i} extensions`).EXT_meshopt_compression, 'meshopt')
    index(meshopt.buffer, 'buffers', `bufferView ${i} meshopt buffer`)
    for (const key of ['byteOffset', 'byteLength', 'byteStride', 'count'])
      whole(meshopt[key], `bufferView ${i} meshopt ${key}`)
  })
  // an accessor's elements: bytes per component and per element, and whether they fit in their bufferView where the
  // parser reads them (the specification's alignment and stride rules)
  collections.accessors.forEach((accessor, i) => {
    index(accessor.bufferView, 'bufferViews', `accessor ${i} bufferView`)
    whole(accessor.byteOffset, `accessor ${i} byteOffset`)
    whole(accessor.count, `accessor ${i} count`)
    if (accessor.count === undefined) refuse(`accessor ${i} has no count`)
    // at least one element (the specification's minimum; the parser goes through an empty one's uses all the same)
    if (accessor.count === 0) refuse(`accessor ${i} has no elements`)
    const componentBytes = COMPONENT_BYTES[accessor.componentType]
    const size = TYPE_SIZES[accessor.type]
    // (a number and a string: a list was its one element as a key, wherever the parser looked it up)
    if (
      typeof accessor.componentType !== 'number' ||
      !Object.hasOwn(COMPONENT_BYTES, accessor.componentType) ||
      !Object.hasOwn(TYPE_SIZES, accessor.type)
    ) {
      refuse(`accessor ${i} has an invalid componentType or type`)
    }
    if (accessor.normalized !== undefined && typeof accessor.normalized !== 'boolean') {
      refuse(`accessor ${i} normalized is not true or false`)
    }
    numbers(accessor.min, `accessor ${i} min`)
    numbers(accessor.max, `accessor ${i} max`)
    const elementBytes = componentBytes * size
    if (accessor.bufferView !== undefined) {
      const view = collections.bufferViews[accessor.bufferView]
      const offset = accessor.byteOffset || 0
      if (offset % componentBytes !== 0) refuse(`accessor ${i} byteOffset is not a multiple of its component size`)
      const stride = view.byteStride
      if (stride !== undefined && (stride % componentBytes !== 0 || (offset % stride) + elementBytes > stride)) {
        refuse(`accessor ${i} elements do not fit the byteStride of bufferView ${accessor.bufferView}`)
      }
      const end = accessor.count === 0 ? 0 : offset + (accessor.count - 1) * (stride || elementBytes) + elementBytes
      if (end > (view.byteLength || 0)) refuse(`accessor ${i} is longer than bufferView ${accessor.bufferView}`)
    } else if (accessor.byteOffset !== undefined && accessor.byteOffset !== 0) {
      refuse(`accessor ${i} has a byteOffset without a bufferView`)
    }
    if (accessor.sparse !== undefined) {
      const sparse = object(accessor.sparse, `accessor ${i} sparse`)
      whole(sparse.count, `accessor ${i} sparse count`, 1)
      // the parser refuses indices that are not strictly increasing inside the accessor (COO_SPARSE), so there are
      // at most as many as the accessor has elements
      if (sparse.count > accessor.count) refuse(`accessor ${i} has more sparse entries than elements`)
      for (const part of ['indices', 'values']) {
        const def = object(sparse[part], `accessor ${i} sparse ${part}`)
        if (def.bufferView === undefined) refuse(`accessor ${i} sparse ${part} has no bufferView`)
        index(def.bufferView, 'bufferViews', `accessor ${i} sparse ${part} bufferView`)
        whole(def.byteOffset, `accessor ${i} sparse ${part} byteOffset`)
      }
      if (!UNSIGNED_INDICES.includes(sparse.indices.componentType)) refuse(`accessor ${i} has invalid sparse indices`)
      const indexBytes = COMPONENT_BYTES[sparse.indices.componentType]
      for (const [part, bytes] of [
        ['indices', indexBytes],
        ['values', elementBytes],
      ]) {
        const offset = sparse[part].byteOffset || 0
        if (offset % (part === 'indices' ? indexBytes : componentBytes) !== 0) {
          refuse(`accessor ${i} sparse ${part} byteOffset is not aligned`)
        }
        if (offset + sparse.count * bytes > (collections.bufferViews[sparse[part].bufferView].byteLength || 0)) {
          refuse(`accessor ${i} sparse ${part} are longer than their bufferView`)
        }
      }
    }
  })
  const accessors = collections.accessors
  const tight = accessor => {
    const stride =
      accessor.bufferView === undefined ? undefined : collections.bufferViews[accessor.bufferView].byteStride
    return stride === undefined || stride === COMPONENT_BYTES[accessor.componentType] * TYPE_SIZES[accessor.type]
  }
  collections.images.forEach((image, i) => {
    index(image.bufferView, 'bufferViews', `image ${i} bufferView`)
    if (image.uri !== undefined && typeof image.uri !== 'string') refuse(`image ${i} uri is not a string`)
    // a blob: URL is no file's own data, and the client's URL filter lets blob: through (for embedded images)
    if (typeof image.uri === 'string' && image.uri.trim().toLowerCase().startsWith('blob:')) {
      refuse(`image ${i} names a blob: URL`)
    }
    // kept in its texture's userData, which three.js copies with every clone of the texture: one of a fixed list of
    // image types (a document's own string of any length was copied in every texture slot of every outline)
    if (image.mimeType !== undefined && !IMAGE_TYPES.includes(image.mimeType)) {
      refuse(`image ${i} mimeType is not one of ${IMAGE_TYPES.join(', ')}`)
    }
  })
  // a sampler's filters and wrapping: numbers (the parser looks each up for every texture using the sampler)
  collections.samplers.forEach((sampler, i) => {
    for (const key of ['magFilter', 'minFilter', 'wrapS', 'wrapT']) whole(sampler[key], `sampler ${i} ${key}`)
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
      step(1, 'material entries')
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
  // the elements of the accessors a map names (an attributes or target map, instancing attributes): all one count
  const sameCount = (map, where, count) => {
    for (const accessor of Object.values(map)) {
      if (count === undefined) count = accessors[accessor].count
      else if (accessors[accessor].count !== count) refuse(`${where} attributes have different counts`)
    }
    return count
  }
  collections.meshes.forEach((mesh, i) => {
    numbers(mesh.weights, `mesh ${i} weights`)
    let targetCount
    items(mesh.primitives, `mesh ${i} primitives`).forEach((primitive, k) => {
      const where = `mesh ${i} primitive ${k}`
      step(1 + Object.keys(object(primitive.attributes, `${where} attributes`)).length, 'primitive entries')
      if (primitive.attributes === undefined) refuse(`${where} has no attributes`)
      indexMap(primitive.attributes, 'accessors', `${where} attribute`)
      const count = sameCount(primitive.attributes, where)
      index(primitive.indices, 'accessors', `${where} indices`)
      if (primitive.indices !== undefined) {
        const indices = accessors[primitive.indices]
        if (indices.type !== 'SCALAR' || !UNSIGNED_INDICES.includes(indices.componentType)) {
          refuse(`${where} indices are not unsigned whole numbers`)
        }
        if (indices.bufferView !== undefined && collections.bufferViews[indices.bufferView].byteStride !== undefined) {
          refuse(`${where} indices are interleaved`)
        }
      }
      index(primitive.material, 'materials', `${where} material`)
      whole(primitive.mode, `${where} mode`)
      if (primitive.mode > 6) refuse(`${where} has an unknown mode`)
      const targets = items(list(primitive.targets, `${where} targets`, limits.targets), `${where} targets`)
      targets.forEach((target, t) => {
        step(1 + Object.keys(target).length, 'target entries')
        indexMap(target, 'accessors', `${where} target ${t}`)
        sameCount(target, `${where} target ${t}`, count)
      })
      // every primitive of a mesh has as many targets (the weights animated, and the mesh's weights, are per target)
      if (targetCount === undefined) targetCount = targets.length
      else if (targets.length !== targetCount) refuse(`mesh ${i} primitives have different numbers of morph targets`)
      const draco = object(object(primitive.extensions, `${where} extensions`).KHR_draco_mesh_compression, 'draco')
      index(draco.bufferView, 'bufferViews', `${where} draco bufferView`)
    })
  })
  const targetsOf = mesh => list(collections.meshes[mesh].primitives, 'primitives')[0]?.targets?.length ?? 0
  collections.cameras.forEach((camera, i) => {
    if (typeof camera.type !== 'string') refuse(`camera ${i} has no type`)
  })
  collections.skins.forEach((skin, i) => {
    const joints = list(skin.joints, `skin ${i} joints`)
    for (const joint of joints) index(joint, 'nodes', `skin ${i} joint`)
    index(skin.skeleton, 'nodes', `skin ${i} skeleton`)
    index(skin.inverseBindMatrices, 'accessors', `skin ${i} inverseBindMatrices`)
    if (skin.inverseBindMatrices !== undefined) {
      // a float 4x4 matrix per joint (the parser reads the joint's at 16 x its index)
      const matrices = accessors[skin.inverseBindMatrices]
      if (matrices.type !== 'MAT4' || matrices.componentType !== FLOAT || matrices.count < joints.length) {
        refuse(`skin ${i} inverseBindMatrices are not a float 4x4 matrix per joint`)
      }
      if (!tight(matrices)) refuse(`skin ${i} inverseBindMatrices are interleaved`)
    }
  })
  collections.animations.forEach((animation, i) => {
    // glTF 1.0: the vendored parser still reads accessors through `parameters` when it is there
    if (animation.parameters !== undefined) refuse(`animation ${i} has glTF 1.0 parameters`)
    const samplers = items(animation.samplers, `animation ${i} samplers`)
    step(samplers.length + list(animation.channels, `animation ${i} channels`).length, 'animation entries')
    samplers.forEach((sampler, k) => {
      const where = `animation ${i} sampler ${k}`
      if (sampler.input === undefined || sampler.output === undefined) refuse(`${where} has no input or output`)
      index(sampler.input, 'accessors', `${where} input`)
      index(sampler.output, 'accessors', `${where} output`)
      if (sampler.interpolation !== undefined && !INTERPOLATIONS.includes(sampler.interpolation)) {
        refuse(`${where} has an unknown interpolation`)
      }
      // the keyframe times: one float each (a track's value size is its values over its times)
      const input = accessors[sampler.input]
      if (input.type !== 'SCALAR' || input.componentType !== FLOAT || input.count < 1) {
        refuse(`${where} input is not a float time per keyframe`)
      }
      // the track gets the accessors' arrays as they are: interleaved, they hold other data (times of 2 keyframes
      // at a byteStride of 8 were 4 floats, and a fractional sample size looped three's interpolant forever)
      if (!tight(input) || !tight(accessors[sampler.output])) refuse(`${where} input or output is interleaved`)
    })
    items(animation.channels, `animation ${i} channels`).forEach((channel, k) => {
      const where = `animation ${i} channel ${k}`
      if (!Number.isSafeInteger(channel.sampler) || channel.sampler < 0 || channel.sampler >= samplers.length) {
        refuse(`${where} sampler is not an index of its samplers`)
      }
      const target = object(channel.target, `${where} target`)
      index(target.node, 'nodes', `${where} node`)
      // a channel without a node is skipped by the parser (KHR_animation_pointer's, for one)
      if (target.node === undefined) return
      // the output: per keyframe (three per keyframe for CUBICSPLINE: in-tangent, value, out-tangent), one element
      // of the path's type, or a weight per morph target. Anything else is a fractional value size, which three's
      // interpolants and PropertyMixer loop on forever (`i !== stride`)
      const kind = typeof target.path === 'string' && Object.hasOwn(ANIMATION_OUTPUTS, target.path)
      if (!kind) refuse(`${where} animates a path this client cannot play`)
      const expected = ANIMATION_OUTPUTS[target.path]
      const sampler = samplers[channel.sampler]
      const output = accessors[sampler.output]
      if (
        output.type !== expected.type ||
        !(
          output.componentType === FLOAT ||
          (expected.normalized && output.normalized === true && NORMALIZED_INTEGERS.includes(output.componentType))
        )
      ) {
        refuse(`${where} output is not ${expected.type} values for ${target.path}`)
      }
      let perKeyframe = sampler.interpolation === 'CUBICSPLINE' ? 3 : 1
      if (target.path === 'weights') {
        const mesh = collections.nodes[target.node].mesh
        const morphTargets = mesh === undefined ? 0 : targetsOf(mesh)
        if (morphTargets === 0) refuse(`${where} animates the weights of a node without morph targets`)
        perKeyframe *= morphTargets
      }
      if (output.count !== accessors[sampler.input].count * perKeyframe) {
        refuse(`${where} output does not have ${perKeyframe} values per keyframe`)
      }
    })
  })

  // nodes: references, then the hierarchy (a tree of bounded depth)
  const nodes = collections.nodes
  const parents = new Array(nodes.length).fill(-1)
  const children = nodes.map(() => [])
  nodes.forEach((node, i) => {
    step(1 + list(node.children, `node ${i} children`).length, 'node entries')
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
    const instancing = object(object(nodeExtensions.EXT_mesh_gpu_instancing, 'instancing').attributes, 'instancing')
    // TRANSLATION, ROTATION, SCALE and a few of the file's own: the parser goes through them for each primitive
    const instancingKeys = Object.keys(instancing).length
    if (instancingKeys > limits.instancingAttributes) {
      refuse(`node ${i} has ${instancingKeys} instancing attributes, more than ${limits.instancingAttributes}`)
    }
    indexMap(instancing, 'accessors', `node ${i} instancing`)
    // one count of instances (the parser takes the first attribute's), and each transform of its type
    sameCount(instancing, `node ${i} instancing`)
    for (const [name, type] of [
      ['TRANSLATION', 'VEC3'],
      ['ROTATION', 'VEC4'],
      ['SCALE', 'VEC3'],
    ]) {
      if (instancing[name] !== undefined && accessors[instancing[name]].type !== type) {
        refuse(`node ${i} instancing ${name} is not ${type}`)
      }
    }
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
  // a scene's roots: each listed once, and a child of no node. (A root shared by several scenes is valid glTF: the
  // parser moves it to the last, and each move is charged at what it costs)
  collections.scenes.forEach((scene, i) => {
    const listed = new Set()
    for (const root of list(scene.nodes, `scene ${i} nodes`)) {
      if (parents[root] !== -1) refuse(`scene ${i} lists node ${root}, which is a child of another node`)
      if (listed.has(root)) refuse(`scene ${i} lists node ${root} twice`)
      listed.add(root)
    }
  })

  // the userData the parser fills from each object's extras and extensions (which of the extensions it copies depends
  // on the plugins registered: all are counted), in characters of JSON: each object's; and all the scene holds (a
  // mesh's for each of its primitives and each node using it, a camera's and a light's for each node using it; the
  // materials and images once: the parser charges each clone of them), which every clone of the scene copies
  const userDataOf = (def, where) => {
    const length =
      (def.extras === undefined ? 0 : JSON.stringify(def.extras).length) +
      (def.extensions === undefined ? 0 : JSON.stringify(def.extensions).length)
    step(length, 'extras and extensions')
    if (length > limits.userDataLength) {
      refuse(`${where} has ${length} characters of extras and extensions, more than ${limits.userDataLength}`)
    }
    return length
  }
  const meshUserData = collections.meshes.map((mesh, i) => {
    const own = userDataOf(mesh, `mesh ${i}`)
    return list(mesh.primitives, 'primitives').reduce(
      (sum, primitive, k) => sum + own + userDataOf(primitive, `mesh ${i} primitive ${k}`),
      0
    )
  })
  const cameraUserData = collections.cameras.map((camera, i) => userDataOf(camera, `camera ${i}`))
  const lightUserData = collections.lights.map((light, i) => userDataOf(light, `light ${i}`))
  let sceneUserData = 0
  for (const [name, label] of [
    ['materials', 'material'],
    ['images', 'image'],
    ['scenes', 'scene'],
  ]) {
    collections[name].forEach((def, i) => (sceneUserData += userDataOf(def, `${label} ${i}`)))
  }
  nodes.forEach((node, i) => {
    sceneUserData += userDataOf(node, `node ${i}`)
    if (node.mesh !== undefined) sceneUserData += meshUserData[node.mesh]
    if (node.camera !== undefined) sceneUserData += cameraUserData[node.camera]
    const light = object(node.extensions, 'extensions').KHR_lights_punctual?.light
    if (light !== undefined) sceneUserData += lightUserData[light]
  })
  if (sceneUserData > limits.sceneUserDataLength) {
    refuse(`the scene's userData is ${sceneUserData} characters of JSON, more than ${limits.sceneUserDataLength}`)
  }

  return { ...checkVRM(json, collections, parents, order, limits, { list, object, items, index, step }), sceneUserData }
}

// three-vrm's work, counted before it runs, in the units its plugins (version 3.3.3) iterate: most of them walk the
// parsed scene graph (`object.traverse`), so the counts are of the objects the parser and the plugins put in it, not
// of the document's nodes. VRM 0 (`extensions.VRM`) and VRM 1 (`VRMC_vrm`, `VRMC_springBone`, `VRMC_node_constraint`).
// Each count names its unit. Exact: springColliders, constraints, VRM 1 springJoints (consecutive joints listed) and
// VRM 1 morph binds. Bounds, and why: the objects below a node (a node carrying one thing is that thing, a Bone or
// Group holding it is one more: both counted as the larger), so the VRM 0 springJoints, the subtree walks of
// expressionWork and firstPersonWork, and springColliderWork with them; expressions (three-vrm skips duplicate VRM 0
// names, and runs VRM 1 or VRM 0, not both); material binds (every mesh with the material, its outline copy too);
// springSortWork (a product of the deepest object and the most joints on one); outlineDraws (every VRM 0 material,
// and every VRM 1 material with an outline mode, counted as outlined); outlineCopyBytes (every texture slot at the
// largest texture's userData, and 8 KiB more); textureBindCopyBytes (the most slots any material kind has, at the
// largest texture's userData, for every material a VRM 0 material value names and every mesh a VRM 1 bind's
// material is on).
function checkVRM(json, collections, parents, order, limits, { list, object, items, index, step }) {
  const caps = limits.vrm
  const extensions = object(json.extensions, 'extensions')
  const nodes = collections.nodes
  const materials = collections.materials
  const primitivesOf = mesh => (mesh === undefined ? [] : list(collections.meshes[mesh].primitives, 'primitives'))
  const counts = {
    expressions: 0,
    expressionBinds: 0,
    expressionPrimitives: 0,
    expressionWork: 0,
    springJoints: 0,
    springColliders: 0,
    springColliderWork: 0,
    springSortWork: 0,
    firstPersonWork: 0,
    constraints: 0,
    outlineDraws: 0,
    outlineCopyBytes: 0,
    textureBindCopyBytes: 0,
  }
  // what a clone of a texture copies: its userData, which is its image's extras and the image's mimeType (one of
  // IMAGE_TYPES, ten characters at most), at what a JSON copy holds. Which image a texture three-vrm clones holds is
  // not modelled (an extension's source, the parser's texture cache and VRM 0's slots may each resolve it to another
  // than the one named): each is counted at the largest of any image
  let largestTexture = 0
  for (const image of collections.images) {
    const extras = typeof image.extras === 'object' ? image.extras : undefined
    largestTexture = Math.max(largestTexture, jsonCopyBytes(JSON.stringify({ ...extras, mimeType: 'image/jpeg' })))
  }
  step(collections.images.length, 'VRM image extras')
  const v0 = extensions.VRM === undefined ? null : object(extensions.VRM, 'VRM')
  const vrm1 = extensions.VRMC_vrm === undefined ? null : object(extensions.VRMC_vrm, 'VRMC_vrm')
  const springs =
    extensions.VRMC_springBone === undefined ? null : object(extensions.VRMC_springBone, 'VRMC_springBone')

  // the spring bone plugin adds a collider object below its node (VRM 0: each collider of a collider group, at the
  // group's node; VRM 1: each collider, at its node) before it walks the bones
  const collidersAt = new Array(nodes.length).fill(0)
  const v0Secondary = v0 ? object(v0.secondaryAnimation, 'VRM secondaryAnimation') : {}
  const v0ColliderGroups = items(v0Secondary.colliderGroups, 'VRM colliderGroups')
  const v0CollidersIn = v0ColliderGroups.map((group, i) => {
    if (group.node === undefined) refuse(`VRM colliderGroup ${i} names no node`)
    index(group.node, 'nodes', `VRM colliderGroup ${i} node`)
    const colliders = list(group.colliders, `VRM colliderGroup ${i} colliders`).length
    collidersAt[group.node] += colliders
    counts.springColliders += colliders
    return colliders
  })
  const v1Colliders = springs ? items(springs.colliders, 'VRMC_springBone colliders') : []
  v1Colliders.forEach((collider, i) => {
    if (collider.node === undefined) refuse(`VRMC_springBone collider ${i} names no node`)
    index(collider.node, 'nodes', `VRMC_springBone collider ${i} node`)
    collidersAt[collider.node]++
  })
  counts.springColliders += v1Colliders.length

  // the objects the parser makes for a node: the node's own object, or a Group or Bone holding what it carries (a
  // mesh: itself for one primitive, a Group and a mesh per primitive for more; a camera; a light, with its target
  // unless it is a point light). A mesh used by several nodes is cloned for each
  const lights = collections.lights
  const joints = new Set(collections.skins.flatMap(skin => list(skin.joints, 'joints')))
  const objectsOf = (node, i) => {
    const carried = []
    if (node.mesh !== undefined) {
      const primitives = primitivesOf(node.mesh).length
      carried.push(primitives === 1 ? 1 : primitives + 1)
    }
    if (node.camera !== undefined) carried.push(1)
    const light = object(node.extensions, 'extensions').KHR_lights_punctual?.light
    if (light !== undefined) carried.push(lights[light].type === 'point' ? 1 : 2)
    const carriedObjects = carried.reduce((sum, n) => sum + n, 0)
    // one thing carried is the node itself; a joint of a skin is a Bone holding it
    return carried.length === 1 && !joints.has(i) ? carriedObjects : 1 + carriedObjects
  }
  // objects in each node's subtree (with the colliders), the deepest object, and every object of the scene graph
  // (with what the plugins add to the scene itself: the normalized humanoid rig, an object per expression)
  step(4 * nodes.length, 'VRM node walks') // the walks over every node below
  const below = nodes.map((node, i) => objectsOf(node, i) + collidersAt[i])
  const objectDepth = new Array(nodes.length).fill(0)
  let deepest = 0
  for (const i of order) {
    objectDepth[i] = (parents[i] === -1 ? 0 : objectDepth[parents[i]]) + 1
    deepest = Math.max(deepest, objectDepth[i] + 2) // a mesh in a Group in the node, or a collider
  }
  for (let k = order.length - 1; k >= 0; k--) {
    if (parents[order[k]] !== -1) below[parents[order[k]]] += below[order[k]]
  }
  let nodeObjects = 0
  for (let i = 0; i < nodes.length; i++) if (parents[i] === -1) nodeObjects += below[i]

  // the meshes of the scene graph: one per primitive of each node's mesh; and by material (index, and name: VRM 0
  // material values find their materials by name; an outline copy is named "<name> (Outline)"). Counted per mesh,
  // times the nodes using it (a loop over the nodes' primitives was the nodes times the primitives)
  const usesOf = new Map()
  nodes.forEach(node => {
    if (node.mesh !== undefined) usesOf.set(node.mesh, (usesOf.get(node.mesh) || 0) + 1)
  })
  let meshObjects = 0
  let meshNodes = 0
  const meshesByMaterial = new Map()
  const meshesByName = new Map()
  const materialName = m => (m === undefined ? '' : typeof materials[m].name === 'string' ? materials[m].name : '')
  for (const [mesh, uses] of usesOf) {
    meshNodes += uses
    const primitives = primitivesOf(mesh)
    step(1 + primitives.length, 'VRM mesh uses')
    for (const primitive of primitives) {
      meshObjects += uses
      meshesByMaterial.set(primitive.material, (meshesByMaterial.get(primitive.material) || 0) + uses)
      const name = materialName(primitive.material)
      meshesByName.set(name, (meshesByName.get(name) || 0) + uses)
    }
  }
  // an outlined mesh holds two materials (its own and the outline copy); every scene walk for materials sees both
  const sceneMaterials = 2 * meshObjects

  // expressions first: their objects are in the scene the material walks visit
  const v0Groups = v0
    ? items(object(v0.blendShapeMaster, 'VRM blendShapeMaster').blendShapeGroups, 'VRM blendShapeGroups')
    : []
  const v1Expressions = []
  if (vrm1) {
    const expressions = object(vrm1.expressions, 'VRMC_vrm expressions')
    for (const group of ['preset', 'custom']) {
      for (const [name, expression] of Object.entries(object(expressions[group], `VRMC_vrm expressions ${group}`))) {
        if (expression === null || expression === undefined) continue
        v1Expressions.push([`VRMC_vrm expression ${name.slice(0, 40)}`, object(expression, 'expression')])
      }
    }
  }
  counts.expressions = v0Groups.length + v1Expressions.length
  const RIG_OBJECTS = 64 // the normalized humanoid: a root and an object per human bone (at most 55)
  const sceneObjects = nodeObjects + RIG_OBJECTS + counts.expressions

  // for each mesh, the nodes using it and the objects below them (summed once, so each bind costs one look-up)
  const usingMesh = new Map()
  nodes.forEach((node, i) => {
    if (node.mesh === undefined) return
    const using = usingMesh.get(node.mesh) || { nodes: 0, below: 0 }
    using.nodes++
    using.below += below[i]
    usingMesh.set(node.mesh, using)
  })

  if (v0) {
    // UniVRM writes -1 for "none" in the fields three-vrm reads as absent when they name nothing (a bone group's
    // center, a bind's mesh, a mesh annotation's mesh, the first-person bone, the meta texture). Not a human bone's
    // node: three-vrm takes only a missing one as absent, and looked node -1 up (a TypeError)
    const optional = (value, collection, where) => {
      if (value !== -1) index(value, collection, where)
    }
    const humanoid = object(v0.humanoid, 'VRM humanoid')
    items(humanoid.humanBones, 'VRM humanBones').forEach((bone, i) =>
      index(bone.node, 'nodes', `VRM humanBone ${i} node`)
    )
    for (const [g, group] of v0Groups.entries()) {
      for (const [b, bind] of items(group.binds, `VRM blendShapeGroup ${g} binds`).entries()) {
        optional(bind.mesh, 'meshes', `VRM blendShapeGroup ${g} bind ${b} mesh`)
        // a bind walks every node for those using its mesh, then the subtree of each (for its primitives), and
        // binds each one
        const using = usingMesh.get(bind.mesh) || { nodes: 0, below: 0 }
        counts.expressionWork += nodes.length + using.below
        counts.expressionBinds += using.nodes
        if (using.nodes > 0) counts.expressionPrimitives += using.nodes * primitivesOf(bind.mesh).length
      }
      for (const value of items(group.materialValues, `VRM blendShapeGroup ${g} materialValues`)) {
        // a material value walks the scene, and looks each mesh whose material has its name up in what it found so
        // far; then binds each material found
        const named =
          typeof value.materialName === 'string'
            ? 2 *
              ((meshesByName.get(value.materialName) || 0) + (meshesByName.get(`${value.materialName} (Outline)`) || 0))
            : 0
        counts.expressionWork += sceneObjects + named * named
        counts.expressionBinds += named
        // a texture transform clones every texture slot of each material found
        if (value.propertyName === '_MainTex_ST') {
          counts.textureBindCopyBytes += named * TEXTURE_TRANSFORM_SLOTS * largestTexture
        }
      }
    }
    // spring bones: a bone group makes a joint for every object below each bone it lists (the parser's and the
    // colliders); each joint visits the colliders of the group's collider groups
    items(v0Secondary.boneGroups, 'VRM boneGroups').forEach((group, g) => {
      let joints = 0
      for (const bone of list(group.bones, `VRM boneGroup ${g} bones`)) {
        index(bone, 'nodes', `VRM boneGroup ${g} bone`)
        if (bone === undefined) continue
        joints += below[bone]
      }
      optional(group.center, 'nodes', `VRM boneGroup ${g} center`)
      let colliders = 0
      for (const ref of list(group.colliderGroups, `VRM boneGroup ${g} colliderGroups`)) {
        if (!Number.isSafeInteger(ref) || ref < 0 || ref >= v0CollidersIn.length) {
          refuse(`VRM boneGroup ${g} colliderGroup is not an index`)
        }
        colliders += v0CollidersIn[ref]
      }
      counts.springJoints += joints
      counts.springColliderWork += joints * colliders
    })
    const firstPerson = object(v0.firstPerson, 'VRM firstPerson')
    optional(firstPerson.firstPersonBone, 'nodes', 'VRM firstPersonBone')
    const annotations = items(firstPerson.meshAnnotations, 'VRM meshAnnotations')
    annotations.forEach((annotation, i) => optional(annotation.mesh, 'meshes', `VRM meshAnnotation ${i} mesh`))
    counts.firstPersonWork += meshNodes * annotations.length
    const meta = object(v0.meta, 'VRM meta')
    optional(meta.texture, 'textures', 'VRM meta texture')
  }

  if (vrm1) {
    const humanBones = object(object(vrm1.humanoid, 'VRMC_vrm humanoid').humanBones, 'VRMC_vrm humanBones')
    for (const [name, bone] of Object.entries(humanBones))
      index(object(bone, name).node, 'nodes', `VRMC_vrm humanBone ${name}`)
    index(object(vrm1.meta, 'VRMC_vrm meta').thumbnailImage, 'images', 'VRMC_vrm thumbnailImage')
    for (const [where, def] of v1Expressions) {
      for (const [b, bind] of items(def.morphTargetBinds, `${where} morphTargetBinds`).entries()) {
        index(bind.node, 'nodes', `${where} morphTargetBind ${b} node`)
        if (bind.node === undefined) continue
        // a bind walks its node's subtree for the node's primitives
        counts.expressionWork += below[bind.node]
        counts.expressionBinds++
        counts.expressionPrimitives += primitivesOf(nodes[bind.node].mesh).length
      }
      const colorBinds = items(def.materialColorBinds, `${where} materialColorBinds`)
      const materialBinds = [...colorBinds, ...items(def.textureTransformBinds, `${where} textureTransformBinds`)]
      // the scene walked once for its materials; each bind filters all of them, and binds each mesh using its
      // material (a shared material once per mesh); a texture-transform bind clones every texture slot of each
      materialBinds.forEach((bind, b) => {
        index(bind.material, 'materials', `${where} material bind ${b} material`)
        const found = meshesByMaterial.get(bind.material) || 0
        counts.expressionWork += sceneMaterials
        counts.expressionBinds += found
        if (b >= colorBinds.length) counts.textureBindCopyBytes += found * TEXTURE_TRANSFORM_SLOTS * largestTexture
      })
      if (materialBinds.length > 0) counts.expressionWork += sceneObjects
    }
    const firstPerson = object(vrm1.firstPerson, 'VRMC_vrm firstPerson')
    const annotations = items(firstPerson.meshAnnotations, 'VRMC_vrm meshAnnotations')
    annotations.forEach((annotation, i) => index(annotation.node, 'nodes', `VRMC_vrm meshAnnotation ${i} node`))
    counts.firstPersonWork += meshNodes * annotations.length
  }
  // first person (either version): every node, and the subtree of each node with a mesh (for its primitives)
  if (v0 || vrm1) {
    counts.firstPersonWork += nodes.length
    nodes.forEach((node, i) => {
      if (node.mesh !== undefined) counts.firstPersonWork += below[i]
    })
  }

  // VRM 1 spring bones: a joint between each two consecutive joints a spring lists
  const jointsAt = new Array(nodes.length).fill(0)
  let jointDependencies = 0 // what sorting the joints walks up from: each joint's parent and its colliders
  if (springs) {
    // a collider group lists colliders (repeats are kept), a spring lists collider groups (repeats are kept)
    const collidersIn = items(springs.colliderGroups, 'VRMC_springBone colliderGroups').map((group, i) => {
      const refs = list(group.colliders, `VRMC_springBone colliderGroup ${i} colliders`)
      for (const ref of refs) {
        if (!Number.isSafeInteger(ref) || ref < 0 || ref >= v1Colliders.length) {
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
      for (let j = 0; j < made; j++) if (joints[j].node !== undefined) jointsAt[joints[j].node]++
      counts.springJoints += made
      counts.springColliderWork += made * groupColliders
      jointDependencies += made * (1 + groupColliders)
    })
  }
  // VRM 0 joints: every object below each listed bone gets one, so an object's count is the listings above it
  if (v0) {
    const listed = new Array(nodes.length).fill(0)
    items(v0Secondary.boneGroups, 'VRM boneGroups').forEach((group, g) => {
      let colliders = 0
      for (const ref of list(group.colliderGroups, `VRM boneGroup ${g} colliderGroups`)) colliders += v0CollidersIn[ref]
      for (const bone of list(group.bones, `VRM boneGroup ${g} bones`)) {
        if (bone === undefined) continue
        listed[bone]++
        jointDependencies += below[bone] * (1 + colliders)
      }
    })
    const cover = new Array(nodes.length).fill(0)
    for (const i of order) {
      cover[i] = (parents[i] === -1 ? 0 : cover[parents[i]]) + listed[i]
      jointsAt[i] += cover[i]
    }
  }
  // sorting the joints (the manager, before its first update): from each dependency, a walk up to the root, and at
  // each object above it the joints there; then a walk down from their common ancestor
  if (counts.springJoints > 0) {
    let mostJoints = 0
    for (const n of jointsAt) if (n > mostJoints) mostJoints = n
    counts.springSortWork = jointDependencies * deepest * (1 + mostJoints) + sceneObjects
  }

  nodes.forEach((node, i) => {
    const constraint = object(node.extensions, `node ${i} extensions`).VRMC_node_constraint
    if (constraint === undefined) return
    counts.constraints++
    const def = object(object(constraint, `node ${i} constraint`).constraint, `node ${i} constraint`)
    for (const kind of ['roll', 'aim', 'rotation'])
      index(object(def[kind], kind).source, 'nodes', `node ${i} ${kind} source`)
  })

  // MToon outlines: for each primitive of a mesh whose material is outlined, the plugin adds two draw groups to the
  // primitive's geometry, which the parser shares between meshes with the same primitive; every mesh drawn with
  // that geometry then draws all of its groups
  const outlined = m => {
    if (m === undefined) return false
    if (v0) return true // VRM 0 MToon materials are converted when loaded: any of them may be
    const mtoon = object(materials[m].extensions, 'extensions').VRMC_materials_mtoon
    return typeof mtoon?.outlineWidthMode === 'string' && mtoon.outlineWidthMode !== 'none'
  }
  const groups = new Map()
  const keyOf = primitive => primitiveKey(primitive)
  const keys = collections.meshes.map(mesh => list(mesh.primitives, 'primitives').map(keyOf))
  collections.meshes.forEach((mesh, i) => {
    step(1 + keys[i].length, 'VRM outlines')
    list(mesh.primitives, 'primitives').forEach((primitive, k) => {
      if (outlined(primitive.material)) groups.set(keys[i][k], (groups.get(keys[i][k]) || 0) + 2)
    })
  })
  if (groups.size > 0) {
    for (const [mesh, uses] of usesOf) {
      for (const key of keys[mesh]) counts.outlineDraws += uses * (groups.get(key) || 0)
    }
  }
  // and the outline material it clones for each such primitive of each mesh. MToon is a ShaderMaterial: the clone
  // copies the material's userData as JSON (its extras, and the extensions the parser does not handle, which include
  // the MToon extension itself), and clones the texture in each of its texture uniforms (each counted at the largest
  // texture's userData, above). At what a JSON copy holds, and 8 KiB for the uniforms, the material object and the
  // MToon extension a VRM 0 material is converted to. A bound by construction (each term at least what it stands for)
  const copied = value => (value === undefined ? 0 : jsonCopyBytes(JSON.stringify(value) || ''))
  const copies = new Map()
  const copyBytes = m => {
    if (!copies.has(m)) {
      const material = materials[m]
      copies.set(m, 8192 + copied(material.extras) + copied(material.extensions) + MTOON_TEXTURE_SLOTS * largestTexture)
    }
    return copies.get(m)
  }
  collections.meshes.forEach(mesh => {
    for (const primitive of list(mesh.primitives, 'primitives')) {
      if (outlined(primitive.material)) counts.outlineCopyBytes += copyBytes(primitive.material)
    }
  })

  for (const [name, value] of Object.entries(counts)) {
    if (value > caps[name]) refuse(`three-vrm ${name}: ${value}, more than ${caps[name]}`)
  }
  return { nodes: nodes.length, vrm: counts }
}

// the texture uniforms of three-vrm's MToonMaterial (3.3.3): map, alphaMap, normalMap, emissiveMap,
// shadeMultiplyTexture, shadingShiftTexture, matcapTexture, rimMultiplyTexture, outlineWidthMultiplyTexture,
// uvAnimationMaskTexture (test/gltfLimits.test.js reads them from the class)
export const MTOON_TEXTURE_SLOTS = 10
// the most texture slots three-vrm's VRMExpressionTextureTransformBind (3.3.3) clones on one material: a
// MeshStandardMaterial's map, emissiveMap, bumpMap, normalMap, displacementMap, roughnessMap, metalnessMap and
// alphaMap (MToon has 7, MeshBasicMaterial 3; test/gltfLimits.test.js reads them from the class)
export const TEXTURE_TRANSFORM_SLOTS = 8

// the parser's cache key for a primitive's geometry (its createPrimitiveKey, without Draco: this client has no
// decoder): primitives with the same key share one geometry
function primitiveKey(primitive) {
  const attributesKey = map =>
    Object.keys(map ?? {})
      .sort()
      .map(key => `${key}:${map[key]};`)
      .join('')
  let key = `${primitive.indices}:${attributesKey(primitive.attributes)}:${primitive.mode}`
  for (const target of Array.isArray(primitive.targets) ? primitive.targets : []) key += `:${attributesKey(target)}`
  return key
}

// The per-file budget the parser charges (see the COO_BUDGET and COO_WORK sites in the vendored GLTFLoader).
// `fileBytes`: the file's size (its data is copied twice: the GLB's binary chunk, then the bufferViews; and an honest
// file's accessors are gone through about once). `onCharge(kind, n, what, total)`: told of every charge (tests).
// `now`: a monotonic clock in milliseconds (tests). `maxTextureSize`: the renderer's, when it is known (the
// morph-target textures three.js builds are padded to rows of it)
export function createGLTFBudget({
  fileBytes = 0,
  limits = GLTF_LIMITS,
  onCharge,
  now = () => globalThis.performance.now(),
  maxTextureSize,
} = {}) {
  const maxBytes = limits.allocatedBytes + 2 * fileBytes
  const maxWork = limits.work + fileBytes
  const used = { bytes: 0, pixels: 0, work: 0, counts: {} }
  // the wall-clock backstop: every charge looks at the time (work only each 65,536 steps, since walks charge a step
  // per object). Once refused it stays quiet: the parse has failed, and the parts still running are bounded by the
  // other limits (refusing them all would reject promise chains nothing waits on any more)
  const started = now()
  let unclocked = 0
  let timedOut = false
  const clock = what => {
    unclocked = 0
    if (!timedOut && now() - started > limits.parseMilliseconds) {
      timedOut = true
      fail(what, `the parse took more than ${limits.parseMilliseconds / 1000} s (at ${what})`)
    }
  }
  // every later charge of the kind refused is refused too (its total stays past the limit), so a part of the parse
  // still running (promise chains the parser started side by side) allocates, or walks, nothing more than the
  // limits allow. (Refusing every kind after the first refusal would reject chains nothing waits on any more.)
  // the first refusal is kept (budget.refused): the parser fails the parse with it even where it had to swallow it
  const fail = (what, reason) => {
    onCharge?.('refused', 0, what, reason)
    const error = new GLTFLimitError(reason)
    budget.refused ??= error
    throw error
  }
  const budget = {
    used,
    refused: null,
    maxBytes,
    maxWork,
    maxTextureSize: Number.isSafeInteger(maxTextureSize) && maxTextureSize > 0 ? maxTextureSize : undefined,
    bytes(n, what) {
      clock(what)
      if (!Number.isFinite(n) || n < 0) fail(what, `${what}: an impossible size`)
      used.bytes += n
      onCharge?.('bytes', n, what, used.bytes)
      if (used.bytes > maxBytes) fail(what, `the parser would allocate more than ${maxBytes} bytes (at ${what})`)
    },
    count(kind, n = 1) {
      clock(kind)
      const limit = limits.counts[kind]
      if (limit === undefined) throw new Error(`gltf budget: unknown count ${kind}`)
      const total = (used.counts[kind] || 0) + n
      used.counts[kind] = total
      onCharge?.('count', n, kind, total)
      if (total > limit) fail(kind, `${kind}: ${total}, more than ${limit}`)
    },
    // steps of work, charged before they are taken (or, for a walk, at each object visited)
    work(n, what) {
      unclocked += n
      if (unclocked >= 65536) clock(what)
      if (!Number.isFinite(n) || n < 0) fail(what, `${what}: an impossible amount of work`)
      used.work += n
      onCharge?.('work', n, what, used.work)
      if (used.work > maxWork) fail(what, `the parser would take more than ${maxWork} steps (at ${what})`)
    },
    // a JSON copy of a value (three.js's clone of an object's, a material's or a texture's userData): the bytes the
    // copy holds (jsonCopyBytes) and a step a character
    jsonCopy(value, what) {
      let text = ''
      try {
        text = JSON.stringify(value) ?? ''
      } catch {
        // what three.js cannot stringify, it cannot copy: the clone throws before it allocates
      }
      budget.bytes(jsonCopyBytes(text), what)
      budget.work(text.length, what)
    },
    // a document the parser cannot use (a rule of the specification it would otherwise loop or write on through)
    refuse(reason, what) {
      fail(what, reason)
    },
    // an image about to be decoded, sized from its header (embedded images must be PNG, JPEG or WebP)
    image(bytes, what) {
      clock(what)
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
    // an image named by URI: a data: URI is measured as embedded bytes (one that does not decode is refused, like any
    // other image that is not one); a blob: URL is refused; any other URL is refused by the client's URL filter
    // before a fetch, so nothing decodes it
    imageURI(uri, what) {
      if (typeof uri !== 'string') return
      const scheme = uri.trim().toLowerCase()
      if (scheme.startsWith('data:')) {
        let bytes
        try {
          bytes = decodeDataURI(uri)
        } catch {
          fail(what, `${what} is a data: URI that does not decode`)
        }
        return budget.image(bytes, what)
      }
      if (scheme.startsWith('blob:')) fail(what, `${what} names a blob: URL`)
    },
  }
  return budget
}
