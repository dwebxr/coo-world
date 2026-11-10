import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { loadClient } from './lib/clientHarness.mjs'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { LoaderUtils } from 'three'

// The server parses models and emotes with the limits a client applies (gltfLimits.js): the document is checked
// first, the parse is charged to a budget, and with a budget the parser decodes the file's own data itself.

const tick = () => new Promise(resolve => setImmediate(resolve))
const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
const base64 = Buffer.from(triangle.buffer).toString('base64')
// a model of one triangle whose buffer is `buffer` (an entry of `buffers`)
const model = (buffer, accessor = {}) =>
  JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0], ...accessor },
    ],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36, ...buffer }],
  })

const files = {
  'triangle.gltf': model({ uri: `data:application/octet-stream;base64,${base64}` }),
  'upper.gltf': model({ uri: `DATA:application/octet-stream;base64,${base64}` }),
  // a billion positions that no data backs: 12 GB for the parser to fill with zeros
  'huge.gltf': model({ uri: `data:application/octet-stream;base64,${base64}` }, { bufferView: undefined, count: 1e9 }),
  // three.js's URL helper takes quadratic time on this one
  'breaks.gltf': model({ uri: `data:application/octet-stream,${','.repeat(100_000)}\nx` }),
  'short.gltf': model({ uri: `data:application/octet-stream;base64,${base64.slice(0, 32)}` }),
}

// the parsed file is handed over as it is, so a test can look at what the parser built
const ServerLoader = loadClient('core/systems/ServerLoader.js', 'ServerLoader', {
  fs: { readFile: async file => Buffer.from(files[path.basename(file)]) },
  path,
  RGBELoader: class {},
  GLTFLoader,
  System: class {
    constructor(world) {
      this.world = world
    }
  },
  createVRMFactory: () => ({}),
  glbToNodes: glb => ({ clone: () => glb }),
  createNode: () => ({ add() {}, clone: () => ({}) }),
  createEmoteFactory: glb => ({ toClip: () => glb }),
})
const makeLoader = () =>
  new ServerLoader({
    assetsDir: path.join(path.sep, 'world', 'assets'),
    resolveURL: url => url,
    scripts: { evaluate: code => ({ code }) },
  })
const positions = glb => {
  let found = null
  glb.scene.traverse(object => {
    if (object.geometry) found = Array.from(object.geometry.attributes.position.array)
  })
  return found
}
const settled = promise =>
  promise.then(
    value => ({ value }),
    error => ({ error })
  )

test('a model whose buffer is a data: URI loads on the server, decoded by the parser itself', async t => {
  // three's own loader would be asked for the data: URL (and its URL helper for the text); neither may happen
  const resolved = []
  const resolveURL = LoaderUtils.resolveURL
  t.mock.method(LoaderUtils, 'resolveURL', (url, base) => {
    resolved.push(url)
    return resolveURL(url, base)
  })
  const fetched = []
  t.mock.method(globalThis, 'fetch', async url => {
    fetched.push(String(url))
    throw new Error('the server loader fetched')
  })
  for (const name of ['triangle.gltf', 'upper.gltf']) {
    const loader = makeLoader()
    const result = await loader.load('model', `asset://${name}`)
    assert.deepEqual(positions(result.toNodes()), Array.from(triangle), name)
  }
  assert.deepEqual(resolved, [], 'no data: URI reached the URL helper')
  assert.deepEqual(fetched, [], 'nothing was fetched')
})

test('a file a client would refuse is refused on the server, is not kept, and leaves its turn', async () => {
  const loader = makeLoader()
  for (const [name, reason] of [
    ['huge.gltf', /model file: /],
    ['breaks.gltf', /model file: .*line break/],
    ['short.gltf', /model file: /],
  ]) {
    for (const type of ['model', 'emote']) {
      const { error } = await settled(loader.load(type, `asset://${name}`))
      assert.equal(error?.isGLTFLimit, true, `${type} ${name}: ${error?.message}`)
      assert.match(error.message, reason)
      await tick()
      assert.equal(loader.get(type, `asset://${name}`), undefined, 'a refused file is not kept')
    }
  }
  assert.equal(loader.results.size, 0)
  assert.equal(loader.turns.active.size, 0, 'every turn was given back')
  // each file has its own budget: the refusals above cost the next file nothing
  const result = await loader.load('model', 'asset://triangle.gltf')
  assert.deepEqual(positions(result.toNodes()), Array.from(triangle))
})

test('the billion-element accessor is refused before anything of that size is made', async t => {
  const made = []
  const RealFloat32Array = globalThis.Float32Array
  // counts what the parser asks for; a refusal must come before the 12 GB request, not from it
  globalThis.Float32Array = new Proxy(RealFloat32Array, {
    construct(target, args) {
      if (typeof args[0] === 'number') made.push(args[0])
      return Reflect.construct(target, args)
    },
  })
  t.after(() => (globalThis.Float32Array = RealFloat32Array))
  const { error } = await settled(makeLoader().load('model', 'asset://huge.gltf'))
  assert.equal(error?.isGLTFLimit, true)
  assert.ok(
    made.every(length => length < 1e6),
    `arrays asked for: ${made.join(', ')}`
  )
})
