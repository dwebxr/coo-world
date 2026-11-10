import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { pathToFileURL } from 'node:url'

// storage.js picks its implementation when it is imported, and in Node that one reads and writes a file next to
// the sources. The browser class is tested from a bundle of the module evaluated as a browser would
// (window defined), so the repository's localstorage.json is never touched.
async function loadBrowserStorage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outfile = path.join(dir, 'storage.mjs')
  await esbuild.build({
    entryPoints: [new URL('../src/core/storage.js', import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: 'const window = {};' },
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile))
}

function fakeLocalStorage() {
  const items = new Map()
  return {
    items,
    getItem: key => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: key => items.delete(key),
  }
}

test('browser storage: values round-trip, and a stored false or 0 is not replaced by the default', async t => {
  const { LocalStorage } = await loadBrowserStorage(t)
  const backend = fakeLocalStorage()
  const storage = new LocalStorage(() => backend)
  assert.equal(storage.get('missing'), null)
  assert.equal(storage.get('missing', 'fallback'), 'fallback')
  storage.set('prefs', { shadows: 'high' })
  assert.deepEqual(storage.get('prefs'), { shadows: 'high' })
  assert.equal(backend.items.get('prefs'), '{"shadows":"high"}')
  storage.set('collapsed', false)
  storage.set('width', 0)
  assert.equal(storage.get('collapsed', true), false)
  assert.equal(storage.get('width', 500), 0)
  storage.set('prefs', null)
  assert.equal(backend.items.has('prefs'), false)
  storage.remove('width')
  assert.equal(storage.get('width', 500), 500)
  // a damaged entry reads as the default
  t.mock.method(console, 'error', () => {})
  backend.items.set('broken', '{not json')
  assert.equal(storage.get('broken', 'fallback'), 'fallback')
})

test('browser storage: when the browser refuses localStorage the client still runs, on memory', async t => {
  const { LocalStorage } = await loadBrowserStorage(t)
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  const denied = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  // every access throws, including reading the global itself
  const storage = new LocalStorage(denied)
  assert.equal(storage.get('authToken'), null)
  assert.deepEqual(storage.get('prefs', {}), {})
  storage.set('authToken', 'abc')
  assert.equal(storage.get('authToken'), 'abc')
  storage.set('prefs', { ui: 1 })
  assert.deepEqual(storage.get('prefs', {}), { ui: 1 })
  storage.remove('authToken')
  assert.equal(storage.get('authToken'), null)
  assert.equal(warnings.length, 1, 'said once')
  assert.match(warnings[0], /SecurityError/)

  // a write that fails (quota) keeps the value for this page; reads of other keys still use the store
  const backend = fakeLocalStorage()
  backend.items.set('kept', '"from disk"')
  backend.setItem = () => {
    throw new DOMException('quota', 'QuotaExceededError')
  }
  const full = new LocalStorage(() => backend)
  full.set('big', { a: 1 })
  assert.deepEqual(full.get('big'), { a: 1 })
  assert.equal(full.get('kept'), 'from disk')
})
