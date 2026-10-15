import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import vm from 'node:vm'

import { PROTOCOL_VERSION, readPacket, writePacket } from '../src/core/packets.js'
import { createConnectionLimits, readConnectionLimitsEnv } from '../src/server/connectionLimits.js'
import { clientIpKey } from '../src/server/uploadLimits.js'
import { WireClient } from './e2e/lib/ws.mjs'

// Exercise the route itself without booting the world, database and physics runtime in index.js.
const source = fs.readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8')
const routeSource = source.match(/^async function worldNetwork\(fastify\) \{[\s\S]*?^\}/m)?.[0]
assert.ok(routeSource, 'worldNetwork route found')

async function makeRoute() {
  const limits = createConnectionLimits({
    ...readConnectionLimitsEnv({}),
    ratePerMin: 0,
    concurrentPerIp: 1,
  })
  const connections = []
  const register = vm.runInNewContext(`(${routeSource})`, {
    PROTOCOL_VERSION,
    writePacket,
    clientIpKey,
    uploadLimitsConfig: { clientIpHeader: '' },
    connectionLimits: limits,
    world: { network: { onConnection: (ws, params) => connections.push({ ws, params }) } },
  })
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
      const ws = new EventEmitter()
      ws.packets = []
      ws.send = packet => ws.packets.push(readPacket(packet))
      ws.close = (code, reason) => {
        ws.closeCode = code
        ws.closeReason = reason
      }
      handler(ws, { headers: {}, ip: '127.0.0.1', query })
      return ws
    },
  }
}

test('protocol version: missing or mismatched versions are kicked before world admission', async () => {
  for (const v of [undefined, '', '1', '02', '2.0', '3', ['2', '2']]) {
    const route = await makeRoute()
    const ws = route.connect(v === undefined ? {} : { v })
    assert.deepEqual(ws.packets, [['onKick', 'outdated']])
    assert.equal(ws.closeCode, 1008)
    assert.equal(ws.closeReason, 'outdated')
    assert.equal(route.connections.length, 0)
    ws.emit('close')
  }
})

test('protocol version: v=2 reaches the world with the original connection params', async () => {
  assert.equal(PROTOCOL_VERSION, 2)
  const route = await makeRoute()
  const params = { v: '2', authToken: 'token', name: 'player' }
  const ws = route.connect(params)
  assert.deepEqual(ws.packets, [])
  assert.equal(ws.closeCode, undefined)
  assert.deepEqual(route.connections, [{ ws, params }])
  ws.emit('close')
})

test('protocol version: address admission runs first and an outdated socket holds its slot until close', async () => {
  const route = await makeRoute()
  const outdated = route.connect()
  assert.equal(route.limits.stats().active, 1)
  const refused = route.connect()
  assert.deepEqual(refused.packets, [['onKick', 'connection_limit']])
  assert.equal(refused.closeCode, 1013)
  assert.equal(route.connections.length, 0)
  outdated.emit('close')
  assert.equal(route.limits.stats().active, 0)
  const current = route.connect({ v: '2' })
  assert.equal(route.connections.length, 1)
  current.emit('close')
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
