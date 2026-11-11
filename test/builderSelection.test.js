import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPacket } from '../src/core/packets.js'
import { strictDecode } from '../src/core/extras/strictDecode.js'
import { loadClient, clientWorld } from './lib/clientHarness.mjs'
import { Entity } from '../src/core/entities/Entity.js'
import { createEventQueue } from '../src/core/extras/appEventQueue.js'
import { createScriptTimers } from '../src/core/extras/scriptTimers.js'
import { briefError, createLogOnce } from '../src/core/extras/logOnce.js'

// stand-in nodes that record which of them are mounted
function nodes() {
  const mounted = new Set()
  const vector = value => ({ fromArray() {}, toArray: () => [...value] })
  const createNode = () => {
    const node = {
      position: vector([0, 0, 0]),
      quaternion: vector([0, 0, 0, 1]),
      scale: vector([1, 1, 1]),
      activate() {
        mounted.add(node)
      },
      deactivate() {
        mounted.delete(node)
      },
      traverse() {},
    }
    return node
  }
  return { mounted, createNode }
}

// a builder's client (network id `player`) with the real App, Apps, Blueprints, ClientNetwork and ClientBuilder,
// and one app another user (`uploader`) is still uploading: shown here as the loading placeholder
function builderWithUpload() {
  const { mounted, createNode } = nodes()
  const Apps = loadClient('core/systems/Apps.js', 'Apps')
  const App = loadClient('core/entities/App.js', 'App', {
    Entity,
    createEventQueue,
    createScriptTimers,
    createNode,
    createEntityProxy: entity => entity,
    registerAppProxy() {},
    LerpVector3: class {},
    LerpQuaternion: class {},
    briefError,
    createLogOnce: () => createLogOnce(() => {}),
    assertScriptActive() {},
    serializeError: err => ({ message: String(err?.message) }),
  })
  const world = clientWorld()
  world.network.isClient = true
  world.network.isServer = false
  // the client's entity list, as Entities.remove does it: the app is torn down and leaves the list
  world.entities.get = id => world.entities.items.get(id)
  world.entities.remove = id => {
    const entity = world.entities.items.get(id)
    if (!entity) return
    entity.destroy()
    world.entities.items.delete(id)
  }
  world.entities.stateEmptied = () => {}
  world.entities.player = {}
  world.events = { on() {}, off() {}, emit() {} }
  world.setHot = () => {}
  world.apps = new Apps(world)
  world.blueprints.add({ id: 'bp', version: 0, name: 'Box', model: 'asset://box.glb', props: {} })
  const app = new App(world, {
    id: 'app',
    type: 'app',
    blueprint: 'bp',
    position: [1, 2, 3],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    mover: null,
    uploader: 'uploader',
    pinned: false,
    state: {},
  })
  world.entities.items.set('app', app)
  const Builder = loadClient('core/systems/ClientBuilder.js', 'ClientBuilder')
  const builder = Object.assign(Object.create(Builder.prototype), {
    world,
    enabled: false,
    mode: 'grab',
    undos: [],
    selected: null,
    control: { tab: { pressed: false }, keyC: {}, scrollDelta: {} },
    target: { position: { copy() {} }, quaternion: { copy() {} }, scale: { copy() {} } },
    updateActions() {},
  })
  return { world, app, builder, mounted }
}

// what the client sent, by name, with the data as the server reads it
const sent = world =>
  world.packets.map(packet => [readPacket(packet)[0], strictDecode(packet, { maxNodes: 8192, build: true }).value[1]])

test('builder: an app removed while selected is not placed, announced or built again on deselection', () => {
  const { world, app, builder, mounted } = builderWithUpload()
  assert.equal(mounted.size, 1, 'the loading placeholder')
  builder.select(app)
  assert.equal(app.data.mover, 'player')
  assert.deepEqual(sent(world), [['onEntityModified', { id: 'app', mover: 'player' }]])
  world.packets.length = 0
  // its uploader leaves before the upload finished: the server removes it
  world.network.onEntityRemoved('app')
  assert.equal(app.destroyed, true)
  assert.equal(world.entities.get('app'), undefined)
  assert.equal(mounted.size, 0)
  // the builder's next frame lets go of it
  builder.update(0)
  assert.equal(builder.selected, null)
  assert.deepEqual(sent(world), [], 'no change is sent for an app that is gone')
  assert.equal(mounted.size, 0, 'nothing is mounted for it again')
})

test('app: a removed app is not built again', async () => {
  const { app, mounted } = builderWithUpload()
  assert.equal(mounted.size, 1)
  app.destroy()
  assert.equal(mounted.size, 0)
  await app.build()
  assert.equal(mounted.size, 0)
  // (control: an app that is not removed is built)
  const other = builderWithUpload()
  await other.app.build()
  assert.equal(other.mounted.size, 1)
})
