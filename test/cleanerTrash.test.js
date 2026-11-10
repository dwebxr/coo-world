import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleServer } from './lib/serverBundle.mjs'
import { load, appData } from './lib/persistenceHarness.mjs'

// The clean-up with ASSETS=local and a real AssetsLocal in a temporary world: what it removes goes to
// <world>/assets-trash/<UTC date>/, is removed for good after CLEAN_TRASH_DAYS, and comes back when named again.

let bundle, AssetsLocal
before(async () => {
  bundle = await bundleServer(`export { AssetsLocal } from './src/server/AssetsLocal.js'`)
  ;({ AssetsLocal } = bundle.module)
})
after(() => bundle?.destroy())

// uploaded-asset names (a 64-character hash), the only ones the store lists
const name = (label, ext = 'glb') => `${createHash('sha256').update(label).digest('hex')}.${ext}`
const KEPT = name('kept')
const GONE = name('gone')
const row = data => ({ id: data.id, data: JSON.stringify(data) })
const NOW = Date.parse('2026-11-10T12:00:00Z')
const TODAY = '2026-11-10'

async function world(t) {
  t.mock.method(console, 'log', line => logs.push(line))
  const logs = []
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  const oldClean = process.env.CLEAN
  process.env.CLEAN = 'true'
  const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-world-'))
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-root-'))
  t.after(() => {
    if (oldClean === undefined) delete process.env.CLEAN
    else process.env.CLEAN = oldClean
    fs.rmSync(worldDir, { recursive: true, force: true })
    fs.rmSync(rootDir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(rootDir, 'src/world/assets'), { recursive: true })
  const assets = new AssetsLocal()
  await assets.init({ rootDir, worldDir })
  const trashDir = path.join(worldDir, 'assets-trash')
  const put = (file, text = file) => fs.writeFileSync(path.join(assets.dir, file), text)
  const trash = (day, file, text = file) => {
    fs.mkdirSync(path.join(trashDir, day), { recursive: true })
    fs.writeFileSync(path.join(trashDir, day, file), text)
  }
  const inStore = file => fs.existsSync(path.join(assets.dir, file))
  const inTrash = (day, file) => fs.existsSync(path.join(trashDir, day, file))
  put(KEPT)
  put(GONE)
  const tables = {
    entities: [row(appData())],
    blueprints: [row({ id: 'bp', version: 0, model: `asset://${KEPT}` })],
    config: [{ key: 'settings', value: '{}' }],
    users: [],
  }
  const db = table =>
    Object.assign(Promise.resolve(tables[table]), {
      select: async () => tables[table],
      where: (key, value) => ({
        first: async () => tables[table].find(item => item[key] === value),
        delete: async () => {},
      }),
    })
  const Cleaner = load('server/cleaner.js', 'Cleaner', {
    assets,
    collections: { blueprints: new Set() },
    fs: fs.promises,
    path,
  })
  logs.length = 0
  const run = (options = {}) =>
    new Cleaner().init({
      db,
      storageFile: path.join(worldDir, 'storage.json'),
      assetsUrl: 'https://world.example/assets',
      localStore: true,
      trashDays: 30,
      now: () => NOW,
      ...options,
    })
  return { assets, worldDir, trashDir, put, trash, inStore, inTrash, tables, run, logs, warnings }
}

test('clean-up trash: an unreferenced file is moved to the trash folder of the day, not unlinked', async t => {
  const w = await world(t)
  await w.run()
  assert.equal(w.inStore(GONE), false)
  assert.equal(w.inTrash(TODAY, GONE), true)
  assert.equal(w.inStore(KEPT), true)
  assert.ok(
    w.logs.includes(`[clean] 1 assets moved to ${path.join(w.trashDir, TODAY)} (removed for good after 30 days)`),
    w.logs.join('\n')
  )
  // beside the assets directory, never inside it: not listed, not found by an upload check
  assert.equal(path.dirname(w.trashDir), path.dirname(w.assets.dir))
  assert.deepEqual([...(await w.assets.list())], [KEPT])
  assert.equal(await w.assets.exists(GONE), false)
  assert.deepEqual(w.warnings, [])
})

test('clean-up trash: folders at least CLEAN_TRASH_DAYS old are removed, younger ones stay', async t => {
  const w = await world(t)
  w.trash('2026-10-10', name('old')) // 31 days and 12 hours before NOW
  w.trash('2026-10-11', name('edge')) // 30 days and 12 hours: also at least 30 days
  w.trash('2026-10-12', name('young')) // 29 days and 12 hours
  await w.run()
  assert.equal(fs.existsSync(path.join(w.trashDir, '2026-10-10')), false)
  assert.equal(fs.existsSync(path.join(w.trashDir, '2026-10-11')), false)
  assert.equal(w.inTrash('2026-10-12', name('young')), true)
  assert.ok(
    w.logs.includes('[clean] removed 2 trash folders at least 30 days old (2 files): ["2026-10-10","2026-10-11"]'),
    w.logs.join('\n')
  )
})

test('clean-up trash: a trashed file named again comes back, a trashed script is followed where it lies', async t => {
  const w = await world(t)
  const model = name('model')
  const script = name('script', 'js')
  const dep = name('dep')
  w.trash('2026-11-05', model)
  w.trash('2026-11-05', script, `world.load('model', 'asset://${dep}')`)
  w.trash('2026-11-01', dep)
  w.tables.blueprints[0] = row({ id: 'bp', version: 0, model: `asset://${KEPT}`, script: `asset://${script}` })
  w.tables.entities[0] = row({ ...appData(), props: { model: `https://cdn.example/assets/${model}` } })
  await w.run()
  for (const file of [model, script, dep]) assert.equal(w.inStore(file), true, file)
  assert.equal(w.inTrash('2026-11-05', model), false)
  assert.equal(w.warnings.length, 1)
  assert.equal(
    w.warnings[0],
    `[clean] 3 assets named again came back from the trash: ${JSON.stringify([model, script, dep].sort())}`
  )
  assert.equal(w.inTrash(TODAY, GONE), true)
})

test('clean-up trash: what is named comes back even when deletion stops; the trash is not purged then', async t => {
  const w = await world(t)
  const model = name('model')
  w.trash('2026-09-01', name('ancient'))
  w.trash('2026-11-05', model)
  w.tables.entities[0] = row({ ...appData(), props: { model: `asset://${model}` } })
  // a script from elsewhere: discovery is incomplete
  w.tables.blueprints[0] = row({ id: 'bp', version: 0, model: `asset://${KEPT}`, script: 'https://code.example/x.js' })
  await w.run()
  assert.equal(w.inStore(model), true)
  assert.equal(w.inStore(GONE), true, 'nothing removed')
  assert.equal(w.inTrash('2026-09-01', name('ancient')), true, 'nothing purged')
  assert.match(w.warnings.at(-1), /skipped all deletion: kept blueprints run a script that is not a store file/)
})

test('clean-up trash: CLEAN_TRASH_DAYS=0 deletes at once and empties the trash', async t => {
  const w = await world(t)
  w.trash('2026-11-09', name('yesterday'))
  await w.run({ trashDays: 0 })
  assert.equal(w.inStore(GONE), false)
  assert.equal(fs.existsSync(path.join(w.trashDir, TODAY)), false, 'not moved: deleted')
  assert.equal(fs.existsSync(path.join(w.trashDir, '2026-11-09')), false)
  assert.ok(w.logs.includes('[clean] 1 assets deleted'), w.logs.join('\n'))
})

test('clean-up trash: the trash is never store content: a trashed script nothing names is not read', async t => {
  const w = await world(t)
  const unnamed = name('unnamed', 'js')
  const onlyThere = name('only-there')
  w.put(onlyThere)
  w.trash('2026-11-05', unnamed, `world.load('model', 'asset://${onlyThere}')`)
  await w.run()
  // the trashed script's source keeps nothing; it stays in the trash
  assert.equal(w.inStore(onlyThere), false)
  assert.equal(w.inTrash(TODAY, onlyThere), true)
  assert.equal(w.inTrash('2026-11-05', unnamed), true)
  assert.equal(w.inStore(unnamed), false)
})

test('clean-up trash: a name both in the store and the trash (an interrupted or repeated move) is handled', async t => {
  const w = await world(t)
  // the unreferenced one moved earlier today and uploaded again since: the newer copy replaces it in the trash
  w.trash(TODAY, GONE, 'older copy')
  w.put(GONE, 'newer copy')
  // the referenced one also left a copy in an earlier folder: the store's stays, nothing is restored over it
  w.trash('2026-11-05', KEPT, 'trashed copy')
  w.put(KEPT, 'store copy')
  await w.run()
  assert.equal(w.inStore(GONE), false)
  assert.equal(fs.readFileSync(path.join(w.trashDir, TODAY, GONE), 'utf8'), 'newer copy')
  assert.equal(fs.readFileSync(path.join(w.assets.dir, KEPT), 'utf8'), 'store copy')
  assert.equal(w.inTrash('2026-11-05', KEPT), true, 'left for its folder to be purged')
  assert.deepEqual(w.warnings, [], 'nothing came back')
  // a copy that left the trash before it could come back has nothing to restore, and stops nothing
  const vanished = name('vanished')
  w.trash('2026-11-06', vanished)
  const trashed = await w.assets.trashed()
  fs.rmSync(path.join(w.trashDir, '2026-11-06', vanished))
  assert.deepEqual(await w.assets.restoreFromTrash([vanished], trashed), { restored: [], failed: [] })
})

test('clean-up trash: a dry run says what would move, be purged and come back, and changes nothing', async t => {
  const w = await world(t)
  const model = name('model')
  w.trash('2026-10-01', name('old'))
  w.trash('2026-11-05', model)
  w.tables.entities[0] = row({ ...appData(), props: { model: `asset://${model}` } })
  process.env.CLEAN = 'dryrun'
  await w.run()
  assert.equal(w.inStore(GONE), true)
  assert.equal(w.inStore(model), false)
  assert.equal(w.inTrash('2026-11-05', model), true)
  assert.equal(w.inTrash('2026-10-01', name('old')), true)
  assert.deepEqual(w.warnings, [`[clean] dry run: 1 assets would come back from the trash: ${JSON.stringify([model])}`])
  assert.ok(
    w.logs.includes('[clean] dry run: would remove 1 trash folders at least 30 days old (1 files): ["2026-10-01"]'),
    w.logs.join('\n')
  )
  assert.ok(w.logs.includes(`[clean] 1 assets can be moved to the trash: ${JSON.stringify([GONE])}`), w.logs.join('\n'))
})
