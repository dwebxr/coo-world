import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import vm from 'node:vm'
import moment from 'moment'
import { isAvatarUrl, sanitizeName } from '../src/core/extras/entityModifyPolicy.js'
import { SNAPSHOT_CAP } from '../src/core/extras/writeLedger.js'
import { readPacket } from '../src/core/packets.js'
import { createConnectionLimits, readConnectionLimitsEnv } from '../src/server/connectionLimits.js'
import { connectionMethod, fakeWs, loadRoute, makeNetwork } from './lib/networkHarness.mjs'

const source = fs.readFileSync(new URL('../src/core/systems/ServerNetwork.js', import.meta.url), 'utf8')
const disconnect = source.match(/^ {2}onDisconnect = [^]*?^ {2}}/m)?.[0]
assert.ok(disconnect)
const Disconnect = vm.runInNewContext(`(class { ${disconnect.replace(' = ', '').replace(' =>', '')} })`, {
  solanaGating: { clearSocket() {} },
})
const stages = ['readJWT', 'lookup', 'insert', 'createJWT', 'livekit']

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture({ pause, fail, existing = false, auth = { userId: 'player' } } = {}) {
  const logs = []
  const calls = []
  const players = new Map()
  const added = []
  const destroyed = []
  const entered = []
  const inserted = []
  const pending = deferred()
  const reached = deferred()
  const failure = { name: 'SetupError', message: 'setup failed', packet: 'must not be logged' }
  const step = (name, value) => {
    calls.push(name)
    if (name === pause) {
      reached.resolve(value)
      return pending.promise
    }
    return Promise.resolve(value)
  }
  const network = makeNetwork(line => logs.push(line))
  network.onDisconnect = Disconnect.prototype.onDisconnect
  network.connecting = new Set()
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  const user = { id: 'player', name: 'Saved', rank: 0 }
  network.db = table => {
    assert.equal(table, 'users')
    return {
      where(key, id) {
        assert.equal(key, 'id')
        assert.equal(id, user.id)
        return { first: () => step('lookup', existing ? user : undefined) }
      },
      insert(row) {
        inserted.push(row)
        return step('insert')
      },
    }
  }
  const serial = { serialize: () => [] }
  Object.assign(network.world, {
    settings: { ...serial, playerLimit: 0 },
    livekit: { serialize: () => step('livekit', {}), clearModifiers() {} },
    collections: serial,
    chat: serial,
    ai: serial,
    blueprints: serial,
    entities: {
      add(data) {
        if (fail === 'add-before') throw failure
        const player = {
          data,
          destroy(local) {
            assert.equal(local, true)
            assert.equal(this.destroyed, undefined, 'cleanup runs once, even when close follows a failure')
            this.destroyed = true
            destroyed.push(player)
            players.delete(data.id)
            if (fail === 'cleanup') throw failure
          },
        }
        added.push(player)
        players.set(data.id, player)
        if (fail === 'add-after') throw failure
        return player
      },
      get: id => players.get(id),
      serialize() {
        if (fail === 'snapshot' || fail === 'cleanup') throw failure
        return [...players.values()].map(player => player.data)
      },
    },
    events: {
      emit(name, data) {
        assert.equal(name, 'enter')
        assert.ok(network.sockets.has(data.playerId), 'socket is registered before enter')
        if (fail === 'enter') throw failure
        entered.push(data.playerId)
      },
    },
  })
  if (fail === 'write')
    network.write = () => {
      throw failure
    }
  network.onConnection = connectionMethod({
    isNumber: value => typeof value === 'number',
    sanitizeName,
    isAvatarUrl,
    readJWT: () => step('readJWT', auth),
    createJWT: () => step('createJWT', 'new-token'),
    uuid: () => user.id,
    moment,
    process: { env: {} },
    performance,
    HEALTH_MAX: 100,
  })
  const limits = createConnectionLimits({ ...readConnectionLimitsEnv({}), ratePerMin: 0 })
  const { preValidation } = loadRoute(limits, network)
  const peer = () => {
    const ws = fakeWs()
    const transport = new EventEmitter()
    ws.closeCodes = []
    ws.close = code => {
      ws.closeCodes.push(code)
      ws.readyState = 2
    }
    ws.finishClose = () => {
      ws.drain()
      ws.readyState = 3
      transport.emit('close')
      ws.emit('close', 1000)
    }
    const request = { ws: true, raw: { socket: transport }, headers: {}, ip: '127.0.0.1' }
    preValidation(request, {}, () => {})
    return ws
  }
  const ws = peer()
  const run = (params = { authToken: 'token' }, target = ws) => network.onConnection(target, params)
  return {
    network,
    ws,
    run,
    peer,
    limits,
    logs,
    calls,
    players,
    added,
    destroyed,
    entered,
    inserted,
    pending,
    reached,
    failure,
  }
}

for (const pause of stages) {
  test(`onConnection: close during ${pause} stops setup and releases the transport lease`, async () => {
    const f = fixture({ pause })
    const running = f.run()
    const value = await f.reached.promise
    assert.equal(f.ws.listenerCount('close'), 1, 'cancellation listener is installed before awaiting')
    assert.equal(f.limits.stats().active, 1)
    if (pause === 'livekit') assert.equal(f.network.connecting.size, 1)
    f.ws.finishClose()
    f.pending.resolve(value)
    await running
    assert.deepEqual(f.calls, stages.slice(0, stages.indexOf(pause) + 1))
    assert.equal(f.players.size, 0)
    assert.equal(f.added.length, 0)
    assert.equal(f.network.sockets.size, 0)
    assert.equal(f.network.connecting.size, 0)
    assert.equal(f.limits.stats().active, 0)
    assert.deepEqual(f.ws.packets, [])
    assert.deepEqual(f.ws.closeCodes, [])
    assert.deepEqual(f.entered, [])
  })

  test(`onConnection: rejection of ${pause} closes with 1011 and holds the lease until close`, async () => {
    const f = fixture({ pause })
    const running = f.run()
    await f.reached.promise
    f.pending.reject(f.failure)
    await running
    assert.deepEqual(f.calls, stages.slice(0, stages.indexOf(pause) + 1))
    assert.deepEqual(f.ws.closeCodes, [1011])
    assert.equal(f.players.size, 0)
    assert.equal(f.network.sockets.size, 0)
    assert.equal(f.network.connecting.size, 0)
    assert.equal(f.limits.stats().active, 1, 'close request does not release a TCP lease')
    assert.deepEqual(f.logs, ['onConnection: SetupError: setup failed'])
    f.ws.finishClose()
    assert.equal(f.limits.stats().active, 0)
  })
}

for (const fail of ['add-before', 'add-after', 'snapshot', 'write', 'enter', 'cleanup']) {
  test(`onConnection: ${fail} failure after users insert cleans up before closing`, async () => {
    const f = fixture({ fail })
    await f.run()
    assert.equal(f.inserted.length, 1)
    assert.equal(f.added.length, fail === 'add-before' ? 0 : 1)
    assert.equal(f.destroyed.length, f.added.length)
    assert.equal(f.players.size, 0)
    assert.equal(f.network.sockets.size, 0)
    assert.equal(f.network.connecting.size, 0)
    assert.deepEqual(f.ws.closeCodes, [1011])
    assert.equal(f.limits.stats().active, 1)
    assert.ok(f.logs.every(line => typeof line === 'string' && !line.includes('must not be logged')))
    f.ws.finishClose()
    assert.equal(f.limits.stats().active, 0)
    assert.equal(f.destroyed.length, f.added.length)
  })
}

test('onConnection: new and existing users receive a snapshot and disconnect normally', async () => {
  for (const existing of [false, true]) {
    const f = fixture({ existing })
    await f.run()
    const socket = f.network.sockets.get('player')
    assert.ok(socket)
    assert.equal(socket.player, f.players.get('player'))
    assert.equal(f.network.connecting.size, 0)
    assert.deepEqual(f.entered, ['player'])
    assert.equal(f.inserted.length, existing ? 0 : 1)
    assert.deepEqual(f.ws.closeCodes, [])
    const [method, snapshot] = readPacket(f.ws.packets[0])
    assert.equal(method, 'onSnapshot')
    assert.equal(snapshot.id, 'player')
    assert.equal(snapshot.authToken, existing ? 'token' : 'new-token')
    f.ws.finishClose()
    assert.equal(f.players.size, 0)
    assert.equal(f.network.sockets.size, 0)
    assert.equal(f.limits.stats().active, 0)
  }
})

test('onConnection: an invalid or absent JWT still creates an anonymous user', async () => {
  for (const params of [{ authToken: 'invalid' }, {}]) {
    const f = fixture({ auth: null })
    await f.run(params)
    assert.equal(f.inserted.length, 1)
    assert.ok(!f.calls.includes('lookup'))
    assert.equal(f.network.sockets.size, 1)
    f.ws.finishClose()
  }
})

test('onConnection: duplicate reservations and registered users kick through the writer', async () => {
  const f = fixture({ existing: true, pause: 'livekit' })
  const running = f.run()
  const value = await f.reached.promise
  for (const registered of [false, true]) {
    const ws = f.peer()
    await f.run({ authToken: 'token' }, ws)
    assert.deepEqual(readPacket(ws.packets[0]), ['onKick', 'duplicate_user'])
    assert.ok(f.network.writer.state(ws).queued > 0)
    assert.equal(f.network.connecting.size, registered ? 0 : 1)
    assert.equal(f.network.sockets.size, registered ? 1 : 0)
    ws.finishClose()
    assert.equal(f.limits.stats().active, 1)
    if (!registered) {
      f.pending.resolve(value)
      await running
    }
  }
  f.ws.finishClose()
  assert.equal(f.limits.stats().active, 0)
})

test('onConnection: player limit kicks through the writer before touching the database', async () => {
  const f = fixture()
  f.network.world.settings.playerLimit = 1
  const other = {}
  f.network.sockets.set('other', other)
  await f.run()
  assert.deepEqual(readPacket(f.ws.packets[0]), ['onKick', 'player_limit'])
  assert.ok(f.network.writer.state(f.ws).queued > 0)
  assert.deepEqual(f.calls, [])
  assert.equal(f.network.sockets.get('other'), other)
  f.ws.finishClose()
  assert.equal(f.limits.stats().active, 0)
})

test('onConnection: oversized and refused snapshots clean up the player before transport close', async () => {
  for (const oversized of [false, true]) {
    const f = fixture()
    if (oversized) f.network.world.blueprints.serialize = () => 'x'.repeat(SNAPSHOT_CAP)
    else f.network.write = () => false
    await f.run()
    assert.equal(f.destroyed.length, 1)
    assert.equal(f.players.size, 0)
    assert.equal(f.network.sockets.size, 0)
    assert.equal(f.network.connecting.size, 0)
    assert.deepEqual(f.ws.packets, [])
    assert.deepEqual(f.ws.closeCodes, [1011])
    assert.deepEqual(f.logs, [`onConnection: ${oversized ? 'snapshot too large' : 'snapshot write failed'}`])
    f.ws.finishClose()
    assert.equal(f.limits.stats().active, 0)
  }
})

test('onConnection: a snapshot near 900 KiB is the first write and completes a join', async () => {
  const f = fixture()
  f.network.world.blueprints = { serialize: () => [{ id: 'loaded', props: { text: 'x'.repeat(900 * 1024) } }] }
  await f.run()
  assert.equal(f.network.sockets.size, 1)
  assert.deepEqual(f.ws.closeCodes, [])
  assert.equal(f.ws.packets.length, 1)
  assert.ok(f.ws.packets[0].length > 900 * 1024)
  assert.ok(f.ws.packets[0].length <= SNAPSHOT_CAP)
  assert.equal(readPacket(f.ws.packets[0])[0], 'onSnapshot')
  f.ws.drain()
  assert.equal(f.network.writer.state(f.ws).queued, 0)
  f.ws.finishClose()
  assert.equal(f.limits.stats().active, 0)
})

test('onConnection: arbitrary thrown values are never inspected or stringified', async () => {
  const f = fixture({ pause: 'createJWT' })
  const running = f.run()
  await f.reached.promise
  const error = {
    get message() {
      return assert.fail('message getter')
    },
    toString() {
      assert.fail('toString')
    },
    toJSON() {
      assert.fail('toJSON')
    },
  }
  f.pending.reject(error)
  await running
  assert.deepEqual(f.logs, ['onConnection: error'])
  assert.deepEqual(f.ws.closeCodes, [1011])
  f.ws.finishClose()
})
