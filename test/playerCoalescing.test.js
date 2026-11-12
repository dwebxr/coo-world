import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ranks } from '../src/core/extras/ranks.js'
import { readPacket, writeClientPacket, writePacket } from '../src/core/packets.js'
import { clamp } from '../src/core/utils.js'
import { prng } from '../src/core/extras/prng.js'
import { createInboundGate } from '../src/core/extras/inboundPolicy.js'
import {
  EFFECT_MAX_BYTES,
  STORED_AVATAR_MAX_LENGTH,
  sanitizePlayerSelfModify,
} from '../src/core/extras/entityModifyPolicy.js'
import { BACKLOG_CAP, SCRIPT_TICK_CAP, WRITE_OVERHEAD } from '../src/core/extras/writeLedger.js'
import { loadClient } from './lib/clientHarness.mjs'
import { fixture } from './lib/joinFixture.mjs'

// the server's player entity: its modify, setEffect and destroy are the real ones, on the fixture's stand-in
const Player = loadClient('core/entities/PlayerRemote.js', 'PlayerRemote', { avatarChosen() {}, chatBubble() {} })
const createPlayerProxy = loadClient('core/extras/createPlayerProxy.js', 'createPlayerProxy', { clamp })
const remoteParts = () => ({
  modify: Player.prototype.modify,
  setEffect: Player.prototype.setEffect,
  destroy: Player.prototype.destroy,
  teleport: 0,
  position: { push() {} },
  quaternion: { push() {} },
  axis: { fromArray() {} },
  gaze: { fromArray() {} },
  nametag: {},
  body: {},
  base: { deactivate() {} },
  aura: { deactivate() {} },
  applyAvatar() {},
})
// What every client is told of a player, as the entity keeps it (PlayerRemote.modify). The server's player data is
// made in the connection handler's own realm, and holds what only the server keeps: compared as the JSON of these
const TOLD = ['position', 'quaternion', 'mode', 'axis', 'gaze', 'emote', 'effect', 'name', 'health', 'avatar'].concat([
  'sessionAvatar',
  'rank',
  'evmTips',
])
const plain = data => JSON.parse(JSON.stringify(Object.fromEntries(TOLD.map(key => [key, data[key] ?? null]))))
const EXTERNAL_VRM = 'https://cdn.example/avatar.vrm'
const EXTERNAL_GLB = 'https://cdn.example/emote.glb'
const TICK_MS = 1000 / 30

// The real network handlers (joinFixture) with an admin and visitors `a`, `b` and `c`, and a stand-in app whose
// server script acts on players through the real player handle (createPlayerProxy) when an event asks it to.
// `tick()` is the server's tick (preFixedUpdate): this tick's packets, then what was kept for its end.
async function stage({ visitors = ['a', 'b'] } = {}) {
  const f = fixture({ env: { ASSETS_BASE_URL: 'http://localhost/assets' } })
  const world = f.world
  world.settings.setHasAdminCode(true)
  world.settings.rank = Ranks.VISITOR
  world.emit = () => {}
  world.setHot = () => {}
  world.chat.add = () => {}
  const who = {}
  for (const id of ['admin', ...visitors]) {
    f.users.set(id, { id, name: id, avatar: null, rank: id === 'admin' ? Ranks.ADMIN : Ranks.VISITOR })
    const joined = await f.join({ authToken: id })
    const socket = f.network.sockets.get(id)
    Object.assign(socket.player, remoteParts())
    who[id] = { id, ws: joined.ws, socket, player: socket.player }
  }
  const everyone = Object.values(who)
  const got = one => {
    one.ws.drain()
    const all = one.ws.packets.map(readPacket)
    one.ws.packets.length = 0
    return all
  }
  for (const one of everyone) got(one)
  // what `watcher` was told about `subject`: the entityModified data, in order
  const told = (packets, subject) =>
    packets.filter(([name, data]) => name === 'onEntityModified' && data.id === subject.id).map(([, data]) => data)
  // a client's copy of another player: the server's data when the copy was made, then every change it is told,
  // applied as a client applies them
  const copies = new Map()
  const copyOf = (watcher, subject) => {
    const key = `${watcher.id} ${subject.id}`
    if (!copies.has(key)) {
      const world = { emit() {}, events: { emit() {} } }
      copies.set(key, { ...remoteParts(), world, data: structuredClone(subject.player.data) })
    }
    return copies.get(key)
  }
  // every connection reads what it was sent; each copy applies it; -> what each was sent
  const settle = () => {
    const seen = {}
    for (const watcher of everyone) {
      seen[watcher.id] = got(watcher)
      for (const subject of everyone) {
        if (subject === watcher) continue
        const copy = copyOf(watcher, subject)
        for (const data of told(seen[watcher.id], subject)) copy.modify(data)
      }
    }
    return seen
  }
  // every copy of every player is the server's player
  const assertInStep = message => {
    for (const watcher of everyone) {
      for (const subject of everyone) {
        if (subject === watcher || subject.player.destroyed) continue
        assert.deepEqual(
          plain(copyOf(watcher, subject).data),
          plain(subject.player.data),
          `${watcher.id}'s copy of ${subject.id}${message ? `: ${message}` : ''}`
        )
      }
    }
  }
  for (const watcher of everyone) for (const subject of everyone) if (subject !== watcher) copyOf(watcher, subject)
  // the server script: an event named after an action runs it
  const actions = {}
  world.entities.items.set('script', {
    isApp: true,
    data: { id: 'script', blueprint: 'bp' },
    serialize() {
      return this.data
    },
    modify() {},
    onEvent: (version, name, data, from) => actions[name]?.(data, from),
  })
  const handles = new Map()
  const handle = one => {
    if (!handles.has(one.id)) {
      handles.set(one.id, createPlayerProxy({ data: { id: 'script' }, deadHook: { dead: false } }, one.player))
    }
    return handles.get(one.id)
  }
  const packet = (one, name, data) => one.socket.ws.emit('message', writeClientPacket(name, data))
  const own = (one, fields) => packet(one, 'entityModified', { id: one.id, ...fields })
  const ask = (one, name, data = null) => packet(one, 'entityEvent', ['script', 0, name, data])
  const tick = () => f.network.preFixedUpdate()
  const pending = () => f.network.pending?.size ?? 0
  return {
    f,
    world,
    ...who,
    everyone,
    got,
    told,
    settle,
    assertInStep,
    actions,
    handle,
    packet,
    own,
    ask,
    tick,
    pending,
  }
}

test('one change in a tick: the others get the packet they got before, when the tick ends; the sender gets nothing', async () => {
  const s = await stage()
  const fields = { p: [1, 2, 3], q: [0, 0, 0, 1], m: 2, a: [0, 0, 1], g: [0, 0, -1], e: null, t: true }
  s.own(s.a, fields)
  // a line of chat after it, in the same tick, is written before it: the change waits for the end of the flush
  s.packet(s.a, 'chatAdded', { body: 'hello' })
  assert.deepEqual(s.got(s.b), [], 'nothing is written before the tick')
  s.tick()
  assert.equal(s.pending(), 0)
  s.b.ws.drain()
  assert.equal(s.b.ws.packets.length, 2)
  assert.equal(readPacket(s.b.ws.packets[0])[0], 'onChatAdded')
  assert.deepEqual(
    Buffer.from(s.b.ws.packets[1]),
    Buffer.from(writePacket('entityModified', { id: 'a', ...fields })),
    'byte for byte the packet written for this change before'
  )
  assert.deepEqual(s.told(s.got(s.admin), s.a), [{ id: 'a', ...fields }])
  assert.deepEqual(s.told(s.got(s.a), s.a), [], 'nothing of it to the sender')
  assert.deepEqual(s.a.player.data.position, [1, 2, 3], 'applied')
  // a tick without a change writes nothing
  s.got(s.b)
  s.tick()
  assert.deepEqual(s.got(s.b), [])
})

test('a thousand changes of one player in a tick: one packet to each of the others, the latest of each field', async () => {
  const s = await stage()
  // handled in one tick (the inbox hands a tick about 300 such packets of one connection: see below)
  for (let i = 0; i < 1000; i++) {
    const fields = { id: 'a', p: [i, 0, -i] }
    if (i === 10) Object.assign(fields, { q: [0, 1, 0, 0], t: true })
    if (i % 100 === 0) fields.m = i / 100
    if (i === 500) fields.ef = { freeze: true }
    if (i === 998) fields.g = [0, 1, 0]
    s.f.network.onEntityModified(s.a.socket, fields, { at: 1000 })
    assert.deepEqual(s.a.player.data.position, [i, 0, -i], 'each is applied as it comes')
  }
  assert.equal(s.pending(), 1, 'one entry for the player, whatever it sent')
  s.tick()
  assert.equal(s.pending(), 0)
  const merged = { id: 'a', p: [999, 0, -999], m: 9, q: [0, 1, 0, 0], t: true, ef: { freeze: true }, g: [0, 1, 0] }
  assert.deepEqual(s.told(s.got(s.b), s.a), [merged])
  assert.deepEqual(s.told(s.got(s.admin), s.a), [merged])
  assert.deepEqual(s.got(s.a), [])
  // through the real admission: every tick that handled some of them writes one packet, and the others end where
  // the server is
  for (let i = 0; i < 1000; i++) s.own(s.a, { p: [i, 1, 0], a: [0, 0, i % 2] })
  let ticks = 0
  for (; s.a.socket.inbox.length; ticks++) {
    s.tick()
    assert.equal(s.pending(), 0)
  }
  const seen = s.told(s.got(s.b), s.a)
  assert.equal(seen.length, ticks)
  assert.ok(ticks >= 2 && ticks <= 6, `${ticks} ticks for 1000 packets`)
  assert.deepEqual(seen.at(-1), { id: 'a', p: [999, 1, 0], a: [0, 0, 1] })
  assert.deepEqual(s.a.player.data.position, [999, 1, 0])
})

test('two players changing in one tick: one packet each, to everyone but its own connection', async () => {
  const s = await stage()
  for (let i = 0; i < 20; i++) {
    s.own(s.b, { p: [0, i, 0] })
    s.own(s.a, { p: [i, 0, 0] })
  }
  s.tick()
  const seen = s.settle()
  assert.deepEqual(seen.admin, [
    ['onEntityModified', { id: 'b', p: [0, 19, 0] }],
    ['onEntityModified', { id: 'a', p: [19, 0, 0] }],
  ])
  assert.deepEqual(seen.a, [['onEntityModified', { id: 'b', p: [0, 19, 0] }]])
  assert.deepEqual(seen.b, [['onEntityModified', { id: 'a', p: [19, 0, 0] }]])
  s.assertInStep()
})

// what a hostile client sends for its own player: about the largest change that still costs the inbound gate one
// unit (under 2048 bytes and under 32 nodes), so that a thousand a second are let through
const heavy = i => ({
  p: [i, 0.5, -i],
  q: [0, 0, 0, 1],
  m: i % 7,
  ef: { anchorId: 'n'.repeat(128), emote: 'e'.repeat(512), snare: 's'.repeat(512), freeze: 'f'.repeat(420) },
})

test("a recipient on a slow link is not closed by one visitor's flood of its own player's changes", async t => {
  const s = await stage()
  let clock = 80_000
  t.mock.method(performance, 'now', () => clock)
  s.f.network.gate = createInboundGate({ now: () => clock, log: line => s.f.logs.push(line) })
  const bytes = writeClientPacket('entityModified', { id: 'a', ...heavy(0) }).length
  assert.ok(bytes > 1600 && bytes < 2048, `${bytes} bytes a packet`)
  // b takes 125 KB a second off its connection (1 Mbit/s), in the order written; what it has not taken yet is what
  // the write ledger holds against it (the bytes and 1 KiB a write)
  const slow = { done: 0, credit: 0, most: 0 }
  const queued = () => {
    let sum = 0
    for (let i = slow.done; i < s.b.ws.packets.length; i++) sum += s.b.ws.packets[i].length + WRITE_OVERHEAD
    return sum
  }
  const drainSlowly = () => {
    slow.most = Math.max(slow.most, queued())
    slow.credit += 125_000 / 30
    while (slow.done < s.b.ws.packets.length && slow.credit >= s.b.ws.packets[slow.done].length) {
      slow.credit -= s.b.ws.packets[slow.done].length
      s.b.ws.pending[slow.done]()
      slow.done++
    }
    // an idle link saves nothing up
    if (slow.done === s.b.ws.packets.length) slow.credit = 0
  }
  // a thousand a second for a minute, as the inbound gate admits them; a tick every 33 ms
  let sent = 0
  const start = clock
  for (let n = 1; n <= 30 * 60; n++) {
    const tickAt = start + n * TICK_MS
    for (; start + sent < tickAt; sent++) {
      clock = start + sent
      s.own(s.a, heavy(sent))
    }
    clock = tickAt
    const before = s.b.ws.packets.length
    s.tick()
    assert.ok(s.b.ws.packets.length - before <= 1, 'at most one packet about the flooder is written to b in a tick')
    assert.equal(s.pending(), 0)
    drainSlowly()
    s.got(s.admin)
    if (s.b.ws.readyState !== 1) break
  }
  assert.equal(s.b.ws.terminations, 0, 'b is never closed')
  assert.equal(s.b.ws.readyState, 1)
  assert.equal(sent, 60_000)
  assert.equal(s.f.network.gate.dropped(s.a.socket), 0, 'the inbound gate let every packet through')
  assert.deepEqual(s.a.player.data.position, [sent - 1, 0.5, -(sent - 1)], 'the server applied every one')
  assert.equal(s.b.ws.packets.length, 30 * 60, 'one packet a tick')
  // b's backlog never got near the megabyte at which a connection is closed: a few packets at most
  assert.ok(slow.most < BACKLOG_CAP / 64, `at most ${slow.most} bytes queued for b`)
  assert.deepEqual(readPacket(s.b.ws.packets.at(-1))[1].p, [sent - 1, 0.5, -(sent - 1)], 'and b ends where a is')
})

// each case: what `a`'s own client sent, then, in the same tick, what the server itself tells everyone about `a`
const serverWrites = [
  {
    name: "a script's effect",
    own: { p: [1, 0, 0], ef: { freeze: true } },
    write: s => s.ask(s.a, 'effect'),
    told: [
      { id: 'a', ef: { snare: 0.5, duration: 5 } },
      { id: 'a', p: [1, 0, 0] },
    ],
    ends: data => assert.deepEqual(data.effect, { snare: 0.5, duration: 5 }),
  },
  {
    name: "a script's session avatar",
    own: { p: [1, 0, 0], sessionAvatar: 'asset://mine.vrm' },
    write: s => s.ask(s.a, 'avatar'),
    told: [
      { id: 'a', sessionAvatar: 'asset://script.vrm' },
      { id: 'a', p: [1, 0, 0] },
    ],
    ends: data => assert.equal(data.sessionAvatar, 'asset://script.vrm'),
  },
  {
    name: "a script's damage",
    own: { p: [1, 0, 0], ef: { freeze: true } },
    write: s => s.ask(s.a, 'damage'),
    told: [
      { id: 'a', health: 60 },
      { id: 'a', p: [1, 0, 0], ef: { freeze: true } },
    ],
    ends: data => assert.equal(data.health, 60),
  },
  {
    name: '/name',
    own: { p: [1, 0, 0], name: 'by packet' },
    write: s => s.packet(s.a, 'command', { args: ['name', 'by command'] }),
    told: [
      { id: 'a', name: 'by command' },
      { id: 'a', p: [1, 0, 0] },
    ],
    ends: data => assert.equal(data.name, 'by command'),
  },
  {
    name: 'a rank taken away, and with it the urls a builder may show',
    builder: true,
    own: { p: [1, 0, 0], sessionAvatar: EXTERNAL_VRM, e: EXTERNAL_GLB },
    write: s => s.packet(s.admin, 'modifyRank', { playerId: 'a', rank: Ranks.VISITOR }),
    told: [
      { id: 'a', rank: Ranks.VISITOR },
      { id: 'a', sessionAvatar: null, e: null },
      { id: 'a', p: [1, 0, 0] },
    ],
    ends: data => assert.deepEqual([data.sessionAvatar, data.emote, data.rank], [null, null, Ranks.VISITOR]),
  },
]
for (const { name, builder, own, write, told, ends } of serverWrites) {
  test(`what the server tells everyone about a player is not undone by that player's own change of the same tick: ${name}`, async () => {
    const s = await stage()
    s.actions.effect = () => s.handle(s.a).applyEffect({ snare: 0.5, duration: 5 })
    s.actions.avatar = () => s.handle(s.a).setSessionAvatar('asset://script.vrm')
    s.actions.damage = () => s.handle(s.a).damage(40)
    if (builder) {
      s.packet(s.admin, 'modifyRank', { playerId: 'a', rank: Ranks.BUILDER })
      s.tick()
      s.settle()
    }
    s.own(s.a, own)
    write(s)
    s.tick()
    assert.equal(s.pending(), 0)
    const seen = s.settle()
    assert.deepEqual(s.told(seen.b, s.a), told)
    assert.deepEqual(s.told(seen.admin, s.a), told)
    ends(s.a.player.data)
    s.assertInStep()
    // the other way round the player's own change is the later one, and is told
    const again = await stage()
    again.actions.effect = () => again.handle(again.a).applyEffect({ snare: 0.5, duration: 5 })
    again.actions.avatar = () => again.handle(again.a).setSessionAvatar('asset://script.vrm')
    again.actions.damage = () => again.handle(again.a).damage(40)
    if (builder) {
      again.packet(again.admin, 'modifyRank', { playerId: 'a', rank: Ranks.BUILDER })
      again.tick()
      again.settle()
      // (told before its rank goes: once a visitor, it may not name these)
      again.own(again.a, own)
      again.tick()
      again.settle()
    }
    write(again)
    again.tick()
    again.own(again.a, own)
    again.tick()
    again.settle()
    again.assertInStep()
  })
}

test('only a change of the player takes fields out of what is pending for it, not another packet that names it', async () => {
  const s = await stage()
  s.f.network.onEntityModified(s.a.socket, { id: 'a', p: [1, 0, 0], sessionAvatar: 'asset://mine.vrm' }, { at: 1000 })
  // (the packet that announces a player carries its id, its name and its avatars)
  s.f.network.send('entityAdded', { id: 'a', type: 'player', name: 'a', sessionAvatar: null, p: null })
  s.tick()
  assert.deepEqual(s.told(s.got(s.b), s.a), [{ id: 'a', p: [1, 0, 0], sessionAvatar: 'asset://mine.vrm' }])
})

test('a script write that was refused takes nothing out of what is pending', async () => {
  const s = await stage()
  s.actions.effect = () => s.handle(s.a).applyEffect({ snare: 0.5, duration: 5 })
  s.actions.avatar = () => s.handle(s.a).setSessionAvatar('asset://script.vrm')
  // this tick's budget for script writes is used up to its last bytes: large packets until one is refused, then
  // the smallest there is (the tick is ended by hand below: a new one would start a new budget)
  s.f.network.writer.resetTick()
  let written = 0
  for (const filler of [{ body: 'x'.repeat(60000) }, 0]) {
    for (;;) {
      let result
      s.f.network.asScript(() => (result = s.f.network.broadcast('chatAdded', filler)), { id: 'script' }, 'fill')
      for (const one of s.everyone) s.got(one)
      if (result === 'refused') break
      written += writePacket('chatAdded', filler).length
    }
  }
  assert.ok(SCRIPT_TICK_CAP - written < 8, `${SCRIPT_TICK_CAP - written} bytes left`)
  s.own(s.a, { ef: { freeze: true }, sessionAvatar: 'asset://mine.vrm' })
  s.ask(s.a, 'effect')
  s.ask(s.a, 'avatar')
  s.f.network.flush()
  assert.equal(s.pending(), 0)
  // nobody was told the script's values, so the player's own are still to be told
  assert.deepEqual(s.told(s.settle().b, s.a), [{ id: 'a', ef: { freeze: true }, sessionAvatar: 'asset://mine.vrm' }])
  assert.equal(s.a.player.data.sessionAvatar, 'asset://mine.vrm', 'a session avatar that is refused is not set')
})

test('a change that ends an effect whose end starts another: told in the order the server made them', async () => {
  const s = await stage()
  s.actions.chain = () =>
    s.handle(s.a).applyEffect({
      freeze: true,
      // the script answers the end of its effect with another one
      onEnd: () => s.handle(s.a).applyEffect({ snare: 0.5 }),
    })
  s.ask(s.b, 'chain')
  s.tick()
  assert.deepEqual(s.told(s.settle().b, s.a), [{ id: 'a', ef: { freeze: true } }])
  // the player's client ends the effect (ef: null): applying that runs the script's onEnd, which tells everyone the
  // next effect, and then the server's player has none, as the client said
  s.own(s.a, { p: [3, 0, 0], ef: null })
  s.tick()
  assert.deepEqual(s.told(s.settle().b, s.a), [
    { id: 'a', ef: { snare: 0.5 } },
    { id: 'a', p: [3, 0, 0], ef: null },
  ])
  assert.equal(s.a.player.data.effect, null)
  s.assertInStep()
})

test('what is pending goes out when a handler throws, and when the flush itself ends by a throw; nothing stays', async () => {
  const s = await stage()
  s.actions.boom = () => {
    throw new Error('boom')
  }
  // a handler that throws is reported, and the tick goes on
  s.own(s.a, { p: [8, 8, 8] })
  s.ask(s.a, 'boom')
  s.tick()
  assert.equal(s.pending(), 0)
  assert.deepEqual(s.told(s.got(s.b), s.a), [{ id: 'a', p: [8, 8, 8] }])
  assert.ok(s.f.logs.some(line => /entityEvent from client a failed: boom/.test(line)))
  // here the report itself fails, and the flush ends by that
  s.own(s.a, { p: [7, 7, 7] })
  s.ask(s.a, 'boom')
  s.f.network.logOnce = () => {
    throw new Error('the log failed')
  }
  assert.throws(() => s.f.network.flush(), /the log failed/)
  assert.equal(s.pending(), 0)
  assert.deepEqual(s.told(s.got(s.b), s.a), [{ id: 'a', p: [7, 7, 7] }])
})

test('when a write throws, what was pending is gone all the same: nothing stays for a later tick', async () => {
  const s = await stage()
  s.own(s.a, { p: [1, 1, 1] })
  s.own(s.b, { p: [2, 2, 2] })
  const send = s.f.network.send
  s.f.network.send = () => {
    throw new Error('the write failed')
  }
  assert.throws(() => s.f.network.flush(), /the write failed/)
  assert.equal(s.pending(), 0)
  s.f.network.send = send
  // the next tick tells what it is given, and nothing of the one before
  s.own(s.a, { m: 2 })
  s.tick()
  assert.deepEqual(s.told(s.got(s.b), s.a), [{ id: 'a', m: 2 }])
  assert.deepEqual(s.told(s.got(s.a), s.b), [])
})

test('nothing is told about a player after its removal', async () => {
  // (the fixture's connection reports its close at once, inside the flush; the invariant is kept there too)
  const s = await stage()
  s.own(s.a, { p: [5, 5, 5] })
  s.own(s.b, { p: [6, 6, 6] })
  s.packet(s.admin, 'kick', 'a')
  s.tick()
  assert.equal(s.pending(), 0)
  assert.equal(s.world.entities.get('a'), undefined)
  const seen = s.got(s.b).filter(([, data]) => data === 'a' || data?.id === 'a')
  assert.deepEqual(seen, [['onEntityRemoved', 'a']])
  assert.deepEqual(
    s.got(s.admin).filter(([name]) => /^onEntity/.test(name)),
    [
      ['onEntityRemoved', 'a'],
      ['onEntityModified', { id: 'b', p: [6, 6, 6] }],
    ],
    "and the other player's change is told as ever"
  )
})

test('a server that is stopping tells nothing more, and keeps nothing', async () => {
  const s = await stage()
  s.actions.stop = () => s.f.network.stopForFatal()
  s.own(s.a, { p: [1, 1, 1] })
  s.ask(s.a, 'stop')
  s.own(s.a, { p: [2, 2, 2] })
  s.tick()
  assert.equal(s.f.network.stopping, true)
  assert.equal(s.pending(), 0)
  assert.deepEqual(s.got(s.b), [])
  assert.deepEqual(s.a.player.data.position, [1, 1, 1], 'what came before the stop was applied')
  s.own(s.a, { p: [3, 3, 3] })
  s.tick()
  assert.equal(s.pending(), 0)
  assert.deepEqual(s.got(s.b), [])
})

test('visitors and a script changing players for 300 ticks: after every tick each client has what the server has', async t => {
  for (const seed of [1, 20261112, 987654321]) {
    const s = await stage({ visitors: ['a', 'b', 'c'] })
    const rand = prng(seed)
    const pick = list => list[rand(0, list.length - 1)]
    let clock = 10_000
    t.mock.method(performance, 'now', () => clock)
    s.f.network.gate = createInboundGate({ now: () => clock, log: line => s.f.logs.push(line) })
    s.world.settings.customAvatars = true
    const players = [s.a, s.b, s.c]
    const effects = [null, { freeze: true }, { snare: 0.5, duration: 3 }, { turn: true, cancellable: true }]
    const avatars = ['asset://one.vrm', 'asset://two.vrm', EXTERNAL_VRM, null]
    const emotes = [null, 'asset://emote-float.glb', EXTERNAL_GLB]
    // what the script does when asked, to the player named. (Not cancelEffect: on the server it ends the effect
    // without telling anyone, which leaves the clients on the effect whether changes are merged or not)
    s.actions.effect = id => s.handle(s[id]).applyEffect({ ...pick(effects.slice(1)) })
    s.actions.chain = id =>
      s.handle(s[id]).applyEffect({ freeze: true, onEnd: () => s.handle(s[id]).applyEffect({ snare: 0.25 }) })
    s.actions.avatar = id => s.handle(s[id]).setSessionAvatar(pick(avatars))
    s.actions.damage = id => s.handle(s[id]).damage(rand(1, 30))
    s.actions.heal = id => s.handle(s[id]).heal(rand(1, 30))
    s.actions.boom = () => {
      throw new Error('boom')
    }
    const ownChange = one => {
      const fields = {}
      if (rand(0, 9) < 8) fields.p = [rand(-50, 50), rand(0, 5), rand(-50, 50)]
      if (rand(0, 9) < 4) fields.q = pick([[0, 0, 0, 1], [0, 1, 0, 0]]) // prettier-ignore
      if (rand(0, 9) < 2) fields.m = rand(0, 6)
      if (rand(0, 9) < 3) fields.a = [rand(-1, 1), 0, rand(-1, 1)]
      if (rand(0, 9) < 2) fields.g = [0, rand(-1, 1), 1]
      if (rand(0, 9) < 2) fields.e = pick(emotes)
      if (rand(0, 9) < 2) fields.ef = pick(effects)
      if (rand(0, 19) < 1) fields.t = true
      if (rand(0, 29) < 1) fields.name = `${one.id}-${rand(0, 99)}`
      if (rand(0, 19) < 1) fields.sessionAvatar = pick(avatars)
      if (rand(0, 39) < 1) fields.avatar = pick(avatars.slice(0, 2))
      s.own(one, fields)
    }
    const steps = [
      () => ownChange(pick(players)),
      () => ownChange(pick(players)),
      () => ownChange(pick(players)),
      () => s.ask(pick(players), pick(['effect', 'chain', 'avatar', 'damage', 'heal']), pick(players).id),
      () => s.ask(pick(players), 'boom'),
      () => s.packet(pick(players), 'command', { args: ['name', `named-${rand(0, 99)}`] }),
      () => s.packet(s.admin, 'modifyRank', { playerId: pick(players).id, rank: pick([Ranks.VISITOR, Ranks.BUILDER]) }),
      () => s.packet(pick(players), 'chatAdded', { body: 'hello' }),
    ]
    for (let tick = 0; tick < 300; tick++) {
      for (let n = rand(0, 12); n > 0; n--) pick(steps)()
      clock += TICK_MS
      s.tick()
      assert.equal(s.pending(), 0, `seed ${seed}, tick ${tick}`)
      s.settle()
      s.assertInStep(`seed ${seed}, tick ${tick}`)
      // (what the handlers left to the database settles between ticks, as it does between real ones)
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.ok(
      s.f.logs.some(line => /entityEvent from client \w+ failed: boom/.test(line)),
      'handlers threw on the way'
    )
    // and when the server stops
    for (const one of players) ownChange(one)
    s.f.network.stopForFatal()
    s.tick()
    assert.equal(s.pending(), 0)
  }
})

test('an own-player change with every field at its limit in three-byte text is under 3.8 KB; identity fields add under 2.5 KB', () => {
  // The limits count characters for urls and names and bytes for the effect, so the large values are in
  // three-byte characters. The changelog gives 3.8 KB and 2.5 KB as what one connection can have written to each
  // other connection in a tick: this builds a packet with every field near its limit and holds it under them. It
  // is not a proof of the largest one (other choices of url and effect measure some tens of bytes more or less).
  const store = 'https://world.example/assets'
  const options = { allowAvatar: true, assetsUrl: store }
  const fill = (prefix, length, suffix = '') => prefix + '界'.repeat(length - prefix.length - suffix.length) + suffix
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length
  // an effect of exactly the 2048 bytes it may have
  const ef = { anchorId: '界'.repeat(128), emote: fill(`${store}/a.glb#`, 512), freeze: true, snare: '' }
  ef.emote = ef.emote.slice(0, 400)
  while (bytes({ ...ef, snare: ef.snare + '界' }) <= EFFECT_MAX_BYTES) ef.snare += '界'
  while (bytes({ ...ef, snare: ef.snare + 'a' }) <= EFFECT_MAX_BYTES) ef.snare += 'a'
  assert.equal(bytes(ef), EFFECT_MAX_BYTES)
  const f = 1.2345678901234567
  const id = 'a'.repeat(21)
  const move = sanitizePlayerSelfModify(
    {
      id,
      p: [f, f, f],
      q: [0.5, 0.5, 0.5, 0.5],
      m: f,
      a: [f, f, f],
      g: [f, f, f],
      t: true,
      e: fill(`${store}/a.glb#`, 512),
      ef,
    },
    id,
    options
  )
  assert.deepEqual(Object.keys(move).sort(), ['a', 'e', 'ef', 'g', 'id', 'm', 'p', 'q', 't'])
  const moved = writePacket('entityModified', move).length
  assert.ok(moved > 3500 && moved < 3800, `${moved} bytes`)
  const identity = sanitizePlayerSelfModify(
    {
      id,
      name: '界'.repeat(64),
      avatar: fill(`${store}/`, STORED_AVATAR_MAX_LENGTH, '.vrm'),
      sessionAvatar: fill(`${store}/`, 512, '.vrm'),
    },
    id,
    options
  )
  assert.deepEqual(Object.keys(identity).sort(), ['avatar', 'id', 'name', 'sessionAvatar'])
  const both = writePacket('entityModified', { ...move, ...identity }).length
  assert.ok(both - moved > 2200 && both - moved < 2500, `${both - moved} bytes more`)
})
