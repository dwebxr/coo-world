import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { loadClient } from './lib/clientHarness.mjs'
import { imageElementsPlugin } from '../src/core/extras/gltfImageElements.js'
import { checkGLTF, createGLTFBudget } from '../src/core/extras/gltfLimits.js'
import { png } from './lib/imageBytes.mjs'
import { MAX_IMAGE_PIXELS, readImageHeader } from '../src/core/extras/imageHeader.js'

// The browser's loader with the real (vendored) GLTF parser, its per-file budget and three-vrm's real plugin: a model, avatar or emote may only
// use what is inside its file, embedded images still load (both the ImageBitmap path and the iPhone <img> path),
// and the pixel budget applies to them. Image decoding is the only stand-in: Node has no decoder, so a decoded
// image reports the size the test gives it.
let apple = false
let parsed = null
const keep = glb => {
  parsed = glb
}
const ClientLoader = loadClient('core/systems/ClientLoader.js', 'ClientLoader', {
  THREE,
  RGBELoader: class {},
  GLTFLoader,
  VRMLoaderPlugin,
  System: class {
    constructor(world) {
      this.world = world
    }
  },
  createNode: () => ({ add() {} }),
  createVRMFactory: glb => (keep(glb), {}),
  glbToNodes: glb => (keep(glb), { clone: () => ({}) }),
  createEmoteFactory: glb => (keep(glb), { toClip: () => null }),
  formatBytes: n => String(n),
  imageElementsPlugin,
  checkGLTF,
  createGLTFBudget,
  isAppleMobile: () => apple,
  emoteUrls: [],
  Hls: class {},
  MAX_IMAGE_PIXELS,
  readImageHeader,
})

const ASSETS = 'https://world.example/assets'
let decodedSize = 512
const closed = []
const globals = {}
const files = {}
const requests = []

before(() => {
  for (const name of ['self', 'createImageBitmap', 'document', 'ProgressEvent', 'fetch']) {
    globals[name] = globalThis[name]
  }
  globalThis.self = globalThis // GLTFLoader reads self.URL
  // the ImageBitmap path: a bitmap of the size the test sets, from the blob the parser fetched
  globalThis.createImageBitmap = async blob => {
    assert.ok(blob.size > 0)
    const size = decodedSize
    return { width: size, height: size, close: () => closed.push(size) }
  }
  // the <img> path (iPhone and iPad), through three's ImageLoader
  class FakeImage extends EventTarget {
    set src(value) {
      this._src = value
      const size = decodedSize
      queueMicrotask(() => {
        this.naturalWidth = this.width = size
        this.naturalHeight = this.height = size
        this.dispatchEvent(new Event('load'))
      })
    }
    get src() {
      return this._src
    }
  }
  globalThis.document = { createElementNS: (ns, name) => (name === 'img' ? new FakeImage() : { style: {} }) }
  globalThis.ProgressEvent ??= class extends Event {
    constructor(type, init) {
      super(type)
      Object.assign(this, init)
    }
  }
  const original = globals.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('data:') || url.startsWith('blob:')) return original(input, init)
    requests.push(url)
    const body = files[url]
    return body ? new Response(body) : new Response('not found', { status: 404 })
  }
})

after(() => {
  for (const [name, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[name]
    else globalThis[name] = value
  }
})

function makeLoader() {
  const world = {
    assetsUrl: ASSETS,
    network: { maxUploadSize: 32 },
    resolveURL: url => (url.startsWith('asset://') ? url.replace('asset:/', ASSETS) : url),
    setupMaterial: () => {},
  }
  const loader = new ClientLoader(world)
  loader.vrmHooks = {}
  return loader
}

const serve = (name, body) => {
  files[`${ASSETS}/${name}`] = body
  return `asset://${name}`
}

// a GLB container: the JSON chunk and, when given, the binary chunk
function glb(json, bin) {
  const pad = (bytes, fill) => {
    const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill)
    out.set(bytes)
    return out
  }
  const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const binBytes = bin ? pad(bin, 0) : null
  const total = 12 + 8 + jsonBytes.length + (binBytes ? 8 + binBytes.length : 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  if (binBytes) {
    const offset = 20 + jsonBytes.length
    view.setUint32(offset, binBytes.length, true)
    view.setUint32(offset + 4, 0x004e4942, true)
    out.set(binBytes, offset + 8)
  }
  return out
}

// one textured triangle. `buffer`: the buffer's uri (none: the GLB's own chunk); `image`: an image uri (none: the
// image is in the buffer)
function triangle({ buffer, image, size = [64, 64] } = {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1])
  const header = png(...size) // decoded by the stand-in; only its header is read for real
  const bin = new Uint8Array(128)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(uvs.buffer), 36)
  bin.set(header, 60)
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'tri' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [image ? { uri: image } : { bufferView: 2, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 24 },
      { buffer: 0, byteOffset: 60, byteLength: header.length },
    ],
    buffers: [buffer ? { byteLength: 128, uri: buffer } : { byteLength: 128 }],
  }
  if (buffer === 'data:') {
    json.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`
  }
  // a .gltf (text) when the buffer is a uri, a .glb otherwise
  return buffer ? new TextEncoder().encode(JSON.stringify(json)) : glb(json, bin)
}

const mapOf = glb => {
  let map
  glb.scene.traverse(node => {
    if (node.isMesh) map = node.material.map
  })
  return map
}

test('a model or emote that names an external buffer is refused before anything is fetched from it', async t => {
  t.mock.method(console, 'error', () => {})
  const loader = makeLoader()
  requests.length = 0
  for (const [type, uri] of [
    ['model', 'https://elsewhere.example/big.bin'],
    ['emote', 'https://elsewhere.example/big.bin'],
    ['avatar', 'https://elsewhere.example/big.bin'],
    ['model', 'big.bin'],
    ['model', '//elsewhere.example/big.bin'],
  ]) {
    const url = serve(`external-${type}-${requests.length}.gltf`, triangle({ buffer: uri }))
    await assert.rejects(loader.load(type, url), /may not reference external files/, `${type} ${uri}`)
  }
  assert.ok(
    requests.every(url => url.endsWith('.gltf')),
    `only the files themselves were requested: ${requests}`
  )
  // a buffer inside the file, as a data: URI, loads
  parsed = null
  assert.ok(await loader.load('model', serve('data-buffer.gltf', triangle({ buffer: 'data:' }))))
  assert.equal(parsed.scene.getObjectByName('tri').geometry.attributes.position.count, 3)
})

test('the parser refuses at the allocation: a file of a few hundred bytes declaring a billion vertices', async () => {
  const loader = makeLoader()
  // one accessor of a billion VEC3 floats with no data, in a scene: the parser would zero-fill 12 GB; its budget
  // refuses at the charge made just before that allocation. (Without the scene the parser never loads the accessor.)
  const file = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      accessors: [{ componentType: 5126, type: 'VEC3', count: 1000000000 }],
    })
  )
  assert.ok(file.length < 300)
  for (const type of ['model', 'emote', 'avatar']) {
    await assert.rejects(
      loader.load(type, serve(`declared-${type}.gltf`, file)),
      /would allocate more than \d+ bytes \(at accessor without data\)/,
      type
    )
  }
  await assert.rejects(
    loader.insert('model', 'asset://picked.gltf', new File([file], 'picked.gltf')),
    /would allocate more than/
  )
  // and the files are not kept
  assert.equal(loader.hasFile('asset://declared-model.gltf'), false)
  assert.equal(loader.hasFile('asset://picked.gltf'), false)
})

test('an image inside the file loads (ImageBitmap and <img> paths); an external one is not fetched', async t => {
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')))
  for (const iphone of [false, true]) {
    apple = iphone
    const loader = makeLoader()
    decodedSize = 512
    parsed = null
    await loader.load('model', serve(`embedded-${iphone}.glb`, triangle()))
    const image = mapOf(parsed).image
    assert.equal(iphone ? image.naturalWidth : image.width, 512, 'the embedded image went through the loader')
    assert.equal(iphone, image instanceof EventTarget, iphone ? 'an <img> element' : 'an ImageBitmap')
    // an image the file names elsewhere: the model loads without that texture, and nothing is requested
    requests.length = 0
    parsed = null
    const external = triangle({ image: 'https://elsewhere.example/t.png' })
    await loader.load('model', serve(`external-image-${iphone}.glb`, external))
    assert.equal(mapOf(parsed), null)
    assert.deepEqual(requests, [`${ASSETS}/external-image-${iphone}.glb`])
    // the parser reports the texture it could not load (and the request list shows it was refused, not missing)
    assert.ok(errors.some(line => line.includes("Couldn't load texture https://elsewhere.example/t.png")))
  }
  apple = false
})

test('an embedded image whose header declares more than the budget is refused before it is decoded (both paths)', async t => {
  t.mock.method(console, 'error', () => {})
  const decodes = t.mock.method(globalThis, 'createImageBitmap')
  const elements = t.mock.method(globalThis.document, 'createElementNS')
  for (const iphone of [false, true]) {
    apple = iphone
    const loader = makeLoader()
    for (const type of ['model', 'emote', 'avatar']) {
      const url = serve(`declares-${type}-${iphone}.glb`, triangle({ size: [100000, 100000] }))
      await assert.rejects(loader.load(type, url), /image 0 is larger than 36000000 pixels/, `${type} ${iphone}`)
    }
    await assert.rejects(
      loader.insert(
        'model',
        `asset://declares-picked-${iphone}.glb`,
        new File([triangle({ size: [100000, 100000] })], 'p.glb')
      ),
      /larger than 36000000 pixels/
    )
  }
  apple = false
  assert.equal(decodes.mock.callCount(), 0, 'no ImageBitmap was decoded')
  assert.equal(elements.mock.callCount(), 0, 'no <img> was made')
})

test('an embedded image above the pixel budget fails the load and its bitmap is closed', async t => {
  t.mock.method(console, 'error', () => {})
  for (const iphone of [false, true]) {
    apple = iphone
    const loader = makeLoader()
    decodedSize = 8000
    closed.length = 0
    for (const type of ['model', 'emote', 'avatar']) {
      await assert.rejects(
        loader.load(type, serve(`huge-${type}-${iphone}.glb`, triangle())),
        /texture in the file is larger than 36000000 pixels/,
        `${type} ${iphone}`
      )
    }
    if (!iphone) assert.deepEqual(closed, [8000, 8000, 8000])
    decodedSize = 6000
    assert.ok(await loader.load('model', serve(`fits-${iphone}.glb`, triangle())))
  }
  apple = false
  decodedSize = 512
})

test('the bundled VRM loads every embedded texture through the loader’s manager (three-vrm’s plugin, both image paths)', async t => {
  t.mock.method(console, 'warn', () => {})
  const vrm = fs.readFileSync(new URL('../src/world/assets/avatar.vrm', import.meta.url))
  for (const iphone of [false, true]) {
    apple = iphone
    const loader = makeLoader()
    decodedSize = 1024
    parsed = null
    await loader.load('avatar', serve(`avatar-${iphone}.vrm`, vrm))
    assert.ok(parsed.userData.vrm?.humanoid, 'three-vrm ran')
    const images = parsed.parser.json.images.length
    const textures = new Set()
    parsed.scene.traverse(node => {
      for (const material of [node.material].flat()) {
        if (!material) continue
        const values = [...Object.values(material), ...Object.values(material.uniforms || {}).map(u => u?.value)]
        for (const value of values) if (value?.isTexture) textures.add(value)
      }
    })
    assert.ok(textures.size > 0 && images > 0)
    for (const texture of textures) {
      const size = iphone ? texture.image?.naturalWidth : texture.image?.width
      assert.equal(size, 1024, `${texture.name}: decoded through the loader`)
    }
    parsed = null
  }
  apple = false
})
