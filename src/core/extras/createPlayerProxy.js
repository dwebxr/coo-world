import { callForScript } from './scriptValues.js'
import { getRef } from '../nodes/Node'
import { clamp, uuid } from '../utils'
import * as THREE from './three'
import { sanitizePlayerSelfModify } from './entityModifyPolicy'

import { readVec3, warnOnce } from './physxConvert.js'

const _v = new THREE.Vector3()
const HEALTH_MAX = 100
const balanceWarnings = new WeakSet()

export function createPlayerProxy(entity, player) {
  const world = player.world
  const position = new THREE.Vector3()
  const rotation = new THREE.Euler()
  const quaternion = new THREE.Quaternion()
  let activeEffectConfig = null
  let voiceMod
  // a client script changes another player only through a server script: on a remote player these calls
  // do nothing here, said once per method because scripts tend to call them every frame
  const warned = new Set()
  const remoteOnClient = method => {
    if (warned.has(method)) return
    warned.add(method)
    console.error(`[player] ${method} on a remote player must be called on the server`)
  }
  const proxy = {
    get networkId() {
      return player.data.owner
    },
    get id() {
      return player.data.id
    },
    get userId() {
      return player.data.userId
    },
    get local() {
      return player.data.id === world.network.id
    },
    get admin() {
      return player.isAdmin()
    },
    get builder() {
      return player.isBuilder()
    },
    get isAdmin() {
      return player.isAdmin() // deprecated, use .admin
    },
    get name() {
      return player.data.name
    },
    get health() {
      return player.data.health
    },
    get position() {
      return position.copy(player.base.position)
    },
    get rotation() {
      return rotation.copy(player.base.rotation)
    },
    get quaternion() {
      return quaternion.copy(player.base.quaternion)
    },
    get height() {
      return player.avatar?.getHeight()
    },
    get headToHeight() {
      return player.avatar?.getHeadToHeight()
    },
    get destroyed() {
      return !!player.destroyed
    },
    getTokenBalance() {
      const run = entity.getDeadHook()
      return new Promise(resolve => {
        const settle = value => {
          if (run.dead || entity.crashed || entity.destroyed || world.fatalError) return
          const verified = value?.verified === true
          const known = verified && value?.known === true && Number.isFinite(value.balance) && value.balance >= 0
          resolve(Object.freeze({ verified, known, balance: known ? value.balance : 0 }))
        }
        const unavailable = !world.network.isClient || player.data.id !== world.network.id
        if (unavailable && !balanceWarnings.has(entity)) {
          balanceWarnings.add(entity)
          console.warn('[player] getTokenBalance is available only for the local player in client scripts')
        }
        let result
        try {
          if (!unavailable && world.solana) result = world.network.tokenBalance.get()
        } catch {
          // Operational failures resolve unknown and never cross the script boundary.
          result = { verified: world.solana?.isVerified() === true }
        }
        Promise.resolve(result).then(settle, () => settle({ verified: world.solana?.isVerified() === true }))
      })
    },
    teleport(position, rotationY) {
      if (player.data.owner !== world.network.id && world.network.isClient) {
        remoteOnClient('teleport')
        return
      }
      if (!readVec3(position, _v, '[player] teleport position must be Vector3')) {
        warnOnce('[player] teleport ignored a non-finite position')
        return
      }
      const payload = { position: [_v.x, _v.y, _v.z] }
      if (Number.isFinite(rotationY)) payload.rotationY = rotationY
      if (player.data.owner === world.network.id) {
        // if player is local we can set directly
        world.network.enqueue('onPlayerTeleport', payload)
      } else {
        // if we're the server we need to notify the player
        world.network.sendTo(player.data.owner, 'playerTeleport', payload)
      }
    },
    getBoneTransform(boneName) {
      return player.avatar?.getBoneTransform?.(boneName)
    },
    setSessionAvatar(url) {
      const avatar = url
      if (player.data.owner === world.network.id) {
        // if player is local we can set directly
        world.network.enqueue('onPlayerSessionAvatar', { avatar })
      } else if (world.network.isClient) {
        remoteOnClient('setSessionAvatar')
      } else {
        // if we're the server we need to notify the player
        world.network.sendTo(player.data.owner, 'playerSessionAvatar', { avatar })
      }
    },
    damage(amount) {
      const health = clamp(player.data.health - amount, 0, HEALTH_MAX)
      if (player.data.health === health) return
      if (world.network.isServer) {
        world.network.send('entityModified', { id: player.data.id, health })
      }
      player.modify({ health })
    },
    heal(amount = HEALTH_MAX) {
      const health = clamp(player.data.health + amount, 0, HEALTH_MAX)
      if (player.data.health === health) return
      if (world.network.isServer) {
        world.network.send('entityModified', { id: player.data.id, health })
      }
      player.modify({ health })
    },
    hasEffect() {
      return !!player.data.effect
    },
    applyEffect(opts) {
      if (!opts) return
      const effect = {}
      // effect.id = uuid()
      if (opts.anchor) effect.anchorId = opts.anchor.anchorId
      if (opts.emote) effect.emote = opts.emote
      if (opts.snare) effect.snare = opts.snare
      if (opts.freeze) effect.freeze = opts.freeze
      if (opts.turn) effect.turn = opts.turn
      if (opts.duration) effect.duration = opts.duration
      if (opts.cancellable) {
        effect.cancellable = opts.cancellable
        delete effect.freeze // overrides
      }
      const safe = sanitizePlayerSelfModify({ ef: effect }, player.data.id)
      if (!safe || !Object.prototype.hasOwnProperty.call(safe, 'ef')) return
      const config = {
        effect: safe.ef,
        onEnd: () => {
          if (activeEffectConfig !== config) return
          activeEffectConfig = null
          player.setEffect(null)
          if (!entity.crashed && !world.fatalError) opts.onEnd?.call(undefined)
        },
      }
      activeEffectConfig = config
      player.setEffect(config.effect, config.onEnd)
      if (world.network.isServer) {
        world.network.send('entityModified', { id: player.data.id, ef: config.effect })
      }
      return {
        get active() {
          return activeEffectConfig === config
        },
        cancel: () => {
          config.onEnd()
        },
      }
    },
    cancelEffect() {
      activeEffectConfig?.onEnd()
    },
    push(force) {
      if (player.data.owner !== world.network.id && world.network.isClient) {
        remoteOnClient('push')
        return
      }
      if (!readVec3(force, _v, '[player] push force must be Vector3')) {
        warnOnce('[player] push ignored a non-finite force')
        return
      }
      const values = [_v.x, _v.y, _v.z]
      if (player.data.owner === world.network.id) {
        // if player is local we can set directly
        player.push(values)
      } else {
        // if we're the server we need to notify the player
        world.network.sendTo(player.data.owner, 'playerPush', { force: values })
      }
    },
    screenshare(targetId) {
      if (!targetId) {
        return console.error(`screenshare has invalid targetId: ${targetId}`)
      }
      if (player.data.owner !== world.network.id) {
        return console.error('screenshare can only be called on local player')
      }
      world.livekit.setScreenShareTarget(targetId)
    },
    setVoiceLevel(level) {
      if (!world.network.isServer) {
        return console.error(`[setVoiceLevel] must be applied on the server`)
      }
      if (!level && !voiceMod) {
        return // no modifiers to remove, this is a noop
      }
      if (!level && voiceMod) {
        voiceMod = world.livekit.removeModifier(voiceMod)
        return
      }
      if (level && !voiceMod) {
        voiceMod = world.livekit.addModifier(player.data.id, level)
        return
      }
      if (level && voiceMod) {
        voiceMod = world.livekit.updateModifier(voiceMod, level)
        return
      }
    },
    $cleanup() {
      activeEffectConfig?.onEnd()
      if (voiceMod) {
        voiceMod = world.livekit.removeModifier(voiceMod)
      }
    },
  }
  if (world.network.isServer) {
    for (const name of [
      'teleport',
      'setSessionAvatar',
      'damage',
      'heal',
      'applyEffect',
      'cancelEffect',
      'push',
      'setVoiceLevel',
    ]) {
      const method = proxy[name]
      proxy[name] = (...args) => world.network.asScript(() => method(...args), entity, name)
    }
  }
  for (const name of ['push', 'teleport', 'getTokenBalance']) {
    const method = proxy[name]
    proxy[name] = (...args) => callForScript(method, entity, args)
  }
  return proxy
}
