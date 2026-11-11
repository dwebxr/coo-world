import { AccessToken, TrackSource } from 'livekit-server-sdk'

import { System } from './System'
import { uuid } from '../utils'

const levels = ['disabled', 'spatial', 'global']
// how many muted user ids are kept (they travel in every join snapshot)
const MUTED_MAX = 1024

const levelPriorities = {
  disabled: 1,
  spatial: 2,
  global: 3,
}

export class ServerLiveKit extends System {
  constructor(world) {
    super(world)
    this.roomId = uuid()
    this.wsUrl = process.env.LIVEKIT_WS_URL
    this.apiKey = process.env.LIVEKIT_API_KEY
    this.apiSecret = process.env.LIVEKIT_API_SECRET
    this.enabled = this.wsUrl && this.apiKey && this.apiSecret
    this.modifiers = {} // [playerId] => Set({ level })
    // [playerId] => level (disabled, spatial, global), only for players a script gave one: no entry means the
    // world's default
    this.levels = {}
    // the user ids a moderator muted, oldest first. Kept when the player leaves, so a reconnect does not lift a
    // mute; not stored, so a restart does
    this.muted = new Set()
  }

  async serialize(playerId) {
    if (!this.enabled) return null
    const data = {}
    data.wsUrl = this.wsUrl
    data.levels = this.levels
    data.muted = this.muted
    // generate voice access token for the player
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: playerId,
    })
    const videoGrant = {
      room: this.roomId,
      roomJoin: true,
      canSubscribe: true,
      canPublish: true,
      // a microphone and a screen: nothing publishes or plays a screen's audio, a camera or data messages
      canPublishSources: [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE],
      canPublishData: false,
      // a share names its screen in its participant's metadata (ClientLiveKit.setScreenShareTarget)
      canUpdateOwnMetadata: true,
    }
    at.addGrant(videoGrant)
    data.token = await at.toJwt()
    return data
  }

  // A mute is carried out by the clients that listen: each stops playing that player's voice and showing their
  // screen share (ClientLiveKit.setMuted). The muted player's own client still sends its microphone to the voice
  // server; no client that follows this plays it. The caller has checked who mutes whom (ServerNetwork.onMute).
  // The list holds at most MUTED_MAX ids: at the limit the longest-muted player who is not here is unmuted, said to
  // everyone so that clients agree, and with nobody absent the new mute is not made.
  // -> whether the list now says what was asked
  setMuted(playerId, muted) {
    if (muted === this.muted.has(playerId)) return true
    if (!muted) {
      this.muted.delete(playerId)
      this.world.network.send('mute', { playerId, muted: false })
      return true
    }
    if (this.muted.size >= MUTED_MAX) {
      let absent
      for (const id of this.muted) {
        if (!this.world.entities.getPlayer(id)) {
          absent = id
          break
        }
      }
      if (absent === undefined) return false
      this.muted.delete(absent)
      this.world.network.send('mute', { playerId: absent, muted: false })
    }
    this.muted.add(playerId)
    this.world.network.send('mute', { playerId, muted: true })
    return true
  }

  addModifier(playerId, level) {
    if (!levels.includes(level)) return console.error(`[livekit] invalid level: ${level}`)
    let modifiers = this.modifiers[playerId]
    if (!modifiers) {
      modifiers = new Set()
      this.modifiers[playerId] = modifiers
    }
    const mod = { playerId, level }
    modifiers.add(mod)
    this.checkLevel(playerId)
    return mod
  }

  updateModifier(mod, level) {
    if (!levels.includes(level)) return console.error(`[livekit] invalid level: ${level}`)
    const playerId = mod.playerId
    const modifiers = this.modifiers[playerId]
    if (!modifiers) return
    if (!modifiers.has(mod)) return console.error('updateModifier: mod not found')
    mod.level = level
    this.checkLevel(playerId)
    return mod
  }

  removeModifier(mod) {
    const playerId = mod.playerId
    const modifiers = this.modifiers[playerId]
    if (!modifiers) return
    modifiers.delete(mod)
    this.checkLevel(playerId)
    return null
  }

  clearModifiers(playerId) {
    delete this.modifiers[playerId]
    this.checkLevel(playerId)
  }

  checkLevel(playerId) {
    const modifiers = this.modifiers[playerId]
    let level = null
    if (modifiers) {
      for (const mod of modifiers) {
        const currPriority = levelPriorities[level] || 0
        const modPriority = levelPriorities[mod.level]
        if (modPriority > currPriority) {
          level = mod.level
        }
      }
    }
    // No entry is the world's default. A null used to be stored for every player who left (clearModifiers), and
    // said to everyone: one key per user id ever seen, kept for the process's life and sent in every snapshot
    if ((this.levels[playerId] ?? null) === level) {
      return // no change
    }
    if (level === null) delete this.levels[playerId]
    else this.levels[playerId] = level
    this.world.network.send('liveKitLevel', { playerId, level })
  }
}
