// Which avatar and emote urls a player can make every other client load (src/core/extras/entityModifyPolicy.js
// isExternalUrl and the rule in sanitizePlayerSelfModify; ServerNetwork onEntityModified and onConnection;
// createPlayerProxy on the server). A file of the world's own store: anyone. A url outside the world: a builder, or
// the very url a server script chose for that player.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SCRIPT_EMOTE_LIMIT,
  SESSION_AVATAR_REQUEST_MAX,
  isEmoteUrl,
  isExternalUrl,
  nextSessionAvatarRequest,
  rememberScriptEmote,
  sanitizePlayerSelfModify,
  sessionAvatarRequest,
} from '../src/core/extras/entityModifyPolicy.js'
import { hasRank, Ranks } from '../src/core/extras/ranks.js'
import { SCRIPT_BACKLOG_CAP, SCRIPT_TICK_CAP } from '../src/core/extras/writeLedger.js'
import * as gating from '../src/server/solana-gating.js'
import { fixture, nextId, sentTo } from './lib/joinFixture.mjs'
import { loadClient } from './lib/clientHarness.mjs'
import { bundleProbe } from './lib/workerProbe.mjs'

// the real PlayerLocal, bundled as the client build bundles it, as a player's own client
let PlayerLocal
let bundle
before(async () => {
  bundle = await bundleProbe(`export { PlayerLocal } from './src/core/entities/PlayerLocal'`)
  ;({ PlayerLocal } = await import(bundle.url))
})
after(() => bundle?.destroy())

const ASSETS = 'https://world.example/assets'
const me = 'socket-me'
const EVIL_VRM = 'https://evil.example/a.vrm'
const EVIL_GLB = 'https://evil.example/dance.glb'
// what a stored value may hold from before these rules (or from a hand edit): each loads from evil.example as every
// loader reads it (assetURL.js loaderReference, then resolveReference), though only the last is a url as written
const EVIL_SPELLINGS = [
  '//evil.example/a.vrm',
  'evil.example/a.vrm',
  ` ${EVIL_VRM}`,
  `\t${EVIL_VRM}\n`,
  'HTTPS://evil.example/a.vrm',
]
// the same spellings for a file of the world's own store: as every loader reads them, each is
// https://world.example/assets/mine.vrm, so each is the visitor's own (Codex: the protocol-relative and bare-host ones
// were classified as written, not as resolved, and a visitor who had stored one joined wearing the default)
const OWN_SPELLINGS = [
  '//world.example/assets/mine.vrm',
  'world.example/assets/mine.vrm',
  ` ${ASSETS}/mine.vrm`,
  `\t${ASSETS}/mine.vrm\n`,
  ' //world.example/assets/mine.vrm\n',
  '\tworld.example/assets/mine.vrm ',
]

test('isExternalUrl: an asset or a plain address of a store file is not; anything else that loads is', () => {
  for (const own of [
    'asset://avatar.vrm',
    'asset://emote-float.glb?s=1.5',
    `${ASSETS}/avatar.vrm`,
    `${ASSETS}/0123abcd.glb`,
    // the loaders take the white space off first, and resolve what is left
    ...OWN_SPELLINGS,
    ' asset://avatar.vrm ',
    null,
    undefined,
    '',
    7,
  ]) {
    assert.equal(isExternalUrl(own, ASSETS), false, String(own))
  }
  // read as the loaders read them: another host, or wherever the page is served from
  for (const other of [...EVIL_SPELLINGS, '/assets/avatar.vrm', 'blob:https://world.example/1234', 'avatar.vrm']) {
    assert.equal(isExternalUrl(other, ASSETS), true, other)
  }
  // A page path is left for the browser to resolve against the page. It lands in the store only when the page is
  // served from the assets url's origin and path, which the server cannot know (a proxy, a CDN or another path can
  // be in between), so it is outside whatever the assets url is, the page's own origin included.
  for (const assetsUrl of [ASSETS, 'https://cdn.example/assets', 'https://world.example/w/assets']) {
    assert.equal(isExternalUrl('/assets/mine.vrm', assetsUrl), true, assetsUrl)
  }
  // resolved to another place than the store: outside, whatever the spelling
  for (const near of [
    '//world.example/other/mine.vrm',
    '//world.example:8443/assets/mine.vrm',
    'world.example.evil.example/assets/mine.vrm',
    '//world.example/assets/../mine.vrm',
    'world.example/assets/sub/../../mine.vrm',
    'world.example/assets/%2e%2e/mine.vrm',
    'world.example/assets\\..\\mine.vrm',
    'world.example/assetsx/mine.vrm',
    'world.example/assets',
    'world.example/assets/',
    '//user@world.example/assets/mine.vrm',
    'https://user:pw@world.example/assets/mine.vrm',
    'https://world.example@evil.example/assets/mine.vrm',
    'https://evil.example/assets/mine.vrm#https://world.example/assets/mine.vrm',
    'https://evil.example/?https://world.example/assets/mine.vrm',
  ]) {
    assert.equal(isExternalUrl(near, ASSETS), true, near)
  }
  // a request that goes to the store, however its address is written: a client's loader leaves a query and a
  // fragment off a store address, and the URL parser folds dot segments and letter case before anything is asked.
  // (Codex: `…/assets/avatar.vrm?v=1` was taken for outside, and its visitor joined wearing the default.)
  for (const own of [
    `${ASSETS}/mine.vrm?v=1`,
    `${ASSETS}/mine.vrm#top`,
    'world.example/assets/mine.vrm?x=1',
    `${ASSETS}/sub/../mine.vrm`,
    `${ASSETS}/./mine.vrm`,
    'world.example/assets/sub/mine.vrm',
    'HTTPS://WORLD.example/assets/mine.vrm',
    'https://world.example:443/assets/mine.vrm',
  ]) {
    assert.equal(isExternalUrl(own, ASSETS), false, own)
  }
  // with an http assets url, `//host/…` and `host/…` load over https: another origin
  assert.equal(isExternalUrl('//world.example/assets/mine.vrm', 'http://world.example/assets'), true)
  assert.equal(isExternalUrl('http://world.example/assets/mine.vrm', 'http://world.example/assets'), false)
  // an asset is the store's whatever the assets url is
  assert.equal(isExternalUrl('asset://avatar.vrm', undefined), false)
  assert.equal(isExternalUrl(' asset://avatar.vrm\n', undefined), false)
  assert.equal(isExternalUrl('asset://emote-float.glb?s=1.5', undefined), false)
  for (const other of [
    EVIL_VRM,
    'http://world.example/assets/avatar.vrm', // another scheme is another origin
    'https://world.example:8443/assets/avatar.vrm',
    'https://world.example/assets/../secret/a.vrm',
    'https://user:pw@world.example/assets/avatar.vrm',
    'https://world.example.evil.example/assets/avatar.vrm',
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

// a token-gated world (solana-gating.js): a verified wallet can be a builder for the session
const tokenGating = { ...gating, TOKEN_GATING_ENABLED: true }

// The real ServerNetwork handlers, with players that joined through the real onConnection. The fixture's player
// stands in for the server's PlayerRemote: as there, the emote it plays is kept as `data.emote`, and it is a builder
// by its own rank or by the world's, whichever is higher (playerRanks.js isBuilder).
async function world({ customAvatars = false, rank = null } = {}) {
  const f = fixture({ env: { ASSETS_BASE_URL: ASSETS, ADMIN_CODE: 'code' }, context: { solanaGating: tokenGating } })
  f.world.settings.setHasAdminCode(true)
  f.world.settings.customAvatars = customAvatars
  f.world.settings.rank = rank
  const connect = async ({ rank = Ranks.VISITOR, avatar, stored } = {}) => {
    const id = nextId()
    f.users.set(id, { id, name: id, rank, avatar: stored ?? null })
    const joined = await f.join({ authToken: id, ...(avatar === undefined ? {} : { avatar }) })
    const socket = f.network.sockets.get(id)
    socket.ws.packets.length = 0
    const player = f.world.entities.get(id)
    player.isBuilder = () => hasRank(Math.max(player.data.rank, f.world.settings.effectiveRank), Ranks.BUILDER)
    player.modify = function (change) {
      const { e, ...rest } = change
      Object.assign(this.data, rest)
      if ('e' in change) this.data.emote = isEmoteUrl(e) ? e : null
    }
    player.setEffect = function (effect) {
      this.data.effect = effect
    }
    return { id, socket, snapshot: joined.snapshot, player }
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
  // each sender is told the session avatar the server took, and nothing else of its own change
  for (const [who, value] of [
    [visitor, 'asset://avatar.vrm'],
    [builder, EVIL_VRM],
  ]) {
    const own = w.received(who).filter(([name, data]) => name === 'onEntityModified' && data.id === who.id)
    assert.deepEqual(own, [['onEntityModified', { id: who.id, sessionAvatar: value }]])
  }
})

// A server script's handle on a player of a handler-level world (createPlayerProxy on the real network)
function scriptProxy(player) {
  const createPlayerProxy = loadClient('core/extras/createPlayerProxy.js', 'createPlayerProxy')
  return createPlayerProxy({ data: { id: 'app' }, deadHook: { dead: false } }, player)
}

// What a client ends on for `subject`'s session avatar: `start` (for the subject's own client, the value it set
// itself last, since it shows each value as it sends it), then each value the server told it, in the order told
function endsOn(w, client, subject, start) {
  let value = start
  for (const [name, data] of w.received(client)) {
    if (name === 'onEntityModified' && data.id === subject.id && 'sessionAvatar' in data) value = data.sessionAvatar
  }
  return value
}

test('crossing packets: the sender ends on the session avatar the server ends on, as everyone else does', async () => {
  // (a) a visitor's client sets an avatar outside the world (refused), then an asset, before the answer to the
  // first comes back
  {
    const w = await world()
    const visitor = await w.connect()
    const watcher = await w.connect()
    w.modify(visitor, { sessionAvatar: EVIL_VRM })
    w.modify(visitor, { sessionAvatar: 'asset://avatar.vrm' })
    assert.equal(visitor.player.data.sessionAvatar, 'asset://avatar.vrm', 'the server')
    assert.equal(endsOn(w, visitor, visitor, 'asset://avatar.vrm'), 'asset://avatar.vrm', 'the visitor')
    assert.equal(endsOn(w, watcher, visitor, null), 'asset://avatar.vrm', 'everyone else')
  }
  // (b) the owner's own change is on its way when a server script chooses another avatar for the player: the
  // script's choice reaches everyone, the owner included, then the server takes the owner's change
  {
    const w = await world()
    const owner = await w.connect()
    const watcher = await w.connect()
    scriptProxy(owner.player).setSessionAvatar(EVIL_VRM)
    w.modify(owner, { sessionAvatar: 'asset://mine.vrm' })
    assert.equal(owner.player.data.sessionAvatar, 'asset://mine.vrm', 'the server')
    assert.equal(endsOn(w, owner, owner, 'asset://mine.vrm'), 'asset://mine.vrm', 'the owner')
    assert.equal(endsOn(w, watcher, owner, null), 'asset://mine.vrm', 'everyone else')
  }
})

// The player's own client, the real PlayerLocal, on a handler-level world. Its updates reach the server when the test
// says, oldest first as on its connection (`send(n)` sends the n oldest, `lose()` drops the oldest unsent), and what
// the server told it reaches it when the test says (`deliver`). `started` lists the avatar loads it begins, in order;
// `finish(url)` ends the latest load of that url; `installed` is the url of the avatar it shows.
async function ownClient(w, who) {
  const outbox = []
  const pending = {}
  const started = []
  const p = Object.create(PlayerLocal.prototype)
  Object.assign(p, {
    data: { id: who.id, avatar: 'asset://avatar.vrm', sessionAvatar: null },
    world: {
      loader: {
        load: (_type, url) =>
          new Promise(resolve => {
            started.push(url)
            pending[url] = () => resolve({ toNodes: () => ({ get: () => avatarNode(url) }) })
          }),
      },
      network: { send: (name, data) => outbox.push([name, data]) },
      emit() {},
    },
    base: {
      children: [],
      // a node added is mounted at once, as an Avatar from the loader's toNodes() is (it carries its factory)
      add(node) {
        node.parent = this
        this.children.push(node)
        node.instance = { headToHeight: 1.6, height: 1.8 }
        p.installed = node.url
      },
      remove(node) {
        const index = this.children.indexOf(node)
        if (index === -1) return
        node.deactivate()
        node.parent = null
        this.children.splice(index, 1)
      },
    },
    nametag: { position: {}, active: false },
    bubble: { position: {}, active: false },
  })
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const client = {
    p,
    started,
    outbox,
    finish: async url => (pending[url](), await tick()),
    send: (count = outbox.length) => {
      for (const [name, data] of outbox.splice(0, count)) w.f.send(name, data, who.socket)
    },
    lose: () => outbox.shift(),
    deliver: () => {
      for (const [name, data] of w.received(who)) if (name === 'onEntityModified' && data.id === who.id) p.modify(data)
    },
  }
  // it shows the world's avatar to begin with
  p.applyAvatar()
  await client.finish('asset://avatar.vrm')
  started.length = 0
  return client
}

function avatarNode(url) {
  return {
    url,
    visible: true,
    instance: null,
    deactivate() {
      this.instance = null
    },
    getHeadToHeight() {
      return this.instance?.headToHeight || null
    },
    disableRateCheck() {},
    get height() {
      return this.instance?.height || null
    },
  }
}

const A = 'asset://a.vrm'
const B = 'asset://b.vrm'

// Codex: the answer to an earlier update of the owner's arrived after the owner had chosen again, put the older
// avatar back (a new load, and it could be installed for a moment), and the answer to the newer one then put the
// newer one back: four loads for two choices. The client numbers its updates and passes over an answer that is not
// to its latest one.
test("the owner's client: the answer to an older choice does not undo a newer one in flight", async () => {
  const w = await world()
  const owner = await w.connect()
  const watcher = await w.connect()
  const c = await ownClient(w, owner)
  c.p.setSessionAvatar(A)
  c.p.setSessionAvatar(B)
  // the server takes A and answers it while B is still on its way
  c.send(1)
  c.deliver()
  assert.equal(c.p.data.sessionAvatar, B, 'the newer choice stays')
  assert.deepEqual(c.started, [A, B], 'no load for the answer to A')
  c.send()
  c.deliver()
  assert.equal(c.p.data.sessionAvatar, B)
  assert.deepEqual(c.started, [A, B], 'one load for each choice')
  // A's load ends after B was chosen: it is stale and never shown
  await c.finish(A)
  assert.equal(c.p.installed, 'asset://avatar.vrm')
  await c.finish(B)
  assert.equal(c.p.installed, B)
  assert.equal(owner.player.data.sessionAvatar, B, 'the server')
  assert.equal(endsOn(w, watcher, owner, null), B, 'everyone else')
})

test("the owner's client: a refused value, then a valid one before the answer, shows nothing in between", async () => {
  const w = await world()
  const visitor = await w.connect()
  const watcher = await w.connect()
  const c = await ownClient(w, visitor)
  c.p.setSessionAvatar(EVIL_VRM)
  c.p.setSessionAvatar(A)
  c.send(1)
  c.deliver()
  // the answer to the refused value (the session avatar the server has: none) is passed over: A is on its way
  assert.equal(c.p.data.sessionAvatar, A)
  assert.deepEqual(c.started, [EVIL_VRM, A], "the visitor's own two choices, and not the world's avatar again")
  c.send()
  c.deliver()
  assert.deepEqual(c.started, [EVIL_VRM, A])
  await c.finish(A)
  assert.equal(c.p.installed, A)
  assert.equal(visitor.player.data.sessionAvatar, A, 'the server')
  assert.equal(endsOn(w, watcher, visitor, null), A, 'everyone else')
  // the other way round: the answer to the valid one is passed over, and the answer to the refused one, the latest
  // update, puts the visitor back on the valid one, which the server has
  c.p.setSessionAvatar(B)
  c.p.setSessionAvatar(EVIL_VRM)
  c.send()
  c.deliver()
  assert.deepEqual(c.started.slice(2), [B, EVIL_VRM, B])
  assert.equal(c.p.data.sessionAvatar, B)
  assert.equal(visitor.player.data.sessionAvatar, B)
  assert.equal(endsOn(w, watcher, visitor, A), B, 'everyone else')
})

test("the owner's client: a server script's choice crossing the owner's own ends where the server ends", async () => {
  // the script's choice reaches the owner first, then the server takes the owner's: everyone ends on the owner's
  {
    const w = await world()
    const owner = await w.connect()
    const watcher = await w.connect()
    const c = await ownClient(w, owner)
    c.p.setSessionAvatar(A)
    scriptProxy(owner.player).setSessionAvatar(EVIL_VRM)
    c.send()
    c.deliver()
    assert.deepEqual(c.started, [A, EVIL_VRM, A], "the script's choice, which everyone saw, then the owner's again")
    assert.equal(c.p.data.sessionAvatar, A)
    assert.equal(owner.player.data.sessionAvatar, A, 'the server')
    assert.equal(endsOn(w, watcher, owner, null), A, 'everyone else')
  }
  // the server takes the owner's, then the script chooses: everyone ends on the script's
  {
    const w = await world()
    const owner = await w.connect()
    const watcher = await w.connect()
    const c = await ownClient(w, owner)
    c.p.setSessionAvatar(A)
    c.send()
    scriptProxy(owner.player).setSessionAvatar(EVIL_VRM)
    c.deliver()
    assert.deepEqual(c.started, [A, EVIL_VRM])
    assert.equal(c.p.data.sessionAvatar, EVIL_VRM)
    assert.equal(owner.player.data.sessionAvatar, EVIL_VRM, 'the server')
    assert.equal(endsOn(w, watcher, owner, null), EVIL_VRM, 'everyone else')
  }
  // two choices of the owner's with the script's between them on the server: the answer to the first is passed
  // over, the script's choice is shown, and the answer to the second ends it
  {
    const w = await world()
    const owner = await w.connect()
    const watcher = await w.connect()
    const c = await ownClient(w, owner)
    c.p.setSessionAvatar(A)
    c.p.setSessionAvatar(B)
    c.send(1)
    scriptProxy(owner.player).setSessionAvatar(EVIL_VRM)
    c.send()
    c.deliver()
    assert.deepEqual(c.started, [A, B, EVIL_VRM, B])
    assert.equal(c.p.data.sessionAvatar, B)
    assert.equal(owner.player.data.sessionAvatar, B, 'the server')
    assert.equal(endsOn(w, watcher, owner, null), B, 'everyone else')
  }
})

// An update that never reaches the server (the inbound gate dropped it) gets no answer, and the answers to the ones
// before it are passed over: the owner stays on its own latest choice, as it did before the server answered at all.
test("the owner's client: when its latest update is lost, it stays on its own choice", async () => {
  const w = await world()
  const owner = await w.connect()
  const c = await ownClient(w, owner)
  c.p.setSessionAvatar(A)
  c.p.setSessionAvatar(B)
  c.send(1)
  c.lose()
  c.deliver()
  assert.equal(c.p.data.sessionAvatar, B)
  assert.deepEqual(c.started, [A, B])
  assert.equal(owner.player.data.sessionAvatar, A, 'the server has the last one it got')
})

test('the number of a session avatar update comes back to its sender alone, and is kept nowhere', async () => {
  const w = await world()
  const visitor = await w.connect()
  const watcher = await w.connect()
  const answers = () =>
    w
      .received(visitor)
      .filter(([name, data]) => name === 'onEntityModified' && data.id === visitor.id)
      .map(([, data]) => data)
  const relayed = () => w.received(watcher).filter(([name]) => name === 'onEntityModified')
  // taken: relayed without the number; the answer carries it
  w.modify(visitor, { sessionAvatar: A, sessionAvatarRequest: 7 })
  assert.deepEqual(answers(), [{ id: visitor.id, sessionAvatar: A, sessionAvatarRequest: 7 }])
  assert.deepEqual(relayed(), [['onEntityModified', { id: visitor.id, sessionAvatar: A }]])
  // refused: nothing relayed; the answer carries the number with the value the server has
  w.modify(visitor, { sessionAvatar: EVIL_VRM, sessionAvatarRequest: 8 })
  assert.deepEqual(answers(), [{ id: visitor.id, sessionAvatar: A, sessionAvatarRequest: 8 }])
  assert.deepEqual(relayed(), [])
  // the bounds are numbers; anything else is no number, and the answer carries none
  for (const request of [0, SESSION_AVATAR_REQUEST_MAX]) {
    w.modify(visitor, { sessionAvatar: A, sessionAvatarRequest: request })
    assert.deepEqual(answers(), [{ id: visitor.id, sessionAvatar: A, sessionAvatarRequest: request }])
  }
  for (const request of [-1, 1.5, '9', SESSION_AVATAR_REQUEST_MAX + 1, 2 ** 53, NaN, Infinity, null, true, [1], {}]) {
    w.modify(visitor, { sessionAvatar: A, sessionAvatarRequest: request })
    assert.deepEqual(answers(), [{ id: visitor.id, sessionAvatar: A }], String(request))
  }
  relayed()
  // a number alone is not a change, and one beside another field is not relayed with it; only an update that names
  // a session avatar is answered
  w.modify(visitor, { sessionAvatarRequest: 9 })
  w.modify(visitor, { p: [1, 2, 3], sessionAvatarRequest: 10 })
  assert.deepEqual(answers(), [])
  assert.deepEqual(relayed(), [['onEntityModified', { id: visitor.id, p: [1, 2, 3] }]])
  assert.equal(w.f.logs.filter(line => /no permitted fields/.test(line)).length, 1)
  // the server's player, and a later joiner's snapshot, have no number
  assert.equal(Object.hasOwn(visitor.player.data, 'sessionAvatarRequest'), false)
  const late = await w.connect()
  assert.equal(JSON.stringify(late.snapshot).includes('sessionAvatarRequest'), false)
})

test("the number: the policy leaves it out of the player's fields; the client counts from 1 and starts again", () => {
  assert.equal(sanitizePlayerSelfModify({ id: me, sessionAvatarRequest: 3 }, me), null)
  assert.deepEqual(sanitizePlayerSelfModify({ id: me, sessionAvatar: A, sessionAvatarRequest: 3 }, me), {
    id: me,
    sessionAvatar: A,
  })
  assert.equal(sessionAvatarRequest({ sessionAvatarRequest: 3 }), 3)
  assert.equal(sessionAvatarRequest({}), undefined)
  assert.equal(sessionAvatarRequest(null), undefined)
  let reads = 0
  const data = {
    get sessionAvatarRequest() {
      return reads++ ? 'x' : 4
    },
  }
  assert.equal(sessionAvatarRequest(data), 4)
  assert.equal(reads, 1, 'read once')
  assert.equal(nextSessionAvatarRequest(undefined), 1)
  assert.equal(nextSessionAvatarRequest(1), 2)
  assert.equal(nextSessionAvatarRequest(SESSION_AVATAR_REQUEST_MAX - 1), SESSION_AVATAR_REQUEST_MAX)
  assert.equal(nextSessionAvatarRequest(SESSION_AVATAR_REQUEST_MAX), 1)
  for (const junk of [0, -1, 1.5, NaN, '2', null]) assert.equal(nextSessionAvatarRequest(junk), 1, String(junk))
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

test('joining: a stored avatar is read as the loaders read it, whatever its spelling', async () => {
  const w = await world({ customAvatars: true })
  const watcher = await w.connect()
  for (const stored of EVIL_SPELLINGS) {
    const visitor = await w.connect({ stored })
    assert.equal(visitor.player.data.avatar, 'asset://avatar.vrm', JSON.stringify(stored))
    assert.equal(JSON.stringify(visitor.snapshot).includes('evil.example'), false, 'not in the snapshot')
    assert.equal(JSON.stringify(w.received(watcher)).includes('evil.example'), false, 'not in entityAdded')
    assert.equal(w.f.users.get(visitor.id).avatar, stored, 'the stored value is left alone')
  }
  // a file of the store, in any of the spellings the loaders resolve to it, is the visitor's own
  for (const stored of OWN_SPELLINGS) {
    const own = await w.connect({ stored })
    assert.equal(own.player.data.avatar, stored, JSON.stringify(stored))
  }
})

// the ways a player stops being a builder; `make` makes the joined player one, `lower` ends it
const demotions = {
  'an admin lowers the rank': {
    rank: Ranks.BUILDER,
    lower: (w, who) => w.f.network.onModifyRank(w.f.builder, { playerId: who.id, rank: Ranks.VISITOR }),
  },
  '/admin again': {
    rank: Ranks.ADMIN,
    lower: (w, who) => w.f.network.onCommand(who.socket, { args: ['admin', 'code'] }),
  },
  'the token grant ends': {
    make: who => {
      who.player.data.rank = Ranks.BUILDER
      who.player.tokenGrantedRank = true
    },
    lower: (w, who) => w.f.network.onRevokeBuilderByToken(who.socket, {}),
  },
  "the world's rank setting is lowered": {
    worldRank: Ranks.BUILDER,
    lower: w => w.f.send('settingsModified', { key: 'rank', value: Ranks.VISITOR }),
  },
}

for (const [way, { rank = Ranks.VISITOR, worldRank = null, make, lower }] of Object.entries(demotions)) {
  test(`a builder who stops being one (${way}) keeps nothing outside the world that a script did not choose`, async () => {
    const w = await world({ rank: worldRank })
    const watcher = await w.connect()
    const who = await w.connect({ rank, stored: EVIL_VRM })
    make?.(who)
    assert.equal(who.player.isBuilder(), true)
    // (a token's grant comes after the join, so the stored avatar is set again here, as a builder may)
    w.modify(who, { sessionAvatar: EVIL_VRM, e: EVIL_GLB, avatar: EVIL_VRM })
    assert.equal(who.player.data.sessionAvatar, EVIL_VRM)
    assert.equal(who.player.data.emote, EVIL_GLB)
    assert.equal(who.player.data.avatar, EVIL_VRM)
    w.received(watcher)
    w.received(who)
    await lower(w, who)
    assert.equal(who.player.isBuilder(), false)
    // the server's player, and what everyone (the player too) is told, as one change
    assert.equal(who.player.data.sessionAvatar, null)
    assert.equal(who.player.data.emote, null)
    assert.equal(who.player.data.avatar, 'asset://avatar.vrm', "the world's default")
    const told = { id: who.id, sessionAvatar: null, e: null, avatar: 'asset://avatar.vrm' }
    for (const client of [watcher, who]) {
      const changes = w
        .received(client)
        .filter(([name, data]) => name === 'onEntityModified' && data.id === who.id && !('rank' in data))
      assert.deepEqual(changes, [['onEntityModified', told]])
    }
    assert.equal(w.f.users.get(who.id).avatar, EVIL_VRM, 'the stored value is left alone')
    const late = await w.connect()
    assert.equal(JSON.stringify(late.snapshot).includes('evil.example'), false, "a later joiner's snapshot")
  })
}

test('a builder who stops being one keeps a stored avatar of the store, whatever its spelling', async () => {
  const w = await world()
  for (const stored of OWN_SPELLINGS) {
    const who = await w.connect({ rank: Ranks.BUILDER, stored })
    await w.f.network.onModifyRank(w.f.builder, { playerId: who.id, rank: Ranks.VISITOR })
    assert.equal(who.player.isBuilder(), false)
    assert.equal(who.player.data.avatar, stored, JSON.stringify(stored))
  }
})

test('a builder who stops being one keeps what a server script chose; a builder who stays one keeps everything', async () => {
  const w = await world()
  const watcher = await w.connect()
  const who = await w.connect({ rank: Ranks.BUILDER })
  const stays = await w.connect({ rank: Ranks.ADMIN })
  const script = scriptProxy(who.player)
  script.setSessionAvatar(EVIL_VRM)
  script.applyEffect({ emote: EVIL_GLB, duration: 5 })
  w.modify(who, { e: EVIL_GLB })
  w.modify(stays, { sessionAvatar: EVIL_VRM, e: EVIL_GLB })
  w.received(watcher)
  await w.f.network.onModifyRank(w.f.builder, { playerId: who.id, rank: Ranks.VISITOR })
  await w.f.network.onModifyRank(w.f.builder, { playerId: stays.id, rank: Ranks.BUILDER })
  assert.equal(who.player.data.sessionAvatar, EVIL_VRM)
  assert.equal(who.player.data.emote, EVIL_GLB)
  assert.equal(stays.player.data.sessionAvatar, EVIL_VRM)
  assert.equal(stays.player.data.emote, EVIL_GLB)
  const changes = w.received(watcher).filter(([name, data]) => name === 'onEntityModified' && !('rank' in data))
  assert.deepEqual(changes, [], 'nothing to tell')
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
      broadcast: (name, data) => (sent.push([name, data]), 'delivered'),
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
  world.network.broadcast = () => 'refused'
  assert.equal(proxy.setSessionAvatar(EVIL_VRM), false)
  assert.equal(player.data.sessionAvatar, null)
  assert.equal(player.scriptAvatar, undefined)
})

test('a server script: a change some clients did not get is still made; one nobody got is not', async () => {
  const w = await world()
  const visitor = await w.connect()
  const healthy = await w.connect()
  const full = await w.connect()
  const told = client =>
    w.received(client).filter(([name, data]) => name === 'onEntityModified' && data.id === visitor.id)
  // a client at its backlog limit for script writes: the others get the change, it does not
  w.f.network.writer.state(full.socket.ws).queued = SCRIPT_BACKLOG_CAP
  assert.equal(scriptProxy(visitor.player).setSessionAvatar(EVIL_VRM), false, 'the script is told not all got it')
  assert.equal(visitor.player.data.sessionAvatar, EVIL_VRM, "the server's player has what the others have")
  assert.equal(visitor.player.scriptAvatar, EVIL_VRM)
  assert.deepEqual(told(healthy), [['onEntityModified', { id: visitor.id, sessionAvatar: EVIL_VRM }]])
  assert.deepEqual(told(full), [])
  const late = await w.connect()
  assert.equal(late.snapshot.entities.find(entity => entity.id === visitor.id).sessionAvatar, EVIL_VRM)
  // this tick's budget for script writes used up: the packet is not admitted, so nothing changes anywhere
  w.f.network.writer.state(full.socket.ws).queued = 0
  w.f.network.writer.resetTick()
  assert.ok(w.f.network.writer.prepare(new Uint8Array(SCRIPT_TICK_CAP), { script: true }))
  assert.equal(scriptProxy(visitor.player).setSessionAvatar(null), false)
  assert.equal(visitor.player.data.sessionAvatar, EVIL_VRM)
  assert.equal(visitor.player.scriptAvatar, EVIL_VRM)
  assert.deepEqual(told(healthy), [])
  assert.deepEqual(told(full), [])
})

test('ServerNetwork broadcast tells a packet nobody got from one some did not get; send is true only when all did', async () => {
  const w = await world()
  const healthy = await w.connect()
  const closing = await w.connect()
  const got = client => w.received(client).filter(([name]) => name === 'onChatAdded').length
  assert.equal(w.f.network.broadcast('chatAdded', { body: 'a' }), 'delivered')
  assert.equal(w.f.network.send('chatAdded', { body: 'b' }), true)
  assert.deepEqual([got(healthy), got(closing)], [2, 2])
  closing.socket.ws.readyState = 2
  assert.equal(w.f.network.broadcast('chatAdded', { body: 'c' }), 'partial')
  assert.equal(w.f.network.send('chatAdded', { body: 'd' }), false)
  assert.deepEqual([got(healthy), got(closing)], [2, 0])
  closing.socket.ws.readyState = 1
  w.f.network.writer.resetTick()
  w.f.network.writer.prepare(new Uint8Array(SCRIPT_TICK_CAP), { script: true })
  // a script's packet over this tick's budget
  let result
  w.f.network.asScript(() => (result = w.f.network.broadcast('chatAdded', { body: 'e' })), { id: 'app' }, 'probe')
  assert.equal(result, 'refused')
  assert.deepEqual([got(healthy), got(closing)], [0, 0])
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
