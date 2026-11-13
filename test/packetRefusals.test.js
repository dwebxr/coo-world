// Who may send what, asked of ServerNetwork's handlers themselves (test/lib/joinFixture.mjs: the real handlers,
// Entities, Blueprints and Settings, players joined through the real onConnection). Each test sends a packet as a
// connection below the rank the rule of test/lib/packetAccess.mjs names and reads what came of it: the world's state,
// what the connections were told, the refusal's log line; then, where there is one, the same packet from a
// connection with the rank, which has to take effect. A check removed from a handler fails here, whatever its
// variables are called.
//
// A handler is called directly where a check before it would hide its own (the inbound gate drops three names from
// a visitor before any handler: test 'the inbound gate …' asks the gate, the others ask the handler). The same rules
// are asked of the running server by test/e2e/access-control.mjs, which cannot see a check that has a second one
// behind it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ranks } from '../src/core/extras/ranks.js'
import { internalEvents } from '../src/core/extras/internalEvents.js'
import { BUILDER_ONLY_PACKETS } from '../src/core/extras/inboundPolicy.js'
import { ADMIN_SETTING_KEYS } from '../src/core/extras/settingsPolicy.js'
import { parseTipTokens } from '../src/core/extras/evmTokens.js'
import * as solana from '../src/server/solana-gating.js'
import * as evm from '../src/server/evm-gating.js'
import { app, fixture, sentTo, settle } from './lib/joinFixture.mjs'
import { PACKET_RULES, REFUSED_EVENT_NAMES, namesOfClass } from './lib/packetAccess.mjs'

const CODE = 'p14-unit-admin-code'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const methodOf = name => `on${name[0].toUpperCase()}${name.slice(1)}`

// A world with an admin code (so a visitor is a visitor) and four players: an admin, a builder, a visitor and
// another visitor. `modules`: the gating modules the handlers see in place of the real ones (below)
async function stage(t, { modules } = {}) {
  const f = fixture(t, { env: { ADMIN_CODE: CODE }, modules })
  f.world.settings.setHasAdminCode(true)
  f.world.settings.rank = Ranks.VISITOR
  // what the handlers ask of the rest of the world, recorded
  const calls = []
  f.calls = calls
  f.world.chat.clear = broadcast => calls.push(['chat.clear', broadcast])
  f.world.monitor = {
    getStats: async () => (calls.push(['monitor.getStats']), { currentCPU: 1, currentMemory: 10, maxMemory: 20 }),
  }
  f.world.ai = { ...f.world.ai, onAction: (action, key) => (calls.push(['ai.onAction', key]), null) }
  f.world.livekit.setMuted = (playerId, muted) => calls.push(['livekit.setMuted', playerId, muted])
  f.world.events = { emit: name => calls.push(['events.emit', name]) }
  const enter = async (id, rank) => {
    f.users.set(id, { id, name: id, avatar: null, rank })
    const joined = await f.join({ authToken: id })
    assert.equal(joined.method, 'onSnapshot', `${id} joined`)
    const socket = f.network.sockets.get(id)
    socket.ws.packets.length = 0
    return socket
  }
  f.admin = await enter('admin', Ranks.ADMIN)
  f.maker = await enter('maker', Ranks.BUILDER)
  f.visitor = await enter('visitor', Ranks.VISITOR)
  f.other = await enter('other', Ranks.VISITOR)
  f.player = socket => f.world.entities.get(socket.id)
  f.logged = text => f.logs.some(line => line.includes(text))
  // where a player stands (a record made here, as when the joined record was made inside the old harness's realm,
  // whose objects the handlers' sanitizers did not take for plain ones)
  f.stand = (socket, position) => {
    const player = f.player(socket)
    player.data = { ...player.data, position }
  }
  f.rankLine = (action, socket) => `player attempted to ${action} without builder permission: "${socket.id}"`
  f.addApp = (id, extra) => f.world.entities.add(app(id, 'bp', extra))
  // (the joins raised `enter`)
  calls.length = 0
  return f
}

// what a connection has been told, as [method, data]
const told = socket => {
  for (let i = 0; i < 10 && socket.ws.pending.length; i++) socket.ws.drain()
  return sentTo(socket)
}
const replies = (socket, method) =>
  told(socket)
    .filter(([name]) => name === method)
    .map(([, data]) => data)
const said = socket => replies(socket, 'onChatAdded').map(line => line.body)

const blueprint = id => ({
  id,
  version: 0,
  name: id,
  image: null,
  author: null,
  url: null,
  desc: null,
  model: 'asset://crash-block.glb',
  script: null,
  props: {},
  preload: false,
  public: false,
  locked: false,
  frozen: false,
  unique: false,
  scene: false,
  disabled: false,
})

// ---- builder ----

// Each builder rule: the payload, how to tell that it was taken, and the action its refusal line names
const BUILDER_CASES = [
  {
    name: 'blueprintAdded',
    action: 'add blueprint',
    payload: () => blueprint('bp-new'),
    taken: f => !!f.world.blueprints.get('bp-new'),
  },
  {
    name: 'blueprintModified',
    action: 'modify blueprint',
    payload: () => ({ id: 'bp', version: 1, desc: 'changed' }),
    taken: f => f.world.blueprints.get('bp').version === 1,
  },
  {
    name: 'entityAdded',
    action: 'add entity',
    payload: () => app('appNew0001'),
    taken: f => !!f.world.entities.get('appNew0001'),
  },
  {
    name: 'entityModified',
    action: 'modify entity',
    prepare: f => f.addApp('appMoved01', { position: [0, 0, 0] }),
    payload: () => ({ id: 'appMoved01', position: [3, 0, 3] }),
    taken: f => same(f.world.entities.get('appMoved01').data.position, [3, 0, 3]),
  },
  {
    name: 'entityRemoved',
    action: 'remove entity',
    prepare: f => f.addApp('appGone001'),
    payload: () => 'appGone001',
    taken: f => !f.world.entities.get('appGone001'),
  },
  {
    name: 'settingsModified',
    action: 'modify settings',
    payload: () => ({ key: 'title', value: 'P14 title' }),
    taken: f => f.world.settings.title === 'P14 title',
  },
  {
    name: 'spawnModified',
    action: 'modify spawn',
    // both stand away from the spawn, so that a spawn set where either stands is a change
    prepare: f => {
      for (const socket of [f.visitor, f.maker]) f.stand(socket, [5, 0, 5])
    },
    payload: () => 'set',
    taken: f => same(f.network.spawn.position, [5, 0, 5]),
  },
  {
    name: 'ai',
    action: 'use ai',
    payload: () => ({ name: 'create', blueprintId: 'bp', appId: 'x', prompt: 'a cube' }),
    taken: f => f.calls.some(([call]) => call === 'ai.onAction'),
  },
]

test('builder: each handler refuses a visitor itself, says so in the log, and takes the same packet from a builder', async t => {
  const names = BUILDER_CASES.map(c => c.name)
  for (const name of names) assert.ok(namesOfClass('builder').includes(name), `${name} has a builder rule`)
  for (const c of BUILDER_CASES) {
    const f = await stage(t)
    c.prepare?.(f)
    const handler = f.network[methodOf(c.name)]
    await handler(f.visitor, c.payload())
    await settle()
    assert.equal(c.taken(f), false, `${c.name}: taken from a visitor`)
    assert.ok(f.logged(f.rankLine(c.action, f.visitor)), `${c.name}: the refusal is not in the log`)
    await handler(f.maker, c.payload())
    await settle()
    assert.equal(c.taken(f), true, `${c.name}: not taken from a builder`)
  }
})

test('builder: the inbound gate drops blueprintAdded, blueprintModified and ai from a visitor before any handler', async t => {
  // the names as the rules give them, not as the gate's own list does (that list is what is asked)
  const GATED = ['blueprintAdded', 'blueprintModified', 'ai']
  const f = await stage(t)
  const ran = []
  for (const name of GATED) {
    const method = methodOf(name)
    const handler = f.network[method]
    f.network[method] = (socket, ...rest) => (ran.push([name, socket.id]), handler(socket, ...rest))
  }
  const payloads = Object.fromEntries(BUILDER_CASES.map(c => [c.name, c.payload]))
  for (const name of GATED) f.send(name, payloads[name](), f.visitor)
  await settle()
  assert.deepEqual(ran, [], 'a handler ran for a visitor')
  for (const name of GATED) {
    assert.ok(f.logged(`[network] ${name} from client visitor dropped: builder only`), name)
  }
  for (const name of GATED) f.send(name, payloads[name](), f.maker)
  await settle()
  assert.deepEqual(
    ran.map(([name]) => name),
    GATED,
    "the builder's reach their handlers"
  )
  assert.deepEqual([...BUILDER_ONLY_PACKETS].sort(), [...GATED].sort(), 'and no other name is refused by the gate')
})

test("builder: a visitor's settingsModified is refused for its rank before its content is read", async t => {
  const f = await stage(t)
  await f.network.onSettingsModified(f.visitor, { key: 'no-such-setting', value: 1 })
  await f.network.onSettingsModified(f.visitor, 'not an object')
  assert.ok(f.logged(f.rankLine('modify settings', f.visitor)))
  assert.equal(f.logged('unknown setting'), false, "the visitor's packet was read")
  // the control: the builder's same packet is read, and refused for what it says
  await f.network.onSettingsModified(f.maker, { key: 'no-such-setting', value: 1 })
  assert.ok(f.logged('onSettingsModified: unknown setting: "no-such-setting"'))
})

test('builder: an app is changed or removed by a builder; a visitor may end its own move and upload, and nothing else', async t => {
  const f = await stage(t)
  f.addApp('appHeld001', { position: [1, 0, 1], scale: [1, 1, 1], mover: 'visitor' })
  f.addApp('appUpload1', { uploader: 'visitor' })
  const held = () => f.world.entities.get('appHeld001').data
  const release = { id: 'appHeld001', mover: null, position: [5, 0, 5], scale: [2, 2, 2] }
  // a visitor that holds neither
  await f.network.onEntityModified(f.other, release)
  await f.network.onEntityRemoved(f.other, 'appUpload1')
  assert.equal(held().mover, 'visitor', 'the move is not ended by another visitor')
  assert.ok(f.world.entities.get('appUpload1'), 'the upload is not removed by another visitor')
  assert.ok(f.logged(f.rankLine('modify entity', f.other)))
  assert.ok(f.logged(f.rankLine('remove entity', f.other)))
  // the holder, a visitor: its own move ends, and nothing else of the packet is taken
  await f.network.onEntityModified(f.visitor, release)
  assert.equal(held().mover, null, 'its own move is ended')
  assert.ok(same(held().position, [1, 0, 1]), 'the position it sent along is not taken')
  assert.ok(same(held().scale, [1, 1, 1]), 'nor the scale')
  await f.network.onEntityRemoved(f.visitor, 'appUpload1')
  assert.equal(f.world.entities.get('appUpload1'), undefined, 'its own upload is removed')
  // holding nothing now, it is refused as any visitor is
  await f.network.onEntityModified(f.visitor, { id: 'appHeld001', position: [6, 0, 6] })
  await f.network.onEntityModified(f.visitor, { id: 'appHeld001', mover: 'visitor' })
  await f.network.onEntityRemoved(f.visitor, 'appHeld001')
  assert.ok(same(held().position, [1, 0, 1]), 'not moved')
  assert.equal(held().mover, null, 'not taken again')
  assert.ok(f.world.entities.get('appHeld001'), 'not removed')
})

test('builder: /spawn, /chat clear and /server stats are refused to a visitor and done for a builder', async t => {
  const f = await stage(t)
  for (const socket of [f.visitor, f.maker]) f.stand(socket, [7, 0, 7])
  const command = (socket, ...args) => f.network.onCommand(socket, { args })
  await command(f.visitor, 'spawn', 'set')
  await command(f.visitor, 'chat', 'clear')
  await command(f.visitor, 'server', 'stats')
  await settle()
  assert.ok(same(f.network.spawn.position, [0, 0, 0]), 'the spawn point')
  assert.ok(f.logged(f.rankLine('modify spawn', f.visitor)))
  assert.deepEqual(
    f.calls.filter(([call]) => call !== 'events.emit'),
    [],
    'the chat was cleared or the figures asked for'
  )
  assert.equal(
    said(f.visitor).some(body => /^(CPU|Memory):/.test(body)),
    false,
    'the visitor was told process figures'
  )
  await command(f.maker, 'spawn', 'set')
  await command(f.maker, 'chat', 'clear')
  await command(f.maker, 'server', 'stats')
  await settle()
  assert.ok(same(f.network.spawn.position, [7, 0, 7]), 'the spawn point, set by the builder')
  assert.deepEqual(
    f.calls.filter(([call]) => call !== 'events.emit'),
    [['chat.clear', true], ['monitor.getStats']]
  )
  assert.ok(
    said(f.maker).some(body => body.startsWith('Memory:')),
    'the builder was told the figures'
  )
})

// ---- admin ----

test("admin: nobody but an admin changes a rank, its own, an admin's or a third player's", async t => {
  const f = await stage(t)
  const rank = socket => f.player(socket).data.rank
  for (const sender of [f.visitor, f.maker]) {
    await f.network.onModifyRank(sender, { playerId: f.other.id, rank: Ranks.BUILDER })
    await f.network.onModifyRank(sender, { playerId: sender.id, rank: Ranks.ADMIN })
    await f.network.onModifyRank(sender, { playerId: f.admin.id, rank: Ranks.VISITOR })
  }
  assert.deepEqual([f.admin, f.maker, f.visitor, f.other].map(rank), [
    Ranks.ADMIN,
    Ranks.BUILDER,
    Ranks.VISITOR,
    Ranks.VISITOR,
  ])
  await f.network.onModifyRank(f.admin, { playerId: f.other.id, rank: Ranks.BUILDER })
  assert.equal(rank(f.other), Ranks.BUILDER, 'the admin gives a rank')
})

test('admin: rank and customAvatars are refused to a builder and taken from an admin', async t => {
  const values = { rank: Ranks.BUILDER, customAvatars: true }
  assert.deepEqual(Object.keys(values).sort(), [...ADMIN_SETTING_KEYS].sort(), 'a value for every admin setting')
  for (const [key, value] of Object.entries(values)) {
    const f = await stage(t)
    const before = f.world.settings[key]
    await f.network.onSettingsModified(f.maker, { key, value })
    assert.equal(f.world.settings[key], before, `${key}: taken from a builder`)
    assert.ok(f.logged('player attempted to modify setting without admin permission'), key)
    await f.network.onSettingsModified(f.admin, { key, value })
    assert.equal(f.world.settings[key], value, `${key}: not taken from an admin`)
  }
})

test("kick and mute: only a player whose rank is above the target's, and the target a player", async t => {
  const f = await stage(t)
  f.addApp('appTarget1')
  const refused = [
    [f.visitor, f.other],
    [f.visitor, f.maker],
    [f.visitor, f.admin],
    [f.maker, f.admin],
    [f.maker, f.maker],
    [f.admin, f.admin],
  ]
  for (const [sender, target] of refused) {
    await f.network.onMute(sender, { playerId: target.id, muted: true })
    f.network.onKick(sender, target.id)
  }
  await f.network.onMute(f.maker, { playerId: 'appTarget1', muted: true })
  f.network.onKick(f.maker, 'appTarget1')
  for (const socket of [f.admin, f.maker, f.visitor, f.other]) {
    assert.equal(socket.disconnected, false, `${socket.id} was kicked`)
    assert.equal(replies(socket, 'onKick').length, 0, `${socket.id} was told of a kick`)
  }
  assert.ok(f.world.entities.get('appTarget1'), 'the app is still here')
  assert.deepEqual(
    f.calls.filter(([call]) => call === 'livekit.setMuted'),
    [],
    'somebody was muted'
  )
  // the controls: a builder above a visitor, an admin above a builder
  await f.network.onMute(f.admin, { playerId: f.maker.id, muted: true })
  assert.deepEqual(
    f.calls.filter(([call]) => call === 'livekit.setMuted'),
    [['livekit.setMuted', f.maker.id, true]]
  )
  f.network.onKick(f.maker, f.other.id)
  assert.deepEqual(replies(f.other, 'onKick'), ['moderation'])
  assert.equal(f.other.disconnected, true, 'the visitor is closed')
})

test('/admin: a wrong code gives no rank and the 21st closes the socket; the right code makes an admin', async t => {
  const f = await stage(t)
  const guess = i => f.network.onCommand(f.visitor, { args: ['admin', `p14-guess-${i}`] })
  await guess(0)
  assert.equal(f.player(f.visitor).data.rank, Ranks.VISITOR)
  assert.deepEqual(said(f.visitor), ['Wrong admin code.'])
  for (let i = 1; i < 20; i++) await guess(i)
  assert.equal(f.visitor.disconnected, false, 'closed before its 21st attempt')
  await guess(20)
  assert.equal(f.visitor.disconnected, true, 'the socket that keeps trying is closed')
  assert.deepEqual(replies(f.visitor, 'onKick'), ['admin_attempts'])
  assert.equal(f.player(f.visitor), undefined, 'and its player is gone')
  // no attempt became a command event, and nobody else was given a rank
  assert.deepEqual(f.calls, [])
  assert.deepEqual(
    [f.admin, f.maker, f.other].map(socket => f.player(socket).data.rank),
    [Ranks.ADMIN, Ranks.BUILDER, Ranks.VISITOR]
  )
  // the control: the right code, from a connection the wrong ones did not slow down (another user, another address)
  const right = await stage(t)
  await right.network.onCommand(right.other, { args: ['admin', CODE] })
  assert.equal(right.player(right.other).data.rank, Ranks.ADMIN)
  assert.deepEqual(right.calls, [], 'the code is no command event either')
})

// ---- refused whoever sends it ----

test('relays: a client copy of playerTeleport, playerPush or playerSessionAvatar reaches nobody and is logged once', async t => {
  const f = await stage(t)
  const relays = namesOfClass('relay')
  assert.deepEqual([...relays].sort(), ['playerPush', 'playerSessionAvatar', 'playerTeleport'])
  const payload = { networkId: f.other.id, position: [1, 2, 3], force: [0, 9, 0], avatar: 'asset://avatar.vrm' }
  for (const sender of [f.visitor, f.admin]) {
    for (const name of relays) {
      f.send(name, payload, sender)
      f.send(name, payload, sender)
    }
  }
  await settle()
  for (const socket of [f.admin, f.maker, f.visitor, f.other]) {
    const got = told(socket).filter(([method]) => relays.some(name => method === methodOf(name)))
    assert.deepEqual(got, [], `${socket.id} was sent a relay`)
  }
  for (const sender of [f.visitor, f.admin]) {
    for (const name of relays) {
      const line = `[network] ${name} from client ${sender.id} ignored: only server scripts may act on other players`
      assert.equal(f.logs.filter(entry => entry === line).length, 1, line)
    }
  }
})

test("refused whoever sends it: an event named after an engine hook or a world event reaches no app's script", async t => {
  const f = await stage(t)
  const app = f.addApp('appEvents1')
  const events = []
  app.onEvent = (version, name, data, from) => events.push([name, from])
  const names = [...new Set([...REFUSED_EVENT_NAMES, ...internalEvents])]
  for (const name of REFUSED_EVENT_NAMES) assert.ok(names.includes(name))
  for (const sender of [f.visitor, f.admin]) {
    for (const name of names) f.network.onEntityEvent(sender, ['appEvents1', 0, name, { forged: true }])
  }
  assert.deepEqual(events, [])
  // the control: the same app and payload, under a name that is not internal
  f.network.onEntityEvent(f.visitor, ['appEvents1', 0, 'probe', { forged: true }])
  assert.deepEqual(events, [['probe', 'visitor']])
})

test("refused whoever sends it: another player's fields, a player's removal", async t => {
  const f = await stage(t)
  const target = f.player(f.other)
  const before = JSON.stringify(target.data)
  const change = { id: f.other.id, name: 'renamed', p: [50, 0, 50], q: [0, 0, 0, 1], t: true }
  for (const sender of [f.visitor, f.admin]) {
    await f.network.onEntityModified(sender, change)
    await f.network.onEntityRemoved(sender, f.other.id)
  }
  assert.equal(JSON.stringify(target.data), before, "the other player's fields")
  assert.equal(f.player(f.other), target, 'the player is still here')
  assert.equal(f.logs.filter(line => line.includes('player attempted to modify another player')).length, 2)
  assert.equal(f.logs.filter(line => line.includes('player attempted to remove a non-app entity')).length, 2)
  // the control: the player itself
  await f.network.onEntityModified(f.other, change)
  assert.equal(target.data.name, 'renamed')
})

test("refused whoever sends it: a player's own fields that only the server sets; a field it may set is taken", async t => {
  const f = await stage(t)
  const forbidden = {
    rank: Ranks.ADMIN,
    userId: 'someone-else',
    owner: 'someone-else',
    health: 0,
    type: 'app',
    enteredAt: 1,
    evmTips: true,
    position: [99, 0, 99],
    quaternion: [0, 1, 0, 0],
    emote: 'asset://emote.glb',
    effect: { freeze: true },
  }
  for (const socket of [f.visitor, f.maker]) {
    const player = f.player(socket)
    const before = { ...player.data }
    await f.network.onEntityModified(socket, { id: socket.id, ...forbidden, name: `${socket.id}-renamed` })
    assert.equal(player.data.name, `${socket.id}-renamed`, `${socket.id}: the name is taken`)
    for (const key of Object.keys(forbidden)) {
      assert.ok(same(player.data[key], before[key]), `${socket.id}: ${key} is ${JSON.stringify(player.data[key])}`)
    }
  }
})

test("refused whoever sends it: a player added through entityAdded, or an app under a player's id", async t => {
  const f = await stage(t)
  // one complete app record: each refused packet differs from it in one field, and the control is the record itself
  const record = app('appAdded01')
  const announced = id =>
    [f.admin, f.maker, f.visitor, f.other]
      .flatMap(socket => told(socket))
      .filter(([method, data]) => method === 'onEntityAdded' && data?.id === id)
  for (const sender of [f.maker, f.admin, f.visitor]) {
    f.network.onEntityAdded(sender, { ...record, type: 'player' })
    assert.equal(f.world.entities.get(record.id), undefined, `a player from ${sender.id}`)
  }
  assert.ok(f.logged('onEntityAdded: invalid entity: "appAdded01"'))
  assert.deepEqual(announced(record.id), [], 'a player was announced')
  assert.equal(f.network.dirtyApps.has(record.id), false, 'a player is to be stored as an app')
  // the same record under the id of a player who is here
  const player = f.world.entities.get(f.visitor.id)
  assert.equal(player?.isPlayer, true)
  f.network.onEntityAdded(f.maker, { ...record, id: f.visitor.id })
  assert.equal(f.world.entities.get(f.visitor.id), player, 'the player is still the entity registered under its id')
  assert.deepEqual(announced(f.visitor.id), [], "an app under the player's id was announced")
  assert.equal(f.network.dirtyApps.has(f.visitor.id), false, "an app is to be stored under the player's id")
  // the control: the record itself, from the builder, is added, announced to the three others and to be stored
  f.network.onEntityAdded(f.maker, record)
  assert.equal(f.world.entities.get(record.id)?.isApp, true)
  assert.equal(announced(record.id).length, 3)
  assert.equal(f.network.dirtyApps.has(record.id), true)
})

// ---- the wallet flows: open to anyone where the world has the feature, ignored where it has not ----

const host = { WALLET_HOST: 'test.example', WALLET_URI: 'https://test.example' }
const SOLANA_ON = { ...solana, ...host, TOKEN_GATING_ENABLED: true, REQUIRED_TOKEN_AMOUNT: 10000 }
const EVM_ON = {
  ...evm,
  ...host,
  EVM_ENABLED: true,
  EVM_CHAIN_IDS: [137],
  EVM_CHAIN_ID: 137,
  EVM_TIP_TOKENS: parseTipTokens('JPYC', 137),
}
// the worlds without a feature: no token gate, no EVM sign-in; and EVM sign-in without tips
const OFF = {
  solana: { solana: { ...SOLANA_ON, TOKEN_GATING_ENABLED: false }, evm: EVM_ON },
  evm: { solana: SOLANA_ON, evm: { ...EVM_ON, EVM_ENABLED: false, EVM_TIP_TOKENS: [] } },
  tips: { solana: SOLANA_ON, evm: { ...EVM_ON, EVM_TIP_TOKENS: [] } },
}
// the switches a handler reads first; any other read of a gating module is recorded
const SWITCHES = ['TOKEN_GATING_ENABLED', 'EVM_ENABLED', 'EVM_TIP_TOKENS']
const watched = (module, reads, label) =>
  new Proxy(module, {
    get(target, key) {
      if (!SWITCHES.includes(key)) reads.push(`${label}.${String(key)}`)
      return target[key]
    },
  })
// a collaborator that fails the test when it is touched (and is recorded, for a handler that catches the throw)
const tripwire = (label, touched) =>
  new Proxy(function () {}, {
    get(_, key) {
      touched.push(`${label}.${String(key)}`)
      throw new Error(`${label} was touched in a world without the feature`)
    },
    apply() {
      touched.push(label)
      throw new Error(`${label} was called in a world without the feature`)
    },
  })

const SOL = '11111111111111111111111111111111'
const EVM_ADDRESS = `0x${'12'.repeat(20)}`
// Each wallet packet, with a state of the sender's in which, in a world with the feature, the handler acts (`acted`).
// The six marked `silent` are the ones a refusal cannot be seen from outside for: with the feature on, the same
// payload from a connection without that state is not answered either, so the e2e suite cannot tell the feature
// check from the next one. They are the reason this test exists.
const WALLET_CASES = [
  {
    name: 'requestBuilderNonce',
    feature: 'solana',
    payload: () => ({ walletAddress: SOL, attempt: 1 }),
    acted: s => replies(s, 'onBuilderNonce').length > 0,
  },
  {
    name: 'requestBuilderByToken',
    feature: 'solana',
    silent: true,
    prepare: s => {
      s.wallet.challenge = { ...solana.buildChallenge(SOL, host.WALLET_HOST, Date.now(), host.WALLET_URI), attempt: 1 }
    },
    payload: s => ({ walletAddress: SOL, signature: 'x', nonce: s.wallet.challenge.nonce, attempt: 1 }),
    acted: s => s.wallet.challenge === null,
  },
  {
    name: 'requestBuilderRecheck',
    feature: 'solana',
    silent: true,
    prepare: s => {
      s.wallet.verified = SOL
    },
    payload: () => ({}),
    acted: s => s.wallet.builderRecheckAt !== 0,
  },
  {
    name: 'tokenBalanceRequest',
    feature: 'solana',
    payload: () => ({ id: 2 }),
    acted: s => replies(s, 'onTokenBalance').length > 0,
  },
  {
    name: 'revokeBuilderByToken',
    feature: 'solana',
    silent: true,
    prepare: s => {
      s.wallet.verified = SOL
    },
    payload: () => ({}),
    acted: s => s.wallet.verified === null,
  },
  {
    name: 'requestEvmNonce',
    feature: 'evm',
    payload: () => ({ address: EVM_ADDRESS, attempt: 3 }),
    acted: s => replies(s, 'onEvmNonce').length > 0,
  },
  {
    name: 'requestEvmVerify',
    feature: 'evm',
    silent: true,
    prepare: s => {
      const challenge = evm.buildEvmChallenge(EVM_ADDRESS, {
        host: 'test.example',
        uri: host.WALLET_URI,
        chainId: 137,
        now: Date.now(),
      })
      s.evmWallet.challenge = { ...challenge, attempt: 3 }
    },
    payload: s => ({
      address: EVM_ADDRESS,
      signature: `0x${'1'.repeat(130)}`,
      nonce: s.evmWallet.challenge.nonce,
      attempt: 3,
    }),
    acted: s => s.evmWallet.challenge === null,
  },
  {
    name: 'revokeEvmWallet',
    feature: 'evm',
    silent: true,
    prepare: s => {
      s.evmWallet.verified = EVM_ADDRESS
    },
    payload: () => ({}),
    acted: s => s.evmWallet.verified === null,
  },
  {
    name: 'setEvmTipReceive',
    feature: 'tips',
    silent: true,
    prepare: s => {
      s.evmWallet.verified = EVM_ADDRESS
    },
    payload: () => ({ enabled: true }),
    acted: s => s.evmWallet.receiveTips === true,
  },
  {
    name: 'requestEvmTipIntent',
    feature: 'tips',
    payload: () => ({ id: 4, to: 'nobody', token: 'JPYC', amount: '1' }),
    acted: s => replies(s, 'onEvmTipIntent').length > 0,
  },
  {
    name: 'evmTip',
    feature: 'tips',
    payload: () => ({ ticket: '0'.repeat(32), txHash: `0x${'1'.repeat(64)}` }),
    acted: s => replies(s, 'onEvmTipStatus').length > 0,
  },
]

// the sender's wallet state, as text (the tickets are a Map)
const walletState = s => JSON.stringify([s.wallet, { ...s.evmWallet, tickets: [...s.evmWallet.tickets] }])

test('the wallet flows: in a world without the feature each handler returns before it reads anything, and in a world with it the same state is acted on', async t => {
  assert.deepEqual(
    WALLET_CASES.map(c => c.name).sort(),
    namesOfClass('feature').sort(),
    'a case for every wallet packet'
  )
  assert.deepEqual(
    WALLET_CASES.filter(c => c.silent)
      .map(c => c.name)
      .sort(),
    [
      'requestBuilderByToken',
      'requestBuilderRecheck',
      'requestEvmVerify',
      'revokeBuilderByToken',
      'revokeEvmWallet',
      'setEvmTipReceive',
    ]
  )
  for (const c of WALLET_CASES) {
    // the features this packet needs, each off in turn (tips: EVM off, and EVM on without tip tokens)
    const worlds = c.feature === 'tips' ? ['evm', 'tips'] : [c.feature]
    for (const world of worlds) {
      const reads = []
      const f = await stage(t, {
        modules: {
          solanaGating: watched(OFF[world].solana, reads, 'solanaGating'),
          evmGating: watched(OFF[world].evm, reads, 'evmGating'),
        },
      })
      const s = f.visitor
      c.prepare?.(s)
      const state = walletState(s)
      const touched = []
      const own = {}
      for (const key of ['tokenBalanceService', 'evmHoldings', 'tipWatcher', 'evmSignatureVerifier', 'db']) {
        own[key] = f.network[key]
        f.network[key] = tripwire(`network.${key}`, touched)
      }
      f.world.events = tripwire('world.events', touched)
      reads.length = 0
      await f.network[methodOf(c.name)](s, c.payload(s))
      await settle()
      const where = `${c.name} in a world without ${world === 'tips' ? 'tips' : world}`
      assert.deepEqual(reads, [], `${where}: read the gating module`)
      assert.deepEqual(touched, [], `${where}: touched a collaborator`)
      assert.deepEqual(told(s), [], `${where}: answered`)
      assert.equal(walletState(s), state, `${where}: changed the sender's wallet state`)
      assert.equal(c.acted(s), false, `${where}: acted`)
      // (the test's end stops the network, which touches what it holds: it has its own back for that)
      Object.assign(f.network, own)
    }
    // the control: the same state and payload in a world with the feature
    const f = await stage(t, { modules: { solanaGating: SOLANA_ON, evmGating: EVM_ON } })
    f.network.tokenBalanceService = { get: async () => ({ known: true, balance: 0 }) }
    const s = f.visitor
    c.prepare?.(s)
    await f.network[methodOf(c.name)](s, c.payload(s))
    await settle()
    assert.equal(c.acted(s), true, `${c.name}: not acted on in a world with the feature`)
  }
})

test('the rules these tests ask are the rules of the table', () => {
  for (const name of ['kick', 'mute'])
    assert.deepEqual(
      PACKET_RULES[name].map(rule => rule.class),
      ['outranks']
    )
  assert.deepEqual(
    PACKET_RULES.modifyRank.map(rule => rule.class),
    ['admin']
  )
  for (const name of ['entityEvent', 'entityRemoved', 'entityModified', 'entityAdded']) {
    assert.ok(
      PACKET_RULES[name].some(rule => rule.class === 'nobody'),
      `${name} has a rule that refuses everyone`
    )
  }
})
