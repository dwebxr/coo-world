// The server's collections (src/server/collections.js): at start it reads every .hyp file the manifest of each
// collection in the world's `collections` folder names. That folder is the operator's data; a file importApp refuses
// is left out of its collection, and the start goes on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { load } from './lib/persistenceHarness.mjs'
import { importApp, exportApp, INVALID_HYP } from '../src/core/extras/appTools.js'

const hyp = async (id, bytes) => {
  const blueprint = { id, name: id, model: `asset://${id}.glb` }
  const file = await exportApp(blueprint, async () => new File([new Uint8Array(bytes).fill(1)], `${id}.glb`))
  return { blueprint, buffer: Buffer.from(await file.arrayBuffer()) }
}

// a world folder with these collections ({ id: { name, apps: { filename: buffer } } }), and the collections system
// read from it (`readApp` stands in for importApp)
async function start(t, collections, { readApp = importApp } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collections-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const rootDir = path.join(dir, 'root')
  fs.ensureDirSync(path.join(rootDir, 'src/world/collections'))
  const worldDir = path.join(dir, 'world')
  for (const [id, { name, apps, manifest }] of Object.entries(collections)) {
    const folder = path.join(worldDir, 'collections', id)
    fs.ensureDirSync(folder)
    for (const [filename, buffer] of Object.entries(apps)) fs.writeFileSync(path.join(folder, filename), buffer)
    fs.writeFileSync(path.join(folder, 'manifest.json'), manifest ?? JSON.stringify({ name, apps: Object.keys(apps) }))
  }
  const uploads = []
  const assets = { upload: async file => uploads.push(file.name) }
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')))
  const Collections = load('server/collections.js', 'Collections', {
    fs,
    path,
    importApp: readApp,
    INVALID_HYP,
    assets,
  })
  const system = new Collections()
  const started = system.init({ rootDir, worldDir })
  return { system, started, uploads, errors, worldDir }
}

test('collections: a .hyp file importApp refuses is left out and said, and the start goes on', async t => {
  const good = await hyp('good', 10)
  const other = await hyp('other', 4)
  // cut short: its asset is longer than the file (it used to load, with the asset cut)
  const cut = (await hyp('cut', 10)).buffer.subarray(0, -3)
  const f = await start(t, {
    default: { name: 'Default', apps: { 'Good.hyp': good.buffer, 'Cut.hyp': cut } },
    more: { name: 'More', apps: { 'Other.hyp': other.buffer } },
  })
  await f.started
  assert.deepEqual(
    f.system.list.map(c => [c.id, c.name, c.blueprints]),
    [
      ['default', 'Default', [good.blueprint]],
      ['more', 'More', [other.blueprint]],
    ]
  )
  assert.deepEqual([...f.system.blueprints], [good.blueprint, other.blueprint])
  assert.deepEqual(f.uploads, ['good.glb', 'other.glb'], 'nothing of the refused file is uploaded')
  assert.deepEqual(f.errors, [
    '[collections] default: Cut.hyp is left out: not a valid .hyp file: an asset is longer than the file',
  ])
})

test('collections: a file whose asset is not the file its stored address names is left out; other references as before', async t => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const ones = new Uint8Array(4).fill(1)
  const twos = new Uint8Array(4).fill(2)
  const app = async (id, url, bytes) => {
    const blueprint = { id, name: id, model: url }
    const file = await exportApp(blueprint, async () => new File([bytes], 'picked.glb'))
    return { blueprint, buffer: Buffer.from(await file.arrayBuffer()) }
  }
  // stored under its hash; another file's bytes under that address; a name that is no stored address (as `hyp` makes)
  const stored = await app('stored', `asset://${sha(ones)}.glb`, ones)
  const planted = await app('planted', `asset://${sha(ones)}.glb`, twos)
  const named = await hyp('named', 4)
  const f = await start(t, {
    default: {
      name: 'Default',
      apps: { 'Stored.hyp': stored.buffer, 'Planted.hyp': planted.buffer, 'Named.hyp': named.buffer },
    },
  })
  await f.started
  assert.deepEqual(f.system.list[0].blueprints, [stored.blueprint, named.blueprint])
  // every asset of a file that is kept is uploaded, as before: the store names each by the hash of its bytes
  assert.deepEqual(f.uploads, [`${sha(ones)}.glb`, 'named.glb'])
  assert.deepEqual(f.errors, [
    `[collections] default: Planted.hyp is left out: not a valid .hyp file: asset 1 (asset://${sha(ones)}.glb) is not the file its address names`,
  ])
})

test('collections: a file that cannot be read, a bad manifest or another failure still stops the start', async t => {
  const good = await hyp('good', 10)
  const missing = await start(t, { default: { manifest: JSON.stringify({ name: 'D', apps: ['Gone.hyp'] }), apps: {} } })
  await assert.rejects(missing.started, { code: 'ENOENT' })
  const manifest = await start(t, { default: { manifest: '{ not json', apps: { 'Good.hyp': good.buffer } } })
  await assert.rejects(manifest.started, /JSON/)
  // a failure of importApp that is not a refusal (no INVALID_HYP code) is not taken for one
  const failure = new Error('could not read the file')
  const other = await start(
    t,
    { default: { name: 'D', apps: { 'Good.hyp': good.buffer } } },
    { readApp: async () => Promise.reject(failure) }
  )
  await assert.rejects(other.started, err => err === failure)
  for (const f of [missing, manifest, other]) assert.deepEqual(f.errors, [])
})
