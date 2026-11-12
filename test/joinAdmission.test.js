import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPacket } from '../src/core/packets.js'
import { SNAPSHOT_CAP } from '../src/core/extras/writeLedger.js'
import {
  GROWTH_RESERVE_BYTES,
  RANKED_RESERVE_PLAYERS,
  SNAPSHOT_FIXED_BYTES,
  SNAPSHOT_PLAYER_BYTES,
  WORLD_JOIN_BYTES,
  joinStateBytes,
  snapshotBound,
  visitorShortfall,
} from '../src/core/extras/joinBudget.js'
import { Ranks } from '../src/core/extras/ranks.js'
import { serverSource } from './lib/networkHarness.mjs'
import { app, apps, fillTo, fixture, long, nextId } from './lib/joinFixture.mjs'

// Who may join when (joinBudget.js, ServerNetwork.onConnection): the real snapshot after its steps must fit its cap,
// for everyone; a visitor must also leave the bound room for ranked users and growth; the fixed part the bound
// counts is measured. The world and the join helper are test/lib/joinFixture.mjs.

// the voice state a configured LiveKit gives a join (its token's length follows LIVEKIT_API_KEY)
const voice = token => ({ wsUrl: `wss://${long(1018)}`, levels: {}, muted: new Set(), token })
// a small player record, put in place directly (the crowd a test needs, without a join each)
const crowd = i => {
  const id = `crowd${String(i).padStart(5, '0')}`
  return {
    id,
    type: 'player',
    position: [0, 1, 0],
    quaternion: [0, 0, 0, 1],
    owner: id,
    userId: id,
    name: 'p',
    rank: 0,
  }
}
// the most players a visitor's join can bring the world to (joinBudget.js visitorShortfall): with them here, the
// bound still has room for RANKED_RESERVE_PLAYERS more and GROWTH_RESERVE_BYTES more world state
const visitorLimit = (world, fixed = SNAPSHOT_FIXED_BYTES) =>
  Math.floor((SNAPSHOT_CAP - joinStateBytes(world) - GROWTH_RESERVE_BYTES - fixed) / SNAPSHOT_PLAYER_BYTES) -
  RANKED_RESERVE_PLAYERS
// a user whose rank is stored (builder 1, admin 2), who joins with their token
const ranked = (f, id, rank = 2) => {
  f.users.set(id, { id, name: id, avatar: null, rank })
  return f.join({ authToken: id })
}

test('join budget: the fixed part is measured from the real fields; a long voice token counts and is reported', async t => {
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  // every environment value at the length index.js allows
  const env = { ASSETS_BASE_URL: `https://${long(1016)}`, PUBLIC_API_URL: `https://${long(1016)}`, ADMIN_CODE: 'x' }
  const f = fixture({ env })
  f.network.maxUploadSize = 12
  f.world.ai = { serialize: () => ({ enabled: true, provider: long(128), model: long(128), effort: long(128) }) }
  f.world.livekit.state = voice('j'.repeat(2048))
  const fixed = await f.network.measureFixedBytes()
  assert.equal(f.network.fixedBytes, fixed)
  // the 24 KiB joinBudget.js expects; the joiner's own record alone is over 8,000 bytes of it
  assert.ok(fixed > 8000 + 3 * 3 * 1016 && fixed <= SNAPSHOT_FIXED_BYTES, `${fixed}`)
  assert.deepEqual(warnings, [])
  // Codex: a 4,096-character LIVEKIT_API_KEY made a 5,915-byte token; a longer key goes past the 24 KiB
  f.world.livekit.state = voice('j'.repeat(30000))
  const larger = await f.network.measureFixedBytes()
  assert.equal(larger - fixed, 30000 - 2048, 'the token is counted byte for byte')
  assert.equal(warnings.length, 1)
  assert.match(
    warnings[0],
    new RegExp(`fixed part measures ${larger} bytes, more than the ${SNAPSHOT_FIXED_BYTES} expected`)
  )
  // visitors are held to it: at the full budget they stop sooner than with the expected size, and no snapshot a
  // join sends is over the cap
  fillTo(f, 0)
  const limit = visitorLimit(f.world, larger)
  assert.ok(limit < visitorLimit(f.world), `${limit}`)
  let count = 0
  while (count < limit - 1) f.world.entities.add(crowd(count++))
  const last = await f.join()
  assert.equal(last.method, 'onSnapshot')
  assert.equal(last.snapshot.livekit.token.length, 30000)
  assert.ok(last.bytes <= SNAPSHOT_CAP)
  assert.equal((await f.join()).method, 'onKick')
})

test("join budget: growth counts the measured fixed part; a visitor's join counts its own when it is larger", () => {
  const f = fixture()
  fillTo(f, 50000)
  for (let i = 0; i < 200; i++) f.world.entities.add(crowd(i))
  // with 200 here: room for an app with the expected 24 KiB, none once the measured part is 110,000 bytes
  assert.equal(f.world.entities.canFitApp('x', app('x')), true)
  f.network.fixedBytes = 110000
  assert.equal(f.world.entities.canFitApp('x', app('x')), false)
  f.network.fixedBytes = 1000
  assert.equal(visitorShortfall(f.world, 1000), null)
  assert.equal(visitorShortfall(f.world, 40000), 'players', "the join's own envelope")
  f.network.fixedBytes = 40000
  assert.equal(visitorShortfall(f.world, 1000), 'players', 'the start-up measurement')
  assert.equal(visitorShortfall(f.world, 300000), 'world')
})

test('join budget: the snapshot carries the upload size the server parsed, never the text (Codex: 260,000 zeros)', async () => {
  const padded = `${'0'.repeat(260000)}12`
  const f = fixture({ env: { PUBLIC_MAX_UPLOAD_SIZE: padded } })
  f.network.init({ db: f.network.db, maxUploadSize: Number(padded) })
  const joined = await f.join()
  assert.equal(joined.method, 'onSnapshot')
  assert.equal(joined.snapshot.maxUploadSize, 12)
  assert.ok(joined.bytes < 10000, `${joined.bytes}`)
  // index.js parses it once and hands world.init the number
  assert.match(serverSource, /^const maxUploadSize = Number\(process\.env\.PUBLIC_MAX_UPLOAD_SIZE\)/m)
  assert.match(serverSource, /^ {2}world\.init\(\{\n[^}]*^ {4}maxUploadSize,\n {2}\}\)/m)
  assert.match(
    serverSource,
    /^await startup\.step\(\(\) => world\.network\.ready\)\n[^]*?^await startup\.step\(\(\) => world\.network\.measureFixedBytes\(\)\)/m
  )
})

// The general formula is the per-player and fixed bounds test above; these cases cross the bound with small player
// records (the joins build real snapshots, so their size is kept small), a crowd put in place directly up to its last
// member, who joins, and a world brought to its budget through the accounting where a case needs it (eight 60 KB
// blueprints and the rest as operator collections).
// The rule reads the rank stored on the user (the users row, `user.rank` in onConnection; after a takeover whose rank
// write is still landing, the in-world rank that write stores). The world's rank setting (free build, or every
// player an admin without ADMIN_CODE: Settings.effectiveRank) and a session-only token grant (rankGrants.js) are
// effective ranks, not stored ones, so they do not skip it.
test('join budget: the visitor rule reads the stored rank, not a free-build world rank or a token grant', async () => {
  const f = fixture()
  fillTo(f, 0)
  // a wallet holder who came in early and was made builder by token: player.data only, the row keeps rank 0
  f.users.set('wallet1', { id: 'wallet1', name: 'w', avatar: null, rank: Ranks.VISITOR })
  assert.equal((await f.join({ authToken: 'wallet1' })).method, 'onSnapshot')
  const holder = f.world.entities.get('wallet1')
  holder.data.tokenGrantedRank = true
  holder.modify({ rank: Ranks.BUILDER })
  let count = 0
  while (f.world.entities.players.size < visitorLimit(f.world)) f.world.entities.add(crowd(count++))
  // free build: the world makes everyone a builder; a newcomer is still a visitor here
  f.world.settings.rank = Ranks.BUILDER
  f.world.settings.setHasAdminCode(true)
  assert.equal(f.world.settings.effectiveRank, Ranks.BUILDER)
  assert.equal((await f.join()).method, 'onKick')
  // without ADMIN_CODE everyone is an admin in the world, and still a visitor here
  f.world.settings.setHasAdminCode(false)
  assert.equal(f.world.settings.effectiveRank, Ranks.ADMIN)
  assert.equal((await f.join()).method, 'onKick')
  // the token holder leaves (one more takes the place) and comes back: the grant was never stored
  f.network.sockets.delete('wallet1')
  f.world.entities.remove('wallet1')
  f.world.entities.add(crowd(count++))
  assert.equal(f.users.get('wallet1').rank, Ranks.VISITOR)
  assert.equal((await f.join({ authToken: 'wallet1' })).method, 'onKick')
  // once the rank is stored, the same user skips the rule
  f.users.get('wallet1').rank = Ranks.BUILDER
  assert.equal((await f.join({ authToken: 'wallet1' })).method, 'onSnapshot')
})

test('join budget: visitors stop where ranked users and growth keep their room; a stored rank always gets in', async () => {
  const f = fixture()
  fillTo(f, 0)
  // the number joinBudget.js states for a full 768 KiB world
  const limit = visitorLimit(f.world)
  assert.equal(limit, 159)
  let count = 0
  while (count < limit - 1) f.world.entities.add(crowd(count++))
  const last = await f.join()
  assert.equal(last.method, 'onSnapshot')
  assert.equal(f.world.entities.players.size, limit)
  // the next visitors are turned away with the player-limit kick, the reason logged once
  for (let i = 0; i < 2; i++) {
    const refused = await f.join()
    assert.equal(refused.method, 'onKick')
    assert.equal(readPacket(refused.ws.packets[0])[1], 'player_limit')
  }
  const reason = f.logs.filter(line => line.includes('a visitor was turned away: with'))
  assert.equal(reason.length, 1)
  assert.match(reason[0], /keeps its last room for 8 users with a stored rank of builder or above and 64 KiB/)
  // the room kept: eight ranked users fit the bound after them
  for (let i = 0; i < RANKED_RESERVE_PLAYERS; i++) {
    assert.equal((await ranked(f, `admin${i}`)).method, 'onSnapshot')
    assert.ok(snapshotBound(joinStateBytes(f.world), f.world.entities.players.size) <= SNAPSHOT_CAP)
  }
  // Codex's crowd: 231 here (as many as the bound holds) kept a stored admin out; only the real size counts for
  // ranked users now, and it fits with four times that as well
  for (const size of [231, 1024]) {
    while (f.world.entities.players.size < size) f.world.entities.add(crowd(count++))
    const admin = await ranked(f, `late${size}`)
    assert.equal(admin.method, 'onSnapshot')
    assert.ok(admin.bytes <= SNAPSHOT_CAP)
    assert.equal((await ranked(f, `builder${size}`, 1)).method, 'onSnapshot')
    assert.equal((await f.join()).method, 'onKick', 'a visitor still is not')
  }
  assert.equal(f.logs.filter(line => line.includes('turned away')).length, 1)
  // growth stays held to the players here, though the budget has room for it
  f.network.collectionsBytes -= 50000
  f.network.onEntityAdded(f.builder, app('grows', 'bp', { state: { notes: 'n'.repeat(2000) } }))
  assert.equal(f.world.entities.get('grows'), undefined)
})

test('join budget: in a nearly empty world visitors stop short of the bound, and building goes on (Codex: 998 visitors)', async () => {
  const f = fixture()
  const limit = visitorLimit(f.world)
  assert.ok(limit > 900 && limit < 998, `${limit}`)
  let count = 0
  while (count < limit - 1) f.world.entities.add(crowd(count++))
  assert.equal((await f.join()).method, 'onSnapshot')
  assert.equal((await f.join()).method, 'onKick')
  // a ~1 KiB app is added, and a 60 KB blueprint: the growth kept for them
  f.network.onEntityAdded(f.builder, app('grows', 'bp', { state: { notes: 'n'.repeat(1000) } }))
  assert.ok(f.world.entities.get('grows'))
  f.send('blueprintAdded', { id: 'big', version: 0, props: { notes: 'n'.repeat(60000) } })
  assert.ok(f.world.blueprints.get('big'))
  // and a stored admin joins, to moderate
  assert.equal((await ranked(f, 'admin')).method, 'onSnapshot')
})

test('join budget: a world stored far over its budget (5,100 apps) takes a stored admin, not visitors, and refuses growth', async () => {
  const f = fixture()
  // loaded at start-up as stored: nothing is refused or dropped
  for (let i = 0; i < 5100; i++) f.world.entities.add(app(`legacy${String(i).padStart(4, '0')}`))
  const counted = joinStateBytes(f.world)
  // Codex's probe world: over the budget, and the bound with one player over the cap (which refused everyone)
  assert.equal(counted, 1035412)
  assert.ok(counted > WORLD_JOIN_BYTES && snapshotBound(counted, 1) > SNAPSHOT_CAP)
  const visitor = await f.join()
  assert.equal(visitor.method, 'onKick')
  assert.equal(readPacket(visitor.ws.packets[0])[1], 'player_limit')
  assert.match(
    f.logs.find(line => line.includes('turned away')),
    /the world's state \(\d+ bytes counted\) and the snapshot's fixed part \(\d+ bytes\) leave the join snapshot no room for visitors/
  )
  // the counted size is an upper bound: what the admin is sent is far smaller (Codex: 1,035,412 against 592,143)
  const admin = await ranked(f, 'admin')
  assert.equal(admin.method, 'onSnapshot')
  assert.ok(admin.bytes < counted * 0.7 && admin.bytes <= SNAPSHOT_CAP, `${admin.bytes}`)
  assert.equal(admin.snapshot.entities.length, 5101)
  // growth is refused; the admin shrinks the world, and once the bound has room for them visitors come back
  f.network.onEntityAdded(f.builder, app(nextId()))
  assert.equal(apps(f.world).length, 5100)
  let removed = 0
  while (visitorShortfall(f.world, 0)) f.send('entityRemoved', `legacy${String(removed++).padStart(4, '0')}`)
  // down to 948,224 counted (the cap less 64 KiB, 24 KiB and nine players): about 430 apps of 203 bytes
  assert.ok(removed > 400 && removed < 500, `${removed}`)
  assert.equal((await f.join()).method, 'onSnapshot')
})
