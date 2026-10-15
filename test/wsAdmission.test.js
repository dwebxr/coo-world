import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConnectionLimits, readConnectionLimitsEnv } from '../src/server/connectionLimits.js'
import { loadRoute, makeNetwork } from './lib/networkHarness.mjs'

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
