import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadClient, Blueprints } from './lib/clientHarness.mjs'
import { Entity } from '../src/core/entities/Entity.js'
import { createEventQueue } from '../src/core/extras/appEventQueue.js'
import { createScriptTimers } from '../src/core/extras/scriptTimers.js'
import { createEntityProxy } from '../src/core/extras/createEntityProxy.js'
import { assertScriptActive, handlePhysicsFailure } from '../src/core/extras/physicsFailure.js'
import { createScriptResponse, toHostFetchOptions } from '../src/core/extras/scriptFetch.js'
import { serializeError } from '../src/core/extras/serializeError.js'
import { fieldValues } from '../src/core/extras/appFields.js'
import { exportApp } from '../src/core/extras/appTools.js'

const root = () => ({
  position: { fromArray() {} },
  quaternion: { fromArray() {} },
  scale: { fromArray() {} },
  activate() {},
  deactivate() {},
  traverse() {},
  getProxy: () => ({}),
})

// two instances of one blueprint, each running the given script with the real App, Apps and entity proxies
function makeWorld(script, { props = { color: 'red', list: [1, 2] }, isServer = true } = {}) {
  const Apps = loadClient('core/systems/Apps.js', 'Apps')
  const App = loadClient('core/entities/App.js', 'App', {
    Entity,
    createEventQueue,
    createScriptTimers,
    createNode: root,
    createEntityProxy,
    registerAppProxy() {},
    LerpVector3: class {},
    LerpQuaternion: class {},
    assertScriptActive,
    handlePhysicsFailure,
    createScriptResponse,
    toHostFetchOptions,
    serializeError,
  })
  const world = Object.assign(new EventEmitter(), {
    network: { isServer, isClient: !isServer, id: 0, send: () => true, asScript: fn => fn() },
    entities: { items: new Map(), remove: id => world.entities.items.delete(id) },
    events: { emit() {}, on() {}, off() {} },
    setHot() {},
    loader: { get: type => (type === 'script' ? { exec: script } : { toNodes: root }) },
  })
  world.apps = new Apps(world)
  world.blueprints = new Blueprints(world)
  world.blueprints.add({ id: 'bp', version: 0, name: 'Shop', model: 'm.glb', script: 's.js', props })
  const apps = ['a', 'b'].map(id => {
    const app = new App(world, { id, blueprint: 'bp', position: [], quaternion: [], scale: [], state: {} })
    world.entities.items.set(id, app)
    return app
  })
  return { world, apps, App }
}

test('props: each instance gets its own copy; script changes reach nothing shared', () => {
  const seen = []
  const { world, apps } = makeWorld((_world, app, _fetch, props) => {
    seen.push({ props, appProps: app.props, config: app.config })
    if (seen.length === 1) {
      props.color = 'blue'
      props.list.push(3)
      props.added = 'x'.repeat(100_000)
      props['__proto__'] = { polluted: true }
      Object.defineProperty(props, 'trap', { get: () => 'getter', enumerable: true })
      Object.setPrototypeOf(props, { inherited: true })
    }
  })
  const before = structuredClone(world.blueprints.serialize())
  assert.equal(seen.length, 2)
  const [first, second] = seen
  assert.equal(first.props, first.appProps, 'app.props is the props the script was given')
  assert.equal(first.props, first.config)
  assert.notEqual(first.props, second.props)
  assert.deepEqual(second.props, { color: 'red', list: [1, 2] }, 'the other instance is untouched')
  const blueprint = world.blueprints.get('bp')
  assert.deepEqual(blueprint.props, { color: 'red', list: [1, 2] })
  assert.equal(Object.getPrototypeOf(blueprint.props), Object.prototype)
  assert.equal({}.polluted, undefined)
  assert.deepEqual(world.blueprints.serialize(), before, 'the join snapshot carries only the blueprint data')
  assert.equal(apps[0].props.color, 'blue')
  // a rebuild (here: a blueprint change) gives every instance a fresh copy of the new props
  world.blueprints.modify({ id: 'bp', version: 1, props: { color: 'green' } })
  assert.deepEqual(
    seen.slice(2).map(entry => entry.props),
    [{ color: 'green' }, { color: 'green' }]
  )
})

test('props: configure applies initial values to the instance copy only', () => {
  const warnings = []
  const original = console.warn
  console.warn = line => warnings.push(line)
  try {
    const { world, apps } = makeWorld(
      (_world, app) => {
        app.configure([
          { type: 'text', key: 'title', initial: 'Hello' },
          { type: 'text', key: 'color', initial: 'ignored: set on the blueprint' },
          { type: 'text', key: '__proto__', initial: { polluted: true } },
          { type: 'text', key: 'big', initial: { nested: ['x'.repeat(10)] } },
        ])
      },
      { props: { color: 'red' } }
    )
    const props = apps.map(app => app.props)
    assert.deepEqual(props[0], { color: 'red', title: 'Hello', big: { nested: ['xxxxxxxxxx'] } })
    assert.deepEqual(props[1], props[0])
    assert.notEqual(props[0].big, props[1].big, 'initial objects are copied per instance')
    assert.deepEqual(world.blueprints.get('bp').props, { color: 'red' }, 'the shared blueprint keeps only set values')
    assert.equal(Object.getPrototypeOf(props[0]), Object.prototype)
    assert.equal({}.polluted, undefined)
    assert.equal(warnings.length, 2, 'one warning per app for the dropped field')
    // the sidebar and the .hyp export show the effective values
    assert.deepEqual(fieldValues(apps[0].fields, world.blueprints.get('bp').props), {
      color: 'red',
      title: 'Hello',
      big: { nested: ['xxxxxxxxxx'] },
    })
    // editing one prop in the sidebar (blueprintModified with the blueprint's props plus that key) keeps the
    // others: unset keys still come from initial, set ones stay
    const bp = world.blueprints.get('bp')
    world.blueprints.modify({ id: 'bp', version: bp.version + 1, props: { ...bp.props, title: 'Edited' } })
    assert.deepEqual(apps[0].props, { color: 'red', title: 'Edited', big: { nested: ['xxxxxxxxxx'] } })
    assert.deepEqual(world.blueprints.get('bp').props, { color: 'red', title: 'Edited' })
  } finally {
    console.warn = original
  }
})

test('props: a blueprint without props gives the script an empty object', () => {
  let given
  const { world } = makeWorld(
    (_world, _app, _fetch, props) => {
      given = props
      props.x = 1
    },
    { props: null }
  )
  assert.deepEqual(given, { x: 1 })
  assert.equal(world.blueprints.get('bp').props, null)
})

test('props: the .hyp export bakes in the effective values (set props plus initial values)', async () => {
  const fields = [
    { type: 'text', key: 'title', initial: 'Hello' },
    { type: 'file', key: 'image', initial: { type: 'texture', name: 'a.png', url: 'asset://a.png' } },
  ]
  const blueprint = { id: 'bp', version: 3, name: 'Shop', model: 'asset://m.glb', props: { color: 'red' } }
  const resolveFile = async url => new File([url], url.slice(8), { type: 'application/octet-stream' })
  const file = await exportApp({ ...blueprint, props: fieldValues(fields, blueprint.props) }, resolveFile)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const size = new DataView(bytes.buffer).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + size)))
  assert.deepEqual(header.blueprint.props, { color: 'red', title: 'Hello', image: fields[1].initial })
  assert.deepEqual(
    header.assets.map(asset => asset.url),
    ['asset://m.glb', 'asset://a.png']
  )
})
