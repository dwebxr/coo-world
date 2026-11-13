// What a dropped .hyp file puts in the builder's loader (ClientBuilder.addApp, importApp in appTools.js). A .hyp file
// carries its assets' bytes, each under a url its header gives. Every asset used to be put in the dropper's loader
// under that url, so a file made by anyone could make the dropper's client show its bytes wherever that address is
// loaded (another app's model or script, the default avatar, an emote, an https URL), until a reload. Now an asset
// whose url is the address of an upload (asset://<sha256>.<ext>) must hold the bytes that hash names, or the file is
// refused, and only such assets, of a kind a blueprint loads, are cached and uploaded; any other reference is kept as
// it is and loads from its own address. The real importApp, ClientBuilder.addApp and ClientLoader run here; the
// parsers and decoders are stand-ins that say which bytes they were given.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import nodeCrypto from 'node:crypto'
import fs from 'node:fs'
import * as THREE from 'three'
import { loadClient, clientWorld } from './lib/clientHarness.mjs'
import { png } from './lib/imageBytes.mjs'
import { importApp, exportApp, INVALID_HYP, takeAsset } from '../src/core/extras/appTools.js'
import { fieldValues } from '../src/core/extras/appFields.js'
import { resolveReference } from '../src/core/extras/assetURL.js'
import { load } from './lib/persistenceHarness.mjs'
import { extensionOf } from '../src/server/uploadPolicy.js'
import { IMAGE_HEADER_BYTES, MAX_IMAGE_PIXELS, readImageHeader } from '../src/core/extras/imageHeader.js'
import { isDataURI } from '../src/core/extras/gltfLimits.js'

const latin1 = buffer => Buffer.from(buffer).toString('latin1')
const sha = bytes => nodeCrypto.createHash('sha256').update(bytes).digest('hex')
const bytesOf = text => new TextEncoder().encode(text)

// the HDR parser's results, by the data array a texture is made from
const hdrData = new WeakMap()
const ClientLoader = loadClient('core/systems/ClientLoader.js', 'ClientLoader', {
  THREE,
  RGBELoader: class {
    parse(buffer) {
      const data = new Uint16Array(4)
      hdrData.set(data, latin1(buffer))
      return { data, width: 1, height: 1, type: THREE.HalfFloatType }
    }
  },
  GLTFLoader: class {
    register() {}
    async parseAsync(buffer) {
      return { scene: new THREE.Group(), animations: [], text: latin1(buffer) }
    }
  },
  VRMLoaderPlugin: class {},
  System: class {
    constructor(world) {
      this.world = world
    }
  },
  createNode: () => ({ add() {}, clone() {} }),
  createVRMFactory: glb => ({ text: glb.text }),
  glbToNodes: glb => ({ clone: () => ({ text: glb.text }) }),
  createEmoteFactory: glb => ({ toClip: () => glb.text }),
  formatBytes: n => String(n),
  imageElementsPlugin: () => {},
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
const Builder = loadClient('core/systems/ClientBuilder.js', 'ClientBuilder', { importApp })

// the name the server stores an upload under (src/server/assetFilename.js), with the server's hash (utils-server.js)
const computeAssetFilename = load('server/assetFilename.js', 'computeAssetFilename', {
  hashFile: async buffer => nodeCrypto.createHash('sha256').update(buffer).digest('hex'),
  extensionOf,
})

const ASSETS = 'https://world.example/assets'
const storeURL = url => url.replace('asset:/', ASSETS)

// object URLs lead back to their blob; an <img> decodes at once
const blobs = new Map()
const originals = {}
before(() => {
  Object.assign(originals, { create: URL.createObjectURL, revoke: URL.revokeObjectURL, Image: globalThis.Image })
  URL.createObjectURL = blob => {
    const url = `blob:${blobs.size}`
    blobs.set(url, blob)
    return url
  }
  URL.revokeObjectURL = () => {}
  globalThis.Image = class {
    set src(value) {
      this._src = value
      queueMicrotask(() => {
        this.naturalWidth = 8
        this.naturalHeight = 8
        this.onload?.()
      })
    }
  }
})
after(() => {
  URL.createObjectURL = originals.create
  URL.revokeObjectURL = originals.revoke
  globalThis.Image = originals.Image
})
const blobText = async url => latin1(await blobs.get(url).arrayBuffer())

// what a loaded result says about the bytes it was made from
async function seen(type, result) {
  if (type === 'script') return result.code
  if (type === 'model') return result.toNodes().text
  if (type === 'avatar') return result.factory.text
  if (type === 'emote') return result.toClip()
  if (type === 'image') return blobText(result._src)
  if (type === 'texture') return blobText(result.image._src)
  if (type === 'hdr') return hdrData.get(result.image.data)
  if (type === 'audio') return result.text
  return null
}

// bytes of each kind, told apart by a text at their end
const withText = (bytes, text) => Uint8Array.from([...bytes, ...bytesOf(text)])
const KINDS = {
  script: ['js', text => bytesOf(`// ${text}`)],
  model: ['glb', text => bytesOf(`glTF ${text}`)],
  avatar: ['vrm', text => bytesOf(`glTF vrm ${text}`)],
  emote: ['glb', text => bytesOf(`glTF emote ${text}`)],
  texture: ['png', text => withText(png(8, 8), text)],
  image: ['png', text => withText(png(8, 8), text)],
  hdr: ['hdr', text => bytesOf(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n${text}`)],
  audio: ['mp3', text => bytesOf(`ID3 ${text}`)],
  video: ['mp4', text => bytesOf(`mp4 ${text}`)],
}
const contentURL = (bytes, ext) => `asset://${sha(bytes)}.${ext}`

// a builder's client with the real loader over a fake network (`served`: url -> body), recording what it caches,
// uploads, sends and says in the console
function setup(t, served = {}) {
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async url => {
    requests.push(url)
    const body = served[url]
    return body ? new Response(body) : new Response('missing', { status: 404 })
  }
  t.after(() => (globalThis.fetch = original))
  const warnings = []
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')))
  const world = clientWorld()
  world.assetsUrl = ASSETS
  // as World.resolveURL does it
  world.resolveURL = url => resolveReference(url, ASSETS)
  world.scripts = { evaluate: code => ({ code }) }
  world.audio = { ctx: { decodeAudioData: async buffer => ({ text: latin1(buffer) }) } }
  world.network.maxUploadSize = 12
  const uploads = []
  world.network.upload = async file => {
    uploads.push(file.name)
  }
  world.entities.add = () => ({ onUploaded() {}, destroy() {} })
  world.ui = { confirm: async () => true }
  world.loader = new ClientLoader(world)
  const inserts = []
  const insert = world.loader.insert.bind(world.loader)
  world.loader.insert = (type, url, file) => {
    inserts.push([type, url])
    return insert(type, url, file)
  }
  const builder = Object.assign(Object.create(Builder.prototype), { world })
  const sent = () => world.packets.length
  return { world, builder, requests, uploads, inserts, warnings, sent }
}

// a .hyp file as anyone could write one: each asset's header says `type` and `url`; its bytes are `bytes`
function hyp(blueprint, assets) {
  const header = bytesOf(
    JSON.stringify({
      blueprint,
      assets: assets.map(a => ({ type: a.type, url: a.url, size: a.bytes.length, mime: '' })),
    })
  )
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, header.length, true)
  return new File([size, header, ...assets.map(a => a.bytes)], 'gift.hyp')
}
const at = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }

for (const [type, [ext, make]] of Object.entries(KINDS)) {
  test(`${type}: a .hyp file whose asset takes the address of a loaded ${type} with other bytes is refused before anything is cached`, async t => {
    const real = make('the real one')
    const url = contentURL(real, ext)
    const f = setup(t, { [storeURL(url)]: real })
    const loaded = await f.world.loader.load(type, url)
    if (type !== 'video') assert.match(await seen(type, loaded), /the real one/)
    // (it used to replace what this client gets for that address, for every kind: the planted bytes, no new request)
    await assert.rejects(f.builder.addApp(hyp({ name: 'gift' }, [{ type, url, bytes: make('PLANTED') }]), at), {
      code: INVALID_HYP,
      message: `not a valid .hyp file: asset 1 (${url}) is not the file its address names`,
    })
    assert.equal(await f.world.loader.load(type, url), loaded)
    assert.equal(f.world.loader.get(type, url), loaded)
    if (type !== 'video') {
      assert.match(await seen(type, f.world.loader.get(type, url)), /the real one/)
      assert.match(latin1(await f.world.loader.getFile(url).arrayBuffer()), /the real one/)
    }
    assert.deepEqual(f.inserts, [])
    assert.deepEqual(f.uploads, [])
    assert.equal(f.sent(), 0)
    assert.equal(f.world.blueprints.items.size, 0)
    assert.equal(f.requests.length, type === 'video' ? 0 : 1)
  })
}

test('a file made by exportApp whose assets are stored under their hashes is cached and uploaded as before', async t => {
  const files = {}
  const add = (type, text) => {
    const [ext, make] = KINDS[type]
    const bytes = make(text)
    const url = contentURL(bytes, ext)
    files[url] = new File([bytes], `picked.${ext}`, { type: 'application/octet-stream' })
    return url
  }
  const blueprint = {
    id: 'bp',
    name: 'Everything',
    model: add('model', 'the model'),
    script: add('script', 'the script'),
    image: { type: 'texture', name: 'icon.png', url: add('texture', 'the icon') },
    props: { label: 'hi' },
  }
  for (const type of ['avatar', 'emote', 'image', 'video', 'hdr', 'audio']) {
    blueprint.props[type] = { type, name: `a ${type}`, url: add(type, `the ${type}`) }
  }
  const file = await exportApp(blueprint, async url => files[url])
  const f = setup(t)
  await f.builder.addApp(file, at)
  const expected = [
    ['model', blueprint.model],
    ['script', blueprint.script],
    ['texture', blueprint.image.url],
    ...['avatar', 'emote', 'image', 'video', 'hdr', 'audio'].map(type => [type, blueprint.props[type].url]),
  ]
  assert.deepEqual(f.inserts, expected)
  // each is uploaded under its own name, which is the name the server stores its bytes under
  assert.deepEqual(
    f.uploads,
    expected.map(([, url]) => url.slice('asset://'.length))
  )
  for (const [, url] of expected) {
    assert.equal((await computeAssetFilename(files[url])).filename, url.slice('asset://'.length))
  }
  assert.match(await seen('model', await f.world.loader.load('model', blueprint.model)), /the model/)
  assert.equal((await f.world.loader.load('script', blueprint.script)).code, '// the script')
  assert.equal(f.sent(), 2, 'blueprintAdded and entityAdded, after the uploads')
  assert.deepEqual(f.warnings, [])
})

test('other spellings of a stored address, built-in names and other hosts are kept as references: not cached, not uploaded', async t => {
  const real = KINDS.script[1]('the real one')
  const url = contentURL(real, 'js')
  const hash = sha(real)
  const builtins = {
    'asset://avatar.vrm': ['avatar', KINDS.avatar[1]('the default avatar')],
    'asset://mp-idle.glb': ['emote', KINDS.emote[1]('idle')],
    'asset://crash-block.glb': ['model', KINDS.model[1]('the crash block')],
    'https://cdn.example/avatars/hero.vrm': ['avatar', KINDS.avatar[1]('a remote avatar')],
  }
  const served = { [storeURL(url)]: real }
  for (const [address, [, bytes]] of Object.entries(builtins)) served[storeURL(address)] = bytes
  const f = setup(t, served)
  const script = await f.world.loader.load('script', url)
  const loaded = {}
  for (const [address, [type]] of Object.entries(builtins)) loaded[address] = await f.world.loader.load(type, address)
  // Aliases of asset://<hash>.js: the loader files each under the same key (the store's own URL of the file, and the
  // address with a query, a fragment or white space around it: ClientLoader.resourceURL, World.resolveURL), but none
  // is the name an upload of the bytes is stored under. A file could use them to reach a loaded address
  const aliases = [storeURL(url), `${url}?v=2`, `${url}#a`, ` ${url}`]
  for (const alias of aliases)
    assert.equal(f.world.loader.keyFor('script', alias), f.world.loader.keyFor('script', url))
  // Other paths, which the canonical form leaves out as well: an upper-case extension or hash, or another extension
  // before it. The loader files them under keys of their own (the path is compared as it is written)
  const others = [`asset://${hash}.JS`, `asset://${hash.toUpperCase()}.js`, `asset://${hash}.glb.js`]
  for (const other of others)
    assert.notEqual(f.world.loader.keyFor('script', other), f.world.loader.keyFor('script', url))
  const spellings = [...aliases, ...others]
  const planted = KINDS.script[1]('PLANTED')
  let drops = 0
  for (const spelling of spellings) {
    // the planted bytes, and the store file's own bytes: neither is taken under another spelling
    for (const bytes of [planted, real]) {
      await f.builder.addApp(hyp({ name: 'gift' }, [{ type: 'script', url: spelling, bytes }]), at)
      drops++
    }
  }
  for (const [address, [type]] of Object.entries(builtins)) {
    await f.builder.addApp(hyp({ name: 'gift' }, [{ type, url: address, bytes: KINDS[type][1]('PLANTED') }]), at)
    drops++
  }
  assert.deepEqual(f.inserts, [])
  assert.deepEqual(f.uploads, [])
  assert.equal(f.world.blueprints.items.size, drops, 'each file was added all the same')
  assert.equal(await f.world.loader.load('script', url), script)
  assert.equal((await f.world.loader.load('script', url)).code, '// the real one')
  assert.match(latin1(await f.world.loader.getFile(url).arrayBuffer()), /the real one/)
  for (const [address, [type]] of Object.entries(builtins)) {
    assert.equal(await f.world.loader.load(type, address), loaded[address], address)
    assert.doesNotMatch(await seen(type, loaded[address]), /PLANTED/)
  }
  assert.equal(f.warnings.length, drops, 'said once for each file')
  assert.equal(
    f.warnings[0],
    '[builder] 1 of the 1 assets of this .hyp file is not cached or uploaded (not stored under the hash of its bytes, or of a kind no app loads): it loads from its own address'
  )
})

test('an asset stored under its hash but of a kind no app loads is neither cached nor uploaded', async t => {
  const bytes = KINDS.script[1]('code')
  const url = contentURL(bytes, 'js')
  const f = setup(t)
  for (const type of ['nonsense', '__proto__', 'constructor', 5, null, undefined]) {
    await f.builder.addApp(hyp({ name: 'gift' }, [{ type, url, bytes }]), at)
  }
  assert.deepEqual(f.inserts, [])
  assert.deepEqual(f.uploads, [])
  assert.equal(f.warnings.length, 6)
  assert.equal(f.world.loader.hasFile(url), false)
})

test('a .hyp of an AI-made app (model asset://ai.glb) still imports: the built-in is a reference, the script is taken', async t => {
  const glb = KINDS.model[1]('the ai placeholder')
  const code = KINDS.script[1]('generated')
  // ClientAI.create: model asset://ai.glb (never replaced), and the script ServerAI stores under its hash
  const blueprint = {
    id: 'bp',
    name: 'Model',
    author: 'Claude',
    model: 'asset://ai.glb',
    script: contentURL(code, 'js'),
  }
  const files = { 'asset://ai.glb': new File([glb], 'ai.glb'), [blueprint.script]: new File([code], 'script.js') }
  const file = await exportApp(blueprint, async url => files[url])
  const imported = await importApp(file)
  assert.deepEqual(
    imported.assets.map(a => [a.type, a.url, a.contentAddressed]),
    [
      ['model', 'asset://ai.glb', false],
      ['script', blueprint.script, true],
    ]
  )
  const f = setup(t, { [storeURL('asset://ai.glb')]: glb })
  await f.builder.addApp(file, at)
  assert.deepEqual(f.inserts, [['script', blueprint.script]])
  assert.deepEqual(f.uploads, [blueprint.script.slice('asset://'.length)])
  const [added] = f.world.blueprints.items.values()
  assert.equal(added.model, 'asset://ai.glb', 'the blueprint keeps its reference')
  assert.equal(added.script, blueprint.script)
  // this client loads the model from the world's own built-in, as everyone else does
  assert.match(await seen('model', await f.world.loader.load('model', 'asset://ai.glb')), /the ai placeholder/)
  assert.deepEqual(f.warnings, [
    '[builder] 1 of the 2 assets of this .hyp file is not cached or uploaded (not stored under the hash of its bytes, or of a kind no app loads): it loads from its own address',
  ])
})

test("a file field's initial with an https url is exported, and imported as a reference", async t => {
  const fields = [
    {
      type: 'file',
      kind: 'avatar',
      key: 'hero',
      initial: { type: 'avatar', name: 'hero.vrm', url: 'https://cdn.example/hero.vrm' },
    },
  ]
  const blueprint = { id: 'bp', name: 'Hero', props: fieldValues(fields, {}) }
  const vrm = KINDS.avatar[1]('fetched from the host')
  const file = await exportApp(blueprint, async () => new File([vrm], 'hero.vrm'))
  const f = setup(t)
  await f.builder.addApp(file, at)
  assert.deepEqual(f.inserts, [])
  assert.deepEqual(f.uploads, [])
  const [added] = f.world.blueprints.items.values()
  assert.deepEqual(added.props.hero, fields[0].initial)
  assert.equal(f.world.loader.hasFile('https://cdn.example/hero.vrm'), false)
  assert.equal(f.warnings.length, 1)
})

test('the scene replacement takes only the assets stored under their hashes', async t => {
  const code = KINDS.script[1]('the scene script')
  const real = KINDS.avatar[1]('the default avatar')
  const f = setup(t, { [storeURL('asset://avatar.vrm')]: real })
  const avatar = await f.world.loader.load('avatar', 'asset://avatar.vrm')
  f.world.blueprints.add({ id: '$scene', version: 0, name: 'Scene', props: {}, scene: true })
  const file = hyp({ name: 'New scene', scene: true, script: contentURL(code, 'js') }, [
    { type: 'script', url: contentURL(code, 'js'), bytes: code },
    { type: 'avatar', url: 'asset://avatar.vrm', bytes: KINDS.avatar[1]('PLANTED') },
  ])
  await f.builder.addApp(file, at)
  assert.deepEqual(f.inserts, [['script', contentURL(code, 'js')]])
  assert.deepEqual(f.uploads, [contentURL(code, 'js').slice('asset://'.length)])
  assert.equal(f.world.blueprints.getScene().script, contentURL(code, 'js'))
  assert.equal(await f.world.loader.load('avatar', 'asset://avatar.vrm'), avatar)
  assert.equal(f.warnings.length, 1)
  // a scene whose assets are all left out is changed and announced at once, as one without assets was
  const g = setup(t)
  g.world.blueprints.add({ id: '$scene', version: 0, name: 'Scene', props: {}, scene: true })
  await g.builder.addApp(
    hyp({ name: 'Other', scene: true, model: 'asset://ai.glb' }, [
      { type: 'model', url: 'asset://ai.glb', bytes: KINDS.model[1]('x') },
    ]),
    at
  )
  assert.deepEqual(g.inserts, [])
  assert.deepEqual(g.uploads, [])
  assert.equal(g.world.blueprints.getScene().model, 'asset://ai.glb')
  assert.equal(g.sent(), 1, 'blueprintModified')
})

// Uploads that finish when the test says so: each entry resolves or rejects the upload it stands for, and `done` is
// that upload's promise as the builder holds it. `pending.asked(n, adding)` resolves as soon as the builder has asked
// for n uploads (in the call that asks for the n-th, before the builder goes on), and fails with a reason when addApp
// (`adding`) ends first or the limit passes. Before it asks, importApp reads the file and hashes assets with
// WebCrypto: how many turns that takes is the platform's (CI's Linux and Node 22 took more than a fixed wait gave it).
function deferUploads(world) {
  const pending = []
  const waiting = []
  world.network.upload = (file, options) => {
    const entry = { name: file.name, batch: options?.batch }
    entry.done = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }))
    // (a failed upload's promise is the builder's to handle; the test awaits it only to know it has settled)
    entry.done.catch(() => {})
    pending.push(entry)
    for (const waiter of waiting) if (pending.length >= waiter.n) waiter.resolve()
    return entry.done
  }
  pending.asked = (n, adding, limit = 30_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the builder asked for ${pending.length} of ${n} uploads in ${limit} ms`)),
        limit
      )
      const end = settle => value => {
        clearTimeout(timer)
        settle(value)
      }
      if (pending.length >= n) return end(resolve)()
      waiting.push({ n, resolve: end(resolve) })
      adding.then(
        end(() => reject(new Error(`addApp ended after asking for ${pending.length} of ${n} uploads`))),
        end(reject)
      )
    })
  return pending
}

// Every reaction the builder can have to an upload settling has run: the test waits for that upload's promise, which
// the builder awaits through Promise.all, and then for the next macrotask, before which every promise reaction it
// started has run (nothing between the two is real asynchronous work: no hashing, no reading, no timer). Used where
// the test checks that nothing has happened yet, which has no event of its own.
async function reactedTo(upload) {
  await upload.done.catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
}

// the names of the packets the builder sends, in order
function sentNames(world) {
  const names = []
  const send = world.network.send.bind(world.network)
  world.network.send = (name, data) => {
    names.push(name)
    return send(name, data)
  }
  return names
}

// a file with two assets stored under their hashes and a built-in reference between them
function mixedFile(blueprint) {
  const glb = KINDS.model[1]('the model')
  const code = KINDS.script[1]('the script')
  const model = contentURL(glb, 'glb')
  const script = contentURL(code, 'js')
  const file = hyp({ ...blueprint, model, script }, [
    { type: 'model', url: model, bytes: glb },
    { type: 'avatar', url: 'asset://avatar.vrm', bytes: KINDS.avatar[1]('PLANTED') },
    { type: 'script', url: script, bytes: code },
  ])
  return { file, taken: [model, script].map(url => url.slice('asset://'.length)) }
}

test('a new app with assets taken and left out is announced only when the last taken upload has finished', async t => {
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args.map(String).join(' ')))
  for (const outcome of ['uploaded', 'failed']) {
    const f = setup(t)
    const uploads = deferUploads(f.world)
    const sent = sentNames(f.world)
    const app = { local: null, uploaded: 0, destroyed: [] }
    f.world.entities.add = (data, local) => {
      app.local = local
      return { onUploaded: () => app.uploaded++, destroy: broadcast => app.destroyed.push(broadcast) }
    }
    const { file, taken } = mixedFile({ name: 'mixed' })
    const adding = f.builder.addApp(file, at)
    await uploads.asked(2, adding)
    assert.deepEqual(
      uploads.map(u => u.name),
      taken,
      'the taken assets, as one batch'
    )
    assert.equal(uploads[0].batch, uploads[1].batch)
    assert.equal(app.local, false, 'added here, not announced')
    assert.deepEqual(sent, [], 'nothing announced while the uploads run')
    // the last one asked for finishes first: nothing yet
    uploads[1].resolve()
    await reactedTo(uploads[1])
    assert.deepEqual(sent, [])
    assert.equal(app.uploaded, 0)
    if (outcome === 'uploaded') {
      uploads[0].resolve()
      await adding
      assert.deepEqual(sent, ['blueprintAdded', 'entityAdded'])
      assert.equal(app.uploaded, 1)
      assert.equal(f.world.blueprints.items.size, 1)
    } else {
      // as before: the toast says why, and the app and its blueprint go, here only (they were never announced)
      uploads[0].reject(new Error('Upload failed: 503'))
      await adding
      assert.deepEqual(sent, [])
      assert.equal(app.uploaded, 0)
      assert.deepEqual(app.destroyed, [false])
      assert.equal(f.world.blueprints.items.size, 0)
      assert.deepEqual(f.world.toasts, ['Upload failed: 503'])
      assert.deepEqual(errors, ['failed to upload .hyp assets', 'Error: Upload failed: 503'])
    }
    assert.equal(f.warnings.length, 1, 'the built-in reference is left out')
  }
})

test('a scene replacement with assets taken and left out is announced only when the last taken upload has finished', async t => {
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args.map(String).join(' ')))
  for (const outcome of ['uploaded', 'failed']) {
    const f = setup(t)
    const uploads = deferUploads(f.world)
    const sent = sentNames(f.world)
    f.world.blueprints.add({
      id: '$scene',
      version: 0,
      name: 'Scene',
      model: null,
      script: null,
      props: {},
      scene: true,
    })
    const { file, taken } = mixedFile({ name: 'New scene', scene: true })
    const adding = f.builder.addApp(file, at)
    await uploads.asked(2, adding)
    assert.deepEqual(
      uploads.map(u => u.name),
      taken
    )
    assert.equal(uploads[0].batch, uploads[1].batch)
    assert.equal(f.world.blueprints.getScene().name, 'New scene', 'changed here at once')
    assert.deepEqual(sent, [], 'nothing announced while the uploads run')
    uploads[1].resolve()
    await reactedTo(uploads[1])
    assert.deepEqual(sent, [])
    if (outcome === 'uploaded') {
      uploads[0].resolve()
      await adding
      assert.deepEqual(sent, ['blueprintModified'])
      assert.equal(f.world.blueprints.getScene().name, 'New scene')
    } else {
      // as before: the toast says why, and the change is taken back here; nothing was announced
      uploads[0].reject(new Error('Upload failed: 503'))
      await adding
      assert.deepEqual(sent, [])
      assert.deepEqual(f.world.toasts, ['Upload failed: 503'])
      const scene = f.world.blueprints.getScene()
      assert.deepEqual([scene.name, scene.model, scene.script], ['Scene', null, null])
      assert.deepEqual(errors, ['Error: Upload failed: 503'])
    }
    assert.equal(f.warnings.length, 1)
  }
})

test('the five files shipped with the world: all 18 assets are taken, the duplicate in Image.hyp too', async t => {
  const names = [
    'collections/default/Image.hyp',
    'collections/default/Model.hyp',
    'collections/default/Text.hyp',
    'collections/default/Video.hyp',
    'scene.hyp',
  ]
  let count = 0
  for (const name of names) {
    const buffer = fs.readFileSync(new URL(`../src/world/${name}`, import.meta.url))
    const app = await importApp(new File([buffer], name))
    for (const asset of app.assets) {
      assert.equal(asset.contentAddressed, true, `${name}: ${asset.url}`)
      assert.equal(takeAsset(asset), true, `${name}: ${asset.type}`)
      assert.equal((await computeAssetFilename(asset.file)).filename, asset.url.slice('asset://'.length))
      count++
    }
    // dropped on a world: every asset cached and uploaded, nothing said
    const f = setup(t)
    f.world.loader = { insert: (type, url) => f.inserts.push([type, url]) }
    f.world.blueprints.add({ id: '$scene', version: 0, name: 'Scene', props: {}, scene: true })
    await f.builder.addApp(new File([buffer], name), at)
    assert.deepEqual(
      f.inserts,
      app.assets.map(a => [a.type, a.url]),
      name
    )
    assert.equal(f.uploads.length, app.assets.length)
    assert.deepEqual(f.warnings, [])
    if (name.endsWith('Image.hyp')) {
      const [, , texture, image] = app.assets
      assert.deepEqual([texture.type, image.type], ['texture', 'image'])
      assert.equal(texture.url, image.url, 'one png under one url, as a texture and as an image')
    }
  }
  assert.equal(count, 18)
})

test('each asset written as a stored address is hashed once; an empty one is its own hash; the others are not hashed', async t => {
  const digests = []
  const digest = crypto.subtle.digest
  t.mock.method(crypto.subtle, 'digest', function (algorithm, data) {
    digests.push(data.byteLength)
    return digest.call(this, algorithm, data)
  })
  const empty = new Uint8Array(0)
  const large = new Uint8Array(8 * 1024 * 1024).fill(7)
  const emptyURL = contentURL(empty, 'js')
  assert.equal(emptyURL, 'asset://e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.js')
  const app = await importApp(
    hyp({ name: 'x' }, [
      { type: 'script', url: emptyURL, bytes: empty },
      { type: 'model', url: contentURL(large, 'glb'), bytes: large },
      { type: 'model', url: contentURL(large, 'glb'), bytes: large },
      { type: 'model', url: 'asset://ai.glb', bytes: large },
      { type: 'avatar', url: 'https://cdn.example/a.vrm', bytes: large },
    ])
  )
  assert.deepEqual(
    app.assets.map(a => a.contentAddressed),
    [true, true, true, false, false]
  )
  assert.deepEqual(digests, [0, large.length, large.length], 'once per asset in that form, none for the others')
  // the empty asset under another hash is refused like any other
  await assert.rejects(
    importApp(hyp({ name: 'x' }, [{ type: 'script', url: contentURL(bytesOf('x'), 'js'), bytes: empty }])),
    { code: INVALID_HYP, message: /asset 1 \(asset:\/\/[0-9a-f]{64}\.js\) is not the file its address names$/ }
  )
})

test('a wrong hash refuses the whole file and names the asset; the right hash with another extension is that address', async () => {
  const glb = KINDS.model[1]('a model')
  const other = KINDS.model[1]('another model')
  // the second asset: an address of a stored file, with other bytes
  await assert.rejects(
    importApp(
      hyp({ name: 'x' }, [
        { type: 'model', url: contentURL(glb, 'glb'), bytes: glb },
        { type: 'model', url: contentURL(glb, 'glb'), bytes: other },
      ])
    ),
    {
      code: INVALID_HYP,
      message: `not a valid .hyp file: asset 2 (${contentURL(glb, 'glb')}) is not the file its address names`,
    }
  )
  // the same bytes under the hash and another extension: an upload of them is stored under exactly that name
  const app = await importApp(hyp({ name: 'x' }, [{ type: 'model', url: contentURL(glb, 'png'), bytes: glb }]))
  assert.equal(app.assets[0].contentAddressed, true)
  assert.equal((await computeAssetFilename(app.assets[0].file)).filename, contentURL(glb, 'png').slice(8))
  // an extension the server could not store the name under (upper case, too long): not that form, so a reference
  for (const url of [`asset://${sha(glb)}.GLB`, `asset://${sha(glb)}.${'g'.repeat(64)}`, `asset://${sha(glb)}.`]) {
    const kept = await importApp(hyp({ name: 'x' }, [{ type: 'model', url, bytes: other }]))
    assert.equal(kept.assets[0].contentAddressed, false, url)
  }
})

// (onDrop turns any rejection of drop into the toast "That could not be added." and a console line:
// clientLifecycle.test.js, "builder: a drop that fails is not an unhandled rejection")
test('a dropped file that is refused: the drop fails with the reason, before anything is cached', async t => {
  const f = setup(t)
  Object.assign(f.builder, { canBuild: () => true, toggle() {}, getSpawnTransform: () => at })
  const url = contentURL(bytesOf('// the real one'), 'js')
  const file = hyp({ name: 'gift' }, [{ type: 'script', url, bytes: bytesOf('// PLANTED') }])
  await assert.rejects(
    f.builder.drop({
      preventDefault() {},
      dataTransfer: { items: [{ kind: 'file', type: '', getAsFile: () => file }] },
    }),
    { code: INVALID_HYP, message: `not a valid .hyp file: asset 1 (${url}) is not the file its address names` }
  )
  assert.deepEqual(f.inserts, [])
  assert.deepEqual(f.uploads, [])
  assert.equal(f.sent(), 0)
})
