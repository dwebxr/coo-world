import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { PROTOCOL_VERSION, packetNameById, peekPacketId, writePacket } from '../../src/core/packets.js'
import { createWriteLedger, PACKET_CAP } from '../../src/core/extras/writeLedger.js'
import { createInboundGate, createInboundScheduler } from '../../src/core/extras/inboundPolicy.js'
import { createEventLedger } from '../../src/core/extras/appEventQueue.js'
import { clientIpKeys } from '../../src/server/uploadLimits.js'

export const serverSource = fs.readFileSync(new URL('../../src/server/index.js', import.meta.url), 'utf8')
const source = fs.readFileSync(new URL('../../src/core/systems/ServerNetwork.js', import.meta.url), 'utf8')
const names = ['preFixedUpdate', 'asScript', 'write', 'send', 'sendTo', 'checkSockets', 'admit', 'enqueue']
const methods = names
  .map(name => {
    const method = source.match(new RegExp(`^  ${name}\\([^]*?^  }`, 'm'))?.[0]
    assert.ok(method, `${name} method found`)
    return method
  })
  .join('\n')
const Network = vm.runInNewContext(`(class Network { ${methods} })`, {
  writePacket,
  packetNameById,
  peekPacketId,
  Uint8Array,
})
const socketSource = fs.readFileSync(new URL('../../src/core/Socket.js', import.meta.url), 'utf8')
export const Socket = vm.runInNewContext(`(${socketSource.slice(socketSource.indexOf('class Socket'))})`, {
  writePacket,
})

export function makeNetwork(log = () => {}) {
  const network = new Network()
  network.isServer = true
  network.id = 0
  network.sockets = new Map()
  network.writer = createWriteLedger({ log })
  network.gate = createInboundGate({ log })
  network.scheduler = createInboundScheduler()
  network.world = { apps: { eventLedger: createEventLedger() } }
  network.onDisconnect = socket => {
    socket.disconnected = true
    network.scheduler.purge(socket)
    network.sockets.delete(socket.id)
  }
  return network
}

export function fakeWs() {
  const ws = new EventEmitter()
  ws.readyState = 1
  ws.pending = []
  ws.packets = []
  ws.terminations = 0
  ws.send = (packet, cb) => {
    ws.packets.push(packet)
    ws.pending.push(cb)
  }
  ws.ping = (data, mask, cb) => {
    assert.equal(data, undefined)
    assert.equal(mask, false)
    ws.pending.push(cb)
  }
  ws.terminate = () => {
    ws.terminations++
    ws.readyState = 3
  }
  ws.drain = () => {
    for (const cb of ws.pending.splice(0)) cb()
  }
  return ws
}

// Run the actual index.js options, preValidation and route without booting physics or a database.
export function loadRoute(limits, network, config = { clientIpHeader: '' }) {
  const admission = serverSource.match(/^function admitConnection\([^]*?^}/m)?.[0]
  const route = serverSource.match(/^async function worldNetwork\([^]*?^}/m)?.[0]
  const options = serverSource.match(/fastify.register\(ws, (\{\n {2}options: \{[^]*?\n\})\)/)?.[1]
  assert.ok(admission && route && options)
  const context = vm.createContext({
    PROTOCOL_VERSION,
    writePacket,
    clientIpKeys,
    connectionLimits: limits,
    uploadLimitsConfig: config,
    kLease: Symbol('lease'),
    world: { network },
  })
  vm.runInContext(`${admission}\n${route}`, context)
  return {
    register: vm.runInContext('worldNetwork', context),
    preValidation: vm.runInContext('admitConnection', context),
    options: vm.runInContext(`(${options})`, context),
  }
}

export function connectionMethod(context) {
  const method = source.match(/^ {2}async onConnection\([^]*?^ {2}}/m)?.[0]
  assert.ok(method)
  return vm.runInNewContext(`(class { ${method} }).prototype.onConnection`, {
    writePacket,
    PACKET_CAP,
    Socket,
    ...context,
  })
}
