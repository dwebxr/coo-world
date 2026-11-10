import { assertScriptActive, handlePhysicsFailure, stoppedError } from '../extras/physicsFailure.js'
import { Entity } from './Entity'
import { createNode } from '../extras/createNode'
import { LerpVector3 } from '../extras/LerpVector3'
import { LerpQuaternion } from '../extras/LerpQuaternion'
import { cleanupPlayerProxy, createPlayerProxy, isPlayerProxyCurrent } from '../extras/createPlayerProxy'
import { createEntityProxy } from '../extras/createEntityProxy'
import { serializeError } from '../extras/serializeError'
import { registerAppProxy } from '../nodes/refs'
import { createScriptTimers } from '../extras/scriptTimers'
import { createScriptResponse, toHostFetchOptions } from '../extras/scriptFetch'
import { toScriptError } from '../extras/scriptValues'
import { copyProps } from '../extras/appFields'
import { NodeLimitError } from '../extras/nodeLimits.js'
import { createEventQueue } from '../extras/appEventQueue'
import { briefError, createLogOnce } from '../extras/logOnce'

const hotEventNames = ['fixedUpdate', 'update', 'animate', 'lateUpdate']

// an app says once per reason that it is dropping events; the count is kept on the app
const logDroppedEvent = createLogOnce()
// a teardown stage that throws is reported once per app and stage
const logTeardown = createLogOnce(message => console.error(message))

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
    this.crashed = false
    this.worldNodes = new Set()
    this.hotEvents = 0
    this.worldListeners = new Map()
    this.listeners = {}
    this.droppedEvents = 0
    this.eventDrops = new Map()
    this.eventQueue = createEventQueue({
      ledger: world.apps.eventLedger,
      isServer: world.network.isServer,
      onDrop: reason => this.dropEvent(reason),
    })
    this.snaps = []
    this.root = createNode('group')
    this.fields = []
    // this instance's own copy of the blueprint props (rebuilt with every build)
    this.props = {}
    // live mounted nodes counted against the node budget (Node.js)
    this.liveNodes = 0
    this.target = null
    this.projectLimit = Infinity
    this.resetOnMove = false
    this.animateDelta = 0
    this.animateRate = 0.001
    // the player handles of the current run: { run, cache: id -> proxy, owned: every proxy made in the run }; the
    // owned set (not the cache, which a lookup can replace) is what unbuild cleans up
    this.players = null
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
    const failureVersion = this.physicsFailureVersion
    // fetch blueprint
    const blueprint = this.world.blueprints.get(this.data.blueprint)

    if (blueprint.disabled) {
      this.unbuild()
      this.blueprint = blueprint
      this.props = copyProps(blueprint.props)
      this.eventQueue.clear() // a disabled app runs no script; nothing queued can be delivered
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
    if (this.n !== n || this.world.fatalError) return
    // unbuild any previous version
    this.unbuild()
    // mode
    this.mode = Modes.ACTIVE
    if (this.data.mover) this.mode = Modes.MOVING
    if (this.data.uploader && this.data.uploader !== this.world.network.id) this.mode = Modes.LOADING
    // setup
    this.blueprint = blueprint
    // scripts change this copy, never the shared blueprint (other instances, the snapshot and the sidebar read that)
    this.props = copyProps(blueprint.props)
    this.root = root
    if (!blueprint.scene) {
      this.root.position.fromArray(this.data.position)
      this.root.quaternion.fromArray(this.data.quaternion)
      this.root.scale.fromArray(this.data.scale)
    }
    // activate
    try {
      this.root.activate({ world: this.world, entity: this, moving: !!this.data.mover, run: this.deadHook })
    } catch (err) {
      if (!(err instanceof NodeLimitError)) throw err
      // the model alone is over the node budget: this run shows the crash block instead (crash() below queues it,
      // also when the app was already crashed before this build)
      if (!crashed) {
        crashed = true
        this.crashed = false
        this.crash()
      }
    }
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
    if (this.n !== n || this.world.fatalError) return
    if (this.physicsFailureVersion !== failureVersion) {
      this.building = false
      return
    }
    if (runScript) {
      this.crashed = false
      this.nativeFailure = false
      this.abortController = new AbortController()
      try {
        // the fetch and setTimeout this run gets are bound to it (and to its request controller): kept and called
        // after a rebuild, they act for nobody
        const run = this.deadHook
        const controller = this.abortController
        const runFetch = (url, options) => this.fetchFor(run, controller, url, options)
        const runSetTimeout = (fn, ms) => this.setTimeoutFor(run, fn, ms)
        this.script.exec(this.getWorldProxy(), this.getAppProxy(), runFetch, this.props, runSetTimeout)
        if (this.n !== n || this.crashed || this.world.fatalError) return
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
    // execute any events we collected while building. a listener that throws is reported and the rest are
    // still delivered, so the build always finishes
    this.eventQueue.drain(
      this.blueprint.version,
      event => this.emit(event.name, event.data, event.networkId),
      err => this.dropEvent('listener error', err),
      {
        latest: this.world.blueprints.get(this.data.blueprint)?.version,
        author: this.world.blueprints.authors.get(this.data.blueprint),
      }
    )
    // finished!
    this.building = false
  }

  // Every stage runs even when an earlier one throws (a script's destroy listener, a script callback reached
  // from a cleanup, a node's unmount), so the nodes are unmounted and release their budget, listeners, timers
  // and requests are gone, and the run is latched dead whatever the script did.
  unbuild() {
    const stage = (name, fn) => {
      try {
        fn()
      } catch (err) {
        logTeardown(
          this,
          name,
          `[app] ${String(this.data.id).slice(0, 64)}: teardown (${name}) failed: ${briefError(err)}`
        )
      }
    }
    // notify any running script; a throwing listener must not skip the teardown below
    this.destroying = true
    try {
      this.emit('destroy')
    } catch (err) {
      console.error('script destroy() crashed', this)
      console.error(err)
    } finally {
      this.destroying = false
    }
    // cancel any control
    stage('control', () => this.control?.release())
    this.control = null
    // cancel any effects; the cleanups are host-private (createPlayerProxy) and each runs on its own. While they run
    // the run's registry is closing: a cleanup callback (an effect's onEnd) that looks a player up gets the stopped
    // error instead of a new handle, so nothing of this run reaches the next one and the drain ends
    const players = this.players
    if (players && players.run === this.deadHook) {
      players.closing = true
      players.cache.clear()
      while (players.owned.size) {
        const [proxy] = players.owned
        players.owned.delete(proxy)
        stage('player', () => cleanupPlayerProxy(proxy))
      }
    }
    this.players = null
    // deactivate local node
    stage('root', () => this.root?.deactivate())
    // deactivate world nodes
    // (only nodes this app still owns: one another app took over left this list when it moved)
    for (const node of [...this.worldNodes]) {
      if (node._worldOwner !== this) continue
      stage('world nodes', () => {
        node._worldOwner = null
        node.deactivate()
      })
    }
    this.worldNodes.clear()
    // clear script event listeners
    stage('listeners', () => this.clearEventListeners())
    this.hotEvents = 0
    // cancel update tracking
    stage('hot', () => this.world.setHot(this, false))
    // abort fetch's etc
    stage('requests', () => this.abortController?.abort())
    this.abortController = null
    // cancel script timers
    stage('timers', () => this.timers.clear())
    // mark dead and re-create hook (async etc): proxies, nodes and player handles of this run stop working
    this.deadHook.dead = true
    this.deadHook = { dead: false }
    // clear fields
    stage('fields', () => this.onFields?.([]))
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
      this.eventQueue.clear()
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
    if (this.crashed || this.destroyed) return
    this.crashed = true
    this.deadHook.dead = true
    this.timers.clear()
    this.world.setHot(this, false)
    const n = ++this.n // invalidate builds already waiting on assets
    queueMicrotask(() => {
      if (this.n !== n || this.destroyed || this.world.fatalError) return
      const promise = this.build(true)
      const build = this.n
      promise.catch(err => {
        handlePhysicsFailure(err, { entity: this, phase: 'crash rebuild' })
        console.error(`[app] crash rebuild failed (entity ${this.data.id})`)
        if (this.n === build) this.building = false
      })
    })
  }

  destroy(local) {
    if (this.destroyed) return
    this.destroyed = true
    this.n++
    this.eventQueue.clear()

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
    // a crashed app still gets its destroy event so the script can clean up; native work from it is
    // refused by the latched script boundaries
    const suppressed = () => (this.crashed && name !== 'destroy') || this.world.fatalError
    if (suppressed()) return
    if (!this.listeners[name]) return
    for (const callback of this.listeners[name]) {
      if (suppressed()) return
      callback(a1, a2)
    }
  }

  onWorldEvent(name, callback) {
    let listeners = this.worldListeners.get(callback)
    if (!listeners) this.worldListeners.set(callback, (listeners = new Map()))
    if (listeners.has(name)) return
    const run = this.deadHook
    const wrapped = (...args) => {
      if (this.crashed || this.world.fatalError || run.dead) return
      callback(...args)
    }
    listeners.set(name, wrapped)
    this.world.events.on(name, wrapped)
  }

  offWorldEvent(name, callback) {
    const listeners = this.worldListeners.get(callback)
    const wrapped = listeners?.get(name)
    if (!wrapped) return
    listeners.delete(name)
    if (!listeners.size) this.worldListeners.delete(callback)
    this.world.events.off(name, wrapped)
  }

  clearEventListeners() {
    // local
    this.listeners = {}
    // world
    for (const listeners of this.worldListeners.values()) {
      for (const [name, wrapped] of listeners) {
        this.world.events.off(name, wrapped)
      }
    }
    this.worldListeners.clear()
  }

  onEvent(version, name, data, networkId, meta) {
    if (!Number.isSafeInteger(version) || version < 0) return this.dropEvent('invalid version')
    const latest = this.world.blueprints.get(this.data.blueprint)?.version
    // An optimistic upload can run its cached script before announcing the next blueprint version.
    const keep = version === latest + 1
    if (version > latest && (!keep || !meta?.builder)) return this.dropEvent('future version')
    if (this.building || version > this.blueprint.version) {
      this.eventQueue.push({ version, name, data, networkId }, meta, { keep, blueprintId: this.data.blueprint })
    } else {
      try {
        this.emit(name, data, networkId)
      } catch (err) {
        this.dropEvent('listener error', err)
      }
    }
  }

  dropEvent(reason, err) {
    this.droppedEvents++
    this.eventDrops.set(reason, (this.eventDrops.get(reason) || 0) + 1)
    logDroppedEvent(
      this,
      reason,
      `[app] ${String(this.data.id).slice(0, 64)}: event dropped (${reason}); further drops for this app are counted only${err ? `: ${briefError(err)}` : ''}`
    )
  }

  // scripts get a whitelisted request init and a response of plain values (see scriptFetch.js). A failed request
  // rejects with a script-safe error, like the standard fetch. Once the run that made the request has ended
  // (rebuild, crash, removal: unbuild aborts the request) the promise stays pending, so nothing reaches a stopped
  // script and the abort is not reported; a fetch called by a run that has ended starts nothing and stays pending too
  fetchFor(run, controller, url, options = {}) {
    const signal = controller?.signal
    const isDead = () => run !== this.deadHook || run.dead || this.crashed || this.destroyed || !!this.world.fatalError
    return new Promise((resolve, reject) => {
      if (!signal || isDead()) return
      let init
      try {
        init = { ...toHostFetchOptions(options), signal }
      } catch (err) {
        return reject(toScriptError(err))
      }
      let request
      try {
        request = fetch(url, init)
      } catch (err) {
        return reject(toScriptError(err))
      }
      Promise.resolve(request).then(
        resp => {
          if (isDead()) return
          resolve(createScriptResponse(resp, isDead))
        },
        err => {
          if (isDead() || signal.aborted) return
          reject(toScriptError(err))
        }
      )
    })
  }

  // scripts get an opaque handle; the timer itself stays host-private. A run that has ended gets the stopped error
  setTimeoutFor(run, fn, ms) {
    if (run !== this.deadHook) throw stoppedError(this)
    assertScriptActive(this)
    return this.timers.set(() => {
      if (this.crashed || this.world.fatalError || run.dead) return
      fn()
    }, ms)
  }

  // the current run's (host code and tests; scripts get the run-bound ones from build)
  fetch = (url, options) => this.fetchFor(this.deadHook, this.abortController, url, options)
  setTimeout = (fn, ms) => this.setTimeoutFor(this.deadHook, fn, ms)

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

  // player handles belong to the current run (the cache is emptied by unbuild)
  getPlayerProxy(playerId) {
    if (playerId === undefined) playerId = this.world.entities.player?.data.id
    if (this.players?.run !== this.deadHook) this.players = { run: this.deadHook, cache: new Map(), owned: new Set() }
    const players = this.players
    if (players.closing) throw stoppedError(this)
    let proxy = players.cache.get(playerId)
    if (!proxy || !isPlayerProxyCurrent(proxy)) {
      // a proxy whose player left is cleaned up now (it stays owned until then, whatever the cache holds)
      if (proxy && players.owned.delete(proxy)) cleanupPlayerProxy(proxy)
      const player = this.world.entities.getPlayer(playerId)
      if (!player) return null
      proxy = createPlayerProxy(this, player)
      players.cache.set(playerId, proxy)
      players.owned.add(proxy)
    }
    return proxy
  }

  // the world and app proxies are made per run (see createEntityProxy): an old run's proxy stops working
  getWorldProxy() {
    if (!this.worldProxy || this.worldProxyRun !== this.deadHook) {
      const entity = this
      this.worldProxyRun = this.deadHook
      this.worldProxy = createEntityProxy(entity, {
        getters: this.world.apps.worldGetters,
        setters: this.world.apps.worldSetters,
        methods: this.world.apps.worldMethods,
        destroyMethods: ['off', 'remove'],
        run: this.deadHook,
      })
    }
    return this.worldProxy
  }

  getAppProxy() {
    if (!this.appProxy || this.appProxyRun !== this.deadHook) {
      const entity = this
      const run = this.deadHook
      this.appProxyRun = run
      this.appProxy = createEntityProxy(entity, {
        run,
        getters: this.world.apps.appGetters,
        setters: this.world.apps.appSetters,
        methods: this.world.apps.appMethods,
        destroyMethods: ['off', 'send', 'sendTo'],
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
      // lets world.add(app) etc resolve to the app's root node, for as long as its run lasts
      registerAppProxy(this.appProxy, () => (run === entity.deadHook ? entity.root.getProxy() : null))
    }
    return this.appProxy
  }
}
