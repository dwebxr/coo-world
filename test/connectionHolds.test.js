import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ranks } from '../src/core/extras/ranks.js'
import { readPacket } from '../src/core/packets.js'
import { app, apps, fixture, settle } from './lib/joinFixture.mjs'

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
