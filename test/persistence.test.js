import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { database, fixture, load, Network, Settings, deferred } from './lib/persistenceHarness.mjs'

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
    world.loader = { get: () => ({ code: 'app.on("init", () => {})' }) }
    network.send = () => world.fatal('test')
    world.blueprints.modify = () => {
      throw new Error('rebuild failed')
    }
    await assert.rejects(ai[action]({ blueprintId: 'bp', prompt: 'test', error: {} }), /rebuild/)
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
    const world = { blueprints: { add() {} }, entities: { add() {} } }
    const network = new Network(world)
    world.network = network
    world.settings = new Settings(world)
    t.after(() => network.stopForFatal())
    const held = deferred()
    const started = deferred()
    t.after(() => held.resolve())
    network.db = table =>
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
          }
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
