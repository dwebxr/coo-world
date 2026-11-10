import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { loadClient, Blueprints } from './lib/clientHarness.mjs'
import { Entity } from '../src/core/entities/Entity.js'
import { createEventQueue } from '../src/core/extras/appEventQueue.js'
import { createScriptTimers } from '../src/core/extras/scriptTimers.js'
import { briefError, createLogOnce } from '../src/core/extras/logOnce.js'
import { stopApps } from '../src/server/shutdown.js'

const root = () => ({
  position: { fromArray() {} },
  quaternion: { fromArray() {} },
  scale: { fromArray() {} },
  activate() {},
  deactivate() {},
})

// a server app whose model is still loading when the server begins to stop
function pendingApp() {
  const runs = []
  let resolveModel
  const model = new Promise(resolve => (resolveModel = resolve))
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
    createLogOnce: () => createLogOnce(() => {}),
    assertScriptActive() {},
    serializeError: err => ({ message: String(err?.message) }),
  })
  const world = Object.assign(new EventEmitter(), {
    network: { isServer: true, isClient: false, id: 0, send: () => true },
    entities: { items: new Map(), remove: id => world.entities.items.delete(id), stateEmptied() {} },
    events: { off() {} },
    setHot() {},
    loader: {
      get: type =>
        type === 'script'
          ? {
              exec(_world, app, _fetch, _props, setTimeout) {
                runs.push('exec')
                app.on('destroy', () => runs.push('destroy'))
                setTimeout(() => runs.push('timer'), 0)
              },
            }
          : null,
      load: type => (type === 'model' ? model : Promise.resolve({ toNodes: root })),
    },
  })
  world.apps = new Apps(world)
  world.blueprints = new Blueprints(world)
  world.blueprints.add({ id: 'bp', version: 0, model: 'asset://slow.glb', script: 'asset://app.js', props: {} })
  const app = new App(world, { id: 'app', blueprint: 'bp', position: [], quaternion: [], scale: [], state: {} })
  world.entities.items.set('app', app)
  return { world, app, runs, resolveModel }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1))
}

test('app stop: a build waiting for its assets when the server stops never runs its script, timers or destroy', async () => {
  const { world, app, runs, resolveModel } = pendingApp()
  await settle()
  assert.deepEqual(runs, [], 'still waiting for the model')
  stopApps(world)
  resolveModel({ toNodes: root })
  await settle()
  assert.deepEqual(runs, [])
  // nothing restarts it either: a crash rebuild, a blueprint change
  app.crash()
  world.blueprints.modify({ id: 'bp', version: 1, props: { changed: true } })
  await settle()
  assert.deepEqual(runs, [])
})

test('app stop: without the stop the same build runs its script and its timer (the control)', async () => {
  const { runs, resolveModel } = pendingApp()
  resolveModel({ toNodes: root })
  await settle()
  assert.deepEqual(runs, ['exec', 'timer'])
})
