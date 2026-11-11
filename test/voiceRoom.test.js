import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadClient } from './lib/clientHarness.mjs'
import { SCREEN_TARGET_MAX_LENGTH, screenTarget } from '../src/core/extras/screenShare.js'

test('a share names its screen in metadata anyone can write: read as untrusted text', () => {
  assert.equal(screenTarget(JSON.stringify({ screenTargetId: 'stage' })), 'stage')
  assert.equal(screenTarget(JSON.stringify({ screenTargetId: 'a'.repeat(SCREEN_TARGET_MAX_LENGTH) }))?.length, 128)
  for (const metadata of [
    undefined,
    null,
    '',
    '{',
    'not json',
    'null',
    '7',
    '"stage"',
    '[]',
    '["stage"]',
    '{}',
    JSON.stringify({ screenTargetId: null }),
    JSON.stringify({ screenTargetId: '' }),
    JSON.stringify({ screenTargetId: 7 }),
    JSON.stringify({ screenTargetId: ['stage'] }),
    JSON.stringify({ screenTargetId: { toString: 'stage' } }),
    JSON.stringify({ screenTargetId: 'a'.repeat(SCREEN_TARGET_MAX_LENGTH + 1) }),
    { screenTargetId: 'stage' },
  ]) {
    assert.equal(screenTarget(metadata), null, String(metadata).slice(0, 40))
  }
})

// ClientLiveKit with stand-ins for the room, the voices' audio and the screens' video elements
function client({ Room = class {} } = {}) {
  const textures = []
  class VideoTexture {
    constructor(elem) {
      this.elem = elem
      this.disposed = false
      textures.push(this)
    }
    dispose() {
      this.disposed = true
    }
  }
  const voices = []
  const deps = {
    ParticipantEvent: { IsSpeakingChanged: 'isSpeakingChanged' },
    Room,
    RoomEvent: {},
    ScreenSharePresets: { h1080fps30: {} },
    THREE: { Vector3: class {}, Quaternion: class {}, VideoTexture, SRGBColorSpace: 'srgb', LinearFilter: 'linear' },
    System: class extends EventEmitter {
      constructor(world) {
        super()
        this.world = world
      }
    },
    isBoolean: v => typeof v === 'boolean',
    prepareVideoElement: () => {},
    createVoiceTap: () => null,
    screenTarget,
    document: { createElement: () => ({}) },
  }
  const ClientLiveKit = loadClient('core/systems/ClientLiveKit.js', 'ClientLiveKit', deps)
  const players = new Map()
  const player = id => {
    const p = { data: { id }, speaking: [], setSpeaking: value => p.speaking.push(value) }
    players.set(id, p)
    return p
  }
  const world = new EventEmitter()
  world.settings = Object.assign(new EventEmitter(), { voice: 'spatial' })
  world.network = { id: 'me' }
  world.graphics = { maxAnisotropy: 1 }
  world.entities = { getPlayer: id => players.get(id) }
  world.audio = { ready: fn => (world.audio.go = fn) }
  const livekit = new ClientLiveKit(world)
  world.livekit = livekit
  livekit.start()
  // voices are stand-ins: what matters here is which exist and that they are destroyed
  const voice = id => {
    const v = { id, destroyed: false, muted: null, destroy: () => (v.destroyed = true), setMuted: m => (v.muted = m) }
    voices.push(v)
    livekit.voices.set(id, v)
    return v
  }
  const track = () => {
    const t = { source: 'screen_share', attached: [], detached: [] }
    t.attach = elem => t.attached.push(elem)
    t.detach = elem => t.detached.push(elem)
    return t
  }
  const participant = (identity, target) => ({
    identity,
    metadata: target === undefined ? undefined : JSON.stringify({ screenTargetId: target }),
  })
  const node = screenId => {
    const n = { _screenId: screenId, dirty: 0, needsRebuild: false, setDirty: () => n.dirty++ }
    livekit.screenNodes.add(n)
    return n
  }
  const shown = () => livekit.screens.map(s => [s.playerId, s.targetId])
  return { livekit, world, player, voice, track, participant, node, shown, textures }
}

test('voice room: a kick or a lost connection leaves the room, for good', async () => {
  for (const event of ['kick', 'disconnect']) {
    const c = client()
    c.player('p1')
    const room = { disconnects: 0, connects: 0 }
    room.disconnect = async () => void room.disconnects++
    room.connect = async () => void room.connects++
    c.livekit.room = room
    const v = c.voice('p1')
    const t = c.track()
    c.livekit.onTrackSubscribed(t, {}, c.participant('p1', 'stage'))
    assert.deepEqual(c.shown(), [['p1', 'stage']])
    c.livekit.status.connected = true
    c.livekit.status.mic = true
    const statuses = []
    c.livekit.on('status', status => statuses.push({ ...status }))
    c.world.emit(event, 'moderation')
    assert.equal(room.disconnects, 1, event)
    assert.equal(v.destroyed, true)
    assert.equal(c.livekit.voices.size, 0)
    assert.deepEqual(c.shown(), [])
    assert.equal(t.detached.length, 1, 'the screen let go of its track')
    assert.equal(c.textures[0].disposed, true)
    assert.equal(c.livekit.shares.size, 0)
    assert.deepEqual(
      statuses.map(s => [s.connected, s.mic, s.screenshare]),
      [[false, false, null]]
    )
    // the other event follows a kick: once is enough
    c.world.emit('disconnect', true)
    c.world.emit('kick', 'moderation')
    assert.equal(room.disconnects, 1)
    assert.equal(statuses.length, 1)
  }
})

test('voice room: out of the world before the room is joined, it is never joined (or left at once)', async () => {
  // audio becomes ready on the player's first touch; the world's connection may have ended by then
  const rooms = []
  class Room extends EventEmitter {
    constructor() {
      super()
      this.localParticipant = new EventEmitter()
      this.connects = []
      this.disconnects = 0
      rooms.push(this)
    }
    connect(...args) {
      this.connects.push(args)
      return new Promise(resolve => (this.connected = resolve))
    }
    async disconnect() {
      this.disconnects++
    }
  }
  const options = { wsUrl: 'wss://voice.example', token: 'signed', muted: new Set(), levels: {} }
  {
    const c = client({ Room })
    await c.livekit.deserialize(options)
    c.world.emit('kick', 'moderation')
    await c.world.audio.go()
    assert.deepEqual(rooms[0].connects, [], 'kicked before the first touch')
    assert.equal(c.livekit.status.connected, false)
  }
  {
    const c = client({ Room })
    await c.livekit.deserialize(options)
    const joining = c.world.audio.go()
    assert.deepEqual(rooms[1].connects, [['wss://voice.example', 'signed']])
    c.world.emit('disconnect', true)
    assert.equal(rooms[1].disconnects, 1)
    rooms[1].connected()
    await joining
    assert.equal(rooms[1].disconnects, 2, 'the connection that completed after leaving is closed')
    assert.equal(c.livekit.status.connected, false)
  }
  {
    // the ordinary case still joins
    const c = client({ Room })
    await c.livekit.deserialize(options)
    const joining = c.world.audio.go()
    rooms[2].connected()
    await joining
    assert.equal(c.livekit.status.connected, true)
    assert.equal(rooms[2].disconnects, 0)
  }
})

test('voice room: a player who leaves the world is no longer heard or shown, whatever the room says', () => {
  const c = client()
  c.player('p1')
  c.player('p2')
  const v1 = c.voice('p1')
  const v2 = c.voice('p2')
  const stage = c.node('stage')
  c.livekit.onTrackSubscribed(c.track(), {}, c.participant('p1', 'stage'))
  c.livekit.onTrackSubscribed(c.track(), {}, c.participant('p2', 'wall'))
  const dirty = stage.dirty
  c.livekit.dropPlayer('p1')
  assert.equal(v1.destroyed, true)
  assert.equal(v2.destroyed, false)
  assert.deepEqual([...c.livekit.voices.keys()], ['p2'])
  assert.deepEqual(c.shown(), [['p2', 'wall']])
  assert.equal(stage.dirty, dirty + 1, 'the screen node it was on is rebuilt')
  assert.equal(c.livekit.shares.has('p1'), false)
  // dropping someone with nothing here is nothing
  c.livekit.dropPlayer('p3')
  c.livekit.dropPlayer('p1')
  assert.deepEqual(c.shown(), [['p2', 'wall']])
})

test("voice room: a mute hides the player's screen share too, and lifting it shows it again", () => {
  const c = client()
  const p1 = c.player('p1')
  const v = c.voice('p1')
  const t = c.track()
  c.livekit.onTrackSubscribed(t, {}, c.participant('p1', 'stage'))
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  c.livekit.setMuted('p1', true)
  assert.equal(v.muted, true)
  assert.deepEqual(c.shown(), [], 'hidden')
  assert.deepEqual(p1.speaking, [false], 'a speaking state that was on ends')
  assert.equal(c.livekit.shares.has('p1'), true, 'the track is kept for when the mute is lifted')
  c.livekit.setMuted('p1', false)
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  assert.equal(c.livekit.screens[0].track, t)
  assert.deepEqual(p1.speaking, [false], 'lifting a mute says nothing about speaking')

  // asked again with nothing changed, the screen is left as it is
  c.livekit.syncScreen('p1')
  assert.equal(c.textures.length, 2, 'one for each time it was shown')
  // the same player's share comes again on a new track (a re-subscribe): the screen is made from the new one
  const t2 = c.track()
  c.livekit.onTrackSubscribed(t2, {}, c.participant('p1', 'stage'))
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  assert.equal(c.livekit.screens[0].track, t2)
  assert.equal(c.textures.length, 3)
  assert.equal(c.textures[1].disposed, true)

  // a share that starts while its player is muted is not shown until the mute is lifted
  c.player('p2')
  c.livekit.setMuted('p2', true)
  c.livekit.onTrackSubscribed(c.track(), {}, c.participant('p2', 'wall'))
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  c.livekit.setMuted('p2', false)
  assert.deepEqual(c.shown(), [
    ['p1', 'stage'],
    ['p2', 'wall'],
  ])
  // one that ended while muted does not come back
  c.livekit.setMuted('p2', true)
  c.livekit.onTrackUnsubscribed({ source: 'screen_share' }, {}, c.participant('p2', 'wall'))
  c.livekit.setMuted('p2', false)
  assert.deepEqual(c.shown(), [['p1', 'stage']])
})

test('voice room: a share without a readable target is not shown; the target may arrive or change later', () => {
  const c = client()
  c.player('p1')
  const t = c.track()
  const who = { identity: 'p1', metadata: '{broken' }
  c.livekit.onTrackSubscribed(t, {}, who)
  assert.deepEqual(c.shown(), [])
  // an unsubscribe for a share that was never shown is nothing (it used to throw)
  c.livekit.onTrackUnsubscribed({ source: 'screen_share' }, {}, who)
  assert.equal(c.livekit.shares.size, 0)

  c.livekit.onTrackSubscribed(t, {}, who)
  who.metadata = JSON.stringify({ screenTargetId: 'stage' })
  c.livekit.onMetadataChanged('{broken', who)
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  c.livekit.onMetadataChanged(who.metadata, who)
  assert.equal(c.textures.length, 1, 'the same target again builds nothing')
  who.metadata = JSON.stringify({ screenTargetId: 'wall' })
  c.livekit.onMetadataChanged('', who)
  assert.deepEqual(c.shown(), [['p1', 'wall']])
  assert.equal(c.textures[0].disposed, true)
  who.metadata = 'null'
  c.livekit.onMetadataChanged('', who)
  assert.deepEqual(c.shown(), [])
  // metadata of someone who shares nothing, or of nobody, is nothing
  c.livekit.onMetadataChanged('', { identity: 'p9', metadata: who.metadata })
  c.livekit.onMetadataChanged('', undefined)
  assert.deepEqual(c.shown(), [])
})

test('voice room: a track of someone who is not a player here is ignored', t => {
  t.mock.method(console, 'error', () => {})
  const c = client()
  c.livekit.onTrackSubscribed(c.track(), {}, c.participant('ghost', 'stage'))
  assert.deepEqual(c.shown(), [])
  assert.equal(c.livekit.shares.size, 0)
})

test('voice room: a level of null is no entry (the world default), as the server keeps it', () => {
  const c = client()
  c.livekit.setLevel('p1', 'global')
  assert.deepEqual(c.livekit.levels, { p1: 'global' })
  c.livekit.setLevel('p1', null)
  assert.deepEqual(c.livekit.levels, {})
  c.livekit.setLevel('p2', null)
  assert.deepEqual(c.livekit.levels, {})
})

test('voice room: destroy stops listening for the world leaving', () => {
  const c = client()
  assert.equal(c.world.listenerCount('kick'), 1)
  assert.equal(c.world.listenerCount('disconnect'), 1)
  c.livekit.destroy()
  assert.equal(c.world.listenerCount('kick'), 0)
  assert.equal(c.world.listenerCount('disconnect'), 0)
})

// ServerLiveKit with a stand-in token signer that keeps what it was asked to sign
function server(env = { LIVEKIT_WS_URL: 'wss://voice.example', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secret' }) {
  const tokens = []
  class AccessToken {
    constructor(key, secret, options) {
      this.entry = { key, secret, options, grants: [] }
      tokens.push(this.entry)
    }
    addGrant(grant) {
      this.entry.grants.push(grant)
    }
    async toJwt() {
      return 'signed'
    }
  }
  const ServerLiveKit = loadClient('core/systems/ServerLiveKit.js', 'ServerLiveKit', {
    AccessToken,
    TrackSource: { MICROPHONE: 'mic', SCREEN_SHARE: 'screen', SCREEN_SHARE_AUDIO: 'screen-audio', CAMERA: 'camera' },
    process: { env },
    uuid: () => 'room-1',
  })
  const sent = []
  const here = new Set()
  const world = {
    network: { send: (name, data) => sent.push([name, data]) },
    entities: { getPlayer: id => (here.has(id) ? { data: { id } } : undefined) },
  }
  return { livekit: new ServerLiveKit(world), sent, here, tokens }
}

test('voice token: a microphone and a screen for this room, no data messages, no camera, no screen audio', async () => {
  const s = server()
  const data = await s.livekit.serialize('user-1')
  assert.equal(data.token, 'signed')
  assert.equal(data.wsUrl, 'wss://voice.example')
  assert.equal(s.tokens.length, 1)
  assert.deepEqual(s.tokens[0].options, { identity: 'user-1' })
  assert.deepEqual(s.tokens[0].grants, [
    {
      room: 'room-1',
      roomJoin: true,
      canSubscribe: true,
      canPublish: true,
      canPublishSources: ['mic', 'screen'],
      canPublishData: false,
      canUpdateOwnMetadata: true,
    },
  ])
  assert.equal(await server({}).livekit.serialize('user-1'), null, 'no voice server configured: no token')
})

test('mute list: said to everyone on change only, kept for absent players, bounded', () => {
  const s = server()
  assert.equal(s.livekit.setMuted('p1', true), true)
  assert.equal(s.livekit.setMuted('p1', true), true)
  assert.deepEqual(s.sent, [['mute', { playerId: 'p1', muted: true }]])
  assert.equal(s.livekit.setMuted('p2', false), true)
  assert.equal(s.sent.length, 1, 'unmuting someone who is not muted says nothing')
  assert.equal(s.livekit.setMuted('p1', false), true)
  assert.deepEqual(s.sent[1], ['mute', { playerId: 'p1', muted: false }])
  assert.equal(s.livekit.muted.size, 0)

  // at the limit the longest-muted player who is not here gives way, and everyone is told
  for (let i = 0; i < 1024; i++) s.livekit.muted.add(`m${i}`)
  s.here.add('m0')
  s.here.add('m1')
  s.sent.length = 0
  assert.equal(s.livekit.setMuted('new', true), true)
  assert.deepEqual(s.sent, [
    ['mute', { playerId: 'm2', muted: false }],
    ['mute', { playerId: 'new', muted: true }],
  ])
  assert.equal(s.livekit.muted.size, 1024)
  assert.ok(s.livekit.muted.has('m0') && s.livekit.muted.has('m1') && !s.livekit.muted.has('m2'))
  // with everyone muted present, a new mute is not made (and nobody is unmuted for it)
  for (const id of s.livekit.muted) s.here.add(id)
  s.sent.length = 0
  assert.equal(s.livekit.setMuted('another', true), false)
  assert.deepEqual(s.sent, [])
  assert.equal(s.livekit.muted.has('another'), false)
  assert.equal(s.livekit.muted.size, 1024)
  // unmuting still works at the limit
  assert.equal(s.livekit.setMuted('m0', false), true)
  assert.equal(s.livekit.muted.size, 1023)
})

test('voice levels: a player without one has no entry; leaving says nothing and keeps nothing', () => {
  const s = server()
  // a player who never had a modifier leaves
  s.livekit.clearModifiers('p1')
  assert.deepEqual(s.sent, [])
  assert.deepEqual(s.livekit.levels, {})
  // one with a modifier: said when it starts, when it ends, and no entry is left
  const mod = s.livekit.addModifier('p2', 'global')
  assert.deepEqual(s.livekit.levels, { p2: 'global' })
  s.livekit.updateModifier(mod, 'disabled')
  s.livekit.clearModifiers('p2')
  assert.deepEqual(s.sent, [
    ['liveKitLevel', { playerId: 'p2', level: 'global' }],
    ['liveKitLevel', { playerId: 'p2', level: 'disabled' }],
    ['liveKitLevel', { playerId: 'p2', level: null }],
  ])
  assert.deepEqual(s.livekit.levels, {})
  s.livekit.clearModifiers('p2')
  assert.equal(s.sent.length, 3)
  // removing the last modifier is the same as leaving
  const again = s.livekit.addModifier('p3', 'spatial')
  s.livekit.removeModifier(again)
  assert.deepEqual(s.livekit.levels, {})
  assert.deepEqual(s.sent.at(-1), ['liveKitLevel', { playerId: 'p3', level: null }])
})
