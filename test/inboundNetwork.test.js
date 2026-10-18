import { persistenceRecord } from '../src/core/extras/persistenceRecord.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import vm from 'node:vm'
import { writeClientPacket, writePacket } from '../src/core/packets.js'
import {
  createInboundGate,
  createInboundScheduler,
  INBOX_SOCKET_CAP,
  packetNodeLimit,
} from '../src/core/extras/inboundPolicy.js'
import { briefError, createLogOnce } from '../src/core/extras/logOnce.js'
import { readInboundPacket } from '../src/server/inboundDecode.js'
import { createEventLedger, createEventQueue } from '../src/core/extras/appEventQueue.js'
import { sanitizeBlueprintModify } from '../src/core/extras/blueprintPolicy.js'

// Exercise the real receive/queue/flush methods without booting physics, the database or Solana.
const source = fs.readFileSync(new URL('../src/core/systems/ServerNetwork.js', import.meta.url), 'utf8')
const methods = [
  'markBlueprintDirty',
  'admit',
  'enqueue',
  'flush',
  'onDisconnect',
  'checkSockets',
  'onEntityEvent',
  'onBlueprintModified',
  'revertBlueprint',
]
  .map(name => {
    const method = source.match(new RegExp(`^  ${name}(?:\\(| = )[^]*?^  }`, 'm'))?.[0]
    assert.ok(method, `${name} method found`)
    return method
  })
  .join('\n')
const socketSource = fs.readFileSync(new URL('../src/core/Socket.js', import.meta.url), 'utf8')
const Socket = vm.runInNewContext(`(${socketSource.slice(socketSource.indexOf('class Socket'))})`, { writePacket })
const Network = vm.runInNewContext(`(class Network { ${methods} })`, {
  packetNodeLimit,
  readInboundPacket,
  briefError,
  solanaGating: { clearSocket() {} },
  Uint8Array,
  console,
  internalEvents: ['update'],
  sanitizeBlueprintModify,
  persistenceRecord,
})
const make = () => {
  const logs = []
  const network = new Network()
  network.scheduler = createInboundScheduler()
  network.sockets = new Map()
  network.world = { livekit: { clearModifiers() {} }, apps: { eventLedger: createEventLedger() } }
  network.logOnce = createLogOnce(line => logs.push(line))
  network.gate = createInboundGate({ now: () => 1000, log: line => logs.push(line) })
  const ws = new EventEmitter()
  const socket = new Socket({ id: 'test', ws, network, player: { isBuilder: () => true, destroy() {} } })
  return { network, ws, socket, logs }
}

test('Socket: admission precedes exact-size copy; flush passes bytes, nodes, socket and builder metadata', () => {
  const { network, ws, socket } = make()
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
  assert.deepEqual({ ...seen[0].meta }, { bytes: packet.length, nodes: 9, socketId: 'test', builder: true })
})

test('Socket: refused scans and a full inbox are counted, logged once, and never copied', () => {
  const { network, ws, socket, logs } = make()
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

test('flush: a corrupted admitted copy is a decoder bug counted per packet and logged once', () => {
  const { network, ws, socket, logs } = make()
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

test('flush: per-socket FIFO drains work below W even when wire bytes exceed 256 KiB', () => {
  const { network, ws, socket } = make()
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

test('flush: node work stops a tick before the next entry would exceed W', () => {
  const { network, ws, socket } = make()
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

test('enqueue: capacity is reserved before copying and a failed copy releases its reservation', () => {
  const { network, ws, socket } = make()
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

test('enqueue: late packets for a disconnected socket are counted as disconnected without copying', () => {
  const { network, ws, socket, logs } = make()
  ws.emit('close')
  for (let i = 0; i < 2; i++) ws.emit('message', writeClientPacket('ping', i))
  assert.equal(network.gate.dropped(socket), 2)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /dropped: disconnected /)
  assert.equal(socket.inbox.length, 0)
  assert.equal(socket.inboxCost, 0)
  assert.equal(network.scheduler.pool, 0)
})

test('onDisconnect: release queued and deferred credit synchronously, with lazy skipping on the next flush', () => {
  const { network, ws, socket } = make()
  const packet = writeClientPacket('entityEvent', 'x'.repeat(60000))
  for (let i = 0; i < 5; i++) ws.emit('message', packet)
  const entries = [...socket.inbox]
  let dispatched = 0
  network.onEntityEvent = () => {
    dispatched++
    assert.equal(entries[0].released, true)
    ws.emit('message', packet)
    ws.emit('message', packet)
    assert.equal(socket.inboxCost, 6 * (packet.length + 160))
    ws.emit('close')
    assert.equal(socket.disconnected, true)
    assert.equal(socket.inboxCost, 0)
    assert.equal(network.scheduler.pool, 0)
    ws.emit('close')
    network.scheduler.purge(socket)
  }
  network.flush()
  network.flush()
  assert.equal(dispatched, 1)
  assert.equal(socket.inbox.length, 0)
  assert.equal(socket.inboxCost, 0)
  assert.equal(network.scheduler.pool, 0)
  assert.equal(socket.inQueue, false)
  assert.ok(entries.every(e => e.released))
})

test('flush: synchronous and async handler errors are brief, logged once, and do not stall the queue', async () => {
  const { network, ws, socket, logs } = make()
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

test('onEntityEvent: rejects invalid versions silently and passes scheduler metadata to the app', () => {
  const { network, socket, ws, logs } = make()
  const seen = []
  network.world.entities = { get: id => (id === 'app' ? { onEvent: (...args) => seen.push(args) } : undefined) }
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
  assert.deepEqual({ ...seen[0][4] }, { bytes: packet.length, nodes: 7, socketId: socket.id, builder: true })
})

test('onBlueprintModified: passes the editing socket as author without changing the existing local argument', () => {
  const { network, socket } = make()
  const seen = []
  network.requireBuilder = () => true
  network.world.blueprints = {
    canFit: () => true,
    get: () => ({ id: 'bp', version: 0 }),
    modify: (...args) => seen.push(args),
  }
  network.send = () => {}
  network.dirtyBlueprints = new Map()
  network.persistenceRevision = 0
  const data = { id: 'bp', version: 1 }
  network.onBlueprintModified(socket, data)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0][0], data)
  assert.notEqual(seen[0][0], data)
  assert.equal(seen[0][1], false)
  assert.deepEqual({ ...seen[0][2] }, { authorSocketId: socket.id })
})

test('onDisconnect and checkSockets: purge and expire actual queued events, releasing the shared ledger', () => {
  const { network, socket } = make()
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
