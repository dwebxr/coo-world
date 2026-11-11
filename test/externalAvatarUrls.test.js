// Which avatar and emote urls a player can make every other client load (src/core/extras/entityModifyPolicy.js
// isExternalUrl and the rule in sanitizePlayerSelfModify; ServerNetwork onEntityModified and onConnection;
// createPlayerProxy on the server). A file of the world's own store: anyone. A url outside the world: a builder, or
// the very url a server script chose for that player.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SCRIPT_EMOTE_LIMIT,
  isExternalUrl,
  rememberScriptEmote,
  sanitizePlayerSelfModify,
} from '../src/core/extras/entityModifyPolicy.js'
import { Ranks } from '../src/core/extras/ranks.js'
import { fixture, nextId, sentTo } from './lib/joinFixture.mjs'
import { loadClient } from './lib/clientHarness.mjs'

const ASSETS = 'https://world.example/assets'
const me = 'socket-me'
const EVIL_VRM = 'https://evil.example/a.vrm'
const EVIL_GLB = 'https://evil.example/dance.glb'

test('isExternalUrl: an asset or a plain address of a store file is not; any other http(s) url is', () => {
  for (const own of [
    'asset://avatar.vrm',
    'asset://emote-float.glb?s=1.5',
    `${ASSETS}/avatar.vrm`,
    `${ASSETS}/0123abcd.glb`,
    null,
    undefined,
    '',
    7,
  ]) {
    assert.equal(isExternalUrl(own, ASSETS), false, String(own))
  }
  for (const other of [
    EVIL_VRM,
    'http://world.example/assets/avatar.vrm', // another scheme is another origin
    'https://world.example:8443/assets/avatar.vrm',
    'https://world.example/assets/../secret/a.vrm',
    'https://world.example/assets/sub/a.vrm',
    'https://world.example/assets/avatar.vrm?x=1',
    'https://user:pw@world.example/assets/avatar.vrm',
    'https://world.example.evil.example/assets/avatar.vrm',
    'HTTPS://world.example/assets/avatar.vrm',
    'https://world.example/other/avatar.vrm',
  ]) {
    assert.equal(isExternalUrl(other, ASSETS), true, other)
  }
  // without a clean assets url nothing can be told to be the store's: every http(s) url is outside
  assert.equal(isExternalUrl(`${ASSETS}/avatar.vrm`, undefined), true)
  assert.equal(isExternalUrl(`${ASSETS}/avatar.vrm`, `${ASSETS}/`), true)
})

test('the policy: a url outside the world is taken from a builder, or when a server script chose it for the player', () => {
  const modify = (data, options) => sanitizePlayerSelfModify({ id: me, ...data }, me, { assetsUrl: ASSETS, ...options })
  // assets: anyone
  assert.deepEqual(modify({ sessionAvatar: 'asset://avatar.vrm', e: 'asset://emote-float.glb' }), {
    id: me,
    e: 'asset://emote-float.glb',
    sessionAvatar: 'asset://avatar.vrm',
  })
  assert.deepEqual(modify({ sessionAvatar: `${ASSETS}/avatar.vrm` }), { id: me, sessionAvatar: `${ASSETS}/avatar.vrm` })
  // outside: a visitor's is refused (the emote becomes null so nobody stays on the last one, the avatar is dropped)
  assert.deepEqual(modify({ sessionAvatar: EVIL_VRM, e: EVIL_GLB, p: [1, 2, 3] }), { id: me, p: [1, 2, 3], e: null })
  assert.equal(modify({ sessionAvatar: EVIL_VRM }), null)
  // Custom Avatars on (the stored avatar may change): still not a url outside the world
  assert.deepEqual(modify({ avatar: EVIL_VRM, sessionAvatar: EVIL_VRM, p: [0, 0, 0] }, { allowAvatar: true }), {
    id: me,
    p: [0, 0, 0],
  })
  assert.deepEqual(modify({ avatar: 'asset://mine.vrm' }, { allowAvatar: true }), {
    id: me,
    avatar: 'asset://mine.vrm',
  })
  // a builder
  assert.deepEqual(
    modify({ avatar: EVIL_VRM, sessionAvatar: EVIL_VRM, e: EVIL_GLB }, { allowAvatar: true, allowExternal: true }),
    {
      id: me,
      e: EVIL_GLB,
      sessionAvatar: EVIL_VRM,
      avatar: EVIL_VRM,
    }
  )
  // what a server script chose for this player: that exact value, and no other
  const chosen = { scriptAvatar: EVIL_VRM, scriptEmotes: new Set([EVIL_GLB]) }
  assert.deepEqual(modify({ sessionAvatar: EVIL_VRM, e: EVIL_GLB }, chosen), {
    id: me,
    e: EVIL_GLB,
    sessionAvatar: EVIL_VRM,
  })
  for (const near of [`${EVIL_VRM}?v=2`, `${EVIL_VRM}#x`, EVIL_VRM.toUpperCase(), EVIL_VRM.replace('a.vrm', 'b.vrm')]) {
    assert.equal(modify({ sessionAvatar: near }, chosen), null, near)
  }
  for (const near of [`${EVIL_GLB}?s=2`, EVIL_GLB.replace('dance', 'other')]) {
    assert.deepEqual(modify({ e: near }, chosen), { id: me, e: null }, near)
  }
  // a script's choice is for the session avatar, not for the stored one
  assert.equal(modify({ avatar: EVIL_VRM }, { allowAvatar: true, scriptAvatar: EVIL_VRM }), null)
  // each url is still read once: what is checked is what is kept
  let reads = 0
  const data = {
    id: me,
    get sessionAvatar() {
      return reads++ ? EVIL_VRM : 'asset://avatar.vrm'
    },
  }
  assert.deepEqual(sanitizePlayerSelfModify(data, me, { assetsUrl: ASSETS }), {
    id: me,
    sessionAvatar: 'asset://avatar.vrm',
  })
  assert.equal(reads, 1)
})

test('rememberScriptEmote keeps the latest emote urls a script chose, and only emote urls', () => {
  const player = {}
  for (const junk of [undefined, null, '', 7, {}, 'dance', 'javascript:1', 'x'.repeat(600)])
    rememberScriptEmote(player, junk)
  assert.equal(player.scriptEmotes, undefined)
  for (let i = 0; i < SCRIPT_EMOTE_LIMIT + 4; i++) rememberScriptEmote(player, `https://cdn.example/${i}.glb`)
  assert.equal(player.scriptEmotes.size, SCRIPT_EMOTE_LIMIT)
  assert.equal(player.scriptEmotes.has('https://cdn.example/0.glb'), false, 'the oldest went')
  assert.equal(player.scriptEmotes.has('https://cdn.example/4.glb'), true)
  // named again: it is the latest, and stays when sixteen more come... minus one
  rememberScriptEmote(player, 'https://cdn.example/4.glb')
  for (let i = 100; i < 100 + SCRIPT_EMOTE_LIMIT - 1; i++) rememberScriptEmote(player, `https://cdn.example/${i}.glb`)
  assert.equal(player.scriptEmotes.has('https://cdn.example/4.glb'), true)
  assert.equal(player.scriptEmotes.size, SCRIPT_EMOTE_LIMIT)
})

// The real ServerNetwork handlers, with players that joined through the real onConnection
async function world({ customAvatars = false } = {}) {
  const f = fixture({ env: { ASSETS_BASE_URL: ASSETS, ADMIN_CODE: 'code' } })
  f.world.settings.setHasAdminCode(true)
  f.world.settings.customAvatars = customAvatars
  const connect = async ({ rank = Ranks.VISITOR, avatar, stored } = {}) => {
    const id = nextId()
    f.users.set(id, { id, name: id, rank, avatar: stored ?? null })
    const joined = await f.join({ authToken: id, ...(avatar === undefined ? {} : { avatar }) })
    const socket = f.network.sockets.get(id)
    socket.ws.packets.length = 0
    return { id, socket, snapshot: joined.snapshot, player: f.world.entities.get(id) }
  }
  // packets a socket received since the last call
  const received = who => {
    who.socket.ws.drain?.()
    const packets = sentTo(who.socket)
    who.socket.ws.packets.length = 0
    return packets
  }
  const modify = (who, data) => f.send('entityModified', { id: who.id, ...data }, who.socket)
  return { f, connect, received, modify }
}

test("a visitor's url outside the world is not kept, not relayed, and put right for the visitor", async () => {
  for (const customAvatars of [false, true]) {
    const w = await world({ customAvatars })
    const visitor = await w.connect()
    const watcher = await w.connect()
    w.modify(visitor, { sessionAvatar: EVIL_VRM, e: EVIL_GLB, avatar: EVIL_VRM })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(visitor.player.data.sessionAvatar ?? null, null, `custom avatars ${customAvatars}`)
    assert.notEqual(visitor.player.data.avatar, EVIL_VRM)
    assert.notEqual(visitor.player.data.emote, EVIL_GLB)
    // the watcher is told the emote ended (null), and nothing with either url in it
    const seen = w.received(watcher)
    assert.equal(JSON.stringify(seen).includes('evil.example'), false, JSON.stringify(seen))
    // the visitor is told what their session avatar really is
    const back = w.received(visitor)
    assert.deepEqual(
      back.filter(([name, data]) => name === 'onEntityModified' && 'sessionAvatar' in data).map(([, data]) => data),
      [{ id: visitor.id, sessionAvatar: null }]
    )
    // a late joiner's snapshot has nothing of it either
    const late = await w.connect()
    assert.equal(JSON.stringify(late.snapshot).includes('evil.example'), false)
    assert.equal(w.f.logs.filter(line => /session avatar was not taken/.test(line)).length, 1, 'said once in the log')
  }
})

test('an asset is relayed for anyone, and a url outside the world for a builder', async () => {
  const w = await world()
  const visitor = await w.connect()
  const builder = await w.connect({ rank: Ranks.BUILDER })
  const watcher = await w.connect()
  w.modify(visitor, { sessionAvatar: 'asset://avatar.vrm', e: 'asset://emote-float.glb' })
  w.modify(builder, { sessionAvatar: EVIL_VRM, e: EVIL_GLB })
  const seen = w
    .received(watcher)
    .filter(([name]) => name === 'onEntityModified')
    .map(([, data]) => data)
  assert.deepEqual(seen, [
    { id: visitor.id, e: 'asset://emote-float.glb', sessionAvatar: 'asset://avatar.vrm' },
    { id: builder.id, e: EVIL_GLB, sessionAvatar: EVIL_VRM },
  ])
  assert.equal(
    w.received(visitor).some(([, data]) => data?.id === visitor.id),
    false,
    'no correction for a value taken'
  )
})

test("a visitor's own effect does not make its emote one a script chose", async () => {
  const w = await world()
  const visitor = await w.connect()
  const watcher = await w.connect()
  w.modify(visitor, { ef: { emote: EVIL_GLB, duration: 5 } })
  w.modify(visitor, { e: EVIL_GLB })
  assert.equal(visitor.player.scriptEmotes, undefined)
  const emotes = w.received(watcher).filter(([name, data]) => name === 'onEntityModified' && 'e' in data)
  assert.deepEqual(
    emotes.map(([, data]) => data.e),
    [null]
  )
})

test('what a server script chose for a visitor is taken from that visitor, later too, and from nobody else', async () => {
  const w = await world()
  const visitor = await w.connect()
  const other = await w.connect()
  const watcher = await w.connect()
  // (as createPlayerProxy records it on the server)
  visitor.player.scriptAvatar = EVIL_VRM
  rememberScriptEmote(visitor.player, EVIL_GLB)
  w.modify(visitor, { sessionAvatar: EVIL_VRM, e: EVIL_GLB })
  w.modify(other, { sessionAvatar: EVIL_VRM, e: EVIL_GLB })
  // the visitor's own client ending the effect, and naming the emote again afterwards
  w.modify(visitor, { ef: null, e: null })
  w.modify(visitor, { e: EVIL_GLB })
  const seen = w
    .received(watcher)
    .filter(([name]) => name === 'onEntityModified')
    .map(([, data]) => data)
  assert.deepEqual(seen, [
    { id: visitor.id, e: EVIL_GLB, sessionAvatar: EVIL_VRM },
    { id: other.id, e: null },
    { id: visitor.id, e: null, ef: null },
    { id: visitor.id, e: EVIL_GLB },
  ])
})

test('joining: an avatar outside the world, asked for or stored, is for builders; others get the world default', async () => {
  const w = await world({ customAvatars: true })
  const watcher = await w.connect()
  const visitor = await w.connect({ avatar: EVIL_VRM, stored: EVIL_VRM })
  assert.equal(visitor.player.data.sessionAvatar, null)
  assert.equal(visitor.player.data.avatar, 'asset://avatar.vrm')
  assert.equal(JSON.stringify(visitor.snapshot).includes('evil.example'), false)
  assert.equal(JSON.stringify(w.received(watcher)).includes('evil.example'), false, 'not in the entityAdded broadcast')
  assert.equal(w.f.users.get(visitor.id).avatar, EVIL_VRM, 'the stored value is left alone')
  const assets = await w.connect({ avatar: 'asset://avatar.vrm', stored: 'asset://mine.vrm' })
  assert.equal(assets.player.data.sessionAvatar, 'asset://avatar.vrm')
  assert.equal(assets.player.data.avatar, 'asset://mine.vrm')
  const builder = await w.connect({ rank: Ranks.BUILDER, avatar: EVIL_VRM, stored: EVIL_VRM })
  assert.equal(builder.player.data.sessionAvatar, EVIL_VRM)
  assert.equal(builder.player.data.avatar, EVIL_VRM)
  assert.equal(w.f.logs.filter(line => /asked for an avatar outside this world/.test(line)).length, 1)
})

test('in a world open to all every player is a builder, so nothing changes there', async () => {
  const f = fixture({ env: { ASSETS_BASE_URL: ASSETS } })
  f.world.settings.setHasAdminCode(false)
  const id = nextId()
  f.users.set(id, { id, name: id, rank: Ranks.VISITOR, avatar: EVIL_VRM })
  await f.join({ authToken: id, avatar: EVIL_VRM })
  const player = f.world.entities.get(id)
  assert.equal(player.data.sessionAvatar, EVIL_VRM)
  assert.equal(player.data.avatar, EVIL_VRM)
})

// createPlayerProxy on the server
function serverProxy() {
  const createPlayerProxy = loadClient('core/extras/createPlayerProxy.js', 'createPlayerProxy')
  const sent = []
  const world = {
    network: {
      isServer: true,
      isClient: false,
      id: 'server',
      // (the real one also counts what the call wrote against the script's budget)
      asScript: fn => fn(),
      send: (name, data) => (sent.push([name, data]), true),
      sendTo: (id, name, data) => (sent.push([name, data, id]), true),
    },
    events: { emit() {} },
  }
  const player = {
    world,
    data: { id: 'p1', owner: 'p1', sessionAvatar: null, effect: null },
    modify(patch) {
      Object.assign(this.data, patch)
    },
    setEffect(effect) {
      this.data.effect = effect
    },
  }
  const entity = { data: { id: 'app' }, deadHook: { dead: false } }
  return { proxy: createPlayerProxy(entity, player), player, sent, world }
}

test('a server script sets a session avatar: the server applies it and tells everyone, and remembers the choice', () => {
  const { proxy, player, sent } = serverProxy()
  proxy.setSessionAvatar(EVIL_VRM)
  assert.equal(player.data.sessionAvatar, EVIL_VRM)
  assert.equal(player.scriptAvatar, EVIL_VRM)
  assert.deepEqual(sent, [['entityModified', { id: 'p1', sessionAvatar: EVIL_VRM }]], 'one change, to everyone')
  proxy.setSessionAvatar(null)
  assert.equal(player.data.sessionAvatar, null)
  assert.equal(player.scriptAvatar, null)
  assert.deepEqual(sent.at(-1), ['entityModified', { id: 'p1', sessionAvatar: null }])
})

test('a server script: a value that is not an avatar url, or a player who has left, changes nothing', t => {
  t.mock.method(console, 'error', () => {})
  const { proxy, player, sent } = serverProxy()
  for (const bad of ['javascript:1', 'asset://x.glb', 'x'.repeat(600)]) proxy.setSessionAvatar(bad)
  assert.equal(player.data.sessionAvatar, null)
  assert.equal(player.scriptAvatar, undefined)
  assert.deepEqual(sent, [])
  player.destroyed = true
  proxy.setSessionAvatar(EVIL_VRM)
  assert.equal(player.data.sessionAvatar, null)
  assert.deepEqual(sent, [])
})

test('a server script: a change the network does not take is not made on the server either', () => {
  const { proxy, player, world } = serverProxy()
  world.network.send = () => false
  assert.equal(proxy.setSessionAvatar(EVIL_VRM), false)
  assert.equal(player.data.sessionAvatar, null)
  assert.equal(player.scriptAvatar, undefined)
})

test("a server script's effect: its emote is remembered for that player; one that is not an emote url is left out", () => {
  const { proxy, player, sent } = serverProxy()
  proxy.applyEffect({ emote: EVIL_GLB, duration: 2 })
  assert.deepEqual([...player.scriptEmotes], [EVIL_GLB])
  assert.deepEqual(sent.at(-1), ['entityModified', { id: 'p1', ef: { emote: EVIL_GLB, duration: 2 } }])
  proxy.applyEffect({ emote: 'not a url', freeze: true })
  assert.deepEqual([...player.scriptEmotes], [EVIL_GLB], 'nothing new remembered')
  assert.deepEqual(sent.at(-1), ['entityModified', { id: 'p1', ef: { freeze: true } }], 'sent without the emote')
  assert.equal(player.data.effect.emote, undefined)
})
