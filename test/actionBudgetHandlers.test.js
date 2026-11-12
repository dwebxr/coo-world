import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ranks } from '../src/core/extras/ranks.js'
import { readPacket, writeClientPacket, writePacket } from '../src/core/packets.js'
import { BACKLOG_CAP, SCRIPT_BACKLOG_CAP } from '../src/core/extras/writeLedger.js'
import { fixture } from './lib/joinFixture.mjs'

// A world with an admin code (so a visitor is a visitor), an admin, and two visitors: `a` acts, `b` watches
async function stage() {
  const f = fixture()
  f.world.settings.setHasAdminCode(true)
  f.world.settings.rank = Ranks.VISITOR
  const lines = []
  f.world.chat.add = message => lines.push(message)
  const events = []
  f.world.events.emit = (name, data) => events.push([name, data])
  const enter = async (id, rank = Ranks.VISITOR) => {
    f.users.set(id, { id, name: id, avatar: null, rank })
    const joined = await f.join({ authToken: id })
    const socket = f.network.sockets.get(id)
    return { ...joined, socket, id }
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
  const chat = (who, body, at) => f.network.onChatAdded(who.socket, { body }, { at })
  const chats = packets => packets.filter(([name]) => name === 'onChatAdded').map(([, data]) => data)
  const TOO_FAST = 'You are sending messages too fast. Some were not sent.'
  // a handler called here runs outside ServerNetwork.flush, which ends by telling the others what the players' own
  // clients changed in the tick (flushPending): this ends the tick of such a call
  const tick = handled => (f.network.flushPending(), handled)
  return { f, lines, events, admin, a, b, got, chat, chats, tick, TOO_FAST }
}

test('chat: a thousand lines a second from one visitor reach the others as a burst and then a line a second', async () => {
  const s = await stage()
  for (let ms = 0; ms < 3000; ms++) s.chat(s.a, `line ${ms}`, 10_000 + ms)
  const seen = s.chats(s.got(s.b))
  assert.equal(seen.length, 6 + 2, 'the burst, and one for each second that passed')
  assert.deepEqual(
    seen.slice(0, 7).map(m => m.body),
    ['line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 1000']
  )
  assert.ok(seen.every(m => m.kind === 'player' && m.fromId === 'a'))
  assert.equal(s.lines.length, 8, 'and no more are kept in the chat')
  // the sender is told once per wait that lines were not sent, and nobody else is told
  const told = s.chats(s.got(s.a)).filter(m => m.body === s.TOO_FAST)
  assert.equal(told.length, 3, 'once for each run of refusals')
  assert.ok(told.every(m => m.kind === 'system'))
  assert.equal(s.chats(s.got(s.admin)).filter(m => m.body === s.TOO_FAST).length, 0)
  assert.ok(s.f.logs.some(line => /"a" is over its chat budget/.test(line)))
  assert.equal(s.f.logs.filter(line => /over its chat budget/.test(line)).length, 1, 'logged once per connection')
})

test('chat: what is not a line of chat is dropped without using the budget', async () => {
  const s = await stage()
  for (let i = 0; i < 100; i++) {
    s.f.network.onChatAdded(s.a.socket, { body: { not: 'text' } }, { at: 1000 })
    s.f.network.onChatAdded(s.a.socket, { body: '   ' }, { at: 1000 })
    s.f.network.onChatAdded(s.a.socket, 'just a string', { at: 1000 })
    s.f.network.onAppChat(s.a.socket, { id: 'no-such-app', body: 'x' }, { at: 1000 })
  }
  assert.deepEqual(s.chats(s.got(s.b)), [])
  assert.deepEqual(s.chats(s.got(s.a)), [], 'nothing to tell: nothing was a line')
  // the whole burst is still there
  for (let i = 0; i < 6; i++) s.chat(s.a, `line ${i}`, 1000)
  assert.equal(s.chats(s.got(s.b)).length, 6)
})

test('chat: a person typing is never refused; another connection is not held by a flooder', async () => {
  const s = await stage()
  for (let i = 0; i < 2000; i++) s.chat(s.a, 'flood', 5000)
  s.got(s.admin)
  // b types a line every two seconds for a minute, with three quick ones now and then
  let sent = 0
  for (let second = 0; second < 60; second += 2) {
    s.chat(s.b, `b ${second}`, 5000 + second * 1000)
    sent++
    if (second % 20 === 0) {
      for (let i = 1; i <= 3; i++) s.chat(s.b, `quick ${second}.${i}`, 5000 + second * 1000 + i * 200), sent++
    }
  }
  const fromB = s.chats(s.got(s.admin)).filter(m => m.fromId === 'b')
  assert.equal(fromB.length, sent)
  assert.equal(s.chats(s.got(s.b)).filter(m => m.body === s.TOO_FAST).length, 0)
})

test('chat: the arrival time of the packet is what is counted, through the real admission', async t => {
  const s = await stage()
  const seen = []
  assert.equal(s.f.network.actionBudgets, undefined, 'made on first use')
  s.f.network.actionBudgets = { spend: (socket, action, at) => (seen.push([socket.id, action, at]), { ok: true }) }
  // the clock reads 111 when the packet is admitted and something else when its turn comes (a packet waits in the
  // inbox): the budget must be asked with the first
  let clock = 111
  t.mock.method(performance, 'now', () => clock)
  s.a.socket.ws.emit('message', writeClientPacket('chatAdded', { body: 'hello' }))
  clock = 99999
  s.f.network.flush()
  t.mock.restoreAll()
  assert.deepEqual(seen, [['a', 'chat', 111]])
  assert.equal(s.chats(s.got(s.b)).length, 1)
})

test('app chat: a script speaking through a connection has its own budget and its player is told nothing', async () => {
  const s = await stage()
  s.f.world.entities.add({ id: 'shop', type: 'app', blueprint: 'bp', position: [0, 0, 0], quaternion: [0, 0, 0, 1] })
  for (let i = 0; i < 500; i++) s.f.network.onAppChat(s.a.socket, { id: 'shop', body: `sale ${i}` }, { at: 1000 })
  assert.equal(s.chats(s.got(s.b)).length, 10, 'the burst')
  assert.deepEqual(s.chats(s.got(s.a)), [], 'nothing said to the player who typed nothing')
  // and it did not use the player's own chat budget
  for (let i = 0; i < 6; i++) s.chat(s.a, `typed ${i}`, 1000)
  assert.equal(s.chats(s.got(s.b)).length, 6)
})

test('chat: a recipient whose backlog is high misses the line instead of being closed for it', async () => {
  const s = await stage()
  // b reads nothing: its backlog is filled to over the mark with packets it must have
  const big = writePacket('chatAdded', { id: 'x', kind: 'system', from: null, fromId: null, body: 'x'.repeat(60000) })
  while (s.b.ws.packets.reduce((sum, packet) => sum + packet.length + 1024, 0) <= SCRIPT_BACKLOG_CAP) {
    assert.equal(s.f.network.write(s.b.ws, big), true)
  }
  const queued = s.b.ws.packets.length
  s.chat(s.a, 'hello', 1000)
  assert.equal(s.b.ws.packets.length, queued, 'not written to the connection that lags')
  assert.equal(s.b.ws.readyState, 1, 'and that connection stays')
  assert.equal(s.chats(s.got(s.admin)).length, 1, 'everyone else has it')
  assert.ok(s.f.logs.some(line => /chatAdded refused: backlog high, skipped/.test(line)))
  // an ordinary packet is still written to it, up to the cap, where it is closed as before
  while (s.b.ws.readyState === 1) s.f.network.write(s.b.ws, big)
  assert.ok(s.b.ws.packets.reduce((sum, packet) => sum + packet.length + 1024, 0) <= BACKLOG_CAP)
})

test('/name: the name the player has is answered and changes nothing; a flood of names is five and then one every two seconds', async () => {
  const s = await stage()
  const name = (value, at) => s.f.network.onCommand(s.a.socket, { args: ['name', value] }, { at })
  const NAME_FAST = 'You are changing your name too fast.'
  // the name it has already: answered, not told to anyone, not written
  await name('a', 1000)
  assert.deepEqual(
    s.chats(s.got(s.a)).map(m => m.body),
    ['Name set to a!']
  )
  assert.deepEqual(s.got(s.b), [])
  assert.equal(s.f.store.userUpdates, undefined)
  // forty names at once (the command budget lets ten commands through; of those, five names)
  const pending = []
  for (let i = 0; i < 40; i++) pending.push(name(`n${i}`, 2000))
  await Promise.all(pending)
  const renames = s.got(s.b).filter(([n, d]) => n === 'onEntityModified' && d.name !== undefined)
  assert.deepEqual(
    renames.map(([, d]) => d.name),
    ['n0', 'n1', 'n2', 'n3', 'n4']
  )
  assert.equal(s.a.socket.player.data.name, 'n4')
  const said = s.chats(s.got(s.a)).map(m => m.body)
  assert.equal(said.filter(body => body === NAME_FAST).length, 1, 'told once')
  assert.equal(said.filter(body => body === 'You are sending commands too fast.').length, 1)
  // Written one statement at a time (userRows.js): the first name at once, and the names taken while that
  // statement was under way as one more, with the last of them. Never a name that was not taken
  await s.f.network.userRows().idle()
  assert.deepEqual(
    s.f.store.userUpdates.map(update => update.changes.name),
    ['n0', 'n4']
  )
  assert.equal(s.f.users.get('a').name, 'n4')
  // two seconds later one more goes through
  await name('later', 4000)
  await s.f.network.userRows().idle()
  assert.equal(s.a.socket.player.data.name, 'later')
  assert.equal(s.f.users.get('a').name, 'later')
})

test('own player: a name or avatar that is not new is not told or written again', async () => {
  const s = await stage()
  s.f.world.settings.customAvatars = true
  const modify = (data, at) => s.tick(s.f.network.onEntityModified(s.a.socket, { id: 'a', ...data }, { at }))
  // (a user without an avatar of their own wears the world's)
  const worn = s.a.socket.player.data.avatar
  assert.equal(worn, 'asset://avatar.vrm')
  await modify({ name: 'a' }, 1000)
  await modify({ avatar: worn }, 1000)
  assert.deepEqual(s.got(s.b), [], 'nothing to tell')
  assert.equal(s.f.store.userUpdates, undefined, 'nothing to write')
  // with movement in the same packet, the movement goes on alone
  await modify({ name: 'a', p: [1, 2, 3] }, 1000)
  assert.deepEqual(s.got(s.b), [['onEntityModified', { id: 'a', p: [1, 2, 3] }]])
  // a real change is told and written, once
  await modify({ name: 'new name' }, 1000)
  assert.deepEqual(s.got(s.b), [['onEntityModified', { id: 'a', name: 'new name' }]])
  assert.deepEqual(
    s.f.store.userUpdates.map(update => update.changes),
    [{ name: 'new name' }]
  )
  // and unchanged values did not use the budget: five more changes still go through
  for (let i = 0; i < 4; i++) await modify({ name: `n${i}` }, 1000)
  assert.equal(s.got(s.b).length, 4)
})

test("own player: over the budget, name and avatar are taken out, the sender gets the server's back, movement goes on", async () => {
  const s = await stage()
  s.f.world.settings.customAvatars = true
  const modify = (data, at) => s.tick(s.f.network.onEntityModified(s.a.socket, { id: 'a', ...data }, { at }))
  for (let i = 0; i < 5; i++) await modify({ name: `n${i}` }, 1000)
  s.got(s.a)
  s.got(s.b)
  const writes = s.f.store.userUpdates.length
  // the sixth: the sender had applied "sixth" and an avatar before sending
  await modify({ name: 'sixth', avatar: 'asset://mine.vrm', p: [4, 5, 6] }, 1000)
  assert.deepEqual(s.got(s.b), [['onEntityModified', { id: 'a', p: [4, 5, 6] }]], 'the others get the movement only')
  assert.deepEqual(
    s.got(s.a),
    [['onEntityModified', { id: 'a', name: 'n4', avatar: 'asset://avatar.vrm' }]],
    'the sender gets back the name and the avatar the server keeps'
  )
  assert.equal(s.a.socket.player.data.name, 'n4')
  assert.equal(s.f.store.userUpdates.length, writes, 'nothing written')
  // a packet of identity alone leaves nothing to tell the others
  await modify({ name: 'seventh' }, 1000)
  assert.deepEqual(s.got(s.b), [])
  assert.deepEqual(s.got(s.a), [['onEntityModified', { id: 'a', name: 'n4' }]])
  // movement alone is not counted at all
  for (let i = 0; i < 200; i++) await modify({ p: [i, 0, 0] }, 1000)
  assert.equal(s.got(s.b).length, 200)
  // a session avatar over the budget: the sender is answered with the one the server has (none), with its number
  await modify({ sessionAvatar: 'asset://avatar.vrm', sessionAvatarRequest: 7 }, 1000)
  assert.deepEqual(s.got(s.b), [])
  assert.deepEqual(s.got(s.a), [['onEntityModified', { id: 'a', sessionAvatar: null, sessionAvatarRequest: 7 }]])
  // two seconds later one identity change goes through again
  await modify({ name: 'later' }, 3000)
  assert.deepEqual(s.got(s.b), [['onEntityModified', { id: 'a', name: 'later' }]])
})

test('own player: a truncated name is corrected whatever became of the avatar in the same packet', async () => {
  const s = await stage()
  s.f.world.settings.customAvatars = true
  const modify = (data, at) => s.tick(s.f.network.onEntityModified(s.a.socket, { id: 'a', ...data }, { at }))
  const long = 'N'.repeat(64)
  // the name the server keeps is 64 characters long; the rest of the budget goes on avatars
  await modify({ name: long }, 1000)
  for (let i = 1; i <= 4; i++) await modify({ avatar: `asset://a${i}.vrm` }, 1000)
  s.got(s.a)
  s.got(s.b)
  // the sender shows a longer name whose first 64 characters are the name kept (so it is no change), and asks
  // for an avatar over the budget: it is given back the avatar the server keeps, and its name is corrected
  await modify({ name: `${long}tail`, avatar: 'asset://a5.vrm' }, 1000)
  assert.deepEqual(s.got(s.a), [
    ['onEntityModified', { id: 'a', avatar: 'asset://a4.vrm' }],
    ['onEntityModified', { id: 'a', name: long }],
  ])
  assert.deepEqual(s.got(s.b), [])
  // a truncated name that is itself over the budget is given back once, as the name kept, and not corrected to
  // the truncated name the server did not take
  await modify({ name: 'Z'.repeat(70) }, 1000)
  assert.deepEqual(s.got(s.a), [['onEntityModified', { id: 'a', name: long }]])
})

test('commands: ten at once, then two a second; the admin code is not counted here, a granted toggle is counted with the moderation', async () => {
  const s = await stage()
  for (let i = 0; i < 100; i++) await s.f.network.onCommand(s.a.socket, { args: ['dance', String(i)] }, { at: 1000 })
  assert.equal(s.events.filter(([name]) => name === 'command').length, 10)
  assert.equal(s.chats(s.got(s.a)).filter(m => m.body === 'You are sending commands too fast.').length, 1)
  await s.f.network.onCommand(s.a.socket, { args: ['dance', 'later'] }, { at: 1500 })
  assert.equal(s.events.filter(([name]) => name === 'command').length, 11)
  // every admin attempt reaches the admin gate, however many came before (its brake is its own)
  const attempts = []
  s.f.network.adminState = {
    mode: 'code',
    gate: { attempt: (who, candidate) => (attempts.push(candidate), { ok: false, reason: 'wrong', tell: false }) },
  }
  for (let i = 0; i < 50; i++) await s.f.network.onCommand(s.a.socket, { args: ['admin', `guess-${i}`] }, { at: 1500 })
  assert.equal(attempts.length, 50)
  // with the right code the brake is cleared, so each toggle is counted as a change of rank: ten at once
  s.f.network.adminState.gate.attempt = () => ({ ok: true })
  for (let i = 0; i < 100; i++)
    await s.f.network.onCommand(s.admin.socket, { args: ['admin', 'the-code'] }, { at: 2000 })
  const toggles = s.got(s.b).filter(([n, d]) => n === 'onEntityModified' && d.id === 'admin' && d.rank !== undefined)
  assert.equal(toggles.length, 10)
  assert.equal(s.chats(s.got(s.admin)).filter(m => m.body === 'You are changing ranks too fast.').length, 1)
})

// A clock for the tick (preFixedUpdate applies the settings held over the budget at performance.now())
function clockFor(t) {
  const clock = { now: 10_000 }
  t.mock.method(performance, 'now', () => clock.now)
  return clock
}
const settingsTo = (s, who) =>
  s
    .got(who)
    .filter(([name]) => name === 'onSettingsModified')
    .map(([, data]) => data)

test('settings: an arrow key held on a number field for five seconds ends on the last value; the others see a few changes a second, the sender none', async t => {
  const s = await stage()
  const clock = clockFor(t)
  const set = value => s.f.network.onSettingsModified(s.admin.socket, { key: 'playerLimit', value }, { at: clock.now })
  // FieldNumber sends a change per key repeat, each one more than the value shown: thirty a second, and a tick
  // every sixteen milliseconds
  const repeats = new Set(Array.from({ length: 150 }, (_, i) => Math.round((i * 1000) / 30)))
  let value = 0
  for (let ms = 0; ms <= 7000; ms++) {
    clock.now = 10_000 + ms
    if (repeats.has(ms)) set(++value)
    if (ms % 16 === 0) s.f.network.preFixedUpdate()
  }
  assert.equal(value, 150)
  assert.equal(s.f.world.settings.playerLimit, 150, 'the value the builder ended on is the one the world keeps')
  const told = settingsTo(s, s.b).map(data => data.value)
  assert.equal(told.at(-1), 150, 'and the last one the others are told')
  assert.ok(
    told.every((v, i) => i === 0 || v > told[i - 1]),
    'in the order they were typed'
  )
  // the burst as it came, then five a second, and the last value
  assert.ok(told.length <= 30 + 5 * 5 + 1, `${told.length} changes told to the others`)
  assert.deepEqual(settingsTo(s, s.admin), [], 'the sender is never answered: its field does not jump back')
  assert.equal(s.f.network.heldSettings.size, 0, 'nothing is held once the last value is applied')
})

test('settings: a flood of a thousand a second for a minute reaches the others at most five times a second, ends on its last value, and leaves moderation alone', async t => {
  const s = await stage()
  const clock = clockFor(t)
  const muted = []
  s.f.world.livekit.muted = new Set()
  s.f.world.livekit.setMuted = (id, value) => muted.push([id, value])
  for (let ms = 0; ms < 60_000; ms++) {
    clock.now = 10_000 + ms
    s.f.network.onSettingsModified(s.admin.socket, { key: 'title', value: `t${ms}` }, { at: clock.now })
    assert.ok(s.f.network.heldSettings.size <= 1 && (s.f.network.heldSettings.get(s.admin.socket)?.size ?? 0) <= 1)
    if (ms % 16 === 0) s.f.network.preFixedUpdate()
  }
  clock.now += 1000
  s.f.network.preFixedUpdate()
  const told = settingsTo(s, s.b)
  assert.ok(told.length <= 30 + 5 * 61, `${told.length} changes told to the others in a minute`)
  assert.equal(s.f.world.settings.title, 't59999')
  assert.equal(told.at(-1).value, 't59999')
  assert.deepEqual(settingsTo(s, s.admin), [])
  assert.ok(s.f.logs.some(line => /is over its settings budget: the latest value of each setting is held/.test(line)))
  // moderation has a bucket of its own: a mute and a kick right after go through at once
  s.f.network.onMute(s.admin.socket, { playerId: 'b', muted: true }, { at: clock.now })
  assert.deepEqual(muted, [['b', true]])
  s.f.network.onKick(s.admin.socket, 'b', { at: clock.now })
  assert.equal(s.f.network.sockets.has('b'), false)
})

test('settings: a value held is checked again when it is applied, and a connection that is gone keeps nothing', async t => {
  const s = await stage()
  const clock = clockFor(t)
  const set = (who, key, value) => s.f.network.onSettingsModified(who.socket, { key, value }, { at: clock.now })
  // the admin's burst is used up, and a value is held
  for (let i = 1; i <= 30; i++) set(s.admin, 'playerLimit', i)
  set(s.admin, 'playerLimit', 99)
  set(s.admin, 'customAvatars', true)
  assert.equal(s.f.world.settings.playerLimit, 30)
  // the admin is made a visitor meanwhile: what it held is not applied, and is let go
  s.admin.socket.player.data.rank = Ranks.VISITOR
  clock.now += 10_000
  s.f.network.preFixedUpdate()
  assert.equal(s.f.world.settings.playerLimit, 30)
  assert.notEqual(s.f.world.settings.customAvatars, true)
  assert.equal(s.f.network.heldSettings.size, 0)
  // an admin-only setting held by an admin who is a builder by the time it is applied
  s.admin.socket.player.data.rank = Ranks.ADMIN
  for (let i = 1; i <= 30; i++) set(s.admin, 'playerLimit', 100 + i)
  set(s.admin, 'customAvatars', true)
  set(s.admin, 'playerLimit', 200)
  s.admin.socket.player.data.rank = Ranks.BUILDER
  // a fifth of a second: one token, which the setting refused now does not use
  clock.now += 200
  s.f.network.preFixedUpdate()
  assert.notEqual(s.f.world.settings.customAvatars, true, 'checked again: an admin setting needs an admin')
  assert.equal(s.f.world.settings.playerLimit, 200, 'a builder setting still goes')
  // a value the rules refuse never takes the place of one held; a value the rules shorten is told to its sender
  // when it is applied
  for (let i = 1; i <= 30; i++) set(s.admin, 'playerLimit', 400 + i)
  set(s.admin, 'playerLimit', 77)
  set(s.admin, 'playerLimit', 'many')
  set(s.admin, 'title', 'T'.repeat(300))
  s.got(s.admin)
  clock.now += 10_000
  s.f.network.preFixedUpdate()
  assert.equal(s.f.world.settings.playerLimit, 77)
  assert.equal(s.f.world.settings.title, 'T'.repeat(256))
  assert.deepEqual(settingsTo(s, s.admin), [{ key: 'title', value: 'T'.repeat(256) }])
  // a connection that is gone keeps nothing
  s.admin.socket.player.data.rank = Ranks.ADMIN
  for (let i = 1; i <= 40; i++) set(s.admin, 'playerLimit', 300 + i)
  assert.equal(s.f.network.heldSettings.get(s.admin.socket).size, 1)
  const applied = s.f.world.settings.playerLimit
  assert.ok(applied > 300 && applied < 340)
  s.admin.socket.disconnect()
  clock.now += 10_000
  s.f.network.preFixedUpdate()
  assert.equal(s.f.world.settings.playerLimit, applied)
  assert.equal(s.f.network.heldSettings.size, 0)
})

// What each builder's settings pane shows for one setting: its own value when it sends one (the client sets it
// before sending), then each value the server tells it, in the order it is told
function panes(s, builders, key) {
  const shown = new Map()
  const read = () => {
    for (const who of builders) {
      for (const [name, data] of s.got(who))
        if (name === 'onSettingsModified' && data.key === key) shown.set(who, data.value)
    }
  }
  return {
    set(who, value, at) {
      read()
      shown.set(who, value)
      s.f.network.onSettingsModified(who.socket, { key, value }, { at })
      read()
    },
    // what each pane that is still connected shows, and what the world keeps
    shown() {
      read()
      return builders.filter(who => !who.socket.closed).map(who => shown.get(who))
    },
    agree() {
      return this.shown().every(value => value === s.f.world.settings[key])
    },
  }
}

// three builders whose settings budgets are used up, each pane showing the same title
async function builders(t) {
  const s = await stage()
  const clock = clockFor(t)
  s.a.socket.player.data.rank = Ranks.BUILDER
  s.b.socket.player.data.rank = Ranks.BUILDER
  const p = panes(s, [s.admin, s.a, s.b], 'title')
  for (let i = 0; i < 30; i++) for (const who of [s.admin, s.a, s.b]) p.set(who, `burst ${i}`, clock.now)
  assert.equal(s.f.network.heldSettings?.size ?? 0, 0)
  assert.ok(p.agree())
  return { s, clock, p }
}

test('settings: of two builders holding a value of one setting, the later is applied and both panes show it, whichever is released first', async t => {
  for (const order of ['earlier first', 'later first', 'the tick']) {
    const { s, clock, p } = await builders(t)
    p.set(s.a, 'A', clock.now)
    p.set(s.b, 'B', clock.now)
    assert.equal(s.f.network.heldSettings.size, 2, 'both held')
    clock.now += 200
    if (order === 'the tick') s.f.network.preFixedUpdate()
    else {
      const sockets = order === 'earlier first' ? [s.a, s.b] : [s.b, s.a]
      for (const who of sockets) s.f.network.releaseSettings(who.socket, clock.now)
    }
    assert.equal(s.f.world.settings.title, 'B', order)
    assert.deepEqual(p.shown(), ['B', 'B', 'B'], order)
    assert.equal(s.f.network.heldSettings.size, 0, order)
    clock.now += 10_000
    s.f.network.preFixedUpdate()
    assert.ok(p.agree(), order)
  }
})

test('settings: of three builders holding a value of one setting, the last is applied and every pane shows it', async t => {
  const { s, clock, p } = await builders(t)
  p.set(s.a, 'A', clock.now)
  p.set(s.b, 'B', clock.now)
  p.set(s.admin, 'C', clock.now)
  for (let tick = 0; tick < 3; tick++) {
    clock.now += 200
    s.f.network.preFixedUpdate()
    // never a value other than the one each pane sent, or the one the world ends on
    assert.ok(p.shown().every((value, i) => value === 'C' || value === ['C', 'A', 'B'][i]))
  }
  assert.equal(s.f.world.settings.title, 'C')
  assert.deepEqual(p.shown(), ['C', 'C', 'C'])
})

test('settings: a held value waits for a later one of another builder, and is applied after all when that one goes', async t => {
  for (const going of ['closes', 'loses the rank']) {
    const { s, clock, p } = await builders(t)
    p.set(s.a, 'A', clock.now)
    p.set(s.b, 'B', clock.now)
    if (going === 'closes') s.b.socket.disconnect()
    else s.b.socket.player.data.rank = Ranks.VISITOR
    for (let tick = 0; tick < 3; tick++) {
      clock.now += 200
      s.f.network.preFixedUpdate()
    }
    assert.equal(s.f.world.settings.title, 'A', going)
    assert.ok(p.agree(), `${going}: ${p.shown()}`)
    assert.equal(s.f.network.heldSettings.size, 0)
  }
})

test('settings: values held by builders who lost the rank are not applied, and each of them is told the value the world keeps', async t => {
  const { s, clock, p } = await builders(t)
  const kept = s.f.world.settings.title
  p.set(s.a, 'A', clock.now)
  p.set(s.b, 'B', clock.now)
  s.a.socket.player.data.rank = Ranks.VISITOR
  s.b.socket.player.data.rank = Ranks.VISITOR
  clock.now += 200
  s.f.network.preFixedUpdate()
  assert.equal(s.f.world.settings.title, kept, 'nothing applied')
  assert.equal(s.f.network.heldSettings.size, 0)
  // told alone: the admin, who sent nothing, is told nothing
  assert.deepEqual(settingsTo(s, s.admin), [])
  assert.deepEqual(p.shown(), [kept, kept, kept])
  // the rank given back: nothing more is told, and every pane still shows the world's value
  s.a.socket.player.data.rank = Ranks.BUILDER
  s.b.socket.player.data.rank = Ranks.BUILDER
  for (let tick = 0; tick < 3; tick++) {
    clock.now += 200
    s.f.network.preFixedUpdate()
  }
  assert.equal(s.f.world.settings.title, kept)
  assert.ok(p.agree(), `${p.shown()}`)
})

test('settings: a value applied at once from a third builder lets go of the values held before it', async t => {
  const { s, clock, p } = await builders(t)
  p.set(s.a, 'A', clock.now)
  p.set(s.b, 'B', clock.now)
  // the admin has a token again before the others' turn: its value is applied as it comes
  clock.now += 200
  p.set(s.admin, 'C', clock.now)
  assert.equal(s.f.world.settings.title, 'C')
  assert.deepEqual(p.shown(), ['C', 'C', 'C'])
  for (let tick = 0; tick < 3; tick++) {
    clock.now += 200
    s.f.network.preFixedUpdate()
  }
  assert.equal(s.f.world.settings.title, 'C')
  assert.ok(p.agree())
})

test("settings: the tick releases the connections by their values' arrival", async t => {
  const { s, clock } = await builders(t)
  const order = []
  const release = s.f.network.releaseSettings
  s.f.network.releaseSettings = function (socket, at) {
    order.push(socket.id)
    return release.call(this, socket, at)
  }
  // `b` holds first (a description), then the admin and `a` (titles)
  s.f.network.onSettingsModified(s.b.socket, { key: 'desc', value: 'first' }, { at: clock.now })
  s.f.network.onSettingsModified(s.admin.socket, { key: 'title', value: 'second' }, { at: clock.now })
  s.f.network.onSettingsModified(s.a.socket, { key: 'title', value: 'third' }, { at: clock.now })
  // the admin's held map is made again, after the others: its oldest value is what counts
  s.f.network.heldSettings.delete(s.admin.socket)
  s.f.network.heldSettings.set(s.admin.socket, new Map([['title', { value: 'second', changed: false, seq: 0 }]]))
  order.length = 0
  clock.now += 10
  s.f.network.preFixedUpdate()
  assert.deepEqual(order, ['admin', 'b', 'a'])
})

test('moderation: kicks, mutes and ranks have a bucket of their own, ten at once and then two a second', async () => {
  const s = await stage()
  const muted = []
  s.f.world.livekit.muted = new Set()
  s.f.world.livekit.setMuted = (id, value) => muted.push([id, value])
  for (let i = 0; i < 10; i++) s.f.network.onMute(s.admin.socket, { playerId: 'b', muted: i % 2 === 0 }, { at: 1000 })
  assert.equal(muted.length, 10)
  await s.f.network.onModifyRank(s.admin.socket, { playerId: 'b', rank: Ranks.BUILDER }, { at: 1000 })
  s.f.network.onKick(s.admin.socket, 'b', { at: 1000 })
  for (let i = 0; i < 10; i++) s.f.network.onMute(s.admin.socket, { playerId: 'b', muted: true }, { at: 1000 })
  assert.equal(muted.length, 10)
  assert.equal(s.b.socket.player.data.rank, Ranks.VISITOR)
  assert.equal(s.f.network.sockets.has('b'), true)
  assert.equal(s.chats(s.got(s.admin)).filter(m => m.body === 'You are changing ranks too fast.').length, 1)
  await s.f.network.onModifyRank(s.admin.socket, { playerId: 'b', rank: Ranks.BUILDER }, { at: 1500 })
  assert.equal(s.b.socket.player.data.rank, Ranks.BUILDER)
  // and the settings edited meanwhile are not held by it
  for (let i = 1; i <= 30; i++) {
    s.f.network.onSettingsModified(s.admin.socket, { key: 'playerLimit', value: i }, { at: 1500 })
  }
  assert.equal(s.f.world.settings.playerLimit, 30)
})

test('a request that is refused uses no budget: thirty refused, then a valid one is carried out at once', async () => {
  const s = await stage()
  s.f.network.saveConfig = async () => true
  const muted = []
  s.f.world.livekit.muted = new Set()
  s.f.world.livekit.setMuted = (id, value) => muted.push([id, value])
  // settings: an admin's setting from a builder, and a value the rules refuse
  s.a.socket.player.data.rank = Ranks.BUILDER
  for (let i = 0; i < 30; i++) {
    s.f.network.onSettingsModified(s.a.socket, { key: 'customAvatars', value: true }, { at: 1000 })
  }
  s.f.network.onSettingsModified(s.a.socket, { key: 'playerLimit', value: 7 }, { at: 1000 })
  assert.equal(s.f.world.settings.playerLimit, 7)
  for (let i = 0; i < 30; i++) {
    s.f.network.onSettingsModified(s.admin.socket, { key: 'playerLimit', value: 'many' }, { at: 1000 })
  }
  s.f.network.onSettingsModified(s.admin.socket, { key: 'playerLimit', value: 8 }, { at: 1000 })
  assert.equal(s.f.world.settings.playerLimit, 8)
  // a rank for a player who is not here
  for (let i = 0; i < 30; i++) {
    await s.f.network.onModifyRank(s.admin.socket, { playerId: 'nobody', rank: Ranks.BUILDER }, { at: 1000 })
  }
  await s.f.network.onModifyRank(s.admin.socket, { playerId: 'b', rank: Ranks.BUILDER }, { at: 1000 })
  assert.equal(s.b.socket.player.data.rank, Ranks.BUILDER)
  // a spawn where the player's transform is not one (the player's record is made again here: the one the join made
  // belongs to the handlers' own realm, which the transform check does not take for a plain object)
  const record = s.a.socket.player.data
  s.a.socket.player.data = { ...record, position: [NaN, 0, 0], quaternion: [0, 0, 0, 1] }
  for (let i = 0; i < 30; i++) await s.f.network.onSpawnModified(s.a.socket, 'set', { at: 1000 })
  s.a.socket.player.data = { ...record, position: [1, 2, 3], quaternion: [0, 0, 0, 1] }
  await s.f.network.onSpawnModified(s.a.socket, 'set', { at: 1000 })
  assert.deepEqual(s.f.network.spawn.position, [1, 2, 3])
  s.a.socket.player.data = record
  // a kick of a player whose connection is not here, and mutes that are not mutes
  s.f.world.entities.add({ id: 'ghost', type: 'player', owner: 'ghost', userId: 'ghost', name: 'ghost', rank: 0 })
  for (let i = 0; i < 30; i++) {
    s.f.network.onKick(s.admin.socket, 'ghost', { at: 1000 })
    s.f.network.onMute(s.admin.socket, { playerId: 'b', muted: 'yes' }, { at: 1000 })
    s.f.network.onKick(s.admin.socket, 'nobody-here', { at: 1000 })
  }
  s.b.socket.player.data.rank = Ranks.VISITOR
  s.f.network.onKick(s.admin.socket, 'b', { at: 1000 })
  assert.equal(s.f.network.sockets.has('b'), false)
})

test('spawn: set through the command, counted with the settings; an unknown operation is nothing', async () => {
  const s = await stage()
  const saved = []
  s.f.network.saveConfig = async (key, value) => saved.push([key, value])
  await s.f.network.onSpawnModified(s.admin.socket, 'explode', { at: 1000 })
  assert.deepEqual(saved, [])
  for (let i = 0; i < 40; i++) await s.f.network.onSpawnModified(s.admin.socket, 'clear', { at: 1000 })
  assert.equal(saved.length, 30)
  assert.equal(s.chats(s.got(s.admin)).filter(m => m.body === 'You are changing the spawn too fast.').length, 1)
})

test('a refusal that says nothing leaves the telling to the next one that does', async () => {
  // a setting held over the budget is not answered; the spawn refused after it is
  const s = await stage()
  const saved = []
  s.f.network.saveConfig = async (key, value) => saved.push([key, value])
  for (let i = 1; i <= 31; i++) {
    s.f.network.onSettingsModified(s.admin.socket, { key: 'playerLimit', value: i }, { at: 1000 })
  }
  assert.equal(s.f.world.settings.playerLimit, 30, 'the thirty-first is held')
  await s.f.network.onSpawnModified(s.admin.socket, 'clear', { at: 1000 })
  await s.f.network.onSpawnModified(s.admin.socket, 'clear', { at: 1000 })
  assert.deepEqual(saved, [])
  assert.equal(s.chats(s.got(s.admin)).filter(m => m.body === 'You are changing the spawn too fast.').length, 1)

  // a mute refused over the budget is not answered; the change of rank refused after it is
  const m = await stage()
  m.f.world.livekit.muted = new Set()
  m.f.world.livekit.setMuted = () => {}
  for (let i = 0; i < 11; i++) m.f.network.onMute(m.admin.socket, { playerId: 'b', muted: i % 2 === 0 }, { at: 1000 })
  await m.f.network.onModifyRank(m.admin.socket, { playerId: 'b', rank: Ranks.BUILDER }, { at: 1000 })
  await m.f.network.onModifyRank(m.admin.socket, { playerId: 'b', rank: Ranks.BUILDER }, { at: 1000 })
  assert.equal(m.b.socket.player.data.rank, Ranks.VISITOR)
  assert.equal(m.chats(m.got(m.admin)).filter(x => x.body === 'You are changing ranks too fast.').length, 1)
})

test('rank: where no admin code is set, an admin cannot lower their own rank; with a code, or for anyone else, they can', async () => {
  const told = s => s.chats(s.got(s.admin)).filter(m => /no admin code/.test(m.body)).length
  // locked: no code is set, so nobody becomes admin by typing one
  const locked = await stage()
  locked.f.network.admin().mode = 'locked'
  for (const rank of [Ranks.BUILDER, Ranks.VISITOR]) {
    await locked.f.network.onModifyRank(locked.admin.socket, { playerId: 'admin', rank }, { at: 1000 })
    assert.equal(locked.admin.socket.player.data.rank, Ranks.ADMIN)
  }
  assert.equal(told(locked), 2)
  assert.equal(locked.f.store.userUpdates, undefined, 'nothing is written')
  // nothing was said to the others, and the budget was not used: ten more rank changes go through
  assert.deepEqual(locked.got(locked.a), [])
  for (let i = 0; i < 10; i++) {
    await locked.f.network.onModifyRank(locked.admin.socket, { playerId: 'b', rank: i % 2 ? 0 : 1 }, { at: 1000 })
  }
  assert.equal(locked.b.socket.player.data.rank, Ranks.VISITOR)
  assert.equal(locked.f.store.userUpdates.length, 10)
  // their own rank kept as it is (admin to admin) is not a lowering
  const same = await stage()
  same.f.network.admin().mode = 'locked'
  await same.f.network.onModifyRank(same.admin.socket, { playerId: 'admin', rank: Ranks.ADMIN }, { at: 1000 })
  assert.equal(told(same), 0)
  // another admin can still be lowered (this is a guard against a slip, not a rule that an admin remains)
  const two = await stage()
  two.f.network.admin().mode = 'locked'
  two.a.socket.player.data.rank = Ranks.ADMIN
  await two.f.network.onModifyRank(two.admin.socket, { playerId: 'a', rank: Ranks.VISITOR }, { at: 1000 })
  assert.equal(two.a.socket.player.data.rank, Ranks.VISITOR)
  // with a code the way back exists: lowering oneself is allowed
  const coded = await stage()
  coded.f.network.admin().mode = 'code'
  await coded.f.network.onModifyRank(coded.admin.socket, { playerId: 'admin', rank: Ranks.BUILDER }, { at: 1000 })
  assert.equal(coded.admin.socket.player.data.rank, Ranks.BUILDER)
  assert.equal(told(coded), 0)
})
