import { test, before, after } from 'node:test'
import { holdEffect } from './lib/effectPlayer.mjs'
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
    export { ServerLiveKit } from './src/core/systems/ServerLiveKit'
    export { placeWorldNode } from './src/core/extras/nodeLimits'
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

// a world with one app running `script`, remote players 'p1' and 'p2' and a client control system
function makeWorld(script, { isServer = false, livekit = false } = {}) {
  const world = Object.assign(new EventEmitter(), {
    network: {
      isServer,
      isClient: !isServer,
      id: 'me',
      send: () => true,
      broadcast: () => 'delivered',
      asScript: fn => fn(),
    },
    entities: {
      items: new Map(),
      remove: id => world.entities.items.delete(id),
      // (the join budget's record of a rebuilt app's emptied state, Entities.stateEmptied)
      stateEmptied() {},
    },
    events: new EventEmitter(),
    stage: { dirtyNodes: new Set() },
    hot: new Set(),
    setHot: (item, hot) => (hot ? world.hot.add(item) : world.hot.delete(item)),
    scripts: {},
    models: {},
    loader: {
      get: (type, url) =>
        type === 'script'
          ? { exec: (...args) => (world.scripts[url] || script)(...args) }
          : { toNodes: () => (world.models[url] ? world.models[url]() : m.createNode('group')) },
      // an app's requests go through its world's loader: here, to the stand-in above (or a test's own)
      scriptFetch: (url, init) => globalThis.fetch(url, init),
    },
    ui: {
      suppressors: 0,
      suppressReticle: () => {
        world.ui.suppressors++
        return () => world.ui.suppressors--
      },
    },
  })
  const makePlayer = id => ({
    world,
    data: { id, owner: id, health: 100 },
    effects: [],
    setEffect(effect, onEnd) {
      this.effects.push(effect)
      holdEffect.call(this, effect, onEnd)
    },
    modify(data) {
      Object.assign(this.data, data)
    },
  })
  const players = { p1: makePlayer('p1'), p2: makePlayer('p2') }
  const player = players.p1
  world.entities.getPlayer = id => (Object.hasOwn(players, id) ? players[id] : null)
  world.apps = new m.Apps(world)
  world.blueprints = new m.Blueprints(world)
  world.controls = new m.ClientControls(world)
  if (livekit) world.livekit = new m.ServerLiveKit(world)
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
  return { world, app, player, players }
}

// a second app with its own blueprint and script in the same world
function addApp(world, id, script) {
  world.scripts[`${id}.js`] = script
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
  // an old world-space node cannot be mounted into the new run: its handle belongs to the old run
  const before = app.liveNodes
  assert.throws(() => (old.outside.active = false), /this app has stopped/)
  assert.throws(() => (old.outside.active = true), /this app has stopped/)
  assert.throws(() => old.outside.add(old.local), /this app has stopped/)
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

test("teardown: the pointer lock an app's control took ends with its run (and survives app.control() again)", async () => {
  const shared = {}
  const { world, app } = makeWorld((world, app) => {
    const control = app.control()
    shared.lock = () => control.pointer.lock()
    shared.again = () => app.control()
  })
  // the browser's pointer lock, simulated: the request, then the lock-change event it fires
  const calls = { request: 0, exit: 0 }
  world.controls.viewport = { requestPointerLock: async () => calls.request++ }
  const original = globalThis.document
  globalThis.document = { exitPointerLock: () => calls.exit++ }
  try {
    await tick()
    shared.lock()
    assert.equal(calls.request, 1)
    world.controls.onPointerLockStart()
    // replacing the control keeps the lock (the new control holds it)
    shared.again()
    assert.equal(world.controls.pointer.locked, true)
    assert.equal(calls.exit, 0)
    app.destroy()
    assert.equal(world.controls.pointer.locked, false, 'the run ended, so did its lock')
    assert.equal(calls.exit, 1)
  } finally {
    globalThis.document = original
  }
})

test('player handles: a script cannot evict its handle to skip the cleanup (voice modifiers do not outlive the app)', async () => {
  const { world, app } = makeWorld(
    (world, app) => {
      const p = world.getPlayer('p1')
      p.setVoiceLevel('global')
      Object.defineProperty(p, 'destroyed', { value: true })
      const again = world.getPlayer('p1')
      again.setVoiceLevel('disabled')
      app.state.same = again === p
    },
    { isServer: true, livekit: true }
  )
  await tick()
  assert.equal(app.data.state.same, true, 'the spoofed flag does not replace the cached handle')
  assert.equal(world.livekit.modifiers.p1.size, 1)
  app.destroy()
  assert.equal(world.livekit.modifiers.p1?.size ?? 0, 0, 'every modifier the app set is removed')
})

test('player handles: a lookup from an effect callback during teardown does not reach the next run', async () => {
  const seen = []
  const { world } = makeWorld(world => {
    const p = world.getPlayer('p1')
    seen.push(p)
    p.applyEffect({
      freeze: true,
      duration: 60,
      onEnd: () => {
        try {
          world.getPlayer('p1')
          seen.push('looked up')
        } catch (err) {
          seen.push(err.message)
        }
      },
    })
  })
  await tick()
  world.blueprints.modify({ id: 'bp', version: 1 })
  await tick()
  assert.equal(seen.length, 3)
  assert.equal(seen[1], '[app] this app has stopped', 'the retiring run gets no new handle')
  assert.notEqual(seen[2], seen[0], 'the new run has its own handle')
  // and it works in the new run
  assert.doesNotThrow(() => seen[2].hasEffect())
})

test('player handles: an effect callback during teardown cannot start a new effect or voice modifier', async () => {
  const seen = []
  const { world, app, players } = makeWorld(
    world => {
      const p = world.getPlayer('p1')
      const q = world.getPlayer('p2') // drained after p: still uncleaned when p's callback runs
      p.setVoiceLevel('global')
      // the review's sequence: the effect's callback applies a new effect through the handle it kept
      p.applyEffect({
        freeze: true,
        duration: 60,
        onEnd: () => {
          for (const attempt of [
            () => p.applyEffect({ freeze: true, duration: 600 }),
            () => q.applyEffect({ freeze: true, duration: 600 }),
            () => p.setVoiceLevel('disabled'),
            () => q.setVoiceLevel('global'),
          ]) {
            try {
              attempt()
              seen.push('accepted')
            } catch (err) {
              seen.push(err.message)
            }
          }
          // ending what exists still works
          p.setVoiceLevel(null)
          q.cancelEffect()
          seen.push('ended')
        },
      })
    },
    { isServer: true, livekit: true }
  )
  await tick()
  assert.equal(world.livekit.modifiers.p1.size, 1)
  // rebuild into a script that does nothing, then remove the app
  world.scripts['s.js'] = () => {}
  world.blueprints.modify({ id: 'bp', version: 1 })
  await tick()
  app.destroy()
  const stopped = '[app] this app has stopped'
  assert.deepEqual(seen, [stopped, stopped, stopped, stopped, 'ended'])
  for (const id of ['p1', 'p2']) {
    assert.equal(players[id].effects.at(-1) ?? null, null, `no effect of the old run is left on ${id}`)
    assert.equal(world.livekit.modifiers[id]?.size ?? 0, 0, `no voice modifier is left on ${id}`)
  }
})

test('world nodes: a node another app took over is not torn down (or removed) by its former owner', async () => {
  const shared = {}
  const { world, app: a } = makeWorld((world, app) => {
    shared.node = app.create('group')
    world.add(shared.node)
    shared.removeFromA = () => world.remove(shared.node)
  })
  await tick()
  const b = addApp(world, 'b', world => {
    world.add(shared.node)
  })
  await tick()
  assert.equal(a.liveNodes, 1, 'only its root')
  assert.equal(b.liveNodes, 2)
  assert.equal(a.worldNodes.size, 0)
  shared.removeFromA()
  assert.equal(b.liveNodes, 2, "the former owner's world.remove does nothing")
  // even a stale registration (forced here) is not the former owner's to tear down
  const hostNode = [...b.worldNodes][0]
  a.worldNodes.add(hostNode)
  a.destroy()
  assert.equal(b.liveNodes, 2, "the former owner's teardown does not unmount it")
  b.destroy()
  assert.equal(b.liveNodes, 0)
})

test("app roots: another app's root cannot be moved into an app's tree or world space", async () => {
  const shared = {}
  const own = []
  const { world, app: a } = makeWorld((world, app) => {
    shared.aApp = app
    app.add(app.create('group'))
    // an app moving its own root keeps working as before
    try {
      world.add(app)
      own.push('added')
    } catch (err) {
      own.push(err.message)
    }
  })
  await tick()
  assert.deepEqual(own, ['added'])
  const aBefore = { live: a.liveNodes, world: [...a.worldNodes], mounted: mountedNodes(a).length }
  const seen = []
  const b = addApp(world, 'b', (world, app) => {
    const local = app.create('group')
    app.add(local)
    const outside = app.create('group')
    world.add(outside)
    const detached = app.create('group')
    for (const attempt of [
      () => world.add(shared.aApp),
      () => world.attach(shared.aApp),
      () => app.add(shared.aApp),
      () => local.add(shared.aApp),
      () => outside.add(shared.aApp),
      () => detached.add(shared.aApp),
    ]) {
      try {
        attempt()
        seen.push('moved')
      } catch (err) {
        seen.push(err.message)
      }
    }
  })
  await tick()
  assert.equal(seen.length, 6)
  for (const message of seen) assert.match(message, /cannot add another app's root node/)
  assert.equal(a.liveNodes, aBefore.live)
  assert.deepEqual([...a.worldNodes], aBefore.world)
  assert.equal(mountedNodes(a).length, aBefore.mounted)
  assert.equal(a.root.parent, null)
  assert.equal(a.root._nodeOwner, a)
  assert.equal(b.liveNodes, 3, 'its root, its local node and its world-space node')
  assert.equal(b.worldNodes.size, 1)
  const bWorld = [...b.worldNodes]
  a.destroy()
  assert.equal(b.liveNodes, 3, 'deleting the other app does not disturb it')
  assert.deepEqual([...b.worldNodes], bWorld)
  assert.equal(mountedNodes(b).length, 3)
  b.destroy()
  assert.equal(b.liveNodes, 0)
})

test("app roots: a former owner's teardown leaves its old root alone once another app holds it", async () => {
  const shared = {}
  const { world, app: a } = makeWorld((world, app) => {
    // its own root under its own world-space node: allowed, as before
    shared.holder = app.create('group')
    world.add(shared.holder)
    shared.holder.add(app)
  })
  await tick()
  assert.equal(a.root.parent?.ctx?.entity, a)
  const b = addApp(world, 'b', world => {
    // a world-space node of another app (an ordinary node) can be taken over, with what is under it
    world.add(shared.holder)
  })
  await tick()
  assert.equal(b.liveNodes, 3, 'its root, the holder and the root under it')
  a.destroy()
  assert.equal(b.liveNodes, 3, "the former owner's teardown does not unmount what the other app holds")
  b.destroy()
  assert.equal(b.liveNodes, 0)
})

test('world nodes: a world-space node moved under a node leaves its app world-node list', async () => {
  const shared = {}
  const { app } = makeWorld((world, app) => {
    shared.node = app.create('group')
    world.add(shared.node)
    app.add(shared.node)
  })
  await tick()
  assert.equal(app.worldNodes.size, 0)
  assert.equal(app.liveNodes, 2)
  app.destroy()
  assert.equal(app.liveNodes, 0)
})

// the review's inactive-node flood: inactive world-space nodes take a step of the world-node drain without being live,
// so a drain bounded by the live-node budget left the node placed after 20,001 of them mounted (rebuilt, then removed;
// the inactive ones are listed directly, the way world.add lists them, to keep the test small)
test('world nodes: every registered world node is drained, however many inactive ones come first', async () => {
  const { world, app } = makeWorld((world, app) => {
    app.state.place = () => world.add(app.create('group'))
  })
  await tick()
  const flood = () => {
    for (let i = 0; i < 20001; i++) m.placeWorldNode(app, m.createNode('group', { active: false }))
    app.data.state.place()
  }
  flood()
  assert.equal(app.worldNodes.size, 20002)
  assert.equal(app.liveNodes, 2, 'the root and the last world node')
  world.scripts['s.js'] = (world, app) => {
    app.state.place = () => world.add(app.create('group'))
  }
  world.blueprints.modify({ id: 'bp', version: 1 })
  await tick()
  assert.equal(app.liveNodes, 1, "after the rebuild: only the new run's root")
  assert.equal(app.worldNodes.size, 0)
  flood()
  app.destroy()
  assert.equal(app.liveNodes, 0)
  assert.equal(app.worldNodes.size, 0)
})

test('fetch and setTimeout kept from an old run act for nobody after a rebuild', async () => {
  const kept = []
  let calls = 0
  const original = globalThis.fetch
  const { world } = makeWorld((_world, _app, fetch, _props, setTimeout) => kept.push({ fetch, setTimeout }))
  await tick()
  world.blueprints.modify({ id: 'bp', version: 1 })
  await tick()
  assert.equal(kept.length, 2)
  globalThis.fetch = (...args) => {
    calls++
    return original(...args)
  }
  try {
    const old = kept[0]
    assert.throws(() => old.setTimeout(() => assert.fail('old timer ran'), 0), /this app has stopped/)
    let settled = false
    old.fetch('https://example.invalid/').then(
      () => (settled = true),
      () => (settled = true)
    )
    await tick(20)
    assert.equal(settled, false, 'stays pending, like any request of a stopped run')
    assert.equal(calls, 0, 'and never reaches the network')
    // the current run's functions work
    let fired = false
    kept[1].setTimeout(() => (fired = true), 0)
    await tick(10)
    assert.equal(fired, true)
  } finally {
    globalThis.fetch = original
  }
})

test('node budget: a model over the budget mounts nothing more and shows the crash block (real nodes)', async () => {
  for (const alreadyCrashed of [false, true]) {
    const runs = []
    const { world, app } = makeWorld(() => runs.push('ran'))
    await tick()
    // a model 300 levels deep: the real mount refuses level 256
    world.models['deep.glb'] = () => {
      const root = m.createNode('group')
      let parent = root
      for (let i = 0; i < 300; i++) {
        const child = m.createNode('group')
        parent.add(child)
        parent = child
      }
      return root
    }
    let crashBlock = null
    world.models['asset://crash-block.glb'] = () => (crashBlock = m.createNode('group'))
    const logs = quietly()
    try {
      if (alreadyCrashed) app.crashed = true
      world.blueprints.modify({ id: 'bp', version: 1, model: 'deep.glb' })
      await tick()
    } finally {
      logs.restore()
    }
    const label = `already crashed: ${alreadyCrashed}`
    assert.deepEqual(runs, ['ran'], `the over-budget build ran no script (${label})`)
    assert.equal(app.crashed, true, label)
    assert.ok(crashBlock, `the crash block was built (${label})`)
    assert.equal(app.root, crashBlock, `the crash block is shown (${label})`)
    assert.equal(app.liveNodes, 1, `only the crash block is mounted (${label})`)
    assert.equal(app.building, false, label)
    if (!alreadyCrashed) assert.match(app.scriptError.message, /more than 256 levels of nodes/)
  }
})

// A server script that ends an effect it gave a player: the clients are told (createPlayerProxy endByScript). The
// player here behaves as PlayerRemote does: an effect that ends, or is replaced, calls the callback it was set with.
function effectWorld(script, { isServer = true, localId } = {}) {
  // the script under test is a second app, added once the world's stand-ins below are in place
  const made = makeWorld(() => {}, { isServer })
  const sent = []
  const network = made.world.network
  // 'refused': this tick's room for script writes is used up (ServerNetwork.broadcast)
  network.outcome = 'delivered'
  network.broadcast = (name, data) => {
    if (network.outcome !== 'refused') sent.push([name, data])
    return network.outcome
  }
  network.send = (name, data) => network.broadcast(name, data) === 'delivered'
  for (const player of Object.values(made.players)) {
    player.setEffect = holdEffect
    // the player's client said its effect ended (ServerNetwork onEntityModified -> PlayerRemote.modify)
    player.endsByItself = function () {
      this.setEffect(null)
    }
  }
  const efs = () => sent.filter(([name, data]) => name === 'entityModified' && 'ef' in data).map(([, data]) => data)
  // on a client: which player is this client's own
  if (localId) made.world.network.id = localId
  const app = addApp(made.world, 'fx', script)
  const rebuild = () => made.world.blueprints.modify({ id: 'bp-fx', version: 1 })
  return { ...made, app, rebuild, sent, efs }
}
const FREEZE = { freeze: true }

test('effects: a server script that cancels an effect tells the clients, once, before its callback runs', async () => {
  const seen = []
  let handle
  const { players, efs } = effectWorld(world => {
    const p = world.getPlayer('p1')
    handle = p.applyEffect({
      freeze: true,
      onEnd: () => {
        seen.push('ended')
        // the next effect, given from the callback, goes out after the end of the first, not under it
        p.applyEffect({ snare: 0.5 })
      },
    })
  })
  await tick()
  assert.deepEqual(efs(), [{ id: 'p1', ef: FREEZE }])
  assert.equal(handle.active, true)
  handle.cancel()
  assert.deepEqual(seen, ['ended'])
  assert.deepEqual(efs(), [
    { id: 'p1', ef: FREEZE },
    { id: 'p1', ef: null },
    { id: 'p1', ef: { snare: 0.5 } },
  ])
  assert.deepEqual(players.p1.data.effect, { snare: 0.5 })
  assert.equal(handle.active, false)
  // an effect that is over is not ended again
  handle.cancel()
  assert.equal(efs().length, 3)
})

test('effects: cancelEffect tells the clients for the effect this script gave, and says nothing when there is none', async () => {
  let p
  const { players, efs } = effectWorld(world => {
    p = world.getPlayer('p1')
  })
  await tick()
  p.cancelEffect()
  assert.deepEqual(efs(), [], 'nothing of this script to end')
  p.applyEffect({ freeze: true })
  p.cancelEffect()
  p.cancelEffect()
  assert.deepEqual(efs(), [
    { id: 'p1', ef: FREEZE },
    { id: 'p1', ef: null },
  ])
  assert.equal(players.p1.data.effect, null)
})

test('effects: an end that comes from the player, or from the next effect, is not told a second time', async () => {
  const seen = []
  let p
  const { players, efs } = effectWorld(world => {
    p = world.getPlayer('p1')
  })
  await tick()
  // the player's client said the effect ended (its duration, or the player moved): ServerNetwork passes that
  // packet on, and an echo from here could end an effect the client has started since
  p.applyEffect({ freeze: true, onEnd: () => seen.push('first') })
  players.p1.endsByItself()
  assert.deepEqual(seen, ['first'])
  assert.deepEqual(efs(), [{ id: 'p1', ef: FREEZE }])
  // nothing left to cancel
  p.cancelEffect()
  assert.equal(efs().length, 1)
  // another effect takes the place of the current one: the new one goes out, with no end in between
  p.applyEffect({ freeze: true, onEnd: () => seen.push('second') })
  p.applyEffect({ snare: 0.5 })
  assert.deepEqual(seen, ['first', 'second'])
  assert.deepEqual(efs().slice(1), [
    { id: 'p1', ef: FREEZE },
    { id: 'p1', ef: { snare: 0.5 } },
  ])
})

test('effects: an app that is rebuilt or removed gives back the effects it holds, and the clients are told', async () => {
  for (const how of ['rebuilt', 'removed']) {
    const seen = []
    const { app, rebuild, players, efs } = effectWorld(world => {
      // no duration and not cancellable: the player's client would never end this by itself
      world.getPlayer('p1').applyEffect({ freeze: true, onEnd: () => seen.push('ended') })
      world.getPlayer('p2').applyEffect({ snare: 0.5 })
    })
    await tick()
    assert.equal(efs().length, 2)
    if (how === 'rebuilt') {
      // the new run of the script gives the effects again, after the old run's were ended
      rebuild()
      await tick()
      assert.deepEqual(efs().slice(2), [
        { id: 'p1', ef: null },
        { id: 'p2', ef: null },
        { id: 'p1', ef: FREEZE },
        { id: 'p2', ef: { snare: 0.5 } },
      ])
    } else {
      app.destroy()
      assert.deepEqual(efs().slice(2), [
        { id: 'p1', ef: null },
        { id: 'p2', ef: null },
      ])
      assert.equal(players.p1.data.effect, null)
      assert.equal(players.p2.data.effect, null)
    }
    assert.deepEqual(seen.slice(0, 1), ['ended'], how)
  }
})

test('effects: nothing is sent for a player who has left, and nothing extra from a client', async () => {
  const gone = effectWorld(world => {
    world.getPlayer('p1').applyEffect({ freeze: true })
  })
  await tick()
  gone.players.p1.destroyed = true
  gone.app.destroy()
  assert.deepEqual(gone.efs(), [{ id: 'p1', ef: FREEZE }], 'no change for an entity the clients no longer have')
  // on a client the local player says so itself (PlayerLocal.setEffect): the handle adds no message of its own
  const seen = []
  const client = effectWorld(
    world => {
      world.getPlayer('p1').applyEffect({ freeze: true, onEnd: () => seen.push('ended') })
    },
    { isServer: false, localId: 'p1' }
  )
  await tick()
  assert.deepEqual(client.players.p1.data.effect, FREEZE, 'the effect was given')
  client.app.destroy()
  assert.deepEqual(seen, ['ended'])
  assert.equal(client.players.p1.data.effect, null)
  assert.deepEqual(client.efs(), [])
})

test('effects: an end the clients could not be told of does not happen: the effect stays, and can be ended later', async () => {
  const seen = []
  let p, handle
  const { world, players, efs } = effectWorld(world => {
    p = world.getPlayer('p1')
    handle = p.applyEffect({ freeze: true, onEnd: () => seen.push('ended') })
  })
  await tick()
  // no room left for script writes in this tick
  world.network.outcome = 'refused'
  assert.equal(handle.cancel(), false)
  assert.equal(p.cancelEffect(), false)
  assert.equal(handle.active, true)
  assert.deepEqual(players.p1.data.effect, FREEZE, 'the server has what the clients have')
  assert.deepEqual(seen, [])
  assert.deepEqual(efs(), [{ id: 'p1', ef: FREEZE }])
  // a message that reached some connections and not others was sent: the effect ends. (What the call answers then
  // is the ledger's business: with the real one it is false too, for a write that did not reach everyone;
  // handle.active says whether the effect is over)
  world.network.outcome = 'partial'
  handle.cancel()
  assert.equal(handle.active, false)
  assert.equal(players.p1.data.effect, null)
  assert.deepEqual(seen, ['ended'])
  assert.deepEqual(efs().slice(1), [{ id: 'p1', ef: null }])
})

test('effects: a handle whose effect another app replaced does not end that app’s effect', async () => {
  const seen = []
  let a, handleA
  const { world, players, efs } = effectWorld(world => {
    a = world.getPlayer('p1')
    handleA = a.applyEffect({ freeze: true, onEnd: () => seen.push('a ended') })
  })
  // a second app, with its own handle of the same player
  let b
  addApp(world, 'other', world => {
    b = world.getPlayer('p1')
  })
  await tick()
  const handleB = b.applyEffect({ snare: 0.5, onEnd: () => seen.push('b ended') })
  assert.deepEqual(seen, ['a ended'], 'the first app is told its effect is over')
  assert.equal(handleA.active, false)
  assert.equal(handleB.active, true)
  const sentSoFar = efs().length
  // the first app ends "its effect": it has none, and the other app's stays, on the server and for the clients
  a.cancelEffect()
  handleA.cancel()
  assert.deepEqual(players.p1.data.effect, { snare: 0.5 })
  assert.equal(handleB.active, true)
  assert.deepEqual(seen, ['a ended'])
  assert.equal(efs().length, sentSoFar, 'nothing was told')
})

test('effects: a handle left believing in an effect the player no longer has ends nothing but itself', async () => {
  const seen = []
  let a
  const { players, efs } = effectWorld(world => {
    a = world.getPlayer('p1')
  })
  await tick()
  const handle = a.applyEffect({ freeze: true, onEnd: () => seen.push('ended') })
  // the player's effect is replaced without this handle hearing of it (what a callback wiped by the old
  // PlayerRemote.setEffect looked like): the player now holds an effect that is not this handle's
  const others = { snare: 0.5 }
  players.p1.data.effect = others
  players.p1.onEffectEnd = () => seen.push('the other effect ended')
  assert.equal(handle.active, true)
  const sentSoFar = efs().length
  handle.cancel()
  assert.equal(handle.active, false, 'the handle is done')
  assert.deepEqual(seen, ['ended'], 'and its script is told')
  assert.equal(players.p1.data.effect, others, 'the effect the player has is left alone')
  assert.equal(efs().length, sentSoFar, 'and nobody is told it ended')
})
