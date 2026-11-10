import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { createGLTFBudget, GLTF_LIMITS } from '../src/core/extras/gltfLimits.js'
import { imageElementsPlugin } from '../src/core/extras/gltfImageElements.js'
import { png } from './lib/imageBytes.mjs'
import { glb } from './lib/glb.mjs'

// An embedded image is decoded from a blob: URL the parser makes for it (GLTFLoader.loadImageSource, COO_REVOKE). The
// URL holds the image's bytes until it is revoked; it was revoked only when the decode succeeded, so each failed
// decode kept its bytes for the life of the page. Every way the load ends is driven here, on both image loaders: the
// ImageBitmap one, and the <img> one iPhones and iPads get (imageElementsPlugin).
const saved = {}
let urls // the object URLs made and not revoked
let decode // what the next ImageBitmap decode does

beforeEach(t => {
  for (const name of ['self', 'createImageBitmap', 'ProgressEvent', 'document']) saved[name] = globalThis[name]
  globalThis.self = globalThis
  globalThis.ProgressEvent ??= class extends Event {}
  urls = new Set()
  decode = async () => ({ width: 64, height: 64, close() {} })
  globalThis.createImageBitmap = (...args) => decode(...args)
  const create = URL.createObjectURL.bind(URL)
  const revoke = URL.revokeObjectURL.bind(URL)
  t.mock.method(URL, 'createObjectURL', blob => {
    const url = create(blob)
    urls.add(url)
    return url
  })
  t.mock.method(URL, 'revokeObjectURL', url => {
    urls.delete(url)
    revoke(url)
  })
  t.mock.method(console, 'error', () => {})
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[name]
    else globalThis[name] = value
  }
})

// a triangle whose material has one embedded image; `more`: other entries of the document
function textured(image = png(64, 64), more = {}) {
  const bin = new Uint8Array(36 + image.length)
  bin.set(image, 36)
  return glb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
      accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [0, 0, 0] }],
      bufferViews: [
        { buffer: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: image.length },
      ],
      buffers: [{ byteLength: bin.length }],
      ...more,
    },
    bin
  )
}

const parse = (file, { plugin, limits = GLTF_LIMITS } = {}) => {
  const loader = new GLTFLoader()
  if (plugin) loader.register(plugin)
  return loader.parseAsync(file, '', createGLTFBudget({ fileBytes: file.byteLength, limits }))
}
const map = gltf => gltf.scene.getObjectByProperty('isMesh', true).material.map
const until = async (condition, what) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(condition(), what)
}

test('ImageBitmaps: the blob URL is revoked after a decode, a failed decode, and one still running when the parse fails', async () => {
  // a decode: revoked once it is done
  assert.ok(map(await parse(textured())), 'the texture loaded')
  assert.equal(urls.size, 0)
  // a decode that fails: the material is left without the texture, and the URL is revoked all the same
  decode = async () => {
    throw new Error('not an image after all')
  }
  assert.equal(map(await parse(textured())), null)
  assert.equal(urls.size, 0, 'a failed decode keeps no blob')
  // a refusal at the image (its header): no URL is made
  await assert.rejects(parse(textured(png(100000, 100000))), /image 0 is larger than 36000000 pixels/)
  assert.equal(URL.createObjectURL.mock.callCount(), 2)
  // a refusal elsewhere while the decode runs (2000 cameras, more than 1024): the parse fails at once; the decode
  // still running ends later, and its URL is revoked then
  let finish
  decode = () => new Promise((resolve, reject) => (finish = reject))
  const cameras = Array.from({ length: 2000 }, () => ({ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }))
  await assert.rejects(parse(textured(png(64, 64), { cameras })), /cameras: 1025, more than 1024/)
  await until(() => finish !== undefined, 'the decode started')
  assert.equal(urls.size, 1, 'held while the decode runs')
  finish(new Error('the page moved on'))
  await until(() => urls.size === 0, 'revoked when the decode ended')
})

// a DOM for the <img> path: each image loads, or fails, a moment after its src is set
class FakeImage extends EventTarget {
  static fails = false
  set src(url) {
    this.url = url
    setTimeout(() => this.dispatchEvent(new Event(FakeImage.fails ? 'error' : 'load')), 1)
  }
}

test('<img> elements (imageElementsPlugin): the blob URL is revoked after a load and after a failed one', async () => {
  globalThis.document = { createElementNS: () => new FakeImage() }
  FakeImage.fails = false
  const texture = map(await parse(textured(), { plugin: imageElementsPlugin }))
  assert.ok(texture.image instanceof FakeImage, 'loaded by an <img>')
  assert.equal(urls.size, 0)
  FakeImage.fails = true
  assert.equal(map(await parse(textured(), { plugin: imageElementsPlugin })), null)
  assert.equal(URL.createObjectURL.mock.callCount(), 2)
  assert.equal(urls.size, 0, 'a failed load keeps no blob')
})
