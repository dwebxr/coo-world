import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolveObjectURL } from 'node:buffer'

// the real lockdown config (ses must be imported first, as in src/server/index.js)
import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'

// The executable teardown sweep. For every point where an app's script code runs while its run is torn down (or while
// a handle of it is evicted), the script tries every allocating API it has; afterwards, once the app is removed and
// separately once it is rebuilt into an empty script, nothing of that run may remain, what each stage had released
// must have been refused there (with the error the docs name), and the handles it kept may no longer change host
// state. The scripts run in real compartments with the real App, Apps, Blueprints, ClientControls, ServerLiveKit,
// Stage and nodes; the loader, the network, the audio context, the players and the browser are stand-ins. A new
// callback point is one entry in POINTS, a new allocating API one entry in ATTEMPTS; every node type in the registry
// is covered by the node-handle axis at the end.
let bundle
let m
let scripts
const realFetch = globalThis.fetch
const realDocument = globalThis.document
const requests = [] // every request the host started: { signal, settled }

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
    export * as Nodes from './src/core/nodes'
    export * as THREE from './src/core/extras/three'
    export { Object3D } from 'three'
  `)
  m = await import(bundle.url)
  scripts = new m.Scripts({})
  // a request to .../blob answers with an image; any other only ends when it is aborted (no network)
  globalThis.fetch = (url, init) => {
    const request = { signal: init.signal, settled: false }
    requests.push(request)
    if (String(url).endsWith('/blob')) {
      request.settled = true
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
    }
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
const STOPPED = '[app] this app has stopped'
const LEFT = '[player] this player has left'

// Every allocating API of the script surface, as script code run by attemptAll(). `kept` holds what the run made at
// build: a player handle, a control, a world-space holder with an inactive child, the two linked meshes and a
// material of theirs, a video and its material, a sound, a skinned mesh and a blob. `env` limits an attempt to the
// side where it allocates (voice levels exist on the server, a video's material on the client).
const ATTEMPTS = [
  ['getPlayer', `if (!world.getPlayer('p1')) throw new Error('no handle')`],
  ['getPlayers', `world.getPlayers().map(player => player.id)`],
  ['fresh handle: applyEffect', `world.getPlayer('p1').applyEffect({ freeze: true, duration: 600 })`],
  ['fresh handle: setVoiceLevel', `world.getPlayer('p1').setVoiceLevel('global')`, 'server'],
  ['kept handle: applyEffect', `kept.player.applyEffect({ freeze: true, duration: 600 })`],
  ['kept handle: setVoiceLevel', `kept.player.setVoiceLevel('global')`, 'server'],
  ['app.control', `app.control().hideReticle()`],
  ['kept control: hideReticle', `kept.control.hideReticle()`],
  ['kept control: pointer.lock', `kept.control.pointer.lock()`],
  ['kept control: setActions', `kept.control.setActions([{ type: 'keyE', label: 'Use' }])`],
  ['world.add', `world.add(app.create('group'))`],
  ['world.add (video)', `world.add(app.create('video', { width: 1, height: 1 }))`],
  // (a node under a detached parent, made at build: only world.attach itself is asked)
  ['world.attach', `world.attach(kept.attachable)`],
  ['app.add', `app.add(app.create('group'))`],
  ['kept node: add', `kept.holder.add(app.create('group'))`],
  ['kept node: active false -> true', `kept.hidden.active = false; kept.hidden.active = true`],
  // the review's clean() variant: rebuild a mesh from a callback reached while it unmounts
  ['kept mesh: rebuild (linked, clean)', `kept.first.linked = !kept.first.linked; kept.first.clean()`],
  ['kept audio: play', `kept.audio.play()`],
  ['kept skinned mesh: play', `kept.skinned.play({ name: 'absent' })`],
  ['kept blob: URL.createObjectURL', `urls.push(URL.createObjectURL(kept.blob))`],
  ['setTimeout', `setTimeout(() => fired.push('timer'), 0)`],
  ['app.on (update)', `app.on('update', () => fired.push('update'))`],
  ['world.on', `world.on('enter', () => fired.push('enter'))`],
  ['fetch', `fetch('https://example.invalid/')`],
  ['app.emit', `app.emit('sweep-ping', 1)`],
  ['app.send', `app.send('sweep-ping', 1)`],
  ['world.chat', `world.chat('hello', true)`],
  ['kept material: color', `kept.material.color = 'red'`],
  ['kept video material: textureX', `kept.videoMaterial.textureX = 0.5`, 'client'],
]

// a callback reached while unmounting reads a node's matrixWorld (Stage reads a moved linked instance's values):
// a script can make its `elements` an accessor
const HOOK = `
    const hook = (matrix, action) => {
      const elements = matrix.elements
      let once = false
      Object.defineProperty(matrix, 'elements', {
        get() {
          if (!once) {
            once = true
            action()
          }
          return elements
        },
        configurable: true,
      })
    }`

// Where script code runs during teardown (or eviction), as the code that makes attemptAll(label) run there.
const POINTS = {
  'destroy event': `app.on('destroy', () => attemptAll('destroy'))`,
  'control onRelease': ``, // the kept control's onRelease (see scriptFor)
  'effect onEnd': `kept.player.applyEffect({ freeze: true, duration: 60, onEnd: () => attemptAll('onEnd') })`,
  // unmounting the first of two linked meshes moves the last one into the freed slot and reads its matrix
  'unmount, root stage (matrixWorld)': `hook(kept.last.matrixWorld, () => attemptAll('unmount (root)'))`,
  'unmount, world-nodes stage (matrixWorld)': `
    world.add(kept.first)
    world.add(kept.last)
    hook(kept.last.matrixWorld, () => attemptAll('unmount (world)'))`,
  'world listener reached from an unmount (app.emit)': `
    world.on('sweep-relay', () => attemptAll('relayed listener'))
    hook(kept.last.matrixWorld, () => app.emit('sweep-relay', 1))`,
  // eviction: the lookup in the leave listener evicts and cleans the kept handle
  'leave listener after eviction': `
    world.on('leave', ({ playerId }) => {
      if (playerId !== 'p1') return
      world.getPlayer(playerId)
      attemptAll('leave')
    })`,
}

const PLAYER_KINDS = [
  ['getPlayer', STOPPED],
  ['getPlayers', STOPPED],
  ['fresh handle: applyEffect', STOPPED],
  ['fresh handle: setVoiceLevel', STOPPED],
  ['kept handle: applyEffect', STOPPED],
  ['kept handle: setVoiceLevel', STOPPED],
]
const NODE_KINDS = [
  ['world.add', STOPPED],
  ['world.add (video)', STOPPED],
  ['world.attach', STOPPED],
  ['app.add', STOPPED],
  ['kept node: add', STOPPED],
  ['kept node: active false -> true', STOPPED],
  ['kept mesh: rebuild (linked, clean)', STOPPED],
  ['kept audio: play', STOPPED],
  ['kept skinned mesh: play', STOPPED],
]
// what each callback point must refuse, and with which error (what it may still do there is released by a later
// stage: the footprint shows it)
const REFUSED = {
  'destroy event': [['app.control', STOPPED]],
  'control onRelease': [['app.control', STOPPED]],
  'effect onEnd': [['app.control', STOPPED], ...PLAYER_KINDS],
  'unmount, root stage (matrixWorld)': [['app.control', STOPPED], ...PLAYER_KINDS, ...NODE_KINDS],
  'unmount, world-nodes stage (matrixWorld)': [['app.control', STOPPED], ...PLAYER_KINDS, ...NODE_KINDS],
  'world listener reached from an unmount (app.emit)': [['app.control', STOPPED], ...PLAYER_KINDS, ...NODE_KINDS],
  // there is no handle for a player that is leaving, and the evicted handle starts nothing; the list of players is
  // still there
  'leave listener after eviction': [
    ['getPlayer', 'no handle'],
    ['kept handle: applyEffect', LEFT],
    ['kept handle: setVoiceLevel', LEFT],
  ],
}
// what must work at a callback point
const ALLOWED = {
  'destroy event': ['getPlayer', 'getPlayers'],
  'control onRelease': ['getPlayer'],
  'leave listener after eviction': ['getPlayers'],
}
// after teardown, a kept handle refuses with the stopped error, except these, which answer and change nothing (the
// footprint shows it): a released control, and a fetch of an ended run (it stays pending and starts nothing)
const NO_OPS = ['kept control: hideReticle', 'kept control: pointer.lock', 'kept control: setActions', 'fetch']

const attemptsFor = isServer => ATTEMPTS.filter(([, , env]) => !env || env === (isServer ? 'server' : 'client'))

function scriptFor(point, isServer) {
  const attempts = attemptsFor(isServer)
    .map(([name, code]) => `[${JSON.stringify(name)}, () => { ${code} }]`)
    .join(',\n')
  return `
    const log = (app.state.log = [])
    const fired = (app.state.fired = [])
    const urls = (app.state.urls = [])
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
    ${HOOK}
    const kept = {}
    kept.player = world.getPlayer('p1')
    ${isServer ? `kept.player.setVoiceLevel('spatial')` : ''}
    kept.control = app.control(${point === 'control onRelease' ? `{ onRelease: () => attemptAll('onRelease') }` : ''})
    kept.holder = app.create('group')
    world.add(kept.holder)
    kept.hidden = app.create('group', { active: false })
    kept.holder.add(kept.hidden)
    kept.attachable = app.create('group')
    app.create('group').add(kept.attachable)
    kept.first = app.get('first')
    kept.last = app.get('last')
    kept.skinned = app.get('skinned')
    kept.material = kept.first.material
    const video = app.create('video', { width: 1, height: 1 })
    world.add(video)
    kept.videoMaterial = video.material
    kept.audio = app.create('audio', { src: 'asset://tone.mp3', loop: true, spatial: false })
    app.add(kept.audio)
    fetch('https://example.invalid/blob').then(response => response.blob()).then(blob => (kept.blob = blob))
    ${POINTS[point] ?? ''}
    app.state.attemptAll = attemptAll
  `
}

// an audio context stand-in that counts the sources that started and were not stopped
function audioSystem() {
  const audio = { started: new Set() }
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } })
  audio.ctx = {
    currentTime: 0,
    createGain: node,
    createPanner: node,
    createBufferSource() {
      const source = {
        ...node(),
        start: () => audio.started.add(source),
        stop: () => audio.started.delete(source),
      }
      return source
    },
  }
  audio.groupGains = { music: node(), sfx: node() }
  audio.ready = fn => fn()
  audio.lastDelta = 0
  return audio
}

// a world (client or server) with one player 'p1' and an app whose model holds two linked meshes 'first' and 'last'
// and a skinned mesh 'skinned'
function makeWorld({ isServer, models } = {}) {
  const compiled = new Map()
  const lock = { request: 0 }
  const geometry = new m.THREE.BoxGeometry(1, 1, 1)
  const material = new m.THREE.MeshStandardMaterial({ color: 'white' })
  // (a rebuild into an empty script also loads an empty model: only its root is exempt from the footprint)
  const model =
    models ||
    (url => {
      const root = m.createNode('group')
      if (String(url).startsWith('empty')) return root
      for (const id of ['first', 'last']) {
        root.add(m.createNode('mesh', { id, type: 'geometry', geometry, material, linked: true }))
      }
      root.add(m.createNode('skinnedmesh', { id: 'skinned', object3d: new m.THREE.Group(), animations: [] }))
      return root
    })
  const world = Object.assign(new EventEmitter(), {
    network: { isServer, isClient: !isServer, id: 'me', send: () => true, asScript: fn => fn() },
    entities: { items: new Map(), remove: id => world.entities.items.delete(id) },
    events: new EventEmitter(),
    hot: new Set(),
    setHot: (item, hot) => (hot ? world.hot.add(item) : world.hot.delete(item)),
    scripts: {},
    chat: { add() {} },
    audio: audioSystem(),
    loader: {
      get: (type, url) => {
        if (type === 'audio') return { duration: 1 }
        if (type !== 'script') return { toNodes: () => model(url) }
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
  const sceneBaseline = world.stage.scene.children.filter(object => !object.isMesh).length
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
  world.entities.players = new Map([['p1', player]])
  world.apps = new m.Apps(world)
  world.blueprints = new m.Blueprints(world)
  world.controls = new m.ClientControls(world)
  world.controls.viewport = { requestPointerLock: async () => lock.request++ }
  globalThis.document = { exitPointerLock() {} }
  if (isServer) world.livekit = new m.ServerLiveKit(world)
  return { world, player, lock, sceneBaseline }
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

// What a run can leave behind. `replacement` is the root of the run that replaced it (a rebuild): only that root's
// tree is exempt, once it is shown to belong to the app's current run. After a removal nothing is exempt.
function footprint({ world, lock, sceneBaseline }, app, { replacement, oldRun, urls }) {
  const exempt = []
  if (replacement) {
    assert.ok(app.root === replacement && app.deadHook !== oldRun, 'the app runs a new run')
    assert.equal(replacement.ctx?.run, app.deadHook, "the exempt root is the new run's")
    replacement.traverse(node => node.mounted && exempt.push(node))
  }
  const exemptMeshes = exempt.filter(node => node.name === 'mesh').length
  const ofApp = item =>
    item === app || item?.ctx?.entity === app || item?.hotOwner?.ctx?.entity === app || item?._created?.entity === app
  return {
    // every node mounted for the app is charged to it
    strayNodes: app.liveNodes - exempt.length,
    mountedUnderOldRoots: 0,
    worldNodes: app.worldNodes.size,
    sceneMeshes: world.stage.scene.children.filter(object => object.isMesh && !object.isInstancedMesh).length,
    // (a skinned mesh adds its object to the scene)
    sceneObjects:
      world.stage.scene.children.filter(object => !object.isMesh).length -
      sceneBaseline -
      exempt.filter(node => node.name === 'skinnedmesh').length,
    linkedInstances: [...world.stage.models.values()].reduce((n, model) => n + model.items.length, 0) - exemptMeshes,
    octreeItems: octreeItems(world.stage.octree.root) - exemptMeshes,
    controls: world.controls.controls.filter(control => control.options.object === app).length,
    reticleSuppressors: world.ui.suppressors,
    hudActions: world.controls.actions.length,
    pointerOwner: world.controls.pointerOwner ? 'held' : null,
    activeEffect: world.entities.getPlayer('p1').effects.at(-1) ?? null,
    voiceModifiers: world.livekit.modifiers?.p1?.size ?? 0,
    worldListeners:
      ['enter', 'leave', 'sweep-ping', 'sweep-relay'].reduce((n, name) => n + world.events.listenerCount(name), 0) +
      app.worldListeners.size,
    appListeners: Object.values(app.listeners).reduce((n, set) => n + set.size, 0),
    timers: app.timers.size,
    hot: [...world.hot].filter(ofApp).length,
    pendingRequests: requests.filter(request => !request.settled && !request.signal.aborted).length,
    playingSounds: world.audio.started.size,
    liveObjectURLs: (urls || []).filter(url => resolveObjectURL(url)).length,
    pointerLockRequests: lock.request,
  }
}

const CLEAN = {
  strayNodes: 0,
  mountedUnderOldRoots: 0,
  worldNodes: 0,
  sceneMeshes: 0,
  sceneObjects: 0,
  linkedInstances: 0,
  octreeItems: 0,
  controls: 0,
  reticleSuppressors: 0,
  hudActions: 0,
  pointerOwner: null,
  activeEffect: null,
  voiceModifiers: 0,
  worldListeners: 0,
  appListeners: 0,
  timers: 0,
  hot: 0,
  pendingRequests: 0,
  playingSounds: 0,
  liveObjectURLs: 0,
}

// tear the app's run down: remove it, or rebuild it into an empty script (and model: nothing to exempt but its root)
async function end(world, app, ending) {
  const oldRoot = app.root
  const oldRun = app.deadHook
  if (ending === 'removed') {
    app.destroy()
    await tick(20)
    return { replacement: null, oldRoot, oldRun }
  }
  world.scripts['empty.js'] = ''
  world.blueprints.modify({ id: app.data.blueprint, version: 1, script: 'empty.js', model: 'empty.glb' })
  await tick(20)
  return { replacement: app.root, oldRoot, oldRun }
}

function withoutLockRequests(state) {
  const rest = { ...state }
  delete rest.pointerLockRequests
  return rest
}

function mountedUnder(root) {
  const mounted = []
  root?.traverse(node => node.mounted && mounted.push(node))
  return mounted.length
}

const emptyModel = url => (String(url).startsWith('empty') ? m.createNode('group') : null)

for (const point of Object.keys(POINTS)) {
  for (const ending of ['removed', 'rebuilt into an empty script']) {
    for (const isServer of [false, true]) {
      test(`teardown sweep: ${point}; ${ending}; ${isServer ? 'server' : 'client'}`, async () => {
        requests.length = 0
        const env = makeWorld({ isServer })
        const { world, player } = env
        const app = addApp(world, scriptFor(point, isServer))
        await tick()
        assert.equal(app.crashed, false, 'the script ran')
        const { log, fired, urls, attemptAll } = app.data.state
        assert.ok(app.data.state.urls, 'the script kept its state')
        if (point === 'leave listener after eviction') {
          // the disconnect order: the player's modifiers are cleared, it is destroyed, then leave is emitted (while
          // the player is still listed)
          world.livekit.clearModifiers?.('p1')
          player.destroyed = true
          world.events.emit('leave', { playerId: 'p1' })
        }
        const { replacement, oldRoot, oldRun } = await end(world, app, ending)
        assert.ok(log.length > 0, `script code ran at the callback point (${point})`)
        const label = log[0].split(' | ')[0]
        const outcome = name => log.find(entry => entry.startsWith(`${label} | ${name} | `))?.split(' | ')[2]
        // refused with the documented error
        for (const [name, message] of REFUSED[point]) {
          if (!attemptsFor(isServer).some(([attempt]) => attempt === name)) continue
          assert.equal(outcome(name), message, `${name} at ${point}\n${log.join('\n')}`)
        }
        for (const name of ALLOWED[point] || []) assert.equal(outcome(name), 'ok', `${name} at ${point}`)
        // nothing of the run remains
        const state = withoutLockRequests(footprint(env, app, { replacement, oldRun, urls }))
        state.mountedUnderOldRoots = replacement ? mountedUnder(oldRoot) : mountedUnder(app.root)
        assert.deepEqual(state, CLEAN, `nothing of the run remains\n${log.join('\n')}`)
        // the handles the run kept change nothing any more
        const colors = [...world.stage.linkedMaterials.values()].map(entry => entry.raw.color.getHex())
        const { pointerLockRequests } = footprint(env, app, { replacement, oldRun })
        const tried = log.length
        attemptAll('after teardown')
        await tick(20)
        const after = log.slice(tried)
        assert.equal(after.length, attemptsFor(isServer).length, 'every attempt was made again')
        for (const line of after) {
          const [, name, result] = line.split(' | ')
          if (NO_OPS.includes(name)) continue
          assert.equal(result, STOPPED, `a kept handle refuses after teardown: ${line}`)
        }
        const stateAfter = footprint(env, app, { replacement, oldRun, urls })
        assert.equal(stateAfter.pointerLockRequests, pointerLockRequests, 'no lock requested through a kept control')
        const cleanAfter = withoutLockRequests(stateAfter)
        cleanAfter.mountedUnderOldRoots = replacement ? mountedUnder(oldRoot) : mountedUnder(app.root)
        assert.deepEqual(cleanAfter, CLEAN, 'kept handles changed nothing')
        assert.deepEqual(
          [...world.stage.linkedMaterials.values()].map(entry => entry.raw.color.getHex()),
          colors,
          'a kept material changes nothing'
        )
        assert.deepEqual([...fired], [], 'no timer or listener of the run fired')
      })
    }
  }
}

// Every node type in the registry: a handle a run kept, mounted or only created, refuses every method and setter once
// the run is over (getters keep reading), and calling them leaves nothing behind.
const MOUNTABLE = ['group', 'mesh', 'video', 'audio', 'image', 'skinnedmesh']
for (const ending of ['removed', 'rebuilt into an empty script']) {
  test(`teardown sweep: kept node handles of every node type; ${ending}`, async () => {
    requests.length = 0
    const types = Object.keys(m.Nodes)
    const env = makeWorld({
      isServer: false,
      models: url => emptyModel(url) || m.createNode('group'),
    })
    const { world } = env
    const app = addApp(
      world,
      `
      const kept = (app.state.kept = {})
      for (const type of ${JSON.stringify(types)}) kept[type] = app.create(type)
      for (const type of ${JSON.stringify(MOUNTABLE)}) {
        const node = app.create(type, type === 'video' ? { width: 1, height: 1 } : undefined)
        kept['mounted ' + type] = node
        if (type !== 'skinnedmesh') app.add(node)
      }
    `
    )
    await tick()
    assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
    const kept = app.data.state.kept
    const { replacement, oldRoot, oldRun } = await end(world, app, ending)
    const unexpected = []
    let calls = 0
    for (const [label, proxy] of Object.entries(kept)) {
      for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(proxy))) {
        const attempts = []
        if (typeof desc.value === 'function') attempts.push(() => proxy[key]())
        if (desc.set) attempts.push(() => (proxy[key] = undefined))
        for (const attempt of attempts) {
          calls++
          try {
            attempt()
            unexpected.push(`${label}.${key}: ok`)
          } catch (err) {
            if (err?.message !== STOPPED) unexpected.push(`${label}.${key}: ${err?.message}`)
          }
        }
      }
    }
    await tick(20)
    assert.ok(calls > 100, `every method and setter was tried (${calls})`)
    assert.deepEqual(unexpected, [], 'every method and setter of a kept node handle refuses')
    const state = withoutLockRequests(footprint(env, app, { replacement, oldRun }))
    state.mountedUnderOldRoots = replacement ? mountedUnder(oldRoot) : mountedUnder(app.root)
    assert.deepEqual(state, CLEAN, 'calling them left nothing behind')
    for (const type of types) assert.ok(kept[type] && typeof kept[type] === 'object', `${type} was created`)
  })
}

// clean() from inside a mesh's own unmount, in a live run (no teardown stage is involved): the mount gate refuses
// the rebuild, so nothing of the mesh stays in the scene
test('teardown sweep: a rebuild asked for from inside a node’s own unmount does not happen (live run)', async () => {
  requests.length = 0
  const env = makeWorld({ isServer: false })
  const { world } = env
  const app = addApp(
    world,
    `
    ${HOOK}
    const first = app.get('first')
    const last = app.get('last')
    hook(last.matrixWorld, () => {
      first.linked = false
      first.clean()
    })
    app.state.unmountFirst = () => (first.active = false)
  `
  )
  await tick()
  const first = app.root.get('first')
  app.data.state.unmountFirst()
  assert.equal(first.mounted, false)
  assert.equal(first.handle, null, 'the mesh was not rebuilt')
  assert.equal(world.stage.scene.children.filter(object => object.isMesh && !object.isInstancedMesh).length, 0)
  assert.equal(octreeItems(world.stage.octree.root), 1, "only the last mesh's entry")
  app.destroy()
})

// Two apps share a linked Model. Removing A's instance moves B's last one into A's slot; reading its matrix runs B's
// script, which unmounts that last one (another swap). The surviving instance's slot must hold its own matrix.
test("teardown sweep: a nested removal during a linked instance's move leaves every slot with its node's matrix", async () => {
  requests.length = 0
  const geometry = new m.THREE.BoxGeometry(1, 1, 1)
  const material = new m.THREE.MeshStandardMaterial({ color: 'white' })
  const env = makeWorld({
    isServer: false,
    models: url => {
      const root = m.createNode('group')
      const ids = String(url).startsWith('b') ? ['first', 'last'] : ['only']
      for (const id of ids) root.add(m.createNode('mesh', { id, type: 'geometry', geometry, material, linked: true }))
      return root
    },
  })
  const { world } = env
  const a = addApp(world, ``, 'a')
  await tick()
  const b = addApp(
    world,
    `
    ${HOOK}
    const first = app.get('first')
    const last = app.get('last')
    first.position.x = 10
    last.position.x = 20
    first.clean()
    last.clean()
    hook(last.matrixWorld, () => (last.active = false))
  `,
    'b'
  )
  await tick()
  const model = [...world.stage.models.values()][0]
  assert.equal(model.items.length, 3)
  a.destroy()
  const first = b.root.get('first')
  assert.equal(b.root.get('last').mounted, false, "B's callback ran (it unmounted its last mesh)")
  assert.equal(model.items.length, 1)
  const item = model.items.find(entry => entry.node === first)
  const x = model.iMesh.instanceMatrix.array[item.idx * 16 + 12]
  assert.equal(first.matrixWorld.elements[12], 10)
  assert.equal(x, 10, "the surviving instance's slot holds its own matrix")
  b.destroy()
})

// A host listener that rebuilds the app synchronously from an event its script emits from destroy: the rebuild waits
// for the teardown, which finishes on the run it captured; nothing of either run is orphaned.
for (const waitBetween of [false, true]) {
  test(`teardown sweep: a build asked for during the app's teardown waits for it (${waitBetween ? 'awaited' : 'removed at once'})`, async () => {
    requests.length = 0
    const env = makeWorld({ isServer: true, models: () => m.createNode('group') })
    const { world } = env
    const app = addApp(
      world,
      `
      const c = app.control()
      c.hideReticle()
      world.getPlayer('p1').setVoiceLevel('global')
      app.on('destroy', () => app.emit('reenter', 1))
    `
    )
    await tick()
    let once = false
    world.events.on('reenter', () => {
      if (once) return
      once = true
      app.build()
    })
    assert.equal(world.ui.suppressors, 1)
    app.unbuild()
    assert.equal(world.ui.suppressors, 0, 'the teardown released the run it captured')
    if (waitBetween) {
      await tick()
      assert.equal(world.ui.suppressors, 1, 'the deferred build ran afterwards')
    }
    app.destroy()
    await tick(20)
    world.events.removeAllListeners('reenter')
    const state = withoutLockRequests(footprint(env, app, { replacement: null, oldRun: null }))
    state.mountedUnderOldRoots = mountedUnder(app.root)
    assert.deepEqual(state, CLEAN)
  })
}

// In a live run: a sound or a skinned mesh that is not mounted starts nothing, and a sound whose load or audio unlock
// completes after it was unmounted does not start either
test('teardown sweep: an unmounted sound or skinned mesh starts nothing, and a late audio unlock is re-checked', async () => {
  requests.length = 0
  const env = makeWorld({ isServer: false })
  const { world } = env
  const pending = []
  world.audio.ready = fn => pending.push(fn)
  const app = addApp(
    world,
    `
    const sound = app.create('audio', { src: 'asset://tone.mp3', loop: true, spatial: false })
    app.add(sound)
    const skinned = app.get('skinned')
    app.state.playThenUnmount = () => {
      sound.play()
      app.remove(sound)
    }
    app.state.unmountedPlays = () => {
      sound.play()
      app.remove(skinned)
      skinned.play({ name: 'absent' })
    }
  `
  )
  await tick()
  app.data.state.playThenUnmount()
  await tick()
  for (const fn of pending.splice(0)) fn()
  assert.equal(world.audio.started.size, 0, 'the unlock came after the sound was unmounted')
  app.data.state.unmountedPlays()
  await tick()
  for (const fn of pending.splice(0)) fn()
  assert.equal(world.audio.started.size, 0, 'an unmounted sound does not play')
  assert.equal([...world.hot].filter(item => item.name === 'skinnedmesh').length, 0, 'nor does a skinned mesh animate')
  app.destroy()
})

// The other transitions a host listener can ask for from an event the script emits from destroy: an unbuild does
// nothing (the outer teardown finishes the run, its destroy event runs once), a destroy runs once the teardown is over
test('teardown sweep: an unbuild or destroy asked for during the app teardown does not re-enter it', async () => {
  requests.length = 0
  const env = makeWorld({ isServer: true, models: () => m.createNode('group') })
  const { world } = env
  const app = addApp(
    world,
    `
    const destroys = (app.state.destroys = [])
    const c = app.control()
    c.hideReticle()
    world.getPlayer('p1').setVoiceLevel('global')
    app.on('destroy', () => {
      destroys.push('destroy')
      app.emit('reenter', 1)
    })
  `
  )
  await tick()
  const destroys = app.data.state.destroys
  const asks = []
  world.events.on('reenter', () => {
    asks.push('reenter')
    app.unbuild()
    app.destroy()
  })
  world.scripts['empty.js'] = ''
  world.blueprints.modify({ id: app.data.blueprint, version: 1, script: 'empty.js' })
  await tick(20)
  world.events.removeAllListeners('reenter')
  assert.deepEqual([...destroys], ['destroy'], 'the destroy event ran once')
  assert.deepEqual(asks, ['reenter'])
  assert.equal(app.destroyed, true, 'the destroy asked for ran after the teardown')
  const state = withoutLockRequests(footprint(env, app, { replacement: null, oldRun: null }))
  state.mountedUnderOldRoots = mountedUnder(app.root)
  assert.deepEqual(state, CLEAN)
})

// A matrix read that throws while a linked instance is taken out (the moved instance's `elements` accessor): the
// Model's list, its octree entries and the scene still lose everything of the removed app
test('teardown sweep: a matrix read that throws while instances are taken out leaves nothing behind', async () => {
  requests.length = 0
  const env = makeWorld({ isServer: false })
  const { world } = env
  const app = addApp(
    world,
    `
    const elements = app.get('last').matrixWorld.elements
    let once = false
    Object.defineProperty(app.get('last').matrixWorld, 'elements', {
      get() {
        if (!once) {
          once = true
          throw new Error('matrix boom')
        }
        return elements
      },
      configurable: true,
    })
  `
  )
  await tick()
  assert.equal(octreeItems(world.stage.octree.root), 2)
  app.destroy()
  await tick()
  const state = withoutLockRequests(footprint(env, app, { replacement: null, oldRun: null }))
  state.mountedUnderOldRoots = mountedUnder(app.root)
  assert.deepEqual(state, CLEAN)
})
