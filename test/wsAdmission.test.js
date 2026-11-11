import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConnectionLimits, readConnectionLimitsEnv } from '../src/server/connectionLimits.js'
import { loadRoute, makeNetwork } from './lib/networkHarness.mjs'
import { PROTOCOL_VERSION } from '../src/core/packets.js'

function fixture() {
  const limits = createConnectionLimits({ ...readConnectionLimitsEnv({}), ratePerMin: 0 })
  const route = loadRoute(limits, makeNetwork())
  const transport = new EventEmitter()
  const request = { ws: true, raw: { socket: transport }, headers: {}, ip: '::ffff:102:304' }
  const reply = {
    code(value) {
      this.status = value
      return this
    },
    header(key, value) {
      this[key] = value
      return this
    },
    send() {
      this.sent = true
    },
  }
  return { limits, ...route, transport, request, reply }
}

test('preValidation: HTTP GETs take no lease and only one upgrade lease may occupy a transport', () => {
  const { limits, preValidation, request, reply, transport } = fixture()
  let next = 0
  for (let i = 0; i < 8; i++) preValidation({ ...request, ws: false }, reply, () => next++)
  assert.equal(limits.stats().active, 0)
  preValidation(request, reply, () => next++)
  assert.equal(limits.stats().active, 1)
  preValidation(request, reply, () => next++)
  assert.equal(next, 9)
  assert.equal(reply.status, 503)
  assert.equal(reply['Retry-After'], '10')
  assert.equal(transport.listenerCount('close'), 1)
  transport.emit('close')
  transport.emit('close')
  assert.equal(limits.stats().active, 0)
})

test('preValidation: already destroyed and synchronously closing transports release their lease', () => {
  for (const duringRegistration of [false, true]) {
    const { limits, preValidation, request, reply, transport } = fixture()
    transport.destroyed = !duringRegistration
    if (duringRegistration) {
      transport.once = (name, fn) => {
        EventEmitter.prototype.once.call(transport, name, fn)
        transport.destroyed = true
        transport.emit('close')
      }
    }
    preValidation(request, reply, () => {})
    assert.equal(limits.stats().active, 0)
  }
})

test('transport: actual registration pins all six ws limits', () => {
  const { options } = fixture()
  assert.deepEqual(
    { ...options.options },
    {
      maxPayload: 65536,
      maxFragments: 8,
      maxBufferedChunks: 1024,
      autoPong: false,
      perMessageDeflate: false,
      closeTimeout: 2000,
    }
  )
})

test('the /ws route hands the connection its address key and wider networks, from the header the limits use', () => {
  const calls = []
  const network = { onConnection: (...args) => calls.push(args), write() {} }
  const connect = (config, req) => {
    const { register } = loadRoute(
      createConnectionLimits({ ...readConnectionLimitsEnv({}), ratePerMin: 0 }),
      network,
      config
    )
    let handler
    register({ get: (_path, _options, fn) => (handler = fn) })
    handler({ close() {} }, req)
    return calls.at(-1)
  }
  const version = String(PROTOCOL_VERSION)
  // no header configured: the connection's own address (an IPv4-mapped one is its IPv4 address)
  const direct = connect({ clientIpHeader: '' }, { query: { v: version }, headers: {}, ip: '::ffff:203.0.113.9' })
  assert.equal(direct[1].v, version, 'the query is passed on as before')
  assert.equal(JSON.stringify(direct[2]), JSON.stringify({ key: '203.0.113.9', parents: [] }))
  // the proxy's header, when one is named: an IPv6 client is its /64, with its /56 and /48
  const proxied = connect(
    { clientIpHeader: 'fly-client-ip' },
    { query: { v: version }, headers: { 'fly-client-ip': '2001:db8:1:2:3:4:5:6' }, ip: '10.0.0.1' }
  )
  assert.match(proxied[2].key, /^2001:db8:1:2/)
  assert.equal(proxied[2].parents.length, 2)
  // nothing usable: 'unknown', which the admin brake does not take for a key
  const hidden = connect({ clientIpHeader: 'fly-client-ip' }, { query: { v: version }, headers: {}, ip: undefined })
  assert.equal(hidden[2].key, 'unknown')
})
