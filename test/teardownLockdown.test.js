import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// the real lockdown config (ses must be imported first, as in src/server/index.js)
import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'

// App teardown against scripts running in real compartments: the real App, Apps, Blueprints, ClientControls, Stage
// and nodes, with the browser's pointer lock, the loader, the network and the players as stand-ins. A script reaches
// the host only through what it is handed; it passes values back through `app.state` (the app's data.state).
let bundle
let m
let scripts

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
    export { Object3D } from 'three'
  `)
  m = await import(bundle.url)
  scripts = new m.Scripts({})
})
after(() => bundle?.destroy())

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
const STOPPED = '[app] this app has stopped'

// a world whose apps run the code in `world.scripts[url]` in compartments; a remote player 'p1'
function makeWorld({ isServer = false } = {}) {
  const compiled = new Map()
  const world = Object.assign(new EventEmitter(), {
    network: {
      isServer,
      isClient: !isServer,
      id: 'me',
      send: () => true,
      broadcast: () => 'delivered',
      asScript: fn => fn(),
    },
    entities: { items: new Map(), remove: id => world.entities.items.delete(id) },
    events: new EventEmitter(),
    hot: new Set(),
    setHot: (item, hot) => (hot ? world.hot.add(item) : world.hot.delete(item)),
    scripts: {},
    loader: {
      get: (type, url) => {
        if (type !== 'script') return { toNodes: () => m.createNode('group') }
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
  if (isServer) world.livekit = new m.ServerLiveKit(world)
  // the browser's pointer lock, simulated: the request, then the lock-change event it fires
  const lock = { request: 0, exit: 0 }
  world.controls.viewport = { requestPointerLock: async () => lock.request++ }
  globalThis.document = { exitPointerLock: () => lock.exit++ }
  return { world, player, lock }
}

function addApp(world, id, code) {
  world.scripts[`${id}.js`] = code
  world.blueprints.add({ id: `bp-${id}`, version: 0, name: id, model: 'm.glb', script: `${id}.js`, props: {} })
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

// rebuild into a script that does nothing
function rebuildEmpty(world, app) {
  world.scripts[`${app.data.id}-empty.js`] = ''
  world.blueprints.modify({ id: app.data.blueprint, version: 1, script: `${app.data.id}-empty.js` })
}

const appControls = (world, app) => world.controls.controls.filter(control => control.options.object === app)

const originalDocument = globalThis.document
after(() => (globalThis.document = originalDocument))

test("controls: a script cannot keep its control alive past its app's teardown by changing the object it holds", async () => {
  const { world, lock } = makeWorld()
  const app = addApp(
    world,
    'a',
    `
    const c = app.control()
    app.state.pointer = c.pointer
    app.state.control = c
    c.hideReticle()
    // the review's reproduction: reading c.release now breaks the Proxy invariant
    Object.defineProperty(c, 'release', { value() {}, configurable: false, writable: false })
  `
  )
  await tick()
  assert.equal(appControls(world, app).length, 1)
  assert.equal(world.ui.suppressors, 1)
  assert.throws(() => app.data.state.control.release, TypeError, 'the proxy is broken for any reader')
  app.destroy()
  assert.equal(appControls(world, app).length, 0, 'the control is released by the host')
  assert.equal(world.ui.suppressors, 0, 'the reticle comes back')
  app.data.state.pointer.lock()
  assert.equal(lock.request, 0, 'a kept pointer locks nothing after the app is gone')
  // and were the host's release ever skipped, a control whose run ended is still inert
  const b = addApp(
    world,
    'b',
    `
    const c = app.control()
    app.state.control = c
    const presses = (app.state.presses = [])
    c.keyE.onPress = () => presses.push('pressed')
  `
  )
  await tick()
  const release = world.controls.releaseControl
  world.controls.releaseControl = () => {}
  try {
    b.destroy()
  } finally {
    world.controls.releaseControl = release
  }
  const kept = b.data.state.control
  kept.pointer.lock()
  kept.hideReticle()
  world.controls.onKeyDown({ code: 'KeyE', repeat: false, target: {}, preventDefault() {} })
  assert.equal(lock.request, 0)
  assert.equal(world.ui.suppressors, 0)
  assert.deepEqual([...b.data.state.presses], [])
})

test('controls: a control made from a teardown callback (onRelease) is refused; none outlives the app', async () => {
  const { world } = makeWorld()
  const app = addApp(
    world,
    'a',
    `
    const errors = (app.state.errors = [])
    app.control({
      onRelease() {
        try {
          const replacement = app.control()
          replacement.hideReticle()
          app.state.replacement = replacement
        } catch (err) {
          errors.push(err.message)
        }
      },
    })
  `
  )
  await tick()
  const errors = app.data.state.errors
  rebuildEmpty(world, app)
  await tick()
  app.destroy()
  assert.deepEqual(errors, [STOPPED])
  assert.equal(appControls(world, app).length, 0, 'no live control')
  assert.equal(world.ui.suppressors, 0, 'no reticle suppressor')
  assert.equal(world.controls.actions.length, 0)
})

test("controls: a releasing control's onRelease unlocks only a lock it still holds", async () => {
  const { world, lock } = makeWorld()
  const a = addApp(
    world,
    'a',
    `
    const c = app.control({ onRelease: () => c.pointer.unlock() })
    app.state.lock = () => c.pointer.lock()
    app.state.again = () => app.control()
  `
  )
  const b = addApp(
    world,
    'b',
    `
    const c = app.control()
    app.state.lock = () => c.pointer.lock()
  `
  )
  await tick()
  // another control locks after A's: releasing A's control (its app is removed) leaves that lock alone
  a.data.state.lock()
  world.controls.onPointerLockStart()
  b.data.state.lock()
  a.destroy()
  assert.equal(world.controls.pointer.locked, true)
  assert.equal(lock.exit, 0)
  b.destroy()
  assert.equal(world.controls.pointer.locked, false)
  assert.equal(lock.exit, 1)
  // app.control() again: the lock went to the new control, so the previous control's onRelease cannot unlock it
  const c = addApp(
    world,
    'c',
    `
    const first = app.control({ onRelease: () => first.pointer.unlock() })
    app.state.lock = () => first.pointer.lock()
    app.state.again = () => app.control()
  `
  )
  await tick()
  c.data.state.lock()
  world.controls.onPointerLockStart()
  c.data.state.again()
  assert.equal(world.controls.pointer.locked, true, 'the handed-over lock survives the old callback')
  assert.equal(lock.exit, 1)
  c.destroy()
  assert.equal(world.controls.pointer.locked, false)
  assert.equal(lock.exit, 2)
})

test('video.material: nothing before the video is mounted; a kept one cannot act after its app is gone', async () => {
  const { world } = makeWorld()
  const a = addApp(
    world,
    'a',
    `
    const video = app.create('video')
    // the review's reproduction: read before mounting
    app.state.early = video.material
    app.add(video)
    const material = video.material
    material.textureX = 0.25
    let redefined = 'allowed'
    try {
      Object.defineProperty(material, 'textureY', { set() {} })
    } catch (err) {
      redefined = err.name
    }
    app.state.checks = { same: material === video.material, frozen: Object.isFrozen(material), redefined }
    app.state.material = material
    app.state.video = video
    // unmounted again (in the same run): no material, as for a mesh
    const other = app.create('video')
    app.add(other)
    app.remove(other)
    app.state.unmounted = other.material
  `
  )
  const b = addApp(world, 'b', `app.state.adopt = node => world.add(node)`)
  await tick()
  assert.equal(a.data.state.early, undefined, 'no material before mounting, as for a mesh')
  assert.equal(a.data.state.unmounted, undefined, 'nor once unmounted')
  assert.deepEqual({ ...a.data.state.checks }, { same: true, frozen: true, redefined: 'TypeError' })
  const own = a.root.children.find(child => child.name === 'video')
  assert.equal(own.mesh.material.uniforms.uOffset.value.x, 0.25, 'a write of the live run acts')
  // B adopts the video (it mounts again, for B), then A is removed
  b.data.state.adopt(a.data.state.video)
  const node = [...b.worldNodes][0]
  assert.ok(node.mesh, 'mounted for B')
  a.destroy()
  assert.throws(() => (a.data.state.material.textureX = 0.75), new RegExp(STOPPED.replace(/[[\]]/g, '\\$&')))
  assert.equal(node.mesh.material.uniforms.uOffset.value.x, 0, "B's video is unchanged")
  assert.equal(a.data.state.material.textureX, 0, 'reading still answers (it follows the mounted mesh)')
  b.destroy()
})

test("player handles: an app's own cleanup callback can still end its effect and voice level while it is removed", async () => {
  const { world } = makeWorld({ isServer: true })
  const app = addApp(
    world,
    'a',
    `
    const log = (app.state.log = [])
    const p = world.getPlayer('p1')
    p.setVoiceLevel('global')
    p.applyEffect({
      freeze: true,
      duration: 60,
      onEnd: () => {
        for (const [label, end] of [
          ['voice', () => p.setVoiceLevel(null)],
          ['cancel', () => p.cancelEffect()],
          ['new effect', () => p.applyEffect({ freeze: true, duration: 600 })],
          ['damage', () => p.damage(1)],
        ]) {
          try {
            end()
            log.push(label + ' ok')
          } catch (err) {
            log.push(label + ': ' + err.message)
          }
        }
      },
    })
  `
  )
  await tick()
  assert.equal(world.livekit.modifiers.p1.size, 1)
  const log = app.data.state.log
  app.destroy()
  // ending works, and so does a one-shot effect (damage) while the teardown runs; a new effect is refused
  assert.deepEqual(log, ['voice ok', 'cancel ok', `new effect: ${STOPPED}`, 'damage ok'])
  assert.equal(world.livekit.modifiers.p1?.size ?? 0, 0)
})
