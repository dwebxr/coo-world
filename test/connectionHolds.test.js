import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ranks } from '../src/core/extras/ranks.js'
import { readPacket } from '../src/core/packets.js'
import { app, apps, fixture, settle } from './lib/joinFixture.mjs'

const packets = ws => ws.packets.map(readPacket)

// --- the player limit while joins are still being set up ---

test('player limit: joins that arrive together are counted together', async () => {
  const f = fixture()
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

test('player limit: a join that ends without a player gives its place back', async () => {
  const f = fixture()
  f.world.settings.playerLimit = 1
  // a join whose connection closes while it waits for the database holds the place only until then
  let release
  const db = f.network.db
  f.network.db = table => {
    const real = db(table)
    return { ...real, insert: row => new Promise(resolve => (release = () => resolve(real.insert(row)))) }
  }
  const pending = f.join()
  await settle()
  assert.equal(f.network.arriving, 1, 'the place is held while the join waits')
  assert.equal((await f.join()).method, 'onKick', 'the world is full meanwhile')
  release()
  await pending
  f.network.db = db
  assert.equal(f.network.arriving, 0)
  assert.equal(f.network.sockets.size, 1)
  // a refused join (the id is listed as kicked) gives its place back too
  const g = fixture()
  g.world.settings.playerLimit = 3
  g.users.set('u1', { id: 'u1', name: 'u1', avatar: null, rank: Ranks.VISITOR })
  g.network.kicks().add({ userId: 'u1' })
  assert.equal((await g.join({ authToken: 'u1' })).snapshot, 'kicked')
  assert.equal(g.network.arriving, 0)
})

test('player limit: a player who is here does not take a second place when they connect again', async () => {
  const f = fixture()
  f.world.settings.playerLimit = 2
  f.users.set('u1', { id: 'u1', name: 'u1', avatar: null, rank: Ranks.VISITOR })
  assert.equal((await f.join({ authToken: 'u1' })).method, 'onSnapshot')
  // the same user again (a reload) while the old connection is asked whether it is alive: one place, not two
  let answer
  f.network.answersPing = () => new Promise(resolve => (answer = resolve))
  const again = f.join({ authToken: 'u1' })
  await settle()
  assert.equal(f.network.arriving, 0, 'its place is the one it has')
  assert.equal((await f.join()).method, 'onSnapshot', 'the other place is still free')
  assert.equal((await f.join()).method, 'onKick')
  answer(true)
  assert.equal((await again).snapshot, 'duplicate_user')
  assert.equal(f.network.sockets.size, 2)
  assert.equal(f.network.arriving, 0)
})

test('no player limit: nothing is refused, and the count still returns to zero', async () => {
  const f = fixture()
  const joined = await Promise.all(Array.from({ length: 4 }, () => f.join()))
  assert.ok(joined.every(j => j.method === 'onSnapshot'))
  assert.equal(f.network.arriving, 0)
})

// --- what a connection that is gone was holding ---

async function builders() {
  const f = fixture()
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

test('a builder who leaves in the middle of a move: the app is let go where it is, said to everyone and saved', async () => {
  const { f, one, two } = await builders()
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

test('a builder who leaves in the middle of an upload: the app that never finished loading is removed', async () => {
  const { f, one, two } = await builders()
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

test('a connection that another of the same user has replaced releases nothing', async () => {
  const { f, one } = await builders()
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

test('while the server is stopping nothing is released (the world is saved as it is)', async () => {
  const { f, one } = await builders()
  f.world.entities.add(app('moving', 'bp', { mover: 'one' }))
  f.world.entities.add(app('loading', 'bp', { uploader: 'one' }))
  f.network.stopping = true
  f.network.onDisconnect(one.socket)
  assert.equal(f.world.entities.get('moving').data.mover, 'one')
  assert.ok(f.world.entities.get('loading'))
})
