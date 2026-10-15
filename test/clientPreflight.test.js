import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientWorld, loadClient } from './lib/clientHarness.mjs'
import { CHANGE_TOO_LARGE } from '../src/core/extras/clientPreflight.js'
import { sanitizeBlueprintAdd, sanitizeBlueprintModify } from '../src/core/extras/blueprintPolicy.js'
import { createInboundGate, packetByteLimit, packetNodeLimit } from '../src/core/extras/inboundPolicy.js'
import { writeClientPacket } from '../src/core/packets.js'
import { strictDecode } from '../src/core/extras/strictDecode.js'

const decode = packet => strictDecode(packet, { maxNodes: 8192, build: true }).value[1]

test('client fits: exact wire byte caps, including overhead, match server admission for every cap', () => {
  const world = clientWorld()
  for (const name of ['entityEvent', 'blueprintAdded', 'blueprintModified', 'ai', 'chatAdded']) {
    const cap = packetByteLimit(name)
    const text = 'x'.repeat(cap - 5)
    assert.equal(writeClientPacket(name, text).length, cap)
    for (const data of [text, text + 'x']) {
      const packet = writeClientPacket(name, data)
      assert.equal(
        world.network.fits(name, data),
        !!createInboundGate({ log() {} }).admit({}, packet, { builder: true })
      )
    }
  }
  assert.equal(world.network.fits('entityEvent', ['app', 0, 'size', 'x'.repeat(60 * 1024)]), true)
  assert.equal(world.packets.length, 0, 'fits is side-effect free')
})

test('client fits: exact node caps, depth, bin cost and strict formats match the server count pass', () => {
  const world = clientWorld()
  for (const name of ['entityEvent', 'blueprintAdded', 'blueprintModified', 'ai', 'chatAdded']) {
    const max = packetNodeLimit(name)
    for (const length of [max - 3, max - 2]) {
      const data = Array(length).fill(null)
      assert.equal(world.network.fits(name, data), length === max - 3)
    }
    const bins = Array(Math.floor((max - 3) / 4) + 1).fill(new Uint8Array())
    assert.equal(world.network.fits(name, bins), false)
  }
  assert.equal(world.network.fits('entityEvent', new Date()), false)
  assert.equal(world.network.fits('entityEvent', new Map([[1, 'no string key']])), false)
  assert.equal(world.network.fits('entityEvent', new Map([['key', 'value']])), true)
  let deep = null
  for (let i = 0; i < 33; i++) deep = [deep]
  assert.equal(world.network.fits('entityEvent', deep), false)
  assert.equal(world.network.send('entityEvent', deep), false)
  assert.equal(world.packets.length, 0)
  // The encoder's documented exceptions remain exceptions at the sender.
  assert.throws(() => world.network.fits('entityEvent', Symbol('bad')))
})

test('ClientNetwork.send: false and builder toast; app.send forwards true/false and logs once per event name', () => {
  const world = clientWorld()
  const Apps = loadClient('core/systems/Apps.js', 'Apps')
  const apps = new Apps(world)
  const entity = { data: { id: 'app' }, blueprint: { version: 0 } }
  const logs = []
  const original = console.error
  console.error = (...args) => logs.push(args)
  try {
    for (const name of ['blueprintAdded', 'blueprintModified', 'ai']) {
      assert.equal(world.network.send(name, 'x'.repeat(70 * 1024)), false)
    }
    for (const name of ['large', 'large', 'other']) {
      assert.equal(apps.appMethods.send(entity, name, 'x'.repeat(70 * 1024)), false)
    }
    assert.equal(logs.length, 2)
    assert.deepEqual(world.toasts, Array(3).fill(CHANGE_TOO_LARGE))
    assert.equal(world.packets.length, 0)
    assert.equal(apps.appMethods.send(entity, 'size', 'x'.repeat(60 * 1024)), true)
    assert.equal(world.packets.length, 1)
  } finally {
    console.error = original
  }
})

test('blueprint registry: policy before fits, sanitized send before rebuild, same output as the server policy', () => {
  const world = clientWorld()
  const input = { id: 'bp', version: 0, author: null, props: {}, name: 'x'.repeat(300), extra: 1 }
  assert.equal(world.blueprints.add(input, true), true)
  assert.deepEqual(world.blueprints.get('bp'), sanitizeBlueprintAdd(input).value)
  assert.deepEqual(decode(world.packets[0]), sanitizeBlueprintAdd(input).value)
  let builds = 0
  world.entities.items.set('app', {
    data: { blueprint: 'bp', state: { old: true } },
    build() {
      builds++
      assert.equal(world.packets.length, 2, 'announcement already sent when a cached script starts')
      world.network.send('entityEvent', ['app', 1, 'ready', true])
    },
  })
  const change = { id: 'bp', version: 1, props: { text: 'accepted' }, desc: '😀'.repeat(3000) }
  assert.equal(world.blueprints.modify(change, true), true)
  assert.deepEqual(decode(world.packets[1]), sanitizeBlueprintModify(change).value)
  assert.equal(builds, 1)
  assert.equal(world.blueprints.get('bp').desc.length, 4096)
})

test('blueprint registry: refusal changes no state, emits no modify and sends no packets', () => {
  const world = clientWorld()
  const original = { id: 'bp', version: 0, props: { text: 'original' } }
  world.blueprints.add(original)
  let modified = 0
  world.blueprints.on('modify', () => modified++)
  assert.equal(world.blueprints.add({ ...original, id: 'new', props: { text: 'x'.repeat(70 * 1024) } }, true), false)
  assert.equal(world.blueprints.get('new'), undefined)
  assert.equal(world.blueprints.modify({ id: 'bp', version: 1, props: { text: 'x'.repeat(70 * 1024) } }, true), false)
  assert.equal(world.blueprints.modify({ id: 'bp', disabled: 'yes' }, true), false)
  assert.equal(world.blueprints.add({ id: 'invalid', version: -1 }, true), false)
  assert.equal(world.blueprints.get('invalid'), undefined)
  assert.equal(world.blueprints.get('bp'), original)
  assert.equal(modified, 0)
  assert.equal(world.packets.length, 0)
  assert.deepEqual(world.toasts, [
    CHANGE_TOO_LARGE,
    CHANGE_TOO_LARGE,
    ...Array(2).fill('This change could not be saved'),
  ])
  world.network.send = () => false
  assert.equal(world.blueprints.modify({ id: 'bp', version: 1 }, true), false)
  assert.equal(world.blueprints.get('bp'), original)
})

test('entity registry: refuses an oversized add before constructing an entity', () => {
  const App = class {
    constructor() {
      assert.fail('must not construct')
    }
  }
  const Entities = loadClient('core/systems/Entities.js', 'Entities', { App, PlayerLocal: App, PlayerRemote: App })
  const world = clientWorld()
  const registry = new Entities(world)
  assert.equal(registry.add({ type: 'app', state: { text: 'x'.repeat(40 * 1024) } }, true), false)
  assert.equal(registry.items.size, 0)
  assert.deepEqual(world.toasts, [CHANGE_TOO_LARGE])
})

test('undo: oversized add/move keeps the undo and selection, with no local or network effects', () => {
  const Builder = loadClient('core/systems/ClientBuilder.js', 'ClientBuilder')
  for (const undo of [
    { name: 'add-entity', data: { id: 'app', state: { text: 'x'.repeat(40 * 1024) } } },
    { name: 'move-entity', entityId: 'app', position: ['x'.repeat(40 * 1024)], quaternion: [0, 0, 0, 1] },
  ]) {
    const world = clientWorld()
    world.entities.get = () => ({ data: { scale: [1, 1, 1] } })
    const builder = Object.assign(Object.create(Builder.prototype), {
      world,
      undos: [undo],
      selected: {},
      select() {
        assert.fail('selection changed')
      },
    })
    builder.undo()
    assert.equal(builder.undos.length, 1)
    assert.equal(builder.undos[0], undo)
    assert.equal(world.packets.length, 0)
    assert.deepEqual(world.toasts, [CHANGE_TOO_LARGE])
  }
})

test('AI: oversized create refuses before its placeholder; /fix truncates oversized error text to fit', async () => {
  const AI = loadClient('core/systems/ClientAI.js', 'ClientAI', { console: { log() {}, error() {} } })
  const world = clientWorld()
  world.builder = { canBuild: () => true }
  world.network.getTime = () => 0
  const ai = new AI(world)
  ai.enabled = true
  await ai.create({ value: 'x'.repeat(70 * 1024) })
  assert.equal(world.blueprints.items.size, 0)
  assert.equal(world.packets.length, 0)
  assert.deepEqual(world.toasts, [CHANGE_TOO_LARGE])
  const scriptError = { name: 'Error', message: '😀'.repeat(70 * 1024), stack: '界'.repeat(70 * 1024) }
  world.builder.getEntityAtReticle = () => ({
    isApp: true,
    blueprint: {},
    data: { id: 'app', blueprint: 'bp' },
    scriptError,
  })
  await ai.fix()
  assert.equal(world.packets.length, 1)
  const action = decode(world.packets[0])
  assert.equal(world.network.fits('ai', action), true)
  assert.ok(scriptError.message.startsWith(action.error.message))
  assert.ok(scriptError.stack.startsWith(action.error.stack))
  assert.ok(action.error.message.length > 0)
  assert.equal(scriptError.message.length, 140 * 1024)
})

test('.hyp import and scene replacement: refusal precedes caching, rebuilding and uploading', async () => {
  for (const scene of [false, true]) {
    const world = clientWorld()
    const old = { id: '$scene', version: 0, props: {} }
    world.blueprints.add(old)
    world.loader = {
      insert() {
        assert.fail('cached a refused import')
      },
    }
    world.ui = { confirm: async () => true }
    world.network.upload = () => assert.fail('uploaded a refused import')
    world.entities.add = () => assert.fail('spawned a refused import')
    const info = {
      blueprint: { scene, props: { text: 'x'.repeat(70 * 1024) } },
      assets: [{ type: 'model', url: 'asset://a.glb', file: {} }],
    }
    const Builder = loadClient('core/systems/ClientBuilder.js', 'ClientBuilder', { importApp: async () => info })
    const builder = Object.assign(Object.create(Builder.prototype), { world })
    await builder.addApp({}, { position: [0, 0, 0], quaternion: [0, 0, 0, 1] })
    assert.equal(world.blueprints.get('$scene'), old)
    assert.equal(world.blueprints.items.size, 1)
    assert.equal(world.packets.length, 0)
    assert.deepEqual(world.toasts, [CHANGE_TOO_LARGE])
  }
})

test('.hyp upload exception: preflight, local build, upload, then sanitized announcement', async () => {
  const world = clientWorld()
  const order = []
  const info = {
    blueprint: { name: 'n'.repeat(300), props: { text: 'kept' } },
    assets: [{ type: 'model', url: 'asset://a.glb', file: {} }],
  }
  world.loader = {
    insert() {
      order.push('cache')
    },
  }
  world.entities.add = (data, local) => {
    assert.equal(local, false)
    assert.equal(world.packets.length, 0)
    assert.equal(world.blueprints.get(data.blueprint).name.length, 256)
    order.push('build')
    world.blueprints.get(data.blueprint).props.text = 'mutated while uploading'
    data.state = { local: true }
    return { onUploaded: () => order.push('uploaded') }
  }
  world.network.upload = async () => {
    order.push('upload')
  }
  const send = world.network.send.bind(world.network)
  world.network.send = (name, data) => {
    order.push(name)
    return send(name, data)
  }
  const Builder = loadClient('core/systems/ClientBuilder.js', 'ClientBuilder', { importApp: async () => info })
  const builder = Object.assign(Object.create(Builder.prototype), { world })
  await builder.addApp({}, { position: [0, 0, 0], quaternion: [0, 0, 0, 1] })
  assert.deepEqual(order, ['cache', 'build', 'upload', 'blueprintAdded', 'entityAdded', 'uploaded'])
  assert.equal(decode(world.packets[0]).name.length, 256)
  assert.equal(decode(world.packets[0]).props.text, 'kept')
  assert.deepEqual(decode(world.packets[1]).state, {})
  assert.equal(world.blueprints.get(decode(world.packets[0]).id).props.text, 'mutated while uploading')
})
