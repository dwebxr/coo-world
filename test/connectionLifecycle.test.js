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

// `lapsed`: the user row of a genuine token that is past its end ({ id, rank }), for a connection whose token no
// longer signs anyone in
function fixture({ pause, fail, existing = false, auth = { userId: 'player' }, lapsed = null } = {}) {
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
        if (lapsed && id === lapsed.id) return { first: () => step('lapsed lookup', lapsed) }
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
      items: players,
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
      // the snapshot is made before the player is added, so a failure here leaves no player to clean up
      serialize() {
        if (fail === 'snapshot') throw failure
        return [...players.values()].map(player => player.data)
      },
    },
    events: {
      emit(name, data) {
        assert.equal(name, 'enter')
        assert.ok(Object.isFrozen(data), 'the enter payload every app sees is frozen')
        assert.ok(network.sockets.has(data.playerId), 'socket is registered before enter')
        // 'cleanup': a failure after the player was added, whose clean-up throws too
        if (fail === 'enter' || fail === 'cleanup') throw failure
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
    expiredSessionUser: () => step('expiredSessionUser', lapsed?.id ?? null),
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
    assert.equal(f.added.length, fail === 'add-before' || fail === 'snapshot' ? 0 : 1)
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

test('onConnection: a second connection while the first is still connecting is refused', async () => {
  const f = fixture({ existing: true, pause: 'livekit' })
  const running = f.run()
  const value = await f.reached.promise
  const ws = f.peer()
  await f.run({ authToken: 'token' }, ws)
  assert.deepEqual(readPacket(ws.packets[0]), ['onKick', 'duplicate_user'])
  assert.ok(f.network.writer.state(ws).queued > 0)
  assert.equal(f.network.connecting.size, 1)
  assert.equal(f.network.sockets.size, 0)
  ws.finishClose()
  assert.equal(f.limits.stats().active, 1)
  f.pending.resolve(value)
  await running
  f.ws.finishClose()
  assert.equal(f.limits.stats().active, 0)
})

test('onConnection: a registered player whose connection answers a ping keeps it; the newcomer is refused', async () => {
  const f = fixture({ existing: true })
  f.network.takeoverPingMs = 1000
  await f.run()
  const first = f.network.sockets.get('player')
  const ws = f.peer()
  const second = f.run({ authToken: 'token' }, ws)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.network.connecting.size, 1, 'the id is reserved while the old connection is asked')
  // a third one meanwhile is refused at once
  const third = f.peer()
  await f.run({ authToken: 'token' }, third)
  assert.deepEqual(readPacket(third.packets[0]), ['onKick', 'duplicate_user'])
  f.ws.emit('pong')
  await second
  assert.deepEqual(readPacket(ws.packets[0]), ['onKick', 'duplicate_user'])
  assert.ok(f.network.writer.state(ws).queued > 0)
  assert.equal(f.network.sockets.get('player'), first, 'the live connection stays')
  assert.equal(f.ws.terminations, 0)
  assert.equal(f.network.connecting.size, 0)
  ws.finishClose()
  third.finishClose()
  f.ws.finishClose()
  assert.equal(f.limits.stats().active, 0)
})

test('onConnection: a registered player whose connection is silent (a suspended phone tab) gives way', async () => {
  const f = fixture({ existing: true })
  f.network.takeoverPingMs = 20
  await f.run()
  const first = f.network.sockets.get('player')
  const firstPlayer = f.players.get('player')
  const ws = f.peer()
  await f.run({ authToken: 'token' }, ws)
  assert.equal(f.ws.terminations, 1, 'the stale connection is closed')
  assert.equal(firstPlayer.destroyed, true, 'its player left before the new one joined')
  assert.equal(first.disconnected, true)
  const socket = f.network.sockets.get('player')
  assert.ok(socket && socket !== first)
  assert.equal(socket.ws, ws)
  assert.equal(readPacket(ws.packets[0])[0], 'onSnapshot')
  assert.deepEqual(f.entered, ['player', 'player'])
  assert.equal(f.network.connecting.size, 0)
  ws.finishClose()
  f.ws.finishClose()
  assert.equal(f.network.sockets.size, 0)
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
  // only the token is read (is this a player already here?), never the database
  assert.deepEqual(f.calls, ['readJWT'])
  assert.equal(f.network.sockets.get('other'), other)
  f.ws.finishClose()
  assert.equal(f.limits.stats().active, 0)
  // no token at all: refused without reading anything
  const g = fixture()
  g.network.world.settings.playerLimit = 1
  g.network.sockets.set('other', {})
  await g.run({})
  assert.deepEqual(readPacket(g.ws.packets[0]), ['onKick', 'player_limit'])
  assert.deepEqual(g.calls, [])
  g.ws.finishClose()
})

test('onConnection: in a full world, a player whose old connection went silent can still come back', async () => {
  const f = fixture({ existing: true })
  f.network.takeoverPingMs = 20
  f.network.world.settings.playerLimit = 1
  await f.run()
  const first = f.network.sockets.get('player')
  const ws = f.peer()
  await f.run({ authToken: 'token' }, ws)
  assert.equal(readPacket(ws.packets[0])[0], 'onSnapshot')
  assert.equal(first.disconnected, true)
  assert.notEqual(f.network.sockets.get('player'), first)
  ws.finishClose()
  f.ws.finishClose()
})

test('onConnection: a newcomer that closes while the old connection is asked frees the id at once', async () => {
  const f = fixture({ existing: true })
  // long enough that only an early end (not the deadline) can finish the wait within the check below
  f.network.takeoverPingMs = 3000
  await f.run()
  const first = f.network.sockets.get('player')
  const ws = f.peer()
  const second = f.run({ authToken: 'token' }, ws)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.network.connecting.size, 1)
  assert.ok(first.probing)
  ws.finishClose()
  const outcome = await Promise.race([
    second.then(() => 'ended'),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 500)),
  ])
  assert.equal(outcome, 'ended', 'the wait ends with the newcomer')
  assert.equal(f.network.connecting.size, 0, 'no minute-long reservation for a closed newcomer')
  // the ping may still be queued: the regular check keeps leaving the socket alone until the probe's deadline
  assert.ok(first.probing, 'still marked')
  assert.equal(f.network.sockets.get('player'), first, 'nothing replaced')
  // the next reload asks again (and here the old one answers)
  const retry = f.peer()
  const third = f.run({ authToken: 'token' }, retry)
  await new Promise(resolve => setImmediate(resolve))
  f.ws.emit('pong')
  await third
  assert.deepEqual(readPacket(retry.packets[0]), ['onKick', 'duplicate_user'])
  assert.ok(first.probing, 'marked until its deadline, answered or not (its ping may still be queued)')
  retry.finishClose()
  f.ws.finishClose()
})

// (What a join gets when its user's rank, name or avatar changed while it was being set up, the takeover included,
// is in test/userRowsNetwork.test.js, through the handlers that make those changes.)

test('answersPing: the mark stays until its own deadline, and a later probe keeps its own', async () => {
  const f = fixture({ existing: true })
  await f.run()
  const socket = f.network.sockets.get('player')
  const answered = f.network.answersPing(socket, 40)
  f.ws.emit('pong')
  assert.equal(await answered, true)
  const firstMark = socket.probing
  assert.ok(firstMark, 'answered, still marked')
  await new Promise(resolve => setTimeout(resolve, 20))
  const second = f.network.answersPing(socket, 200)
  const secondMark = socket.probing
  assert.notEqual(secondMark, firstMark)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(socket.probing, secondMark, "the first probe's deadline does not clear the second's mark")
  f.ws.emit('pong')
  await second
  await new Promise(resolve => setTimeout(resolve, 220))
  assert.equal(socket.probing, null)
  f.ws.finishClose()
})

test('playersPresent: a user counts once, registered or joining, and a join of no known user counts on its own', () => {
  const f = fixture()
  f.network.sockets.set('player', {})
  f.network.sockets.set('other', {})
  assert.equal(f.network.playersPresent(), 2)
  // two joins of `player` (a reload, and its replacement of the old connection)
  f.network.joining = new Map([['player', 2]])
  assert.equal(f.network.playersPresent(), 2, 'old connection still registered: not counted twice')
  f.network.sockets.delete('player')
  assert.equal(f.network.playersPresent(), 2, 'old connection gone: its place is kept')
  f.network.joining.delete('player')
  assert.equal(f.network.playersPresent(), 1)
  f.network.arriving = 2
  assert.equal(f.network.playersPresent(), 3)
})

// the replacement's last wait (the voice token), held after the old connection has been closed
const holdVoice = f => {
  const hold = { asked: false }
  const held = new Promise(resolve => (hold.release = resolve))
  f.network.world.livekit.serialize = async () => {
    hold.asked = true
    await held
    return {}
  }
  hold.reached = async () => {
    for (let i = 0; i < 50 && !hold.asked; i++) await new Promise(resolve => setTimeout(resolve, 5))
  }
  return hold
}

test('onConnection: in a full world, nobody else can take the place of a player being replaced', async () => {
  const f = fixture({ existing: true })
  f.network.takeoverPingMs = 20
  f.network.world.settings.playerLimit = 1
  await f.run()
  const voice = holdVoice(f)
  const ws = f.peer()
  const replacement = f.run({ authToken: 'token' }, ws)
  await voice.reached()
  assert.equal(voice.asked, true, 'the replacement is at its last wait')
  assert.equal(f.network.sockets.size, 0, 'the old connection is gone')
  const stranger = f.peer()
  await f.run({}, stranger)
  assert.deepEqual(readPacket(stranger.packets[0]), ['onKick', 'player_limit'], 'the place is kept')
  voice.release()
  await replacement
  assert.equal(readPacket(ws.packets[0])[0], 'onSnapshot')
  assert.equal(f.network.sockets.size, 1)
  assert.equal(f.network.joining.size, 0)
  assert.equal(f.calls.filter(call => call === 'lookup').length, 2, 'the user is read once for each of its joins')
  stranger.finishClose()
  ws.finishClose()
  f.ws.finishClose()
})

test('onConnection: a replacement that closes during its last wait gives back the place and the id at once', async () => {
  const f = fixture({ existing: true })
  f.network.takeoverPingMs = 20
  f.network.world.settings.playerLimit = 1
  await f.run()
  const serialize = f.network.world.livekit.serialize
  // does not answer until the end of the test
  const voice = holdVoice(f)
  const ws = f.peer()
  const replacement = f.run({ authToken: 'token' }, ws)
  await voice.reached()
  assert.equal(voice.asked, true, 'the replacement is at its last wait')
  assert.equal(f.network.sockets.size, 0, 'the old connection is gone')
  ws.finishClose()
  assert.equal(f.network.playersPresent(), 0, 'its place is free')
  assert.equal(f.network.connecting.size, 0, 'and its user id')
  // the player again: neither refused as a duplicate of the closed join nor for want of a place
  f.network.world.livekit.serialize = serialize
  const again = f.peer()
  await f.run({ authToken: 'token' }, again)
  assert.equal(readPacket(again.packets[0])[0], 'onSnapshot')
  const current = f.network.sockets.get('player')
  voice.release()
  await replacement
  assert.deepEqual(ws.packets, [])
  assert.equal(f.network.sockets.get('player'), current, 'the closed join registers nothing')
  assert.equal(f.network.playersPresent(), 1)
  assert.equal(f.network.joining.size, 0)
  assert.equal(f.network.connecting.size, 0)
  again.finishClose()
  f.ws.finishClose()
})

test('checkSockets: a connection being asked by a takeover is left to it', () => {
  const f = fixture()
  const terminated = []
  const probing = { probing: true, pingPending: true, alive: false, disconnect: () => terminated.push('probing') }
  const stale = { probing: false, pingPending: true, alive: false, disconnect: () => terminated.push('stale') }
  f.network.sockets.set('a', probing)
  f.network.sockets.set('b', stale)
  f.network.checkSockets()
  assert.deepEqual(terminated, ['stale'])
})

test('onConnection: a refused snapshot write cleans up the player before transport close', async () => {
  const f = fixture()
  f.network.write = () => false
  await f.run()
  assert.equal(f.destroyed.length, 1)
  assert.equal(f.players.size, 0)
  assert.equal(f.network.sockets.size, 0)
  assert.equal(f.network.connecting.size, 0)
  assert.deepEqual(f.ws.packets, [])
  assert.deepEqual(f.ws.closeCodes, [1011])
  assert.deepEqual(f.logs, ['onConnection: snapshot write failed'])
  f.ws.finishClose()
  assert.equal(f.limits.stats().active, 0)
})

test('onConnection: a snapshot over its cap is refused before any player is added (player_limit kick)', async () => {
  const f = fixture()
  // over the cap in what it sends, not in what is counted (a world stored before the budget): the visitor passes
  // the headroom rule and the real size refuses it
  f.network.world.blueprints = { serialize: () => 'x'.repeat(SNAPSHOT_CAP) }
  await f.run()
  assert.equal(f.added.length, 0)
  assert.equal(f.players.size, 0)
  assert.equal(f.network.sockets.size, 0)
  assert.equal(f.network.connecting.size, 0)
  f.ws.drain()
  assert.deepEqual(
    f.ws.packets.map(packet => readPacket(packet)),
    [['onKick', 'player_limit']]
  )
  assert.deepEqual(f.ws.closeCodes, [undefined])
  assert.equal(f.logs.length, 1)
  assert.match(f.logs[0], /^\[network\] a player was turned away: the join snapshot is \d+ bytes after every step/)
  f.ws.finishClose()
  assert.equal(f.limits.stats().active, 0)
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

test('onConnection: a token due for renewal is replaced in the snapshot, for the same user; a fresh one is kept', async () => {
  for (const renew of [true, false]) {
    const f = fixture({ existing: true, auth: { userId: 'player', renew } })
    await f.run()
    const [, snapshot] = readPacket(f.ws.packets[0])
    assert.equal(snapshot.id, 'player')
    assert.equal(snapshot.authToken, renew ? 'new-token' : 'token')
    assert.equal(f.calls.includes('createJWT'), renew)
    assert.equal(f.inserted.length, 0, 'no new user is made')
    f.ws.finishClose()
  }
  // a token to renew whose user row is gone signs nobody in: a new user, with that user's own new token
  const f = fixture({ existing: false, auth: { userId: 'player', renew: true } })
  await f.run()
  assert.equal(f.inserted.length, 1)
  assert.equal(f.calls.filter(call => call === 'createJWT').length, 1)
  f.ws.finishClose()
})

test('onConnection: a session that ended unused starts a new visitor, and says so when its user had a rank', async () => {
  for (const [rank, said] of [
    [2, true],
    [1, true],
    [0, false],
  ]) {
    const f = fixture({ auth: null, lapsed: { id: 'gone-admin\nforged', rank } })
    await f.run({ authToken: 'expired-token' })
    const warnings = f.logs
    assert.equal(f.inserted.length, 1, 'a new anonymous user')
    assert.equal(f.inserted[0].rank, 0, 'without the old rank')
    assert.equal(warnings.length, said ? 1 : 0, `rank ${rank}`)
    if (said) {
      assert.match(warnings[0], /^\[auth\] the session of a ranked user ended unused: "gone-admin\?forged" \(rank \d\)/)
      assert.ok(!warnings[0].includes('expired-token'), 'the token is not logged')
    }
    f.ws.finishClose()
  }
  // the same expired token presented again and again is said once
  const again = fixture({ auth: null, lapsed: { id: 'gone-admin', rank: 2 } })
  await again.run({ authToken: 'expired-token' })
  again.ws.finishClose()
  for (let i = 0; i < 3; i++) {
    const ws = again.peer()
    await again.run({ authToken: 'expired-token' }, ws)
    ws.finishClose()
  }
  assert.equal(again.logs.filter(line => line.startsWith('[auth] the session of a ranked user')).length, 1)
  // a token that is simply not genuine is not looked up at all
  const f = fixture({ auth: null })
  await f.run({ authToken: 'forged' })
  assert.ok(!f.calls.includes('lapsed lookup'))
  f.ws.finishClose()
})
