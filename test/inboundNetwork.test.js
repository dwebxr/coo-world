import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import vm from 'node:vm'
import { writeClientPacket, writePacket } from '../src/core/packets.js'
import {
  createInboundGate,
  INBOX_MAX_BYTES,
  INBOUND_BYTES_PER_TICK,
  packetNodeLimit,
} from '../src/core/extras/inboundPolicy.js'
import { readInboundPacket } from '../src/server/inboundDecode.js'

// Exercise the real receive/queue/flush methods without booting physics, the database or Solana.
const source = fs.readFileSync(new URL('../src/core/systems/ServerNetwork.js', import.meta.url), 'utf8')
const methods = ['admit', 'enqueue', 'flush']
  .map(name => {
    const method = source.match(new RegExp(`^  ${name}\\([^]*?^  }`, 'm'))?.[0]
    assert.ok(method, `${name} method found`)
    return method
  })
  .join('\n')
const socketSource = fs.readFileSync(new URL('../src/core/Socket.js', import.meta.url), 'utf8')
const Socket = vm.runInNewContext(`(${socketSource.slice(socketSource.indexOf('class Socket'))})`, { writePacket })
const Network = vm.runInNewContext(`(class Network { ${methods} })`, {
  INBOX_MAX_BYTES,
  INBOUND_BYTES_PER_TICK,
  packetNodeLimit,
  readInboundPacket,
  Uint8Array,
  console,
})
const make = () => {
  const logs = []
  const network = new Network()
  network.inbox = []
  network.gate = createInboundGate({ now: () => 1000, log: line => logs.push(line) })
  const ws = new EventEmitter()
  const socket = new Socket({ id: 'test', ws, network, player: { isBuilder: () => true } })
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
  assert.equal(network.inbox.length, 2)
  const entry = network.inbox[1]
  assert.ok(entry.copy instanceof Uint8Array)
  assert.equal(entry.copy.byteOffset, 0)
  assert.equal(entry.copy.buffer.byteLength, packet.length)
  assert.notEqual(entry.copy.buffer, backing.buffer)
  backing.fill(0)
  network.flush()
  assert.equal(socket.inboxBytes, 0)
  assert.equal(network.inbox.length, 0)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].s, socket)
  assert.deepEqual(seen[0].data, ['app', 0, 'probe', { n: 1 }])
  assert.deepEqual({ ...seen[0].meta }, { bytes: packet.length, nodes: 9, socketId: 'test', builder: true })
})

test('Socket: refused scans and a full flat inbox are counted, logged once, and never copied', () => {
  const { network, ws, socket, logs } = make()
  for (let i = 0; i < 3; i++) ws.emit('message', Buffer.from([0x92, 8, 0xc1]))
  assert.equal(network.inbox.length, 0)
  assert.equal(network.gate.dropped(socket), 3)
  assert.equal(logs.length, 1)
  socket.inboxBytes = INBOX_MAX_BYTES
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
  assert.equal(network.inbox.length, 0)
})

test('flush: a corrupted admitted copy is a decoder bug counted per packet and logged once', () => {
  const { network, ws, socket, logs } = make()
  const seen = []
  network.onPing = (s, data) => seen.push(data)
  for (let i = 0; i < 2; i++) {
    ws.emit('message', writeClientPacket('ping', i))
    network.inbox[network.inbox.length - 1].copy[2] = 0xc1
  }
  ws.emit('message', writeClientPacket('ping', 42))
  network.flush()
  assert.deepEqual(seen, [42])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /decoder bug .*pos 2, nodes 3/)
  assert.equal(network.gate.dropped(socket), 2)
  assert.equal(socket.inboxBytes, 0)
})

test('flush: flat inbox FIFO and per-tick wire budget remain in place', () => {
  const { network, ws, socket } = make()
  const seen = []
  network.onEntityEvent = (s, data) => seen.push(data[0])
  for (let i = 0; i < 6; i++) ws.emit('message', writeClientPacket('entityEvent', [i, 'x'.repeat(60000)]))
  network.flush()
  assert.deepEqual(seen, [0, 1, 2, 3, 4])
  assert.equal(network.inbox.length, 2)
  assert.ok(socket.inboxBytes > 0)
  network.flush()
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5])
  assert.equal(socket.inboxBytes, 0)
})
