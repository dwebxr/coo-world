import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadClient } from './lib/clientHarness.mjs'
import { ASSET_PROTOCOL, resolveReference, scriptSource } from '../src/core/extras/assetURL.js'

// scriptSource says "this script is the store file X for certain" only where the runtime loads exactly X, on the
// server and on a client. The oracles are the real code: World.resolveURL, then ServerLoader.fetchText (with fetch
// stubbed to record the request) for the server, and the URL a browser's fetch requests (resolveURL's result resolved
// against the page) for a client, for a page at the origin root and at a sub-path, and for three assets bases (the
// page's origin, another origin, a path prefix), over a few thousand generated spellings. Codex:
// `https:/world.example/assets/<hash>.js` was certain because new URL() normalises it, while the loader requested
// https://https/world.example/...

const BASES = ['https://world.example/assets', 'https://cdn.example/assets', 'https://world.example/w/assets']
const PAGES = ['https://world.example/', 'https://world.example/room/']
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
function loader(assetsUrl, assetsDir) {
  return new ServerLoader({ assetsUrl, assetsDir, resolveURL })
}

// what a client requests: ClientLoader fetches world.resolveURL(url), which a browser resolves against the page
function clientRequest(spelling, assetsUrl, page) {
  try {
    return new URL(resolveURL.call({ assetsUrl }, spelling), page).href
  } catch {
    return null // the browser's fetch rejects it: nothing loads
  }
}

function spellings(base) {
  const { host, pathname } = new URL(base)
  const schemes = [
    'https://',
    'http://',
    'HTTPS://',
    'https:/',
    'https:',
    'https:///',
    'ht\ttps://',
    'https:\t//',
    ' https://',
  ]
  const hosts = [
    host,
    host.toUpperCase(),
    `${host}:443`,
    `${host}:8443`,
    `user@${host}`,
    `user:pw@${host}`,
    `${host.slice(0, 3)}\t${host.slice(3)}`,
    `${host}.`,
    'wörld.example',
    'other.example',
  ]
  const p = pathname.replace(/\/$/, '')
  const paths = [
    `${p}/s.js`,
    `${p}/S.js`,
    `${p}//s.js`,
    `${p.replace(/\//g, '\\')}\\s.js`,
    `${p}/s.js?`,
    `${p}/s.js#x`,
    `${p}/%73.js`,
    `${p.toUpperCase()}/s.js`,
    `${p}/./s.js`,
    `${p}/x/../s.js`,
    `${p}/\ts.js`,
    `${p}/s\n.js`,
    `${p}x/s.js`,
    `${p}s.js`,
    '/s.js',
    '/assets/s.js',
  ]
  const out = []
  for (const scheme of schemes) for (const h of hosts) for (const q of paths) out.push(scheme + h + q)
  for (const n of ['s.js', 'S.js', '%73.js', 'sub/../s.js', '../s.js', 's.js?v=1', 's.js#x', ' s.js', 's.js ']) {
    out.push(`asset://${n}`, ` asset://${n} `, `ASSET://${n}`, `\tasset://${n}\n`)
  }
  out.push('blob:https://world.example/1', 'Blob:443/s.js', 'blob/../assets/s.js', `${p}/s.js`, `//${host}${p}/s.js`)
  return out
}

test('scriptSource: every "certain store file" is exactly what the server loader and a client load', async () => {
  let checked = 0
  let certain = 0
  for (const base of BASES) {
    const store = name => new URL(`${base}/${name}`).href
    for (const spelling of spellings(base)) {
      checked++
      const source = scriptSource(spelling, base)
      if (source.source !== 'store') continue
      certain++
      const label = `${JSON.stringify(spelling)} with ${base}`
      for (const mode of [undefined, '/world/assets']) {
        requested.length = 0
        let text
        try {
          text = await loader(base, mode).fetchText(spelling)
        } catch (err) {
          assert.fail(`${label} is certain (${source.name}) but the server loader refuses it: ${err.message}`)
        }
        if (requested.length) {
          assert.equal(requested.length, 1)
          assert.equal(new URL(requested[0]).href, store(source.name), label)
        } else {
          // read from the assets directory (ASSETS=local): the file by that name
          assert.equal(text, `file:${path.join(mode, source.name)}`, label)
        }
      }
      for (const page of PAGES)
        assert.equal(clientRequest(spelling, base, page), store(source.name), `${label} on ${page}`)
    }
  }
  assert.ok(checked > 4000, `${checked} spellings`)
  assert.ok(certain > 60, `${certain} certain`)
  // the spellings Codex found, and others the runtime rewrites or refuses, are not certain
  for (const spelling of [
    'https:/world.example/assets/s.js',
    'ht\ttps://world.example/assets/s.js',
    'https:\t//world.example/assets/s.js',
    'HTTPS://world.example/assets/s.js',
    'https://user:pw@world.example/assets/s.js',
    'https://world.example/assetss.js',
  ]) {
    assert.equal(scriptSource(spelling, BASES[0]).source, 'unknown', JSON.stringify(spelling))
  }
})

test('scriptSource: nothing is certain with an assets base that is not clean (Codex: https:/…, ?rev=1)', () => {
  for (const base of [
    'https:/world.example/assets',
    'https://world.example/assets?rev=1',
    'https://world.example/assets#x',
    'https://user:pw@world.example/assets',
    'https://World.example/assets',
    'https://world.example/a/../assets',
  ]) {
    for (const spelling of ['asset://s.js', 'https://world.example/assets/s.js', 'https://world.example/assetss.js']) {
      assert.equal(scriptSource(spelling, base).source, 'unknown', `${spelling} with ${base}`)
    }
  }
})
