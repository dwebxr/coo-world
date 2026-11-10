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
  // the assets URL, and the assets directory as the store (ASSETS=local)
  const store = { assetsUrl: 'https://world.example/assets', localStore: true }
  const run = (options = store) => cleaner.init({ db, storageFile, ...options })
  return {
    store,
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
    await assert.doesNotReject(f.cleaner.init({ db: f.db, ...f.store }))
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
  await f.cleaner.init({ db: f.db, ...f.store })
  assert.deepEqual(f.deleted, [
    ['blueprints', 'orphan'],
    ['assets', ['unused.glb']],
  ])
  assert.deepEqual(f.warnings, [])
  f.deleted.length = 0
  process.env.CLEAN = 'dryrun'
  await f.cleaner.init({ db: f.db, ...f.store })
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

const UNCERTAIN = ids =>
  `[clean] skipped all deletion: kept blueprints run a script that is not a store file for certain ${JSON.stringify(ids)}; give them an asset:// script (upload it as an asset) so the clean-up can read it`

test('cleaner: a kept script that is not a store file for certain stops all deletion and says which', async t => {
  for (const script of [
    'https://code.example/app.js',
    'http://code.example/app.js',
    '//code.example/app.js',
    'code.example/app.js',
    // page paths land wherever the page is served from (Codex: a proxy can put another application at /assets/)
    '/assets/x.js',
    'blob/../assets/x.js',
    '/etc/app.js',
    // not the canonical spelling: what the server's loader and a browser make of these differs
    'ASSET://x.js',
    'asset://../x.js',
    'asset://%2e%2e%2fx.js',
    'asset://sub/../x.js',
    'asset://x.js?v=2',
    'asset://x.js#main',
    'asset://%61.js',
    // under the assets URL, but not directly or with a query
    'https://world.example/assets/sub/x.js',
    'https://world.example/assets/x.js?v=2',
    'https://world.example/other/x.js',
    // the URL parser refuses these
    'https://exa mple.com/app.js',
    'http://[::1/app.js',
  ]) {
    const f = fixture(t)
    f.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://used.glb', script })
    await f.run()
    assert.deepEqual(f.deleted, [], script)
    assert.deepEqual(f.warnings, [UNCERTAIN(['bp'])], script)
  }
  // a collection blueprint counts the same; an orphan's (deleted with it), a blob: URL (by its parsed scheme: a
  // browser tab's own object) and white space alone (no script) do not
  const f = fixture(t)
  f.collections.blueprints.add({ id: 'collection', version: 0, script: 'https://code.example/c.js' })
  await f.run()
  assert.deepEqual(f.deleted, [])
  assert.deepEqual(f.warnings, [UNCERTAIN(['collection'])])
  for (const [where, script] of [
    ['orphan', 'https://code.example/orphan.js'],
    ['bp', 'blob:nodedata:x'],
    ['bp', ' blob:https://world.example/1234'],
    ['bp', 'Blob:https://world.example/1234'],
    ['bp', '  \n'],
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

test('cleaner: a script that is a store file for certain is read: canonical asset://, or directly under the assets URL', async t => {
  const f = fixture(t)
  for (const name of ['s1.js', 's2.js', 's3.js', 'm1.glb', 'm2.glb', 'm3.glb']) f.files.add(name)
  // trimmed as the loaders trim it; the URL parser takes the case of a scheme and host and a default port away
  f.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://used.glb', script: ' asset://s1.js ' })
  f.collections.blueprints.add({ id: 'c2', version: 0, script: 'https://world.example/assets/s2.js' })
  f.collections.blueprints.add({ id: 'c3', version: 0, script: 'HTTPS://WORLD.EXAMPLE:443/assets/s3.js' })
  f.scripts.set('s1.js', "world.load('model', 'asset://m1.glb')")
  f.scripts.set('s2.js', "world.load('model', 'asset://m2.glb')")
  f.scripts.set('s3.js', "world.load('model', 'asset://m3.glb')")
  await f.run()
  assert.deepEqual(f.warnings, [])
  assert.deepEqual([...f.scriptReads].sort(), ['s1.js', 's2.js', 's3.js'])
  assert.deepEqual(f.deleted, [
    ['blueprints', 'orphan'],
    ['assets', ['unused.glb']],
  ])
})

// Codex: a kept http(s) store script naming its model through the CDN's protocol-relative URL, a `..` or an explicit
// default port; the prefix scan missed all three and the models were deleted without a warning
test('cleaner: a model named in a script by any URL spelling is kept (S3 behind a CDN)', async t => {
  const f = fixture(t)
  for (const name of ['s.js', 'm1.glb', 'm2.glb', 'm3.glb']) f.files.add(name)
  f.tables.blueprints[0] = row({
    id: 'bp',
    version: 0,
    model: 'asset://used.glb',
    script: 'https://cdn.example/prefix/assets/s.js',
  })
  f.scripts.set(
    's.js',
    `world.load('model', '//cdn.example/prefix/assets/m1.glb')
     world.load('model', 'asset://sub/../m2.glb')
     world.load('model', 'https://cdn.example:443/prefix/assets/m3.glb')`
  )
  await f.run({ assetsUrl: 'https://cdn.example/prefix/assets', localStore: false })
  assert.deepEqual(f.warnings, [])
  assert.deepEqual(f.scriptReads, ['s.js'])
  assert.deepEqual(f.deleted.at(-1), ['assets', ['unused.glb']])
})

// Codex: ASSETS_BASE_URL=//cdn.example/assets (start-up accepts it) made every asset:// reference look external, and
// the models were deleted
test('cleaner: an assets URL that is not an absolute http(s) URL deletes nothing', async t => {
  for (const assetsUrl of ['//cdn.example/assets', '/assets', 'assets', 'ftp://cdn.example/assets', '', undefined]) {
    const f = fixture(t)
    await f.run({ assetsUrl, localStore: true })
    assert.deepEqual(f.deleted, [], String(assetsUrl))
    assert.equal(f.warnings.length, 1)
    assert.match(f.warnings[0], /^\[clean\] skipped all deletion: the assets URL is not an absolute http\(s\) URL/)
  }
})

// Codex: with S3 behind a CDN, a script missing from the bucket may still be served (cached) and run; taking the
// miss as "names nothing" deleted what it loads. Locally the file system is the store, so a miss names nothing.
test('cleaner: a store script missing from S3 deletes nothing; one missing locally names nothing', async t => {
  const f = fixture(t)
  f.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://used.glb', script: 'asset://gone.js' })
  await f.run({ assetsUrl: 'https://cdn.example/assets', localStore: false })
  assert.deepEqual(f.deleted, [])
  assert.deepEqual(f.warnings, [
    '[clean] skipped all deletion: could not read ["script gone.js (not in the S3 store; a CDN may still serve it)"]',
  ])
  const g = fixture(t)
  g.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://used.glb', script: 'asset://gone.js' })
  await g.run()
  assert.deepEqual(g.warnings, [])
  assert.deepEqual(g.deleted.at(-1), ['assets', ['unused.glb']])
})

// the two gaps Codex found in both earlier versions
test('cleaner: a model given by the page origin with a separate CDN, or in another case, is kept', async t => {
  const f = fixture(t)
  for (const name of ['page.glb', 'abc.glb']) f.files.add(name)
  // the assets URL is the CDN; the page's own server serves /assets/ too
  f.tables.entities[0] = row({ ...appData(), props: { model: 'https://world.example/assets/page.glb' } })
  // a case-insensitive file system loads asset://ABC.GLB from abc.glb
  f.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://ABC.GLB' })
  await f.run({ assetsUrl: 'https://cdn.example/assets', localStore: true })
  assert.deepEqual(f.warnings, [])
  assert.deepEqual(f.deleted.at(-1), ['assets', ['unused.glb', 'used.glb']])
})

test('cleaner: names are found wherever they stand in a source, in any case or percent-encoded; not when escaped or assembled', async t => {
  const f = fixture(t)
  const kept = ['q.glb', 'cat.glb', 'up.glb', 'pct.glb', 'twice.glb', 'dot.glb', 'under.glb']
  const gone = ['esc.glb', 'asm.glb']
  for (const name of [...kept, ...gone]) f.files.add(name)
  f.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://used.glb', script: 'asset://app.js' })
  f.scripts.set(
    'app.js',
    `fetch('/api/x?model=q.glb&v=2')
     const base = 'https://cdn.example/assets/'
     world.load('model', base + 'cat.glb')
     world.load('model', 'asset://UP.GLB')
     world.load('model', 'asset://%70ct.glb')
     world.load('model', 'asset://%2574wice.glb')
     // see dot.glb.
     const markdown = '_under.glb_'
     // what the scan cannot see:
     world.load('model', 'asset://\\x65sc.glb')
     world.load('model', 'asset://' + 'asm' + '.glb')`
  )
  await f.run()
  assert.deepEqual(f.warnings, [])
  assert.deepEqual(f.deleted.at(-1), ['assets', [...gone, 'unused.glb'].sort()])
})

test("cleaner: a name like the bundled world's (ai.glb) or a common word is matched like any other", async t => {
  const f = fixture(t)
  // the store lists only uploaded (hash-named) files, but the scan works for any valid name; keeping a file named
  // like a common word whenever the word appears is the safe direction
  for (const name of ['ai.glb', 'model', 'odd name.glb']) f.files.add(name)
  f.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://used.glb', props: { brain: 'asset://ai.glb' } })
  await f.run()
  assert.deepEqual(f.warnings, [])
  // `model` is a key of the blueprint; a listed name no token can match ('odd name.glb') is kept
  assert.deepEqual(f.deleted.at(-1), ['assets', ['unused.glb']])
  // a listed script with such a name cannot be read by name: nothing is deleted
  const g = fixture(t)
  g.files.add('odd name.js')
  await g.run()
  assert.deepEqual(g.deleted, [])
  assert.match(g.warnings[0], /could not read \["script \\"odd name\.js\\" \(a name the clean-up cannot read\)"\]/)
})

test('cleaner: scripts are followed to a fixed point: a kept .js file is read, and what it names is kept in turn', async t => {
  const f = fixture(t)
  for (const name of ['level1.js', 'level2.js', 'level3.js', 'deep.glb', 'loose.js']) f.files.add(name)
  f.tables.blueprints[0] = row({ id: 'bp', version: 0, model: 'asset://used.glb', script: 'asset://level1.js' })
  f.scripts.set('level1.js', "const next = 'asset://level2.js'")
  f.scripts.set('level2.js', "const next = 'level3.js'")
  f.scripts.set('level3.js', "world.load('model', 'asset://deep.glb')")
  f.scripts.set('loose.js', "world.load('model', 'asset://used.glb')")
  await f.run()
  assert.deepEqual(f.warnings, [])
  assert.deepEqual(f.scriptReads, ['level1.js', 'level2.js', 'level3.js'])
  // nothing names loose.js, so it is not read and is deleted
  assert.deepEqual(f.deleted.at(-1), ['assets', ['loose.js', 'unused.glb']])
})

test('cleaner: unreferenced files are still deleted, with their count; a dry run names the same set and deletes nothing', async t => {
  const logs = []
  const f = fixture(t)
  t.mock.method(console, 'log', line => logs.push(line))
  for (const name of ['gone1.glb', 'gone2.png']) f.files.add(name)
  process.env.CLEAN = 'dryrun'
  await f.run()
  assert.deepEqual(f.deleted, [])
  assert.ok(logs.includes('[clean] 3 assets can be deleted: ["gone1.glb","gone2.png","unused.glb"]'), logs.join('\n'))
  logs.length = 0
  process.env.CLEAN = 'true'
  await f.run()
  assert.deepEqual(f.deleted.at(-1), ['assets', ['gone1.glb', 'gone2.png', 'unused.glb']])
  assert.ok(logs.includes('[clean] 3 assets can be deleted'), logs.join('\n'))
  assert.ok(logs.includes('[clean] 3 assets deleted'), logs.join('\n'))
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
  await new Cleaner().init({ db: f.db, storageFile: f.storageFile, ...f.store })
  assert.ok(logs.includes('[clean] 1 assets deleted'), logs.join('\n'))
  assert.ok(logs.includes('[clean] 2 assets can be deleted'), logs.join('\n'))
  assert.deepEqual(f.warnings, ['[clean] 1 assets could not be deleted: ["denied.glb (AccessDenied)"]'])
})
