import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readPacket, writeClientPacket, writePacket } from '../src/core/packets.js'
import {
  sanitizeBlueprintAdd,
  sanitizeBlueprintModify,
  WORLD_BLUEPRINT_BYTES,
} from '../src/core/extras/blueprintPolicy.js'
import { Blueprints } from './lib/clientHarness.mjs'
import { fakeWs, makeNetwork, Socket } from './lib/networkHarness.mjs'

function fixture() {
  const logs = []
  const network = makeNetwork(line => logs.push(line))
  const world = network.world
  world.network = network
  world.entities = {
    items: new Map(),
    get(id) {
      return this.items.get(id)
    },
    add(data) {
      const entity = { data, isApp: true }
      this.items.set(data.id, entity)
      return entity
    },
  }
  world.blueprints = new Blueprints(world)
  const connect = id => {
    const socket = new Socket({ id, ws: fakeWs(), network, player: { isBuilder: () => true } })
    network.sockets.set(id, socket)
    return socket
  }
  const author = connect('author')
  const watcher = connect('watcher')
  const send = (name, data, socket = author) => {
    socket.ws.emit('message', writeClientPacket(name, data))
    network.flush()
  }
  const packets = (socket = watcher) => socket.ws.packets.map(readPacket)
  return { network, world, author, watcher, connect, send, packets, logs }
}

const app = (id, blueprint) => ({
  id,
  type: 'app',
  blueprint,
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  mover: null,
  uploader: null,
  pinned: false,
  state: {},
})

test('blueprint enforcement: decoded adds and modifies store and broadcast only the shared policy value', () => {
  const f = fixture()
  const add = {
    id: 'bp',
    version: 0,
    name: 'x'.repeat(255) + '😀tail',
    author: null,
    unknown: 'secret',
    public: null,
    props: { nested: [1, undefined, 'kept'], absent: undefined },
  }
  f.send('blueprintAdded', add)
  const safeAdd = sanitizeBlueprintAdd(add).value
  assert.deepEqual(f.world.blueprints.get('bp'), safeAdd)
  assert.deepEqual(f.packets(), [['onBlueprintAdded', safeAdd]])
  const change = { id: 'bp', version: 1, desc: 'd'.repeat(5000), model: null, locked: undefined, extra: {} }
  f.send('blueprintModified', change)
  const safeChange = sanitizeBlueprintModify(change).value
  assert.deepEqual(f.world.blueprints.get('bp'), { ...safeAdd, ...safeChange })
  assert.deepEqual(f.packets()[1], ['onBlueprintModified', safeChange])
  assert.deepEqual(f.world.blueprints.authors.get('bp'), { version: 1, socketId: f.author.id })
  assert.deepEqual([...f.network.dirtyBlueprints.keys()], ['bp'])
  assert.equal(f.packets(f.author).length, 0, 'accepted broadcasts exclude the editing socket')
})

test('blueprint enforcement: unknown names are escaped, cut to 32 characters and logged once per socket', () => {
  const f = fixture()
  const key = '\n"' + 'x'.repeat(30) + 'secret-key-tail'
  for (const socket of [f.author, f.connect('author')]) {
    f.send('blueprintAdded', { id: 'bp', version: 0, [key]: 'secret-value' }, socket)
    for (let version = 1; version <= 20; version++) {
      f.send('blueprintModified', { id: 'bp', version, [`other-${version}`]: 'secret-value' }, socket)
    }
  }
  assert.deepEqual(f.logs, Array(2).fill(`blueprint: unknown key ${JSON.stringify(key.slice(0, 32))}`))
  assert.ok(f.logs.every(line => !line.includes('\n') && !line.includes('secret')))
  assert.deepEqual(f.world.blueprints.get('bp'), { id: 'bp', version: 20 })
  assert.ok(f.packets().every(([, data]) => Object.keys(data).length === 2))
})

test('blueprint enforcement: invalid and stale changes share a one-second revert limit per socket and blueprint', t => {
  let now = 10000
  t.mock.method(Date, 'now', () => now)
  const f = fixture()
  const current = { id: 'bp', version: 3, props: { text: 'current' } }
  f.world.blueprints.add(current)
  f.world.blueprints.add({ ...current, id: 'other' })
  const refuse = data => f.send('blueprintModified', { id: 'bp', ...data })
  refuse({ version: 4, disabled: 'yes' })
  assert.deepEqual(f.packets(f.author), [['onBlueprintModified', current]])
  const logged = f.logs.length
  for (const version of ['4', -1, NaN, Infinity, 1.5, 3, 2, undefined, null]) refuse({ version })
  now += 999
  refuse({ version: 4, props: { bad: Infinity } })
  assert.equal(f.packets(f.author).length, 1)
  assert.equal(f.logs.length, logged, 'repeated refusals are silent')
  f.send('blueprintModified', { id: 'other', version: 3 })
  assert.equal(f.packets(f.author).length, 2, 'another blueprint has its own limit')
  const second = f.connect('second')
  f.send('blueprintModified', { id: 'bp', version: 3 }, second)
  assert.deepEqual(f.packets(second), [['onBlueprintModified', current]])
  now++
  refuse({ version: 4, disabled: 0 })
  assert.equal(f.packets(f.author).length, 3, 'reply resumes exactly at one second')
  assert.equal(f.author.blueprintReverts.size, 2)
  now += 1000
  refuse({ version: 3 })
  assert.equal(f.author.blueprintReverts.size, 1, 'expired ids are pruned')
  assert.equal(f.world.blueprints.get('bp'), current)
  assert.equal(f.network.dirtyBlueprints.size, 0)
  assert.equal(f.packets().length, 0)
})

test('blueprint enforcement: malformed roots and invalid ids have no effects or handler failures', () => {
  const f = fixture()
  for (const data of [null, false, [], 1, 'bp', { id: 1, version: 0 }, { id: 'x'.repeat(65), version: 0 }]) {
    f.send('blueprintAdded', data)
    f.send('blueprintModified', data)
  }
  assert.equal(f.world.blueprints.items.size, 0)
  assert.equal(f.packets().length, 0)
  assert.equal(f.packets(f.author).length, 0)
  assert.equal(f.logs.length, 2)
  assert.ok(f.logs.every(line => !line.includes('failed:')))
})

test('blueprint enforcement: a refused add removes the matching optimistic entity only on its socket', () => {
  const f = fixture()
  // Even if the id already exists, a refused replacement must not spawn against that old blueprint.
  const current = { id: 'bp', version: 0 }
  f.world.blueprints.add(current)
  f.send('blueprintAdded', { id: 'bp', version: 1, props: [] })
  f.send('entityAdded', app('other-socket-app', 'bp'), f.watcher)
  f.send('entityAdded', app('refused-app', 'bp'))
  assert.deepEqual(f.packets(f.author), [
    ['onEntityAdded', app('other-socket-app', 'bp')],
    ['onEntityRemoved', 'refused-app'],
  ])
  assert.equal(f.world.entities.get('refused-app'), undefined)
  assert.equal(f.world.blueprints.get('bp'), current)
  assert.equal(f.author.refusedBlueprint, null)
  assert.equal(f.packets().length, 0)
  assert.deepEqual([...f.network.dirtyApps.keys()], ['other-socket-app'])
  assert.equal(f.network.dirtyBlueprints.size, 0)
  f.send('entityAdded', app('next-app', 'bp'))
  assert.ok(f.world.entities.get('next-app'), 'the pending refusal is consumed once')
})

test('blueprint enforcement: a refused new blueprint and its entity are both absent', () => {
  const f = fixture()
  for (const id of ['new', 'x'.repeat(65)]) {
    f.send('blueprintAdded', { id, version: -1 })
    f.send('entityAdded', app(`app-${id}`, id))
    assert.equal(f.world.blueprints.get(id), undefined)
    assert.equal(f.world.entities.get(`app-${id}`), undefined)
  }
  assert.deepEqual(f.packets(f.author), [
    ['onEntityRemoved', 'app-new'],
    ['onEntityRemoved', `app-${'x'.repeat(65)}`],
  ])
  assert.equal(f.packets().length, 0)
})

test('blueprint enforcement: pending add refusal survives unrelated entities, expires and clears on a valid retry', t => {
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const f = fixture()
  f.world.blueprints.add({ id: 'bp', version: 0 })
  f.world.blueprints.add({ id: 'other', version: 0 })
  f.send('blueprintAdded', { id: 'bp', version: -1 })
  f.send('entityAdded', app('unrelated', 'other'))
  assert.equal(f.author.refusedBlueprint.id, 'bp')
  now = 10000
  f.send('entityAdded', app('expired', 'bp'))
  assert.ok(f.world.entities.get('expired'))
  assert.equal(f.author.refusedBlueprint, null)
  f.send('blueprintAdded', { id: 'bp', version: -1 })
  f.send('blueprintAdded', { id: 'bp', version: 1 })
  f.send('entityAdded', app('retry', 'bp'))
  assert.ok(f.world.entities.get('retry'))
  assert.equal(f.author.refusedBlueprint, null)
  assert.equal(f.packets(f.author).length, 0)
})

test('blueprint enforcement: five production shapes and four collection files are stored and broadcast unchanged', () => {
  const production = JSON.parse(fs.readFileSync(new URL('./fixtures/blueprint-shapes.json', import.meta.url)))
  const directory = new URL('../src/world/collections/default/', import.meta.url)
  const collection = fs
    .readdirSync(directory)
    .filter(name => name.endsWith('.hyp'))
    .map(name => {
      const bytes = fs.readFileSync(new URL(name, directory))
      return JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0))).blueprint
    })
  assert.equal(production.length, 5)
  assert.equal(collection.length, 4)
  for (const blueprint of [...production, ...collection]) {
    const f = fixture()
    f.send('blueprintAdded', blueprint)
    assert.deepEqual(f.world.blueprints.get(blueprint.id), blueprint, blueprint.name)
    assert.deepEqual(f.packets(), [['onBlueprintAdded', blueprint]])
    assert.deepEqual(f.logs, [])
  }
})

const largeBlueprint = (id, length = 60000) => ({ id, version: 0, props: { notes: 'n'.repeat(length) } })
const totalBytes = blueprints =>
  blueprints.serialize().reduce((total, bp) => total + writePacket('blueprintAdded', bp).length, 0)

test('blueprint budget: ninth 60 KB add is refused, its entity removed, and the world snapshot still writes', () => {
  const f = fixture()
  for (let i = 0; i < 9; i++) f.send('blueprintAdded', largeBlueprint(`bp${i}`))
  assert.equal(f.world.blueprints.items.size, 8)
  assert.equal(f.world.blueprints.bytes, totalBytes(f.world.blueprints))
  assert.ok(f.world.blueprints.bytes <= WORLD_BLUEPRINT_BYTES)
  f.send('entityAdded', app('refused', 'bp8'))
  assert.deepEqual(f.packets(f.author), [['onEntityRemoved', 'refused']])
  assert.equal(f.world.entities.get('refused'), undefined)
  f.send('blueprintAdded', largeBlueprint('bp9'))
  assert.equal(f.logs.filter(line => line.includes('world blueprint budget')).length, 1)
  const ws = fakeWs()
  assert.equal(
    f.network.write(ws, writePacket('snapshot', { blueprints: f.world.blueprints.serialize() }), { snapshot: true }),
    true
  )
  assert.equal(readPacket(ws.packets[0])[1].blueprints.length, 8)
  assert.equal(ws.terminations, 0)
})

test('blueprint budget: modifications measure the merged blueprint and share the rate-limited revert path', t => {
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const f = fixture()
  for (let i = 0; i < 8; i++) f.world.blueprints.add(largeBlueprint(`bp${i}`))
  f.world.blueprints.add(largeBlueprint('bp8', 40000))
  const original = f.world.blueprints.get('bp8')
  const before = f.world.blueprints.bytes
  for (let i = 0; i < 2; i++)
    f.send('blueprintModified', { id: 'bp8', version: 1, props: { notes: 'n'.repeat(60000) } })
  assert.equal(f.world.blueprints.get('bp8'), original)
  assert.equal(f.world.blueprints.bytes, before)
  assert.deepEqual(f.packets(f.author), [['onBlueprintModified', original]])
  assert.equal(f.packets().length, 0)
  assert.equal(f.network.dirtyBlueprints.size, 0)
  assert.equal(f.logs.length, 1)
  now = 1000
  f.send('blueprintModified', { id: 'bp8', version: 1, props: { notes: 'n'.repeat(60000) } })
  assert.equal(f.packets(f.author).length, 2)
  f.send('blueprintModified', { id: 'bp8', version: 1, props: {} })
  assert.ok(f.world.blueprints.bytes < before)
  assert.equal(f.world.blueprints.bytes, totalBytes(f.world.blueprints))
  f.send('blueprintAdded', largeBlueprint('bp8', 30000))
  assert.equal(f.world.blueprints.bytes, totalBytes(f.world.blueprints), 'replacement add subtracts the old size')
  f.world.blueprints.destroy()
  assert.equal(f.world.blueprints.bytes, 0)
  assert.equal(f.world.blueprints.sizes.size, 0)
})

test('blueprint budget: over-budget startup loads and warns, then allows only non-growing changes', async t => {
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  const f = fixture()
  const rows = Array.from({ length: 9 }, (_, i) => ({ data: JSON.stringify(largeBlueprint(`bp${i}`)) }))
  f.network.db = table =>
    table === 'config' ? { where: () => ({ first: async () => undefined }) } : table === 'blueprints' ? rows : []
  f.world.settings = { deserialize() {}, setHasAdminCode() {}, on() {} }
  await f.network.start()
  assert.equal(f.world.blueprints.items.size, 9)
  assert.equal(f.world.blueprints.bytes, totalBytes(f.world.blueprints))
  assert.ok(f.world.blueprints.bytes > WORLD_BLUEPRINT_BYTES)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /world blueprint budget exceeded at startup/)
  const before = f.world.blueprints.bytes
  f.send('blueprintAdded', { id: 'new', version: 0 })
  f.send('blueprintModified', { id: 'bp0', version: 1, name: 'growth' })
  assert.equal(f.world.blueprints.bytes, before)
  f.send('blueprintModified', { id: 'bp0', version: 1, props: { notes: 'n'.repeat(59000) } })
  assert.ok(f.world.blueprints.bytes < before && f.world.blueprints.bytes > WORLD_BLUEPRINT_BYTES)
  f.send('blueprintAdded', largeBlueprint('bp1', 59000))
  assert.equal(f.world.blueprints.get('bp1').props.notes.length, 59000)
  assert.equal(f.world.blueprints.bytes, totalBytes(f.world.blueprints))
})

test('announce before apply: blueprint broadcast precedes the synchronous rebuild event and preserves author', () => {
  const f = fixture()
  f.world.blueprints.add({ id: 'bp', version: 0 })
  f.world.entities.items.set('app', {
    data: { blueprint: 'bp' },
    build() {
      assert.deepEqual(f.packets(), [['onBlueprintModified', { id: 'bp', version: 1 }]])
      assert.deepEqual(f.world.blueprints.authors.get('bp'), { version: 1, socketId: f.author.id })
      f.network.send('entityEvent', ['app', 1, 'init', {}])
    },
  })
  f.send('blueprintModified', { id: 'bp', version: 1 })
  assert.deepEqual(
    f.packets().map(([name]) => name),
    ['onBlueprintModified', 'onEntityEvent']
  )
  assert.deepEqual(f.logs, [])
})

test('announce before apply: app entity modification precedes its synchronous rebuild event', () => {
  const f = fixture()
  f.world.blueprints.add({ id: 'bp', version: 0 })
  f.world.entities.items.set('app', {
    isApp: true,
    data: { id: 'app' },
    modify(safe) {
      assert.deepEqual(f.packets(), [['onEntityModified', safe]])
      f.network.send('entityEvent', ['app', 0, 'init', {}])
    },
  })
  f.send('entityModified', { id: 'app', blueprint: 'bp', unknown: 'dropped' })
  assert.deepEqual(f.packets(), [
    ['onEntityModified', { id: 'app', blueprint: 'bp' }],
    ['onEntityEvent', ['app', 0, 'init', {}]],
  ])
  assert.deepEqual([...f.network.dirtyApps.keys()], ['app'])
  assert.deepEqual(f.logs, [])
})

test('announce before apply: app entity addition precedes its synchronous init event', () => {
  const f = fixture()
  f.world.blueprints.add({ id: 'bp', version: 0 })
  f.world.entities.add = safe => {
    assert.deepEqual(f.packets(), [['onEntityAdded', safe]])
    f.network.send('entityEvent', [safe.id, 0, 'init', {}])
    return { data: safe }
  }
  const data = app('app', 'bp')
  f.send('entityAdded', { ...data, unknown: 'dropped' })
  assert.deepEqual(f.packets(), [
    ['onEntityAdded', data],
    ['onEntityEvent', ['app', 0, 'init', {}]],
  ])
  assert.deepEqual([...f.network.dirtyApps.keys()], ['app'])
  assert.deepEqual(f.logs, [])
})
