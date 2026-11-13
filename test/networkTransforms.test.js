import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogOnce } from '../src/core/extras/logOnce.js'
import { readPacket } from '../src/core/packets.js'
import { fakeWs, inside, loadNetwork, makeNetwork } from './lib/network.mjs'
import { loadClient } from './lib/clientHarness.mjs'

const Player = loadClient('core/entities/PlayerRemote.js', 'PlayerRemote')
const App = loadClient('core/entities/App.js', 'App', { createLogOnce })
const defaultPose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
const poseOf = data => ({ position: data.position, quaternion: data.quaternion })
// (the old harness's network saved nothing on a timer; a join's session token and new ids are the test's)
const UTILS = 'src/core/utils.js'
const SESSION = 'src/core/utils-server.js'
const net = await loadNetwork({ env: { SAVE_INTERVAL: 0 }, standIns: [UTILS, SESSION] })

function fixture(t, spawnRow) {
  const logs = []
  const saved = []
  const entities = new Map()
  const db = table => {
    if (table === 'blueprints' || table === 'entities') return []
    return {
      where: (_key, value) => ({ first: async () => (value === 'spawn' ? spawnRow : undefined) }),
      // the user ids start() reads: none (the old harness's network logged elsewhere that it could not read them)
      select: async () => [],
      insert: row => {
        if (table === 'users') return Promise.resolve()
        return { onConflict: () => ({ merge: async () => saved.push(row) }) }
      },
    }
  }
  let nextId = 0
  const network = makeNetwork(t, {
    net,
    log: line => logs.push(line),
    init: { db },
    modules: {
      [SESSION]: { readJWT: async () => null, createJWT: async () => 'token', expiredSessionUser: async () => null },
      [UTILS]: { uuid: () => `player-${++nextId}` },
    },
  })
  const serial = { serialize: () => [] }
  Object.assign(network.world, {
    settings: { ...serial, deserialize() {}, setHasAdminCode() {}, on() {} },
    blueprints: { ...serial, bytes: 0, get: id => (id === 'bp' ? { id } : undefined) },
    livekit: serial,
    collections: serial,
    chat: serial,
    ai: serial,
    events: { emit() {} },
    entities: {
      get: id => entities.get(id),
      serialize: () => [...entities.values()].map(entity => entity.data),
      // the join-state budget is not under test here (blueprintEnforcement.test.js)
      canFitApp: () => true,
      measureApp() {},
      trackApp() {},
      add(data) {
        // (a copy, from when onConnection ran in a VM; policies and entity data share one realm, as in production)
        data = { ...data }
        const entity = {
          data,
          isPlayer: data.type === 'player',
          isApp: data.type === 'app',
          isBuilder: () => data.rank >= 1,
          modify: data.type === 'player' ? Player.prototype.modify : App.prototype.modify,
          position: { push() {} },
          quaternion: { push() {} },
          teleport: 0,
          networkPos: { pushArray() {} },
          networkQuat: { pushArray() {} },
          networkSca: { pushArray() {} },
          build() {},
        }
        entities.set(data.id, entity)
        return entity
      },
    },
  })
  const join = async () => {
    const ws = fakeWs()
    // (a join that fails closes inside onConnection's catch: inside() reports it at the end of the test as well)
    ws.close = () => inside(t, () => assert.fail('join unexpectedly failed'))
    await network.onConnection(ws, {})
    ws.drain()
    const [method, snapshot] = readPacket(ws.packets[0])
    assert.equal(method, 'onSnapshot')
    return { ws, snapshot, socket: network.sockets.get(snapshot.id) }
  }
  return { network, logs, saved, entities, join }
}

test('spawn load: malformed JSON and invalid stored poses fall back once; joins and late joins receive default pose', async t => {
  for (const value of [
    '',
    '{',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...defaultPose, position: [1e300, 0, 0] }),
    JSON.stringify({ ...defaultPose, quaternion: [1e200, 0, 0, 1] }),
    '{"position":[1e309,0,0],"quaternion":[0,0,0,1]}',
  ]) {
    const f = fixture(t, { value })
    await f.network.start()
    await f.network.start()
    assert.deepEqual(f.network.spawn, defaultPose)
    assert.equal(f.logs.length, 1)
    assert.match(f.logs[0], /invalid stored spawn; using default spawn/)
    for (let i = 0; i < 2; i++) {
      const { snapshot, socket } = await f.join()
      assert.deepEqual(poseOf(socket.player.data), defaultPose)
      for (const data of snapshot.entities) assert.deepEqual(poseOf(data), defaultPose)
    }
    assert.equal(f.saved.length, 0)
  }
})

test('spawn load: absent spawn defaults silently and accepted stored quaternion drift is normalized before join', async t => {
  for (const spawnRow of [
    undefined,
    {
      value: JSON.stringify({ position: [-1e6, 0, 1e6], quaternion: [0, 0, 0, 1.0000001] }),
    },
  ]) {
    const f = fixture(t, spawnRow)
    await f.network.start()
    const expected = spawnRow ? { position: [-1e6, 0, 1e6], quaternion: [0, 0, 0, 1] } : defaultPose
    assert.deepEqual(f.network.spawn, expected)
    assert.deepEqual(f.logs, [])
    const { snapshot } = await f.join()
    assert.deepEqual(poseOf(snapshot.entities[0]), expected)
  }
})

test('spawn setter: retains builder authorization, refuses invalid poses with a message, normalizes and persists valid sets', async t => {
  const f = fixture(t)
  await f.network.start()
  const { socket, ws } = await f.join()
  const previous = f.network.spawn
  for (const op of ['set', 'clear']) await f.network.onSpawnModified(socket, op)
  assert.equal(f.network.spawn, previous)
  assert.equal(f.saved.length, 0)
  socket.player.data.rank = 1
  for (const invalid of [
    { position: [1e300, 0, 0], quaternion: [0, 0, 0, 1] },
    { position: [0, 0, 0], quaternion: [0, 0, 0, 0] },
  ]) {
    Object.assign(socket.player.data, invalid)
    await f.network.onSpawnModified(socket, 'set')
    assert.equal(f.network.spawn, previous)
    assert.equal(f.saved.length, 0)
    assert.match(readPacket(ws.packets.at(-1))[1].body, /Spawn not updated: invalid player transform/)
  }
  Object.assign(socket.player.data, { position: [1, 2, 3], quaternion: [0, 0, 0, 1.0000001] })
  await f.network.onSpawnModified(socket, 'set')
  const expected = { position: [1, 2, 3], quaternion: [0, 0, 0, 1] }
  assert.deepEqual(f.network.spawn, expected)
  assert.deepEqual(JSON.parse(f.saved[0].value), expected)
  assert.notEqual(f.network.spawn.position, socket.player.data.position)
  assert.notEqual(f.network.spawn.quaternion, socket.player.data.quaternion)
  assert.equal(readPacket(ws.packets.at(-1))[1].body, 'Spawn updated')
  await f.network.onSpawnModified(socket, 'clear')
  assert.deepEqual(JSON.parse(f.saved[1].value), defaultPose)
  assert.equal(readPacket(ws.packets.at(-1))[1].body, 'Spawn cleared')
})

test('entity transforms: server storage, observer broadcasts and late joins share normalized poses and release-only state', async t => {
  const f = fixture(t)
  await f.network.start()
  const { socket: author } = await f.join()
  const { ws: observer } = await f.join()
  const position = [2, 3, 4]
  await f.network.onEntityModified(author, { id: author.id, p: position, q: [0, 0, 0, 1.0000001] })
  // (the others are told at the end of the tick's flush; this handler was called outside one)
  f.network.flushPending()
  const expected = { position, quaternion: [0, 0, 0, 1] }
  assert.deepEqual(poseOf(author.player.data), expected)
  assert.notEqual(author.player.data.position, position)
  assert.deepEqual(readPacket(observer.packets.at(-1)), [
    'onEntityModified',
    {
      id: author.id,
      p: position,
      q: [0, 0, 0, 1],
    },
  ])
  await f.network.onEntityModified(author, { id: author.id, p: [1e300, 0, 0], q: [1e200, 0, 0, 1], t: true })
  f.network.flushPending()
  assert.deepEqual(poseOf(author.player.data), expected)
  assert.deepEqual(readPacket(observer.packets.at(-1)), ['onEntityModified', { id: author.id, t: true }])
  author.player.data.rank = 1
  f.network.onEntityAdded(author, {
    id: 'app',
    type: 'app',
    blueprint: 'bp',
    position,
    quaternion: [0, 0, 0, 1.0000001],
    scale: [1e-9, 2, 3],
  })
  const app = f.entities.get('app')
  assert.deepEqual(poseOf(app.data), expected)
  await f.network.onEntityModified(author, {
    id: 'app',
    mover: author.id,
    position: [5, 6, 7],
    quaternion: [0, 0, 0, 1.0000001],
    scale: [2, 2, 2],
  })
  const retained = structuredClone(app.data)
  author.player.data.rank = 0
  await f.network.onEntityModified(author, {
    id: 'app',
    mover: null,
    position: [99, 99, 99],
    quaternion: [1e200, 0, 0, 1],
    scale: [0, 1, 1],
    state: { bad: true },
  })
  assert.deepEqual(app.data, { ...retained, mover: null })
  assert.deepEqual(readPacket(observer.packets.at(-1)), ['onEntityModified', { id: 'app', mover: null }])
  const { snapshot } = await f.join()
  assert.deepEqual(poseOf(snapshot.entities.find(data => data.id === author.id)), expected)
  assert.deepEqual(
    snapshot.entities.find(data => data.id === 'app'),
    { ...retained, mover: null }
  )
  author.player.data.rank = 1
  await f.network.onEntityModified(author, { id: 'app', position: [8, 9, 10] })
  assert.deepEqual(app.data.position, [8, 9, 10])
})
