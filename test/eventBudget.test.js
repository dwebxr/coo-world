import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ranks } from '../src/core/extras/ranks.js'
import { readPacket, writeClientPacket } from '../src/core/packets.js'
import { ACTION_BUDGETS } from '../src/core/extras/actionBudget.js'
import { createInboundGate } from '../src/core/extras/inboundPolicy.js'
import { Entity } from '../src/core/entities/Entity.js'
import { createEventQueue } from '../src/core/extras/appEventQueue.js'
import { createScriptTimers } from '../src/core/extras/scriptTimers.js'
import { briefError, createLogOnce } from '../src/core/extras/logOnce.js'
import { clientWorld, loadClient } from './lib/clientHarness.mjs'
import { fixture } from './lib/joinFixture.mjs'

const { rate: RATE, burst: BURST } = ACTION_BUDGETS.event
const OVER = 'sender over its event budget'

const root = () => ({
  position: { fromArray() {} },
  quaternion: { fromArray() {} },
  scale: { fromArray() {} },
  activate() {},
  deactivate() {},
})

// The real network handlers (joinFixture) with the real App entity and Apps system in their world: an admin and two
// visitors, `a` and `b`. An app's script listens for the event names its blueprint's props give (`listen`) and
// records what it gets in `seen`.
async function stage(t) {
  const f = fixture(t)
  const world = f.world
  world.settings.setHasAdminCode(true)
  world.settings.rank = Ranks.VISITOR
  const enter = async (id, rank = Ranks.VISITOR) => {
    f.users.set(id, { id, name: id, avatar: null, rank })
    const joined = await f.join({ authToken: id })
    return { ...joined, socket: f.network.sockets.get(id), id }
  }
  const admin = await enter('admin', Ranks.ADMIN)
  const a = await enter('a')
  const b = await enter('b')
  const got = who => {
    who.ws.drain()
    const all = who.ws.packets.map(readPacket)
    who.ws.packets.length = 0
    return all
  }
  for (const who of [admin, a, b]) got(who)
  const appLogs = []
  const seen = []
  const Apps = loadClient('core/systems/Apps.js', 'Apps')
  const App = loadClient('core/entities/App.js', 'App', {
    Entity,
    createEventQueue,
    createScriptTimers,
    createNode: root,
    createEntityProxy: entity => entity,
    registerAppProxy() {},
    LerpVector3: class {},
    LerpQuaternion: class {},
    briefError,
    createLogOnce: () => createLogOnce(line => appLogs.push(line)),
  })
  world.apps = new Apps(world)
  world.events.off = () => {}
  world.setHot = () => {}
  world.loader = {
    get: type =>
      type === 'script'
        ? {
            exec(_world, app, _fetch, props) {
              for (const name of props.listen) {
                app.on(name, (data, networkId) => seen.push({ app: app.data.id, name, data, from: networkId }))
              }
            },
          }
        : { toNodes: root },
  }
  world.blueprints.add({ id: 'ev', version: 0, model: 'cached.glb', script: 'cached.js', props: { listen: ['probe'] } })
  const addApp = (id, blueprint = 'ev') => {
    const app = new App(world, { id, blueprint, position: [], quaternion: [], scale: [], state: {} })
    world.entities.items.set(id, app)
    return app
  }
  // an event as the tick hands it to its handler, arrived at `at`
  const event = (who, at, { id = 'game', version = 0, name = 'probe', data = at, builder = false } = {}) =>
    f.network.onEntityEvent(who.socket, [id, version, name, data], {
      bytes: 32,
      nodes: 8,
      socketId: who.id,
      builder,
      at,
    })
  const over = app => app.eventDrops.get(OVER) ?? 0
  return { f, world, admin, a, b, got, appLogs, seen, addApp, event, over }
}

test('a flood of events from one visitor: the script gets 1280 at once and then 320 a second; the rest are counted', async t => {
  const s = await stage(t)
  const game = s.addApp('game')
  const other = s.addApp('other')
  for (let i = 0; i < 3000; i++) s.event(s.a, 10_000, { data: i })
  assert.equal(s.seen.length, BURST, 'the burst')
  assert.deepEqual(
    s.seen.map(e => e.data),
    Array.from({ length: BURST }, (_, i) => i),
    'the first ones, in order'
  )
  assert.ok(s.seen.every(e => e.app === 'game' && e.from === 'a'))
  assert.equal(s.over(game), 3000 - BURST)
  assert.equal(game.droppedEvents, 3000 - BURST, 'counted with the other drops of the app')
  // the budget is the connection's, for all the apps it sends to
  s.event(s.a, 10_000, { id: 'other' })
  assert.equal(s.over(other), 1)
  // by the time the packets arrived: half a second gives 160 more, a second after that 320
  s.seen.length = 0
  for (let i = 0; i < 1000; i++) s.event(s.a, 10_500)
  assert.equal(s.seen.length, RATE / 2)
  for (let i = 0; i < 1000; i++) s.event(s.a, 11_500, { id: i % 2 ? 'game' : 'other' })
  assert.equal(s.seen.length, RATE / 2 + RATE)
  // said once per app and once per connection, and to nobody else: the sender is not answered, nobody is closed
  assert.equal(s.appLogs.filter(line => line.includes(`[app] game: event dropped (${OVER})`)).length, 1)
  assert.equal(s.appLogs.filter(line => line.includes(`[app] other: event dropped (${OVER})`)).length, 1)
  assert.equal(s.appLogs.length, 2)
  assert.equal(s.f.logs.filter(line => /"a" is over its event budget: dropped/.test(line)).length, 1)
  assert.equal(s.f.logs.filter(line => /over its event budget/.test(line)).length, 1)
  assert.equal(s.f.network.actionBudgets.refused(s.a.socket, 'event'), s.over(game) + s.over(other))
  for (const who of [s.a, s.b, s.admin]) {
    assert.deepEqual(s.got(who), [])
    assert.equal(who.ws.readyState, 1)
  }
  // another connection has its own
  s.seen.length = 0
  for (let i = 0; i < 3000; i++) s.event(s.b, 11_500)
  assert.equal(s.seen.length, BURST)
  assert.ok(s.seen.every(e => e.from === 'b'))
})

test('two apps sending every frame at 144 Hz for a minute lose nothing, through the real admission; a third makes it too many', async t => {
  const s = await stage(t)
  const apps = ['one', 'two', 'three'].map(id => s.addApp(id))
  let clock = 50_000
  t.mock.method(performance, 'now', () => clock)
  // the inbound gate on the same clock (it reads the wall clock, which does not move in this replay)
  s.f.network.gate = createInboundGate({ now: () => clock, log: line => s.f.logs.push(line) })
  const TICK = 1000 / 30
  let nextTick = clock + TICK
  let sent = 0
  const replay = (ids, seconds) => {
    const start = clock
    for (let frame = 0; frame < 144 * seconds; frame++) {
      const at = start + (frame * 1000) / 144
      for (; nextTick <= at; nextTick += TICK) {
        clock = nextTick
        s.f.network.flush()
      }
      clock = at
      for (const id of ids) s.a.socket.ws.emit('message', writeClientPacket('entityEvent', [id, 0, 'probe', sent++]))
    }
    clock = start + seconds * 1000
    s.f.network.flush()
  }
  replay(['one', 'two'], 60)
  assert.equal(sent, 288 * 60)
  assert.equal(s.seen.length, sent, 'every event reached its script')
  assert.deepEqual(
    s.seen.map(e => e.data),
    Array.from({ length: sent }, (_, i) => i),
    'in order'
  )
  assert.equal(s.f.network.actionBudgets.refused(s.a.socket, 'event'), 0)
  assert.equal(s.f.network.gate.dropped(s.a.socket), 0)
  assert.deepEqual(s.appLogs, [])
  // three apps doing so are 432 a second: what the budget had left, and then 320 a second
  s.seen.length = 0
  replay(['one', 'two', 'three'], 30)
  assert.equal(sent, 288 * 60 + 432 * 30)
  assert.equal(s.f.network.gate.dropped(s.a.socket), 0, 'the inbound gate let them all through')
  const expected = BURST + RATE * 30
  assert.ok(Math.abs(s.seen.length - expected) <= 4, `${s.seen.length} of ${432 * 30} delivered, about ${expected}`)
  const dropped = apps.reduce((sum, app) => sum + s.over(app), 0)
  assert.equal(dropped, 432 * 30 - s.seen.length, 'the rest are counted on the apps they were for')
  assert.equal(s.a.ws.readyState, 1)
})

test('an event the app does not take uses no budget', async t => {
  const s = await stage(t)
  const game = s.addApp('game')
  s.world.blueprints.add({ id: 'off', version: 0, model: 'cached.glb', script: 'cached.js', disabled: true, props: {} })
  const off = s.addApp('off', 'off')
  for (let i = 0; i < 3000; i++) {
    s.event(s.a, 1000, { name: 'nobody-listens' })
    s.event(s.a, 1000, { id: 'no-such-app' })
    s.event(s.a, 1000, { id: 'off' })
    s.event(s.a, 1000, { version: 1 }) // a version the blueprint does not have: refused to a visitor
    s.event(s.a, 1000, { version: -1 })
    s.event(s.a, 1000, { name: 'update' }) // an engine hook: never raised from the network
  }
  assert.deepEqual(s.seen, [])
  assert.equal(s.f.network.actionBudgets, undefined, 'the budget was never asked')
  assert.equal(s.over(game), 0)
  assert.equal(s.over(off), 0)
  assert.equal(game.eventDrops.get('future version'), 3000, 'counted as what it is')
  // the whole burst is still there
  for (let i = 0; i < BURST; i++) s.event(s.a, 1000)
  assert.equal(s.seen.length, BURST)
  assert.equal(s.over(game), 0)
})

test('an event for an app whose script has crashed uses no budget: its listeners are still there, and are not called', async t => {
  const s = await stage(t)
  const broken = s.addApp('game')
  const healthy = s.addApp('other')
  // as crash() leaves it until the crash is cleared up: the flag set, the listeners still installed
  broken.crashed = true
  assert.equal(broken.listeners.probe.size, 1)
  for (let i = 0; i < 3000; i++) s.event(s.a, 1000)
  assert.deepEqual(s.seen, [])
  assert.equal(s.f.network.actionBudgets, undefined, 'the budget was never asked')
  assert.equal(s.over(broken), 0)
  // the connection's whole burst is there for the app that runs
  for (let i = 0; i < BURST; i++) s.event(s.a, 1000, { id: 'other' })
  assert.equal(s.seen.length, BURST)
  assert.equal(s.over(healthy), 0)
})

test('an event the app keeps while it builds uses the budget, whatever the old script listened for', async t => {
  const s = await stage(t)
  const game = s.addApp('game')
  // a rebuild that waits for its model: the script of version 0 is still the one running
  const cached = s.world.loader.get
  let finish
  s.world.loader.get = type => (type === 'model' ? undefined : cached(type))
  s.world.loader.load = () => new Promise(resolve => (finish = resolve))
  s.world.blueprints.modify({ id: 'ev', version: 1, props: { listen: ['probe', 'later'] } })
  assert.equal(game.building, true)
  for (let i = 0; i < 2000; i++) s.event(s.a, 1000, { version: 1, name: 'later', data: i })
  assert.equal(s.over(game), 2000 - BURST)
  // the queue keeps the last 64 of those the budget let through
  assert.equal(game.eventQueue.size, 64)
  assert.equal(game.eventDrops.get('queue full'), BURST - 64)
  finish({ toNodes: root })
  await Promise.resolve()
  assert.equal(game.building, false)
  assert.deepEqual(
    s.seen.map(e => [e.name, e.data]),
    Array.from({ length: 64 }, (_, i) => ['later', BURST - 64 + i])
  )
})

test("a builder's event for the next version of the blueprint is kept and uses the budget", async t => {
  const s = await stage(t)
  const game = s.addApp('game')
  assert.equal(game.building, false)
  for (let i = 0; i < 2000; i++) s.event(s.admin, 1000, { version: 1, name: 'later', data: i, builder: true })
  assert.equal(s.over(game), 2000 - BURST)
  assert.equal(game.eventQueue.size, 64)
  assert.deepEqual(s.seen, [])
  s.world.blueprints.modify({ id: 'ev', version: 1, props: { listen: ['later'] } }, false, { authorSocketId: 'admin' })
  assert.deepEqual(
    s.seen.map(e => e.data),
    Array.from({ length: 64 }, (_, i) => BURST - 64 + i)
  )
})

test('the arrival time of the packet is what is counted, through the real admission', async t => {
  const s = await stage(t)
  s.addApp('game')
  const asked = []
  s.f.network.actionBudgets = { spend: (socket, action, at) => (asked.push([socket.id, action, at]), { ok: true }) }
  let clock = 111
  t.mock.method(performance, 'now', () => clock)
  s.a.socket.ws.emit('message', writeClientPacket('entityEvent', ['game', 0, 'probe', 'hello']))
  s.a.socket.ws.emit('message', writeClientPacket('entityEvent', ['game', 0, 'nobody-listens', 'hello']))
  clock = 99999
  s.f.network.flush()
  t.mock.restoreAll()
  assert.deepEqual(asked, [['a', 'event', 111]])
  assert.deepEqual(
    s.seen.map(e => e.data),
    ['hello']
  )
})

test('client: the console warns once when its own count goes over, and the event is sent all the same', t => {
  const world = clientWorld()
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  let clock = 7000
  t.mock.method(performance, 'now', () => clock)
  const send = () => world.network.send('entityEvent', ['app', 0, 'probe', { n: 1 }])
  // two apps sending every frame at 144 Hz for a minute: nothing said
  for (let frame = 0; frame < 144 * 60; frame++) {
    clock = 7000 + (frame * 1000) / 144
    assert.equal(send(), true)
    assert.equal(send(), true)
  }
  assert.deepEqual(warnings, [])
  assert.equal(world.packets.length, 288 * 60)
  // a quiet time, then more at once than the server takes
  clock += 60_000
  world.packets.length = 0
  for (let i = 0; i < BURST; i++) assert.equal(send(), true)
  assert.deepEqual(warnings, [])
  for (let i = 0; i < 500; i++) assert.equal(send(), true)
  assert.equal(warnings.length, 1, 'once')
  assert.match(warnings[0], /sends script events \(app\.send\) faster than the server takes them from one connection/)
  assert.match(warnings[0], /\(320 a second, 1280 at once\)/)
  assert.match(warnings[0], /by this client's count some may be dropped/)
  assert.equal(world.packets.length, BURST + 500, 'every one was sent')
  // other packets are not counted
  const quiet = clientWorld()
  for (let i = 0; i < 3000; i++) quiet.network.send('ping', i)
  assert.equal(warnings.length, 1)
})
