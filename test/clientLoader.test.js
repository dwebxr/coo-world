import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { loadClient } from './lib/clientHarness.mjs'

// The browser's loader with its real code and a fake network: what it accepts, refuses, keeps and forgets.
const ClientLoader = loadClient('core/systems/ClientLoader.js', 'ClientLoader', {
  THREE,
  RGBELoader: class {
    parse() {
      return { data: new Uint8Array(4), width: 1, height: 1, type: 0 }
    }
  },
  GLTFLoader: class {
    register() {}
    async parseAsync(buffer) {
      return { scene: new THREE.Group(), animations: [], bytes: buffer.byteLength }
    }
  },
  VRMLoaderPlugin: class {},
  System: class {
    constructor(world) {
      this.world = world
    }
  },
  createNode: () => ({}),
  createVRMFactory: () => ({}),
  glbToNodes: () => ({ clone: () => ({}) }),
  createEmoteFactory: () => ({ toClip: () => null }),
  TextureLoader: class {},
  formatBytes: n => String(n),
  imageElementsPlugin: () => {},
  isAppleMobile: () => false,
  emoteUrls: [],
  Hls: class {},
})

const ASSETS = 'https://world.example/assets'

// a fetch that answers from a table: { status, body, headers, stream } per url; counts requests
function fakeNetwork(t, table) {
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push(url)
    const entry = typeof table === 'function' ? table(url, requests.length) : table[url]
    if (!entry) return new Response('<html>not found</html>', { status: 404 })
    if (entry.stream) {
      const body = new ReadableStream({
        pull(controller) {
          if (init?.signal?.aborted) return controller.close()
          controller.enqueue(new Uint8Array(entry.stream))
        },
      })
      return new Response(body, { status: 200 })
    }
    return new Response(entry.body ?? '', { status: entry.status ?? 200, headers: entry.headers })
  }
  t.after(() => (globalThis.fetch = original))
  return requests
}

function makeLoader() {
  const world = {
    assetsUrl: ASSETS,
    resolveURL: url => (url.startsWith('asset://') ? url.replace('asset:/', ASSETS) : url),
    scripts: { evaluate: code => ({ code }) },
  }
  return new ClientLoader(world)
}

test('an error status is a failed load, not content; and a failed load can be tried again', async t => {
  let fail = true
  const requests = fakeNetwork(t, url =>
    url.endsWith('/app.js') ? (fail ? { status: 503, body: 'busy' } : { body: '// ok' }) : null
  )
  const loader = makeLoader()
  // the 404 page used to be evaluated as the script, and the 503 answer kept for the session
  await assert.rejects(loader.load('script', 'asset://missing.js'), /HTTP 404/)
  await assert.rejects(loader.load('script', 'asset://app.js'), /HTTP 503/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loader.has('script', 'asset://app.js'), false)
  fail = false
  assert.equal((await loader.load('script', 'asset://app.js')).code, '// ok')
  // and a successful one is kept
  const before = requests.length
  assert.equal((await loader.load('script', 'asset://app.js')).code, '// ok')
  assert.equal(requests.length, before)
})

test('a download stops at the size limit for its kind: declared length, real length and endless streams', async t => {
  const big = new Uint8Array(3 * 1024 * 1024)
  fakeNetwork(t, {
    [`${ASSETS}/declared.js`]: { body: 'x', headers: { 'content-length': String(50 * 1024 * 1024) } },
    [`${ASSETS}/large.js`]: { body: big },
    [`${ASSETS}/ok.glb`]: { body: big },
    'https://elsewhere.example/endless.vrm': { stream: 1024 * 1024 },
  })
  const loader = makeLoader()
  await assert.rejects(loader.load('script', 'asset://declared.js'), /larger than/)
  await assert.rejects(loader.load('script', 'asset://large.js'), /larger than/) // scripts: 2 MiB
  assert.equal((await loader.load('model', 'asset://ok.glb')) != null, true) // models: 64 MiB
  await assert.rejects(loader.load('avatar', 'https://elsewhere.example/endless.vrm'), /larger than/)
})

test('files and results from outside the world’s store are bounded; the world’s own are kept', async t => {
  fakeNetwork(t, url => ({ body: `// ${url}` }))
  const loader = makeLoader()
  for (let i = 0; i < 40; i++) await loader.load('script', `asset://own-${i}.js`)
  for (let i = 0; i < 300; i++) await loader.load('script', `https://elsewhere.example/${i}.js`)
  assert.equal(loader.hasFile('asset://own-0.js'), true)
  assert.equal(loader.hasFile('asset://own-39.js'), true)
  assert.equal(loader.hasFile('https://elsewhere.example/0.js'), false)
  assert.equal(loader.hasFile('https://elsewhere.example/299.js'), true)
  const remoteFiles = [...loader.files.keys()].filter(url => url.startsWith('https://elsewhere')).length
  assert.ok(remoteFiles <= 16, `remote files kept: ${remoteFiles}`)
  const remoteResults = [...loader.results.keys()].filter(key => key.includes('elsewhere')).length
  assert.ok(remoteResults <= 128, `remote results kept: ${remoteResults}`)
  assert.equal(loader.has('script', 'https://elsewhere.example/0.js'), false)
  assert.equal(loader.has('script', 'https://elsewhere.example/299.js'), true)
  for (let i = 0; i < 40; i++) assert.equal(loader.has('script', `asset://own-${i}.js`), true)
  // one in use stays recent
  await loader.load('script', 'https://elsewhere.example/200.js')
  for (let i = 300; i < 420; i++) await loader.load('script', `https://elsewhere.example/${i}.js`)
  assert.equal(loader.has('script', 'https://elsewhere.example/200.js'), true)
  assert.equal(loader.has('script', 'https://elsewhere.example/201.js'), false)
})

test('an image that cannot be decoded, or is larger than the pixel budget, is a failed load', async t => {
  fakeNetwork(t, url => ({ body: 'bytes', headers: { 'content-type': 'image/png' } }))
  const created = []
  const revoked = []
  const original = { Image: globalThis.Image, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  URL.createObjectURL = () => {
    created.push(`blob:${created.length}`)
    return created.at(-1)
  }
  URL.revokeObjectURL = url => revoked.push(url)
  let outcome
  globalThis.Image = class {
    set src(value) {
      this._src = value
      queueMicrotask(() => {
        if (outcome === 'error') return this.onerror?.()
        this.naturalWidth = outcome === 'huge' ? 20000 : 64
        this.naturalHeight = outcome === 'huge' ? 20000 : 64
        this.onload?.()
      })
    }
    get src() {
      return this._src
    }
  }
  t.after(() => {
    globalThis.Image = original.Image
    URL.createObjectURL = original.create
    URL.revokeObjectURL = original.revoke
  })
  const loader = makeLoader()
  outcome = 'error'
  await assert.rejects(loader.load('image', 'asset://broken.png'), /could not be decoded/)
  await assert.rejects(loader.load('texture', 'asset://broken2.png'), /could not be decoded/)
  outcome = 'huge'
  await assert.rejects(loader.load('image', 'asset://huge.png'), /larger than 36000000 pixels/)
  assert.equal(revoked.length, 3, 'failed decodes release their object URL')
  outcome = 'ok'
  const img = await loader.load('image', 'asset://ok.png')
  assert.equal(img.naturalWidth, 64)
  const texture = await loader.load('texture', 'asset://ok2.png')
  assert.equal(texture.isTexture, true)
  assert.equal(texture.image.naturalWidth, 64)
  // broken images are not kept either
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loader.has('image', 'asset://broken.png'), false)
})
