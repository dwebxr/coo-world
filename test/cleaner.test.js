import assert from 'node:assert/strict'
import { test } from 'node:test'
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
  const assets = {
    list: async () => files,
    delete: async names => deleted.push(['assets', [...names].sort()]),
  }
  const collections = { blueprints: new Set() }
  const Cleaner = load('server/cleaner.js', 'Cleaner', { assets, collections })
  return { tables, db, deleted, warnings, files, collections, cleaner: new Cleaner() }
}

for (const [name, corrupt, id] of [
  ['entity JSON', f => f.tables.entities.push({ id: 'bad', data: '{' }), 'bad'],
  ['entity type', f => f.tables.entities.push(row({ ...appData(), id: 'bad', type: 'wrong' })), 'bad'],
  ['blueprint JSON', f => f.tables.blueprints.push({ id: 'bad', data: '{' }), 'bad'],
  ['blueprint model', f => f.tables.blueprints.push(row({ id: 'bad', version: 0, model: 123 })), 'bad'],
  [
    'nested asset url',
    f => (f.tables.blueprints[0] = row({ id: 'bp', version: 0, props: { nested: [{ file: { url: 123 } }] } })),
    'bp',
  ],
  [
    'orphan nested asset url',
    f => (f.tables.blueprints[1] = row({ id: 'orphan', version: 0, props: { nested: { url: 123 } } })),
    'orphan',
  ],
  ['settings JSON', f => (f.tables.config[0].value = '{'), 'settings'],
  ['settings shape', f => (f.tables.config[0].value = '[]'), 'settings'],
  ['settings asset', f => (f.tables.config[0].value = '{"image":{"url":123}}'), 'settings'],
  ['user avatar', f => f.tables.users.push({ id: 'user', avatar: 123 }), 'user'],
  [
    'collection asset',
    f => f.collections.blueprints.add({ id: 'collection', version: 0, props: { file: { url: 123 } } }),
    'collection',
  ],
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
