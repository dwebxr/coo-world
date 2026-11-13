import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { load } from './lib/persistenceHarness.mjs'
import { loadNetwork, makeNetwork } from './lib/network.mjs'
import { database, deferred, fixture as persistenceFixture } from './lib/persistenceFixture.mjs'
import { Storage } from '../src/server/Storage.js'
import { installShutdown } from '../src/server/shutdown.js'

const net = await loadNetwork()
const { Settings } = net
const fixture = (t, db) => persistenceFixture(t, { net, db })

const ServerAI = load('core/systems/ServerAI.js', 'ServerAI', {
  fs: { readFileSync: () => '' },
  path,
  __dirname: '.',
  hashFile: async () => 'hash',
  process: { env: {} },
})

for (const action of ['create', 'edit', 'fix', 'classify']) {
  test(`persistence: AI ${action} records its blueprint before broadcast and rebuild`, { timeout: 5000 }, async t => {
    const { db, tables } = database()
    const { network, world } = fixture(t, db)
    const ai = new ServerAI(world)
    ai.client = { [action]: async () => (action === 'classify' ? 'name' : 'app.on("init", () => {})') }
    ai.assets = { upload: async () => {} }
    if (action === 'create') ai.classify = () => {}
    // edit and fix read only an asset:// script
    world.blueprints.get('bp').script = 'asset://old.js'
    world.loader = { get: () => ({ code: 'app.on("init", () => {})' }) }
    network.send = () => world.fatal('test')
    world.blueprints.modify = () => {
      throw new Error('rebuild failed')
    }
    // (a job of ServerAI.run that has not ended)
    const job = { signal: new AbortController().signal }
    await assert.rejects(ai[action]({ blueprintId: 'bp', prompt: 'test', error: {} }, job), /rebuild/)
    await world.fatalPromise
    assert.equal(JSON.parse(tables.blueprints.get('bp')?.data || '{}').version, 1)
  })
}

for (const change of ['edit', 'delete', 'blueprint']) {
  test(`persistence: paused ${change} write retains the newer revision for fatal flush`, { timeout: 5000 }, async t => {
    const { db, tables } = database()
    const { network, world, socket, exits } = fixture(t, db)
    const table = change === 'blueprint' ? 'blueprints' : 'entities'
    if (change === 'blueprint') network.onBlueprintModified(socket, { id: 'bp', version: 1, name: 'first' })
    else await network.onEntityModified(socket, { id: 'app', position: [1, 0, 0] })
    const held = db.pause(table)
    t.after(() => held.release.resolve())
    const first = network.save()
    await held.started.promise
    if (change === 'blueprint') network.onBlueprintModified(socket, { id: 'bp', version: 2, name: 'latest' })
    else if (change === 'delete') network.onEntityRemoved(socket, 'app')
    else await network.onEntityModified(socket, { id: 'app', position: [2, 0, 0] })
    world.fatal('test')
    assert.deepEqual(exits, [])
    held.release.resolve()
    await first
    await world.fatalPromise
    assert.deepEqual(exits, [1])
    if (change === 'delete') assert.equal(tables.entities.has('app'), false)
    else if (change === 'blueprint') assert.equal(JSON.parse(tables.blueprints.get('bp').data).name, 'latest')
    else assert.deepEqual(JSON.parse(tables.entities.get('app').data).position, [2, 0, 0])
  })
}

test('persistence: concurrent save calls serialize and cannot overwrite a later record', { timeout: 5000 }, async t => {
  const { db, tables, writes } = database()
  const { network, socket } = fixture(t, db)
  await network.onEntityModified(socket, { id: 'app', position: [1, 0, 0] })
  const held = db.pause('entities')
  t.after(() => held.release.resolve())
  const first = network.save()
  await held.started.promise
  await network.onEntityModified(socket, { id: 'app', position: [2, 0, 0] })
  const second = network.save()
  await Promise.resolve()
  assert.equal(writes.length, 1, 'second save must wait for the first write')
  held.release.resolve()
  await Promise.all([first, second])
  assert.deepEqual(JSON.parse(tables.entities.get('app').data).position, [2, 0, 0])
  assert.equal(network.dirtyApps.size, 0)
})

for (const transient of ['mover', 'uploader']) {
  test(
    `persistence: settled edit followed by ${transient} keeps the settled record at fatal`,
    { timeout: 5000 },
    async t => {
      const { db, tables } = database()
      const { network, world, entity, socket } = fixture(t, db)
      await network.onEntityModified(socket, { id: 'app', position: [7, 0, 0] })
      if (transient === 'mover') {
        await network.onEntityModified(socket, { id: 'app', mover: socket.id, position: [99, 0, 0] })
      } else {
        // Upload ownership is host-assigned on add; simulate an upload already in progress.
        entity.data.uploader = socket.id
        await network.onEntityModified(socket, { id: 'app', position: [99, 0, 0] })
      }
      world.fatal('test')
      await world.fatalPromise
      const saved = JSON.parse(tables.entities.get('app')?.data || 'null')
      assert.deepEqual(saved?.position, [7, 0, 0])
      assert.equal(saved[transient], null)
    }
  )
}

test(
  'persistence: throwing teardown leaves a tombstone even while the entity remains registered',
  { timeout: 5000 },
  async t => {
    const { db, tables } = database()
    const { network, world, entity, socket } = fixture(t, db)
    await network.onEntityModified(socket, { id: 'app', position: [1, 0, 0] })
    await network.save()
    entity.destroy = () => {
      throw new Error('native teardown failed')
    }
    assert.throws(() => network.onEntityRemoved(socket, 'app'), /teardown/)
    assert.equal(world.entities.get('app'), entity)
    world.fatal('test')
    await world.fatalPromise
    assert.equal(tables.entities.has('app'), false)
  }
)

for (const kind of ['entity add', 'entity modify', 'blueprint add', 'blueprint modify']) {
  test(`persistence: ${kind} is recorded before broadcast and native-capable apply`, { timeout: 5000 }, async t => {
    const { db, tables } = database()
    const { network, world, entity, socket } = fixture(t, db)
    const blueprint = kind.startsWith('blueprint')
    const id = kind.endsWith('add') ? 'new' : blueprint ? 'bp' : 'app'
    // Fatal can be latched by the apply immediately after an acknowledged broadcast.
    network.send = () => {
      world.fatal('test')
    }
    const fail = () => {
      throw new Error('apply failed')
    }
    if (kind === 'entity add') {
      world.entities.add = fail
      assert.throws(() => network.onEntityAdded(socket, { ...entity.data, id }), /apply/)
    } else if (kind === 'entity modify') {
      entity.modify = fail
      await assert.rejects(network.onEntityModified(socket, { id, pinned: true }), /apply/)
    } else if (kind === 'blueprint add') {
      // Blueprint add applies before broadcasting, so fail from that apply itself.
      world.blueprints.add = () => {
        world.fatal('test')
        fail()
      }
      assert.throws(() => network.onBlueprintAdded(socket, { id, version: 1 }), /apply/)
    } else {
      world.blueprints.modify = fail
      assert.throws(() => network.onBlueprintModified(socket, { id, version: 1 }), /apply/)
    }
    await world.fatalPromise
    assert.ok(tables[blueprint ? 'blueprints' : 'entities'].has(id))
  })
}

for (const state of ['cycle', 'getter', 'toJSON']) {
  test(`persistence: discarded ${state} state is never traversed or serialized`, { timeout: 5000 }, async t => {
    const { db, tables } = database()
    const { network, entity, socket } = fixture(t, db)
    let touched = 0
    if (state === 'cycle') entity.data.state.self = entity.data.state
    else if (state === 'getter') {
      Object.defineProperty(entity.data.state, 'node', {
        enumerable: true,
        get() {
          touched++
          throw new Error('state getter')
        },
      })
    } else
      entity.data.state.toJSON = () => {
        touched++
        throw new Error('state toJSON')
      }
    await network.onEntityModified(socket, { id: 'app', pinned: true })
    await network.save()
    assert.equal(touched, 0)
    assert.equal(JSON.parse(tables.entities.get('app')?.data || '{}').state, null)
  })
}

test(
  'persistence: fatal immediately after a settings broadcast persists without another tick',
  { timeout: 5000 },
  async t => {
    const { db, tables } = database()
    const { network, world, socket } = fixture(t, db)
    network.send = name => {
      assert.equal(name, 'settingsModified')
      world.fatal('test')
    }
    network.onSettingsModified(socket, { key: 'title', value: 'last title' })
    assert.ok(world.settings.changes)
    await world.fatalPromise
    assert.equal(JSON.parse(tables.config.get('settings')?.value || '{}').title, 'last title')
  }
)

for (const key of ['settings', 'spawn']) {
  test(
    `persistence: fatal waits for pending ${key} and writes the latest config afterward`,
    { timeout: 5000 },
    async t => {
      const { db, tables, writes } = database()
      const { network, world, socket } = fixture(t, db)
      const held = db.pause('config')
      t.after(() => held.release.resolve())
      let first
      if (key === 'settings') {
        world.settings.set('title', 'first')
        first = network.saveSettings()
      } else {
        socket.player.data.position = [1, 0, 0]
        first = network.onSpawnModified(socket, 'set')
      }
      await held.started.promise
      if (key === 'settings') network.onSettingsModified(socket, { key: 'title', value: 'latest' })
      else {
        socket.player.data.position = [8, 0, 0]
        network.onSpawnModified(socket, 'set')
      }
      world.fatal('test')
      await Promise.resolve()
      assert.equal(writes.length, 1)
      held.release.resolve()
      await first
      await world.fatalPromise
      const saved = JSON.parse(tables.config.get(key).value)
      if (key === 'settings') assert.equal(saved.title, 'latest')
      else assert.deepEqual(saved.position, [8, 0, 0])
    }
  )
}

for (const phase of ['in-flight save', 'final save', 'config']) {
  test(`persistence: one fatal deadline bounds a hanging ${phase} and logs unsaved ids`, { timeout: 5000 }, async t => {
    const lines = []
    t.mock.method(console, 'error', line => lines.push(line))
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { db, writes } = database()
    const { network, socket, world, exits } = fixture(t, db)
    await network.onEntityModified(socket, { id: 'app', position: [1, 0, 0] })
    const held = db.pause(phase === 'config' ? 'config' : 'entities')
    t.after(() => held.release.resolve())
    if (phase === 'in-flight save') {
      network.save()
      await held.started.promise
    } else if (phase === 'config') {
      world.settings.set('title', 'pending')
      network.saveSettings()
      await held.started.promise
    }
    world.fatal('test')
    if (phase === 'final save') await held.started.promise
    t.mock.timers.tick(4999)
    await Promise.resolve()
    assert.deepEqual(exits, [])
    t.mock.timers.tick(1)
    await world.fatalPromise
    assert.deepEqual(exits, [1])
    assert.ok(lines.some(line => line.includes('not persisted:') && line.includes('app')))
    if (phase === 'config') assert.ok(lines.some(line => line.includes('config=["settings"]')))
    const count = writes.length
    held.release.resolve()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.equal(writes.length, count, 'expired flush must not start more writes after exit')
  })
}

test('persistence: failed final writes retain ids and report incomplete flush', { timeout: 5000 }, async t => {
  const lines = []
  t.mock.method(console, 'error', line => lines.push(line))
  const { db } = database()
  const { network, socket } = fixture(t, db)
  await network.onEntityModified(socket, { id: 'app', pinned: true })
  network.db = () => {
    throw new Error('disk unavailable')
  }
  await assert.rejects(network.flushBeforeExit(5000), /incomplete/)
  assert.equal(network.dirtyApps.size, 1)
  assert.ok(lines.some(line => line.includes('not persisted:') && line.includes('app')))
})

for (const phase of ['spawn read', 'settings read', 'invalid settings', 'unchanged']) {
  test(`N2: fatal preserves stored config during ${phase}`, { timeout: 5000 }, async t => {
    t.mock.method(console, 'error', () => {})
    const { db, tables, writes } = database()
    const settings = phase === 'invalid settings' ? '{' : JSON.stringify({ title: 'stored title', rank: 1 })
    const spawn = JSON.stringify({ position: [12, 3, 4], quaternion: [0, 0, 0, 1] })
    tables.config.set('settings', { key: 'settings', value: settings })
    tables.config.set('spawn', { key: 'spawn', value: spawn })
    const held = deferred()
    const started = deferred()
    t.after(() => held.resolve())
    const network = makeNetwork(t, {
      net,
      world: { blueprints: { add() {} }, entities: { add() {} } },
      init: {
        db: table =>
          table !== 'config'
            ? []
            : {
                ...db(table),
                where: (key, id) => ({
                  first: async () => {
                    const row = tables.config.get(id)
                    if (phase === `${id} read`) {
                      started.resolve()
                      await held.promise
                    }
                    return row
                  },
                }),
              },
      },
    })
    const world = network.world
    world.settings = new Settings(world)
    const boot = network.start()
    if (phase.endsWith('read')) await started.promise
    else await boot
    await network.flushBeforeExit(1000)
    held.resolve()
    await boot
    assert.equal(tables.config.get('settings').value, settings)
    assert.equal(tables.config.get('spawn').value, spawn)
    assert.equal(writes.length, 0, 'unloaded, invalid or unchanged config is never flushed')
  })
}

test('N3: world entity teardown preserves app rows; explicit removal still tombstones', { timeout: 5000 }, async t => {
  const { db, tables } = database()
  const { network, world, entity } = fixture(t, db)
  network.markAppDirty(entity.data)
  await network.save()
  entity.destroy = () => {
    if (entity.destroyed) return
    entity.destroyed = true
    world.entities.remove(entity.data.id)
  }
  world.entities.destroy()
  await network.save()
  assert.equal(world.entities.items.size, 0)
  assert.ok(tables.entities.has('app'), 'teardown must preserve persisted apps')
  world.entities.add({ ...entity.data, id: 'removed' })
  world.entities.remove('removed')
  assert.equal(network.dirtyApps.get('removed').record, null)
})

test(
  'B8: the final flush also writes the script storage file and reports it when it could not',
  { timeout: 5000 },
  async t => {
    const lines = []
    t.mock.method(console, 'error', line => lines.push(line))
    t.mock.method(console, 'log', () => {})
    for (const [name, flush, outcome] of [
      ['saved', async () => true, null],
      ['failed', async () => false, /final save incomplete/],
      ['stalled', () => new Promise(() => {}), /save deadline exceeded/],
    ]) {
      lines.length = 0
      const { db, tables } = database()
      const { network, world, socket } = fixture(t, db)
      let calls = 0
      let saved = false
      world.storage = {
        flush: async () => {
          calls++
          return (saved = await flush())
        },
        saved: () => saved,
      }
      await network.onEntityModified(socket, { id: 'app', pinned: true })
      const done = network.flushBeforeExit(200)
      if (outcome) await assert.rejects(done, outcome, name)
      else await done
      assert.equal(calls, 1, name)
      assert.ok(tables.entities.has('app'), `${name}: the app is saved alongside`)
      const reported = lines.filter(line => line.includes('not persisted:'))
      if (outcome)
        assert.ok(
          reported.some(line => line.endsWith('storage=unsaved')),
          name
        )
      else assert.deepEqual(reported, [], name)
    }
  }
)

// Codex's interleaving: the database save is still pending when the storage flush has finished, and a script
// continuation (a timer, a fetch) calls world.set in between
test(
  'B8: a world.set after the storage flush, while the database save is pending, is refused',
  { timeout: 120000 },
  async t => {
    t.mock.method(console, 'error', () => {})
    t.mock.method(console, 'log', () => {})
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-save-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const file = path.join(dir, 'storage.json')
    for (const late of ['set', 'accepted']) {
      const storage = new Storage(file, { intervalMs: 0 })
      const { db, tables } = database()
      const { network, world, socket } = fixture(t, db)
      world.storage = storage
      storage.set('k', 1)
      await network.onEntityModified(socket, { id: 'app', pinned: true })
      const held = db.pause('entities')
      // the held database write decides when the save goes on: the deadline is far beyond any slow machine
      const done = network.flushBeforeExit(60000)
      await held.started.promise
      while (!storage.saved()) await new Promise(resolve => setTimeout(resolve, 1))
      if (late === 'set') {
        assert.throws(() => storage.set('k', 2), /the server is stopping; the value was not stored/)
        held.release.resolve()
        await done
        assert.equal(storage.get('k'), 1, 'memory holds what the file holds')
      } else {
        // a change that got in anyway (no path does today) is caught by the check at the end
        storage.revision++
        held.release.resolve()
        await assert.rejects(done, /final save incomplete/)
      }
      assert.ok(tables.entities.has('app'))
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { k: 1 })
    }
  }
)

test('a stored settings row that cannot be parsed does not make every visitor an admin', { timeout: 5000 }, async t => {
  t.mock.method(console, 'error', () => {})
  const saved = process.env.ADMIN_CODE
  process.env.ADMIN_CODE = 'a-code-for-this-test'
  t.after(() => {
    if (saved === undefined) delete process.env.ADMIN_CODE
    else process.env.ADMIN_CODE = saved
  })
  const { db, tables } = database()
  tables.config.set('settings', { key: 'settings', value: '{' })
  tables.config.set('spawn', { key: 'spawn', value: JSON.stringify({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }) })
  const network = makeNetwork(t, {
    net,
    world: { blueprints: { add() {} }, entities: { add() {} } },
    init: {
      db: table =>
        table !== 'config' ? [] : { ...db(table), where: (_key, id) => ({ first: async () => tables.config.get(id) }) },
    },
  })
  const world = network.world
  world.settings = new Settings(world)
  await network.start()
  // "there is a code" was set only after a successful parse: left unset, the settings take everyone for an admin
  assert.equal(world.settings.hasAdminCode, true)
  assert.equal(world.settings.effectiveRank, world.settings.rank)
  assert.ok(world.settings.effectiveRank < 2, 'not admin')
})

// The users' rows at the final save (userRows.js, ServerNetwork.flushBeforeExit). `users` is a table of its own
// here: each statement is recorded, and ends as `end(statement)` says.
function userTable(network, db, end) {
  const statements = []
  network.db = table =>
    table !== 'users'
      ? db(table)
      : {
          where: (_key, id) => ({
            update: async values => {
              const statement = { id, values: { ...values } }
              statements.push(statement)
              await end(statement)
            },
          }),
        }
  return statements
}
const visitor = id => {
  const data = { id, userId: id, name: id, rank: 0 }
  return { id, send() {}, player: { data, isPlayer: true, modify: change => Object.assign(data, change) } }
}
// A stop signal for that network (shutdown.js), with a stand-in for the process: the path that ends the process
// with 0 when flushBeforeExit resolves and with 1 when it rejects. Its lines go to `lines` (errors) and `said`.
function stopSignal(network, lines, said) {
  const proc = Object.assign(new EventEmitter(), { exits: [] })
  proc.exit = code => proc.exits.push(code)
  const { onSignal } = installShutdown({
    proc,
    network,
    log: { log: line => said.push(line), error: line => lines.push(line) },
  })
  return { exits: proc.exits, stop: () => onSignal('SIGTERM') }
}

test(
  'final save: a user change the database refuses is tried once more, counted, reported, and a stop exits with 1',
  { timeout: 5000 },
  async t => {
    const lines = []
    const said = []
    t.mock.method(console, 'error', line => lines.push(line))
    t.mock.method(console, 'warn', line => lines.push(line))
    t.mock.method(console, 'log', line => said.push(line))
    const { db } = database()
    const { network, world } = fixture(t, db)
    world.events = { emit() {} }
    const statements = userTable(network, db, async () => {
      throw new Error('SQLITE_BUSY')
    })
    await network.onCommand(visitor('u'), { args: ['name', 'Ada'] })
    await network.onCommand(visitor('v'), { args: ['name', 'Bea'] })
    await network.userRows().idle()
    assert.equal(statements.length, 2)
    assert.equal(lines.filter(line => line.includes('not stored')).length, 2, 'said once for each user')
    const { exits, stop } = stopSignal(network, lines, said)
    await stop()
    // flushBeforeExit rejected (final save incomplete): the stop exits with 1, not with the 0 of a complete save
    assert.deepEqual(exits, [1])
    assert.ok(lines.includes('[server] final save failed: final save incomplete'))
    assert.equal(said.includes('[network] final save complete'), false)
    assert.deepEqual(
      statements.map(statement => statement.id),
      ['u', 'v', 'u', 'v'],
      'one more statement for each'
    )
    const report = lines.filter(line => line.includes('not persisted:'))
    assert.equal(report.length, 1)
    assert.match(report[0], / users=2 /)
    assert.equal(
      lines.filter(line => line.includes('not stored')).length,
      2,
      'the same run of failures: not said again'
    )
  }
)

test(
  'final save: a user change that failed before lands at the final save, and nothing is reported',
  { timeout: 5000 },
  async t => {
    const lines = []
    const said = []
    t.mock.method(console, 'error', line => lines.push(line))
    t.mock.method(console, 'warn', line => lines.push(line))
    t.mock.method(console, 'log', line => said.push(line))
    const { db } = database()
    const { network, world } = fixture(t, db)
    world.events = { emit() {} }
    let down = true
    const stored = new Map()
    const statements = userTable(network, db, async statement => {
      if (down) throw new Error('SQLITE_BUSY')
      stored.set(statement.id, { ...stored.get(statement.id), ...statement.values })
    })
    await network.onCommand(visitor('u'), { args: ['name', 'Ada'] })
    await network.userRows().idle()
    assert.equal(network.userRows().unstored(), 1)
    down = false
    const { exits, stop } = stopSignal(network, lines, said)
    await stop()
    // flushBeforeExit resolved: the process ends with 0
    assert.deepEqual(exits, [0])
    assert.deepEqual(stored.get('u'), { name: 'Ada' })
    assert.equal(statements.length, 2)
    assert.equal(network.userRows().unstored(), 0)
    assert.deepEqual(
      lines.filter(line => line.includes('not persisted:')),
      []
    )
    assert.ok(said.includes('[network] final save complete'))
  }
)

test(
  'final save: a user write that hangs is bounded by the deadline, and no statement starts after it',
  { timeout: 5000 },
  async t => {
    const lines = []
    t.mock.method(console, 'error', line => lines.push(line))
    t.mock.method(console, 'warn', line => lines.push(line))
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { db } = database()
    const { network, world, exits } = fixture(t, db)
    world.events = { emit() {} }
    const held = deferred()
    const statements = userTable(network, db, async statement => {
      if (statement.id === 'failing') throw new Error('SQLITE_BUSY')
      await held.promise
    })
    await network.onCommand(visitor('failing'), { args: ['name', 'Ada'] })
    await network.userRows().idle()
    // a statement that does not return, and a second change of that user waiting behind it
    const slow = visitor('slow')
    await network.onCommand(slow, { args: ['name', 'one'] })
    await network.onCommand(slow, { args: ['name', 'two'] }, { at: 60000 })
    assert.equal(statements.length, 2)
    world.fatal('test')
    t.mock.timers.tick(4999)
    await Promise.resolve()
    assert.deepEqual(exits, [])
    t.mock.timers.tick(1)
    await world.fatalPromise
    assert.deepEqual(exits, [1])
    const report = lines.find(line => line.includes('not persisted:'))
    assert.match(report, / users=2 /)
    // the statement returns after the deadline: the change behind it and the other user's retry are not started
    held.resolve()
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(statements.length, 2, 'no statement after the deadline')
    assert.equal(network.userRows().unstored(), 2)
  }
)
