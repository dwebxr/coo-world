import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
// the installed SDK's own event names (it loads without a browser): a handler wired under another name fails here
import { ParticipantEvent, RoomEvent } from 'livekit-client'
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

// The voice room as the installed SDK presents it (livekit-client 2.9.9, src/room/Room.ts): TrackSubscribed and
// TrackUnsubscribed carry (track, publication, participant); LocalTrackPublished and LocalTrackUnpublished
// (publication, localParticipant), the publication still holding its track; TrackMuted and TrackUnmuted (publication,
// participant); ParticipantMetadataChanged (previous metadata, participant), this client's own participant included.
// The system is reached only through what it wired in deserialize, under the SDK's own event names.
class FakeRoom extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.connects = []
    this.disconnects = 0
    // what this client asked the room for, in order; `answer` gives setMetadata's outcome
    const local = Object.assign(new EventEmitter(), { identity: 'me', metadata: undefined, asked: [] })
    local.setMetadata = metadata => {
      local.asked.push(['metadata', metadata])
      return local.answer?.() ?? Promise.resolve()
    }
    local.setScreenShareEnabled = on => (local.asked.push(['screen', on]), Promise.resolve())
    local.setMicrophoneEnabled = on => (local.asked.push(['mic', on]), Promise.resolve())
    this.localParticipant = local
  }
  connect(...args) {
    this.connects.push(args)
    return new Promise(resolve => (this.connected = resolve))
  }
  // settled at once unless a test holds it (leave does not wait for it)
  disconnect() {
    this.disconnects++
    return this.disconnecting ?? Promise.resolve()
  }
}

const shareTo = target => JSON.stringify({ screenTargetId: target })

// ClientLiveKit with a stand-in room and stand-ins for the voices' audio nodes and the screens' video elements
function client() {
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
  const rooms = []
  class Room extends FakeRoom {
    constructor(options) {
      super(options)
      rooms.push(this)
    }
  }
  const deps = {
    ParticipantEvent,
    Room,
    RoomEvent,
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
  world.entities = {
    getPlayer: id => players.get(id),
    get player() {
      return players.get('me')
    },
  }
  const audioNode = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} })
  world.audio = {
    ctx: { createGain: audioNode, createPanner: audioNode },
    groupGains: { voice: audioNode() },
    ready: fn => (world.audio.go = fn),
  }
  const livekit = new ClientLiveKit(world)
  world.livekit = livekit
  livekit.start()
  // the join snapshot's voice options: the room is made and its events wired
  const join = async ({ muted = [] } = {}) => {
    await livekit.deserialize({ wsUrl: 'wss://voice.example', token: 'signed', muted: new Set(muted), levels: {} })
    return rooms.at(-1)
  }
  const screenTrack = () => {
    const t = { source: 'screen_share', attached: [], detached: [] }
    t.attach = elem => t.attached.push(elem)
    t.detach = elem => t.detached.push(elem)
    return t
  }
  const micTrack = () => {
    const t = { source: 'microphone', attached: 0, detached: 0, setAudioContext() {}, setWebAudioPlugins() {} }
    t.attach = () => t.attached++
    t.detach = () => t.detached++
    return t
  }
  const participant = (identity, target) =>
    Object.assign(new EventEmitter(), { identity, metadata: target === undefined ? undefined : shareTo(target) })
  const node = screenId => {
    const n = { _screenId: screenId, dirty: 0, needsRebuild: false, setDirty: () => n.dirty++ }
    livekit.screenNodes.add(n)
    return n
  }
  const shown = () => livekit.screens.map(s => [s.playerId, s.targetId])
  const statuses = []
  livekit.on('status', status => statuses.push({ ...status }))
  return { livekit, world, join, players, player, screenTrack, micTrack, participant, node, shown, textures, statuses }
}

test('voice room: a kick or a lost connection leaves the room, for good', async () => {
  for (const event of ['kick', 'disconnect']) {
    const c = client()
    c.player('p1')
    const room = await c.join()
    const mic = c.micTrack()
    const screen = c.screenTrack()
    const who = c.participant('p1', 'stage')
    room.emit(RoomEvent.TrackSubscribed, mic, {}, who)
    room.emit(RoomEvent.TrackSubscribed, screen, {}, who)
    assert.equal(c.livekit.voices.size, 1)
    assert.deepEqual(c.shown(), [['p1', 'stage']])
    c.livekit.status.connected = true
    c.livekit.status.mic = true
    c.statuses.length = 0
    c.world.emit(event, 'moderation')
    assert.equal(room.disconnects, 1, event)
    assert.equal(c.livekit.voices.size, 0)
    assert.equal(mic.detached, 1, 'the voice let go of its track')
    assert.deepEqual(c.shown(), [])
    assert.equal(screen.detached.length, 1, 'the screen let go of its track')
    assert.equal(c.textures[0].disposed, true)
    assert.equal(c.livekit.shares.size, 0)
    assert.deepEqual(
      c.statuses.map(s => [s.connected, s.mic, s.screenshare]),
      [[false, false, null]]
    )
    // the other event follows a kick: once is enough
    c.world.emit('disconnect', true)
    c.world.emit('kick', 'moderation')
    assert.equal(room.disconnects, 1)
    assert.equal(c.statuses.length, 1)
  }
})

test('voice room: what the room reports while it is being left brings nothing back', async () => {
  const c = client()
  c.player('me')
  c.player('p1')
  const room = await c.join()
  const local = room.localParticipant
  // the disconnect does not finish here: the room keeps reporting meanwhile
  room.disconnecting = new Promise(() => {})
  c.world.emit('kick', 'moderation')
  assert.equal(room.disconnects, 1)
  assert.deepEqual(room.eventNames(), [], 'nothing the room says is followed any more')
  c.statuses.length = 0
  const who = c.participant('p1', 'stage')
  local.metadata = shareTo('wall')
  room.emit(RoomEvent.TrackSubscribed, c.micTrack(), {}, who)
  room.emit(RoomEvent.TrackSubscribed, c.screenTrack(), {}, who)
  room.emit(RoomEvent.ParticipantMetadataChanged, undefined, who)
  room.emit(RoomEvent.LocalTrackPublished, { source: 'screen_share', track: c.screenTrack() }, local)
  room.emit(RoomEvent.LocalTrackPublished, { source: 'microphone', track: c.micTrack() }, local)
  room.emit(RoomEvent.ParticipantMetadataChanged, undefined, local)
  room.emit(RoomEvent.TrackUnmuted, { isLocal: true, source: 'microphone' }, local)
  assert.equal(c.livekit.voices.size, 0)
  assert.equal(c.livekit.shares.size, 0)
  assert.deepEqual(c.shown(), [])
  assert.equal(c.textures.length, 0)
  assert.deepEqual(c.statuses, [])
  const { connected, mic, screenshare } = c.livekit.status
  assert.deepEqual([connected, mic, screenshare], [false, false, null])
  // and nothing is published into it again
  local.asked.length = 0
  c.livekit.setScreenShareTarget('stage')
  c.livekit.setMicrophoneEnabled(true)
  assert.deepEqual(local.asked, [])
})

test('voice room: out of the world before the room is joined, it is never joined (or left at once)', async () => {
  // audio becomes ready on the player's first touch; the world's connection may have ended by then
  {
    const c = client()
    const room = await c.join()
    c.world.emit('kick', 'moderation')
    await c.world.audio.go()
    assert.deepEqual(room.connects, [], 'kicked before the first touch')
    assert.equal(c.livekit.status.connected, false)
  }
  {
    const c = client()
    const room = await c.join()
    const joining = c.world.audio.go()
    assert.deepEqual(room.connects, [['wss://voice.example', 'signed']])
    c.world.emit('disconnect', true)
    assert.equal(room.disconnects, 1)
    room.connected()
    await joining
    assert.equal(room.disconnects, 2, 'the connection that completed after leaving is closed')
    assert.equal(c.livekit.status.connected, false)
  }
  {
    // the ordinary case still joins
    const c = client()
    const room = await c.join()
    const joining = c.world.audio.go()
    room.connected()
    await joining
    assert.equal(c.livekit.status.connected, true)
    assert.equal(room.disconnects, 0)
  }
})

test('voice room: a player who leaves the world is no longer heard or shown, whatever the room says', async t => {
  t.mock.method(console, 'error', () => {})
  const c = client()
  c.player('p1')
  c.player('p2')
  const room = await c.join()
  const stage = c.node('stage')
  const one = c.participant('p1', 'stage')
  const two = c.participant('p2', 'wall')
  const mic = c.micTrack()
  room.emit(RoomEvent.TrackSubscribed, mic, {}, one)
  room.emit(RoomEvent.TrackSubscribed, c.micTrack(), {}, two)
  room.emit(RoomEvent.TrackSubscribed, c.screenTrack(), {}, one)
  room.emit(RoomEvent.TrackSubscribed, c.screenTrack(), {}, two)
  const dirty = stage.dirty
  c.livekit.dropPlayer('p1')
  assert.equal(mic.detached, 1)
  assert.deepEqual([...c.livekit.voices.keys()], ['p2'])
  assert.deepEqual(c.shown(), [['p2', 'wall']])
  assert.equal(stage.dirty, dirty + 1, 'the screen node it was on is rebuilt')
  assert.equal(c.livekit.shares.has('p1'), false)
  // dropping someone with nothing here is nothing
  c.livekit.dropPlayer('p3')
  c.livekit.dropPlayer('p1')
  assert.deepEqual(c.shown(), [['p2', 'wall']])
  // what the room says of them afterwards changes nothing: they are nobody's player here
  c.players.delete('p1')
  room.emit(RoomEvent.ParticipantMetadataChanged, undefined, Object.assign(one, { metadata: shareTo('wall') }))
  room.emit(RoomEvent.TrackUnsubscribed, mic, {}, one)
  room.emit(RoomEvent.TrackSubscribed, c.micTrack(), {}, one)
  room.emit(RoomEvent.TrackSubscribed, c.screenTrack(), {}, one)
  assert.deepEqual([...c.livekit.voices.keys()], ['p2'])
  assert.deepEqual(c.shown(), [['p2', 'wall']])
})

test("voice room: a mute hides the player's screen share too, and lifting it shows it again", async () => {
  const c = client()
  const p1 = c.player('p1')
  const room = await c.join()
  const who = c.participant('p1', 'stage')
  room.emit(RoomEvent.TrackSubscribed, c.micTrack(), {}, who)
  const voice = c.livekit.voices.get('p1')
  const t = c.screenTrack()
  room.emit(RoomEvent.TrackSubscribed, t, {}, who)
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  p1.speaking.length = 0
  c.livekit.setMuted('p1', true)
  assert.equal(voice.muted, true)
  assert.deepEqual(c.shown(), [], 'hidden')
  assert.deepEqual(p1.speaking, [false], 'a speaking state that was on ends')
  assert.equal(c.livekit.shares.has('p1'), true, 'the track is kept for when the mute is lifted')
  c.livekit.setMuted('p1', false)
  assert.equal(voice.muted, false)
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  assert.equal(c.livekit.screens[0].track, t)
  assert.deepEqual(p1.speaking, [false], 'lifting a mute says nothing about speaking')

  // asked again with nothing changed, the screen is left as it is
  c.livekit.syncScreen('p1')
  assert.equal(c.textures.length, 2, 'one for each time it was shown')
  // the same player's share comes again on a new track (a re-subscribe): the screen is made from the new one
  const t2 = c.screenTrack()
  room.emit(RoomEvent.TrackSubscribed, t2, {}, who)
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  assert.equal(c.livekit.screens[0].track, t2)
  assert.equal(c.textures.length, 3)
  assert.equal(c.textures[1].disposed, true)

  // a share that starts while its player is muted is not shown until the mute is lifted
  c.player('p2')
  c.livekit.setMuted('p2', true)
  const wall = c.screenTrack()
  room.emit(RoomEvent.TrackSubscribed, wall, {}, c.participant('p2', 'wall'))
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  c.livekit.setMuted('p2', false)
  assert.deepEqual(c.shown(), [
    ['p1', 'stage'],
    ['p2', 'wall'],
  ])
  // one that ended while muted does not come back
  c.livekit.setMuted('p2', true)
  room.emit(RoomEvent.TrackUnsubscribed, wall, {}, c.participant('p2', 'wall'))
  c.livekit.setMuted('p2', false)
  assert.deepEqual(c.shown(), [['p1', 'stage']])
})

test('voice room: a share without a readable target is not shown; the target may arrive or change later', async () => {
  const c = client()
  c.player('p1')
  const room = await c.join()
  const t = c.screenTrack()
  const who = Object.assign(c.participant('p1'), { metadata: '{broken' })
  room.emit(RoomEvent.TrackSubscribed, t, {}, who)
  assert.deepEqual(c.shown(), [])
  // its end, never shown, is nothing (it used to throw)
  room.emit(RoomEvent.TrackUnsubscribed, t, {}, who)
  assert.equal(c.livekit.shares.size, 0)

  room.emit(RoomEvent.TrackSubscribed, t, {}, who)
  who.metadata = shareTo('stage')
  room.emit(RoomEvent.ParticipantMetadataChanged, '{broken', who)
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  room.emit(RoomEvent.ParticipantMetadataChanged, who.metadata, who)
  assert.equal(c.textures.length, 1, 'the same target again builds nothing')
  who.metadata = shareTo('wall')
  room.emit(RoomEvent.ParticipantMetadataChanged, '', who)
  assert.deepEqual(c.shown(), [['p1', 'wall']])
  assert.equal(c.textures[0].disposed, true)
  who.metadata = 'null'
  room.emit(RoomEvent.ParticipantMetadataChanged, '', who)
  assert.deepEqual(c.shown(), [])
  // metadata of someone who shares nothing is nothing
  room.emit(RoomEvent.ParticipantMetadataChanged, '', c.participant('p9', 'stage'))
  assert.deepEqual(c.shown(), [])
})

test("voice room: this client's share status follows what is shared; a stop or a change of screen is never skipped", async () => {
  const c = client()
  c.player('me')
  const room = await c.join()
  const local = room.localParticipant
  const status = () => c.livekit.status.screenshare
  const screens = () => c.statuses.map(s => s.screenshare).filter((s, i, all) => i === 0 || s !== all[i - 1])
  const confirm = target => {
    local.metadata = shareTo(target)
    room.emit(RoomEvent.ParticipantMetadataChanged, undefined, local)
  }

  // the metadata is confirmed before the share is published
  c.livekit.setScreenShareTarget('stage')
  assert.deepEqual(local.asked, [
    ['metadata', shareTo('stage')],
    ['screen', true],
  ])
  confirm('stage')
  assert.equal(status(), null, 'nothing is shared yet')
  const first = c.screenTrack()
  room.emit(RoomEvent.LocalTrackPublished, { source: 'screen_share', track: first }, local)
  assert.equal(status(), 'stage')
  assert.deepEqual(c.shown(), [['me', 'stage']])
  local.asked.length = 0
  c.livekit.setScreenShareTarget('stage')
  assert.deepEqual(local.asked, [], 'asked again: nothing to do')
  // to another screen and back, each confirmed before the next: the status follows, and the way back is asked
  c.livekit.setScreenShareTarget('wall')
  confirm('wall')
  assert.equal(status(), 'wall')
  assert.deepEqual(c.shown(), [['me', 'wall']])
  c.livekit.setScreenShareTarget('stage')
  confirm('stage')
  assert.equal(status(), 'stage')
  // and again before the voice server has confirmed the first change: both are asked, in order
  c.livekit.setScreenShareTarget('wall')
  c.livekit.setScreenShareTarget('stage')
  assert.deepEqual(local.asked, [
    ['metadata', shareTo('wall')],
    ['screen', true],
    ['metadata', shareTo('stage')],
    ['screen', true],
    ['metadata', shareTo('wall')],
    ['screen', true],
    ['metadata', shareTo('stage')],
    ['screen', true],
  ])
  confirm('wall')
  confirm('stage')
  assert.deepEqual(screens(), ['stage', 'wall', 'stage', 'wall', 'stage'])
  // a stop unpublishes; the status says so when the share is gone
  local.asked.length = 0
  c.livekit.setScreenShareTarget(null)
  assert.deepEqual(local.asked, [
    ['metadata', shareTo(null)],
    ['screen', false],
  ])
  room.emit(RoomEvent.LocalTrackUnpublished, { source: 'screen_share', track: first }, local)
  confirm(null)
  assert.equal(status(), null)
  assert.deepEqual(c.shown(), [])
  local.asked.length = 0
  c.livekit.setScreenShareTarget(null)
  assert.deepEqual(local.asked, [], 'nothing shared, nothing asked: nothing to do')

  // the share is published before the metadata is confirmed: on no screen until it is, then on it
  c.livekit.setScreenShareTarget('stage')
  const second = c.screenTrack()
  room.emit(RoomEvent.LocalTrackPublished, { source: 'screen_share', track: second }, local)
  assert.equal(status(), null)
  assert.deepEqual(c.shown(), [])
  confirm('stage')
  assert.equal(status(), 'stage')
  assert.deepEqual(c.shown(), [['me', 'stage']])
  c.livekit.setScreenShareTarget(null)
  room.emit(RoomEvent.LocalTrackUnpublished, { source: 'screen_share', track: second }, local)
  confirm(null)
  // and a stop asked before the metadata is confirmed still stops it
  c.livekit.setScreenShareTarget('stage')
  const third = c.screenTrack()
  room.emit(RoomEvent.LocalTrackPublished, { source: 'screen_share', track: third }, local)
  assert.equal(status(), null)
  local.asked.length = 0
  c.livekit.setScreenShareTarget(null)
  assert.deepEqual(local.asked, [
    ['metadata', shareTo(null)],
    ['screen', false],
  ])
  room.emit(RoomEvent.LocalTrackUnpublished, { source: 'screen_share', track: third }, local)
  assert.equal(c.livekit.shares.size, 0)

  // a metadata change the voice server did not confirm is asked again
  local.answer = () => Promise.reject(new Error('timed out'))
  local.asked.length = 0
  c.livekit.setScreenShareTarget('stage')
  await new Promise(resolve => setImmediate(resolve))
  local.answer = null
  c.livekit.setScreenShareTarget('stage')
  assert.deepEqual(local.asked, [
    ['metadata', shareTo('stage')],
    ['screen', true],
    ['metadata', shareTo('stage')],
    ['screen', true],
  ])
  // asked for and not published (the screen picker was closed): asked again, the share is asked for again
  local.asked.length = 0
  c.livekit.setScreenShareTarget('stage')
  assert.deepEqual(local.asked, [['screen', true]])
  // a stop asked again while the share is still published asks again for it to end
  room.emit(RoomEvent.LocalTrackPublished, { source: 'screen_share', track: c.screenTrack() }, local)
  local.asked.length = 0
  c.livekit.setScreenShareTarget(null)
  c.livekit.setScreenShareTarget(null)
  assert.deepEqual(local.asked, [
    ['metadata', shareTo(null)],
    ['screen', false],
    ['screen', false],
  ])
})

test('voice room: a delivery already under way when the room is left creates nothing', async () => {
  // An emitter calls the listeners it had when the event began: taking them off in leave() does not stop the one
  // about to run. Here another listener of the same event leaves first (Codex: the voice and the screen came back).
  for (const source of ['microphone', 'screen_share']) {
    const c = client()
    c.player('p1')
    const room = await c.join()
    room.prependListener(RoomEvent.TrackSubscribed, () => c.world.emit('kick', 'moderation'))
    const track = source === 'microphone' ? c.micTrack() : c.screenTrack()
    room.emit(RoomEvent.TrackSubscribed, track, {}, c.participant('p1', 'stage'))
    assert.equal(c.livekit.left, true)
    assert.equal(c.livekit.voices.size, 0, source)
    assert.equal(c.livekit.shares.size, 0, source)
    assert.deepEqual(c.shown(), [], source)
  }
  // the same for every other handler: called after leaving, each does nothing
  const c = client()
  const me = c.player('me')
  c.player('p1')
  const room = await c.join()
  const local = room.localParticipant
  const handlers = [
    ['onTrackSubscribed', [c.micTrack(), {}, c.participant('p1', 'stage')]],
    ['onTrackSubscribed', [c.screenTrack(), {}, c.participant('p1', 'stage')]],
    ['onTrackUnsubscribed', [c.micTrack(), {}, c.participant('p1', 'stage')]],
    ['onLocalTrackPublished', [{ source: 'screen_share', track: c.screenTrack() }, local]],
    ['onLocalTrackPublished', [{ source: 'microphone', track: c.micTrack() }, local]],
    ['onLocalTrackUnpublished', [{ source: 'microphone', track: c.micTrack() }, local]],
    ['onTrackMuted', [{ isLocal: true, source: 'microphone' }]],
    ['onTrackUnmuted', [{ isLocal: true, source: 'microphone' }]],
    ['onMetadataChanged', [undefined, local]],
    ['onLocalSpeaking', [true]],
  ]
  c.world.emit('disconnect', true)
  c.statuses.length = 0
  local.asked.length = 0
  for (const [name, args] of handlers) c.livekit[name](...args)
  assert.equal(c.livekit.voices.size, 0)
  assert.equal(c.livekit.shares.size, 0)
  assert.deepEqual(c.shown(), [])
  assert.deepEqual(c.statuses, [], 'no status after leaving')
  assert.deepEqual(me.speaking, [], 'this client is not said to speak')
  assert.deepEqual(local.asked, [])
  // and this client's own speaking state is no longer followed at all
  assert.equal(local.listenerCount(ParticipantEvent.IsSpeakingChanged), 0)
})

test('voice room: this client speaking is followed while in the room', async () => {
  const c = client()
  const me = c.player('me')
  const room = await c.join()
  const said = []
  c.livekit.on('speaking', event => said.push(event))
  room.localParticipant.emit(ParticipantEvent.IsSpeakingChanged, true)
  room.localParticipant.emit(ParticipantEvent.IsSpeakingChanged, false)
  assert.deepEqual(me.speaking, [true, false])
  assert.deepEqual(said, [
    { playerId: 'me', speaking: true },
    { playerId: 'me', speaking: false },
  ])
  // destroy takes the listener off by name (off() without one throws in the SDK's emitter)
  c.livekit.destroy()
  assert.equal(room.localParticipant.listenerCount(ParticipantEvent.IsSpeakingChanged), 0)
})

test('voice room: a capture that starts after its stop was asked is ended', async () => {
  // The player is still choosing what to share when the stop is asked. The room waits only so long for that
  // capture, so the stop ends nothing, and the capture is published afterwards (Codex: it stayed, with a status
  // that said nothing was shared).
  const c = client()
  c.player('me')
  const room = await c.join()
  const local = room.localParticipant
  let chosen
  local.setScreenShareEnabled = on => {
    local.asked.push(['screen', on])
    return on ? new Promise(resolve => (chosen = resolve)) : Promise.resolve()
  }
  c.livekit.setScreenShareTarget('stage')
  c.livekit.setScreenShareTarget(null)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(
    local.asked.filter(([what]) => what === 'screen'),
    [
      ['screen', true],
      ['screen', false],
    ]
  )
  // the player picks a window now
  local.asked.length = 0
  const track = c.screenTrack()
  local.metadata = shareTo(null)
  room.emit(RoomEvent.LocalTrackPublished, { source: 'screen_share', track }, local)
  assert.deepEqual(local.asked, [['screen', false]], 'ended as soon as it is published')
  chosen()
  await new Promise(resolve => setImmediate(resolve))
  room.emit(RoomEvent.LocalTrackUnpublished, { source: 'screen_share', track }, local)
  assert.equal(c.livekit.shares.size, 0)
  assert.equal(c.livekit.status.screenshare, null)
  // a share that IS asked for is left alone when it is published
  local.asked.length = 0
  local.setScreenShareEnabled = on => (local.asked.push(['screen', on]), Promise.resolve())
  c.livekit.setScreenShareTarget('stage')
  local.metadata = shareTo('stage')
  room.emit(RoomEvent.LocalTrackPublished, { source: 'screen_share', track: c.screenTrack() }, local)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(
    local.asked.filter(([what]) => what === 'screen'),
    [['screen', true]]
  )
  assert.equal(c.livekit.status.screenshare, 'stage')
})

test('voice room: a closed picker or a refused microphone is said, not thrown; asking again asks again', async t => {
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  const c = client()
  c.player('me')
  const room = await c.join()
  const local = room.localParticipant
  const refuse = name => Object.assign(new Error('Permission denied'), { name })
  local.setScreenShareEnabled = on => (local.asked.push(['screen', on]), Promise.reject(refuse('NotAllowedError')))
  local.setMicrophoneEnabled = on => (local.asked.push(['mic', on]), Promise.reject(refuse('NotAllowedError')))
  c.livekit.setScreenShareTarget('stage')
  c.livekit.setMicrophoneEnabled(true)
  // a request that throws at once (the SDK validates its arguments before it returns a promise)
  local.setMicrophoneEnabled = () => {
    throw new Error('not connected')
  }
  c.livekit.setMicrophoneEnabled(true)
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
  assert.deepEqual(warnings, [
    '[livekit] screen share: Permission denied',
    '[livekit] microphone: Permission denied',
    '[livekit] microphone: not connected',
  ])
  assert.equal(c.livekit.status.screenshare, null)
  assert.equal(c.livekit.status.mic, false)
  // the same screen asked again: the capture is asked for again
  local.asked.length = 0
  local.setScreenShareEnabled = on => (local.asked.push(['screen', on]), Promise.resolve())
  c.livekit.setScreenShareTarget('stage')
  assert.deepEqual(local.asked, [['screen', true]])
})

test('voice room: the end of an older track leaves the newer one of the same player', async () => {
  const c = client()
  c.player('p1')
  c.player('me')
  const room = await c.join()
  const who = c.participant('p1', 'stage')
  // a screen
  const [a, b] = [c.screenTrack(), c.screenTrack()]
  room.emit(RoomEvent.TrackSubscribed, a, {}, who)
  room.emit(RoomEvent.TrackSubscribed, b, {}, who)
  assert.equal(c.livekit.screens.length, 1)
  assert.equal(c.livekit.status.screenshare, null, "another player's share is not this client's")
  room.emit(RoomEvent.TrackUnsubscribed, a, {}, who)
  assert.deepEqual(c.shown(), [['p1', 'stage']])
  assert.equal(c.livekit.screens[0].track, b)
  room.emit(RoomEvent.TrackUnsubscribed, b, {}, who)
  assert.deepEqual(c.shown(), [])
  // a microphone
  const [m1, m2] = [c.micTrack(), c.micTrack()]
  room.emit(RoomEvent.TrackSubscribed, m1, {}, who)
  room.emit(RoomEvent.TrackSubscribed, m2, {}, who)
  const voice = c.livekit.voices.get('p1')
  assert.equal(voice.track, m2)
  assert.equal(m1.detached, 1, 'the older voice was replaced')
  room.emit(RoomEvent.TrackUnsubscribed, m1, {}, who)
  assert.equal(c.livekit.voices.get('p1'), voice)
  assert.equal(m2.detached, 0)
  room.emit(RoomEvent.TrackUnsubscribed, m2, {}, who)
  assert.equal(c.livekit.voices.size, 0)
  assert.equal(m2.detached, 1)
  // this client's own share
  const local = room.localParticipant
  local.metadata = shareTo('wall')
  const [la, lb] = [c.screenTrack(), c.screenTrack()]
  room.emit(RoomEvent.LocalTrackPublished, { source: 'screen_share', track: la }, local)
  room.emit(RoomEvent.LocalTrackPublished, { source: 'screen_share', track: lb }, local)
  room.emit(RoomEvent.LocalTrackUnpublished, { source: 'screen_share', track: la }, local)
  assert.deepEqual(c.shown(), [['me', 'wall']])
  assert.equal(c.livekit.screens[0].track, lb)
  assert.equal(c.livekit.status.screenshare, 'wall')
  room.emit(RoomEvent.LocalTrackUnpublished, { source: 'screen_share', track: lb }, local)
  assert.deepEqual(c.shown(), [])
  assert.equal(c.livekit.status.screenshare, null)
})

test("voice room: this client's microphone status and speaking follow the room", async () => {
  const c = client()
  const me = c.player('me')
  const room = await c.join()
  const local = room.localParticipant
  const mic = () => c.livekit.status.mic
  room.emit(RoomEvent.LocalTrackPublished, { source: 'microphone', track: c.micTrack() }, local)
  assert.equal(mic(), true)
  room.emit(RoomEvent.TrackMuted, { isLocal: true, source: 'microphone' }, local)
  assert.equal(mic(), false)
  room.emit(RoomEvent.TrackUnmuted, { isLocal: true, source: 'microphone' }, local)
  assert.equal(mic(), true)
  // another player's microphone is not this client's
  room.emit(RoomEvent.TrackMuted, { isLocal: false, source: 'microphone' }, c.participant('p1'))
  assert.equal(mic(), true)
  room.emit(RoomEvent.LocalTrackUnpublished, { source: 'microphone', track: null }, local)
  assert.equal(mic(), false)
  local.emit(ParticipantEvent.IsSpeakingChanged, true)
  assert.deepEqual(me.speaking, [true])
})

test('voice room: a track of someone who is not a player here is ignored', async t => {
  t.mock.method(console, 'error', () => {})
  const c = client()
  const room = await c.join()
  room.emit(RoomEvent.TrackSubscribed, c.screenTrack(), {}, c.participant('ghost', 'stage'))
  room.emit(RoomEvent.TrackSubscribed, c.micTrack(), {}, c.participant('ghost', 'stage'))
  assert.deepEqual(c.shown(), [])
  assert.equal(c.livekit.shares.size, 0)
  assert.equal(c.livekit.voices.size, 0)
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
