import moment from 'moment'
import { isArray, isEqual, isFunction } from 'lodash-es'
import * as THREE from '../extras/three'

import { readVec3, isFiniteF32, warnOnce } from '../extras/physxConvert.js'

import { System } from './System'
import { getNodeRef, resolveValueRef } from '../nodes/Node'
import { NODE_CLIMB_LIMIT, assertMovableRoot, placeWorldNode, unplaceWorldNode } from '../extras/nodeLimits.js'
import { Layers } from '../extras/Layers'
import { ControlPriorities } from '../extras/ControlPriorities'
import { warn } from '../extras/warn'
import { applyCreateOptions, splitCreateOptions } from '../extras/createOptions'
import { internalEvents } from '../extras/internalEvents'
import { resolveOpenURL } from '../extras/worldOpenPolicy'
import { toScriptError } from '../extras/scriptValues'
import { createEventLedger } from '../extras/appEventQueue'
import { applyInitials, copyFields } from '../extras/appFields'
import { jsonCopy } from '../extras/scriptText'
import { scriptChatMessage } from '../extras/chatPolicy'
import { createLogOnce } from '../extras/logOnce'

const _rayOrigin = new THREE.Vector3()
const _rayDir = new THREE.Vector3()
const _overlapOrigin = new THREE.Vector3()

const isBrowser = typeof window !== 'undefined'

// what a physics hit tells scripts about the shape it hit: primitive values only (the handle is shared by
// every app's queries)
function hitTag(handle) {
  const tag = handle?.tag
  return tag === undefined || tag === null || typeof tag === 'string' ? tag : undefined
}
function hitPlayerId(handle) {
  const playerId = handle?.playerId
  return playerId === undefined || playerId === null || typeof playerId === 'string' ? playerId : undefined
}

// app.configure reports a dropped field or a cut list once per app
const warnConfigure = createLogOnce(message => console.warn(message))

// create options from scripts: geometry may be null, a geometry ref from another node, or a
// real geometry (resolved here, once, like the proxy setter)
function resolveCreateOption(key, value) {
  if (key === 'geometry') {
    if (value == null || value instanceof THREE.BufferGeometry) return value
    const ref = resolveValueRef(value)
    if (ref) return ref.value
    console.error('[app.create] geometry invalid')
    return undefined
  }
  return value
}

/**
 * Apps System
 *
 * - Runs on both the server and client.
 * - A single place to manage app runtime methods used by all apps
 *
 */
export class Apps extends System {
  constructor(world) {
    super(world)
    this.eventLedger = createEventLedger()
    this.initWorldHooks()
    this.initAppHooks()
  }

  initWorldHooks() {
    const world = this.world
    const allowLoaders = ['avatar', 'model']
    this.worldGetters = {
      networkId(entity) {
        return world.network.id
      },
      isServer(entity) {
        return world.network.isServer
      },
      isClient(entity) {
        return world.network.isClient
      },
    }
    this.worldSetters = {
      // ...
    }
    this.worldMethods = {
      add(entity, pNode) {
        const node = getNodeRef(pNode)
        if (!node) {
          if (pNode != null) console.error('[world.add] expected a node')
          return
        }
        assertMovableRoot(node, entity, 'world.add')
        if (node.parent) {
          node.parent.remove(node)
        } else if (node.mounted && node.ctx?.entity !== entity) {
          // mounted for another owner: it leaves there first, so this app is charged for it (Node.activate)
          node.deactivate()
        }
        placeWorldNode(entity, node)
        node.activate({ world, entity, run: entity.deadHook })
      },
      remove(entity, pNode) {
        const node = getNodeRef(pNode)
        if (!node) {
          if (pNode != null) console.error('[world.remove] expected a node')
          return
        }
        if (node.parent) return // its not in world
        // only a node this app placed in world space (a node another app took over is not this app's to remove)
        if (!entity.worldNodes.has(node) || node._worldOwner !== entity) return
        unplaceWorldNode(node)
        node.deactivate()
      },
      attach(entity, pNode) {
        const node = getNodeRef(pNode)
        if (!node) {
          if (pNode != null) console.error('[world.attach] expected a node')
          return
        }
        assertMovableRoot(node, entity, 'world.attach')
        const parent = node.parent
        if (!parent) return
        const finalMatrix = new THREE.Matrix4()
        finalMatrix.copy(node.matrix)
        let currentParent = node.parent
        let steps = 0
        while (currentParent) {
          if (++steps > NODE_CLIMB_LIMIT) throw new Error('[world.attach] node tree too deep or cyclic')
          finalMatrix.premultiply(currentParent.matrix)
          currentParent = currentParent.parent
        }
        parent.remove(node)
        finalMatrix.decompose(node.position, node.quaternion, node.scale)
        // tracked before it mounts, so an activation that stops part-way (node limit) is still torn down
        placeWorldNode(entity, node)
        node.activate({ world, entity, run: entity.deadHook })
      },
      on(entity, name, callback) {
        entity.onWorldEvent(name, callback)
      },
      off(entity, name, callback) {
        entity.offWorldEvent(name, callback)
      },
      emit(entity, name, data) {
        if (typeof name !== 'string') return console.error('apps cannot emit events with non-string names')
        if (internalEvents.includes(name)) {
          return console.error(`apps cannot emit internal events (${name})`)
        }
        warn('world.emit() is deprecated, use app.emit() instead')
        world.events.emit(name, data)
      },
      getTime(entity) {
        return world.network.getTime()
      },
      getTimestamp(entity, format) {
        if (!format) return moment().toISOString()
        return moment().format(format)
      },
      chat(entity, msg, broadcast) {
        if (!msg) return
        // the script picks the text and a display name; the host stamps kind 'app', the app's name and no player
        const message = scriptChatMessage(msg, entity.blueprint?.name)
        if (!message) return
        if (world.network.isServer) {
          return world.network.asScript(() => world.chat.add(message, broadcast), entity, 'chat')
        }
        world.chat.add(message, false)
        // a client script's broadcast goes to the server as the app's own line (appChat), never as this visitor's
        // chat: the server names the app from its own blueprint and relays it as kind 'app'
        if (broadcast) world.network.send('appChat', { id: entity.data.id, body: message.body, from: message.from })
      },
      getPlayer(entity, playerId) {
        return entity.getPlayerProxy(playerId)
      },
      getPlayers(entity) {
        // tip: probably dont wanna call this every frame
        const players = []
        world.entities.players.forEach(player => {
          players.push(entity.getPlayerProxy(player.data.id))
        })
        return players
      },
      createLayerMask(entity, ...groups) {
        let mask = 0
        for (const group of groups) {
          if (!Layers[group]) throw new Error(`[createLayerMask] invalid group: ${group}`)
          mask |= Layers[group].group
        }
        return mask
      },
      raycast(entity, origin, direction, maxDistance, layerMask) {
        const validOrigin = readVec3(origin, _rayOrigin, '[raycast] origin must be Vector3')
        const validDirection = readVec3(direction, _rayDir, '[raycast] direction must be Vector3')
        maxDistance ??= Infinity
        if (typeof maxDistance !== 'number' || Number.isNaN(maxDistance) || maxDistance < 0) {
          throw new Error('[raycast] maxDistance must be number')
        }
        layerMask ??= 0
        if (!Number.isInteger(layerMask) || layerMask < -2147483648 || layerMask > 4294967295) {
          throw new Error('[raycast] layerMask must be number')
        }
        if (!validOrigin || !validDirection) {
          warnOnce('[raycast] ignored a non-finite origin or direction')
          return null
        }
        const hit = world.physics.raycast(_rayOrigin, _rayDir, maxDistance, layerMask >>> 0)
        if (!hit) return null
        // a new result per call: a script that changes (or puts accessors on) its result cannot see or change
        // another app's raycast
        return {
          point: new THREE.Vector3().copy(hit.point),
          normal: new THREE.Vector3().copy(hit.normal),
          distance: hit.distance,
          tag: hitTag(hit.handle),
          playerId: hitPlayerId(hit.handle),
        }
      },
      overlapSphere(entity, radius, origin, layerMask) {
        const validOrigin = readVec3(origin, _overlapOrigin, '[overlapSphere] origin must be Vector3')
        if (!isFiniteF32(radius) || Math.fround(radius) <= 0) {
          throw new Error('[overlapSphere] radius must be a positive number')
        }
        layerMask ??= 0
        if (!Number.isInteger(layerMask) || layerMask < -2147483648 || layerMask > 4294967295) {
          throw new Error('[overlapSphere] layerMask must be number')
        }
        if (!validOrigin) {
          warnOnce('[overlapSphere] ignored a non-finite origin')
          return []
        }
        const hits = world.physics.overlapSphere(radius, _overlapOrigin, layerMask >>> 0)
        // new plain records, read now: the physics system reuses its hit objects for every query of every app
        return hits.map(hit => ({ tag: hitTag(hit.handle) ?? null, playerId: hitPlayerId(hit.handle) ?? null }))
      },
      get(entity, key) {
        // a copy: the stored object is shared by every app (and the store), so no script holds or patches it
        return jsonCopy(world.storage?.get(key))
      },
      set(entity, key, value) {
        world.storage?.set(key, value)
      },
      open(entity, url, newWindow = false) {
        if (!url) {
          console.error('[world.open] URL is required')
          return
        }

        if (world.network.isClient) {
          try {
            // http(s) only, never a file from the assets store; new windows get no opener
            const resolvedUrl = resolveOpenURL(url, {
              resolve: value => world.resolveURL(value),
              base: window.location.href,
              assetsUrl: world.assetsUrl,
            })
            if (!resolvedUrl) {
              console.error('[world.open] only http(s) URLs outside of /assets/ can be opened')
              return
            }

            setTimeout(() => {
              if (newWindow) {
                window.open(resolvedUrl, '_blank', 'noopener,noreferrer')
              } else {
                window.location.href = resolvedUrl
              }
            }, 0)

            console.log(`[world.open] Redirecting to: ${resolvedUrl} ${newWindow ? '(new window)' : ''}`)
          } catch (e) {
            console.error('[world.open] Failed to open URL:', e)
          }
        } else {
          console.warn('[world.open] URL redirection only works on client side')
        }
      },
      load(entity, type, url) {
        return new Promise((resolve, reject) => {
          const hook = entity.getDeadHook()
          ;(async () => {
            try {
              if (!allowLoaders.includes(type)) {
                return reject(new Error(`cannot load type: ${type}`))
              }
              let glb = world.loader.get(type, url)
              if (!glb) glb = await world.loader.load(type, url)
              if (hook.dead) return
              const root = glb.toNodes()
              resolve(type === 'avatar' ? root.children[0].getProxy() : root.getProxy())
            } catch (err) {
              if (hook.dead) return
              reject(toScriptError(err))
            }
          })()
        })
      },
      getQueryParam(entity, key) {
        if (!isBrowser) {
          console.error('getQueryParam() must be called in the browser')
          return null
        }
        const urlParams = new URLSearchParams(window.location.search)
        return urlParams.get(key)
      },
      setQueryParam(entity, key, value) {
        if (!isBrowser) {
          console.error('getQueryParam() must be called in the browser')
          return null
        }
        const urlParams = new URLSearchParams(window.location.search)
        if (value) {
          urlParams.set(key, value)
        } else {
          urlParams.delete(key)
        }
        const newUrl = window.location.pathname + '?' + urlParams.toString()
        window.history.replaceState({}, '', newUrl)
      },
    }
  }

  initAppHooks() {
    const world = this.world
    this.appGetters = {
      instanceId(entity) {
        return entity.data.id
      },
      version(entity) {
        return entity.blueprint.version
      },
      modelUrl(entity) {
        return entity.blueprint.model
      },
      state(entity) {
        return entity.data.state
      },
      // the app's own copy of the blueprint props (see App.build); changing it changes nothing shared
      props(entity) {
        return entity.props
      },
      config(entity) {
        // deprecated. will be removed
        return entity.props
      },
      resetOnMove(entity) {
        return entity.resetOnMove
      },
      isMoving(entity) {
        return entity.mode === 'moving'
      },
    }
    this.appSetters = {
      state(entity, value) {
        entity.data.state = value
      },
      resetOnMove(entity, value) {
        entity.resetOnMove = value
      },
    }
    this.appMethods = {
      on(entity, name, callback) {
        entity.on(name, callback)
      },
      off(entity, name, callback) {
        entity.off(name, callback)
      },
      send(entity, name, data, ignoreSocketId) {
        if (typeof name !== 'string') {
          console.error('apps cannot send events with non-string names')
          return false
        }
        if (internalEvents.includes(name)) {
          console.error(`apps cannot send internal events (${name})`)
          return false
        }
        // NOTE: on the client ignoreSocketId is a no-op because it can only send events to the server
        const event = [entity.data.id, entity.blueprint.version, name, data]
        if (world.network.isServer) {
          return world.network.asScript(() => world.network.send('entityEvent', event, ignoreSocketId), entity, name)
        }
        return world.network.send('entityEvent', event, ignoreSocketId)
      },
      sendTo(entity, playerId, name, data) {
        if (typeof name !== 'string') {
          console.error('apps cannot send events with non-string names')
          return false
        }
        if (internalEvents.includes(name)) {
          console.error(`apps cannot send internal events (${name})`)
          return false
        }
        if (!world.network.isServer) {
          throw new Error('sendTo can only be called on the server')
        }
        const player = world.entities.get(playerId)
        if (!player) return false
        const event = [entity.data.id, entity.blueprint.version, name, data]
        return world.network.asScript(() => world.network.sendTo(playerId, 'entityEvent', event), entity, name)
      },
      emit(entity, name, data) {
        if (typeof name !== 'string') return console.error('apps cannot emit events with non-string names')
        if (internalEvents.includes(name)) {
          return console.error(`apps cannot emit internal events (${name})`)
        }
        world.events.emit(name, data)
      },
      create(entity, name, data) {
        // construct from host-safe data, then apply the rest through the proxy's own setters
        const { ctorData, options } = splitCreateOptions(data)
        const node = entity.createNode(name, ctorData)
        const proxy = node.getProxy()
        applyCreateOptions(proxy, options, resolveCreateOption)
        return proxy
      },
      control(entity, options) {
        const previous = entity.control
        // TODO: only allow on user interaction
        // TODO: show UI with a button to release()
        const control = world.controls.bind({
          ...options,
          priority: ControlPriorities.APP,
          object: entity,
        })
        try {
          if (previous) {
            // a pointer lock the previous control took stays with the app (ClientControls.handOverPointer)
            world.controls.handOverPointer?.(previous, control)
            previous.release()
          }
        } finally {
          entity.control = control
        }
        return entity.control
      },
      configure(entity, fnOrArray) {
        let fields = fnOrArray
        if (isFunction(fnOrArray)) {
          fields = fnOrArray() // deprecated
        }
        // the sidebar only ever sees host copies made through the field schema (appFields.js)
        entity.fields = copyFields(isArray(fields) ? fields : [], (reason, message) =>
          warnConfigure(entity, reason, message)
        )
        // initial values go into this app's own props copy, never into the shared blueprint
        if (entity.props) applyInitials(entity.fields, entity.props)
        entity.onFields?.(entity.fields)
      },
    }
  }

  inject({ world, app }) {
    if (world) {
      for (const key in world) {
        const value = world[key]
        const isFunction = typeof value === 'function'
        if (isFunction) {
          this.worldMethods[key] = value
          continue
        }
        if (value.get) {
          this.worldGetters[key] = value.get
        }
        if (value.set) {
          this.worldSetters[key] = value.set
        }
      }
    }
    if (app) {
      for (const key in app) {
        const value = app[key]
        const isFunction = typeof value === 'function'
        if (isFunction) {
          this.appMethods[key] = value
          continue
        }
        if (value.get) {
          this.appGetters[key] = value.get
        }
        if (value.set) {
          this.appSetters[key] = value.set
        }
      }
    }
  }
}
