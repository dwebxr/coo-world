import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadClient } from './lib/clientHarness.mjs'
import { ASSET_PROTOCOL, resolveReference, scriptSource } from '../src/core/extras/assetURL.js'

// scriptSource says "this script is the store file X for certain" only where the runtime loads exactly X, on the
// server and on a client. The oracles are the real code: World.resolveURL, then ServerLoader.fetchText (with its
// outbound request function replaced by one that records the request) for the server, and the URL a browser's
// fetch requests (resolveURL's result resolved against the page) for a client, for a page at the origin root and at a sub-path, and for three assets bases (the
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
// the server loader fetches through its outbound request function (outboundFetch.js); the stand-in records the URL
// it is asked for, which is the request it would make
const recordRequest = async url => {
  requested.push(String(url))
  return { ok: true, status: 200, text: async () => 'code', arrayBuffer: async () => new ArrayBuffer(0) }
}
const ServerLoader = loadClient('core/systems/ServerLoader.js', 'ServerLoader', {
  createOutboundFetch: () => recordRequest,
  fetch: async url => {
    throw new Error(`the server loader used the global fetch for ${url}`)
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

// Codex: resolveReference put the base in with String.prototype.replace, so `$&`, `$'`, `` $` `` or `$$` in it were
// replacement patterns (https://world.example/$&/assets made asset://root.js a request for .../asset://assets/root.js)
test('resolveReference: the assets URL is put in literally, `$` sequences included', () => {
  for (const base of [
    'https://world.example/$&/assets',
    "https://world.example/$'/assets",
    'https://world.example/$`/a',
    'https://world.example/$$/a',
    'https://world.example/$1/a',
  ]) {
    assert.equal(resolveReference('asset://root.js', base), `${base}/root.js`)
    assert.equal(resolveURL.call({ assetsUrl: base }, 'asset://root.js'), `${base}/root.js`)
  }
})

// the same claim for assets bases generated from parts (seeded): whenever the clean-up takes a base as clean, every
// "certain store file" holds against the server loader and a client; with a base it refuses, nothing is certain
test('scriptSource: for every generated assets base it accepts, certainty holds on the server and a client', async () => {
  let seed = 0xba5e
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
  const pick = list => list[Math.floor(random() * list.length)]
  const schemes = ['https://', 'http://', 'HTTPS://', 'https:/', 'https:', 'https:///', ' https://', 'ht\ttps://']
  const hosts = [
    'world.example',
    'cdn.example',
    'World.example',
    'world.example:443',
    'world.example:8443',
    'user@world.example',
    'world.example.',
    'xn--wrld-zqa.example',
    'wörld.example',
  ]
  const parts = ['assets', 'a', 'w', '', '$&', "$'", '$`', '$$', '%61', '%2F', '.', '..', 'x\\y', 'A', 'ä', 'a b']
  const started = performance.now()
  let clean = 0
  let certain = 0
  for (let i = 0; i < 600; i++) {
    const segments = Array.from({ length: Math.floor(random() * 4) }, () => pick(parts))
    let base = `${pick(schemes)}${pick(hosts)}${segments.length ? `/${segments.join('/')}` : ''}`
    if (random() < 0.2) base += '/'
    if (random() < 0.1) base += pick(['?rev=1', '#x', '?'])
    const accepted = scriptSource('asset://s.js', base).source === 'store'
    const spellings = [
      'asset://s.js',
      ' asset://s.js ',
      'asset://S.js',
      `${base}/s.js`,
      `${base}//s.js`,
      `${base}/./s.js`,
      `${base}/s.js?`,
      `${base}/s.js#x`,
      `${base}/%73.js`,
      `${base}s.js`,
      `${base}/x/../s.js`,
      `${base.replace('://', ':/')}/s.js`,
      `${base.replace('https://', 'HTTPS://')}/s.js`,
      `${base.slice(0, 10)}\t${base.slice(10)}/s.js`,
      `${base}/s\n.js`,
    ]
    if (!accepted) {
      for (const spelling of spellings) {
        assert.notEqual(
          scriptSource(spelling, base).source,
          'store',
          `${JSON.stringify(spelling)} with ${JSON.stringify(base)}`
        )
      }
      continue
    }
    clean++
    const store = name => new URL(`${base}/${name}`).href
    for (const spelling of spellings) {
      const source = scriptSource(spelling, base)
      if (source.source !== 'store') continue
      certain++
      const label = `${JSON.stringify(spelling)} with ${JSON.stringify(base)}`
      for (const mode of [undefined, '/world/assets']) {
        requested.length = 0
        const text = await loader(base, mode).fetchText(spelling)
        if (requested.length) assert.equal(new URL(requested[0]).href, store(source.name), label)
        else assert.equal(text, `file:${path.join(mode, source.name)}`, label)
      }
      for (const page of PAGES)
        assert.equal(clientRequest(spelling, base, page), store(source.name), `${label} on ${page}`)
    }
  }
  assert.ok(clean > 20 && clean < 600, `${clean} clean bases`)
  assert.ok(certain > clean, `${certain} certain`)
  assert.ok(performance.now() - started < 2000)
})

test('scriptSource: nothing is certain with an assets base that is not clean (Codex: https:/…, ?rev=1)', () => {
  for (const base of [
    'https:/world.example/assets',
    'https://world.example/assets?rev=1',
    'https://world.example/assets#x',
    'https://user:pw@world.example/assets',
    'https://World.example/assets',
    'https://world.example/a/../assets',
    // Codex: the empty segment compared as /a/assets
    'https://world.example/a//assets',
    'https://world.example/assets/',
  ]) {
    for (const spelling of ['asset://s.js', 'https://world.example/assets/s.js', 'https://world.example/assetss.js']) {
      assert.equal(scriptSource(spelling, base).source, 'unknown', `${spelling} with ${base}`)
    }
  }
})
