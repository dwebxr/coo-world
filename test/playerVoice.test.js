import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as THREE from 'three'
import { loadClient } from './lib/clientHarness.mjs'
import { mouthTarget, nextMouth, quantizeMouth } from '../src/core/extras/voiceLevel.js'

const ParticipantEvent = { IsSpeakingChanged: 'isSpeakingChanged' }

function harness() {
  const taps = []
  const createVoiceTap = (ctx, stream) => {
    const tap = { stream, level: 0, destroyed: false, rms: () => tap.level, destroy: () => (tap.destroyed = true) }
    taps.push(tap)
    return tap
  }
  const deps = {
    Participant: class {},
    ParticipantEvent,
    Room: class {},
    RoomEvent: {},
    ScreenSharePresets: {},
    Track: {},
    THREE,
    System: class extends EventEmitter {
      constructor(world) {
        super()
        this.world = world
      }
    },
    isBoolean: v => typeof v === 'boolean',
    TrackSource: {},
    prepareVideoElement: () => {},
    createVoiceTap,
    mouthTarget,
    nextMouth,
    quantizeMouth,
  }
  const PlayerVoice = loadClient('core/systems/ClientLiveKit.js', 'PlayerVoice', deps)
  const ClientLiveKit = loadClient('core/systems/ClientLiveKit.js', 'ClientLiveKit', deps)
  return { PlayerVoice, ClientLiveKit, taps }
}

function audioNode() {
  const node = { connected: [], disconnected: 0 }
  node.connect = target => node.connected.push(target)
  node.disconnect = () => node.disconnected++
  return node
}

function setup({ lipsync = true, level = 'spatial', muted = false } = {}) {
  const h = harness()
  const nodes = []
  const ctx = {
    state: 'running',
    currentTime: 0,
    createGain: () => {
      const n = Object.assign(audioNode(), { gain: { value: 1 } })
      nodes.push(n)
      return n
    },
    createPanner: () => {
      const n = Object.assign(audioNode(), { setPosition() {}, setOrientation() {} })
      nodes.push(n)
      return n
    },
  }
  const mouths = []
  const instance = { setMouth: v => mouths.push(v) }
  const player = {
    data: { id: 'p1' },
    base: { matrixWorld: new THREE.Matrix4() },
    avatar: { instance },
    speaking: false,
    setSpeaking(v) {
      this.speaking = v
    },
  }
  const camera = new THREE.Object3D()
  camera.updateMatrixWorld()
  const world = {
    audio: { ctx, groupGains: { voice: audioNode() }, lastDelta: 0 },
    camera,
    livekit: new EventEmitter(),
  }
  const participant = new EventEmitter()
  const track = {
    mediaStream: { id: 'stream' },
    attached: 0,
    detached: 0,
    setAudioContext() {},
    setWebAudioPlugins() {},
    attach() {
      this.attached++
    },
    detach() {
      this.detached++
    },
  }
  const voice = new h.PlayerVoice(world, player, level, muted, track, participant, lipsync)
  return { ...h, voice, world, player, participant, track, instance, mouths, nodes, ctx, camera }
}

const frames = (voice, n, delta = 1 / 60) => {
  for (let i = 0; i < n; i++) voice.lateUpdate(delta)
}

test('player voice: loud audio opens the mouth, silence closes it, writes only on change', () => {
  const s = setup({ level: 'global' })
  assert.equal(s.taps.length, 1)
  assert.equal(s.taps[0].stream, s.track.mediaStream)
  assert.equal(s.track.attached, 1)
  s.taps[0].level = 0.3
  frames(s.voice, 30)
  assert.equal(s.mouths.at(-1), 1)
  const writes = s.mouths.length
  frames(s.voice, 10)
  assert.equal(s.mouths.length, writes, 'a steady open mouth is not rewritten')
  s.taps[0].level = 0
  frames(s.voice, 60)
  assert.equal(s.mouths.at(-1), 0)
  const closed = s.mouths.length
  frames(s.voice, 10)
  assert.equal(s.mouths.length, closed, 'a closed mouth is not rewritten')
})

test('player voice: speaking=false from LiveKit does not hold the mouth shut', () => {
  const s = setup({ level: 'global' })
  s.player.speaking = false
  s.taps[0].level = 0.3
  frames(s.voice, 30)
  assert.equal(s.mouths.at(-1), 1)
})

for (const [name, change] of [
  ['moderator mute', s => s.voice.setMuted(true)],
  ['disabled level', s => s.voice.setLevel('disabled')],
  ['suspended audio', s => (s.ctx.state = 'suspended')],
  ['far away', s => s.camera.position.set(0, 0, 21) && s.camera.updateMatrixWorld()],
]) {
  test(`player voice: ${name} closes the mouth and stops sampling`, () => {
    const s = setup({ level: 'global' })
    s.taps[0].level = 0.3
    frames(s.voice, 30)
    assert.equal(s.mouths.at(-1), 1)
    change(s)
    let sampled = 0
    s.taps[0].rms = () => (sampled++, 0.3)
    frames(s.voice, 60)
    assert.equal(s.mouths.at(-1), 0)
    assert.equal(sampled, 0)
  })
}

test('player voice: a rebuilt avatar gets the current level; no avatar means no writes', () => {
  const s = setup({ level: 'global' })
  s.taps[0].level = 0.3
  frames(s.voice, 30)
  const rebuilt = []
  s.player.avatar.instance = { setMouth: v => rebuilt.push(v) }
  frames(s.voice, 1)
  assert.equal(rebuilt.at(-1), 1)
  s.player.avatar.instance = null
  frames(s.voice, 5)
  assert.equal(rebuilt.length, 1)
})

test('player voice: lip sync off tears the tap down and closes the mouth; on builds it again', () => {
  const s = setup({ level: 'global' })
  s.taps[0].level = 0.3
  frames(s.voice, 30)
  s.voice.setLipsync(false)
  assert.equal(s.taps[0].destroyed, true)
  assert.equal(s.mouths.at(-1), 0)
  const writes = s.mouths.length
  frames(s.voice, 10)
  assert.equal(s.mouths.length, writes)
  s.voice.setLipsync(true)
  assert.equal(s.taps.length, 2)
  s.voice.setLipsync(true)
  assert.equal(s.taps.length, 2)
})

test('player voice: lip sync off from the start builds no tap and never writes', () => {
  const s = setup({ lipsync: false, level: 'global' })
  assert.equal(s.taps.length, 0)
  frames(s.voice, 10)
  assert.deepEqual(s.mouths, [0])
})

test('player voice: destroy releases the speaking listener, tap and audio nodes and closes the mouth', () => {
  const s = setup()
  assert.equal(s.participant.listenerCount(ParticipantEvent.IsSpeakingChanged), 1)
  s.taps[0].level = 0.3
  frames(s.voice, 30)
  s.voice.destroy()
  assert.equal(s.participant.listenerCount(ParticipantEvent.IsSpeakingChanged), 0)
  assert.equal(s.taps[0].destroyed, true)
  assert.equal(s.mouths.at(-1), 0)
  assert.equal(s.track.detached, 1)
  assert.ok(
    s.nodes.every(n => n.disconnected === 1),
    'root and panner disconnected'
  )
})

test('livekit: a re-subscribe destroys the old voice and prefs toggle lip sync on every voice', () => {
  const s = setup()
  const prefs = new EventEmitter()
  prefs.lipsync = true
  const settings = new EventEmitter()
  settings.voice = 'spatial'
  const player = s.player
  const world = {
    ...s.world,
    prefs,
    settings,
    entities: { getPlayer: id => (id === 'p1' ? player : null) },
  }
  const livekit = new s.ClientLiveKit(world)
  world.livekit = livekit
  livekit.start()
  const participant = new EventEmitter()
  participant.identity = 'p1'
  const track = () => ({ ...s.track, source: 'microphone', setAudioContext() {}, setWebAudioPlugins() {} })
  livekit.onTrackSubscribed(track(), {}, participant)
  const first = livekit.voices.get('p1')
  livekit.onTrackSubscribed(track(), {}, participant)
  const second = livekit.voices.get('p1')
  assert.notEqual(first, second)
  assert.equal(first.tap, null, 'old voice destroyed')
  assert.equal(participant.listenerCount(ParticipantEvent.IsSpeakingChanged), 1)
  livekit.onPrefsChange({ lipsync: { prev: true, value: false } })
  assert.equal(second.tap, null)
  livekit.onPrefsChange({ lipsync: { prev: false, value: true } })
  assert.ok(second.tap)
  livekit.room = null
  livekit.destroy()
  assert.equal(prefs.listenerCount('change'), 0)
  assert.equal(settings.listenerCount('change'), 0)
})
