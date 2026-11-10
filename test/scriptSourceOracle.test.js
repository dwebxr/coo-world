import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadClient } from './lib/clientHarness.mjs'
import { ASSET_PROTOCOL, resolveReference, scriptSource } from '../src/core/extras/assetURL.js'

// scriptSource says "this script is the store file X for certain" only where the runtime fetches exactly X. The
// oracle is the real code: World.resolveURL and ServerLoader.fetchText (with fetch stubbed to record the request),
// for a few hundred generated spellings. Codex: `https:/world.example/assets/<hash>.js` was certain because new URL()
// normalises it, while the loader requested https://https/world.example/...

const ASSETS = 'https://world.example/assets'
const worldSource = fs.readFileSync(new URL('../src/core/World.js', import.meta.url), 'utf8')
const resolveURL = new Function(
  'ASSET_PROTOCOL',
  'resolveReference',
  `return function ${worldSource.match(/^ {2}resolveURL\([^)]*\) \{[^]*?^ {2}}/m)[0].trim()}`
)(ASSET_PROTOCOL, resolveReference)

const requested = []
const ServerLoader = loadClient('core/systems/ServerLoader.js', 'ServerLoader', {
  fetch: async url => {
    requested.push(url)
    return { text: async () => 'code', arrayBuffer: async () => new ArrayBuffer(0) }
  },
  fs: { readFile: async file => `file:${file}` },
  path,
  RGBELoader: class {},
  GLTFLoader: class {},
  System: class {
    constructor(world) {
      this.world = world
    }
  },
  createVRMFactory: () => ({}),
  glbToNodes: () => ({}),
  createNode: () => ({}),
  createEmoteFactory: () => ({}),
})

// ASSETS=s3 (or the node agent): asset:// is fetched from the assets URL; ASSETS=local: it is read from the directory
function loader(assetsDir) {
  const world = { assetsUrl: ASSETS, assetsDir, resolveURL }
  return new ServerLoader(world)
}

function spellings() {
  const schemes = [
    'https://',
    'http://',
    'HTTPS://',
    'Https://',
    'https:/',
    'https:',
    'https:///',
    'ht\ttps://',
    'https:\t//',
    'https:/\t/',
    'https://\n',
    ' https://',
  ]
  const hosts = [
    'world.example',
    'WORLD.example',
    'world.example:443',
    'world.example:8443',
    'user@world.example',
    'user:pw@world.example',
    'wor\tld.example',
    'world.example.',
    'xn--wrld-zqa.example',
    'wörld.example',
    'other.example',
  ]
  const paths = [
    '/assets/s.js',
    '/assets/S.js',
    '/assets//s.js',
    '/assets\\s.js',
    '\\assets\\s.js',
    '/assets/s.js?',
    '/assets/s.js#x',
    '/assets/%73.js',
    '/ASSETS/s.js',
    '/assets/./s.js',
    '/assets/x/../s.js',
    '/assets/\ts.js',
    '/assets/s\n.js',
    '/assets/s.js ',
    '/assets',
    '/s.js',
  ]
  const out = []
  for (const scheme of schemes) for (const host of hosts) for (const p of paths) out.push(scheme + host + p)
  for (const name of ['s.js', 'S.js', '%73.js', 'sub/../s.js', '../s.js', 's.js?v=1', 's.js#x', ' s.js', 's.js ']) {
    out.push(`asset://${name}`, ` asset://${name} `, `ASSET://${name}`, `\tasset://${name}\n`)
  }
  out.push(
    'blob:https://world.example/1',
    'Blob:443/s.js',
    'blob/../assets/s.js',
    '/assets/s.js',
    '//world.example/assets/s.js'
  )
  return out
}

test('scriptSource: every "certain store file" is exactly the object the server loader fetches or reads', async () => {
  const all = spellings()
  assert.ok(all.length > 2000, `${all.length} spellings`)
  let certain = 0
  for (const mode of [undefined, '/world/assets']) {
    for (const spelling of all) {
      const source = scriptSource(spelling, ASSETS)
      if (source.source !== 'store') continue
      certain++
      requested.length = 0
      let text
      try {
        text = await loader(mode).fetchText(spelling)
      } catch (err) {
        assert.fail(
          `${JSON.stringify(spelling)} is certain (${source.name}) but the server loader refuses it: ${err.message}`
        )
      }
      if (requested.length) {
        // fetched: the request is the store's object by that name
        assert.equal(requested.length, 1)
        assert.equal(new URL(requested[0]).href, new URL(`${ASSETS}/${source.name}`).href, JSON.stringify(spelling))
      } else {
        // read from the assets directory (ASSETS=local): the file by that name
        assert.equal(text, `file:${path.join(mode, source.name)}`, JSON.stringify(spelling))
      }
    }
  }
  assert.ok(certain > 40, `${certain} certain`)
  // the spellings Codex found, and others the runtime rewrites or refuses, are not certain
  for (const spelling of [
    'https:/world.example/assets/s.js',
    'ht\ttps://world.example/assets/s.js',
    'https:\t//world.example/assets/s.js',
    'HTTPS://world.example/assets/s.js',
    'https://user:pw@world.example/assets/s.js',
  ]) {
    assert.equal(scriptSource(spelling, ASSETS).source, 'unknown', JSON.stringify(spelling))
  }
})
