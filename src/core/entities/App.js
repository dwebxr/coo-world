import { Entity } from './Entity'
import { createNode } from '../extras/createNode'
import { LerpVector3 } from '../extras/LerpVector3'
import { LerpQuaternion } from '../extras/LerpQuaternion'
import { createPlayerProxy } from '../extras/createPlayerProxy'
import { createEntityProxy } from '../extras/createEntityProxy'
import { serializeError } from '../extras/serializeError'
import { registerAppProxy } from '../nodes/refs'
import { createScriptTimers } from '../extras/scriptTimers'
import { createScriptResponse, toHostFetchOptions } from '../extras/scriptFetch'

const hotEventNames = ['fixedUpdate', 'update', 'animate', 'lateUpdate']

const Modes = {
  ACTIVE: 'active',
  MOVING: 'moving',
  LOADING: 'loading',
  CRASHED: 'crashed',
}

let safeMode = false
if (typeof window !== 'undefined') {
  safeMode = new URLSearchParams(window.location.search).get('safemode')
}

export class App extends Entity {
  constructor(world, data, local) {
    super(world, data, local)
    this.isApp = true
    this.n = 0
    this.worldNodes = new Set()
    this.hotEvents = 0
    this.worldListeners = new Map()
    this.listeners = {}
    this.eventQueue = []
    this.snaps = []
    this.root = createNode('group')
    this.fields = []
    this.target = null
    this.projectLimit = Infinity
    this.resetOnMove = false
    this.animateDelta = 0
    this.animateRate = 0.001
    this.playerProxies = new Map()
    this.hitResultsPool = []
    this.hitResults = []
    this.deadHook = { dead: false }
    this.timers = createScriptTimers()
    this.build()
  }

  createNode(name, data) {
    const node = createNode(name, data)
    return node
  }

  async build(crashed) {
    this.building = true
    const n = ++this.n
    // fetch blueprint
    const blueprint = this.world.blueprints.get(this.data.blueprint)

    if (blueprint.disabled) {
      this.unbuild()
      this.blueprint = blueprint
      this.building = false
      return
    }

    let root
    let script
    // if someone else is uploading glb, show a loading indicator
    if (this.data.uploader && this.data.uploader !== this.world.network.id) {
      root = createNode('mesh')
      root.type = 'box'
      root.width = 1
      root.height = 1
      root.depth = 1
    }
    // otherwise we can load the model and script
    else {
      try {
        const type = blueprint.model.endsWith('vrm') ? 'avatar' : 'model'
        let glb = this.world.loader.get(type, blueprint.model)
        if (!glb) glb = await this.world.loader.load(type, blueprint.model)
        root = glb.toNodes()
      } catch (err) {
        console.error(err)
        crashed = true
        // no model, will use crash block below
      }
      // fetch script (if any)
      if (blueprint.script) {
        try {
          script = this.world.loader.get('script', blueprint.script)
          if (!script) script = await this.world.loader.load('script', blueprint.script)
        } catch (err) {
          console.error(err)
          crashed = true
        }
      }
    }
    // if script crashed (or failed to load model), show crash-block
    if (crashed) {
      let glb = this.world.loader.get('model', 'asset://crash-block.glb')
      if (!glb) glb = await this.world.loader.load('model', 'asset://crash-block.glb')
      root = glb.toNodes()
    }
    // if a new build happened while we were fetching, stop here
    if (this.n !== n) return
    // unbuild any previous version
    this.unbuild()
    // mode
    this.mode = Modes.ACTIVE
    if (this.data.mover) this.mode = Modes.MOVING
    if (this.data.uploader && this.data.uploader !== this.world.network.id) this.mode = Modes.LOADING
    // setup
    this.blueprint = blueprint
    this.root = root
    if (!blueprint.scene) {
      this.root.position.fromArray(this.data.position)
      this.root.quaternion.fromArray(this.data.quaternion)
      this.root.scale.fromArray(this.data.scale)
    }
    // activate
    this.root.activate({ world: this.world, entity: this, moving: !!this.data.mover })
    // execute script
    this.script = script
    this.onScript?.(script)
    const runScript =
      script &&
      !crashed &&
      !safeMode &&
      (this.mode === Modes.ACTIVE || (this.mode === Modes.MOVING && !this.resetOnMove))
    // (this.mode === Modes.ACTIVE && script && !crashed) ||
    // (this.mode === Modes.MOVING && !this.resetOnMove && !this.scriptError)
    if (runScript) {
      this.abortController = new AbortController()
      try {
        this.script.exec(this.getWorldProxy(), this.getAppProxy(), this.fetch, blueprint.props, this.setTimeout)
        this.scriptError = null
      } catch (err) {
        this.scriptError = serializeError(err)
        console.error('script crashed')
        console.error(err)
        return this.crash()
      }
    }
    // if moving we need updates
    if (this.mode === Modes.MOVING) {
      this.world.setHot(this, true)
      // and we need a list of any snap points
      this.snaps = []
      this.root.traverse(node => {
        if (node.name === 'snap') {
          this.snaps.push(node.worldPosition)
        }
      })
    }
    // if remote is moving, set up to receive network updates
    this.networkPos = new LerpVector3(root.position, this.world.networkRate)
    this.networkQuat = new LerpQuaternion(root.quaternion, this.world.networkRate)
    this.networkSca = new LerpVector3(root.scale, this.world.networkRate)
    // execute any events we collected while building
    while (this.eventQueue.length) {
      const event = this.eventQueue[0]
      if (event.version > this.blueprint.version) break // ignore future versions
      this.eventQueue.shift()
      this.emit(event.name, event.data, event.networkId)
    }
    // finished!
    this.building = false
  }

  unbuild() {
    // notify any running script; a throwing listener must not skip the teardown below
    try {
      this.emit('destroy')
    } catch (err) {
      console.error('script destroy() crashed', this)
      console.error(err)
    }
    // cancel any control
    this.control?.release()
    this.control = null
    // cancel any effects
    this.playerProxies.forEach(player => {
      player.$cleanup()
    })
    // deactivate local node
    this.root?.deactivate()
    // deactivate world nodes
    for (const node of this.worldNodes) {
      node.deactivate()
    }
    this.worldNodes.clear()
    // clear script event listeners
    this.clearEventListeners()
    this.hotEvents = 0
    // cancel update tracking
    this.world.setHot(this, false)
    // abort fetch's etc
    this.abortController?.abort()
    this.abortController = null
    // cancel script timers
    this.timers.clear()
    // mark dead and re-create hook (async etc)
    this.deadHook.dead = true
    this.deadHook = { dead: false }
    // clear fields
    this.onFields?.([])
  }

  fixedUpdate(delta) {
    // script fixedUpdate()
    if (this.script) {
      try {
        this.emit('fixedUpdate', delta)
      } catch (err) {
        this.scriptError = serializeError(err)
        console.error('script fixedUpdate crashed', this)
        console.error(err)
        this.crash()
        return
      }
    }
  }

  update(delta) {
    // if someone else is moving the app, interpolate updates
    if (this.data.mover && this.data.mover !== this.world.network.id) {
      this.networkPos.update(delta)
      this.networkQuat.update(delta)
      this.networkSca.update(delta)
    }
    // script update/animate
    if (this.script) {
      try {
        // update
        this.emit('update', delta)
        // animate
        this.animateDelta += delta
        while (this.animateDelta >= this.animateRate) {
          this.emit('animate', this.animateDelta)
          this.animateDelta = 0
        }
      } catch (err) {
        this.scriptError = serializeError(err)
        console.error('script update() crashed', this)
        console.error(err)
        this.crash()
        return
      }
    }
  }

  lateUpdate(delta) {
    if (this.script) {
      try {
        this.emit('lateUpdate', delta)
      } catch (err) {
        this.scriptError = serializeError(err)
        console.error('script lateUpdate() crashed', this)
        console.error(err)
        this.crash()
        return
      }
    }
  }

  onUploaded() {
    this.data.uploader = null
    this.world.network.send('entityModified', { id: this.data.id, uploader: null })
  }

  modify(data) {
    let rebuild
    if (Object.prototype.hasOwnProperty.call(data, 'blueprint')) {
      this.data.blueprint = data.blueprint
      rebuild = true
    }
    if (Object.prototype.hasOwnProperty.call(data, 'uploader')) {
      this.data.uploader = data.uploader
      rebuild = true
    }
    if (Object.prototype.hasOwnProperty.call(data, 'mover')) {
      this.data.mover = data.mover
      rebuild = true
    }
    if (Object.prototype.hasOwnProperty.call(data, 'position')) {
      this.data.position = data.position
      if (this.data.mover) {
        this.networkPos.pushArray(data.position)
      } else {
        rebuild = true
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'quaternion')) {
      this.data.quaternion = data.quaternion
      if (this.data.mover) {
        this.networkQuat.pushArray(data.quaternion)
      } else {
        rebuild = true
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'scale')) {
      this.data.scale = data.scale
      if (this.data.mover) {
        this.networkSca.pushArray(data.scale)
      } else {
        rebuild = true
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'pinned')) {
      this.data.pinned = data.pinned
    }
    if (Object.prototype.hasOwnProperty.call(data, 'state')) {
      this.data.state = data.state
      rebuild = true
    }
    if (rebuild) {
      this.build()
    }
  }

  crash() {
    // the rebuild runs unobserved by callers; a failure must not surface as an unhandled rejection
    // or leave the app stuck in the building state (which would queue events forever)
    const promise = this.build(true)
    const n = this.n
    promise.catch(err => {
      console.error('crash rebuild failed', this)
      console.error(err)
      // only this build may clear the flag; a newer build owns it otherwise
      if (this.n === n) this.building = false
    })
  }

  destroy(local) {
    if (this.destroyed) return
    this.destroyed = true

    this.unbuild()

    this.world.entities.remove(this.data.id)
    // if removed locally we need to broadcast to server/clients
    if (local) {
      this.world.network.send('entityRemoved', this.data.id)
    }
  }

  on(name, callback) {
    if (!this.listeners[name]) {
      this.listeners[name] = new Set()
    }
    if (this.listeners[name].has(callback)) return
    this.listeners[name].add(callback)
    if (hotEventNames.includes(name)) {
      this.hotEvents++
      this.world.setHot(this, this.hotEvents > 0)
    }
  }

  off(name, callback) {
    if (!this.listeners[name]) return
    if (!this.listeners[name].has(callback)) return
    this.listeners[name].delete(callback)
    if (hotEventNames.includes(name)) {
      this.hotEvents--
      this.world.setHot(this, this.hotEvents > 0)
    }
  }

  emit(name, a1, a2) {
    if (!this.listeners[name]) return
    for (const callback of this.listeners[name]) {
      callback(a1, a2)
    }
  }

  onWorldEvent(name, callback) {
    this.worldListeners.set(callback, name)
    this.world.events.on(name, callback)
  }

  offWorldEvent(name, callback) {
    this.worldListeners.delete(callback)
    this.world.events.off(name, callback)
  }

  clearEventListeners() {
    // local
    this.listeners = {}
    // world
    for (const [callback, name] of this.worldListeners) {
      this.world.events.off(name, callback)
    }
    this.worldListeners.clear()
  }

  onEvent(version, name, data, networkId) {
    if (this.building || version > this.blueprint.version) {
      this.eventQueue.push({ version, name, data, networkId })
    } else {
      this.emit(name, data, networkId)
    }
  }

  // scripts get a whitelisted request init and a response of plain values (see scriptFetch.js)
  fetch = async (url, options = {}) => {
    try {
      const resp = await fetch(url, {
        ...toHostFetchOptions(options),
        signal: this.abortController.signal,
      })
      return createScriptResponse(resp)
    } catch (err) {
      console.error(err)
      // this.crash()
    }
  }

  // scripts get an opaque handle; the timer itself stays host-private
  setTimeout = (fn, ms) => {
    return this.timers.set(fn, ms)
  }

  getDeadHook = () => {
    return this.deadHook
  }

  getNodes() {
    // note: this is currently just used in the nodes tab in the app inspector
    // to get a clean hierarchy
    if (!this.blueprint) return
    const type = this.blueprint.model.endsWith('vrm') ? 'avatar' : 'model'
    let glb = this.world.loader.get(type, this.blueprint.model)
    if (!glb) return
    return glb.toNodes()
  }

  getPlayerProxy(playerId) {
    if (playerId === undefined) playerId = this.world.entities.player?.data.id
    let proxy = this.playerProxies.get(playerId)
    if (!proxy || proxy.destroyed) {
      const player = this.world.entities.getPlayer(playerId)
      if (!player) return null
      proxy = createPlayerProxy(this, player)
      this.playerProxies.set(playerId, proxy)
    }
    return proxy
  }

  getWorldProxy() {
    if (!this.worldProxy) {
      const entity = this
      this.worldProxy = createEntityProxy(entity, {
        getters: this.world.apps.worldGetters,
        setters: this.world.apps.worldSetters,
        methods: this.world.apps.worldMethods,
      })
    }
    return this.worldProxy
  }

  getAppProxy() {
    if (!this.appProxy) {
      const entity = this
      this.appProxy = createEntityProxy(entity, {
        getters: this.world.apps.appGetters,
        setters: this.world.apps.appSetters,
        methods: this.world.apps.appMethods,
        // root node props
        fallbackGet: prop => entity.root.getProxy()[prop],
        fallbackSet: (prop, value) => {
          if (Object.prototype.hasOwnProperty.call(entity.root.getProxy(), prop)) {
            entity.root.getProxy()[prop] = value
            return true
          }
          return true
        },
      })
      // lets world.add(app) etc resolve to the app's root node
      registerAppProxy(this.appProxy, () => entity.root.getProxy())
    }
    return this.appProxy
  }
}
