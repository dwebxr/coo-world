import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// the real lockdown config (ses must be imported first, as in src/server/index.js)
import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'

// The executable teardown sweep. For every point where an app's script code runs while its run is torn down (or
// while a handle of it is evicted), the script tries every allocating API it has; afterwards, once the app is removed
// and separately once it is rebuilt into an empty script, nothing of that run may remain, and the handles it kept may
// no longer change host state. The scripts run in real compartments with the real App, Apps, Blueprints,
// ClientControls, ServerLiveKit, Stage and nodes; the loader, the network, the players and the browser are
// stand-ins. A new callback point is one entry in POINTS, a new allocating API one entry in ATTEMPTS.
let bundle
let m
let scripts
const realFetch = globalThis.fetch
const realDocument = globalThis.document
const requests = [] // the signals of every request the host started

before(async () => {
  bundle = await bundleProbe(`
    export { Scripts } from './src/core/systems/Scripts'
    export { App } from './src/core/entities/App'
    export { Apps } from './src/core/systems/Apps'
    export { Blueprints } from './src/core/systems/Blueprints'
    export { ClientControls } from './src/core/systems/ClientControls'
    export { ServerLiveKit } from './src/core/systems/ServerLiveKit'
    export { Stage } from './src/core/systems/Stage'
    export { createNode } from './src/core/extras/createNode'
    export * as THREE from './src/core/extras/three'
    export { Object3D } from 'three'
  `)
  m = await import(bundle.url)
  scripts = new m.Scripts({})
  // a request only ends when it is aborted (no network)
  globalThis.fetch = (_url, init) => {
    requests.push(init.signal)
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
})
after(() => {
  globalThis.fetch = realFetch
  globalThis.document = realDocument
  bundle?.destroy()
})

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

// Every allocating API of the script surface, as script code run by attemptAll(). `kept` holds what the run made at
// build: a player handle, a control, a world-space holder node with an inactive child, a linked mesh's material and a
// video's material.
const ATTEMPTS = {
  getPlayer: `if (!world.getPlayer('p1')) throw new Error('no handle')`,
  'fresh handle: applyEffect': `world.getPlayer('p1').applyEffect({ freeze: true, duration: 600 })`,
  'fresh handle: setVoiceLevel': `world.getPlayer('p1').setVoiceLevel('global')`,
  'kept handle: applyEffect': `kept.player.applyEffect({ freeze: true, duration: 600 })`,
  'kept handle: setVoiceLevel': `kept.player.setVoiceLevel('global')`,
  'app.control': `app.control().hideReticle()`,
  'kept control: hideReticle': `kept.control.hideReticle()`,
  'kept control: pointer.lock': `kept.control.pointer.lock()`,
  'kept control: setActions': `kept.control.setActions([{ type: 'keyE', label: 'Use' }])`,
  'world.add': `world.add(app.create('group'))`,
  'world.add (video)': `world.add(app.create('video', { width: 1, height: 1 }))`,
  'world.attach': `const g = app.create('group'); const n = app.create('group'); g.add(n); world.attach(n)`,
  'app.add': `app.add(app.create('group'))`,
  'kept node: add': `kept.holder.add(app.create('group'))`,
  'kept node: active = true': `kept.hidden.active = true`,
  setTimeout: `setTimeout(() => fired.push('timer'), 0)`,
  'app.on (update)': `app.on('update', () => fired.push('update'))`,
  'world.on': `world.on('enter', () => fired.push('enter'))`,
  fetch: `fetch('https://example.invalid/')`,
  'app.emit': `app.emit('sweep-ping', 1)`,
  'app.send': `app.send('sweep-ping', 1)`,
  'world.chat': `world.chat('hello', true)`,
  'kept material: color': `kept.material.color = 'red'`,
  'kept video material: textureX': `kept.videoMaterial.textureX = 0.5`,
}

// Where script code runs during teardown (or eviction), as the code that makes attemptAll(label) run there.
const POINTS = {
  'destroy event': `app.on('destroy', () => attemptAll('destroy'))`,
  'control onRelease': ``, // the kept control's onRelease (see below)
  'effect onEnd': `kept.player.applyEffect({ freeze: true, duration: 60, onEnd: () => attemptAll('onEnd') })`,
  // the review's reproduction: unmounting the first of two linked meshes moves the last one's matrix into the freed
  // slot and reads it through a method the script defined on that matrixWorld
  'unmount, root stage (matrixWorld.toArray)': `hook(app.get('last').matrixWorld, 'unmount (root)')`,
  'unmount, world-nodes stage (matrixWorld.toArray)': `
    const first = app.get('first')
    const last = app.get('last')
    world.add(first)
    world.add(last)
    hook(last.matrixWorld, 'unmount (world)')`,
  'world listener reached from an unmount (app.emit)': `
    world.on('sweep-relay', () => attemptAll('relayed listener'))
    const matrix = app.get('last').matrixWorld
    const original = matrix.toArray
    let once = false
    Object.defineProperty(matrix, 'toArray', {
      value(...args) {
        if (!once) {
          once = true
          app.emit('sweep-relay', 1)
        }
        return Reflect.apply(original, this, args)
      },
    })`,
  // the review's eviction reproduction: the lookup in the leave listener evicts and cleans the kept handle
  'leave listener after eviction': `
    world.on('leave', ({ playerId }) => {
      if (playerId !== 'p1') return
      world.getPlayer(playerId)
      attemptAll('leave')
    })`,
}

function scriptFor(point) {
  const attempts = Object.entries(ATTEMPTS)
    .map(([name, code]) => `[${JSON.stringify(name)}, () => { ${code} }]`)
    .join(',\n')
  return `
    const log = (app.state.log = [])
    const fired = (app.state.fired = [])
    const ATTEMPTS = [${attempts}]
    function attemptAll(label) {
      for (const [name, attempt] of ATTEMPTS) {
        try {
          attempt()
          log.push(label + ' | ' + name + ' | ok')
        } catch (err) {
          log.push(label + ' | ' + name + ' | ' + err.message)
        }
      }
    }
    const hook = (matrix, label) => {
      const original = matrix.toArray
      let once = false
      Object.defineProperty(matrix, 'toArray', {
        value(...args) {
          if (!once) {
            once = true
            attemptAll(label)
          }
          return Reflect.apply(original, this, args)
        },
      })
    }
    const kept = {}
    kept.player = world.getPlayer('p1')
    kept.player.setVoiceLevel('spatial')
    kept.control = app.control(${point === 'control onRelease' ? `{ onRelease: () => attemptAll('onRelease') }` : ''})
    kept.holder = app.create('group')
    world.add(kept.holder)
    kept.hidden = app.create('group', { active: false })
    kept.holder.add(kept.hidden)
    kept.material = app.get('first').material
    const video = app.create('video', { width: 1, height: 1 })
    world.add(video)
    kept.videoMaterial = video.material
    ${POINTS[point]}
    app.state.attemptAll = attemptAll
  `
}

// a world (client or server) with one player 'p1' and an app whose model holds two linked meshes 'first' and 'last'
function makeWorld({ isServer }) {
  const compiled = new Map()
  const lock = { request: 0 }
  const world = Object.assign(new EventEmitter(), {
    network: { isServer, isClient: !isServer, id: 'me', send: () => true, asScript: fn => fn() },
    entities: { items: new Map(), remove: id => world.entities.items.delete(id) },
    events: new EventEmitter(),
    hot: new Set(),
    setHot: (item, hot) => (hot ? world.hot.add(item) : world.hot.delete(item)),
    scripts: {},
    chat: { add() {} },
    loader: {
      get: (type, url) => {
        if (type !== 'script') return { toNodes: () => model() }
        if (!compiled.has(url)) compiled.set(url, scripts.evaluate(world.scripts[url]))
        return compiled.get(url)
      },
    },
    ui: {
      suppressors: 0,
      suppressReticle: () => {
        world.ui.suppressors++
        return () => world.ui.suppressors--
      },
    },
    livekit: { registerScreenNode: () => null, unregisterScreenNode: () => {} },
    rig: new m.Object3D(),
    camera: new m.Object3D(),
    setupMaterial() {},
  })
  world.stage = new m.Stage(world)
  const geometry = new m.THREE.BoxGeometry(1, 1, 1)
  const material = new m.THREE.MeshStandardMaterial({ color: 'white' })
  const model = () => {
    const root = m.createNode('group')
    for (const id of ['first', 'last']) {
      root.add(m.createNode('mesh', { id, type: 'geometry', geometry, material, linked: true }))
    }
    return root
  }
  const player = {
    world,
    data: { id: 'p1', owner: 'p1', health: 100 },
    effects: [],
    setEffect(effect, onEnd) {
      this.effects.push(effect)
      this.onEnd = onEnd
    },
    modify(data) {
      Object.assign(this.data, data)
    },
  }
  world.entities.getPlayer = id => (id === 'p1' ? player : null)
  world.apps = new m.Apps(world)
  world.blueprints = new m.Blueprints(world)
  world.controls = new m.ClientControls(world)
  world.controls.viewport = { requestPointerLock: async () => lock.request++ }
  globalThis.document = { exitPointerLock() {} }
  if (isServer) world.livekit = new m.ServerLiveKit(world)
  return { world, player, lock }
}

function addApp(world, code) {
  world.scripts['sweep.js'] = code
  world.blueprints.add({ id: 'bp', version: 0, name: 'sweep', model: 'm.glb', script: 'sweep.js', props: {} })
  const app = new m.App(world, {
    id: 'a',
    blueprint: 'bp',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    state: {},
  })
  world.entities.items.set('a', app)
  return app
}

// the run's footprint in host state: everything a run can leave behind
function footprint({ world, player, lock }, app) {
  const mountedInRoot = []
  app.root?.traverse(node => node.mounted && mountedInRoot.push(node))
  const listeners = ['enter', 'leave', 'sweep-ping', 'sweep-relay'].reduce(
    (n, name) => n + world.events.listenerCount(name),
    0
  )
  return {
    // every node mounted for the app is charged to it: after teardown only the new run's root tree may be
    strayNodes: app.liveNodes - mountedInRoot.length,
    worldNodes: app.worldNodes.size,
    videoMeshesInScene: world.stage.scene.children.filter(object => object.isMesh && !object.isInstancedMesh).length,
    linkedInstances:
      [...world.stage.models.values()].reduce((n, model) => n + model.items.length, 0) -
      mountedInRoot.filter(node => node.name === 'mesh').length,
    // what raycasts can hit
    octreeItems: octreeItems(world.stage.octree.root) - mountedInRoot.filter(node => node.name === 'mesh').length,
    controls: world.controls.controls.filter(control => control.options.object === app).length,
    reticleSuppressors: world.ui.suppressors,
    hudActions: world.controls.actions.length,
    pointerOwner: world.controls.pointerOwner ? 'held' : null,
    activeEffect: player.effects.at(-1) ?? null,
    voiceModifiers: world.livekit.modifiers?.p1?.size ?? 0,
    worldListeners: listeners + app.worldListeners.size,
    appListeners: Object.values(app.listeners).reduce((n, set) => n + set.size, 0),
    timers: app.timers.size,
    hot: world.hot.has(app),
    pendingRequests: requests.filter(signal => !signal.aborted).length,
    pointerLockRequests: lock.request,
  }
}

function octreeItems(node) {
  return node.items.length + (node.children || []).reduce((n, child) => n + octreeItems(child), 0)
}

const CLEAN = {
  strayNodes: 0,
  octreeItems: 0,
  worldNodes: 0,
  videoMeshesInScene: 0,
  linkedInstances: 0,
  controls: 0,
  reticleSuppressors: 0,
  hudActions: 0,
  pointerOwner: null,
  activeEffect: null,
  voiceModifiers: 0,
  worldListeners: 0,
  appListeners: 0,
  timers: 0,
  hot: false,
  pendingRequests: 0,
}

function linkedColor(world) {
  return [...world.stage.linkedMaterials.values()].map(material => material.raw.color.getHex())
}

const PLAYER_KINDS = [
  'getPlayer',
  'fresh handle: applyEffect',
  'fresh handle: setVoiceLevel',
  'kept handle: applyEffect',
  'kept handle: setVoiceLevel',
]
const NODE_KINDS = ['world.add', 'world.add (video)', 'world.attach', 'kept node: add']
const REFUSED = {
  'destroy event': ['app.control'],
  'control onRelease': ['app.control'],
  'effect onEnd': ['app.control', ...PLAYER_KINDS],
  'unmount, root stage (matrixWorld.toArray)': ['app.control', ...PLAYER_KINDS, ...NODE_KINDS, 'app.add'],
  'unmount, world-nodes stage (matrixWorld.toArray)': ['app.control', ...PLAYER_KINDS, 'world.add', 'world.attach'],
  'world listener reached from an unmount (app.emit)': ['app.control', ...PLAYER_KINDS, ...NODE_KINDS, 'app.add'],
  // the evicted handle starts nothing, and there is no handle for a player that has left
  'leave listener after eviction': ['getPlayer', 'kept handle: applyEffect', 'kept handle: setVoiceLevel'],
}

for (const point of Object.keys(POINTS)) {
  for (const ending of ['removed', 'rebuilt into an empty script']) {
    for (const isServer of [false, true]) {
      test(`teardown sweep: ${point}; ${ending}; ${isServer ? 'server' : 'client'}`, async () => {
        requests.length = 0
        const env = makeWorld({ isServer })
        const { world, player } = env
        {
          const app = addApp(world, scriptFor(point))
          await tick()
          assert.equal(app.crashed, false, 'the script ran')
          const log = app.data.state.log
          const attemptAll = app.data.state.attemptAll
          const fired = app.data.state.fired
          if (point === 'leave listener after eviction') {
            // the disconnect order: the player's modifiers are cleared, it is destroyed, then leave is emitted
            world.livekit.clearModifiers?.('p1')
            player.destroyed = true
            world.events.emit('leave', { playerId: 'p1' })
            assert.ok(log.length > 0, 'the listener ran')
          }
          if (ending === 'removed') {
            app.destroy()
          } else {
            world.scripts['empty.js'] = ''
            world.blueprints.modify({ id: 'bp', version: 1, script: 'empty.js' })
            await tick()
          }
          await tick(20)
          // (while an app is removed its script is stopped once the destroy event is over, so its app.emit from an
          // unmount is refused and the relayed listener is not reached)
          const reachable = !(point === 'world listener reached from an unmount (app.emit)' && ending === 'removed')
          assert.equal(log.length > 0, reachable, `script code ran at the callback point (${point})`)
          const left = footprint(env, app)
          const { pointerLockRequests, ...state } = left
          assert.deepEqual(state, CLEAN, `nothing of the run remains\n${log.join('\n')}`)
          // the handles the run kept change nothing any more
          const colors = linkedColor(world)
          const requestsBefore = pointerLockRequests
          const tried = log.length
          try {
            attemptAll('after teardown')
          } catch {
            // (the world or app proxy itself may refuse)
          }
          await tick(20)
          const { pointerLockRequests: requestsAfter, ...stateAfter } = footprint(env, app)
          assert.deepEqual(stateAfter, CLEAN, `kept handles changed nothing\n${log.slice(tried).join('\n')}`)
          assert.equal(requestsAfter, requestsBefore, 'no pointer lock requested through a kept control')
          assert.deepEqual(linkedColor(world), colors, 'a kept material changes nothing')
          const after = log.slice(tried)
          assert.equal(after.length, Object.keys(ATTEMPTS).length, 'every attempt was made again')
          // a released control answers and changes nothing, a fetch of an ended run stays pending and starts nothing,
          // and a node of an ended run takes `active = true` but mounts nothing (node handles are not run-bound; the
          // footprint above shows nothing mounted); everything else refuses
          const NO_OPS = [
            'kept control: hideReticle',
            'kept control: pointer.lock',
            'kept control: setActions',
            'fetch',
            'kept node: active = true',
          ]
          assert.deepEqual(
            after.filter(line => line.endsWith(' | ok') && !NO_OPS.some(name => line.includes(` | ${name} | `))),
            [],
            'every kept handle (world, app, player, node placement, material) refuses'
          )
          assert.deepEqual([...fired], [], 'no timer or listener of the run fired')
          if (ending !== 'removed' || point === 'leave listener after eviction') {
            const label = log[0]?.split(' | ')[0]
            const refused = REFUSED[point].filter(name => {
              const line = log.find(entry => entry.startsWith(`${label} | ${name} | `))
              return line && !line.endsWith(' | ok')
            })
            assert.deepEqual(refused, REFUSED[point], `refused at ${point}\n${log.join('\n')}`)
          }
          // legitimate uses keep working: the destroy handler may still look players up (and on a rebuild, onRelease
          // too; a removed app's script is stopped once its destroy event is over)
          if (point === 'destroy event' || (point === 'control onRelease' && ending !== 'removed')) {
            const label = point === 'destroy event' ? 'destroy' : 'onRelease'
            assert.ok(log.includes(`${label} | getPlayer | ok`), `a lookup from ${label} works\n${log.join('\n')}`)
          }
        }
      })
    }
  }
}
