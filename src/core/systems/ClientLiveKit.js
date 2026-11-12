import { ParticipantEvent, Room, RoomEvent, ScreenSharePresets } from 'livekit-client'
import * as THREE from '../extras/three'

import { System } from './System'
import { isBoolean } from 'lodash-es'
import { prepareVideoElement } from './ClientLoader'
import { createVoiceTap } from '../extras/voiceTap'
import { mouthTarget, nextMouth, quantizeMouth } from '../extras/voiceLevel'
import { screenTarget } from '../extras/screenShare'

const v1 = new THREE.Vector3()
const v2 = new THREE.Vector3()
const v3 = new THREE.Vector3()
const q1 = new THREE.Quaternion()

// beyond this a speaker's mouth stays closed and its voice is not sampled
const LIPSYNC_MAX_DISTANCE = 20
let lipsyncWarned = false

export class ClientLiveKit extends System {
  constructor(world) {
    super(world)
    this.room = null
    this.status = {
      available: false,
      connected: false,
      mic: false,
      screenshare: null,
      level: null,
    }
    this.defaultLevel = null
    this.levels = {}
    this.muted = new Set()
    this.voices = new Map() // playerId -> PlayerVoice
    // playerId -> what that player shares ({ targetId, track }); its screen is shown while the player is not muted
    this.shares = new Map()
    this.screens = []
    this.screenNodes = new Set() // Video
    // the screen this client last asked its share to be shown on (its metadata; a token carries none)
    this.screenTargetAsked = null
    // the screen this client wants its share on (null: no share), as asked last. Apart from screenTargetAsked,
    // which is forgotten when the voice server does not confirm the metadata so that it is written again: a
    // metadata request that timed out says nothing about what the player wants
    this.screenTargetWanted = null
    // this client is out of the world (kicked or disconnected) and so out of the voice room
    this.left = false
  }

  start() {
    this.defaultLevel = this.world.settings.voice
    this.status.level = this.defaultLevel
    this.world.settings.on('change', this.onSettingsChange)
    this.world.prefs?.on('change', this.onPrefsChange)
    this.world.on('kick', this.leave)
    this.world.on('disconnect', this.leave)
  }

  // Out of the world is out of the voice room. The room is a connection of its own, to another server: when the
  // world's connection ended (a kick, a lost connection) it stayed open, so a kicked player kept talking to
  // everyone and kept hearing them. The page does not reconnect by itself, so this is final.
  leave = () => {
    if (this.left) return
    this.left = true
    // disconnect() takes a while, and the room keeps reporting tracks and metadata until it is done: what arrives
    // meanwhile must not bring back what is ended here
    if (this.room) this.stopListening()
    this.voices.forEach(voice => voice.destroy())
    this.voices.clear()
    this.shares.clear()
    for (const screen of [...this.screens]) this.removeScreen(screen)
    this.status.connected = false
    this.status.mic = false
    this.status.screenshare = null
    this.emit('status', this.status)
    // disconnect() is async; a failure leaves nothing to do
    Promise.resolve(this.room?.disconnect()).catch(() => {})
  }

  // A player left the world (PlayerRemote.destroy): what they say and show ends here, whatever the voice room says.
  // A kicked player whose client stays in the room, or comes back into it with its voice token, is in nobody's
  // world: its tracks are dropped here and ignored when they arrive (onTrackSubscribed).
  // A player who joins the world again while the room still holds the tracks dropped here is silent, and their share
  // is not shown, until their client publishes again. A client running this code leaves the room with the world
  // (leave) and a page that joins again publishes new tracks; only a client that stayed in the room keeps old ones.
  dropPlayer(playerId) {
    const voice = this.voices.get(playerId)
    if (voice) {
      voice.destroy()
      this.voices.delete(playerId)
    }
    this.setShare(playerId, null)
  }

  onPrefsChange = changes => {
    if (!changes.lipsync) return
    this.voices.forEach(voice => voice.setLipsync(changes.lipsync.value))
  }

  onSettingsChange = changes => {
    if (changes.voice) {
      this.defaultLevel = changes.voice.value
      const myLevel = this.levels[this.world.network.id] || this.defaultLevel
      if (this.status.level !== myLevel) {
        this.status.level = myLevel
        this.emit('status', this.status)
      }
      this.voices.forEach(voice => {
        const level = this.levels[voice.player.data.id] || this.defaultLevel
        voice.setLevel(level)
      })
    }
  }

  async deserialize(opts) {
    if (!opts) return
    this.status.available = true
    this.status.muted = opts.muted.has(this.world.network.id)
    this.levels = opts.levels
    this.muted = opts.muted
    this.room = new Room({
      webAudioMix: {
        audioContext: this.world.audio.ctx,
      },
      publishDefaults: {
        screenShareEncoding: ScreenSharePresets.h1080fps30.encoding,
        screenShareSimulcastLayers: [ScreenSharePresets.h1080fps30],
      },
    })
    this.room.on(RoomEvent.TrackMuted, this.onTrackMuted)
    this.room.on(RoomEvent.TrackUnmuted, this.onTrackUnmuted)
    this.room.on(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished)
    this.room.on(RoomEvent.LocalTrackUnpublished, this.onLocalTrackUnpublished)
    this.room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed)
    this.room.on(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed)
    this.room.on(RoomEvent.ParticipantMetadataChanged, this.onMetadataChanged)
    this.room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, this.onLocalSpeaking)
    this.world.audio.ready(async () => {
      // audio becomes ready on the player's first touch, which may come after the world's connection has ended
      if (this.left) return
      // A voice server that cannot be reached (or refuses the token) is said here and voice stays unconnected. It
      // used to be an unhandled rejection: nothing awaits this callback (ClientAudio.ready, or its queue).
      try {
        await this.room.connect(opts.wsUrl, opts.token)
      } catch (err) {
        if (!this.left) console.error('[livekit] could not connect to the voice room:', err)
        return
      }
      if (this.left) return this.room.disconnect()
      this.status.connected = true
      this.emit('status', this.status)
    })
  }

  onLocalSpeaking = speaking => {
    if (this.left) return
    const player = this.world.entities.player
    this.world.livekit.emit('speaking', { playerId: player.data.id, speaking })
    player.setSpeaking(speaking)
  }

  // The room's events followed since deserialize, no longer followed (leave, destroy). Taking a listener off does
  // not stop a delivery that is already under way (an emitter calls the listeners it had when the event began), so
  // every handler also looks at `left` itself.
  stopListening() {
    this.room.off(RoomEvent.TrackMuted, this.onTrackMuted)
    this.room.off(RoomEvent.TrackUnmuted, this.onTrackUnmuted)
    this.room.off(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished)
    this.room.off(RoomEvent.LocalTrackUnpublished, this.onLocalTrackUnpublished)
    this.room.off(RoomEvent.TrackSubscribed, this.onTrackSubscribed)
    this.room.off(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed)
    this.room.off(RoomEvent.ParticipantMetadataChanged, this.onMetadataChanged)
    this.room.localParticipant?.off(ParticipantEvent.IsSpeakingChanged, this.onLocalSpeaking)
  }

  setMuted(playerId, muted) {
    if (muted && this.muted.has(playerId)) return
    if (!muted && !this.muted.has(playerId)) return
    if (muted) {
      this.muted.add(playerId)
    } else {
      this.muted.delete(playerId)
    }
    const voice = this.voices.get(playerId)
    voice?.setMuted(muted)
    // a mute covers what the player shows too, and ends a speaking state that was on when it came
    this.syncScreen(playerId)
    if (muted) this.world.entities.getPlayer(playerId)?.setSpeaking(false)
    this.emit('muted', { playerId, muted })
    if (playerId === this.world.network.id) {
      this.status.muted = muted
      this.emit('status', this.status)
    }
  }

  isMuted(playerId) {
    return this.muted.has(playerId)
  }

  setLevel(playerId, level) {
    // no level of their own: the world's default (the server sends null and keeps no entry either)
    if (level) this.levels[playerId] = level
    else delete this.levels[playerId]
    level = level || this.defaultLevel
    if (playerId === this.world.network.id) {
      if (this.status.level !== level) {
        this.status.level = level
        this.emit('status', this.status)
      }
      return
    }
    const voice = this.voices.get(playerId)
    voice?.setLevel(level) // disabled, spatial, global
  }

  lateUpdate(delta) {
    this.voices.forEach(voice => {
      voice.lateUpdate(delta)
    })
  }

  setMicrophoneEnabled(value) {
    if (!this.room) return console.error('[livekit] setMicrophoneEnabled failed (not connected)')
    // out of the room for good (leave): nothing is published again
    if (this.left) return
    value = isBoolean(value) ? value : !this.room.localParticipant.isMicrophoneEnabled
    if (this.status.mic === value) return
    // a refused microphone (no permission, no device) is said in the console and leaves the status as it is
    this.ask(() => this.room.localParticipant.setMicrophoneEnabled(value), 'microphone')
  }

  // One request to the room, made now (a capture must be asked for inside the player's gesture) and never left as
  // an unhandled rejection: a closed screen picker, a refused permission and a lost connection all reject.
  ask(request, what) {
    let asked
    try {
      asked = Promise.resolve(request())
    } catch (err) {
      asked = Promise.reject(err)
    }
    asked.catch(err => console.warn(`[livekit] ${what}: ${err?.message ?? err}`))
  }

  setScreenShareTarget(targetId = null) {
    if (!this.room) return console.error('[livekit] setScreenShareTarget failed (not connected)')
    if (this.left) return
    this.screenTargetWanted = targetId
    // Nothing to do when the screen asked for last is this one and a share is published exactly when one is named.
    // Not decided by the status: that follows the published share and the metadata the voice server has confirmed,
    // which come after the ask and in either order, so a stop or a change asked meanwhile would be skipped
    const sharing = this.shares.has(this.world.network.id)
    if (targetId === this.screenTargetAsked && sharing === (targetId !== null)) return
    if (targetId !== this.screenTargetAsked) {
      this.screenTargetAsked = targetId
      this.room.localParticipant.setMetadata(JSON.stringify({ screenTargetId: targetId })).catch(() => {
        // not confirmed: the next ask writes it again
        if (this.screenTargetAsked === targetId) this.screenTargetAsked = undefined
      })
    }
    // with a share published, true keeps it and false unpublishes it; one still being published is waited for
    this.ask(() => this.room.localParticipant.setScreenShareEnabled(!!targetId), 'screen share')
  }

  // This client's share was just published: one nobody asks for any more is ended. The room waits only so long for
  // a capture the player is still choosing, so a stop asked while the picker was open may have ended nothing, and
  // the capture started afterwards. The other way round cannot be mended from here: a start that lost to an older
  // stop ends with nothing shared (a capture needs the player's gesture); the status says so, and asking again
  // starts it.
  settleShare() {
    if (this.left || !this.room) return
    if (this.screenTargetWanted !== null || !this.shares.has(this.world.network.id)) return
    this.ask(() => this.room.localParticipant.setScreenShareEnabled(false), 'screen share')
  }

  onTrackMuted = track => {
    if (this.left) return
    if (track.isLocal && track.source === 'microphone') {
      this.status.mic = false
      this.emit('status', this.status)
    }
  }

  onTrackUnmuted = track => {
    if (this.left) return
    if (track.isLocal && track.source === 'microphone') {
      this.status.mic = true
      this.emit('status', this.status)
    }
  }

  onLocalTrackPublished = publication => {
    if (this.left) return
    const track = publication.track
    const playerId = this.world.network.id
    if (publication.source === 'microphone') {
      this.status.mic = true
      this.emit('status', this.status)
    }
    if (publication.source === 'screen_share') {
      this.setShare(playerId, { targetId: screenTarget(this.room.localParticipant.metadata), track })
      this.settleShare()
    }
  }

  onLocalTrackUnpublished = publication => {
    if (this.left) return
    const playerId = this.world.network.id
    if (publication.source === 'microphone') {
      this.status.mic = false
      this.emit('status', this.status)
    }
    // (the publication still holds its track here; it lets go of it afterwards)
    if (publication.source === 'screen_share' && this.shares.get(playerId)?.track === publication.track) {
      this.setShare(playerId, null)
    }
  }

  onTrackSubscribed = (track, publication, participant) => {
    if (this.left) return
    const playerId = participant.identity
    const player = this.world.entities.getPlayer(playerId)
    if (!player) return console.error('onTrackSubscribed failed: no player')
    const world = this.world
    if (track.source === 'microphone') {
      // a re-subscribe replaces the voice; the old one must release its listener and nodes
      this.voices.get(playerId)?.destroy()
      const level = this.levels[playerId] || this.defaultLevel
      const muted = this.muted.has(playerId)
      const lipsync = this.world.prefs?.lipsync ?? false
      const voice = new PlayerVoice(world, player, level, muted, track, participant, lipsync)
      this.voices.set(playerId, voice)
    }
    if (track.source === 'screen_share') {
      this.setShare(playerId, { targetId: screenTarget(participant.metadata), track })
    }
  }

  // A share names its screen in its participant's metadata, which may arrive after the track or change during it
  onMetadataChanged = (prev, participant) => {
    if (this.left) return
    const share = this.shares.get(participant?.identity)
    if (!share) return
    const targetId = screenTarget(participant.metadata)
    if (targetId === share.targetId) return
    this.setShare(participant.identity, { ...share, targetId })
  }

  // What a player shares (null: nothing), and the screen made from it. For this client's own share the status says
  // the screen it is on: the track and the metadata naming the screen arrive in either order, and a change of
  // screen changes only the metadata
  setShare(playerId, share) {
    if (share) this.shares.set(playerId, share)
    else this.shares.delete(playerId)
    this.syncScreen(playerId)
    const targetId = share?.targetId ?? null
    if (playerId === this.world.network.id && this.status.screenshare !== targetId) {
      this.status.screenshare = targetId
      this.emit('status', this.status)
    }
  }

  // One screen for a player, when they share to a screen and are not muted: a mute hides the share on every
  // client that has the mute, and lifting it shows the share again while its track is still here.
  syncScreen(playerId) {
    const share = this.shares.get(playerId)
    const wanted = !!share && share.targetId !== null && !this.muted.has(playerId)
    const shown = this.screens.find(s => s.playerId === playerId)
    if (shown && wanted && shown.track === share.track && shown.targetId === share.targetId) return
    if (shown) this.removeScreen(shown)
    if (wanted) this.addScreen(createPlayerScreen({ world: this.world, playerId, ...share }))
  }

  // Only the track that is played or shown ends what it made: a participant can publish two tracks of one source
  // (the newer replaces the older here), and the older one's end must not take the newer with it. An older track
  // still subscribed when the newer one ends is not brought back.
  onTrackUnsubscribed = (track, publication, participant) => {
    if (this.left) return
    const playerId = participant.identity
    const voice = this.voices.get(playerId)
    if (track.source === 'microphone' && voice?.track === track) {
      voice.destroy()
      this.voices.delete(playerId)
    }
    if (track.source === 'screen_share' && this.shares.get(playerId)?.track === track) {
      this.setShare(playerId, null)
    }
  }

  addScreen(screen) {
    this.screens.push(screen)
    for (const node of this.screenNodes) {
      if (node._screenId === screen.targetId) {
        node.needsRebuild = true
        node.setDirty()
      }
    }
  }

  removeScreen(screen) {
    screen.destroy()
    this.screens = this.screens.filter(s => s !== screen)
    for (const node of this.screenNodes) {
      if (node._screenId === screen.targetId) {
        node.needsRebuild = true
        node.setDirty()
      }
    }
  }

  registerScreenNode(node) {
    this.screenNodes.add(node)
    let match
    for (const screen of this.screens) {
      if (screen.targetId === node._screenId) {
        match = screen
      }
    }
    return match
  }

  unregisterScreenNode(node) {
    this.screenNodes.delete(node)
  }

  destroy() {
    this.world.settings.off('change', this.onSettingsChange)
    this.world.prefs?.off('change', this.onPrefsChange)
    this.world.off('kick', this.leave)
    this.world.off('disconnect', this.leave)
    this.voices.forEach(voice => {
      voice.destroy()
    })
    this.voices.clear()
    this.shares.clear()
    this.screens.forEach(screen => {
      screen.destroy()
    })
    this.screens = []
    this.screenNodes.clear()
    if (this.room) {
      this.stopListening()
      this.room?.disconnect()
    }
  }
}

class PlayerVoice {
  constructor(world, player, level, muted, track, participant, lipsync = false) {
    this.world = world
    this.player = player
    this.level = level
    this.muted = muted
    this.track = track
    this.participant = participant
    this.track.setAudioContext(world.audio.ctx)
    this.root = world.audio.ctx.createGain()
    this.panner = world.audio.ctx.createPanner()
    this.panner.panningModel = 'HRTF'
    this.panner.panningModel = 'HRTF'
    this.panner.distanceModel = 'inverse'
    this.panner.refDistance = 1
    this.panner.maxDistance = 40
    this.panner.rolloffFactor = 3
    this.panner.coneInnerAngle = 360
    this.panner.coneOuterAngle = 360
    this.panner.coneOuterGain = 0
    this.gain = world.audio.groupGains.voice
    this.root.connect(this.gain)
    this.root.connect(this.panner)
    this.panner.connect(this.gain)
    this.track.attach()
    this.apply()
    this.onSpeakingChanged = speaking => {
      this.world.livekit.emit('speaking', { playerId: this.player.data.id, speaking })
      this.player.setSpeaking(speaking)
    }
    this.participant.on(ParticipantEvent.IsSpeakingChanged, this.onSpeakingChanged)
    // lip sync: a listen-only tap (after attach, so the remote stream already flows into WebAudio)
    this.tap = null
    this.mouth = 0
    this.mouthWritten = -1
    this.mouthInstance = null
    this.setLipsync(lipsync)
  }

  setLipsync(on) {
    if (on && !this.tap) {
      try {
        // only the microphone track: a stream holding several audio tracks would let the source pick another
        const stream = new MediaStream([this.track.mediaStreamTrack])
        this.tap = createVoiceTap(this.world.audio.ctx, stream)
      } catch (err) {
        if (!lipsyncWarned) console.warn('[livekit] lip sync unavailable:', err?.message)
        lipsyncWarned = true
        this.tap = null
      }
    }
    if (!on && this.tap) {
      this.tap.destroy()
      this.tap = null
      this.mouth = 0
      this.mouthInstance?.setMouth(0)
      this.mouthWritten = 0
    }
  }

  updateMouth(delta) {
    const instance = this.player.avatar?.instance ?? null
    if (instance !== this.mouthInstance) {
      // a rebuilt avatar starts closed; re-apply the current level to it
      this.mouthInstance = instance
      this.mouthWritten = -1
    }
    const active =
      !!this.tap &&
      !this.muted &&
      this.level !== 'disabled' &&
      !!instance &&
      this.world.audio.ctx.state === 'running' &&
      this.distanceToCamera() <= LIPSYNC_MAX_DISTANCE
    const target = active ? mouthTarget(this.tap.rms()) : 0
    this.mouth = nextMouth(this.mouth, target, delta)
    const value = quantizeMouth(this.mouth)
    if (instance && value !== this.mouthWritten) {
      instance.setMouth(value)
      this.mouthWritten = value
    }
  }

  distanceToCamera() {
    const pos = v1.setFromMatrixPosition(this.player.base.matrixWorld)
    const cam = v3.setFromMatrixPosition(this.world.camera.matrixWorld)
    return pos.distanceTo(cam)
  }

  setMuted(muted) {
    if (this.muted === muted) return
    this.muted = muted
    this.apply()
  }

  setLevel(level) {
    if (this.level === level) return
    this.level = level
    this.apply()
  }

  apply() {
    if (this.muted) {
      this.root.gain.value = 0
      this.track.setWebAudioPlugins([this.root])
    } else if (this.level === 'disabled') {
      this.root.gain.value = 0
      this.track.setWebAudioPlugins([this.root])
    } else if (this.level === 'spatial') {
      this.root.gain.value = 1
      this.track.setWebAudioPlugins([this.panner])
    } else if (this.level === 'global') {
      this.root.gain.value = 1
      this.track.setWebAudioPlugins([this.root])
    }
  }

  lateUpdate(delta) {
    this.updateMouth(delta)
    if (this.muted) return
    if (this.level !== 'spatial') return
    const audio = this.world.audio
    const matrix = this.player.base.matrixWorld
    const pos = v1.setFromMatrixPosition(matrix)
    const qua = q1.setFromRotationMatrix(matrix)
    const dir = v2.set(0, 0, -1).applyQuaternion(qua)
    if (this.panner.positionX) {
      const endTime = audio.ctx.currentTime + audio.lastDelta
      this.panner.positionX.linearRampToValueAtTime(pos.x, endTime)
      this.panner.positionY.linearRampToValueAtTime(pos.y, endTime)
      this.panner.positionZ.linearRampToValueAtTime(pos.z, endTime)
      this.panner.orientationX.linearRampToValueAtTime(dir.x, endTime)
      this.panner.orientationY.linearRampToValueAtTime(dir.y, endTime)
      this.panner.orientationZ.linearRampToValueAtTime(dir.z, endTime)
    } else {
      this.panner.setPosition(pos.x, pos.y, pos.z)
      this.panner.setOrientation(dir.x, dir.y, dir.z)
    }
  }

  destroy() {
    this.participant.off(ParticipantEvent.IsSpeakingChanged, this.onSpeakingChanged)
    this.tap?.destroy()
    this.tap = null
    this.mouthInstance?.setMouth(0)
    this.mouthInstance = null
    this.root.disconnect()
    this.panner.disconnect()
    this.world.livekit.emit('speaking', { playerId: this.player.data.id, speaking: false })
    this.player.setSpeaking(false)
    this.track.detach()
  }
}

function createPlayerScreen({ world, playerId, targetId, track }) {
  // NOTE: this follows the same construct in ClientLoader.js -> createVideoFactory
  // so that it is automatically compatible with the video node
  const elem = document.createElement('video')
  elem.playsInline = true
  elem.muted = true
  // elem.style.width = '1px'
  // elem.style.height = '1px'
  // elem.style.position = 'absolute'
  // elem.style.opacity = '0'
  // elem.style.zIndex = '-1000'
  // elem.style.pointerEvents = 'none'
  // elem.style.overflow = 'hidden'
  // document.body.appendChild(elem)
  track.attach(elem)
  // elem.play()
  const texture = new THREE.VideoTexture(elem)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = world.graphics.maxAnisotropy
  texture.needsUpdate = true
  const state = { width: undefined, height: undefined, ready: false }
  const prepare = prepareVideoElement(elem, state, { forcePlayOnMetadata: false, logDimensions: true })
  function isPlaying() {
    return true
    // return elem.currentTime > 0 && !elem.paused && !elem.ended && elem.readyState > 2
  }
  function play(restartIfPlaying = false) {
    // if (restartIfPlaying) elem.currentTime = 0
    // elem.play()
  }
  function pause() {
    // elem.pause()
  }
  function stop() {
    // elem.currentTime = 0
    // elem.pause()
  }
  function release() {
    // stop()
    // audio.disconnect()
    // track.detach()
    // texture.dispose()
    // document.body.removeChild(elem)
  }
  function destroy() {
    // the element stops receiving the track (a hidden share's track stays subscribed)
    track.detach(elem)
    texture.dispose()
    // help to prevent chrome memory leaks
    // see: https://github.com/facebook/react/issues/15583#issuecomment-490912533
    // elem.src = ''
    // elem.load()
  }
  const handle = {
    isScreen: true,
    playerId,
    targetId,
    track,
    elem,
    audio: null,
    texture,
    prepare,
    get ready() {
      return state.ready
    },
    get width() {
      return state.width
    },
    get height() {
      return state.height
    },
    get loop() {
      return false
      // return elem.loop
    },
    set loop(value) {
      // elem.loop = value
    },
    get isPlaying() {
      return isPlaying()
    },
    get currentTime() {
      return elem.currentTime
    },
    set currentTime(value) {
      elem.currentTime = value
    },
    play,
    pause,
    stop,
    release,
    destroy,
  }
  return handle
}
