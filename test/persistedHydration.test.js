import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { writePacket, readPacket } from '../src/core/packets.js'
import { load, appData } from './lib/persistenceHarness.mjs'

const policyUrl = process.env.REAL_PHYSX_SOURCE_ROOT
  ? pathToFileURL(path.join(process.env.REAL_PHYSX_SOURCE_ROOT, 'src/core/extras/entityModifyPolicy.js'))
  : new URL('../src/core/extras/entityModifyPolicy.js', import.meta.url)
const policy = await import(policyUrl)
const options = { blueprintExists: id => id === 'bp' }
const Blueprints = load('core/systems/Blueprints.js', 'Blueprints', { writePacket })
const Network = load('core/systems/ServerNetwork.js', 'ServerNetwork', { writePacket })

function fixture(t, blueprints = [], entities = [], extra = {}) {
  const world = {
    settings: { deserialize() {}, setHasAdminCode() {}, on() {} },
    entities: {
      items: new Map(),
      add(data) {
        this.items.set(data.id, { data })
      },
    },
  }
  world.network = new Network(world)
  world.network.send = () => {}
  world.blueprints = new Blueprints(world)
  Object.assign(world, extra)
  const rows = { blueprints, entities }
  world.network.db = table => (table === 'config' ? { where: () => ({ first: async () => undefined }) } : rows[table])
  t.after(() => world.network.stopForFatal())
  const logs = []
  t.mock.method(console, 'log', line => logs.push(line))
  return { world, logs }
}

const row = data => ({ id: data.id, data: JSON.stringify(data) })

test('persisted apps: clamp position and normalize quaternions without narrowing valid scale', () => {
  assert.equal(typeof policy.sanitizePersistedApp, 'function')
  assert.equal(typeof policy.appScale, 'function')
  for (const quaternion of [
    [0, 0, 0, 2],
    [1e308, 1e308, 0, 0],
    [1e-320, 0, 0, 0],
  ]) {
    const data = { ...appData(), position: [1e300, -1e300, 7], quaternion, scale: [-1e-9, 1e-40, 3e38] }
    const before = structuredClone(data)
    const result = policy.sanitizePersistedApp(data, options)
    assert.deepEqual(result.data.position, [policy.TRANSFORM_LIMIT, -policy.TRANSFORM_LIMIT, 7])
    assert.ok(Math.abs(Math.hypot(...result.data.quaternion) - 1) < 1e-14)
    assert.deepEqual(result.data.scale, data.scale)
    assert.deepEqual(result.repaired, ['position', 'quaternion'])
    assert.deepEqual(data, before)
    assert.notEqual(result.data.scale, data.scale)
  }
  const good = policy.sanitizePersistedApp(appData(), options)
  assert.deepEqual(good.repaired, [])
})

test('persisted apps: invalid transform shapes reset safely and report the repaired fields', () => {
  assert.equal(typeof policy.sanitizePersistedApp, 'function')
  for (const value of [null, [], 'bad', [0, 0, 0, 0], [1, 2], [NaN, Infinity, 'x']]) {
    const result = policy.sanitizePersistedApp(
      { ...appData(), position: value, quaternion: value, scale: value },
      options
    )
    assert.ok(result)
    assert.equal(result.data.position.length, 3)
    assert.ok(result.data.position.every(Number.isFinite))
    assert.deepEqual(result.data.quaternion, [0, 0, 0, 1])
    assert.deepEqual(result.data.scale, [1, 1, 1])
    assert.deepEqual(result.repaired, ['position', 'quaternion', 'scale'])
  }
  const data = { ...appData(), position: [Infinity, -Infinity, 'x'], quaternion: [0, 0, 0, 1.01] }
  const result = policy.sanitizePersistedApp(data, options)
  assert.deepEqual(result.data.position, [1e6, -1e6, 0])
  assert.deepEqual(result.data.quaternion, [0, 0, 0, 1])
  assert.deepEqual(result.data.state, {})
})

test('persisted apps: unusable identity, type or blueprint skips the row', () => {
  assert.equal(typeof policy.sanitizePersistedApp, 'function')
  for (const data of [
    null,
    [],
    {},
    { ...appData(), id: '' },
    { ...appData(), id: 7 },
    { ...appData(), type: 'player' },
    { ...appData(), type: 'constructor' },
    { ...appData(), blueprint: 'missing' },
    { ...appData(), blueprint: null },
  ]) {
    assert.equal(policy.sanitizePersistedApp(data, options), null)
  }
})

for (const [name, bad] of [
  ['numeric preload model', row({ id: 'bad', version: 1, preload: true, model: 123, props: {} })],
  ['object script', row({ id: 'bad', version: 1, script: {} })],
  ['array image', row({ id: 'bad', version: 1, image: [] })],
  ['array props', row({ id: 'bad', version: 1, props: [] })],
  ['invalid version', row({ id: 'bad', version: -1 })],
  ['mismatched id', { id: 'bad', data: JSON.stringify({ id: 'other', version: 1 }) }],
  ['bad JSON', { id: 'bad', data: '{' }],
]) {
  test(`persisted blueprints: ${name} is skipped with no snapshot or registry entry`, async t => {
    const { world, logs } = fixture(t, [bad, row({ id: 'bp', version: 0 })], [row(appData())])
    await assert.doesNotReject(world.network.start())
    assert.deepEqual([...world.blueprints.items.keys()], ['bp'])
    const [, snapshot] = readPacket(writePacket('snapshot', { blueprints: world.blueprints.serialize() }))
    assert.deepEqual(snapshot.blueprints, [{ id: 'bp', version: 0 }])
    assert.equal(world.entities.items.size, 1)
    assert.equal(world.network.dirtyBlueprints.size, 0)
    assert.equal(world.network.dirtyApps.size, 0)
    assert.equal(logs.filter(line => line.startsWith('[network] hydration:')).length, 1)
    assert.match(logs[0], /skippedBlueprints=\["bad"\]/)
    assert.ok(!logs[0].includes('123'), 'summary contains metadata only')
  })
}

test('persisted blueprints: sanitized policy value strips unknown fields before hydration', async t => {
  const data = { id: 'bp', version: 0, model: null, props: null, oldField: 'private payload', name: 'x'.repeat(300) }
  const { world } = fixture(t, [row(data)])
  await world.network.start()
  assert.deepEqual(world.blueprints.get('bp'), {
    id: 'bp',
    version: 0,
    model: null,
    props: null,
    name: 'x'.repeat(256),
  })
  assert.equal(world.blueprints.bytes, writePacket('blueprintAdded', world.blueprints.get('bp')).length)
})

test('blueprint add: serialization failure leaves registry, size and author bookkeeping unchanged', () => {
  const blueprints = new Blueprints({ network: { isServer: true } })
  blueprints.add({ id: 'existing', version: 0 })
  blueprints.authors.set('existing', { version: 0, socketId: 'builder' })
  const before = {
    items: [...blueprints.items],
    sizes: [...blueprints.sizes],
    bytes: blueprints.bytes,
    authors: [...blueprints.authors],
  }
  for (const id of ['new', 'existing']) {
    const data = {
      id,
      version: 1,
      get props() {
        throw new Error('serialize failed')
      },
    }
    assert.throws(() => blueprints.add(data), /serialize failed/)
    assert.deepEqual(
      {
        items: [...blueprints.items],
        sizes: [...blueprints.sizes],
        bytes: blueprints.bytes,
        authors: [...blueprints.authors],
      },
      before
    )
  }
})

test('persisted apps: only hydrated blueprints qualify; row failures are isolated and remain clean', async t => {
  const rows = [
    { id: 'json', data: '{' },
    row({ ...appData(), id: 'wrong', type: 'unknown' }),
    row({ ...appData(), id: 'missing', blueprint: 'bad' }),
    { id: 'mismatch', data: JSON.stringify({ ...appData(), id: 'elsewhere' }) },
    row({ ...appData(), id: 'repair', position: [1e30, 2, 3], quaternion: [0, 0, 0, 2] }),
    row({ ...appData(), id: 'throws' }),
    row(appData()),
  ]
  const { world, logs } = fixture(t, [row({ id: 'bad', version: -1 }), row({ id: 'bp', version: 0 })], rows)
  const add = world.entities.add.bind(world.entities)
  world.entities.add = data => {
    if (data.id === 'throws') throw new Error('native-capable add failed')
    return add(data)
  }
  await assert.doesNotReject(world.network.start())
  assert.deepEqual([...world.entities.items.keys()], ['repair', 'app'])
  assert.deepEqual(world.entities.items.get('repair').data.position, [1e6, 2, 3])
  assert.deepEqual(world.entities.items.get('repair').data.quaternion, [0, 0, 0, 1])
  assert.equal(world.network.dirtyApps.size, 0)
  assert.match(logs[0], /repaired=1 skipped=6/)
  assert.match(logs[0], /"id":"repair","fields":\["position","quaternion"\]/)
})
