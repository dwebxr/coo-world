import moment from 'moment'
import { isArray, isEqual, isFunction } from 'lodash-es'
import * as THREE from '../extras/three'

import { readVec3, isFiniteF32, warnOnce } from '../extras/physxConvert.js'

import { System } from './System'
import { getNodeRef, resolveValueRef } from '../nodes/Node'
import { NODE_CLIMB_LIMIT, assertMovableRoot, placeWorldNode, unplaceWorldNode } from '../extras/nodeLimits.js'
import { Teardown, tornDown } from '../extras/runTeardown.js'
import { stoppedError } from '../extras/physicsFailure.js'
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
import { scriptPacketData } from '../packets'
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
// an event name a script gives, as a string (converting an object runs its own code, so this happens first)
function eventName(name) {
  return typeof name === 'string' ? name : String(name)
}

// A handle method's run is the app's run when the method was entered (createEntityProxy has just checked it), so a
// method reads `entity.deadHook` first, before any argument. Reading an argument can run script code (a getter, a
// toString, a Proxy trap) that ends that run (and starts the next, or leaves a removed app with a fresh hook that is
// never torn down): the captured run is checked again, for the stage that releases what the method makes, after the
// arguments are read and before anything is published.
function assertRun(entity, run, stage) {
  if (run !== entity.deadHook || (stage && tornDown(run, stage))) throw stoppedError(entity)
}

// the data of an app.send or app.sendTo, read once into a host copy (scriptPacketData); the run is checked after the
// read, whether it succeeded or threw (the code that ended the run may also have made the read fail)
function readEventData(entity, run, data, client) {
  let copy
  try {
    copy = scriptPacketData(data, client)
  } catch (err) {
    assertRun(entity, run)
    throw err
  }
  assertRun(entity, run)
  return copy
}

// after an activation, which can run script code: if the run that placed the node ended meanwhile, the node is taken
// back (its teardown may already have passed it)
function placedOrTakenBack(entity, run, node) {
  if (run === entity.deadHook && !tornDown(run, Teardown.NODES)) return
  if (node._worldOwner === entity) unplaceWorldNode(node)
  node.deactivate()
  throw stoppedError(entity)
}

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
        // (the run first: reading the node through a script Proxy runs its traps)
        const run = entity.deadHook
        const node = getNodeRef(pNode)
        if (!node) {
          if (pNode != null) console.error('[world.add] expected a node')
          return
        }
        assertMovableRoot(node, entity, 'world.add')
        // nothing is placed for a run whose node teardown has started (runTeardown.js); the run is the one that asked,
        // checked again after each step that can run script code
        assertRun(entity, run, Teardown.NODES)
        if (node.parent) {
          node.parent.remove(node)
        } else if (node.mounted && node.ctx?.entity !== entity) {
          // mounted for another owner: it leaves there first, so this app is charged for it (Node.activate)
          node.deactivate()
        }
        assertRun(entity, run, Teardown.NODES)
        placeWorldNode(entity, node)
        node.activate({ world, entity, run })
        placedOrTakenBack(entity, run, node)
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
        const run = entity.deadHook
        const node = getNodeRef(pNode)
        if (!node) {
          if (pNode != null) console.error('[world.attach] expected a node')
          return
        }
        assertMovableRoot(node, entity, 'world.attach')
        assertRun(entity, run, Teardown.NODES)
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
        assertRun(entity, run, Teardown.NODES)
        finalMatrix.decompose(node.position, node.quaternion, node.scale)
        // tracked before it mounts, so an activation that stops part-way (node limit) is still torn down
        placeWorldNode(entity, node)
        node.activate({ world, entity, run })
        placedOrTakenBack(entity, run, node)
      },
      on(entity, name, callback) {
        // the name is read once, into a string, before anything is admitted (it can be an object with a toString)
        const run = entity.deadHook
        const key = eventName(name)
        assertRun(entity, run, Teardown.LISTENERS)
        entity.onWorldEvent(key, callback)
      },
      off(entity, name, callback) {
        entity.offWorldEvent(eventName(name), callback)
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
        const run = entity.deadHook
        if (!msg) return
        // the script picks the text and a display name; the host stamps kind 'app', the app's name and no player
        const message = scriptChatMessage(msg, entity.blueprint?.name)
        if (!message) return
        // (reading the message can run script code: a run that ended meanwhile says nothing more)
        assertRun(entity, run)
        if (world.network.isServer) {
          return world.network.asScript(() => world.chat.add(message, broadcast), entity, 'chat')
        }
        world.chat.add(message, false)
        // a client script's broadcast goes to the server as the app's own line (appChat), never as this visitor's
        // chat: the server names the app from its own blueprint and relays it as kind 'app'
        if (broadcast) world.network.send('appChat', { id: entity.data.id, body: message.body, from: message.from })
      },
      getPlayer(entity, playerId) {
        return entity.getPlayerProxy(playerId, entity.deadHook)
      },
      getPlayers(entity) {
        // refused from the players teardown stage on, also when nobody is in the world; every handle is made for the
        // run that asked (a lookup can evict a handle, whose cleanup can run script code that ends the run)
        const run = entity.deadHook
        assertRun(entity, run, Teardown.PLAYERS)
        // tip: probably dont wanna call this every frame
        const players = []
        for (const player of [...world.entities.players.values()]) {
          // (a player that is leaving is still listed while its leave event runs: it has no handle)
          const proxy = entity.getPlayerProxy(player.data.id, run)
          if (proxy) players.push(proxy)
        }
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
        const run = entity.deadHook
        if (!world.storage) return
        // the value is read once, here, as JSON (its toJSON and getters are script code, which can end the run): the
        // store gets the host's copy, and nothing is stored for a run that ended meanwhile
        let copy
        if (value !== undefined) {
          let json
          try {
            json = JSON.stringify(value)
          } catch {
            json = undefined
          }
          if (typeof json !== 'string') throw new TypeError('world.set: the value cannot be stored as JSON')
          copy = JSON.parse(json)
        }
        assertRun(entity, run)
        world.storage.set(key, copy)
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
              // the url is read once, into a string, before anything is loaded for the run (an object's toString is
              // script code, which can end the run)
              const href = typeof url === 'string' ? url : String(url)
              if (hook.dead) return
              let glb = world.loader.get(type, href)
              if (!glb) glb = await world.loader.load(type, href)
              if (hook.dead) return
              const root = glb.toNodes()
              // the loaded tree belongs to the run that loaded it (its handles stop with that run; Node.js)
              root._created = { entity, run: hook }
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
        const run = entity.deadHook
        if (!isBrowser) {
          console.error('getQueryParam() must be called in the browser')
          return null
        }
        // the key and the value are read once, into strings (an object's toString is script code, which can end the
        // run), before the address changes
        const name = typeof key === 'string' ? key : String(key)
        const text = !value ? null : typeof value === 'string' ? value : String(value)
        assertRun(entity, run)
        const urlParams = new URLSearchParams(window.location.search)
        if (text !== null) {
          urlParams.set(name, text)
        } else {
          urlParams.delete(name)
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
        const run = entity.deadHook
        const key = eventName(name)
        assertRun(entity, run, Teardown.LISTENERS)
        entity.on(key, callback)
      },
      off(entity, name, callback) {
        // (the name converted as app.on converts it, once: an object's toString is script code)
        entity.off(eventName(name), callback)
      },
      send(entity, name, data, ignoreSocketId) {
        const run = entity.deadHook
        if (typeof name !== 'string') {
          console.error('apps cannot send events with non-string names')
          return false
        }
        if (internalEvents.includes(name)) {
          console.error(`apps cannot send internal events (${name})`)
          return false
        }
        // the data is read once, now (scriptPacketData: packing it runs its getters), and nothing is sent for a run
        // that ended meanwhile (also when reading it failed)
        const copy = readEventData(entity, run, data, !world.network.isServer)
        // NOTE: on the client ignoreSocketId is a no-op because it can only send events to the server
        const event = [entity.data.id, entity.blueprint.version, name, copy]
        if (world.network.isServer) {
          return world.network.asScript(() => world.network.send('entityEvent', event, ignoreSocketId), entity, name)
        }
        return world.network.send('entityEvent', event, ignoreSocketId)
      },
      sendTo(entity, playerId, name, data) {
        const run = entity.deadHook
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
        // (read once, as app.send reads it)
        const copy = readEventData(entity, run, data, false)
        const event = [entity.data.id, entity.blueprint.version, name, copy]
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
        // construct from host-safe data, then apply the rest through the proxy's own setters (each a call of its own,
        // checked on entry). The type and the data are read first: the node belongs to the run that asked, while it is
        // still current (App.createNode)
        const run = entity.deadHook
        const type = typeof name === 'string' ? name : String(name)
        const { ctorData, options } = splitCreateOptions(data)
        const node = entity.createNode(type, ctorData, run)
        const proxy = node.getProxy()
        applyCreateOptions(proxy, options, resolveCreateOption)
        return proxy
      },
      control(entity, options) {
        // the options are read once, into a plain copy, before anything is admitted (a getter on them is script code)
        const run = entity.deadHook
        const copy = { ...options }
        // every control a run makes is listed for its teardown, which releases it through the host; once the teardown
        // has started, no control is made (App.getRunControls throws the stopped error)
        assertRun(entity, run, Teardown.CONTROLS)
        const controls = entity.getRunControls()
        const previous = entity.control
        // TODO: only allow on user interaction
        // TODO: show UI with a button to release()
        const control = world.controls.bind(
          {
            ...copy,
            priority: ControlPriorities.APP,
            object: entity,
          },
          { entity, run }
        )
        // (listed before the previous control's onRelease runs: a teardown that callback starts releases it too)
        controls.add(control)
        try {
          if (previous) {
            // a pointer lock the previous control took stays with the app (ClientControls.handOverPointer)
            world.controls.handOverPointer(previous, control)
            world.controls.releaseControl(previous)
            controls.delete(previous)
          }
        } finally {
          if (run === entity.deadHook) entity.control = control
        }
        return control
      },
      configure(entity, fnOrArray) {
        const run = entity.deadHook
        let fields = fnOrArray
        if (isFunction(fnOrArray)) {
          fields = fnOrArray() // deprecated
        }
        // the sidebar only ever sees host copies made through the field schema (appFields.js)
        const copied = copyFields(isArray(fields) ? fields : [], (reason, message) =>
          warnConfigure(entity, reason, message)
        )
        // (the fields function and the field getters are script code: a run that ended meanwhile shows no fields, its
        // teardown has already cleared them)
        assertRun(entity, run)
        entity.fields = copied
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
