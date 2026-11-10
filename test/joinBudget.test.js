import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import moment from 'moment'
import { readPacket, writeClientPacket, writePacket } from '../src/core/packets.js'
import { SNAPSHOT_CAP } from '../src/core/extras/writeLedger.js'
import {
  SNAPSHOT_STEPS,
  WORLD_JOIN_BYTES,
  encodeSnapshot,
  joinStateBytes,
  stateBytes,
} from '../src/core/extras/joinBudget.js'
import { isAvatarUrl, sanitizeName } from '../src/core/extras/entityModifyPolicy.js'
import { WORLD_BLUEPRINT_BYTES } from '../src/core/extras/blueprintPolicy.js'
import { Blueprints, loadClient } from './lib/clientHarness.mjs'
import { load, Settings } from './lib/persistenceHarness.mjs'
import { connectionMethod, fakeWs, makeNetwork, Socket } from './lib/networkHarness.mjs'

// Real accounting throughout: the real Entities, Blueprints, Settings and network handlers; only the app and player
// entities themselves are stand-ins (no scripts, no physics)
class FakeApp {
  constructor(world, data) {
    this.world = world
    this.data = data
    this.isApp = true
    this.builds = 0
  }
  modify(change) {
    Object.assign(this.data, change)
  }
  build() {
    this.builds++
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.world.entities.remove(this.data.id)
  }
  serialize() {
    return this.data
  }
}
class FakePlayer extends FakeApp {
  constructor(world, data) {
    super(world, data)
    this.isApp = false
    this.isPlayer = true
  }
  isBuilder() {
    return this.data.rank >= 1
  }
  isAdmin() {
    return this.data.rank >= 2
  }
}
const Entities = load('core/systems/Entities.js', 'Entities', {
  App: FakeApp,
  PlayerLocal: FakePlayer,
  PlayerRemote: FakePlayer,
})

const F3 = () => [Math.random() * 10, 1.25, -3.5]
const app = (id, blueprint = 'bp', extra = {}) => ({
  id,
  type: 'app',
  blueprint,
  position: F3(),
  quaternion: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)],
  scale: [1.5, 1.5, 1.5],
  mover: null,
  uploader: null,
  pinned: false,
  state: {},
  ...extra,
})
// ids of the shape uuid() makes (10 of [0-9a-zA-Z]), unique per test
let counter = 0
const nextId = () => `id${String(++counter).padStart(8, '0')}`

function fixture() {
  const logs = []
  const network = makeNetwork(line => logs.push(line))
  const world = network.world
  world.network = network
  world.entities = new Entities(world)
  world.blueprints = new Blueprints(world)
  world.settings = new Settings(world)
  world.collections = { serialize: () => [] }
  world.chat = { msgs: [], serialize: () => world.chat.msgs }
  world.ai = { serialize: () => ({ enabled: false }) }
  world.livekit = { state: null, serialize: async () => world.livekit.state, clearModifiers() {} }
  world.events = { emit() {} }
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  network.settingsBytes = writePacket('settingsModified', world.settings.serialize()).length
  network.collectionsBytes = writePacket('settingsModified', []).length
  const users = new Map()
  network.db = table => {
    assert.equal(table, 'users')
    return {
      where: (key, id) => ({ first: async () => users.get(id) }),
      insert: async row => users.set(row.id, row),
    }
  }
  network.onConnection = connectionMethod({
    isNumber: value => typeof value === 'number',
    sanitizeName,
    isAvatarUrl,
    moment,
    performance,
    HEALTH_MAX: 100,
    readJWT: async token => (token ? { userId: token } : null),
    createJWT: async ({ userId }) => userId,
    uuid: nextId,
    process: { env: {} },
  })
  // a builder connection that sends packets (its player is not in the world)
  const builder = new Socket({
    id: 'builder',
    ws: fakeWs(),
    network,
    player: { isBuilder: () => true, isAdmin: () => true, data: { rank: 2 } },
  })
  const send = (name, data, socket = builder) => {
    socket.ws.emit('message', writeClientPacket(name, data))
    network.flush()
  }
  const join = async (params = {}) => {
    const ws = fakeWs()
    ws.closeCodes = []
    ws.close = code => {
      ws.closeCodes.push(code)
      ws.readyState = 3
    }
    await network.onConnection(ws, params)
    ws.drain()
    const [method, snapshot] = ws.packets.length ? readPacket(ws.packets[0]) : []
    return { ws, method, snapshot, bytes: ws.packets[0]?.length }
  }
  world.blueprints.add({ id: 'bp', version: 0, name: 'Box' })
  return { logs, network, world, builder, send, join, users }
}

const sentTo = socket => socket.ws.packets.map(readPacket)
const apps = world => [...world.entities.items.values()].filter(entity => entity.isApp)

test('join budget: 36 apps with 30,000-character ids are refused, and a new client still joins', async () => {
  const f = fixture()
  const ids = Array.from({ length: 36 }, (_, i) => 'x'.repeat(30000) + i)
  // what the reproduction did without the id rule: those records alone are over the snapshot cap
  assert.ok(writePacket('snapshot', { entities: ids.map(id => app(id)) }).length > SNAPSHOT_CAP)
  for (const id of ids) f.network.onEntityAdded(f.builder, app(id))
  assert.equal(apps(f.world).length, 0)
  assert.equal(f.network.dirtyApps.size, 0)
  assert.equal(f.logs.filter(line => line.startsWith('onEntityAdded: invalid entity')).length, 1)
  const joined = await f.join()
  assert.equal(joined.method, 'onSnapshot')
  assert.ok(joined.bytes < 10000)
})

test('join budget: about 9,200 plain apps are refused before the snapshot is over its cap, and a new client joins', async () => {
  const f = fixture()
  const count = 9200
  const datas = Array.from({ length: count }, () => app(nextId()))
  // the LARP-04 reproduction (7,275 apps of 144 bytes): these, with float transforms and a short blueprint id,
  // encode at 116 bytes each, so it takes 9,200 of them with nothing refused to be over the cap
  assert.ok(writePacket('snapshot', { entities: datas }).length > SNAPSHOT_CAP)
  for (const data of datas) {
    f.network.onEntityAdded(f.builder, data)
    f.builder.ws.drain() // the sender reads its reverts
  }
  const accepted = apps(f.world).length
  assert.ok(accepted > 3000 && accepted < count, `${accepted} accepted`)
  assert.ok(joinStateBytes(f.world) <= WORLD_JOIN_BYTES)
  assert.equal(
    f.world.entities.appBytes,
    [...f.world.entities.appSizes.values()].reduce((s, v) => s + v.record + v.state, 0)
  )
  // the refused ones were taken back from the sender, and the refusal was logged once
  const removed = sentTo(f.builder).filter(([method]) => method === 'onEntityRemoved')
  assert.equal(removed.length, count - accepted)
  assert.deepEqual(
    f.logs.filter(line => line.includes('world is full')),
    ['onEntityAdded: world is full (join-state budget exceeded)']
  )
  assert.equal(f.network.dirtyApps.size, accepted)
  const joined = await f.join()
  assert.equal(joined.method, 'onSnapshot')
  assert.ok(joined.bytes <= SNAPSHOT_CAP)
  assert.equal(joined.snapshot.entities.filter(entity => entity.type === 'app').length, accepted)
  assert.ok(!f.logs.some(line => line.includes('did not fit')), 'nothing was dropped from it')
  // moving an app of a full world still works: its measured size does not change
  const moved = apps(f.world)[0].data.id
  f.network.onEntityModified(f.builder, { id: moved, mover: 'builder', position: [1e5 + 0.5, 2, 3] })
  f.network.onEntityModified(f.builder, { id: moved, mover: null, position: [0.123, 0.456, 0.789] })
  assert.deepEqual(f.world.entities.get(moved).data.position, [0.123, 0.456, 0.789])
  // removing one frees exactly its bytes, and then one more fits
  const before = f.world.entities.appBytes
  const size = f.world.entities.appSizes.get(moved)
  f.send('entityRemoved', moved)
  assert.equal(f.world.entities.get(moved), undefined)
  assert.equal(f.world.entities.appBytes, before - size.record - size.state)
  assert.equal(f.network.dirtyApps.get(moved).record, null)
  f.network.onEntityAdded(f.builder, app(nextId()))
  assert.equal(apps(f.world).length, accepted)
})

test('join budget: a client-set app state counts, a larger one is refused at the limit, and the record stays exact', () => {
  const f = fixture()
  const state = { notes: 'n'.repeat(8000) }
  for (let i = 0; i < 40; i++) f.network.onEntityAdded(f.builder, app(`s${i}`, 'bp', { state }))
  assert.equal(f.world.entities.appSizes.get('s0').state, stateBytes(state))
  for (let i = 0; f.world.entities.canFitApp(`f${i}`, app(`f${i}`)); i++)
    f.network.onEntityAdded(f.builder, app(`f${i}`))
  const full = joinStateBytes(f.world)
  assert.ok(full <= WORLD_JOIN_BYTES && full > WORLD_JOIN_BYTES - 300)
  // a state change that grows a full world is refused and the sender gets the stored fields back
  f.builder.ws.packets.length = 0
  f.network.onEntityModified(f.builder, { id: 'f0', state: { notes: 'n'.repeat(1000) }, pinned: true })
  assert.equal(f.world.entities.get('f0').data.pinned, false)
  assert.deepEqual(f.world.entities.get('f0').data.state, {})
  assert.deepEqual(sentTo(f.builder), [['onEntityModified', { id: 'f0', pinned: false }]])
  assert.ok(f.logs.includes('onEntityModified: world is full (join-state budget exceeded)'))
  assert.equal(joinStateBytes(f.world), full)
  // a smaller one is taken, and the tracked size follows it
  f.network.onEntityModified(f.builder, { id: 's0', state: { notes: 'short' } })
  assert.equal(f.world.entities.appSizes.get('s0').state, stateBytes({ notes: 'short' }))
  assert.equal(joinStateBytes(f.world), full - stateBytes(state) + stateBytes({ notes: 'short' }))
})

test('join budget: a blueprint change that rebuilds its apps releases their state bytes and is admitted with them', () => {
  const f = fixture()
  f.world.blueprints.add({ id: 'big', version: 0, props: { text: '' } })
  const state = { notes: 'n'.repeat(8000) }
  for (let i = 0; i < 3; i++) f.network.onEntityAdded(f.builder, app(`r${i}`, 'big', { state }))
  // fill the rest with stateless apps until nothing more fits
  for (let i = 0; f.world.entities.canFitApp(`f${i}`, app(`f${i}`)); i++)
    f.network.onEntityAdded(f.builder, app(`f${i}`))
  const charged = f.world.entities.appSizes.get('r0').state
  assert.equal(charged, stateBytes(state))
  // a modify that grows the blueprint by more than the free room but less than the three states it empties
  const room = WORLD_JOIN_BYTES - joinStateBytes(f.world)
  const growth = room + 2 * (charged - stateBytes({}))
  f.send('blueprintModified', { id: 'big', version: 1, props: { text: 't'.repeat(growth) } })
  assert.equal(f.world.blueprints.get('big').version, 1, 'admitted with the released state counted')
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(f.world.entities.get(`r${i}`).data.state, {})
    assert.equal(f.world.entities.appSizes.get(`r${i}`).state, stateBytes({}), 'the emptied state is no longer charged')
  }
  assert.ok(joinStateBytes(f.world) <= WORLD_JOIN_BYTES)
  // without states to release, the same growth again is refused and reverted
  f.builder.ws.packets.length = 0
  f.send('blueprintModified', { id: 'big', version: 2, props: { text: 't'.repeat(growth * 2) } })
  assert.equal(f.world.blueprints.get('big').version, 1)
  assert.deepEqual(sentTo(f.builder), [['onBlueprintModified', f.world.blueprints.get('big')]])
})

test('join budget: settings are measured before they change; growth past the limit is refused and reverted', () => {
  const f = fixture()
  f.network.onSettingsModified(f.builder, { key: 'voice', value: 'spatial' })
  assert.equal(f.network.settingsBytes, writePacket('settingsModified', f.world.settings.serialize()).length)
  for (let i = 0; f.world.entities.canFitApp(`a${i}`, app(`a${i}`)); i++)
    f.network.onEntityAdded(f.builder, app(`a${i}`))
  const before = f.network.settingsBytes
  f.builder.ws.packets.length = 0
  f.network.onSettingsModified(f.builder, { key: 'desc', value: 'd'.repeat(2048) })
  assert.equal(f.world.settings.desc, null)
  assert.equal(f.network.settingsBytes, before)
  assert.deepEqual(sentTo(f.builder), [['onSettingsModified', { key: 'desc', value: null }]])
  assert.ok(f.logs.includes('onSettingsModified: world is full (join-state budget exceeded)'))
  // a change that does not grow is taken, and the accounting is exact
  f.network.onSettingsModified(f.builder, { key: 'voice', value: 'global' })
  assert.equal(f.world.settings.voice, 'global')
  assert.equal(f.network.settingsBytes, writePacket('settingsModified', f.world.settings.serialize()).length)
  assert.ok(joinStateBytes(f.world) <= WORLD_JOIN_BYTES)
})

test('join budget: duplicate entity ids, a present player id and any known user id are refused for a new app', async () => {
  const f = fixture()
  f.network.onEntityAdded(f.builder, app('dup'))
  const first = f.world.entities.get('dup')
  f.network.onEntityAdded(f.builder, app('dup', 'bp', { position: [9, 9, 9] }))
  assert.equal(f.world.entities.get('dup'), first)
  // Entities itself keeps the first entity for an id
  const errors = []
  const error = console.error
  console.error = line => errors.push(line)
  try {
    assert.equal(f.world.entities.add(app('dup')), null)
  } finally {
    console.error = error
  }
  assert.deepEqual(errors, ['entity already exists: dup'])
  assert.equal(f.world.entities.get('dup'), first)
  // a present player, and a user who is away (loaded at start-up or created on a join)
  const { snapshot } = await f.join()
  f.network.userIds.add('awayUser01')
  for (const id of [snapshot.id, 'awayUser01']) {
    f.network.onEntityAdded(f.builder, app(id))
    assert.ok(!f.world.entities.get(id)?.isApp, id)
  }
  assert.ok(f.network.userIds.has(snapshot.id), 'the joined user is known from then on')
  assert.deepEqual([...f.network.dirtyApps.keys()], ['dup'])
})

test('join budget: start-up reads every user id, so an app cannot take the id of someone away', async () => {
  const f = fixture()
  const rows = [{ id: 'stored0001' }, { id: 'stored0002' }]
  f.network.db = table =>
    table === 'users'
      ? { select: async column => (assert.equal(column, 'id'), rows) }
      : table === 'config'
        ? { where: () => ({ first: async () => undefined }) }
        : []
  f.world.settings.on = () => {}
  await f.network.start()
  assert.deepEqual([...f.network.userIds], ['stored0001', 'stored0002'])
  f.network.onEntityAdded(f.builder, app('stored0002'))
  assert.equal(f.world.entities.get('stored0002'), undefined)
})

test('join budget: a blueprintAdded for an existing id is refused, reverted to the sender, and its entity removed', () => {
  const f = fixture()
  const stored = f.world.blueprints.get('bp')
  f.send('blueprintAdded', { id: 'bp', version: 5, name: 'Replaced', props: { secret: 1 } })
  f.send('entityAdded', app('rides-on-it'))
  assert.equal(f.world.blueprints.get('bp'), stored)
  assert.equal(f.world.entities.get('rides-on-it'), undefined)
  assert.deepEqual(sentTo(f.builder), [
    ['onBlueprintModified', stored],
    ['onEntityRemoved', 'rides-on-it'],
  ])
  assert.ok(f.logs.includes('onBlueprintAdded: blueprint id already exists'))
  assert.equal(f.network.dirtyBlueprints.size, 0)
})

test('join budget: an app that holds a joining user id moves to a new id; the player joins; it happens once', async () => {
  const f = fixture()
  const watcher = await f.join()
  f.users.set('legacyUser', { id: 'legacyUser', name: 'Returning', rank: 0 })
  // stored before app ids were kept apart from user ids
  const position = [1.5, 2.5, 3.5]
  f.world.entities.add(app('legacyUser', 'bp', { position, pinned: true, state: { score: 3 } }), true)
  const before = f.world.entities.appBytes
  const logs = f.logs.length
  const joined = await f.join({ authToken: 'legacyUser' })
  assert.equal(joined.method, 'onSnapshot')
  assert.equal(joined.snapshot.id, 'legacyUser')
  const player = f.world.entities.get('legacyUser')
  assert.ok(player.isPlayer)
  const moved = apps(f.world).find(entity => entity.data.blueprint === 'bp')
  assert.notEqual(moved.data.id, 'legacyUser')
  assert.match(moved.data.id, /^[A-Za-z0-9_-]{1,64}$/)
  // (the record was built in the harness's VM realm: compared as JSON)
  const kept = {
    blueprint: moved.data.blueprint,
    position: moved.data.position,
    pinned: moved.data.pinned,
    state: moved.data.state,
  }
  assert.deepEqual(JSON.parse(JSON.stringify(kept)), { blueprint: 'bp', position, pinned: true, state: { score: 3 } })
  assert.equal(f.world.entities.appBytes, before, 'the same record under an id of the same length')
  // persisted and broadcast like a removal and an addition
  assert.equal(f.network.dirtyApps.get('legacyUser').record, null)
  assert.equal(JSON.parse(f.network.dirtyApps.get(moved.data.id).record.data).blueprint, 'bp')
  const seen = watcher.ws.packets.slice(1).map(readPacket)
  assert.deepEqual(JSON.parse(JSON.stringify(seen.slice(0, 2))), [
    ['onEntityRemoved', 'legacyUser'],
    ['onEntityAdded', JSON.parse(JSON.stringify(moved.data))],
  ])
  assert.deepEqual(f.logs.slice(logs), [
    `[network] app "legacyUser" held the id of a joining user and now has id "${moved.data.id}"`,
  ])
  assert.ok(joined.snapshot.entities.some(entity => entity.id === moved.data.id && entity.type === 'app'))
  // the user leaves and comes back: nothing moves again
  f.network.onDisconnect(f.network.sockets.get('legacyUser'))
  assert.equal(f.world.entities.get('legacyUser'), undefined)
  const again = await f.join({ authToken: 'legacyUser' })
  assert.equal(again.method, 'onSnapshot')
  assert.equal(f.world.entities.get(moved.data.id), moved)
  assert.equal(f.logs.length, logs + 1)
})

test('join budget: a world stored over the budget boots whole, reports, refuses growth and accepts a delete', async t => {
  const f = fixture()
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  t.mock.method(console, 'error', () => {})
  const blueprintRows = [
    { id: 'bp', data: JSON.stringify({ id: 'bp', version: 0, props: { notes: 'n'.repeat(50000) } }) },
  ]
  const entityRows = Array.from({ length: 4000 }, (_, i) => {
    const data = { ...app(`p${String(i).padStart(9, '0')}`), state: null }
    return { id: data.id, data: JSON.stringify(data) }
  })
  entityRows.push({ id: 'L'.repeat(3000), data: JSON.stringify({ ...app('L'.repeat(3000)), state: null }) })
  f.world.blueprints.destroy()
  f.network.db = table =>
    table === 'blueprints'
      ? blueprintRows
      : table === 'entities'
        ? entityRows
        : table === 'config'
          ? { where: () => ({ first: async () => undefined }) }
          : { select: async () => [] }
  f.world.settings.on = () => {}
  t.mock.method(console, 'log', () => {})
  await f.network.start()
  assert.equal(apps(f.world).length, 4001, 'nothing is dropped, the long legacy id included')
  const total = joinStateBytes(f.world)
  assert.ok(total > WORLD_JOIN_BYTES)
  const report = warnings.find(line => line.includes('join-state budget exceeded at startup'))
  assert.ok(report)
  assert.match(
    report,
    new RegExp(`bytes=${total} cap=${WORLD_JOIN_BYTES} \\(blueprints=\\d+ apps=\\d+ settings=\\d+ collections=\\d+\\)`)
  )
  assert.match(report, /largest: blueprint "bp" \d+, app "L{24}" \d+, app "p\d+" \d+, app "p\d+" \d+, app "p\d+" \d+$/)
  // growth is refused, a delete is taken and frees its bytes
  f.network.onEntityAdded(f.builder, app(nextId()))
  assert.equal(apps(f.world).length, 4001)
  f.send('entityRemoved', 'L'.repeat(3000))
  assert.equal(apps(f.world).length, 4000)
  assert.ok(joinStateBytes(f.world) < total)
  assert.equal(f.network.dirtyApps.get('L'.repeat(3000)).record, null)
})

// the parts of the snapshot no budget tracks, at their largest, once every step was taken: the derivation of
// WORLD_JOIN_BYTES in joinBudget.js
function worstRest() {
  const id = n => `${String(n).padStart(4, '0')}${'i'.repeat(60)}`
  const player = (n, self) => ({
    id: id(n),
    type: 'player',
    position: [0.1, 0.2, 0.3],
    quaternion: [0.1, 0.2, 0.3, 0.9],
    owner: id(n),
    userId: id(n),
    name: '€'.repeat(64),
    health: 99.5,
    avatar: self ? `https://a.example/${'€'.repeat(2030)}` : null,
    sessionAvatar: self ? `https://a.example/${'€'.repeat(494)}` : null,
    rank: 2,
    enteredAt: Date.now(),
    mode: 1.5,
    axis: [0.1, 0.2, 0.3],
    gaze: [0.1, 0.2, 0.3],
    emote: null,
    effect: null,
    evmTips: true,
    tokenGrantedRank: true,
  })
  const players = Array.from({ length: 64 }, (_, i) => player(i, i === 0))
  return {
    id: id(0),
    serverTime: 123456.789,
    assetsUrl: `https://${'a'.repeat(248)}`,
    apiUrl: `https://${'b'.repeat(248)}`,
    maxUploadSize: '1024',
    collections: [],
    settings: {},
    chat: [],
    ai: { enabled: true, provider: 'p'.repeat(64), model: 'm'.repeat(64), effort: 'e'.repeat(64) },
    blueprints: [],
    entities: players,
    livekit: {
      wsUrl: `wss://${'l'.repeat(250)}`,
      levels: Object.fromEntries(players.map(p => [p.id, 'spatial'])),
      muted: new Set(players.map(p => p.id)),
      token: 'j'.repeat(1024),
    },
    authToken: 't'.repeat(512),
    hasAdminCode: true,
  }
}

test('join budget: world state at its budget plus the worst case of the rest fits the snapshot cap', () => {
  const rest = writePacket('snapshot', worstRest()).length
  assert.ok(rest <= 55054, `${rest}`)
  assert.ok(WORLD_JOIN_BYTES + rest <= SNAPSHOT_CAP - 200000, 'with more than 200 KB to spare')
  const other = writePacket('entityAdded', worstRest().entities[1]).length
  assert.ok(other <= 704, `${other}`)
})

test("join budget: Codex's worst case (blueprints and apps at the budget, 64 players at their limits, full chat) joins", async () => {
  const f = fixture()
  for (let i = 0; i < 8; i++)
    f.send('blueprintAdded', { id: `big${i}`, version: 0, props: { notes: 'n'.repeat(60000) } })
  assert.equal(f.world.blueprints.items.size, 9)
  assert.ok(f.world.blueprints.bytes <= WORLD_BLUEPRINT_BYTES)
  for (let i = 0; i < 1639; i++) f.network.onEntityAdded(f.builder, app(nextId(), `big${i % 8}`))
  assert.ok(joinStateBytes(f.world) > WORLD_JOIN_BYTES - 300, 'the world is at its budget')
  const unicode = n => `https://a.example/${'€'.repeat(n - 18)}`
  const ef = { anchorId: 'a'.repeat(128), notes: 'é'.repeat(3900) }
  for (let i = 0; i < 63; i++) {
    const id = `player${String(i).padStart(4, '0')}`
    f.world.entities.add({
      id,
      type: 'player',
      position: [0.1, 0.2, 0.3],
      quaternion: [0, 0, 0, 1],
      owner: id,
      userId: id,
      name: '€'.repeat(64),
      health: 100,
      avatar: unicode(512),
      sessionAvatar: unicode(512),
      emote: unicode(512),
      effect: ef,
      rank: 1,
      enteredAt: Date.now(),
    })
  }
  f.world.chat.msgs = Array.from({ length: 50 }, (_, i) => ({
    id: `m${i}`,
    from: '€'.repeat(64),
    body: '€'.repeat(500),
  }))
  f.world.livekit.state = {
    wsUrl: 'wss://livekit.example',
    levels: Object.fromEntries(Array.from({ length: 30000 }, (_, i) => [`gone${i}`, null])),
    muted: new Set(['player0001']),
    token: 'token',
  }
  const joined = await f.join()
  assert.equal(joined.method, 'onSnapshot')
  assert.ok(joined.bytes <= SNAPSHOT_CAP, `${joined.bytes}`)
  const line = f.logs.find(entry => entry.includes('did not fit its cap'))
  assert.ok(line, 'the steps taken are logged')
  const self = joined.snapshot.entities.find(entity => entity.id === joined.snapshot.id)
  assert.ok(self.avatar, 'the joiner keeps its own avatar')
  assert.equal(joined.snapshot.livekit.muted.has('player0001'), true, 'a present player stays muted')
})

test('join budget: each step is taken only when the ones before it were not enough', () => {
  const entities = [
    { id: 'me', type: 'player', avatar: 'https://a.example/me.vrm', effect: { e: 'm'.repeat(2000) } },
    {
      id: 'other',
      type: 'player',
      avatar: `https://a.example/${'a'.repeat(400)}`,
      sessionAvatar: 'https://s.example/x.vrm',
      emote: 'https://e.example/x.glb',
      effect: { e: 'o'.repeat(3000) },
    },
    { id: 'app1', type: 'app', blueprint: 'bp', state: { s: 's'.repeat(4000) } },
  ]
  const state = {
    id: 'me',
    chat: Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, body: 'c'.repeat(300) })),
    entities,
    livekit: {
      levels: {
        me: 'global',
        other: 'spatial',
        ...Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`left${i}`, null])),
      },
      muted: new Set(['other', 'left1']),
    },
  }
  const sizes = [encodeSnapshot(state, { selfId: 'me', cap: Infinity }).packet.length]
  for (let k = 1; k <= SNAPSHOT_STEPS.length; k++) {
    const cap = sizes[k - 1] - 1
    const { packet, steps } = encodeSnapshot(state, { selfId: 'me', cap })
    assert.deepEqual(steps, SNAPSHOT_STEPS.slice(0, k), `cap ${cap}`)
    assert.ok(packet.length <= cap)
    sizes.push(packet.length)
  }
  const [, last] = readPacket(encodeSnapshot(state, { selfId: 'me', cap: sizes[5] }).packet)
  assert.deepEqual(Object.keys(last.livekit.levels), ['me', 'other'])
  assert.deepEqual([...last.livekit.muted], ['other'])
  assert.deepEqual(last.chat, [])
  const [me, other, app1] = last.entities
  assert.equal(me.avatar, 'https://a.example/me.vrm')
  assert.equal(me.effect, null)
  assert.deepEqual([other.avatar, other.sessionAvatar, other.emote, other.effect], [null, null, null, null])
  assert.deepEqual(app1.state, {})
  // the world itself is left as it was
  assert.equal(entities[1].avatar.length, 418)
  assert.equal(entities[2].state.s.length, 4000)
  assert.equal(state.chat.length, 10)
  assert.equal(state.livekit.muted.size, 2)
  // a state the encoder refuses (a script's) is dropped by the app-state step
  const symbolic = { ...state, entities: [{ id: 'x', type: 'app', state: { s: Symbol('x') } }] }
  const encoded = encodeSnapshot(symbolic, { selfId: 'me' })
  assert.deepEqual(encoded.steps, ['voice', 'chat', 'effects', 'appState'])
  assert.ok(encoded.packet)
  // and a world over the cap by itself gets no packet that fits
  const huge = { ...state, blueprints: [{ props: { text: 'x'.repeat(SNAPSHOT_CAP) } }] }
  const result = encodeSnapshot(huge, { selfId: 'me' })
  assert.deepEqual(result.steps, SNAPSHOT_STEPS)
  assert.ok(result.packet.length > SNAPSHOT_CAP)
})

test('join budget: an AI change that would grow a full world is not applied', async t => {
  const f = fixture()
  f.world.blueprints.add({ id: 'ai-bp', version: 0, script: 'asset://ai.js' })
  for (let i = 0; f.world.entities.canFitApp(`a${i}`, app(`a${i}`)); i++)
    f.network.onEntityAdded(f.builder, app(`a${i}`))
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  const ServerAI = loadClient('core/systems/ServerAI.js', 'ServerAI', {
    fs: { readFileSync: () => '' },
    path,
    __dirname: '.',
    hashFile: async () => 'h'.repeat(64),
    console: { log() {}, warn: console.warn, error() {} },
    process: { env: {} },
  })
  const ai = new ServerAI(f.world)
  ai.assets = { upload: async () => true }
  ai.client = { classify: async () => 'N'.repeat(5000) }
  await ai.classify({ blueprintId: 'ai-bp', prompt: 'p' })
  assert.equal(f.world.blueprints.get('ai-bp').version, 0)
  assert.equal(f.network.dirtyBlueprints.size, 0)
  assert.deepEqual(warnings, [
    '[ai] change to blueprint "ai-bp" not applied: the world is full (join-state budget exceeded)',
  ])
})

test.todo(
  'join budget: a server script that grows its props does not change the blueprint size in the join snapshot (needs the P1 per-instance props copy)'
)
