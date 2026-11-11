import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import { loadClient } from './lib/clientHarness.mjs'
import { png, pngChunk, jpeg, webp, gif } from './lib/imageBytes.mjs'
import { IMAGE_HEADER_BYTES, MAX_IMAGE_PIXELS, readImageHeader } from '../src/core/extras/imageHeader.js'
import { isDataURI } from '../src/core/extras/gltfLimits.js'

// The browser's loader with its real code and a fake network: what it accepts, refuses, keeps and forgets.
// The parsers are stand-ins the tests steer (test/clientLoaderGLTF.test.js runs the real GLTF parser).
let parseGLTF
let parseHDR
const hdrParses = []
const defaultParsers = () => {
  parseGLTF = buffer => ({ scene: new THREE.Group(), animations: [], bytes: buffer.byteLength })
  parseHDR = () => ({ data: new Uint16Array(4), width: 1, height: 1, type: THREE.HalfFloatType })
}
defaultParsers()

const ClientLoader = loadClient('core/systems/ClientLoader.js', 'ClientLoader', {
  THREE,
  RGBELoader: class {
    parse(buffer) {
      hdrParses.push(buffer.byteLength)
      return parseHDR(buffer)
    }
  },
  GLTFLoader: class {
    register() {}
    async parseAsync(buffer) {
      return parseGLTF(buffer)
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
  formatBytes: n => String(n),
  imageElementsPlugin: () => {},
  // the declared-size check runs for real in gltfLimits.test.js and clientLoaderGLTF.test.js; these bodies are not glTF
  checkGLTF: () => {},
  createGLTFBudget: () => null,
  GLTF_LIMITS: {},
  isDataURI,
  isAppleMobile: () => false,
  emoteUrls: [],
  Hls: class {},
  IMAGE_HEADER_BYTES,
  MAX_IMAGE_PIXELS,
  readImageHeader,
})

const ASSETS = 'https://world.example/assets'
const MiB = 1024 * 1024
const tick = () => new Promise(resolve => setImmediate(resolve))

// a fetch that answers from a table ({ status, body, headers, stream, response } per url) and records each request
// with its abort signal. data: and blob: URLs go to the real fetch
function fakeNetwork(t, table) {
  const requests = []
  const signals = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('data:') || url.startsWith('blob:')) return original(input, init)
    requests.push(url)
    signals.push(init?.signal)
    const entry = typeof table === 'function' ? table(url, requests.length) : table[url]
    if (!entry) return new Response('<html>not found</html>', { status: 404 })
    if (entry.response) return entry.response(init)
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
  requests.signals = signals
  return requests
}

// <img> decoding: `outcome` decides what the next image does; object URLs are counted
function fakeImages(t) {
  const state = { outcome: 'ok', created: [], revoked: [] }
  const original = { Image: globalThis.Image, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  URL.createObjectURL = () => {
    state.created.push(`blob:${state.created.length}`)
    return state.created.at(-1)
  }
  URL.revokeObjectURL = url => state.revoked.push(url)
  globalThis.Image = class {
    set src(value) {
      this._src = value
      queueMicrotask(() => {
        if (state.outcome === 'error') return this.onerror?.()
        const size = { huge: 20000, empty: 0, flat: 64 }[state.outcome] ?? 64
        this.naturalWidth = size
        this.naturalHeight = state.outcome === 'flat' ? 0 : size
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
  return state
}

function makeLoader({ uploadMB } = {}) {
  const world = {
    assetsUrl: ASSETS,
    network: { maxUploadSize: uploadMB },
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
  await tick()
  assert.equal(loader.has('script', 'asset://app.js'), false)
  fail = false
  assert.equal((await loader.load('script', 'asset://app.js')).code, '// ok')
  // and a successful one is kept
  const before = requests.length
  assert.equal((await loader.load('script', 'asset://app.js')).code, '// ok')
  assert.equal(requests.length, before)
  // a refused transfer is aborted, not left to run
  assert.ok(requests.signals.slice(0, 2).every(signal => signal.aborted))
})

test('the size limit: the upload limit (or the table, if larger) in the world’s own store, the table elsewhere, also for kept and inserted files', async t => {
  const three = new Uint8Array(3 * MiB)
  const five = new Uint8Array(5 * MiB)
  const requests = fakeNetwork(t, {
    [`${ASSETS}/declared.js`]: { body: 'x', headers: { 'content-length': String(50 * MiB) } },
    [`${ASSETS}/large.js`]: { body: three },
    [`${ASSETS}/huge.js`]: { body: five },
    [`${ASSETS}/older.glb`]: { body: five },
    'https://elsewhere.example/large.js': { body: three },
    'https://elsewhere.example/model.glb': { body: three },
    'https://elsewhere.example/endless.js': { stream: MiB },
  })
  // a 4 MB upload limit keeps the files of this test small; production's default is 12
  const loader = makeLoader({ uploadMB: 4 })
  // the world's store: a 3 MiB script that the 4 MB upload limit accepted loads (it used to fail after a reload)
  assert.equal((await loader.load('script', 'asset://large.js')).code.length, 3 * MiB)
  await assert.rejects(loader.load('script', 'asset://declared.js'), /larger than 4194304 bytes/)
  assert.equal(requests.signals.at(-1).aborted, true, 'a declared size over the limit aborts the transfer')
  await assert.rejects(loader.load('script', 'asset://huge.js'), /larger than 4194304 bytes/)
  // a model uploaded before the limit was lowered: the table's 64 MiB still applies to it
  assert.ok(await loader.load('model', 'asset://older.glb'))
  // elsewhere: the table (scripts 2 MiB, models and avatars 64 MiB), whether the size is real or endless
  await assert.rejects(loader.load('script', 'https://elsewhere.example/large.js'), /larger than 2097152 bytes/)
  await assert.rejects(loader.load('script', 'https://elsewhere.example/endless.js'), /larger than 2097152 bytes/)
  assert.equal(requests.signals.at(-1).aborted, true, 'an endless stream is aborted at the limit')
  // a file kept from a model load is checked again when the same url is loaded as a script, without a download
  assert.ok(await loader.load('model', 'https://elsewhere.example/model.glb'))
  const before = requests.length
  await assert.rejects(loader.load('script', 'https://elsewhere.example/model.glb'), /larger than 2097152 bytes/)
  // and one put there with setFile
  loader.setFile('https://elsewhere.example/set.js', new File([three], 'set.js'))
  await assert.rejects(loader.load('script', 'https://elsewhere.example/set.js'), /larger than 2097152 bytes/)
  assert.equal(requests.length, before)
  // a picked file above the upload limit fails its insert and is not kept
  await assert.rejects(loader.insert('script', 'asset://picked.js', new File([five], 'p.js')), /larger than/)
  assert.equal(loader.hasFile('asset://picked.js'), false)
  assert.equal(loader.has('script', 'asset://picked.js'), false)
  // with no upload limit known (the viewer, before the snapshot) the store's files may be up to 64 MiB
  const viewer = makeLoader()
  assert.equal(viewer.maxBytes('script', `${ASSETS}/x.js`), 64 * MiB)
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
  // one in use stays recent, whether it is asked for through load() or get()
  await loader.load('script', 'https://elsewhere.example/200.js')
  for (let i = 300; i < 360; i++) await loader.load('script', `https://elsewhere.example/${i}.js`)
  assert.ok(loader.get('script', 'https://elsewhere.example/250.js'))
  for (let i = 360; i < 420; i++) await loader.load('script', `https://elsewhere.example/${i}.js`)
  assert.equal(loader.has('script', 'https://elsewhere.example/200.js'), true)
  assert.equal(loader.has('script', 'https://elsewhere.example/250.js'), true)
  assert.equal(loader.has('script', 'https://elsewhere.example/251.js'), false)
  // the file cache is least recently used too: a file read again stays
  assert.ok(loader.getFile('https://elsewhere.example/404.js'))
  for (let i = 420; i < 435; i++) await loader.load('script', `https://elsewhere.example/${i}.js`)
  assert.equal(loader.hasFile('https://elsewhere.example/404.js'), true)
  assert.equal(loader.hasFile('https://elsewhere.example/405.js'), false)
})

test('own-store URLs that differ only in query or hash are one download, one file and one result', async t => {
  const requests = fakeNetwork(t, () => ({ body: 'bytes' }))
  const loader = makeLoader()
  const loads = []
  for (let i = 0; i < 300; i++) loads.push(loader.load('emote', `asset://emote.glb?i=${i}#h${i}`))
  const emotes = await Promise.all(loads)
  assert.equal(requests.length, 1)
  assert.equal(new Set(emotes).size, 1)
  assert.equal(loader.files.size, 1)
  assert.equal(loader.promises.size, 1)
  assert.equal(loader.results.size, 1)
  assert.equal(loader.remoteKeys.size, 0)
  // has/get/getFile/hasFile answer for any spelling of that resource, the resolved one and another host case too
  assert.equal(loader.has('emote', 'asset://emote.glb?s=2'), true)
  assert.equal(loader.get('emote', 'asset://emote.glb'), emotes[0])
  assert.equal(loader.get('emote', 'HTTPS://World.Example/assets/emote.glb?x'), emotes[0])
  assert.equal(loader.hasFile('asset://emote.glb#x'), true)
  assert.equal(loader.getFile('asset://emote.glb?y=1', 'mine.glb').name, 'mine.glb')
  assert.equal(loader.getFile('asset://emote.glb').name, 'emote.glb')
  // setFile and insert file under the same key, and load reads from them
  loader.setFile('asset://set.js?v=1', new File(['// set'], 'set.js'))
  assert.equal(loader.hasFile('asset://set.js'), true)
  assert.equal((await loader.load('script', 'asset://set.js?v=2')).code, '// set')
  const inserted = loader.insert('script', 'asset://picked.js?v=1', new File(['// picked'], 'picked.js'))
  assert.equal(loader.has('script', 'asset://picked.js'), true)
  assert.equal(await loader.load('script', 'asset://picked.js#a'), await inserted)
  assert.equal(await (await loader.loadFile('asset://picked.js?v=3')).text(), '// picked')
  // an inserted file is read by later loads of another kind, too
  await loader.insert('model', 'asset://picked.glb', new File(['glb'], 'picked.glb'))
  assert.ok(await loader.load('emote', 'asset://picked.glb?s=2'))
  assert.equal(requests.length, 1)
  // a url outside the store keeps its query: those can be different resources
  await loader.load('script', 'https://elsewhere.example/a.js?v=1')
  await loader.load('script', 'https://elsewhere.example/a.js?v=2')
  assert.equal(requests.length, 3)
})

test('the world’s own store is recognised by parsed origin and path', () => {
  const loader = makeLoader()
  for (const url of [
    'https://world.example/assets/x.glb',
    'HTTPS://World.EXAMPLE/assets/x.glb',
    'https://world.example:443/assets/x.glb',
    'https://world.example/assets/sub/../x.glb?q#h',
  ]) {
    assert.equal(loader.isOwnAsset(url), true, url)
    assert.equal(loader.resourceURL(url), 'https://world.example/assets/x.glb', url)
  }
  for (const url of [
    'https://world.example/assets-old/x.glb',
    'https://world.example/x/assets/x.glb',
    'https://world.example/assets/../x.glb',
    'https://world.example.evil/assets/x.glb',
    'http://world.example/assets/x.glb',
    'blob:https://world.example/assets/x',
    'data:text/plain,assets',
    'https://world.example/assets',
  ]) {
    assert.equal(loader.isOwnAsset(url), false, url)
  }
  // a relative assets URL, and one with a trailing slash
  loader.world.assetsUrl = '/assets'
  loader.world.resolveURL = url => (url.startsWith('asset://') ? url.replace('asset:/', '/assets') : url)
  assert.equal(loader.isOwnAsset('/assets/x.glb'), true)
  assert.equal(loader.resourceURL('asset://x.glb?s=1'), 'http://localhost/assets/x.glb')
  assert.equal(loader.isOwnAsset('https://elsewhere.example/assets/x.glb'), false)
  loader.world.assetsUrl = 'https://world.example/assets/'
  assert.equal(loader.isOwnAsset('https://world.example/assets/x.glb'), true)
  loader.world.assetsUrl = null
  assert.equal(loader.isOwnAsset('https://world.example/assets/x.glb'), false)
})

test('loads in progress are not dropped by the bound, and a dropped or replaced request never writes its result', async t => {
  const gates = new Map()
  fakeNetwork(t, url => ({
    response: () => new Promise(resolve => gates.set(url, () => resolve(new Response(`// ${url.split('/').pop()}`)))),
  }))
  const loader = makeLoader()
  // the transfer pool and the request cap have tests of their own: here all 300 run at once
  loader.pools.remote.limit = 1000
  loader.remoteRequestLimit = 1000
  const loads = []
  for (let i = 0; i < 300; i++) loads.push(loader.load('script', `https://elsewhere.example/${i}.js`))
  await tick()
  // all 300 in progress: none was dropped, so every caller's request is the one filed
  assert.equal(loader.promises.size, 300)
  assert.equal(loader.pending.size, 300)
  for (const release of gates.values()) release()
  const scripts = await Promise.all(loads)
  scripts.forEach((script, i) => assert.equal(script.code, `// ${i}.js`))
  assert.ok(loader.promises.size <= 128, `promises: ${loader.promises.size}`)
  assert.ok(loader.results.size <= 128, `results: ${loader.results.size}`)
  assert.equal(loader.pending.size, 0)
  for (const key of loader.results.keys()) assert.ok(loader.promises.has(key), key)
  for (let i = 0; i < 300; i++) {
    const url = `https://elsewhere.example/${i}.js`
    if (loader.get('script', url)) assert.equal(loader.has('script', url), true, url)
  }
  // an insert while a download of the same url is in flight: the download's late result and file do not replace it
  gates.clear()
  const slow = loader.load('script', 'asset://slow.js')
  await tick()
  await loader.insert('script', 'asset://slow.js', new File(['// picked'], 'slow.js'))
  gates.get(`${ASSETS}/slow.js`)()
  assert.equal((await slow).code, '// slow.js', 'the caller still gets what it asked for')
  assert.equal(loader.get('script', 'asset://slow.js').code, '// picked')
  assert.equal(await loader.getFile('asset://slow.js').text(), '// picked')
})

test('an image that cannot be decoded, or is larger than the pixel budget, is a failed load; object URLs are released', async t => {
  fakeNetwork(t, () => ({ body: 'bytes', headers: { 'content-type': 'image/png' } }))
  const images = fakeImages(t)
  const loader = makeLoader()
  images.outcome = 'error'
  await assert.rejects(loader.load('image', 'asset://broken.png'), /could not be decoded/)
  await assert.rejects(loader.load('texture', 'asset://broken2.png'), /could not be decoded/)
  images.outcome = 'huge'
  await assert.rejects(loader.load('image', 'asset://huge.png'), /larger than 36000000 pixels/)
  assert.equal(images.revoked.length, 3, 'failed decodes release their object URL')
  // no intrinsic width or height
  images.outcome = 'empty'
  await assert.rejects(loader.load('image', 'asset://empty.svg'), /no width or height/)
  images.outcome = 'flat'
  await assert.rejects(loader.load('texture', 'asset://flat.svg'), /no width or height/)
  images.outcome = 'ok'
  const img = await loader.load('image', 'asset://ok.png')
  assert.equal(img.naturalWidth, 64)
  const texture = await loader.load('texture', 'asset://ok2.png')
  assert.equal(texture.isTexture, true)
  assert.equal(texture.image.naturalWidth, 64)
  // a decoded image does not need its URL (nothing reads its src): a registered URL would keep the bytes alive
  for (let i = 0; i < 20; i++) await loader.load('image', `https://elsewhere.example/${i}.png`)
  await loader.insert('image', 'asset://picked.png', new File(['bytes'], 'picked.png'))
  await loader.insert('texture', 'asset://picked2.png', new File(['bytes'], 'picked2.png'))
  assert.equal(images.created.length, 29)
  assert.deepEqual(images.revoked.toSorted(), images.created.toSorted())
  // broken images are not kept either
  await tick()
  assert.equal(loader.has('image', 'asset://broken.png'), false)
})

test('a PNG, JPEG or WebP is refused from its header before it is decoded; other formats go to the browser', async t => {
  const images = fakeImages(t)
  // a JPEG whose start of frame comes after 325 KB of segments: past the first bytes read, so the file is read whole
  const late = jpeg(20000, 20000, {
    before: [
      [0xe1, 65000],
      [0xe2, 65000],
      [0xe2, 65000],
      [0xe2, 65000],
      [0xe2, 65000],
    ],
  })
  const files = {
    'huge.png': png(100000, 100000),
    'huge.jpg': jpeg(9000, 5000, { sof: 0xc2 }),
    'huge.webp': webp(100000, 1000, 'animated', { frames: [[16000, 1000, 0, 0]] }),
    'late.jpg': late,
    'empty.png': png(0, 100),
    'small.png': png(64, 64),
    'other.gif': gif(30000, 30000),
    // a 1 x 1 frame header in front of the real one: decoders disagree, so it is refused, not passed to one
    'double.jpg': jpeg(9000, 9000, {
      frames: [
        [1, 1],
        [9000, 9000],
      ],
    }),
    'second-ihdr.png': png(10, 10, { before: [pngChunk('IHDR', [0, 0, 0x40, 0, 0, 0, 0x40, 0, 8, 6, 0, 0, 0])] }),
    // a colour profile longer than the first bytes read: the whole file is read, then the size checked
    'profiled.png': png(9000, 9000, { before: [pngChunk('iCCP', new Array(300000).fill(0))] }),
    'cut.png': png(64, 64).subarray(0, 30),
  }
  fakeNetwork(t, url => (files[url.split('/').pop()] ? { body: files[url.split('/').pop()] } : null))
  const loader = makeLoader()
  for (const [name, reason] of [
    ['huge.png', /larger than 36000000 pixels/],
    ['huge.jpg', /larger than 36000000 pixels/],
    ['huge.webp', /larger than 36000000 pixels/],
    ['late.jpg', /larger than 36000000 pixels/],
    ['empty.png', /no width or height/],
    ['double.jpg', /malformed jpeg \(more than one frame header\)/],
    ['second-ihdr.png', /malformed png \(a second IHDR\)/],
    ['profiled.png', /larger than 36000000 pixels/],
    ['cut.png', /png cut short/],
  ]) {
    await assert.rejects(loader.load('image', `asset://${name}`), reason, `image ${name}`)
    await assert.rejects(loader.load('texture', `https://elsewhere.example/${name}`), reason, `texture ${name}`)
  }
  await assert.rejects(
    loader.insert('image', 'asset://picked.png', new File([png(100000, 100000)], 'p.png')),
    /larger than/
  )
  await assert.rejects(
    loader.insert('texture', 'asset://picked.jpg', new File([jpeg(10000, 9000)], 'p.jpg')),
    /larger than/
  )
  assert.equal(images.created.length, 0, 'none of them reached the decoder')
  // a PNG within the budget is decoded; a GIF (no header reader) goes to the browser, which checks what it decoded
  assert.equal((await loader.load('image', 'asset://small.png')).naturalWidth, 64)
  images.outcome = 'huge'
  await assert.rejects(loader.load('image', 'asset://other.gif'), /larger than 36000000 pixels/)
  assert.equal(images.created.length, 2)
})

test('insert(): a picked file is validated and decoded as a download is, and a failure is not kept', async t => {
  const images = fakeImages(t)
  const loader = makeLoader({ uploadMB: 12 })
  images.outcome = 'error'
  // a broken image used to leave the inserted load pending for ever
  await assert.rejects(loader.insert('image', 'asset://picked.png', new File(['x'], 'p.png')), /could not be decoded/)
  assert.equal(loader.has('image', 'asset://picked.png'), false)
  assert.equal(loader.hasFile('asset://picked.png'), false)
  images.outcome = 'huge'
  await assert.rejects(loader.insert('texture', 'asset://huge.png', new File(['x'], 'h.png')), /pixels/)
  assert.equal(loader.has('texture', 'asset://huge.png'), false)
  // a model that does not parse, and an HDR whose header is refused
  parseGLTF = () => {
    throw new Error('truncated GLB')
  }
  t.after(defaultParsers)
  await assert.rejects(loader.insert('model', 'asset://bad.glb', new File(['x'], 'bad.glb')), /truncated/)
  assert.equal(loader.has('model', 'asset://bad.glb'), false)
  assert.equal(loader.hasFile('asset://bad.glb'), false)
  const hdr = new File(['#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1000000000 +X 8\n'], 'sky.hdr')
  await assert.rejects(loader.insert('hdr', 'asset://sky.hdr', hdr), /larger than 36000000 pixels/)
  // and a good one is kept and served to later loads
  images.outcome = 'ok'
  const img = await loader.insert('image', 'asset://good.png', new File(['x'], 'g.png'))
  assert.equal(await loader.load('image', 'asset://good.png'), img)
  assert.equal(loader.get('image', 'asset://good.png'), img)
})

test('bytes that do not parse are not kept: the next load downloads them again; a newer insert stays', async t => {
  let version = 'broken'
  const requests = fakeNetwork(t, url => ({ body: url.endsWith('/n.glb') ? 'broken-slow' : version }))
  let release
  const gate = new Promise(resolve => (release = resolve))
  parseGLTF = async buffer => {
    const text = new TextDecoder().decode(buffer)
    if (text === 'broken-slow') await gate
    if (text.startsWith('broken')) throw new Error('truncated GLB')
    return { scene: new THREE.Group(), animations: [] }
  }
  t.after(defaultParsers)
  const loader = makeLoader()
  await assert.rejects(loader.load('model', 'asset://m.glb'), /truncated/)
  assert.equal(loader.hasFile('asset://m.glb'), false)
  version = 'fixed'
  assert.ok(await loader.load('model', 'asset://m.glb'))
  assert.equal(requests.length, 2)
  // the same for a script that does not evaluate
  loader.world.scripts.evaluate = code => {
    if (code === 'fixed') throw new SyntaxError('Unexpected token')
    return { code }
  }
  await assert.rejects(loader.load('script', 'asset://s.js'), /Unexpected token/)
  assert.equal(loader.hasFile('asset://s.js'), false)
  // while a load of n.glb is parsing, the user picks a new file for that url: the old failure leaves it alone
  const failing = loader.load('model', 'asset://n.glb')
  while (!loader.hasFile('asset://n.glb')) await tick()
  const picked = new File(['good'], 'n.glb')
  await loader.insert('emote', 'asset://n.glb', picked)
  release()
  await assert.rejects(failing, /truncated/)
  assert.equal(loader.getFile('asset://n.glb'), picked)
})

test('a transfer that stalls, runs too long, or cannot be counted is abandoned and aborted', async t => {
  const stalled = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1))
    },
    pull: () => new Promise(() => {}), // and it ignores the abort, as a broken transport might
  })
  const trickle = init =>
    new ReadableStream({
      pull: controller =>
        new Promise(resolve =>
          setTimeout(() => {
            try {
              if (init.signal.aborted) controller.close()
              else controller.enqueue(new Uint8Array(1))
            } catch {
              // cancelled by the reader meanwhile
            }
            resolve()
          }, 5)
        ),
    })
  const noReader = length => () => ({
    ok: true,
    status: 200,
    headers: new Headers(length === undefined ? {} : { 'content-length': String(length) }),
    body: {},
    blob: async () => new Blob(['// whole']),
  })
  const requests = fakeNetwork(t, {
    'https://elsewhere.example/stalled.glb': { response: () => new Response(stalled) },
    'https://elsewhere.example/silent.glb': { response: () => new Promise(() => {}) },
    'https://elsewhere.example/trickle.glb': { response: init => new Response(trickle(init)) },
    'https://elsewhere.example/unknown.js': { response: noReader(undefined) },
    'https://elsewhere.example/stated.js': { response: noReader(8) },
    'https://elsewhere.example/overstated.js': { response: noReader(3 * MiB) },
  })
  const loader = makeLoader()
  loader.stallMs = 40
  loader.downloadMs = 2000
  await assert.rejects(loader.load('model', 'https://elsewhere.example/stalled.glb'), /stalled: no data/)
  assert.equal(requests.signals.at(-1).aborted, true)
  // no response at all (headers never arrive)
  await assert.rejects(loader.load('model', 'https://elsewhere.example/silent.glb'), /stalled: no data/)
  assert.equal(requests.signals.at(-1).aborted, true)
  // bytes keep coming, slowly, for longer than the overall deadline
  loader.stallMs = 1000
  loader.downloadMs = 80
  await assert.rejects(loader.load('model', 'https://elsewhere.example/trickle.glb'), /longer than 0.08 s/)
  assert.equal(requests.signals.at(-1).aborted, true)
  // no body stream: only a stated length within the limit is read whole
  loader.downloadMs = 2000
  await assert.rejects(loader.load('script', 'https://elsewhere.example/unknown.js'), /no length and no stream/)
  assert.equal(requests.signals.at(-1).aborted, true)
  await assert.rejects(loader.load('script', 'https://elsewhere.example/overstated.js'), /larger than 2097152/)
  assert.equal((await loader.load('script', 'https://elsewhere.example/stated.js')).code, '// whole')
  // nothing of the abandoned ones is kept
  assert.equal(loader.promises.size, 1)
  assert.equal(loader.pending.size, 0)
})

// a Radiance file: header lines, then `pixel` bytes
const hdrFile = (...lines) => new TextEncoder().encode(`${lines.join('\n')}\npixels`)
const HDR_FORMAT = 'FORMAT=32-bit_rle_rgbe'

test('an HDR is refused from its header, before the parser allocates its pixels', async t => {
  const files = {
    'tall.hdr': hdrFile('#?RADIANCE', HDR_FORMAT, '', '-Y 1000000000 +X 8'),
    'other-orientation.hdr': hdrFile('#?RADIANCE', HDR_FORMAT, '', '+X 8 -Y 1000000000'),
    'zero.hdr': hdrFile('#?RADIANCE', HDR_FORMAT, '', '-Y 0 +X 8'),
    'endless-digits.hdr': hdrFile('#?RADIANCE', HDR_FORMAT, '', `-Y ${'9'.repeat(30)} +X 1`),
    'same-axis.hdr': hdrFile('#?RADIANCE', HDR_FORMAT, '', '-Y 8 +Y 8'),
    // the parser takes the last -Y/+X line before it has seen FORMAT too
    'late.hdr': hdrFile('#?RADIANCE', '-Y 8 +X 8', '-Y 1000000000 +X 8', HDR_FORMAT),
    'no-magic.hdr': hdrFile(HDR_FORMAT, '', '-Y 8 +X 8'),
    'no-size.hdr': hdrFile('#?RADIANCE', HDR_FORMAT, ''),
    'long-header.hdr': hdrFile('#?RADIANCE', ...Array(3000).fill('# padding padding padding'), HDR_FORMAT, '-Y 8 +X 8'),
    // a comment is not the size, and the parser stops at the first complete header
    'commented.hdr': hdrFile('#?RADIANCE', '# -Y 1000000000 +X 8', HDR_FORMAT, '', '-Y 16 +X 32\r'),
    'stops.hdr': hdrFile('#?RGBE', HDR_FORMAT, '-Y 16 +X 32', '-Y 1000000000 +X 8'),
    'reparsed.hdr': hdrFile('#?RADIANCE', HDR_FORMAT, '', '-Y 16 +X 32'),
  }
  fakeNetwork(t, url => {
    const name = url.split('/').pop()
    if (name === 'day2.hdr') return { body: fs.readFileSync(new URL('../src/client/public/day2.hdr', import.meta.url)) }
    return files[name] ? { body: files[name] } : null
  })
  const loader = makeLoader()
  hdrParses.length = 0
  for (const [name, reason] of [
    ['tall.hdr', /larger than 36000000 pixels/],
    ['other-orientation.hdr', /larger than 36000000 pixels/],
    ['zero.hdr', /positive whole numbers/],
    ['endless-digits.hdr', /positive whole numbers/],
    ['same-axis.hdr', /positive whole numbers/],
    ['late.hdr', /larger than 36000000 pixels/],
    ['no-magic.hdr', /not a Radiance HDR file/],
    ['no-size.hdr', /no size and format/],
    ['long-header.hdr', /no size and format/],
  ]) {
    await assert.rejects(loader.load('hdr', `asset://${name}`), reason, name)
  }
  assert.equal(hdrParses.length, 0, 'the parser never ran on a refused header')
  for (const name of ['commented.hdr', 'stops.hdr', 'day2.hdr']) {
    assert.equal((await loader.load('hdr', `asset://${name}`)).isDataTexture, true, name)
  }
  assert.equal(hdrParses.length, 3)
  // what the parser reports is checked again
  parseHDR = () => ({ data: new Uint16Array(4), width: 10000, height: 10000, type: THREE.HalfFloatType })
  t.after(defaultParsers)
  await assert.rejects(loader.load('hdr', 'asset://reparsed.hdr'), /larger than 36000000 pixels/)
})

test('a model, avatar or emote with a texture above the pixel budget is refused, and what the parser made is released', async t => {
  fakeNetwork(t, () => ({ body: 'glb' }))
  const disposed = []
  const watch = object => {
    object.addEventListener('dispose', () => disposed.push(object))
    return object
  }
  // a parsed file with one texture per image given, on a standard material slot, a shader material's uniform
  // (as three-vrm's MToon keeps them) and a material in the file's second scene
  const parsedFile = images => () => {
    const textures = images.map(image => watch(new THREE.Texture(image)))
    const geometry = watch(new THREE.BoxGeometry())
    const standard = watch(new THREE.MeshStandardMaterial({ map: textures[0] }))
    const shader = watch(new THREE.ShaderMaterial({ uniforms: { shadeMultiplyTexture: { value: textures[1] } } }))
    const scene = new THREE.Group()
    scene.add(new THREE.Mesh(geometry, [standard, shader]))
    const second = new THREE.Group()
    second.add(new THREE.Mesh(watch(new THREE.BoxGeometry()), watch(new THREE.MeshBasicMaterial({ map: textures[2] }))))
    return { scene, scenes: [scene, second], animations: [], textures }
  }
  const closed = []
  const bitmap = (width, height) => ({ width, height, close: () => closed.push(width) })
  // the <img> path (iPhone and iPad): its size is the natural one
  const element = (naturalWidth, naturalHeight) => ({ naturalWidth, naturalHeight, width: 0, height: 0 })
  const small = () => bitmap(1024, 1024)
  t.after(defaultParsers)
  const loader = makeLoader()
  for (const [type, images] of [
    ['model', [bitmap(20000, 20000), small(), small()]],
    ['avatar', [small(), element(8000, 8000), small()]],
    ['emote', [small(), small(), bitmap(6001, 6000)]],
  ]) {
    disposed.length = 0
    closed.length = 0
    parseGLTF = parsedFile(images)
    await assert.rejects(loader.load(type, `asset://big.${type}`), /texture in the file is larger than 36000000 pixels/)
    assert.equal(closed.length, images.filter(image => image.close).length, `${type}: its image bitmaps are closed`)
    assert.equal(disposed.filter(object => object.isTexture).length, 3, `${type}: textures disposed`)
    assert.equal(disposed.filter(object => object.isMaterial).length, 3, `${type}: materials disposed`)
    assert.equal(disposed.filter(object => object.isBufferGeometry).length, 2, `${type}: geometries disposed`)
  }
  // within the budget (6000 x 6000 is exactly it)
  parseGLTF = parsedFile([bitmap(6000, 6000), element(4096, 4096), small()])
  disposed.length = 0
  assert.ok(await loader.load('model', 'asset://fits.glb'))
  assert.equal(disposed.length, 0)
})

test('video loads from outside the store are kept under the same bound; the store’s are one per resource', async () => {
  const loader = makeLoader()
  for (let i = 0; i < 300; i++) await loader.load('video', `https://elsewhere.example/${i}.mp4`)
  assert.ok(loader.promises.size <= 128, `promises: ${loader.promises.size}`)
  assert.ok(loader.remoteKeys.size <= 128)
  assert.equal(loader.has('video', 'https://elsewhere.example/0.mp4'), false)
  assert.equal(loader.has('video', 'https://elsewhere.example/299.mp4'), true)
  assert.ok(loader.get('video', 'https://elsewhere.example/299.mp4').get)
  const a = await loader.load('video', 'asset://clip.mp4?t=1')
  assert.equal(await loader.load('video', 'asset://clip.mp4?t=2'), a)
})

// a response whose body arrives only when the test lets it: { response, release, pulls }
function gatedBody(bytes, headers = {}) {
  let release
  const gate = new Promise(resolve => (release = resolve))
  const state = { pulls: 0, release: () => release() }
  state.response = init =>
    new Response(
      new ReadableStream(
        {
          async pull(controller) {
            state.pulls++
            await gate
            if (init?.signal?.aborted) return controller.close()
            controller.enqueue(new Uint8Array(bytes))
            controller.close()
          },
        },
        { highWaterMark: 0 }
      ), // pulled only when the loader reads
      { headers }
    )
  return state
}

test('transfers are bounded: four from other hosts at once, 256 waiting or running, then a load fails at once', async t => {
  const gates = []
  let open = 0
  let most = 0
  const requests = fakeNetwork(t, url => {
    if (url.startsWith(ASSETS)) return { body: '// own' }
    return {
      response: () => {
        most = Math.max(most, ++open)
        return new Promise(resolve =>
          gates.push(() => {
            open--
            resolve(new Response('// x'))
          })
        )
      },
    }
  })
  const loader = makeLoader()
  const loads = []
  for (let i = 0; i < 300; i++) loads.push(loader.load('script', `https://elsewhere.example/${i}.js`))
  const settled = Promise.allSettled(loads)
  await tick()
  assert.equal(requests.length, 4, 'only the pool’s downloads are open; the others wait without one')
  assert.equal(loader.promises.size, 256)
  assert.equal(loader.remoteRequests, 256)
  const refused = await Promise.allSettled(loads.slice(256))
  for (const result of refused) {
    assert.equal(result.status, 'rejected')
    assert.match(result.reason.message, /too many downloads from other hosts at once \(256\)/)
    assert.equal(result.reason.code, 'LOADER_BUSY', 'marked as a refusal for being busy, which a player retries once')
  }
  assert.equal(loader.has('script', 'https://elsewhere.example/256.js'), false, 'a refused load is not kept')
  // the world's own assets are not capped in number, and do not wait for the outside pool
  const own = await Promise.all(Array.from({ length: 300 }, (_, i) => loader.load('script', `asset://own-${i}.js`)))
  assert.equal(own.length, 300)
  // as downloads finish the queued ones start, never more than four at once
  for (let round = 0; round < 100 && gates.length; round++) {
    gates.splice(0).forEach(release => release())
    await tick()
  }
  assert.ok((await settled).slice(0, 256).every(result => result.status === 'fulfilled'))
  assert.equal(most, 4)
  assert.equal(requests.filter(url => url.startsWith('https://elsewhere')).length, 256)
  assert.equal(loader.remoteRequests, 0)
  assert.equal(loader.pools.remote.active, 0)
  assert.equal(loader.pools.own.active, 0)
  assert.equal(loader.pending.size, 0)
})

test('own-store loads proceed while stalled transfers from other hosts hold their pool; destroy() ends those', async t => {
  const signals = []
  fakeNetwork(
    t,
    url =>
      url.startsWith(ASSETS)
        ? { body: '// own' }
        : { response: init => (signals.push(init.signal), new Promise(() => {})) } // headers never arrive
  )
  const loader = makeLoader()
  const outside = Array.from({ length: 6 }, (_, i) => loader.load('model', `https://elsewhere.example/${i}.glb`))
  await tick()
  assert.equal(loader.pools.remote.active, 4)
  assert.equal(loader.pools.remote.queue.length, 2)
  const own = await Promise.all(Array.from({ length: 20 }, (_, i) => loader.load('script', `asset://s-${i}.js`)))
  assert.equal(own.length, 20)
  loader.destroy()
  const ended = await Promise.allSettled(outside)
  for (const result of ended) {
    assert.equal(result.status, 'rejected')
    assert.match(result.reason.message, /destroyed/)
  }
  assert.equal(signals.length, 4)
  assert.ok(
    signals.every(signal => signal.aborted),
    'active transfers are aborted'
  )
  assert.equal(loader.remoteRequests, 0)
  assert.equal(loader.pools.remote.queue.length, 0)
})

test('the deadlines of a download start when it does: waiting in the queue is neither a stall nor overtime', async t => {
  // a body of twelve chunks, one every 50 ms: 600 ms in all, never 500 ms without data (ten times the gap)
  const trickle = () => {
    let sent = 0
    return new Response(
      new ReadableStream(
        {
          async pull(controller) {
            await new Promise(resolve => setTimeout(resolve, 50))
            controller.enqueue(new Uint8Array(10))
            if (++sent === 12) controller.close()
          },
        },
        { highWaterMark: 0 }
      )
    )
  }
  fakeNetwork(t, () => ({ response: trickle }))
  const loader = makeLoader()
  loader.pools.remote.limit = 1
  loader.stallMs = 500
  loader.downloadMs = 1000
  // the second waits about 600 ms for the first (more than stallMs), and the two take about 1200 ms (more than
  // downloadMs): both complete, since each one's deadlines start with its own transfer
  const started = Date.now()
  const first = loader.load('script', 'https://elsewhere.example/1.js')
  const second = loader.load('script', 'https://elsewhere.example/2.js')
  const scripts = await Promise.all([first, second])
  assert.ok(Date.now() - started > 1000, `${Date.now() - started} ms`)
  assert.deepEqual(
    scripts.map(script => script.code.length),
    [120, 120]
  )
})

test('a queued download is filed when it is asked for: a file put while it waits is the one used, not overwritten', async t => {
  const gates = []
  const requests = fakeNetwork(t, url => ({
    response: () => new Promise(resolve => gates.push(() => resolve(new Response(`old ${url.split('/').pop()}`)))),
  }))
  const loader = makeLoader()
  loader.pools.remote.limit = 1
  // the pool is held by another download; a loadFile and a load of the same url wait behind it
  const holder = loader.load('script', 'https://elsewhere.example/holder.js')
  await tick()
  const queued = loader.loadFile('https://elsewhere.example/m.js')
  const queuedLoad = loader.load('script', 'https://elsewhere.example/n.js')
  await tick()
  const newer = new File(['// newer'], 'm.js')
  loader.setFile('https://elsewhere.example/m.js', newer)
  loader.setFile('https://elsewhere.example/n.js', new File(['// newer n'], 'n.js'))
  gates.shift()()
  await holder
  // after the slot is granted the cache is read again: the newer files are used, nothing is downloaded
  assert.equal(await queued, newer)
  assert.equal((await queuedLoad).code, '// newer n')
  assert.deepEqual([...requests], ['https://elsewhere.example/holder.js'])
  assert.equal(loader.getFile('https://elsewhere.example/m.js'), newer)
  // a download already running when a newer file is put does not overwrite it either
  const running = loader.loadFile('https://elsewhere.example/r.js')
  while (gates.length === 0) await tick()
  const picked = new File(['// picked'], 'r.js')
  loader.setFile('https://elsewhere.example/r.js', picked)
  gates.shift()()
  assert.equal(await (await running).text(), 'old r.js', 'the caller gets what it downloaded')
  assert.equal(loader.getFile('https://elsewhere.example/r.js'), picked)
})

test('a request from before destroy() does not join the next lifecycle: it fails before it takes a slot', async t => {
  const gates = []
  const requests = fakeNetwork(t, url =>
    url.endsWith('/held.js')
      ? { response: () => new Promise(resolve => gates.push(() => resolve(new Response('// held')))) }
      : { body: '// x' }
  )
  const loader = makeLoader()
  loader.pools.own.limit = 1
  const holder = loader.loadFile('asset://hold.js')
  // asked for before destroy(); the load's work starts only after it
  const before = [loader.load('script', 'asset://a.js'), loader.loadFile('asset://b.js')]
  loader.destroy()
  // the next lifecycle's only slot is taken at once by a download that waits
  loader.pools.own.limit = 1
  const held = loader.loadFile('asset://held.js')
  // the old requests fail at once instead of queueing behind it
  const settled = await Promise.race([
    Promise.allSettled(before),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 1000)),
  ])
  assert.notEqual(settled, 'still waiting', 'an old request joined the new queue')
  for (const result of settled) {
    assert.equal(result.status, 'rejected')
    assert.match(result.reason.message, /destroyed/)
  }
  await holder.catch(() => {})
  while (gates.length === 0) await tick()
  gates.shift()()
  assert.equal(await (await held).text(), '// held')
  assert.equal((await loader.load('script', 'asset://c.js')).code, '// x')
  assert.ok(!requests.includes(`${ASSETS}/a.js`) && !requests.includes(`${ASSETS}/b.js`))
})

test('a download that finishes after a newer file was put for its url, or after destroy(), does not write its file', async t => {
  const bodies = { m: gatedBody(3), s: gatedBody(3), d: gatedBody(3) }
  const signals = {}
  fakeNetwork(t, url => {
    const name = url.split('/').pop().split('.')[0]
    return { response: init => ((signals[name] = init.signal), bodies[name].response(init)) }
  })
  const loader = makeLoader()
  // an old model download; the user picks a newer file too large to keep (above 16 MiB; 1 KB here, to keep the
  // test small), then the old download finishes: its bytes do not come back as the url's file
  loader.remoteFileMaxBytes = 1024
  const old = loader.load('model', 'https://elsewhere.example/m.glb')
  while (bodies.m.pulls === 0) await tick()
  await loader.insert('model', 'https://elsewhere.example/m.glb', new File([new Uint8Array(2048)], 'm.glb'))
  bodies.m.release()
  await old
  assert.equal(loader.getFile('https://elsewhere.example/m.glb'), null)
  // setFile while a download of the same url runs
  const download = loader.loadFile('https://elsewhere.example/s.js')
  while (bodies.s.pulls === 0) await tick()
  const newer = new File(['// newer'], 's.js')
  loader.setFile('https://elsewhere.example/s.js', newer)
  bodies.s.release()
  assert.equal((await download).size, 3, 'the caller gets what it downloaded')
  assert.equal(loader.getFile('https://elsewhere.example/s.js'), newer)
  // destroy() while a download runs: it is aborted, and a late body writes nothing
  const late = loader.load('model', 'asset://d.glb')
  while (bodies.d.pulls === 0) await tick()
  loader.destroy()
  assert.equal(signals.d.aborted, true)
  bodies.d.release()
  await assert.rejects(late, /destroyed/)
  await tick()
  assert.equal(loader.files.size, 0)
  assert.equal(loader.promises.size, 0)
  assert.equal(loader.results.size, 0)
  // a load asked for just before destroy() reaches its transfer after it: it does not start one
  const before = Object.keys(signals).length
  const resumed = loader.load('model', 'asset://m2.glb')
  loader.destroy()
  await assert.rejects(resumed, /destroyed/)
  assert.equal(Object.keys(signals).length, before, 'nothing was fetched')
  assert.equal(loader.files.size, 0)
})
