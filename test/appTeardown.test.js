import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { bundleProbe } from './lib/workerProbe.mjs'

// The real App, Apps, Blueprints, ClientControls and nodes (bundled like the server build), with the real node
// mounting, player proxies and controls; only the loader, network and players are stand-ins.
let m
let bundle
// the host fetch: a request that only ends when it is aborted (no network)
const realFetch = globalThis.fetch
const aborted = []
before(async () => {
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted.push(init.signal)
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
  bundle = await bundleProbe(`
    export { App } from './src/core/entities/App'
    export { Apps } from './src/core/systems/Apps'
    export { Blueprints } from './src/core/systems/Blueprints'
    export { ClientControls } from './src/core/systems/ClientControls'
    export { createNode } from './src/core/extras/createNode'
  `)
  m = await import(bundle.url)
})
after(() => {
  globalThis.fetch = realFetch
  bundle?.destroy()
})

// the host nodes an app has mounted now: its tree and its world-space nodes
function mountedNodes(app) {
  const nodes = []
  app.root.traverse(node => nodes.push(node))
  for (const node of app.worldNodes) node.traverse(child => nodes.push(child))
  return nodes.filter(node => node.mounted)
}

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

function quietly() {
  const original = { error: console.error, warn: console.warn }
  const lines = []
  console.error = (...args) => lines.push(args.map(String).join(' '))
  console.warn = (...args) => lines.push(args.map(String).join(' '))
  return { lines, restore: () => Object.assign(console, original) }
}

// a world with one app running `script`, a remote player 'p1' and a client control system
function makeWorld(script, { isServer = false } = {}) {
  const world = Object.assign(new EventEmitter(), {
    network: { isServer, isClient: !isServer, id: 'me', send: () => true, asScript: fn => fn() },
    entities: { items: new Map(), remove: id => world.entities.items.delete(id) },
    events: new EventEmitter(),
    stage: { dirtyNodes: new Set() },
    hot: new Set(),
    setHot: (item, hot) => (hot ? world.hot.add(item) : world.hot.delete(item)),
    loader: {
      get: type =>
        type === 'script' ? { exec: (...args) => script(...args) } : { toNodes: () => m.createNode('group') },
    },
    ui: {
      suppressors: 0,
      suppressReticle: () => {
        world.ui.suppressors++
        return () => world.ui.suppressors--
      },
    },
  })
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
  world.blueprints.add({ id: 'bp', version: 0, name: 'App', model: 'm.glb', script: 's.js', props: {} })
  const app = new m.App(world, {
    id: 'a',
    blueprint: 'bp',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    state: {},
  })
  world.entities.items.set('a', app)
  return { world, app, player }
}

// a script that leaves as much behind as it can, and tries to break the teardown on the way out
function greedy(record) {
  return (world, app, fetch, _props, setTimeout) => {
    const local = app.create('group')
    local.add(app.create('group'))
    app.add(local)
    const outside = app.create('group')
    world.add(outside)
    const player = world.getPlayer('p1')
    // a replaced cleanup hook (it used to stop the teardown) and an effect callback that throws when it ends
    player.$cleanup = () => {
      throw new Error('skip teardown')
    }
    player.applyEffect({
      freeze: true,
      duration: 60,
      onEnd: () => {
        throw new Error('onEnd boom')
      },
    })
    setTimeout(() => record.fired++, 30)
    world.on('enter', () => record.entered++)
    app.on('update', () => {})
    const control = app.control()
    control.hideReticle()
    control.setActions([{ type: 'keyE', label: 'Use' }])
    record.request = fetch('https://example.invalid/slow').then(
      () => (record.settled = 'resolved'),
      () => (record.settled = 'rejected')
    )
    app.on('destroy', () => {
      throw new Error('destroy listener boom')
    })
    Object.assign(record, { world, app, player, control, local, outside })
  }
}

test('teardown: a removed app is torn down completely whatever its script breaks on the way', async () => {
  const record = { fired: 0, entered: 0 }
  const { world, app } = makeWorld(greedy(record))
  await tick()
  assert.equal(app.liveNodes, 4, 'root, two local nodes and one world-space node')
  const mounted = mountedNodes(app)
  assert.equal(mounted.length, 4)
  assert.equal(world.ui.suppressors, 1)
  assert.equal(world.controls.actions.length, 1)
  const abortsBefore = aborted.length
  const logs = quietly()
  try {
    app.destroy()
  } finally {
    logs.restore()
  }
  assert.equal(app.liveNodes, 0, 'the node budget is back to zero')
  assert.ok(
    mounted.every(node => !node.mounted),
    'every node is unmounted'
  )
  assert.equal(aborted.length, abortsBefore + 1, 'the open request is aborted')
  assert.equal(world.events.listenerCount('enter'), 0, 'world listeners are gone')
  assert.equal(world.hot.has(app), false)
  assert.equal(app.timers.size, 0, 'timers are cleared')
  assert.equal(world.ui.suppressors, 0, 'the reticle comes back')
  assert.deepEqual(world.controls.actions, [], 'the HUD hints leave with the control')
  world.events.emit('enter', {})
  await tick(50)
  assert.equal(record.fired, 0)
  assert.equal(record.entered, 0)
  assert.equal(record.settled, undefined, 'the aborted request never reaches the script')
  assert.ok(
    logs.lines.some(line => /onEnd boom/.test(line)),
    'the throwing effect callback is reported'
  )
})

test('teardown: a rebuild ends the old run; its handles stop working, the new run starts clean', async () => {
  const records = []
  const { world, app, player } = makeWorld((...args) => {
    const record = { fired: 0, entered: 0 }
    records.push(record)
    greedy(record)(...args)
  })
  await tick()
  const logs = quietly()
  try {
    world.blueprints.modify({ id: 'bp', version: 1 })
    await tick()
  } finally {
    logs.restore()
  }
  assert.equal(records.length, 2)
  const [old, current] = records
  assert.equal(app.liveNodes, 4, "only the new run's nodes")
  assert.equal(world.ui.suppressors, 1, "only the new run's suppressor")
  // the old run's world, app, player and control handles
  assert.throws(() => old.world.add(old.app.create('group')), /this app has stopped/)
  assert.throws(() => old.app.position, /this app has stopped/)
  assert.throws(() => old.player.damage(10), /this app has stopped/)
  assert.equal(player.data.health, 100)
  old.control.hideReticle(false)
  old.control.hideReticle(true)
  old.control.setActions([{ type: 'keyX', label: 'stale' }])
  assert.equal(world.ui.suppressors, 1, 'a released control creates no suppressor')
  assert.deepEqual(
    world.controls.actions.map(action => action.label),
    ['Use']
  )
  // an old world-space node cannot be mounted into the new run
  const before = app.liveNodes
  old.outside.active = false
  old.outside.active = true
  assert.equal(app.liveNodes, before)
  // the new run works
  current.player.damage(10)
  assert.equal(player.data.health, 90)
})

test('teardown: a stage that throws (here a node whose unmount fails) does not skip the later stages', async () => {
  const record = { fired: 0, entered: 0 }
  const { world, app } = makeWorld(greedy(record))
  await tick()
  // a node of the app's tree whose unmount throws, as a node in a broken state can
  const failing = mountedNodes(app).find(node => node !== app.root && node.parent === app.root)
  failing.unmount = () => {
    throw new Error('unmount boom')
  }
  const logs = quietly()
  try {
    app.destroy()
  } finally {
    logs.restore()
  }
  assert.equal(app.liveNodes, 0)
  assert.equal(world.events.listenerCount('enter'), 0)
  assert.equal(app.timers.size, 0)
  assert.equal(world.ui.suppressors, 0)
  assert.equal(app.worldNodes.size, 0)
  assert.ok(logs.lines.some(line => /teardown \(root\) failed: unmount boom/.test(line)))
  await tick(50)
  assert.equal(record.fired, 0)
  assert.throws(() => record.world.add(record.app.create('group')), /this app has stopped/)
})

test("teardown: the run's own destroy handler can still clean up and act, synchronously", async () => {
  const seen = []
  const { world, app, player } = makeWorld((world, app) => {
    const control = app.control()
    const p = world.getPlayer('p1')
    app.on('destroy', () => {
      p.damage(5)
      control.setActions(null)
      seen.push(world.isServer === false)
      Promise.resolve().then(() => {
        try {
          p.damage(10)
          seen.push('late damage ran')
        } catch (err) {
          seen.push(err.message)
        }
        try {
          control.hideReticle()
          seen.push('hideReticle returned')
        } catch (err) {
          seen.push(err.message)
        }
      })
    })
  })
  await tick()
  app.destroy()
  await tick()
  assert.equal(player.data.health, 95, 'the synchronous destroy handler acted')
  // the released control answers without creating a suppressor
  assert.deepEqual(seen, [true, '[app] this app has stopped', 'hideReticle returned'])
  assert.equal(world.ui.suppressors, 0)
})
