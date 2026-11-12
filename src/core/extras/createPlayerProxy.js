import { callForScript } from './scriptValues.js'
import { stoppedError } from './physicsFailure.js'
import { Teardown, tornDown } from './runTeardown.js'
import { getRef } from '../nodes/Node'
import { clamp, uuid } from '../utils'
import * as THREE from './three'
import { isAvatarUrl, isEmoteUrl, rememberScriptEmote, sanitizePlayerSelfModify } from './entityModifyPolicy'
import { isPrimitive } from './scriptPrimitives.js'
import { toEngineNumber } from './engineNumber.js'

import { readVec3, warnOnce } from './physxConvert.js'

const _v = new THREE.Vector3()
const HEALTH_MAX = 100
const balanceWarnings = new WeakSet()
const holdingWarnings = new WeakSet()
const holdingSpecWarnings = new WeakSet()
const UNKNOWN_HOLDING = { verified: false, known: false, balance: 0 }

// スクリプトの spec はスクリプト側のオブジェクト (getter を持ち得る)。ここで一度だけ読み、プリミティブだけを写す
function readHoldingSpec(spec) {
  if (!spec || typeof spec !== 'object') return null
  const chainId = spec.chainId
  const contract = spec.contract
  const standard = spec.standard
  const tokenId = spec.tokenId
  const minBalance = spec.minBalance
  if (typeof chainId !== 'number' || typeof contract !== 'string' || typeof standard !== 'string') return null
  if (tokenId !== undefined && tokenId !== null && typeof tokenId !== 'string' && typeof tokenId !== 'number')
    return null
  if (minBalance !== undefined && (!Number.isSafeInteger(minBalance) || minBalance < 1)) return null
  return { chainId, contract, standard, tokenId: tokenId ?? undefined, minBalance: minBalance ?? 1 }
}

// the engine's teardown for each proxy, kept out of the object scripts hold (a script could replace or break a
// method on it); App.unbuild runs it through cleanupPlayerProxy
const cleanups = new WeakMap()
// what the engine knows about each proxy (never read from the proxy itself, which a script can change)
const handles = new WeakMap()

// A handle starts nothing that a cleanup would have to undo (an effect, a voice modifier) once it is retired: when it
// is evicted or cleaned up (its player left, its run ended), when its player has left, and for every handle of a run
// whose players teardown stage has started (runTeardown.js). Those calls throw; ending what exists (cancelEffect, an
// effect handle's cancel, setVoiceLevel(null)) still works.
export function retirePlayerProxy(proxy) {
  handles.get(proxy)?.retire()
}

// runs once per proxy: retired first, then cleaned up (so a callback the cleanup runs cannot start anything on it)
export function cleanupPlayerProxy(proxy) {
  retirePlayerProxy(proxy)
  const cleanup = cleanups.get(proxy)
  if (!cleanup) return
  cleanups.delete(proxy)
  cleanup()
}

// whether a cached proxy may still be handed out: its player is still there and its app run has not ended
export function isPlayerProxyCurrent(proxy) {
  const handle = handles.get(proxy)
  return !!handle && !handle.player.destroyed && handle.run === handle.entity.deadHook
}

// a script callback run by the host: no receiver, invoked without looking anything up on the function (a script
// can put its own `call` on it), and a throw is reported instead of escaping into host code
function callBack(fn) {
  if (typeof fn !== 'function') return
  try {
    Reflect.apply(fn, undefined, [])
  } catch (err) {
    console.error(err)
  }
}

// a player handle belongs to the app run that asked for it (App.getPlayerProxy); after that run, its methods throw
export function createPlayerProxy(entity, player) {
  const world = player.world
  const run = entity.deadHook
  let activeEffectConfig = null
  let voiceMod
  let retired = false
  // after a method has read its arguments (a getter, a toString or a Proxy trap is script code, which can end the
  // run): nothing lands for a run that ended meanwhile
  const assertRunAfterRead = () => {
    if (run !== entity.deadHook) throw stoppedError(entity)
  }
  // what a retired handle answers for a call that would start something
  const assertCanStart = () => {
    if (run !== entity.deadHook || tornDown(run, Teardown.PLAYERS)) throw stoppedError(entity)
    if (retired || player.destroyed) throw new Error('[player] this player has left')
  }
  // a client script changes another player only through a server script: on a remote player these calls
  // do nothing here, said once per method because scripts tend to call them every frame
  const warned = new Set()
  const remoteOnClient = method => {
    if (warned.has(method)) return
    warned.add(method)
    console.error(`[player] ${method} on a remote player must be called on the server`)
  }
  // This script ends its effect (cancel, cancelEffect, or the cleanup of its handle when the run ends): the same as
  // the host ending it (config.onEnd), and on the server the clients are told as well. Nothing else tells them: the
  // player's client ends an effect by itself only when its duration is over or, for a cancellable one, when the
  // player moves, so an effect a server script took back stayed on that client, for good when it had neither.
  // Told before the script's onEnd runs: an effect that callback applies goes out after this, not under it.
  // Not told when the end comes from the player (their client said so; ServerNetwork passes that on) or from another
  // effect taking this one's place (that one goes out instead): config.onEnd is all that runs then.
  // What it cannot tell apart: a client script that gives its own player another effect at the moment a server
  // script ends this one may see the new one ended instead, since the message names no effect.
  // The message is a script's write when a script asked for the end (cancel, cancelEffect: counted in this tick's
  // room for script writes like the one that gave the effect, so that giving and ending in a loop is no way round
  // it). When there is no room it is refused, nobody was told, and the effect is left as it is, here as on the
  // clients: the call answers false and can be made again. The clean-up's is the engine's own and is not refused.
  const endByScript = config => {
    if (activeEffectConfig !== config) return
    if (world.network.isServer && !player.destroyed) {
      const outcome = world.network.broadcast('entityModified', { id: player.data.id, ef: null })
      if (outcome === 'refused') return false
    }
    config.onEnd()
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
    // fresh copies on every read: a reused result would let a script that replaced its methods (eg `copy`) be
    // handed the player's live transform the next time the host refreshes it
    get position() {
      return new THREE.Vector3().copy(player.base.position)
    },
    get rotation() {
      return new THREE.Euler().copy(player.base.rotation)
    },
    get quaternion() {
      return new THREE.Quaternion().copy(player.base.quaternion)
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
    // サーバースクリプト専用: このプレイヤーの検証済み EVM アドレスが NFT を持っているか。
    // known: false は「今は分からない (後で再試行)」で、「持っていない」ではない
    getEvmHolding(spec) {
      const run = entity.getDeadHook()
      return new Promise(resolve => {
        let minBalance = 1
        const settle = value => {
          if (run.dead || entity.crashed || entity.destroyed || world.fatalError) return
          const verified = value?.verified === true
          const known = verified && value?.known === true && typeof value.balance === 'number' && value.balance >= 0
          const balance = known ? Math.min(value.balance, Number.MAX_SAFE_INTEGER) : 0
          resolve(Object.freeze({ verified, known, balance, holds: known && balance >= minBalance }))
        }
        if (!world.network.isServer) {
          if (!holdingWarnings.has(entity)) {
            holdingWarnings.add(entity)
            console.warn('[player] getEvmHolding is available only in server scripts')
          }
          return settle(UNKNOWN_HOLDING)
        }
        let request
        try {
          const read = readHoldingSpec(spec)
          if (!read) {
            if (!holdingSpecWarnings.has(entity)) {
              holdingSpecWarnings.add(entity)
              console.warn('[player] getEvmHolding needs { chainId, contract, standard, tokenId?, minBalance? }')
            }
            request = world.network.evmHolding(player.data.id, null)
          } else {
            minBalance = read.minBalance
            request = world.network.evmHolding(player.data.id, read)
          }
        } catch {
          request = null
        }
        Promise.resolve(request).then(settle, () => settle(UNKNOWN_HOLDING))
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
      assertRunAfterRead()
      if (player.data.owner === world.network.id) {
        // if player is local we can set directly
        world.network.enqueue('onPlayerTeleport', payload)
      } else {
        // if we're the server we need to notify the player
        world.network.sendTo(player.data.owner, 'playerTeleport', payload)
      }
    },
    // a copy: the avatar's own matrix is shared with the engine (nametag placement, aiming) and every app
    getBoneTransform(boneName) {
      const matrix = player.avatar?.getBoneTransform?.(boneName)
      return matrix ? new THREE.Matrix4().copy(matrix) : matrix
    },
    setSessionAvatar(url) {
      // a url is a string (or nothing, which clears it); anything else is reported and changes nothing: it is not
      // converted (an object's toString is script code) and not sent (packing an object runs its getters)
      if (url != null && typeof url !== 'string') return console.error('[player] setSessionAvatar url must be a string')
      const avatar = url
      if (player.data.owner === world.network.id) {
        // if player is local we can set directly
        // (the server passes a url outside the world on to the others only for a builder: said once here, where the
        // script's author looks, since for a visitor the avatar then shows for a moment and is set back)
        if (typeof avatar === 'string' && /^https?:\/\//i.test(avatar) && !player.isBuilder?.()) {
          warnOnce(
            '[player] setSessionAvatar: a url outside the world is shown to other players only for a builder; set it from a server script'
          )
        }
        world.network.enqueue('onPlayerSessionAvatar', { avatar })
      } else if (world.network.isClient) {
        remoteOnClient('setSessionAvatar')
      } else {
        // On the server the choice is applied here and told to everyone, the player included (whose client takes it
        // as it takes any change to its player, and sends nothing back). It used to be told to the player's client
        // alone, which then sent it on as its own change: the server could not tell a script's choice from the
        // player's, and what a script may choose for a player (any url) is more than a visitor may (ServerNetwork
        // onEntityModified). The choice is remembered on the entity, so that the player's client repeating it is
        // not taken for the player's own.
        if (!isAvatarUrl(avatar)) return console.error('[player] setSessionAvatar url is not an avatar url')
        if (player.destroyed) return
        const sessionAvatar = avatar || null
        // Told first (ServerNetwork broadcast). A packet the network does not admit (this tick's budget for script
        // writes is used up) reached nobody, so the change is not made here either. One admitted is a change made,
        // even when a recipient did not get it (a socket at its backlog limit): the clients that did have the new
        // avatar, and the server's player and every later snapshot must have it too.
        const result = world.network.broadcast('entityModified', { id: player.data.id, sessionAvatar })
        if (result === 'refused') return false
        player.scriptAvatar = sessionAvatar
        player.modify({ sessionAvatar })
        return result === 'delivered'
      }
    },
    // an amount is a number, kept by the engine's number rule (engineNumber.js: a numeric string is converted, an
    // object is not, so reading it runs no script code); one that is not finite changes nothing
    damage(amount) {
      const value = toEngineNumber(amount)
      if (!Number.isFinite(value)) return
      assertRunAfterRead()
      const health = clamp(player.data.health - value, 0, HEALTH_MAX)
      if (player.data.health === health) return
      if (world.network.isServer) {
        world.network.send('entityModified', { id: player.data.id, health })
      }
      player.modify({ health })
    },
    heal(amount = HEALTH_MAX) {
      const value = toEngineNumber(amount)
      if (!Number.isFinite(value)) return
      assertRunAfterRead()
      const health = clamp(player.data.health + value, 0, HEALTH_MAX)
      if (player.data.health === health) return
      if (world.network.isServer) {
        world.network.send('entityModified', { id: player.data.id, health })
      }
      player.modify({ health })
    },
    hasEffect() {
      return !!player.data.effect
    },
    // Normalise, admit, publish: the options are read once, into plain values, before anything is admitted (a getter
    // on them is script code); the player's current effect is ended before ours is installed, since its onEnd (this
    // app's or another's) can run script code that ends this run; the run is checked again after that, and nothing of
    // ours is published until then.
    applyEffect(opts) {
      const read = opts
        ? {
            anchor: opts.anchor,
            emote: opts.emote,
            snare: opts.snare,
            freeze: opts.freeze,
            turn: opts.turn,
            duration: opts.duration,
            cancellable: opts.cancellable,
            onEnd: opts.onEnd,
          }
        : null
      const anchorId = read?.anchor ? read.anchor.anchorId : undefined
      const effect = {}
      // only primitive values go into the effect: it is sent to the network and the player reads (and sanitises) it
      // every frame, so an object in it would run its own code later, outside this call. An effect with an object
      // (or a function) as a field is refused, as any other invalid field is
      let invalid = false
      const put = (key, value) => {
        if (!value) return
        if (isPrimitive(value)) effect[key] = value
        else invalid = true
      }
      if (read) {
        // effect.id = uuid()
        if (read.anchor) effect.anchorId = isPrimitive(anchorId) ? anchorId : undefined
        put('emote', read.emote)
        put('snare', read.snare)
        put('freeze', read.freeze)
        put('turn', read.turn)
        put('duration', read.duration)
        if (read.cancellable) {
          put('cancellable', read.cancellable)
          delete effect.freeze // overrides
        }
      }
      const safe = read && !invalid ? sanitizePlayerSelfModify({ ef: effect }, player.data.id) : null
      assertCanStart()
      if (!safe || !Object.prototype.hasOwnProperty.call(safe, 'ef')) return
      // an emote that is not an emote url plays nowhere: the effect goes out without it
      if (!isEmoteUrl(safe.ef.emote)) {
        safe.ef = { ...safe.ef }
        delete safe.ef.emote
      }
      // called by the host when the effect ends, which may be during teardown
      const onEnd = read.onEnd
      const config = {
        effect: safe.ef,
        onEnd: () => {
          if (activeEffectConfig !== config) return
          activeEffectConfig = null
          player.setEffect(null)
          if (!entity.crashed && !world.fatalError && run === entity.deadHook && !run?.dead) callBack(onEnd)
        },
      }
      // (a callback that applies another effect each time is not followed for ever)
      for (let tries = 0; player.data.effect; tries++) {
        if (tries >= 3) throw new Error('[player] the current effect could not be ended')
        player.setEffect(null)
        assertCanStart()
      }
      activeEffectConfig = config
      player.setEffect(config.effect, config.onEnd)
      if (world.network.isServer) {
        // The emote of an effect reaches the other clients through the player's own client, as the emote that
        // player says it is playing. A script may choose any url; a visitor's client may not. So what a server
        // script chose for this player is remembered here (the latest few, on the entity, not in its data), and the
        // player's client naming one of them is taken (ServerNetwork onEntityModified). Only here: an effect a
        // client sends for its own player must never be remembered.
        rememberScriptEmote(player, config.effect.emote)
        world.network.send('entityModified', { id: player.data.id, ef: config.effect })
      }
      return {
        get active() {
          return activeEffectConfig === config
        },
        cancel: () => {
          if (run !== entity.deadHook) throw stoppedError(entity)
          // (attributed to the script like the proxy's own methods, below)
          return world.network.isServer
            ? world.network.asScript(() => endByScript(config), entity, 'cancelEffect')
            : endByScript(config)
        },
      }
    },
    cancelEffect() {
      if (activeEffectConfig) return endByScript(activeEffectConfig)
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
      assertRunAfterRead()
      if (player.data.owner === world.network.id) {
        // if player is local we can set directly
        player.push(values)
      } else {
        // if we're the server we need to notify the player
        world.network.sendTo(player.data.owner, 'playerPush', { force: values })
      }
    },
    screenshare(targetId) {
      // (an id is a string: anything else is not converted, an object's toString is script code)
      if (!targetId || typeof targetId !== 'string') {
        return console.error('screenshare has invalid targetId')
      }
      if (player.data.owner !== world.network.id) {
        return console.error('screenshare can only be called on local player')
      }
      world.livekit.setScreenShareTarget(targetId)
    },
    setVoiceLevel(level) {
      // a level is a string (anything else is reported and changes nothing: it is not converted, an object's toString
      // is script code); removing the modifier is how a script ends it, so only a new or changed level is refused
      if (level && typeof level !== 'string') return console.error('[setVoiceLevel] level must be a string')
      if (level) assertCanStart()
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
        // (a level the voice system refuses leaves the current modifier as it was, and still tracked: it ends with the
        // run)
        voiceMod = world.livekit.updateModifier(voiceMod, level) || voiceMod
        return
      }
    },
  }
  handles.set(proxy, { player, run, entity, retire: () => (retired = true) })
  cleanups.set(proxy, () => {
    try {
      if (activeEffectConfig) endByScript(activeEffectConfig)
    } finally {
      if (voiceMod) {
        voiceMod = world.livekit.removeModifier(voiceMod)
      }
    }
  })
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
  // every call that acts or asks: refused once the app has stopped (crashed, or removed and its teardown is over) or
  // its run has ended; during the teardown the app's own callbacks (an effect's onEnd) can still act and end things,
  // while starting effects and voice levels is refused from the players stage on (assertCanStart)
  for (const name of [
    'push',
    'teleport',
    'getTokenBalance',
    'getEvmHolding',
    'setSessionAvatar',
    'damage',
    'heal',
    'applyEffect',
    'cancelEffect',
    'screenshare',
    'setVoiceLevel',
  ]) {
    const method = proxy[name]
    proxy[name] = (...args) => {
      if (run !== entity.deadHook) throw stoppedError(entity)
      return callForScript(method, entity, args)
    }
  }
  return proxy
}
