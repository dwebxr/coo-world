import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ranks } from '../src/core/extras/ranks.js'
import { readPacket } from '../src/core/packets.js'
import { createKickList } from '../src/server/kickList.js'
import { fixture } from './lib/joinFixture.mjs'

const MINUTE = 60 * 1000

// A world with an admin code (so a visitor is a visitor), a stored admin, a stored builder and visitors
async function stage({ limits = { minutes: 10 }, env = {} } = {}) {
  const f = fixture({ env })
  f.world.settings.setHasAdminCode(true)
  f.world.settings.rank = Ranks.VISITOR
  const clock = { time: 1000 }
  f.network.kickList = createKickList(limits, { now: () => clock.time })
  const muted = []
  f.world.livekit.muted = new Set()
  f.world.livekit.setMuted = (playerId, value) => muted.push([playerId, value])
  const enter = async (id, rank, origin) => {
    if (!f.users.has(id)) f.users.set(id, { id, name: id, avatar: null, rank })
    const joined = await f.join({ authToken: id }, origin)
    return { ...joined, socket: f.network.sockets.get(id) }
  }
  const kickCode = joined => {
    assert.equal(joined.method, 'onKick')
    return joined.snapshot
  }
  return { f, clock, muted, enter, kickCode }
}

const packets = ws => ws.packets.map(readPacket)

test('kick: the player is told, closed and kept out for the minutes; then let in again', async t => {
  const lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  const { f, clock, enter, kickCode } = await stage()
  const admin = await enter('admin', Ranks.ADMIN)
  const visitor = await enter('visitor', Ranks.VISITOR)
  assert.equal(visitor.method, 'onSnapshot')
  f.send('kick', 'visitor', admin.socket)
  visitor.ws.drain()
  assert.deepEqual(packets(visitor.ws).at(-1), ['onKick', 'moderation'])
  assert.equal(f.network.sockets.has('visitor'), false)
  assert.equal(f.world.entities.getPlayer('visitor'), undefined)
  assert.deepEqual(lines, ['[network] "admin" kicked "visitor": kept out for 10 min'])

  // the same user comes straight back: refused where the user is first known (no voice token is made for it),
  // nothing added or announced
  admin.ws.packets.length = 0
  let tokens = 0
  const serialize = f.world.livekit.serialize
  f.world.livekit.serialize = (...args) => (tokens++, serialize(...args))
  const back = await enter('visitor', Ranks.VISITOR)
  assert.equal(kickCode(back), 'kicked')
  assert.equal(tokens, 0)
  assert.equal(back.ws.readyState, 3)
  assert.equal(f.network.sockets.has('visitor'), false)
  assert.equal(f.network.connecting.has('visitor'), false)
  admin.ws.drain()
  assert.deepEqual(packets(admin.ws), [], 'nobody is told of a refused join')

  clock.time += 10 * MINUTE
  assert.equal((await enter('visitor', Ranks.VISITOR)).method, 'onSnapshot')
})

test('kick: KICK_MINUTES=0 only disconnects', async t => {
  const lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  const { f, enter } = await stage({ limits: { minutes: 0 } })
  const admin = await enter('admin', Ranks.ADMIN)
  await enter('visitor', Ranks.VISITOR)
  f.send('kick', 'visitor', admin.socket)
  assert.equal(f.network.sockets.has('visitor'), false)
  assert.deepEqual(lines, ['[network] "admin" kicked "visitor"'])
  assert.equal((await enter('visitor', Ranks.VISITOR)).method, 'onSnapshot')
})

test('kick and mute: only a player who outranks the target, by the rank the players pane shows', async () => {
  const { f, muted, enter } = await stage()
  const admin = await enter('admin', Ranks.ADMIN)
  await enter('admin2', Ranks.ADMIN)
  const builder = await enter('builder1', Ranks.BUILDER)
  const visitor = await enter('visitor', Ranks.VISITOR)
  const visitor2 = await enter('visitor2', Ranks.VISITOR)
  const here = () => [...f.network.sockets.keys()].sort()
  const everyone = here()
  const refused = [
    [visitor, 'visitor2', 'a visitor'],
    [visitor, 'builder1', 'a visitor upwards'],
    [visitor, 'visitor', 'oneself'],
    [builder, 'builder1', 'oneself as a builder'],
    [builder, 'admin', 'a builder upwards'],
    [admin, 'admin2', 'an admin on an admin'],
    [admin, 'admin', 'an admin on oneself'],
  ]
  for (const [actor, target, label] of refused) {
    f.send('kick', target, actor.socket)
    f.send('mute', { playerId: target, muted: true }, actor.socket)
    assert.deepEqual(here(), everyone, label)
    assert.deepEqual(muted, [], label)
  }
  assert.deepEqual(f.network.kickList.stats(), { users: 0, addresses: 0 })

  // what is not a player's id names nobody: an app (it has no rank, and passed the old comparison), a missing id,
  // a value that is not a string
  f.world.entities.add({ id: 'app1', type: 'app', blueprint: 'bp', position: [0, 0, 0], quaternion: [0, 0, 0, 1] })
  for (const target of ['app1', 'nobody', 7, null, { id: 'visitor' }, ['visitor']]) {
    for (const actor of [visitor, admin]) {
      f.send('kick', target, actor.socket)
      f.send('mute', { playerId: target, muted: true }, actor.socket)
    }
  }
  assert.deepEqual(here(), everyone)
  assert.deepEqual(muted, [])

  // a mute's value is a boolean
  for (const value of [1, 'true', null, undefined, {}]) {
    f.send('mute', { playerId: 'visitor', muted: value }, admin.socket)
  }
  f.send('mute', 'visitor', admin.socket)
  assert.deepEqual(muted, [])

  // downwards it works: a builder on a visitor, an admin on a builder
  f.send('mute', { playerId: 'visitor', muted: true }, builder.socket)
  f.send('mute', { playerId: 'builder1', muted: false }, admin.socket)
  assert.deepEqual(muted, [
    ['visitor', true],
    ['builder1', false],
  ])
  f.send('kick', 'visitor2', builder.socket)
  f.send('kick', 'builder1', admin.socket)
  assert.deepEqual(here(), ['admin', 'admin2', 'visitor'])
  visitor2.ws.drain()
  assert.deepEqual(packets(visitor2.ws).at(-1), ['onKick', 'moderation'])
})

test('kick and mute: where everyone is an admin (no admin code) nobody outranks anybody', async () => {
  const { f, muted, enter } = await stage()
  f.world.settings.setHasAdminCode(false)
  const admin = await enter('admin', Ranks.ADMIN)
  await enter('visitor', Ranks.VISITOR)
  f.send('kick', 'visitor', admin.socket)
  f.send('mute', { playerId: 'visitor', muted: true }, admin.socket)
  assert.equal(f.network.sockets.has('visitor'), true)
  assert.deepEqual(muted, [])
})

test('kick: a world rank setting counts for both sides, as in the players pane', async () => {
  const { f, enter } = await stage()
  f.world.settings.rank = Ranks.BUILDER
  const builder = await enter('builder1', Ranks.BUILDER)
  const admin = await enter('admin', Ranks.ADMIN)
  await enter('visitor', Ranks.VISITOR)
  // everyone is a builder here: a stored builder no longer outranks a visitor
  f.send('kick', 'visitor', builder.socket)
  assert.equal(f.network.sockets.has('visitor'), true)
  f.send('kick', 'visitor', admin.socket)
  assert.equal(f.network.sockets.has('visitor'), false)
})

test('kick: the address holds only newcomers, only when asked for, only after an admin', async () => {
  const origin = { key: '203.0.113.7', parents: [] }
  const elsewhere = { key: '198.51.100.9', parents: [] }
  {
    const { f, enter, kickCode } = await stage({ limits: { minutes: 10, byAddress: true } })
    const admin = await enter('admin', Ranks.ADMIN, elsewhere)
    await enter('visitor', Ranks.VISITOR, origin)
    await enter('resident', Ranks.VISITOR, origin)
    f.send('kick', 'visitor', admin.socket)
    const rows = f.users.size
    // no session token from that address: the way around the id entry
    assert.equal(kickCode(await f.join({}, origin)), 'kicked')
    assert.equal(kickCode(await f.join({ authToken: 'forged' }, origin)), 'kicked', 'a token that names no user')
    assert.equal(f.users.size, rows, 'no user row is made for a refused newcomer')
    // from elsewhere a newcomer joins; from there, so does a returning user (and one already here stays)
    assert.equal((await f.join({}, elsewhere)).method, 'onSnapshot')
    f.users.set('returning', { id: 'returning', name: 'r', avatar: null, rank: Ranks.VISITOR })
    assert.equal((await f.join({ authToken: 'returning' }, origin)).method, 'onSnapshot')
    assert.equal(f.network.sockets.has('resident'), true)
    assert.equal(kickCode(await f.join({ authToken: 'visitor' }, elsewhere)), 'kicked', 'the id entry holds anywhere')
  }
  {
    // a builder's kick makes no address entry
    const { f, enter } = await stage({ limits: { minutes: 10, byAddress: true } })
    const builder = await enter('builder1', Ranks.BUILDER, elsewhere)
    await enter('visitor', Ranks.VISITOR, origin)
    f.send('kick', 'visitor', builder.socket)
    assert.equal(f.network.sockets.has('visitor'), false)
    assert.equal((await f.join({}, origin)).method, 'onSnapshot')
  }
  {
    // off unless asked for
    const { f, enter } = await stage()
    const admin = await enter('admin', Ranks.ADMIN, elsewhere)
    await enter('visitor', Ranks.VISITOR, origin)
    f.send('kick', 'visitor', admin.socket)
    assert.equal((await f.join({}, origin)).method, 'onSnapshot')
  }
})

test('kick: one that lands while the same user reconnects is not passed by the new connection', async t => {
  t.mock.method(console, 'log', () => {})
  const { f, enter, kickCode } = await stage()
  const admin = await enter('admin', Ranks.ADMIN)
  const old = await enter('visitor', Ranks.VISITOR)
  // The same user connects again (a reload). The id is not listed yet, so the new connection passes the first
  // check and waits while the old connection is asked whether it is alive. The question is held here until the
  // kick has landed, so no deadline decides which comes first
  let answer
  const asked = new Promise(resolve => {
    f.network.answersPing = socket => {
      resolve(socket)
      return new Promise(settle => (answer = settle))
    }
  })
  const pending = f.join({ authToken: 'visitor' })
  assert.equal(await asked, old.socket, 'the old connection is asked')
  assert.equal(f.network.connecting.has('visitor'), true, 'the new connection is waiting')
  // the kick lands on the old connection meanwhile; closed, it answers no, which lets the new one go on
  f.send('kick', 'visitor', admin.socket)
  assert.equal(f.network.sockets.has('visitor'), false)
  answer(false)
  assert.equal(kickCode(await pending), 'kicked')
  assert.equal(f.network.sockets.has('visitor'), false)
  assert.equal(f.world.entities.getPlayer('visitor'), undefined)
  assert.equal(f.network.connecting.has('visitor'), false)
})

test('a muted player who comes back is said to be muted again', async () => {
  const { f, enter } = await stage()
  const admin = await enter('admin', Ranks.ADMIN)
  f.world.livekit.muted.add('visitor')
  admin.ws.packets.length = 0
  const visitor = await enter('visitor', Ranks.VISITOR)
  admin.ws.drain()
  visitor.ws.drain()
  for (const ws of [admin.ws, visitor.ws]) {
    assert.ok(
      packets(ws).some(([name, data]) => name === 'onMute' && data.playerId === 'visitor' && data.muted === true),
      'everyone here, the player included'
    )
  }
  admin.ws.packets.length = 0
  await enter('other', Ranks.VISITOR)
  admin.ws.drain()
  assert.ok(!packets(admin.ws).some(([name]) => name === 'onMute'), 'nothing for a player who is not muted')
})
