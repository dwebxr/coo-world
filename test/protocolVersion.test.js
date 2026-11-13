import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { PROTOCOL_VERSION, readPacket } from '../src/core/packets.js'
import { createConnectionLimits, readConnectionLimitsEnv } from '../src/server/connectionLimits.js'
import { fakeWs, loadNetwork, makeNetwork } from './lib/network.mjs'
import { loadRoute } from './lib/wsRoute.mjs'
import { WireClient } from './e2e/lib/ws.mjs'

// the real network (test/lib/network.mjs), whose onConnection a test takes over: the route's own write of the kick
// is the class's
const net = await loadNetwork()

async function makeRoute(t) {
  const limits = createConnectionLimits({
    ...readConnectionLimitsEnv({}),
    ratePerMin: 0,
    concurrentPerIp: 1,
  })
  const connections = []
  const network = makeNetwork(t, { net })
  network.onConnection = (ws, params) => connections.push({ ws, params })
  const { register, preValidation } = loadRoute(limits, network)
  let handler
  await register({
    get(url, options, fn) {
      assert.equal(url, '/ws')
      assert.equal(options.websocket, true)
      handler = fn
    },
  })
  return {
    limits,
    connections,
    connect(query = {}) {
      const ws = fakeWs()
      const transport = new EventEmitter()
      ws.transport = transport
      ws.send = (packet, cb) => {
        ws.packets.push(readPacket(packet))
        cb()
      }
      ws.close = (code, reason) => {
        ws.closeCode = code
        ws.closeReason = reason
      }
      const request = { ws: true, raw: { socket: transport }, headers: {}, ip: '127.0.0.1', query }
      const reply = {
        code(status) {
          ws.status = status
          return this
        },
        header(name, value) {
          ws[name] = value
          return this
        },
        send() {},
      }
      preValidation(request, reply, () => handler(ws, request))
      return ws
    },
  }
}

test('protocol version: missing or mismatched versions are kicked before world admission', async t => {
  for (const v of [undefined, '', '1', '02', '2.0', '3', ['2', '2']]) {
    const route = await makeRoute(t)
    const ws = route.connect(v === undefined ? {} : { v })
    assert.deepEqual(ws.packets, [['onKick', 'outdated']])
    assert.equal(ws.closeCode, 1008)
    assert.equal(ws.closeReason, 'outdated')
    assert.equal(route.connections.length, 0)
    ws.transport.emit('close')
  }
})

test('protocol version: v=2 reaches the world with the original connection params', async t => {
  assert.equal(PROTOCOL_VERSION, 2)
  const route = await makeRoute(t)
  const params = { v: '2', authToken: 'token', name: 'player' }
  const ws = route.connect(params)
  assert.deepEqual(ws.packets, [])
  assert.equal(ws.closeCode, undefined)
  assert.deepEqual(route.connections, [{ ws, params }])
  ws.transport.emit('close')
})

test('protocol version: address admission runs first and an outdated socket holds its slot until close', async t => {
  const route = await makeRoute(t)
  const outdated = route.connect()
  assert.equal(route.limits.stats().active, 1)
  const refused = route.connect()
  assert.deepEqual(refused.packets, [])
  assert.equal(refused.status, 503)
  assert.equal(refused['Retry-After'], '10')
  assert.equal(route.connections.length, 0)
  outdated.transport.emit('close')
  assert.equal(route.limits.stats().active, 0)
  const current = route.connect({ v: '2' })
  assert.equal(route.connections.length, 1)
  current.transport.emit('close')
  assert.equal(route.limits.stats().active, 0)
})

test('WireClient advertises v=2 by default and can omit it for the outdated probe', async t => {
  const original = globalThis.WebSocket
  t.after(() => (globalThis.WebSocket = original))
  globalThis.WebSocket = class extends EventTarget {
    constructor(url) {
      super()
      this.url = url
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
  }
  const current = await new WireClient(3000).open()
  assert.equal(new URL(current.ws.url).searchParams.get('v'), '2')
  const outdated = await new WireClient(3000, 'outdated', { version: null }).open()
  assert.equal(new URL(outdated.ws.url).searchParams.has('v'), false)
})
