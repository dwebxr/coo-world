import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Ranks } from '../src/core/extras/ranks.js'
import { readPacket } from '../src/core/packets.js'
import { createConnectionLimits, readConnectionLimitsEnv } from '../src/server/connectionLimits.js'
import { app, apps, fixture, net, settle } from './lib/joinFixture.mjs'
import { makeNetwork } from './lib/network.mjs'
import { loadRoute } from './lib/wsRoute.mjs'

const packets = ws => ws.packets.map(readPacket)

// --- the player limit while joins are still being set up ---

test('player limit: joins that arrive together are counted together', async t => {
  const f = fixture(t)
  f.world.settings.playerLimit = 2
  // five new visitors connect in the same instant: each waits on the database before it is registered
  const joined = await Promise.all(Array.from({ length: 5 }, () => f.join()))
  const methods = joined.map(j => j.method)
  assert.equal(methods.filter(m => m === 'onSnapshot').length, 2, methods.join(','))
  for (const refused of joined.filter(j => j.method === 'onKick')) {
    assert.equal(refused.snapshot, 'player_limit')
    assert.equal(refused.ws.readyState, 3)
  }
  assert.equal(f.network.sockets.size, 2)
  assert.equal(f.network.arriving, 0, 'every held place was given back')
  // a place freed later can be taken
  const [first] = [...f.network.sockets.values()]
  first.disconnect()
  assert.equal(f.network.sockets.size, 1)
  assert.equal((await f.join()).method, 'onSnapshot')
  assert.equal((await f.join()).method, 'onKick')
  assert.equal(f.network.arriving, 0)
})

// a stand-in database whose first `times` answers to `call` (`insert`, or the row read of `id`) wait: `answer()` lets
// the oldest waiting one through
function holdDatabase(f, call, id, times = 1) {
  const db = f.network.db
  const waiting = []
  let held = 0
  const hold = run => (held++ < times ? new Promise(resolve => waiting.push(() => resolve(run()))) : run())
  f.network.db = table => {
    const real = db(table)
    if (call === 'insert') return { ...real, insert: row => hold(() => real.insert(row)) }
    return {
      ...real,
      where: (key, value) =>
        value === id ? { first: () => hold(() => real.where(key, value).first()) } : real.where(key, value),
    }
  }
  return { waiting, answer: () => waiting.shift()() }
}
const visitor = id => ({ id, name: id, avatar: null, rank: Ranks.VISITOR })
const placesHeld = network => [network.arriving ?? 0, network.joining?.size ?? 0]

test('player limit: a join whose connection closes while it waits gives its place back at once', async t => {
  const f = fixture(t)
  f.world.settings.playerLimit = 1
  // the first insert does not answer until the end of the test (a database that hangs)
  const insert = holdDatabase(f, 'insert')
  const ws = f.connection()
  const closed = f.join({}, undefined, ws)
  await settle()
  assert.equal(insert.waiting.length, 1, 'the join waits on its insert')
  assert.equal(f.network.playersPresent(), 1, 'the place is held while the join waits')
  assert.equal((await f.join()).snapshot, 'player_limit', 'the world is full meanwhile')
  // the visitor goes away while the insert has not answered
  ws.terminate()
  assert.equal(f.network.playersPresent(), 0, 'its place is given back with its connection')
  const next = await f.join()
  assert.equal(next.method, 'onSnapshot', 'another visitor enters before the insert answers')
  insert.answer()
  await closed
  assert.deepEqual(ws.packets, [], 'nothing was sent to the closed join')
  assert.deepEqual(
    [...f.network.sockets.values()].map(socket => socket.ws),
    [next.ws],
    'nothing is registered for the closed join'
  )
  assert.deepEqual(placesHeld(f.network), [0, 0], 'given back once')
  assert.equal(f.network.playersPresent(), 1)
  assert.equal((await f.join()).snapshot, 'player_limit', 'the one place is taken')
  // a refused join (the id is listed as kicked) gives its place back too
  const g = fixture(t)
  g.world.settings.playerLimit = 3
  g.users.set('u1', visitor('u1'))
  g.network.kicks().add({ userId: 'u1' })
  assert.equal((await g.join({ authToken: 'u1' })).snapshot, 'kicked')
  assert.deepEqual(placesHeld(g.network), [0, 0])
})

test('player limit: a player who is here and connects again shares their place while their row is read', async t => {
  const f = fixture(t)
  f.world.settings.playerLimit = 2
  f.users.set('u1', visitor('u1'))
  assert.equal((await f.join({ authToken: 'u1' })).method, 'onSnapshot')
  // the same user again (a reload); its row is read while others arrive
  const read = holdDatabase(f, 'lookup', 'u1')
  const again = f.join({ authToken: 'u1' })
  await settle()
  assert.equal(read.waiting.length, 1, 'its row is being read')
  assert.equal(f.network.playersPresent(), 1, 'one place for the one player')
  assert.equal((await f.join()).method, 'onSnapshot', 'the other place is still free')
  assert.equal((await f.join()).snapshot, 'player_limit')
  // the old connection answers: the new one is a second window, refused
  f.network.answersPing = async () => true
  read.answer()
  assert.equal((await again).snapshot, 'duplicate_user')
  assert.equal(f.network.sockets.size, 2)
  assert.deepEqual(placesHeld(f.network), [0, 0])
})

test('player limit: in a full world, a player who connects again keeps their place when the old connection closes', async t => {
  const f = fixture(t)
  f.world.settings.playerLimit = 1
  f.users.set('u1', visitor('u1'))
  assert.equal((await f.join({ authToken: 'u1' })).method, 'onSnapshot')
  const old = f.network.sockets.get('u1')
  const read = holdDatabase(f, 'lookup', 'u1')
  const again = f.join({ authToken: 'u1' })
  await settle()
  assert.equal(read.waiting.length, 1, 'let in (the player is here), its row is being read')
  // the old connection closes meanwhile (the reload's old tab)
  old.disconnect()
  assert.equal(f.network.sockets.size, 0)
  assert.equal(f.network.playersPresent(), 1, "the place is held by the player's join")
  assert.equal((await f.join()).snapshot, 'player_limit', 'nobody else takes it')
  read.answer()
  assert.equal((await again).method, 'onSnapshot')
  assert.notEqual(f.network.sockets.get('u1'), old)
  assert.equal(f.network.sockets.size, 1)
  assert.deepEqual(placesHeld(f.network), [0, 0])
})

test('player limit: two connections of one player hold one place, until the last of them ends', async t => {
  const f = fixture(t)
  f.world.settings.playerLimit = 1
  f.users.set('u1', visitor('u1'))
  assert.equal((await f.join({ authToken: 'u1' })).method, 'onSnapshot')
  const old = f.network.sockets.get('u1')
  // a reload whose row is read slowly; the old connection closes meanwhile
  const read = holdDatabase(f, 'lookup', 'u1', 2)
  const slow = f.join({ authToken: 'u1' })
  await settle()
  old.disconnect()
  assert.equal(f.network.playersPresent(), 1)
  // another reload of the same player: it shares the place the first one holds (not refused for want of one)
  const ws = f.connection()
  const second = f.join({ authToken: 'u1' }, undefined, ws)
  await settle()
  assert.equal(read.waiting.length, 2, 'both rows are being read')
  assert.equal(f.network.joining.get('u1'), 2)
  assert.equal(f.network.playersPresent(), 1)
  // the second one's transport closes: the place stays with the first
  ws.terminate()
  assert.equal(f.network.playersPresent(), 1, 'the place is still held by the other connection')
  assert.equal((await f.join()).snapshot, 'player_limit')
  read.answer()
  assert.equal((await slow).method, 'onSnapshot')
  read.answer()
  await second
  assert.deepEqual(ws.packets, [])
  assert.equal(f.network.sockets.size, 1)
  assert.deepEqual(placesHeld(f.network), [0, 0])
})

test('player limit: a token whose user row is gone is a new user, who needs a place of its own', async t => {
  for (const limit of [1, 2]) {
    const f = fixture(t)
    f.world.settings.playerLimit = limit
    f.users.set('u1', visitor('u1'))
    assert.equal((await f.join({ authToken: 'u1' })).method, 'onSnapshot')
    f.users.delete('u1')
    const joined = await f.join({ authToken: 'u1' })
    if (limit === 1) {
      assert.equal(joined.snapshot, 'player_limit', 'u1 is here: the world is full for a new user')
      assert.deepEqual([...f.network.sockets.keys()], ['u1'])
    } else {
      assert.equal(joined.method, 'onSnapshot')
      assert.notEqual(joined.snapshot.id, 'u1')
      assert.equal(f.network.sockets.size, 2)
    }
    assert.deepEqual(placesHeld(f.network), [0, 0])
  }
})

test('player limit: a limit lowered while joins are being set up does not turn away those that hold a place', async t => {
  const f = fixture(t)
  f.world.settings.playerLimit = 2
  const insert = holdDatabase(f, 'insert')
  const first = f.join()
  await settle()
  assert.equal(insert.waiting.length, 1)
  const second = f.join()
  await settle()
  f.world.settings.playerLimit = 1
  assert.equal((await f.join()).snapshot, 'player_limit')
  insert.answer()
  assert.equal((await first).method, 'onSnapshot')
  assert.equal((await second).method, 'onSnapshot')
  assert.equal(f.network.sockets.size, 2)
})

test('a join that closed gives back its user id once: a later join of the same user keeps it', async t => {
  const f = fixture(t)
  f.users.set('u1', visitor('u1'))
  // the voice token of the first two joins waits until `waiting[n]()`
  const waiting = []
  const serialize = f.world.livekit.serialize
  f.world.livekit.serialize = (...args) =>
    waiting.length < 2 ? new Promise(resolve => waiting.push(() => resolve(serialize(...args)))) : serialize(...args)
  const ws = f.connection()
  const first = f.join({ authToken: 'u1' }, undefined, ws)
  await settle()
  assert.equal(waiting.length, 1)
  assert.ok(f.network.connecting.has('u1'))
  ws.terminate()
  assert.equal(f.network.connecting.has('u1'), false, 'given back with the connection')
  const second = f.join({ authToken: 'u1' })
  await settle()
  assert.equal(waiting.length, 2, 'the same user again, past the duplicate check')
  // the closed join's wait ends
  waiting[0]()
  await first
  assert.ok(f.network.connecting.has('u1'), "the closed join's end leaves the later join's id")
  assert.equal((await f.join({ authToken: 'u1' })).snapshot, 'duplicate_user')
  waiting[1]()
  assert.equal((await second).method, 'onSnapshot')
  assert.equal(f.network.connecting.size, 0)
  assert.deepEqual(placesHeld(f.network), [0, 0])
})

test('no player limit: nothing is refused, and the count still returns to zero', async t => {
  const f = fixture(t)
  const joined = await Promise.all(Array.from({ length: 4 }, () => f.join()))
  assert.ok(joined.every(j => j.method === 'onSnapshot'))
  assert.equal(f.network.arriving, 0)
})

// --- what a connection that is gone was holding ---

async function builders(t) {
  const f = fixture(t)
  f.world.settings.setHasAdminCode(true)
  const enter = async id => {
    f.users.set(id, { id, name: id, avatar: null, rank: Ranks.BUILDER })
    const joined = await f.join({ authToken: id })
    return { ...joined, socket: f.network.sockets.get(id) }
  }
  const one = await enter('one')
  const two = await enter('two')
  return { f, one, two }
}

test('a builder who leaves in the middle of a move: the app is let go where it is, said to everyone and saved', async t => {
  const { f, one, two } = await builders(t)
  f.world.entities.add(app('moving', 'bp', { mover: 'one' }))
  f.world.entities.add(app('other', 'bp', { mover: 'two' }))
  f.world.entities.add(app('still', 'bp'))
  f.network.dirtyApps.clear()
  two.ws.packets.length = 0
  one.socket.disconnect()
  assert.equal(f.world.entities.get('moving').data.mover, null)
  assert.equal(f.world.entities.get('other').data.mover, 'two', "another builder's move is theirs")
  two.ws.drain()
  assert.deepEqual(
    packets(two.ws).filter(([name]) => name === 'onEntityModified'),
    [['onEntityModified', { id: 'moving', mover: null }]]
  )
  // a held app is never saved (markAppDirty leaves it out): let go, it is
  assert.deepEqual([...f.network.dirtyApps.keys()], ['moving'])
  assert.ok(f.network.dirtyApps.get('moving').record, 'a record to write, not a removal')
})

test('a builder who leaves in the middle of an upload: the app that never finished loading is removed', async t => {
  const { f, one, two } = await builders(t)
  f.world.entities.add(app('loading', 'bp', { uploader: 'one' }))
  f.world.entities.add(app('theirs', 'bp', { uploader: 'two' }))
  f.network.dirtyApps.clear()
  two.ws.packets.length = 0
  one.socket.disconnect()
  assert.equal(f.world.entities.get('loading'), undefined)
  assert.ok(f.world.entities.get('theirs'))
  two.ws.drain()
  assert.deepEqual(
    packets(two.ws).filter(([name]) => name === 'onEntityRemoved'),
    [['onEntityRemoved', 'loading']]
  )
  assert.deepEqual(
    apps(f.world).map(entity => entity.data.id),
    ['theirs']
  )
})

test('a connection that another of the same user has replaced releases nothing', async t => {
  const { f, one } = await builders(t)
  // the old connection of `one` is silent; the same user connects again and takes over
  f.network.takeoverPingMs = 1
  f.network.takeoverCloseMs = 1
  const old = one.socket
  const again = await f.join({ authToken: 'one' })
  assert.equal(again.method, 'onSnapshot')
  const current = f.network.sockets.get('one')
  assert.notEqual(current, old)
  // what the user holds now is the new connection's
  f.world.entities.add(app('moving', 'bp', { mover: 'one' }))
  f.world.entities.add(app('loading', 'bp', { uploader: 'one' }))
  // a late close of the old connection (its cleanup runs again)
  f.network.onDisconnect(old)
  assert.equal(f.world.entities.get('moving').data.mover, 'one')
  assert.ok(f.world.entities.get('loading'))
  assert.equal(f.network.sockets.get('one'), current)
  // when the new connection goes, it is released
  current.disconnect()
  assert.equal(f.world.entities.get('moving').data.mover, null)
  assert.equal(f.world.entities.get('loading'), undefined)
})

test('while the server is stopping nothing is released (the world is saved as it is)', async t => {
  const { f, one } = await builders(t)
  f.world.entities.add(app('moving', 'bp', { mover: 'one' }))
  f.world.entities.add(app('loading', 'bp', { uploader: 'one' }))
  f.network.stopping = true
  f.network.onDisconnect(one.socket)
  assert.equal(f.world.entities.get('moving').data.mover, 'one')
  assert.ok(f.world.entities.get('loading'))
})

// --- the places kept for ranked users (WS_RESERVED_SOCKETS): the list of stored ranks, and playerLimit ---

// the join world with the kept places in effect (an admin code: not open to all), 2 of them unless `env` says
// otherwise, and `rows` in the users table (id -> rank) and, as start-up would have read them, on the list
function kept(t, { env = {}, rows = {} } = {}) {
  const f = fixture(t, { env: { ADMIN_CODE: 'code', WS_RESERVED_SOCKETS: '2', ...env } })
  f.world.settings.setHasAdminCode(true)
  for (const [id, rank] of Object.entries(rows)) {
    f.users.set(id, { id, name: id, avatar: null, rank })
    if (rank >= Ranks.BUILDER) f.network.storedRanks.set(id, rank)
  }
  f.keptLines = () => f.logs.filter(line => line.includes('kept for ranked users'))
  return f
}

test('kept places: the list of stored ranks is read at start (builder and above); a read that fails leaves it empty', async t => {
  for (const fails of [false, true]) {
    const asked = []
    const users = {
      select: async (...columns) => {
        asked.push(columns)
        if (fails) throw new Error('no such table')
        return [
          { id: 'admin', rank: 2 },
          { id: 'builder', rank: 1 },
          { id: 'visitor', rank: 0 },
          { id: 'unranked', rank: null },
        ]
      },
    }
    const network = makeNetwork(t, {
      net,
      world: {
        settings: { deserialize() {}, serialize: () => ({}), setHasAdminCode() {}, on() {} },
        entities: { items: new Map(), add() {} },
      },
      init: {
        db: table =>
          table === 'users' ? users : table === 'config' ? { where: () => ({ first: async () => undefined }) } : [],
      },
    })
    network.world.blueprints = new net.Blueprints(network.world)
    const lines = []
    t.mock.method(console, 'log', () => {})
    t.mock.method(console, 'error', line => lines.push(String(line)))
    await network.start()
    assert.deepEqual(asked, [['id', 'rank']])
    if (fails) {
      assert.equal(network.storedRanks.size, 0)
      assert.equal(network.storedRankOf('admin'), Ranks.VISITOR)
      assert.deepEqual(lines, [
        '[network] user ids could not be read (no such table); an app that takes one is moved to a new id when that user joins, and the places kept for ranked users stay unused until a restart',
      ])
      continue
    }
    assert.deepEqual(
      [...network.storedRanks],
      [
        ['admin', 2],
        ['builder', 1],
      ]
    )
    assert.deepEqual([...network.userIds].sort(), ['admin', 'builder', 'unranked', 'visitor'])
    for (const [id, rank] of [
      ['admin', 2],
      ['builder', 1],
      ['visitor', 0],
      ['unranked', 0],
      ['nobody', 0],
      [undefined, 0],
      [null, 0],
    ]) {
      assert.equal(network.storedRankOf(id), rank, String(id))
    }
    assert.deepEqual(lines, [])
  }
})

test('kept places: /admin with the code and a rank given or taken change the list in the turn they are decided', async t => {
  const f = kept(t, { rows: { u: Ranks.VISITOR } })
  assert.equal((await f.join({ authToken: 'u' })).method, 'onSnapshot')
  const socket = f.network.sockets.get('u')
  await f.network.onCommand(socket, { args: ['admin', 'code'] })
  assert.equal(socket.player.data.rank, Ranks.ADMIN)
  assert.equal(f.network.storedRankOf('u'), Ranks.ADMIN, '/admin <code>')
  await f.network.onCommand(socket, { args: ['admin', 'code'] })
  assert.equal(f.network.storedRankOf('u'), Ranks.VISITOR, '/admin <code> again')
  assert.equal(f.network.storedRanks.has('u'), false)
  for (const rank of [Ranks.BUILDER, Ranks.ADMIN, Ranks.VISITOR, Ranks.ADMIN]) {
    await f.network.onModifyRank(f.builder, { playerId: 'u', rank })
    assert.equal(f.network.storedRankOf('u'), rank, `modifyRank ${rank}`)
  }
  // the database's write is another matter: the list holds what was decided (userRows.js)
  assert.equal(f.network.userRows().intended('u').rank, Ranks.ADMIN)
})

test('kept places, playerLimit: at a limit of 2, stored admins take the 2 kept places; visitors and a third admin are refused', async t => {
  const f = kept(t, { rows: { a1: 2, a2: 2, a3: 2, b1: 1 } })
  f.world.settings.playerLimit = 2
  assert.equal((await f.join()).method, 'onSnapshot')
  assert.equal((await f.join()).method, 'onSnapshot')
  assert.equal((await f.join()).snapshot, 'player_limit', 'a visitor at the limit')
  assert.equal(
    (await f.join({ authToken: 'b1' })).snapshot,
    'player_limit',
    'a builder, while the places are for admins'
  )
  assert.equal((await f.join({ authToken: 'a1' })).method, 'onSnapshot')
  assert.equal((await f.join({ authToken: 'a2' })).method, 'onSnapshot')
  assert.equal(f.network.sockets.size, 4)
  assert.equal((await f.join()).snapshot, 'player_limit', 'a visitor never takes a kept place')
  assert.equal((await f.join({ authToken: 'a3' })).snapshot, 'player_limit', 'the kept places are in use')
  assert.deepEqual(placesHeld(f.network), [0, 0])
  // a kept place freed is the next admin's
  f.network.sockets.get('a1').disconnect()
  assert.equal((await f.join()).snapshot, 'player_limit', 'still 3 of 2: no visitor')
  assert.equal((await f.join({ authToken: 'a3' })).method, 'onSnapshot')
  // said once per user id
  assert.deepEqual(f.keptLines(), [
    '[network] "a1" (stored rank 2) was let past playerLimit (2) on a place kept for ranked users (1 of 2 in use)',
    '[network] "a2" (stored rank 2) was let past playerLimit (2) on a place kept for ranked users (2 of 2 in use)',
    '[network] "a3" (stored rank 2) was let past playerLimit (2) on a place kept for ranked users (2 of 2 in use)',
  ])
  f.network.sockets.get('a3').disconnect()
  assert.equal((await f.join({ authToken: 'a3' })).method, 'onSnapshot')
  assert.equal(f.keptLines().length, 3)
  // WS_RESERVED_RANK=builder: builders share them
  const g = kept(t, { env: { WS_RESERVED_RANK: 'builder' }, rows: { b1: 1 } })
  g.world.settings.playerLimit = 1
  assert.equal((await g.join()).method, 'onSnapshot')
  assert.equal((await g.join({ authToken: 'b1' })).method, 'onSnapshot')
})

test('kept places, playerLimit: with WS_RESERVED_SOCKETS=0, or admin open to all, a stored admin at the limit is refused as before', async t => {
  for (const env of [{ WS_RESERVED_SOCKETS: '0' }, { ADMIN_CODE: null }]) {
    const f = kept(t, { env, rows: { a1: 2 } })
    f.world.settings.playerLimit = 1
    assert.equal((await f.join()).method, 'onSnapshot')
    assert.equal((await f.join({ authToken: 'a1' })).snapshot, 'player_limit', JSON.stringify(env))
    assert.deepEqual(f.keptLines(), [])
    assert.deepEqual(placesHeld(f.network), [0, 0])
  }
})

test('kept places, playerLimit: the world rank setting and the session are not a stored rank', async t => {
  // builders' places, and a world that makes every visitor a builder (its rank setting): a visitor is still one
  const f = kept(t, { env: { WS_RESERVED_RANK: 'builder' }, rows: { v: 0, b: 1 } })
  f.world.settings.rank = Ranks.BUILDER
  assert.equal(f.world.settings.effectiveRank, Ranks.BUILDER)
  f.world.settings.playerLimit = 1
  assert.equal((await f.join()).method, 'onSnapshot')
  assert.equal((await f.join({ authToken: 'v' })).snapshot, 'player_limit')
  assert.deepEqual(f.keptLines(), [], 'no kept place was taken for it')
  // nor is it on the door's path: a connection let in for `v` is refused where the limit leaves room
  f.world.settings.playerLimit = 0
  assert.equal((await f.join({ authToken: 'v' }, undefined, undefined, { rankedUser: 'v' })).snapshot, 'player_limit')
  assert.deepEqual(f.keptLines(), [
    '[network] a connection let in through a place kept for ranked users is not one: "v" has a stored rank of 0; refused',
  ])
  assert.equal((await f.join({ authToken: 'b' })).method, 'onSnapshot', 'the positive control: a stored builder')
})

test('kept places: a connection let in on one whose row is not ranked, or gone, is refused before any user is made; said once', async t => {
  const f = kept(t, { rows: { admin: 2, demoted: 0, other: 2 } })
  // the list says admin for `demoted` (a database edit the server did not see) and for `gone` (a row deleted)
  f.network.storedRanks.set('demoted', 2)
  f.network.storedRanks.set('gone', 2)
  const users = f.users.size
  for (let i = 0; i < 2; i++) {
    for (const id of ['demoted', 'gone']) {
      const joined = await f.join({ authToken: id }, undefined, undefined, { rankedUser: id })
      assert.equal(joined.snapshot, 'player_limit', id)
      assert.deepEqual(joined.ws.closeCodes, [undefined])
    }
    // a kept place handed to a connection that brings no token, or another user's
    assert.equal((await f.join({}, undefined, undefined, { rankedUser: 'admin' })).snapshot, 'player_limit')
    assert.equal(
      (await f.join({ authToken: 'demoted' }, undefined, undefined, { rankedUser: 'admin' })).snapshot,
      'player_limit'
    )
    // nor the token of another admin: the place was given to that user, not to the rank
    assert.equal(
      (await f.join({ authToken: 'other' }, undefined, undefined, { rankedUser: 'admin' })).snapshot,
      'player_limit'
    )
  }
  assert.equal(f.users.size, users, 'no user was made')
  assert.equal(f.network.sockets.size, 0)
  assert.deepEqual(placesHeld(f.network), [0, 0])
  assert.equal(f.network.connecting.size, 0)
  assert.deepEqual(f.keptLines(), [
    '[network] a connection let in through a place kept for ranked users is not one: "demoted" has a stored rank of 0; refused',
    '[network] a connection let in through a place kept for ranked users is not one: its session token brought no user row of "gone"; refused',
    '[network] a connection let in through a place kept for ranked users is not one: its session token brought no user row of "admin"; refused',
  ])
  // what this server decided over the row counts: an admin whose rank was taken while the write is under way
  let land
  f.store.holdUserUpdate = new Promise(resolve => (land = resolve))
  f.network.userRows().intend('admin', { rank: Ranks.VISITOR })
  assert.equal(
    (await f.join({ authToken: 'admin' }, undefined, undefined, { rankedUser: 'admin' })).snapshot,
    'player_limit'
  )
  assert.equal(f.users.get('admin').rank, Ranks.ADMIN, 'the row still said admin')
  land()
  await f.network.userRows().idle()
  // the positive control: the admin's own, as the row and the decision say
  f.network.userRows().intend('admin', { rank: Ranks.ADMIN })
  const joined = await f.join({ authToken: 'admin' }, undefined, undefined, { rankedUser: 'admin' })
  assert.equal(joined.method, 'onSnapshot')
  assert.equal(f.network.sockets.size, 1)
})

test("kept places, playerLimit: a place the list called ranked but the row does not is taken again as anyone's", async t => {
  for (const room of [false, true]) {
    const f = kept(t, { rows: { stale: 0 } })
    f.network.storedRanks.set('stale', 2)
    f.world.settings.playerLimit = room ? 2 : 1
    assert.equal((await f.join()).method, 'onSnapshot')
    const joined = await f.join({ authToken: 'stale' })
    if (room) {
      assert.equal(joined.method, 'onSnapshot', 'a place under the limit: it joins, as a visitor')
      assert.equal(f.network.sockets.size, 2)
      assert.equal((await f.join()).snapshot, 'player_limit', 'the limit holds after it')
    } else {
      assert.equal(joined.snapshot, 'player_limit', 'the world is full for a visitor')
      assert.equal(f.network.sockets.size, 1)
    }
    assert.deepEqual(placesHeld(f.network), [0, 0])
  }
})

test('kept places: a kicked admin who is on the list is told so', async t => {
  const f = kept(t, { rows: { admin: 2 } })
  f.world.settings.playerLimit = 1
  assert.equal((await f.join()).method, 'onSnapshot')
  f.network.kicks().add({ userId: 'admin' })
  assert.equal((await f.join({ authToken: 'admin' })).snapshot, 'kicked')
  assert.equal((await f.join({ authToken: 'admin' }, undefined, undefined, { rankedUser: 'admin' })).snapshot, 'kicked')
  assert.deepEqual(placesHeld(f.network), [0, 0])
})

test('kept places: a rank taken while connected through one leaves the connection; the next at the cap is refused at the door', async t => {
  const f = kept(t, { rows: { admin: 2 } })
  const limits = createConnectionLimits({ ...readConnectionLimitsEnv({}), ratePerMin: 0, maxSockets: 1, reserved: 2 })
  // the session tokens of the join world: a token is the id of its user
  const route = loadRoute(limits, f.network, undefined, {
    claimedUserId: token => token || null,
    readNow: token => (token ? { userId: token, renew: false } : null),
  })
  const door = authToken => {
    const transport = new EventEmitter()
    const reply = { code: () => reply, header: () => reply, send: () => (reply.refused = true) }
    let passed = false
    route.preValidation(
      { ws: true, raw: { socket: transport }, headers: {}, ip: '10.0.0.1', query: { authToken } },
      reply,
      () => (passed = true)
    )
    return { passed, transport }
  }
  assert.equal(door('').passed, true, 'a visitor fills the server')
  const at = door('admin')
  assert.equal(at.passed, true)
  assert.equal(limits.stats().ranked, 1)
  assert.equal(
    (await f.join({ authToken: 'admin' }, undefined, undefined, { rankedUser: 'admin' })).method,
    'onSnapshot'
  )
  // another admin takes the rank away
  await f.network.onModifyRank(f.builder, { playerId: 'admin', rank: Ranks.VISITOR })
  assert.ok(f.network.sockets.has('admin'), 'the connection stays')
  assert.equal(limits.stats().ranked, 1, 'and so does its place, until its transport closes')
  assert.equal(door('admin').passed, false, 'the next connection of that user at the cap is a visitor')
  at.transport.emit('close')
  assert.equal(limits.stats().ranked, 0)
})
