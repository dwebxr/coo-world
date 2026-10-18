import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { loadClient, Blueprints, ClientNetwork } from './lib/clientHarness.mjs'
import { Entity } from '../src/core/entities/Entity.js'
import { createEventQueue } from '../src/core/extras/appEventQueue.js'
import { createScriptTimers } from '../src/core/extras/scriptTimers.js'
import { briefError, createLogOnce } from '../src/core/extras/logOnce.js'

const meta = { bytes: 32, nodes: 8, socketId: 'builder', builder: true }
const root = () => ({
  position: { fromArray() {} },
  quaternion: { fromArray() {} },
  scale: { fromArray() {} },
  activate() {},
  deactivate() {},
})
const make = ({ isServer = true, onScript } = {}) => {
  const logs = []
  const seen = []
  const Apps = loadClient('core/systems/Apps.js', 'Apps')
  const App = loadClient('core/entities/App.js', 'App', {
    Entity,
    createEventQueue,
    createScriptTimers,
    createNode: root,
    createEntityProxy: entity => entity,
    registerAppProxy() {},
    LerpVector3: class {},
    LerpQuaternion: class {},
    briefError,
    createLogOnce: () => createLogOnce(line => logs.push(line)),
  })
  const world = Object.assign(new EventEmitter(), {
    network: { isServer, isClient: !isServer, id: 0, send: () => true },
    entities: { items: new Map(), remove: id => world.entities.items.delete(id) },
    events: { off() {} },
    setHot() {},
    loader: {
      get: type =>
        type === 'script'
          ? {
              exec(_world, app, _fetch, props) {
                app.on('probe', (data, networkId) =>
                  seen.push({ data, networkId, version: app.blueprint.version, props })
                )
                onScript?.(app)
              },
            }
          : { toNodes: root },
    },
  })
  world.apps = new Apps(world)
  world.blueprints = new Blueprints(world)
  world.blueprints.add({ id: 'bp', version: 0, model: 'cached.glb', script: 'cached.js', props: {} })
  const app = new App(world, { id: 'app', blueprint: 'bp', position: [], quaternion: [], scale: [], state: {} })
  world.entities.items.set('app', app)
  return { world, app, seen, logs, ledger: world.apps.eventLedger }
}

test('Apps: non-string event names cannot emit or send, even with coercion', () => {
  for (const isServer of [false, true]) {
    const errors = []
    const sent = []
    const emitted = []
    const Apps = loadClient('core/systems/Apps.js', 'Apps', {
      console: { error: value => errors.push(value) },
      warn() {},
    })
    const world = {
      network: {
        isServer,
        send: (...args) => sent.push(args) && true,
        sendTo: (...args) => sent.push(args) && true,
        asScript: fn => fn(),
      },
      entities: { get: () => ({}) },
      events: { emit: (...args) => emitted.push(args) },
    }
    const apps = new Apps(world)
    const entity = { data: { id: 'app' }, blueprint: { version: 1 } }
    for (const event of ['wallet', 'normal']) {
      for (const name of [[event], { toString: () => event }, { toString: () => assert.fail('name coerced') }]) {
        apps.worldMethods.emit(entity, name, {})
        apps.appMethods.emit(entity, name, {})
        assert.equal(apps.appMethods.send(entity, name, {}), false)
        assert.equal(apps.appMethods.sendTo(entity, 'player', name, {}), false)
      }
    }
    assert.equal(errors.length, 24)
    assert.equal(sent.length, 0)
    assert.equal(emitted.length, 0)
    apps.worldMethods.emit(entity, 'normal', 1)
    apps.appMethods.emit(entity, 'normal', 2)
    assert.deepEqual(emitted, [
      ['normal', 1],
      ['normal', 2],
    ])
    assert.equal(apps.appMethods.send(entity, 'normal', 3), true)
    if (isServer) assert.equal(apps.appMethods.sendTo(entity, 'player', 'normal', 4), true)
    assert.equal(sent.length, isServer ? 2 : 1)
  }
})

test('Events: on, off and emit ignore non-string names without coercion', () => {
  const Events = loadClient('core/systems/Events.js', 'Events')
  const events = new Events({})
  for (const event of ['wallet', 'normal']) {
    const seen = []
    const callback = (...args) => seen.push(args)
    events.on(event, callback)
    for (const name of [[event], { toString: () => event }, { toString: () => assert.fail('name coerced') }]) {
      events.on(name, () => assert.fail('non-string listener installed'))
      events.emit(name, 1, 2)
      events.off(name, callback)
    }
    assert.deepEqual(seen, [])
    events.emit(event, 3, 4)
    assert.deepEqual(seen, [[3, 4]])
    events.off(event, callback)
    events.emit(event, 5, 6)
    assert.equal(seen.length, 1)
  }
})

test('App: current/older events emit, non-builders cannot keep, and far-future versions always drop', () => {
  const { world, app, seen, logs, ledger } = make()
  world.blueprints.modify({ id: 'bp', version: 1 })
  app.onEvent(1, 'probe', 'current', 'player', { ...meta, builder: false })
  app.onEvent(0, 'probe', 'old', 'player', { ...meta, builder: false })
  app.onEvent(2, 'probe', 'no-meta', 'player')
  app.onEvent(2, 'probe', 'non-builder', 'player', { ...meta, builder: false })
  app.onEvent(3, 'probe', 'builder-far-future', 'builder', meta)
  app.onEvent(1e12, 'probe', 'far-future', 'builder', meta)
  assert.deepEqual(
    seen.map(e => e.data),
    ['current', 'old']
  )
  assert.equal(app.eventQueue.size, 0)
  assert.equal(ledger.bytes, 0)
  assert.equal(app.droppedEvents, 4)
  assert.equal(app.eventDrops.get('future version'), 4)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /\[app\] app: event dropped \(future version\)/)
})

test("App: cached rebuild delivers an event received before the same builder's blueprint modification", () => {
  const { world, app, seen, ledger } = make()
  assert.equal(app.building, false)
  app.onEvent(1, 'probe', 'before', 'builder', meta)
  assert.equal(seen.length, 0)
  assert.equal(ledger.bytes, 64)
  assert.equal(ledger.keptNodes, 8)
  world.blueprints.modify({ id: 'bp', version: 1, props: { revision: 1 } }, false, { authorSocketId: 'builder' })
  assert.deepEqual(seen, [{ data: 'before', networkId: 'builder', version: 1, props: { revision: 1 } }])
  assert.equal(app.building, false)
  assert.equal(app.eventQueue.size, 0)
  assert.equal(ledger.bytes, 0)
  assert.equal(ledger.keptBytes, 0)
})

test('App: fractional, negative and unsafe versions cannot occupy the ledger or bypass builder keeps', () => {
  const { world, app, seen, ledger } = make()
  world.blueprints.modify({ id: 'bp', version: 3 })
  for (const builder of [false, true]) {
    for (const building of [false, true]) {
      app.building = building
      for (const version of [3.5, -1, -0.5, 1e300, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        for (let i = 0; i < 64; i++) app.onEvent(version, 'probe', 'bad', 'player', { ...meta, builder })
      }
    }
  }
  assert.equal(app.eventQueue.size, 0)
  assert.equal(ledger.bytes, 0)
  assert.equal(ledger.nodes, 0)
  assert.equal(seen.length, 0)
  app.onEvent(4, 'probe', 'kept', 'builder', meta)
  assert.equal(app.eventQueue.size, 1)
  assert.equal(ledger.keptBytes, 2 * meta.bytes)
})

test('App: another builder, AI or script cannot authorize a kept event from a different socket', () => {
  for (const authorSocketId of ['other', null]) {
    const { world, app, seen, logs, ledger } = make()
    app.onEvent(1, 'probe', 'before', 'builder', meta)
    world.blueprints.modify({ id: 'bp', version: 1 }, false, { authorSocketId })
    assert.equal(seen.length, 0)
    assert.equal(app.eventDrops.get('kept author mismatch'), 1)
    assert.equal(logs.length, 1)
    assert.equal(ledger.bytes, 0)
  }
})

test('App: an asynchronous rebuild queues registry-current events and drains after the assets load', async () => {
  const { world, app, seen, ledger } = make()
  const cached = world.loader.get
  let finish
  world.loader.get = type => (type === 'model' ? undefined : cached(type))
  world.loader.load = () =>
    new Promise(resolve => {
      finish = resolve
    })
  world.blueprints.modify({ id: 'bp', version: 1 })
  assert.equal(app.building, true)
  assert.equal(app.blueprint.version, 0)
  app.onEvent(1, 'probe', 'during-build', 'player', { ...meta, builder: false })
  assert.equal(ledger.bytes, 64)
  assert.equal(ledger.keptBytes, 0)
  finish({ toNodes: root })
  await Promise.resolve()
  assert.equal(app.building, false)
  assert.deepEqual(
    seen.map(e => [e.data, e.version]),
    [['during-build', 1]]
  )
  assert.equal(ledger.bytes, 0)
})

test('App: destroy, disabling and blueprint swaps clear queued credit and count every removal once', () => {
  for (const action of ['destroy', 'disabled', 'swap']) {
    const { world, app, seen, ledger } = make()
    app.onEvent(1, 'probe', 'before', 'builder', meta)
    app.onEvent(1, 'probe', 'before-again', 'builder', meta)
    if (action === 'destroy') {
      app.destroy()
      app.destroy()
    } else if (action === 'disabled') {
      world.blueprints.modify({ id: 'bp', version: 1, disabled: true })
    } else {
      world.blueprints.add({ ...world.blueprints.get('bp'), id: 'new' })
      app.modify({ blueprint: 'new' })
    }
    assert.equal(seen.length, 0)
    assert.equal(app.eventQueue.size, 0)
    assert.equal(ledger.bytes, 0)
    assert.equal(ledger.nodes, 0)
    assert.equal(ledger.keptBytes, 0)
    assert.equal(ledger.keptNodes, 0)
    assert.equal(app.eventDrops.get('queue cleared'), 2)
  }
})

test('App: destroying a pending build prevents it from resuming after cleanup', async () => {
  const { world, app, ledger } = make()
  let finish
  world.loader.get = () => undefined
  world.loader.load = type =>
    type === 'model'
      ? new Promise(resolve => {
          finish = resolve
        })
      : null
  const building = app.build()
  app.onEvent(0, 'probe', 'queued', 'builder', meta)
  app.destroy()
  finish({ toNodes: () => ({ ...root(), activate: () => assert.fail('destroyed app activated') }) })
  await building
  assert.equal(app.eventQueue.size, 0)
  assert.equal(ledger.bytes, 0)
})

test('App: direct and drain listener failures are counted once each and logged once with metadata only', () => {
  const { world, app, logs, ledger } = make({
    onScript(app) {
      app.on('fail', () => {
        throw { message: 'x'.repeat(1000), payload: { secret: true } }
      })
    },
  })
  app.onEvent(0, 'fail', { secret: 'payload' }, 'builder', meta)
  app.onEvent(1, 'fail', { secret: 'queued-payload' }, 'builder', meta)
  app.onEvent(1, 'probe', 'after-error', 'builder', meta)
  world.blueprints.modify({ id: 'bp', version: 1 }, false, { authorSocketId: 'builder' })
  assert.equal(app.building, false)
  assert.equal(app.eventDrops.get('listener error'), 2)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /listener error/)
  assert.ok(logs[0].endsWith('x'.repeat(200)))
  assert.ok(!logs[0].includes('secret'))
  assert.equal(ledger.bytes, 0)
})

test('Blueprints: author is recorded before builds, existing local/AI/script signatures default to null', () => {
  const { world } = make()
  const observed = []
  world.entities.items.get('app').build = () => observed.push(world.blueprints.authors.get('bp'))
  world.blueprints.modify({ id: 'bp', version: 1 })
  world.blueprints.modify({ id: 'bp', version: 2 }, true)
  world.blueprints.modify({ id: 'bp', version: 3 }, false, { authorSocketId: 'builder' })
  world.blueprints.modify({ id: 'bp', version: 3 }, false, { authorSocketId: 'other' })
  assert.deepEqual(observed, [
    { version: 1, socketId: null },
    { version: 2, socketId: null },
    { version: 3, socketId: 'builder' },
  ])
  assert.deepEqual(world.blueprints.authors.get('bp'), observed[2], 'an unchanged modification cannot steal authorship')
  world.blueprints.add({ id: 'bp', version: 0 })
  assert.equal(world.blueprints.authors.size, 0)
  world.blueprints.modify({ id: 'bp', version: 1 })
  world.blueprints.destroy()
  assert.equal(world.blueprints.authors.size, 0)
})

test('client: no author records or charged costs; onEntityEvent calls onEvent with four arguments', () => {
  const { world, app, ledger } = make({ isServer: false })
  world.blueprints.modify({ id: 'bp', version: 1 }, false, { authorSocketId: 'unused' })
  assert.equal(world.blueprints.authors.size, 0)
  app.building = true
  app.onEvent(1, 'probe', 'queued', undefined)
  assert.equal(app.eventQueue.size, 1)
  assert.equal(ledger.bytes, 0)
  assert.equal(ledger.nodes, 0)
  const network = new ClientNetwork(world)
  world.entities.get = () => ({ onEvent: (...args) => assert.deepEqual(args, [1, 'probe', 'client', undefined]) })
  network.onEntityEvent(['app', 1, 'probe', 'client'])
})
