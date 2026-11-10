import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { load, appData } from './lib/persistenceHarness.mjs'

const row = data => ({ id: data.id, data: JSON.stringify(data) })

function fixture(t) {
  t.mock.method(console, 'log', () => {})
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  const oldClean = process.env.CLEAN
  process.env.CLEAN = 'true'
  t.after(() => {
    if (oldClean === undefined) delete process.env.CLEAN
    else process.env.CLEAN = oldClean
  })
  const tables = {
    entities: [row(appData())],
    blueprints: [row({ id: 'bp', version: 0, model: 'asset://used.glb' }), row({ id: 'orphan', version: 0 })],
    config: [{ key: 'settings', value: '{}' }],
    users: [],
  }
  const deleted = []
  const reads = new Set()
  const db = table => {
    reads.add(table)
    const rows = tables[table]
    return Object.assign(Promise.resolve(rows), {
      select: async () => rows,
      where: (key, value) => ({
        first: async () => rows.find(row => row[key] === value),
        delete: async () => {
          assert.deepEqual([...reads].sort(), ['blueprints', 'config', 'entities', 'users'])
          deleted.push([table, value])
        },
      }),
    })
  }
  const files = new Set(['used.glb', 'unused.glb'])
  const scripts = new Map()
  const scriptReads = []
  const assets = {
    list: async () => files,
    delete: async names => deleted.push(['assets', [...names].sort()]),
    readText: async name => {
      scriptReads.push(name)
      const text = scripts.get(name)
      if (text instanceof Error) throw text
      return text ?? null
    },
  }
  const collections = { blueprints: new Set() }
  const Cleaner = load('server/cleaner.js', 'Cleaner', { assets, collections, fs: fs.promises, path })
  const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-world-'))
  t.after(() => fs.rmSync(worldDir, { recursive: true, force: true }))
  const storageFile = path.join(worldDir, 'storage.json')
  const cleaner = new Cleaner()
  const run = () => cleaner.init({ db, storageFile })
  return {
    tables,
    db,
    deleted,
    warnings,
    files,
    collections,
    cleaner,
    run,
    scripts,
    scriptReads,
    worldDir,
    storageFile,
  }
}

for (const [name, corrupt, id] of [
  ['entity JSON', f => f.tables.entities.push({ id: 'bad', data: '{' }), 'bad'],
  ['entity type', f => f.tables.entities.push(row({ ...appData(), id: 'bad', type: 'wrong' })), 'bad'],
  ['blueprint JSON', f => f.tables.blueprints.push({ id: 'bad', data: '{' }), 'bad'],
  ['blueprint model', f => f.tables.blueprints.push(row({ id: 'bad', version: 0, model: 123 })), 'bad'],
  ['settings JSON', f => (f.tables.config[0].value = '{'), 'settings'],
  ['settings shape', f => (f.tables.config[0].value = '[]'), 'settings'],
  ['settings asset', f => (f.tables.config[0].value = '{"image":{"url":123}}'), 'settings'],
  ['user avatar', f => f.tables.users.push({ id: 'user', avatar: 123 }), 'user'],
]) {
  test(`cleaner: malformed ${name} skips every deletion for this boot`, async t => {
    const f = fixture(t)
    corrupt(f)
    await assert.doesNotReject(f.cleaner.init({ db: f.db }))
    assert.deepEqual(f.deleted, [])
    assert.equal(f.warnings.length, 1)
    assert.match(f.warnings[0], /skipped all deletion/)
    assert.ok(f.warnings[0].includes(`"id":"${id}"`))
  })
}

test('cleaner: persisted nested and unknown references stay reachable, then ordinary orphans are removed', async t => {
  const f = fixture(t)
  f.tables.blueprints[0] = row({
    id: 'bp',
    version: 0,
    model: 'asset://used.glb',
    props: { nested: [{ file: { url: 'asset://nested.glb?s=1' } }] },
    legacy: { file: 'asset://legacy.glb' },
  })
  f.tables.entities[0] = row({ ...appData(), legacy: { url: 'asset://entity.glb' } })
  f.tables.config[0].value = JSON.stringify({
    image: { url: 'asset://image.png' },
    extra: { url: 'asset://extra.png' },
  })
  f.tables.users.push({ id: 'user', avatar: 'asset://avatar.vrm' })
  f.collections.blueprints.add({ id: 'collection', version: 0, props: { nested: [{ url: 'asset://collection.glb' }] } })
  for (const name of [
    'nested.glb',
    'legacy.glb',
    'entity.glb',
    'image.png',
    'extra.png',
    'avatar.vrm',
    'collection.glb',
  ]) {
    f.files.add(name)
  }
  await f.cleaner.init({ db: f.db })
  assert.deepEqual(f.deleted, [
    ['blueprints', 'orphan'],
    ['assets', ['unused.glb']],
  ])
  assert.deepEqual(f.warnings, [])
  f.deleted.length = 0
  process.env.CLEAN = 'dryrun'
  await f.cleaner.init({ db: f.db })
  assert.deepEqual(f.deleted, [])
})

test('cleaner: an asset named only in script storage (world.set) is kept; once the value is gone it is deleted', async t => {
  const f = fixture(t)
  for (const name of ['stored.glb', 'deep.png', 'key.vrm', 'stored.glb.']) f.files.add(name)
  fs.writeFileSync(
    f.storageFile,
    JSON.stringify({
      note: 'loads asset://stored.glb.',
      deep: { list: [1, { url: 'asset://deep.png?s=1' }] },
      'asset://key.vrm': true,
    })
  )
  await f.run()
  assert.deepEqual(f.deleted, [
    ['blueprints', 'orphan'],
    ['assets', ['unused.glb']],
  ])
  assert.ok(fs.existsSync(f.storageFile), 'storage.json is only read')
  f.deleted.length = 0
  fs.writeFileSync(f.storageFile, JSON.stringify({ note: 'nothing' }))
  await f.run()
  assert.deepEqual(f.deleted.at(-1), ['assets', ['deep.png', 'key.vrm', 'stored.glb', 'stored.glb.', 'unused.glb']])
})

test('cleaner: a storage.json that cannot be read or parsed deletes nothing; a quarantined copy still keeps its assets', async t => {
  const f = fixture(t)
  f.files.add('quarantined.glb')
  fs.writeFileSync(f.storageFile, '{"half":')
  await f.run()
  assert.deepEqual(f.deleted, [])
  assert.deepEqual(f.warnings, ['[clean] skipped all deletion: could not read ["storage.json does not parse"]'])
  // Storage moves such a file aside at start-up: its text is still scanned
  fs.renameSync(f.storageFile, `${f.storageFile}.corrupt-2026-11-10T00-00-00-000Z`)
  fs.appendFileSync(`${f.storageFile}.corrupt-2026-11-10T00-00-00-000Z`, '"asset://quarantined.glb"')
  await f.run()
  assert.deepEqual(f.deleted.at(-1), ['assets', ['unused.glb']])
  f.deleted.length = 0
  f.warnings.length = 0
  fs.mkdirSync(f.storageFile)
  await f.run()
  assert.deepEqual(f.deleted, [])
  assert.match(f.warnings[0], /skipped all deletion: could not read \["storage\.json \(EISDIR\)"\]/)
})

test('cleaner: asset:// literals in the scripts of kept blueprints count as references', async t => {
  const f = fixture(t)
  for (const name of ['initial.glb', 'loaded.vrm', 'orphan-only.glb', 'other.png']) f.files.add(name)
  f.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://used.glb', script: 'asset://app.js' })
  f.tables.blueprints[1] = row({ id: 'orphan', version: 0, script: 'asset://orphan.js' })
  f.collections.blueprints.add({ id: 'collection', version: 0, script: 'asset://collection.js' })
  f.scripts.set(
    'app.js',
    `app.configure([{ key: 'model', type: 'model', initial: { url: 'asset://initial.glb' } }])
     world.load('avatar', "asset://loaded.vrm")`
  )
  f.scripts.set('orphan.js', "world.load('model', 'asset://orphan-only.glb')")
  f.scripts.set('collection.js', 'const image = `asset://other.png`')
  await f.run()
  assert.deepEqual(f.scriptReads.sort(), ['app.js', 'collection.js'], 'an orphan blueprint script is not read')
  assert.deepEqual(f.deleted, [
    ['blueprints', 'orphan'],
    ['assets', ['orphan-only.glb', 'unused.glb']],
  ])
})

test('cleaner: a script that cannot be read deletes nothing; a missing one names nothing', async t => {
  const f = fixture(t)
  f.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://used.glb', script: 'asset://app.js' })
  f.scripts.set('app.js', Object.assign(new Error('denied'), { code: 'EACCES' }))
  await f.run()
  assert.deepEqual(f.deleted, [])
  assert.deepEqual(f.warnings, ['[clean] skipped all deletion: could not read ["script app.js (EACCES)"]'])
  f.scripts.delete('app.js')
  await f.run()
  assert.deepEqual(f.deleted, [
    ['blueprints', 'orphan'],
    ['assets', ['unused.glb']],
  ])
})

test('cleaner: props holding a non-string url (or an empty asset://) are skipped, not a reason to stop cleaning', async t => {
  const f = fixture(t)
  f.tables.blueprints[0] = row({
    id: 'bp',
    version: 0,
    model: 'asset://used.glb',
    props: { nested: [{ file: { url: 123 } }, { url: { url: 'asset://inside.glb' } }, 'asset://', 'asset://?x'] },
  })
  f.tables.blueprints[1] = row({ id: 'orphan', version: 0, props: { nested: { url: 123 } } })
  f.tables.entities[0] = row({ ...appData(), state: { url: false } })
  f.collections.blueprints.add({ id: 'collection', version: 0, props: { file: { url: 123 } } })
  f.files.add('inside.glb')
  await f.run()
  assert.deepEqual(f.warnings, [])
  assert.deepEqual(f.deleted, [
    ['blueprints', 'orphan'],
    ['assets', ['unused.glb']],
  ])
})

test('cleaner: a kept blueprint whose script is loaded from elsewhere stops all deletion and says which', async t => {
  for (const script of [
    'https://code.example/app.js',
    'http://code.example/app.js',
    '//code.example/app.js',
    'code.example/app.js',
  ]) {
    const f = fixture(t)
    f.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://used.glb', script })
    await f.run()
    assert.deepEqual(f.deleted, [], script)
    assert.deepEqual(f.warnings, [
      '[clean] skipped all deletion: kept blueprints load their script from elsewhere ["bp"]; upload those scripts as assets (asset://) so the clean-up can read them',
    ])
  }
  // a collection blueprint counts the same; an orphan's (deleted with it) and a path or blob (never loaded) do not
  const f = fixture(t)
  f.collections.blueprints.add({ id: 'collection', version: 0, script: 'https://code.example/c.js' })
  await f.run()
  assert.deepEqual(f.deleted, [])
  assert.match(f.warnings[0], /from elsewhere \["collection"\]/)
  for (const [where, script] of [
    ['orphan', 'https://code.example/orphan.js'],
    ['bp', '/etc/app.js'],
    ['bp', 'blob:nodedata:x'],
  ]) {
    const g = fixture(t)
    const data =
      where === 'bp'
        ? { id: 'bp', version: 0, model: 'asset://used.glb', script }
        : { id: 'orphan', version: 0, script }
    g.tables.blueprints[where === 'bp' ? 0 : 1] = row(data)
    await g.run()
    assert.deepEqual(g.warnings, [], `${where} ${script}`)
    assert.deepEqual(g.deleted.at(-1), ['assets', ['unused.glb']])
  }
})

test('cleaner: assets the store could not delete are reported, not counted as deleted', async t => {
  const f = fixture(t)
  const logs = []
  t.mock.method(console, 'log', line => logs.push(line))
  f.files.add('denied.glb')
  // the S3 store answers per key (AssetsS3.delete)
  const assets = {
    list: async () => f.files,
    delete: async () => ({ failed: [{ name: 'denied.glb', code: 'AccessDenied' }] }),
    readText: async () => null,
  }
  const Cleaner = load('server/cleaner.js', 'Cleaner', { assets, collections: f.collections, fs: fs.promises, path })
  await new Cleaner().init({ db: f.db, storageFile: f.storageFile })
  assert.ok(logs.includes('[clean] 1 assets deleted'), logs.join('\n'))
  assert.ok(logs.includes('[clean] 2 assets can be deleted'), logs.join('\n'))
  assert.deepEqual(f.warnings, ['[clean] 1 assets could not be deleted: ["denied.glb (AccessDenied)"]'])
})
