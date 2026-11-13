// What the world's persistence (src/server/network/persistence.js: the load at start, the dirty marks, the save queue,
// the final save and the config rows) has to do, where no test asked before: each of these was found by a mutant that
// every test passed (P16-7), and each test's name says the rule. The real class (test/lib/network.mjs), with a
// stand-in database whose writes can be held (test/lib/persistenceFixture.mjs); a test that loads the world runs the
// real Settings and Blueprints of the bundle. Nothing here waits a number of turns for work to finish: a test awaits
// the write, the save or the start it is about. Where a test lets the event loop run a callback of its own, it queues
// it at a point the code it watches has not reached yet, so that the order is the event loop's, not the machine's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writePacket } from '../src/core/packets.js'
import { joinStateBytes } from '../src/core/extras/joinBudget.js'
import { loadNetwork, makeNetwork } from './lib/network.mjs'
import { appData, database, deferred, fixture as persistenceFixture } from './lib/persistenceFixture.mjs'

// (against the REAL_PHYSX_SOURCE_ROOT checkout when it is set, as the other persistence tests)
const net = await loadNetwork({ sourceRoot: process.env.REAL_PHYSX_SOURCE_ROOT })
const fixture = (t, db, options) => persistenceFixture(t, { net, db, ...options })

const SPAWN = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
const SAVE_MS = 60000 // SAVE_INTERVAL's default, in ms (the tests' environment leaves it unset)
const row = data => ({ id: data.id, data: JSON.stringify(data) })
const stored = (tables, key) => JSON.parse(tables.config.get(key).value)
const quiet = (t, levels = ['log', 'warn', 'error']) => {
  const lines = []
  for (const level of levels) t.mock.method(console, level, line => lines.push(line))
  return lines
}

// A database as the start reads it (database(), with rows to load: `config` by key, `blueprints` and `entities` as
// rows, no users), and a network that loads from it through start(), on a world with the bundle's Settings and
// Blueprints. `read`: a function the reads of the config rows go through first (to hold one)
function storedWorld({ config = {}, blueprints = [], entities = [], read } = {}) {
  const base = database()
  for (const [key, value] of Object.entries(config)) base.tables.config.set(key, { key, value })
  const rows = { blueprints, entities }
  const db = table => {
    const query = base.db(table)
    if (table === 'users') return { select: async () => [] }
    if (table !== 'config') return Object.assign([...rows[table]], query)
    return {
      ...query,
      where: (key, id) => ({
        ...query.where(key, id),
        first: async () => {
          await read?.(id)
          return base.tables.config.get(id)
        },
      }),
    }
  }
  db.pause = base.db.pause
  return { ...base, db }
}
function loading(t, db, options = {}) {
  const network = makeNetwork(t, {
    net,
    ...options,
    world: { entities: { items: new Map(), add: data => network.world.entities.items.set(data.id, { data }) } },
    init: { db },
  })
  network.world.settings = new net.Settings(network.world)
  network.world.blueprints = new net.Blueprints(network.world)
  return network
}
const storedConfig = settings => ({ settings: JSON.stringify(settings), spawn: JSON.stringify(SPAWN) })

// (H09, H12)
test(
  'persistence: settings loaded at start are written back when they change, at the settings tick',
  { timeout: 30000 },
  async t => {
    quiet(t)
    const { db, tables } = storedWorld({ config: storedConfig({ title: 'stored' }) })
    const network = loading(t, db)
    await network.start()
    const { settings } = network.world
    settings.set('title', 'edited')
    settings.preFixedUpdate()
    // the write the change started, if one was: it is the network's config queue
    await network.configPromise
    assert.equal(stored(tables, 'settings').title, 'edited')
  }
)

// (H09)
test(
  'persistence: a settings change made after the last tick is written by the final save',
  { timeout: 30000 },
  async t => {
    quiet(t)
    const { db, tables } = storedWorld({ config: storedConfig({ title: 'stored' }) })
    const network = loading(t, db)
    await network.start()
    network.world.settings.set('title', 'late')
    await network.flushBeforeExit(5000)
    assert.equal(stored(tables, 'settings').title, 'late')
  }
)

// (C01)
test(
  'persistence: a config row that could not be read at start is never written over, and that is said once',
  { timeout: 30000 },
  async t => {
    const lines = quiet(t)
    const { db, tables, writes } = storedWorld({ config: { settings: '{', spawn: JSON.stringify(SPAWN) } })
    const network = loading(t, db, { log: line => lines.push(line) })
    await network.start()
    const { settings } = network.world
    settings.set('title', 'edited')
    settings.preFixedUpdate()
    assert.equal(await network.saveConfig('settings', settings.serialize()), false)
    assert.equal(await network.saveSettings(), false)
    await network.flushBeforeExit(5000)
    assert.deepEqual(writes, [])
    assert.equal(tables.config.get('settings').value, '{', 'the row as it was stored')
    assert.equal(
      lines.filter(line => line === '[network] settings was not loaded; changes will not be saved').length,
      1
    )
  }
)

// (C05)
test('persistence: a config value equal to the stored one is not written again', { timeout: 30000 }, async t => {
  const { db, writes } = database()
  const { network } = fixture(t, db)
  assert.equal(await network.saveConfig('spawn', { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }), true)
  assert.deepEqual(writes, [])
})

// (C02) Before, only shutdownSave's queued config writes caught this, and only when its stop signal came after the
// child's writes had started (see that test)
test(
  "persistence: a config row's writes go one at a time, and the newer value is the one stored",
  { timeout: 30000 },
  async t => {
    const { db, tables, writes } = database()
    const { network } = fixture(t, db)
    const held = db.pause('config')
    t.after(() => held.release.resolve())
    const older = network.saveConfig('spawn', { position: [1, 0, 0], quaternion: [0, 0, 0, 1] })
    await held.started.promise
    const newer = network.saveConfig('spawn', { position: [2, 0, 0], quaternion: [0, 0, 0, 1] })
    // The older write is released by a callback of the event loop queued after the newer one's first step has run (a
    // step queued before this test goes on, were it not behind the older write) and so after that step's own turn: a
    // newer write that did not wait for the older one would have started, and ended, by then
    await Promise.resolve()
    setImmediate(() => held.release.resolve())
    assert.equal(await newer, true)
    assert.equal(await older, true)
    assert.deepEqual(
      writes.map(write => JSON.parse(write.row.value).position[0]),
      [1, 2]
    )
    assert.deepEqual(stored(tables, 'spawn').position, [2, 0, 0])
  }
)

// (C07)
test(
  'persistence: a newer config value stays to be written when an older write of the row ends',
  { timeout: 30000 },
  async t => {
    quiet(t)
    const { db, tables } = database()
    const { network, world } = fixture(t, db)
    const { settings } = world
    const first = db.pause('config')
    t.after(() => first.release.resolve())
    settings.set('title', 'B')
    settings.preFixedUpdate()
    await first.started.promise
    settings.set('title', 'C')
    settings.preFixedUpdate()
    // B's write ends, and C's, queued behind it, is under way
    const second = db.pause('config')
    t.after(() => second.release.resolve())
    first.release.resolve()
    await second.started.promise
    // the title goes back to B, with no tick since: the stored row (B, written) is what the world has, but C is still
    // on its way to the row, and the final save has to write B after it
    settings.set('title', 'B')
    const final = network.flushBeforeExit(5000)
    second.release.resolve()
    await final
    assert.equal(stored(tables, 'settings').title, 'B')
  }
)

// (C08)
test(
  'persistence: a settings write that fails is not saved: the final save is incomplete and names the row',
  { timeout: 30000 },
  async t => {
    const lines = quiet(t)
    const { db } = database()
    const { network, world } = fixture(t, db)
    const failing = {
      insert: () => ({ onConflict: () => ({ merge: async () => Promise.reject(new Error('SQLITE_FULL')) }) }),
    }
    network.db = table => (table === 'config' ? failing : db(table))
    world.settings.set('title', 'unsaved')
    assert.equal(await network.saveSettings(), false)
    await assert.rejects(network.flushBeforeExit(5000), /final save incomplete/)
    const report = lines.find(line => line.startsWith('[network] not persisted:'))
    assert.match(report, / config=\["settings"\] /)
  }
)

// (D04)
test(
  'persistence: an app re-keyed and then deleted before the save leaves neither its old row nor its new one',
  { timeout: 30000 },
  async t => {
    quiet(t)
    const { db, tables } = database()
    const { network, world, entity } = fixture(t, db)
    network.markAppDirty(entity.data)
    await network.save()
    assert.ok(tables.entities.has('app'))
    network.rekeyApp(entity)
    const [moved] = [...world.entities.items.keys()]
    assert.notEqual(moved, 'app')
    world.entities.remove(moved)
    await network.save()
    assert.deepEqual([...tables.entities.keys()], [])
  }
)

// (S18)
test('persistence: a save that only removes apps says so in its line', { timeout: 30000 }, async t => {
  const said = quiet(t, ['log'])
  const { db } = database()
  const { network } = fixture(t, db)
  network.markAppDeleted('app')
  await network.save()
  assert.deepEqual(said, ['world saved (0 blueprints, 0 apps, 1 apps removed)'])
})

// (S02)
test('persistence: a save that fails does not keep the next save from writing', { timeout: 30000 }, async t => {
  quiet(t)
  const { db, tables } = database()
  const { network, entity } = fixture(t, db)
  network.saveDirty = async () => {
    throw new Error('the writer failed')
  }
  await assert.rejects(network.save(), /the writer failed/)
  delete network.saveDirty
  network.markAppDirty(entity.data)
  await network.save()
  assert.ok(tables.entities.has('app'))
})

// (S03, S04)
test(
  'persistence: while a queued save writes, the next save is not timed; it is timed once, when that save ends',
  { timeout: 30000 },
  async t => {
    quiet(t)
    const calls = []
    const timers = { setTimeout: (fn, ms) => (calls.push(ms), { fn, ms }), clearTimeout() {} }
    const { db } = database()
    const { network, entity } = fixture(t, db, { timers })
    network.markAppDirty(entity.data)
    const first = db.pause('entities')
    t.after(() => first.release.resolve())
    const one = network.save()
    await first.started.promise
    network.markAppDirty({ ...entity.data, id: 'next' })
    const two = network.save()
    const second = db.pause('entities')
    t.after(() => second.release.resolve())
    first.release.resolve()
    // the first save has ended; the second writes its row
    await second.started.promise
    assert.deepEqual(calls, [], 'no save is timed while the second one writes')
    second.release.resolve()
    await Promise.all([one, two])
    assert.deepEqual(calls, [SAVE_MS], 'one save timed, at the end of the last one')
  }
)

// (S03)
test('persistence: a final save started while a queued save writes waits for it', { timeout: 30000 }, async t => {
  quiet(t)
  const { db, writes } = database()
  const { network, entity } = fixture(t, db)
  network.markAppDirty(entity.data)
  const first = db.pause('entities')
  t.after(() => first.release.resolve())
  const one = network.save()
  await first.started.promise
  network.markAppDirty({ ...entity.data, id: 'next' })
  const two = network.save()
  const second = db.pause('entities')
  t.after(() => second.release.resolve())
  first.release.resolve()
  await second.started.promise
  // The second save's row is released by a callback queued before the final save's own first row could be reached:
  // a final save that did not wait would write that row a second time
  const final = network.flushBeforeExit(30000)
  setImmediate(() => second.release.resolve())
  await final
  await Promise.all([one, two])
  assert.deepEqual(
    writes.map(write => write.row.id),
    ['app', 'next']
  )
})

// (S10)
test(
  'persistence: the save gives the event loop a turn before each row, the first one included',
  { timeout: 30000 },
  async t => {
    quiet(t)
    const { db } = database()
    const { network, entity } = fixture(t, db)
    for (const id of ['app', 'second', 'third']) network.markAppDirty({ ...entity.data, id })
    const order = []
    network.db = table => {
      const query = db(table)
      return {
        ...query,
        insert: data => {
          order.push(data.id)
          // queued while this row is written, before the save turns to the next one
          setImmediate(() => order.push(`after ${data.id}`))
          return query.insert(data)
        },
      }
    }
    // queued before the save starts
    setImmediate(() => order.push('before'))
    await network.save()
    assert.deepEqual(order, ['before', 'app', 'after app', 'second', 'after second', 'third'])
  }
)

// (S07, S08, S09, F02, C03, C04, C12) The deadline by the clock: a machine whose thread is held by synchronous writes
// runs the deadline's timer late; the clock says when the time is up, and once it has said so a clock set back does
// not let another write start. The deadline's timer is the test's (makeNetwork's `timers`), which never runs it: only
// the clock (node:test's mock of Date) decides here
const EXPIRES = {
  // the clock passes the deadline while a row is written, before the check of the next one
  'while a row is written': ({ t, held }) => {
    t.mock.timers.tick(1000)
    held.release.resolve()
  },
  // the check before the next row's turn finds time left; the clock passes the deadline in a callback queued before
  // that turn ends
  'during the turn before the next row': ({ t, held }) => {
    held.release.resolve()
    return later(() => t.mock.timers.tick(1000))
  },
  // the clock passes the deadline while a row is written, and is set back before it in a callback queued before the
  // next row's turn ends: the deadline seen passed stays passed
  'even if the clock goes back after it': ({ t, held }) => {
    t.mock.timers.tick(1000)
    held.release.resolve()
    return later(() => t.mock.timers.setTime(1_000_500))
  },
}
// `change` in a callback of the event loop queued now; its promise is settled once the callback has run (a test
// awaits it before it ends, and the mock of Date with it)
function later(change) {
  const done = deferred()
  setImmediate(() => {
    change()
    done.resolve()
  })
  return done.promise
}
const NOW = 1_000_000
const deadlineTimers = () => {
  const asked = []
  return { asked, timers: { setTimeout: (fn, ms) => (asked.push(ms), { fn, ms }), clearTimeout() {} } }
}
for (const [when, expire] of Object.entries(EXPIRES)) {
  test(
    `persistence: no row of the final save starts once its deadline has passed by the clock (${when})`,
    { timeout: 30000 },
    async t => {
      const lines = quiet(t)
      t.mock.timers.enable({ apis: ['Date'], now: NOW })
      const { asked, timers } = deadlineTimers()
      const { db, writes } = database()
      const { network, entity } = fixture(t, db, { timers })
      network.markAppDirty(entity.data)
      network.markAppDirty({ ...entity.data, id: 'next' })
      const held = db.pause('entities')
      t.after(() => held.release.resolve())
      const final = network.flushBeforeExit(1000)
      await held.started.promise
      const expired = expire({ t, held })
      await assert.rejects(final, /final save incomplete/)
      await expired
      assert.deepEqual(asked, [1000], "the deadline's timer, the test's, never run")
      assert.deepEqual(
        writes.map(write => write.row.id),
        ['app']
      )
      assert.match(
        lines.find(line => line.startsWith('[network] not persisted:')),
        / apps=\["next"\] /
      )
    }
  )

  test(
    `persistence: no config row of the final save starts once its deadline has passed by the clock (${when})`,
    { timeout: 30000 },
    async t => {
      const lines = quiet(t)
      t.mock.timers.enable({ apis: ['Date'], now: NOW })
      const { asked, timers } = deadlineTimers()
      const { db, writes } = database()
      const { network, world } = fixture(t, db, { timers })
      // two rows for the final save, the settings' first
      world.settings.set('title', 'pending')
      network.spawn = { position: [5, 0, 0], quaternion: [0, 0, 0, 1] }
      const held = db.pause('config')
      t.after(() => held.release.resolve())
      const final = network.flushBeforeExit(1000)
      await held.started.promise
      const expired = expire({ t, held })
      await assert.rejects(final, /final save incomplete/)
      await expired
      assert.deepEqual(asked, [1000], "the deadline's timer, the test's, never run")
      assert.deepEqual(
        writes.map(write => write.row.key),
        ['settings']
      )
      assert.match(
        lines.find(line => line.startsWith('[network] not persisted:')),
        / config=\["spawn"\] /
      )
    }
  )
}

// (H13)
test('persistence: a world stopped while it loads times no save', { timeout: 30000 }, async t => {
  quiet(t)
  const calls = []
  const timers = { setTimeout: (fn, ms) => (calls.push(ms), { fn, ms }), clearTimeout() {} }
  const reading = deferred()
  const held = deferred()
  t.after(() => held.resolve())
  const { db } = storedWorld({
    config: storedConfig({}),
    read: async () => {
      reading.resolve()
      await held.promise
    },
  })
  const network = loading(t, db, { timers })
  const started = network.start()
  await reading.promise
  network.stopForFatal()
  held.resolve()
  await started
  assert.deepEqual(calls, [])
  // and a world that was not stopped times its first save
  const { db: other } = storedWorld({ config: storedConfig({}) })
  await loading(t, other, { timers }).start()
  assert.deepEqual(calls, [SAVE_MS])
})

// (H07)
test(
  'persistence: the line of the start counts the apps that loaded, not the rows read',
  { timeout: 30000 },
  async t => {
    const said = quiet(t, ['log'])
    const { db } = storedWorld({
      config: storedConfig({}),
      blueprints: [row({ id: 'bp', version: 0 })],
      entities: [row(appData()), { id: 'broken', data: '{' }],
    })
    await loading(t, db).start()
    const line = said.find(line => line.startsWith('[network] hydration:'))
    assert.match(line, /^\[network\] hydration: blueprints=1 apps=1 repaired=0 skipped=1 /)
  }
)

// (H11, H18)
test(
  'persistence: the settings and collections loaded at start count in the join state from the start',
  { timeout: 30000 },
  async t => {
    quiet(t)
    const settings = { title: 'stored', desc: 'd'.repeat(1000) }
    const collections = [{ id: 'default', name: 'Default', blueprints: [{ id: 'c'.repeat(500), name: 'Block' }] }]
    const { db } = storedWorld({ config: storedConfig(settings) })
    const network = loading(t, db)
    network.world.collections = { serialize: () => collections }
    await network.start()
    const { world } = network
    const measured = {
      settings: writePacket('settingsModified', world.settings.serialize()).length,
      collections: writePacket('settingsModified', collections).length,
    }
    assert.ok(measured.settings > 1000 && measured.collections > 500)
    assert.equal(joinStateBytes(world), world.blueprints.bytes + measured.settings + measured.collections)
  }
)
