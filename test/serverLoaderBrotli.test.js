import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { loadClient } from './lib/clientHarness.mjs'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { installFetchBrotliGuard } from '../src/server/fetchGuard.js'

// A model's files outside it are never requested on the server: the loader's manager only lets a model use what
// is inside it (data: and blob: URLs), so a .glb or .gltf cannot make the server fetch a URL of its author's
// choosing. An external buffer fails the load (not hang); an external image is left out and the model loads
// without it. The Brotli guard stays installed here as it is in the server process, and no decoder may be created
// either way.
const unhandled = []
const requested = []
const decoders = { br: 0 }
const original = zlib.createBrotliDecompress
let server
let base
let dir

// one triangle: 3 float32 vec3 positions
const triangle = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)
// a model whose buffer is at `uri` (or in the .glb's own BIN chunk when there is none), and whose material's
// texture is the image at `image`
const gltfJSON = (uri, image) => ({
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, ...(image ? { material: 0 } : {}) }] }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
  buffers: [{ ...(uri ? { uri } : {}), byteLength: 36 }],
  ...(image
    ? {
        images: [{ uri: image }],
        textures: [{ source: 0 }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      }
    : {}),
})
const gltf = uri => JSON.stringify(gltfJSON(uri))
// a binary .glb: the JSON chunk and a BIN chunk holding the triangle
function glb(image) {
  const pad = (buffer, fill) => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, fill)])
  const json = pad(Buffer.from(JSON.stringify(gltfJSON(null, image))), 0x20)
  const bin = pad(triangle, 0)
  const chunk = (data, type) => {
    const header = Buffer.alloc(8)
    header.writeUInt32LE(data.length, 0)
    header.writeUInt32LE(type, 4)
    return Buffer.concat([header, data])
  }
  const body = Buffer.concat([chunk(json, 0x4e4f534a), chunk(bin, 0x004e4942)])
  const header = Buffer.alloc(12)
  header.write('glTF', 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + body.length, 8)
  return Buffer.concat([header, body])
}

function loader() {
  const ServerLoader = loadClient('core/systems/ServerLoader.js', 'ServerLoader', {
    fs,
    path,
    RGBELoader: class {},
    GLTFLoader,
    System: class {
      constructor(world) {
        this.world = world
      }
    },
    createVRMFactory: () => ({}),
    glbToNodes: () => ({ clone: () => ({ cloned: true }) }),
    createNode: () => ({}),
    createEmoteFactory: () => ({ toClip: () => null }),
  })
  return new ServerLoader({ assetsDir: dir, resolveURL: url => url })
}

const settle = (promise, ms) =>
  Promise.race([
    promise.then(
      value => ({ status: 'resolved', value }),
      error => ({ status: 'rejected', error })
    ),
    new Promise(resolve => setTimeout(() => resolve({ status: 'pending' }), ms)),
  ])

before(async () => {
  process.on('unhandledRejection', err => unhandled.push(err))
  Object.defineProperty(zlib, 'createBrotliDecompress', {
    configurable: true,
    value: (...args) => {
      decoders.br++
      return original(...args)
    },
  })
  installFetchBrotliGuard()
  server = http.createServer((req, res) => {
    requested.push(req.url)
    if (req.url === '/buffer-br.bin') {
      res.writeHead(200, { 'content-encoding': 'br' })
      return res.end(zlib.brotliCompressSync(triangle))
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loader-br-'))
  await fs.writeFile(path.join(dir, 'br.gltf'), gltf(`${base}/buffer-br.bin`))
  await fs.writeFile(path.join(dir, 'image.glb'), glb(`${base}/private.png`))
  await fs.writeFile(path.join(dir, 'embedded.glb'), glb(null))
})

after(async () => {
  Object.defineProperty(zlib, 'createBrotliDecompress', { configurable: true, value: original })
  await new Promise(resolve => server.close(resolve))
  await fs.remove(dir)
})

test('server loader: a model that names an external buffer fails its load, and the buffer is never requested', async () => {
  const result = await settle(loader().load('model', 'asset://br.gltf'), 5000)
  assert.equal(result.status, 'rejected', 'the load settles instead of hanging')
  // the manager's refusal itself, not some other failure of the parse
  assert.equal(result.error?.code, 'ASSET_REFUSED')
  assert.match(result.error.message, /asset refused \(a model may not load external files on the server\): "http:/)
  assert.deepEqual(requested, [], 'the external buffer was not requested')
  assert.equal(decoders.br, 0)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(unhandled, [])
})

test('server loader: a model that names an external image loads without it, and the image is never requested', async t => {
  const logged = []
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')))
  // where createImageBitmap exists GLTFLoader reads images with fetch (ImageBitmapLoader): only the manager stands
  // between the file and a request then. Without it, images go to <img> elements, which Node does not have
  for (const bitmaps of [true, false]) {
    if (bitmaps) globalThis.createImageBitmap = async () => ({ close() {} })
    else delete globalThis.createImageBitmap
    const instance = loader()
    const { manager } = instance.gltfLoader
    const modifier = manager.urlModifier
    const refused = []
    manager.setURLModifier(url => {
      try {
        return modifier(url)
      } catch (err) {
        refused.push(url)
        throw err
      }
    })
    const result = await settle(instance.load('model', 'asset://image.glb'), 5000)
    assert.equal(result.status, 'resolved', 'GLTFLoader turns the refused texture into no texture')
    assert.deepEqual(refused, [`${base}/private.png`], 'the manager refused the image')
    assert.deepEqual(requested, [], 'the external image was not requested')
    assert.ok(
      logged.some(line => line.includes("Couldn't load texture")),
      'the texture was left out'
    )
  }
  // the same model with nothing outside it loads as well
  assert.equal((await settle(loader().load('model', 'asset://embedded.glb'), 5000)).status, 'resolved')
  assert.deepEqual(requested, [])
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(unhandled, [])
})
