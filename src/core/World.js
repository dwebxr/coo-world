import { getPhysicsTrapCount, handlePhysicsFailure } from './extras/physicsFailure.js'
import { briefError, createLogOnce } from './extras/logOnce.js'
import { serializeError } from './extras/serializeError'
import * as THREE from './extras/three'
import EventEmitter from 'eventemitter3'

import { Settings } from './systems/Settings'
import { Collections } from './systems/Collections'
import { Apps } from './systems/Apps'
import { Anchors } from './systems/Anchors'
import { Avatars } from './systems/Avatars'
import { Animation } from './systems/Animation'
import { Events } from './systems/Events'
import { Chat } from './systems/Chat'
import { Blueprints } from './systems/Blueprints'
import { Entities } from './systems/Entities'
import { Physics } from './systems/Physics'
import { Stage } from './systems/Stage'
import { Scripts } from './systems/Scripts'

// a hot item that throws is reported once per item and phase
const logHotFailure = createLogOnce(message => console.error(message))

// who answers for a hot item: an app or player entity itself, the entity of a node, or of the node that owns a
// non-node item (an avatar instance carries its Avatar node as hotOwner)
function hotOwner(item) {
  if (item.isApp || item.isPlayer) return item
  return (item.ctx || item.hotOwner?.ctx)?.entity
}

export class World extends EventEmitter {
  constructor() {
    super()

    this.maxDeltaTime = 1 / 30 // 0.33333
    this.fixedDeltaTime = 1 / 50 // 0.01666
    this.frame = 0
    this.time = 0
    this.accumulator = 0
    this.systems = []
    this.networkRate = 1 / 8 // 8Hz
    this.assetsUrl = null
    this.assetsDir = null
    this.hot = new Set()
    this.fatalError = null

    this.rig = new THREE.Object3D()
    // NOTE: camera near is slightly smaller than spherecast. far is slightly more than skybox.
    // this gives us minimal z-fighting without needing logarithmic depth buffers
    this.camera = new THREE.PerspectiveCamera(70, 0, 0.2, 1200)
    this.rig.add(this.camera)

    this.register('settings', Settings)
    this.register('collections', Collections)
    this.register('apps', Apps)
    this.register('anchors', Anchors)
    this.register('avatars', Avatars)
    this.register('animation', Animation)
    this.register('events', Events)
    this.register('scripts', Scripts)
    this.register('chat', Chat)
    this.register('blueprints', Blueprints)
    this.register('entities', Entities)
    this.register('physics', Physics)
    this.register('stage', Stage)
  }

  register(key, System) {
    const system = new System(this)
    this.systems.push(system)
    this[key] = system
    return system
  }

  async init(options) {
    this.storage = options.storage
    this.assetsDir = options.assetsDir
    this.assetsUrl = options.assetsUrl
    for (const system of this.systems) {
      await system.init(options)
    }
    this.start()
  }

  start() {
    for (const system of this.systems) {
      system.start()
    }
  }

  tick = time => {
    if (this.fatalError) return
    // begin any stats/performance monitors
    this.preTick()
    if (this.fatalError) return
    // update time, delta, frame and accumulator
    time /= 1000
    let delta = time - this.time
    if (delta < 0) delta = 0
    if (delta > this.maxDeltaTime) {
      delta = this.maxDeltaTime
    }
    this.frame++
    this.time = time
    this.accumulator = Math.min(this.accumulator + delta, this.maxDeltaTime + this.fixedDeltaTime)
    // prepare physics
    const willFixedStep = this.accumulator >= this.fixedDeltaTime
    this.preFixedUpdate(willFixedStep)
    if (this.fatalError) return
    // run as many fixed updates as we can for this ticks delta
    while (this.accumulator >= this.fixedDeltaTime) {
      // run all fixed updates
      this.fixedUpdate(this.fixedDeltaTime)
      if (this.fatalError) return
      // step physics
      this.postFixedUpdate(this.fixedDeltaTime)
      if (this.fatalError) return
      // decrement accumulator
      this.accumulator -= this.fixedDeltaTime
    }
    // interpolate physics for remaining delta time
    const alpha = this.accumulator / this.fixedDeltaTime
    this.preUpdate(alpha)
    if (this.fatalError) return
    // run all updates
    this.update(delta, alpha)
    if (this.fatalError) return
    // run post updates, eg cleaning all node matrices
    this.postUpdate(delta)
    if (this.fatalError) return
    // run all late updates
    this.lateUpdate(delta, alpha)
    if (this.fatalError) return
    // run post late updates, eg cleaning all node matrices
    this.postLateUpdate(delta)
    if (this.fatalError) return
    // commit all changes, eg render on the client
    this.commit()
    if (this.fatalError) return
    // end any stats/performance monitors
    this.postTick()
  }

  preTick() {
    for (const system of this.systems) {
      if (this.fatalError) return
      system.preTick()
    }
  }

  preFixedUpdate(willFixedStep) {
    for (const system of this.systems) {
      if (this.fatalError) return
      system.preFixedUpdate(willFixedStep)
    }
  }

  fixedUpdate(delta) {
    for (const item of this.hot) {
      if (this.fatalError) return
      try {
        item.fixedUpdate?.(delta)
      } catch (err) {
        this.hotFailed(item, 'fixedUpdate', err)
      }
    }
    for (const system of this.systems) {
      if (this.fatalError) return
      system.fixedUpdate(delta)
    }
  }

  postFixedUpdate(delta) {
    for (const system of this.systems) {
      if (this.fatalError) return
      system.postFixedUpdate(delta)
    }
  }

  preUpdate(alpha) {
    for (const system of this.systems) {
      if (this.fatalError) return
      system.preUpdate(alpha)
    }
  }

  update(delta) {
    for (const item of this.hot) {
      if (this.fatalError) return
      try {
        item.update?.(delta)
      } catch (err) {
        this.hotFailed(item, 'update', err)
      }
    }
    for (const system of this.systems) {
      if (this.fatalError) return
      system.update(delta)
    }
  }

  postUpdate(delta) {
    for (const system of this.systems) {
      if (this.fatalError) return
      system.postUpdate(delta)
    }
  }

  lateUpdate(delta) {
    for (const item of this.hot) {
      if (this.fatalError) return
      try {
        item.lateUpdate?.(delta)
      } catch (err) {
        this.hotFailed(item, 'lateUpdate', err)
      }
    }
    for (const system of this.systems) {
      if (this.fatalError) return
      system.lateUpdate(delta)
    }
  }

  postLateUpdate(delta) {
    for (const item of this.hot) {
      if (this.fatalError) return
      try {
        item.postLateUpdate?.(delta)
      } catch (err) {
        this.hotFailed(item, 'postLateUpdate', err)
      }
    }
    for (const system of this.systems) {
      if (this.fatalError) return
      system.postLateUpdate(delta)
    }
  }

  commit() {
    for (const system of this.systems) {
      if (this.fatalError) return
      system.commit()
    }
  }

  postTick() {
    for (const system of this.systems) {
      if (this.fatalError) return
      system.postTick()
    }
  }

  fatal(reason) {
    if (this.fatalError) return
    this.fatalError = reason
    console.error(`[physics] ${reason} after ${getPhysicsTrapCount()} traps; stopping for a restart`)
    if (this.network.isServer) {
      this.server.destroy()
      this.network.stopForFatal()
      this.fatalPromise = (async () => {
        try {
          await this.network.flushBeforeExit(5000)
        } catch {
          console.error('[physics] save before exit failed or exceeded its deadline')
        } finally {
          process.exit(1)
        }
      })()
    } else {
      this.client?.stopForFatal()
      this.emit('fatal', 'Physics stopped. Reload to reconnect.')
    }
  }

  setupMaterial = material => {
    this.environment.csm?.setupMaterial(material)
  }

  // One hot item that throws must not stop the others or the frame. An app's item crashes that app (its rebuild
  // replaces it); a player stays hot and falls back to the default avatar (a hostile or broken avatar is the
  // likely cause), and is dropped only if it throws again on the default; anything else leaves the hot set.
  hotFailed(item, phase, err) {
    const owner = hotOwner(item)
    const trapped = handlePhysicsFailure(err, {
      entity: owner?.isApp ? owner : undefined,
      world: this,
      phase: `hot ${phase}`,
    })
    const label = owner?.data?.id ?? item.id ?? 'none'
    const where = `${phase} (${owner?.isApp ? 'app' : owner?.isPlayer ? 'player' : 'item'} ${String(label).slice(0, 64)})`
    if (owner?.isApp) {
      if (item !== owner) this.hot.delete(item)
      if (trapped) return
      if (!owner.crashed) {
        try {
          owner.scriptError = serializeError(err)
        } catch {
          // a hostile error object must not stop the containment
        }
      }
      logHotFailure(item, phase, `[world] ${where} failed: ${briefError(err)}`)
      owner.crash?.()
      return
    }
    if (owner?.isPlayer && owner.fallBackToDefaultAvatar?.()) {
      // the player is kept; an avatar instance that failed is replaced with the avatar
      if (item !== owner) this.hot.delete(item)
      logHotFailure(owner, 'avatar', `[world] ${where} failed, using the default avatar: ${briefError(err)}`)
      return
    }
    this.hot.delete(item)
    logHotFailure(item, phase, `[world] ${where} failed and stopped updating: ${briefError(err)}`)
  }

  setHot(item, hot) {
    if (hot) {
      this.hot.add(item)
    } else {
      this.hot.delete(item)
    }
  }

  resolveURL(url, allowLocal) {
    if (!url) return url
    url = url.trim()
    if (url.startsWith('blob')) {
      return url
    }
    if (url.startsWith('asset://')) {
      if (this.assetsDir && allowLocal) {
        return url.replace('asset:/', this.assetsDir)
      } else if (this.assetsUrl) {
        return url.replace('asset:/', this.assetsUrl)
      } else {
        console.error('resolveURL: no assetsUrl or assetsDir defined')
        return url
      }
    }
    if (url.match(/^https?:\/\//i)) {
      return url
    }
    if (url.startsWith('//')) {
      return `https:${url}`
    }
    if (url.startsWith('/')) {
      return url
    }
    return `https://${url}`
  }

  inject(runtime) {
    this.apps.inject(runtime)
  }

  destroy() {
    for (const system of this.systems) {
      system.destroy()
    }
  }
}
