import assert from 'node:assert/strict'
import { holdEffect, reserveLike } from './effectPlayer.mjs'
import { EventEmitter } from 'node:events'
import { resolveObjectURL } from 'node:buffer'

// The world the teardown sweeps run apps in: the real App, Apps, Blueprints, ClientControls, ServerLiveKit, Stage,
// Anchors and nodes (`m`, a bundle made after lockdown), scripts in real compartments (`scripts`), and stand-ins that
// count what they hold for the loader, the network, the audio context, the players, the browser and the other node
// registries (LODs, actions, snaps, nametags, particles, skies, video instances, screen-space UI canvases). `requests`
// lists every request the host fetch started.
export function createSweep({ m, scripts, requests }) {
  const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

  // an audio context stand-in that counts the sources that started and were not stopped, and the nodes connected to an
  // output (a group gain); as in Web Audio, stopping a source that never started throws. `audio.locked` holds the
  // starts that wait for the audio unlock (null: unlocked)
  function audioSystem() {
    const audio = { started: new Set(), feeding: new Set(), locked: null }
    const node = () => {
      const self = {
        connect: target => target?.isOutput && audio.feeding.add(self),
        disconnect: () => audio.feeding.delete(self),
        setPosition() {},
        setOrientation() {},
        gain: { value: 1 },
      }
      return self
    }
    audio.ctx = {
      currentTime: 0,
      createGain: node,
      createPanner: node,
      createBufferSource() {
        const source = node()
        source.start = () => audio.started.add(source)
        source.stop = () => {
          if (!audio.started.has(source)) throw new Error('InvalidStateError: the source has not started')
          audio.started.delete(source)
        }
        return source
      },
    }
    audio.groupGains = { music: { ...node(), isOutput: true }, sfx: { ...node(), isOutput: true } }
    audio.ready = fn => (audio.locked ? audio.locked.push(fn) : fn())
    audio.lastDelta = 0
    return audio
  }

  // a registry stand-in: what a node registers is listed until it is released; handles answer any call
  function registry(kind) {
    const live = new Set()
    const handle = () => {
      const entry = new Proxy(
        {},
        {
          get: (_target, key) => {
            if (key === 'destroy' || key === 'release') return () => live.delete(entry)
            return () => {}
          },
        }
      )
      live.add(entry)
      return entry
    }
    const methods = {
      lods: { register: node => live.add(node), unregister: node => live.delete(node) },
      actions: { register: node => live.add(node), unregister: node => live.delete(node) },
      snaps: { create: () => handle() },
      nametags: { add: () => handle() },
      particles: { register: () => handle() },
      environment: { addSky: () => handle() },
    }
    return Object.assign({ live }, methods[kind])
  }

  // the player stand-in behaves as the players do: the local player reads (sanitises) a new effect before it installs
  // it, and replacing an effect ends the current one first (its onEnd runs)
  function makePlayer(world, id) {
    return {
      world,
      data: { id, owner: id, health: 100, effect: null },
      onEffectEnd: null,
      setEffect(effect, onEnd) {
        if (effect) effect = JSON.parse(JSON.stringify(effect))
        holdEffect.call(this, effect, onEnd)
      },
      modify(data) {
        Object.assign(this.data, data)
      },
    }
  }

  // a canvas stand-in (UI nodes draw into one; a screen-space UI puts it in the pointer layer)
  function fakeCanvas() {
    const noop = () => {}
    const metrics = { width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }
    const ctx2d = new Proxy(
      {},
      {
        get: (target, key) => (key === 'measureText' ? () => metrics : key in target ? target[key] : noop),
        set: (target, key, value) => ((target[key] = value), true),
      }
    )
    return {
      width: 0,
      height: 0,
      style: {},
      getContext: () => ctx2d,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
      addEventListener: noop,
      removeEventListener: noop,
    }
  }

  // a video factory stand-in: every instance a node takes is listed until the node releases it
  function videoFactory(world) {
    return {
      get() {
        const instance = {
          prepare: Promise.resolve(),
          width: 16,
          height: 9,
          texture: null,
          audio: null,
          loop: false,
          isPlaying: false,
          duration: 1,
          currentTime: 0,
          play() {},
          pause() {},
          stop() {},
          release: () => world.videoInstances.delete(instance),
        }
        world.videoInstances.add(instance)
        return instance
      },
    }
  }

  function defaultModel(url) {
    const root = m.createNode('group')
    if (String(url).startsWith('empty')) return root
    const geometry = (defaultModel.geometry ??= new m.THREE.BoxGeometry(1, 1, 1))
    const material = (defaultModel.material ??= new m.THREE.MeshStandardMaterial({ color: 'white' }))
    for (const id of ['first', 'last']) {
      root.add(m.createNode('mesh', { id, type: 'geometry', geometry, material, linked: true }))
    }
    const clip = new m.THREE.AnimationClip('idle', 1, [])
    const object3d = new m.THREE.Group()
    const bone = new m.THREE.Bone()
    bone.name = 'hip'
    object3d.add(bone)
    root.add(m.createNode('skinnedmesh', { id: 'skinned', object3d, animations: [clip] }))
    return root
  }

  // a world (client or server) with one player 'p1' and an app whose model holds two linked meshes 'first' and 'last'
  // and a skinned mesh 'skinned' with a bone 'hip' (a rebuild into an empty script also loads an empty model)
  function makeWorld({ isServer = false, models } = {}) {
    const compiled = new Map()
    const lock = { request: 0 }
    const model = models || defaultModel
    const world = Object.assign(new EventEmitter(), {
      network: {
        isServer,
        isClient: !isServer,
        id: 'me',
        send: () => true,
        sendTo: () => true,
        broadcast: () => 'delivered',
        reserve: reserveLike,
        asScript: fn => fn(),
      },
      // (the server's world store; a client world has none)
      storage: isServer ? { get() {}, set() {} } : undefined,
      entities: {
        items: new Map(),
        get: id => world.entities.items.get(id) ?? world.entities.players.get(id),
        remove: id => world.entities.items.delete(id),
        // (the join budget's record of a rebuilt app's emptied state, Entities.stateEmptied)
        stateEmptied() {},
      },
      events: new EventEmitter(),
      hot: new Set(),
      setHot: (item, hot) => (hot ? world.hot.add(item) : world.hot.delete(item)),
      scripts: {},
      chat: { add() {} },
      audio: audioSystem(),
      graphics: { maxAnisotropy: 1 },
      loader: {
        get: (type, url) => {
          if (type === 'audio') return world.loaderOverride?.audio ? world.loaderOverride.audio(url) : { duration: 1 }
          if (type === 'image') return { width: 2, height: 1 }
          if (type === 'video') return videoFactory(world)
          if (world.loaderOverride?.[type]) return world.loaderOverride[type](url)
          if (type !== 'script') return { toNodes: () => model(url) }
          if (!compiled.has(url)) compiled.set(url, scripts.evaluate(world.scripts[url]))
          return compiled.get(url)
        },
        load: (type, url) => world.loaderLoad?.(type, url) ?? Promise.reject(new Error(`no ${type} ${url}`)),
        // an app's requests go through its world's loader: here, to whatever a test put in place of the global fetch
        scriptFetch: (url, init) => globalThis.fetch(url, init),
      },
      ui: {
        suppressors: 0,
        suppressReticle: () => {
          world.ui.suppressors++
          return () => world.ui.suppressors--
        },
      },
      livekit: { registerScreenNode: () => null, unregisterScreenNode: () => {} },
      videoInstances: new Set(),
      pointer: {
        ui: {
          canvases: new Set(),
          prepend: canvas => world.pointer.ui.canvases.add(canvas),
          removeChild: canvas => world.pointer.ui.canvases.delete(canvas),
        },
        setScreenHit() {},
      },
      rig: new m.Object3D(),
      camera: new m.Object3D(),
      setupMaterial() {},
      resolveURL: url => String(url).replace('asset://', 'http://assets.invalid/'),
    })
    world.stage = new m.Stage(world)
    world.anchors = new m.Anchors(world)
    for (const kind of ['lods', 'actions', 'snaps', 'nametags', 'particles', 'environment'])
      world[kind] = registry(kind)
    const sceneBaseline = world.stage.scene.children.filter(object => !object.isMesh).length
    const player = makePlayer(world, 'p1')
    world.entities.getPlayer = id => world.entities.players.get(id) ?? null
    world.entities.players = new Map([['p1', player]])
    world.apps = new m.Apps(world)
    world.blueprints = new m.Blueprints(world)
    world.controls = new m.ClientControls(world)
    world.controls.viewport = { requestPointerLock: async () => lock.request++ }
    globalThis.document = { exitPointerLock() {}, createElement: () => fakeCanvas() }
    if (isServer) world.livekit = new m.ServerLiveKit(world)
    return { world, player, lock, sceneBaseline, makePlayer: id => makePlayer(world, id) }
  }

  function addApp(world, code, id = 'a') {
    world.scripts[`${id}.js`] = code
    world.blueprints.add({ id: `bp-${id}`, version: 0, name: id, model: `${id}.glb`, script: `${id}.js`, props: {} })
    const app = new m.App(world, {
      id,
      blueprint: `bp-${id}`,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      state: {},
    })
    world.entities.items.set(id, app)
    return app
  }

  function octreeItems(node) {
    return node.items.length + (node.children || []).reduce((n, child) => n + octreeItems(child), 0)
  }

  function mountedUnder(root) {
    let mounted = 0
    root?.traverse(node => node.mounted && mounted++)
    return mounted
  }

  // Everything a run can leave behind. `replacement` is the root of the run that replaced it (a rebuild into an empty
  // script and model): only that root, once it is shown to be the app's current run's, is exempt. After a removal
  // nothing is.
  function footprint({ world, sceneBaseline }, app, { replacement = null, oldRun = null, oldRoot = null, urls } = {}) {
    let exempt = 0
    if (replacement) {
      assert.ok(app.root === replacement && app.deadHook !== oldRun, 'the app runs a new run')
      assert.equal(replacement.ctx?.run, app.deadHook, "the exempt root is the new run's")
      exempt = mountedUnder(replacement)
    }
    const ofApp = item =>
      item === app || item?.ctx?.entity === app || item?.hotOwner?.ctx?.entity === app || item?._created?.entity === app
    const modifiers = world.livekit.modifiers ? Object.values(world.livekit.modifiers) : []
    return {
      strayNodes: app.liveNodes - exempt,
      mountedUnderOldRoot: replacement ? mountedUnder(oldRoot) : mountedUnder(app.root),
      worldNodes: app.worldNodes.size,
      sceneMeshes: world.stage.scene.children.filter(object => object.isMesh && !object.isInstancedMesh).length,
      sceneObjects: world.stage.scene.children.filter(object => !object.isMesh).length - sceneBaseline,
      linkedInstances: [...world.stage.models.values()].reduce((n, model) => n + model.items.length, 0),
      octreeItems: octreeItems(world.stage.octree.root),
      anchors: world.anchors.matrices.size,
      lods: world.lods.live.size,
      actions: world.actions.live.size,
      snaps: world.snaps.live.size,
      nametags: world.nametags.live.size,
      particles: world.particles.live.size,
      skies: world.environment.live.size,
      videoInstances: world.videoInstances.size,
      uiCanvases: world.pointer.ui.canvases.size,
      controls: world.controls.controls.filter(control => control.options.object === app).length,
      reticleSuppressors: world.ui.suppressors,
      hudActions: world.controls.actions.length,
      pointerOwner: world.controls.pointerOwner ? 'held' : null,
      activeEffects: [...world.entities.players.values()].filter(player => player.data.effect).length,
      voiceModifiers: modifiers.reduce((n, set) => n + set.size, 0),
      worldListeners:
        ['enter', 'leave', 'late', 'sweep-ping', 'sweep-relay'].reduce(
          (n, name) => n + world.events.listenerCount(name),
          0
        ) + app.worldListeners.size,
      appListeners: Object.values(app.listeners).reduce((n, set) => n + set.size, 0),
      timers: app.timers.size,
      hot: [...world.hot].filter(ofApp).length,
      pendingRequests: requests.filter(request => !request.settled && !request.signal.aborted).length,
      playingSounds: world.audio.started.size,
      audioOutputs: world.audio.feeding.size,
      liveObjectURLs: (urls || []).filter(url => resolveObjectURL(url)).length,
      fields: app.fields.length,
    }
  }

  const CLEAN = {
    strayNodes: 0,
    mountedUnderOldRoot: 0,
    worldNodes: 0,
    sceneMeshes: 0,
    sceneObjects: 0,
    linkedInstances: 0,
    octreeItems: 0,
    anchors: 0,
    lods: 0,
    actions: 0,
    snaps: 0,
    nametags: 0,
    particles: 0,
    skies: 0,
    videoInstances: 0,
    uiCanvases: 0,
    controls: 0,
    reticleSuppressors: 0,
    hudActions: 0,
    pointerOwner: null,
    activeEffects: 0,
    voiceModifiers: 0,
    worldListeners: 0,
    appListeners: 0,
    timers: 0,
    hot: 0,
    pendingRequests: 0,
    playingSounds: 0,
    audioOutputs: 0,
    liveObjectURLs: 0,
    fields: 0,
  }

  // remove the app, or rebuild it into an empty script and model
  function retireNow(world, app, ending) {
    if (ending === 'removed') return app.destroy()
    world.scripts['empty.js'] = ''
    const version = world.blueprints.get(app.data.blueprint).version + 1
    world.blueprints.modify({ id: app.data.blueprint, version, script: 'empty.js', model: 'empty.glb' })
  }

  // tear the run down from the outside, and say what is exempt afterwards
  async function end(world, app, ending) {
    const oldRoot = app.root
    const oldRun = app.deadHook
    if (!app.destroyed && oldRun === app.deadHook && !app.data.retired) retireNow(world, app, ending)
    await tick(20)
    const replaced = ending !== 'removed' && !app.destroyed
    return { replacement: replaced ? app.root : null, oldRoot, oldRun }
  }

  // the host side of a script's retire(): the first 'retire' event removes the app or rebuilds it, synchronously
  function onRetire(world, app, ending) {
    const state = { oldRoot: app.root, oldRun: app.deadHook, retired: false }
    const listener = () => {
      if (state.retired) return
      state.retired = true
      state.oldRoot = app.root
      state.oldRun = app.deadHook
      retireNow(world, app, ending)
    }
    world.events.on('retire', listener)
    state.stop = () => world.events.off('retire', listener)
    return state
  }

  return {
    tick,
    makeWorld,
    addApp,
    footprint,
    CLEAN,
    end,
    onRetire,
    retireNow,
    mountedUnder,
    octreeItems,
  }
}

// a callout an engine operation makes on a host node (what a script could once reach through an accessor on an engine
// math object, now sealed): the first call to `phase` runs `fn` before the node's own code, or after it with
// `{ after: true }` (a callback at the end of an unmount, say)
export function calloutOn(node, phase, fn, { after = false } = {}) {
  const original = node[phase]
  let once = false
  node[phase] = function (...args) {
    const first = !once
    once = true
    if (first && !after) fn()
    const result = Reflect.apply(original, this, args)
    if (first && after) fn()
    return result
  }
}
