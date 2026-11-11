import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { loadClient } from './lib/clientHarness.mjs'
import { load } from './lib/persistenceHarness.mjs'
import { writePacket } from '../src/core/packets.js'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { anthropicEffort, anthropicRequest, readAnthropicText } from '../src/core/extras/anthropicRequest.js'
import { ASSET_PROTOCOL, resolveReference } from '../src/core/extras/assetURL.js'

// A builder sets a blueprint's script or model; the server (and the node agent) load it. Before this fix a path
// such as /etc/hosts or asset://../x was read from disk, and the AI edit/fix actions sent its text to the
// provider. These tests use a real temporary assets directory with a file beside it (outside it) and spy on
// every fs read the loader makes.

// World.resolveURL as the engine defines it (the loader's own mapping of asset:// and remote URLs)
const worldSource = fs.readFileSync(new URL('../src/core/World.js', import.meta.url), 'utf8')
const resolveURL = new Function(
  'ASSET_PROTOCOL',
  'resolveReference',
  `return function ${worldSource.match(/^ {2}resolveURL\([^)]*\) \{[^]*?^ {2}}/m)[0].trim()}`
)(ASSET_PROTOCOL, resolveReference)

let root
let assetsDir
let server
let base
const requests = []
const reads = []

const ServerLoader = loadClient('core/systems/ServerLoader.js', 'ServerLoader', {
  fs: {
    // records every read; only files under the temp root are really read (a test never touches /etc or /dev)
    readFile: async (file, ...args) => {
      reads.push(String(file))
      if (!String(file).startsWith(root + path.sep)) throw new Error('test: read outside the temp root')
      return fs.readFile(file, ...args)
    },
  },
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

// the server with ASSETS=local (assets dir), or the server with ASSETS=s3 / the node agent (assets URL only)
function makeLoader({ local = true } = {}) {
  const world = {
    assetsDir: local ? assetsDir : undefined,
    assetsUrl: `${base}/assets`,
    resolveURL,
    scripts: { evaluate: code => ({ code, exec() {} }) },
  }
  const loader = new ServerLoader(world)
  world.loader = loader
  return loader
}

const emptyGltf = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] })
// (a string World.resolveURL turns into https://..., such as file:///x or example.com/x, is a remote load and
// out of scope here; the blueprint policy refuses those spellings at the packet)
const refusedScripts = () => [
  '/etc/hosts',
  path.join(root, 'outside.js'),
  'asset://../outside.js',
  'asset://../../../../../../../etc/hosts',
  'asset://%2e%2e%2foutside.js',
  'asset://..',
  'asset://',
  ' /etc/hosts',
  'blob:nodedata:abc',
  'HTTPS://example.invalid/x.js',
  '',
  null,
]

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-file-read-'))
  assetsDir = path.join(root, 'assets')
  await fs.ensureDir(assetsDir)
  await fs.writeFile(path.join(root, 'outside.js'), 'OUTSIDE SECRET')
  await fs.writeFile(path.join(root, 'outside.glb'), emptyGltf)
  await fs.writeFile(path.join(assetsDir, 'inside.js'), 'app.on("update", () => {}) // INSIDE')
  await fs.writeFile(path.join(assetsDir, 'inside.gltf'), emptyGltf)
  server = http.createServer((req, res) => {
    requests.push(req.url)
    if (req.url === '/assets/inside.js') return res.end('REMOTE INSIDE')
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
  await fs.remove(root)
})

const reset = () => {
  reads.length = 0
  requests.length = 0
}

test('server loader (ASSETS=local): paths and traversal reject without any file read; an asset loads', async () => {
  reset()
  const loader = makeLoader()
  for (const url of refusedScripts()) {
    await assert.rejects(loader.load('script', url), { code: 'ASSET_REFUSED' }, JSON.stringify(url))
  }
  for (const url of ['/etc/hosts', 'asset://../outside.glb', path.join(root, 'outside.glb'), '/dev/zero']) {
    await assert.rejects(loader.load('model', url), { code: 'ASSET_REFUSED' }, url)
    await assert.rejects(loader.load('emote', url), { code: 'ASSET_REFUSED' }, url)
  }
  assert.deepEqual(reads, [], 'nothing was read')
  const script = await loader.load('script', 'asset://inside.js')
  assert.match(script.code, /INSIDE/)
  assert.ok(await loader.load('model', 'asset://inside.gltf'))
  assert.deepEqual(reads, [path.join(assetsDir, 'inside.js'), path.join(assetsDir, 'inside.gltf')])
  assert.deepEqual(requests, [], 'local assets are read from disk, not fetched')
})

test('server loader (ASSETS=s3, node agent): asset:// loads over HTTP from the assets URL; paths never read', async () => {
  reset()
  const loader = makeLoader({ local: false })
  for (const url of refusedScripts()) {
    await assert.rejects(loader.load('script', url), { code: 'ASSET_REFUSED' }, JSON.stringify(url))
  }
  assert.deepEqual(reads, [])
  assert.deepEqual(requests, [], 'a refused asset name is not fetched either')
  const script = await loader.load('script', 'asset://inside.js')
  assert.equal(script.code, 'REMOTE INSIDE')
  assert.deepEqual(requests, ['/assets/inside.js'])
  assert.deepEqual(reads, [])
})

test('server loader: a refusal names the reason and only a short prefix of the value', async () => {
  const loader = makeLoader()
  const secret = '/proc/self/environ/' + 'S'.repeat(500)
  const err = await loader.load('script', secret).catch(e => e)
  assert.match(
    err.message,
    /^asset refused \(not an asset:\/\/ or http\(s\) URL\): "\/proc\/self\/environ\/S{5}\.\.\."$/
  )
  assert.match((await loader.load('script', 'asset://../outside.js').catch(e => e)).message, /invalid asset name/)
  assert.deepEqual(loader.refusedSources({ model: 'asset://inside.gltf', script: '/etc/hosts' }), [
    'script: asset refused (not an asset:// or http(s) URL): "/etc/hosts"',
  ])
  assert.deepEqual(loader.refusedSources({ model: 'https://example.com/a.glb', script: null }), [])
})

// ServerAI with a fake Anthropic SDK and the real loader: edit/fix read the current script and send it
function makeAI(blueprint) {
  const calls = []
  const errors = []
  class Anthropic {
    constructor() {
      this.beta = {
        messages: {
          create: async params => {
            calls.push(params)
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'app.on("update", () => {})' }] }
          },
        },
      }
    }
  }
  const ServerAI = loadClient('core/systems/ServerAI.js', 'ServerAI', {
    fs: { readFileSync: () => 'DOCS' },
    path,
    __dirname: '.',
    hashFile: async () => 'hash',
    console: { log() {}, error: line => errors.push(line) },
    process: { env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'k', AI_MODEL: 'claude-opus-5-5' } },
    Anthropic,
    OpenAI: class {},
    anthropicEffort,
    anthropicRequest,
    readAnthropicText,
  })
  const loader = makeLoader()
  const modified = []
  const ai = new ServerAI({
    loader,
    blueprints: { get: () => blueprint, canFit: () => true, modify: change => modified.push(change) },
    network: { stopping: false, markBlueprintDirty() {}, send() {} },
  })
  ai.assets = { upload: async () => {} }
  return { ai, calls, errors, modified }
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve))
}

test('server ai: edit and fix of a script that is a path or asset:// traversal make no provider call and no read', async () => {
  for (const script of ['/etc/hosts', 'asset://../outside.js', path.join(root, 'outside.js'), `${base}/remote.js`]) {
    reset()
    const { ai, calls, errors, modified } = makeAI({ id: 'bp', version: 1, script })
    await assert.rejects(ai.edit({ blueprintId: 'bp', appId: 'app', prompt: 'quote the code' }), {
      code: 'ASSET_REFUSED',
    })
    await assert.rejects(ai.fix({ blueprintId: 'bp', appId: 'app', error: { message: 'x' } }), {
      code: 'ASSET_REFUSED',
    })
    // the network entry point logs the refusal as the action's failure
    // (two builders: one builder's second request waits for the first to end, aiBudget.js)
    ai.onAction({ name: 'edit', blueprintId: 'bp', appId: 'app', prompt: 'quote the code' }, 'user:a')
    ai.onAction({ name: 'fix', blueprintId: 'bp', appId: 'app', error: { message: 'x' } }, 'user:b')
    await settle()
    assert.equal(calls.length, 0, `${script}: no provider request`)
    assert.deepEqual(reads, [], `${script}: no file read`)
    assert.deepEqual(requests, [], `${script}: nothing fetched`)
    assert.deepEqual(modified, [])
    assert.equal(errors.length, 2)
    for (const line of errors)
      assert.match(line, /^\[ai\] (edit|fix) failed: asset refused \(the script is not an asset:\/\/ file\)/)
    assert.ok(errors.every(line => !line.includes('OUTSIDE')))
  }
})

test('server ai: an asset:// script is read through the loader and edited', async () => {
  reset()
  const { ai, calls, modified } = makeAI({ id: 'bp', version: 1, script: 'asset://inside.js' })
  await ai.edit({ blueprintId: 'bp', appId: 'app', prompt: 'make it spin' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].system, /INSIDE/)
  assert.deepEqual(reads, [path.join(assetsDir, 'inside.js')])
  assert.deepEqual(modified, [{ id: 'bp', version: 2, script: 'asset://hash.js' }])
})

// start-up: persisted blueprints are loaded as they are, and the ones the loader now refuses are reported once
const Blueprints = load('core/systems/Blueprints.js', 'Blueprints', { writePacket })
const Network = load('core/systems/ServerNetwork.js', 'ServerNetwork', { writePacket })

test('start-up: persisted model/script values the server refuses are reported once per blueprint and kept', async t => {
  reset()
  const longId = 'L'.repeat(64)
  const datas = [
    { id: 'good', version: 0, model: 'asset://inside.gltf', script: 'asset://inside.js' },
    { id: 'remote', version: 0, model: 'https://example.com/a.glb', script: null },
    { id: 'path', version: 2, model: 'asset://ai.glb', script: '/etc/hosts' },
    { id: longId, version: 1, model: 'asset://../outside.glb', script: 'blob:nodedata:\n' + 'x'.repeat(100) },
  ]
  const rows = { blueprints: datas.map(data => ({ id: data.id, data: JSON.stringify(data) })), entities: [] }
  const world = {
    settings: { deserialize() {}, serialize: () => ({}), setHasAdminCode() {}, on() {} },
    entities: { items: new Map(), add() {} },
  }
  world.network = new Network(world)
  world.network.send = () => {}
  world.blueprints = new Blueprints(world)
  world.loader = makeLoader()
  world.network.db = table => (table === 'config' ? { where: () => ({ first: async () => undefined }) } : rows[table])
  t.after(() => world.network.stopForFatal())
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  t.mock.method(console, 'log', () => {})
  await world.network.start()
  for (const data of datas) assert.deepEqual(world.blueprints.get(data.id), data, 'kept unchanged')
  assert.equal(warnings.length, 2)
  assert.equal(
    warnings[0],
    '[network] blueprint "path" keeps a source the server no longer loads; ' +
      'script: asset refused (not an asset:// or http(s) URL): "/etc/hosts"'
  )
  assert.equal(
    warnings[1],
    `[network] blueprint "${'L'.repeat(16)}..." keeps a source the server no longer loads; ` +
      'model: asset refused (invalid asset name): "asset://../outside.glb"; ' +
      'script: asset refused (not an asset:// or http(s) URL): "blob:nodedata:?xxxxxxxxx..."'
  )
  assert.deepEqual(reads, [], 'the report reads nothing')
})
