import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { writeClientPacket } from '../src/core/packets.js'
import { INBOX_SOCKET_CAP } from '../src/core/extras/inboundPolicy.js'
import { createEventLedger, createEventQueue } from '../src/core/extras/appEventQueue.js'
import { loadNetwork, makeNetwork } from './lib/network.mjs'

// Exercise the real receive/queue/flush methods without booting physics, the database or Solana: the real network
// (test/lib/network.mjs) and its own Socket, inbound gate and scheduler. `log` takes the gate's and the class's own
// once-per-subject lines (the constructor wires them to it)
const net = await loadNetwork()
const make = t => {
  const logs = []
  const network = makeNetwork(t, { net, log: line => logs.push(line) })
  const ws = new EventEmitter()
  const socket = new net.Socket({ id: 'test', ws, network, player: { isBuilder: () => true, destroy() {} } })
  return { network, ws, socket, logs }
}

test('Socket: admission precedes exact-size copy; flush passes bytes, nodes, socket and builder metadata', t => {
  const { network, ws, socket } = make(t)
  const backing = Buffer.alloc(1024 * 1024)
  const packet = writeClientPacket('entityEvent', ['app', 0, 'probe', { n: 1 }])
  backing.set(packet, 100)
  const view = backing.subarray(100, 100 + packet.length)
  const seen = []
  network.onEntityEvent = (s, data, meta) => seen.push({ s, data, meta })
  ws.emit('message', view)
  assert.equal(socket.inbox.length, 1)
  const entry = socket.inbox[0]
  assert.ok(entry.copy instanceof Uint8Array)
  assert.equal(entry.copy.byteOffset, 0)
  assert.equal(entry.copy.buffer.byteLength, packet.length)
  assert.notEqual(entry.copy.buffer, backing.buffer)
  backing.fill(0)
  network.flush()
  assert.equal(socket.inboxCost, 0)
  assert.equal(socket.inbox.length, 0)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].s, socket)
  assert.deepEqual(seen[0].data, ['app', 0, 'probe', { n: 1 }])
  // (and when it arrived, for the budgets of what a packet sets off)
  const { at, ...meta } = seen[0].meta
  assert.deepEqual(meta, { bytes: packet.length, nodes: 9, socketId: 'test', builder: true })
  assert.ok(Number.isFinite(at) && at > 0 && at <= performance.now(), `arrival time: ${at}`)
})

test('Socket: refused scans and a full inbox are counted, logged once, and never copied', t => {
  const { network, ws, socket, logs } = make(t)
  for (let i = 0; i < 3; i++) ws.emit('message', Buffer.from([0x92, 8, 0xc1]))
  assert.equal(socket.inbox.length, 0)
  assert.equal(network.gate.dropped(socket), 3)
  assert.equal(logs.length, 1)
  socket.inboxCost = INBOX_SOCKET_CAP
  const slice = Uint8Array.prototype.slice
  Uint8Array.prototype.slice = () => {
    throw new Error('must not copy a refused packet')
  }
  try {
    ws.emit('message', writeClientPacket('ping', 1))
    ws.emit('message', writeClientPacket('ping', 2))
  } finally {
    Uint8Array.prototype.slice = slice
  }
  assert.equal(network.gate.dropped(socket), 5)
  assert.equal(logs.length, 2)
  assert.equal(socket.inbox.length, 0)
})

test('flush: a corrupted admitted copy is a decoder bug counted per packet and logged once', t => {
  const { network, ws, socket, logs } = make(t)
  const seen = []
  network.onPing = (s, data) => seen.push(data)
  for (let i = 0; i < 2; i++) {
    ws.emit('message', writeClientPacket('ping', i))
    socket.inbox[socket.inbox.length - 1].copy[2] = 0xc1
  }
  ws.emit('message', writeClientPacket('ping', 42))
  network.flush()
  assert.deepEqual(seen, [42])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /decoder bug .*pos 2, nodes 3/)
  assert.equal(network.gate.dropped(socket), 2)
  assert.equal(socket.inboxCost, 0)
})

test('flush: per-socket FIFO drains work below W even when wire bytes exceed 256 KiB', t => {
  const { network, ws, socket } = make(t)
  const seen = []
  network.onEntityEvent = (s, data) => seen.push(data[0])
  for (let i = 0; i < 6; i++) ws.emit('message', writeClientPacket('entityEvent', [i, 'x'.repeat(60000)]))
  assert.ok(socket.inboxCost > 256 * 1024)
  network.flush()
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5])
  assert.equal(socket.inbox.length, 0)
  assert.equal(socket.inboxCost, 0)
  assert.equal(network.scheduler.pool, 0)
})

test('flush: node work stops a tick before the next entry would exceed W', t => {
  const { network, ws, socket } = make(t)
  const seen = []
  network.onEntityEvent = (s, data) => seen.push(data[0])
  for (let i = 0; i < 3; i++) ws.emit('message', writeClientPacket('entityEvent', [i, Array(8187).fill(0)]))
  network.flush()
  assert.deepEqual(seen, [0])
  assert.equal(socket.inbox.length, 2)
  network.flush()
  network.flush()
  assert.deepEqual(seen, [0, 1, 2])
  assert.equal(socket.inboxCost, 0)
})

test('enqueue: capacity is reserved before copying and a failed copy releases its reservation', t => {
  const { network, ws, socket } = make(t)
  const slice = Uint8Array.prototype.slice
  const packet = writeClientPacket('ping', 1)
  Uint8Array.prototype.slice = function () {
    assert.equal(socket.inboxCost, packet.length + 160)
    throw new Error('copy failed')
  }
  try {
    assert.throws(() => ws.emit('message', packet), /copy failed/)
  } finally {
    Uint8Array.prototype.slice = slice
  }
  assert.equal(socket.inboxCost, 0)
  assert.equal(network.scheduler.pool, 0)
  assert.equal(socket.inbox.length, 0)
})

test('enqueue: late packets for a disconnected socket are counted as disconnected without copying', t => {
  const { network, ws, socket, logs } = make(t)
  ws.emit('close')
  for (let i = 0; i < 2; i++) ws.emit('message', writeClientPacket('ping', i))
  assert.equal(network.gate.dropped(socket), 2)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /dropped: disconnected /)
  assert.equal(socket.inbox.length, 0)
  assert.equal(socket.inboxCost, 0)
  assert.equal(network.scheduler.pool, 0)
})

test('onDisconnect: release queued and deferred credit synchronously, with lazy skipping on the next flush', t => {
  const { network, ws, socket, logs } = make(t)
  const packet = writeClientPacket('entityEvent', 'x'.repeat(60000))
  for (let i = 0; i < 5; i++) ws.emit('message', packet)
  const entries = [...socket.inbox]
  let dispatched = 0
  // What the handler sees is asserted after the flush: the flush catches what a handler throws and only logs it, so
  // an assertion made in the handler could not fail the test. The close itself gives the socket's credit back (its
  // inbox and the arrivals deferred during this flush) to the pool every connection reserves from, before any later
  // flush would skip the socket.
  const during = []
  network.onEntityEvent = () => {
    dispatched++
    during.push({ released: entries[0].released })
    ws.emit('message', packet)
    ws.emit('message', packet)
    during.push({ inboxCost: socket.inboxCost })
    ws.emit('close')
    during.push({ disconnected: socket.disconnected, inboxCost: socket.inboxCost, pool: network.scheduler.pool })
    ws.emit('close')
    network.scheduler.purge(socket)
  }
  network.flush()
  network.flush()
  assert.deepEqual(during, [
    { released: true },
    { inboxCost: 6 * (packet.length + 160) },
    { disconnected: true, inboxCost: 0, pool: 0 },
  ])
  assert.deepEqual(logs, [])
  assert.equal(dispatched, 1)
  assert.equal(socket.inbox.length, 0)
  assert.equal(socket.inboxCost, 0)
  assert.equal(network.scheduler.pool, 0)
  assert.equal(socket.inQueue, false)
  assert.ok(entries.every(e => e.released))
})

test('flush: synchronous and async handler errors are brief, logged once, and do not stall the queue', async t => {
  const { network, ws, socket, logs } = make(t)
  const seen = []
  network.onPing = (s, data) => {
    seen.push(data)
    if (data < 2) throw { name: 'Probe', message: 'x'.repeat(1000), payload: 'never log this' }
    if (data < 4) return Promise.reject(new Error('async error'))
  }
  for (let i = 0; i < 5; i++) ws.emit('message', writeClientPacket('ping', i))
  network.flush()
  await Promise.resolve()
  assert.deepEqual(seen, [0, 1, 2, 3, 4])
  assert.equal(logs.length, 1)
  assert.equal(logs[0], '[network] ping from client test failed: Probe: ' + 'x'.repeat(193))
  assert.equal(socket.inboxCost, 0)
})

test('onEntityEvent: rejects invalid versions silently and passes scheduler metadata to the app', t => {
  const { network, socket, ws, logs } = make(t)
  const seen = []
  network.world.entities = {
    items: new Map(),
    get: id => (id === 'app' ? { onEvent: (...args) => seen.push(args) } : undefined),
  }
  for (const version of [
    NaN,
    Infinity,
    -Infinity,
    '1',
    null,
    undefined,
    0.5,
    -1,
    -0.5,
    1e300,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    network.onEntityEvent(socket, ['app', version, 'probe', 'bad'], {})
  }
  assert.deepEqual(logs, [])
  network.onEntityEvent(socket, ['app', 0, 'update', 'internal'], {})
  assert.equal(seen.length, 0)
  const packet = writeClientPacket('entityEvent', ['app', 1, 'probe', 'ok'])
  ws.emit('message', packet)
  network.flush()
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].slice(0, 4), [1, 'probe', 'ok', socket.id])
  // (`allow`: asks the connection's budget for script events when the app takes the event; this app is a stand-in)
  const { at, allow, ...appMeta } = seen[0][4]
  assert.deepEqual(appMeta, { bytes: packet.length, nodes: 7, socketId: socket.id, builder: true })
  assert.ok(Number.isFinite(at))
  assert.equal(typeof allow, 'function')
})

test('onBlueprintModified: passes the editing socket as author without changing the existing local argument', t => {
  const { network, socket } = make(t)
  const seen = []
  network.requireBuilder = () => true
  network.world.blueprints = {
    canFit: () => true,
    get: () => ({ id: 'bp', version: 0 }),
    modify: (...args) => seen.push(args),
  }
  network.send = () => {}
  const data = { id: 'bp', version: 1 }
  network.onBlueprintModified(socket, data)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0][0], data)
  assert.notEqual(seen[0][0], data)
  assert.equal(seen[0][1], false)
  assert.deepEqual({ ...seen[0][2] }, { authorSocketId: socket.id })
})

test('onDisconnect and checkSockets: purge and expire actual queued events, releasing the shared ledger', t => {
  const { network, socket } = make(t)
  const ledger = network.world.apps.eventLedger
  const queue = createEventQueue({ ledger, isServer: true })
  const meta = { bytes: 100, nodes: 10, socketId: socket.id, builder: true }
  queue.push({ version: 1 }, meta, { keep: true, blueprintId: 'bp' })
  network.onDisconnect(socket)
  assert.equal(queue.size, 0)
  assert.equal(ledger.bytes, 0)
  assert.equal(ledger.keptNodes, 0)
  const expired = createEventLedger({ now: () => Date.now() - 60000 })
  network.world.apps.eventLedger = expired
  const pending = createEventQueue({ ledger: expired, isServer: true })
  pending.push({ version: 1 }, meta, { keep: true, blueprintId: 'bp' })
  network.checkSockets()
  assert.equal(pending.size, 0)
  assert.equal(expired.bytes, 0)
  assert.equal(expired.keptNodes, 0)
})
