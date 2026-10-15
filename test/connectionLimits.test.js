import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SWEEP_INTERVAL_MS, createConnectionLimits, readConnectionLimitsEnv } from '../src/server/connectionLimits.js'

const defaults = readConnectionLimitsEnv({})
const clock = (start = 10_000_000) => {
  let t = start
  return { now: () => t, tick: ms => (t += ms) }
}
const make = (overrides = {}) => {
  const c = clock()
  const limits = createConnectionLimits({ ...defaults, ...overrides }, { now: c.now })
  return { limits, c }
}

test('readConnectionLimitsEnv: defaults, overrides, 0 disables, bad values throw', () => {
  assert.deepEqual(defaults, { ratePerMin: 10, burst: 20, concurrentPerIp: 8, maxEntries: 40_000 })
  assert.deepEqual(
    readConnectionLimitsEnv({
      WS_CONNECT_RATE_PER_MIN: '0',
      WS_CONNECT_BURST: '',
      WS_CONNECT_CONCURRENT_PER_IP: '16',
      WS_CONNECT_MAX_TRACKED: '100',
    }),
    { ratePerMin: 0, burst: 20, concurrentPerIp: 16, maxEntries: 100 }
  )
  for (const bad of ['-1', 'ten', 'NaN', 'Infinity']) {
    assert.throws(() => readConnectionLimitsEnv({ WS_CONNECT_RATE_PER_MIN: bad }), /WS_CONNECT_RATE_PER_MIN/, bad)
  }
  assert.throws(() => readConnectionLimitsEnv({ WS_CONNECT_BURST: '0' }), /WS_CONNECT_BURST/)
  assert.doesNotThrow(() => readConnectionLimitsEnv({ WS_CONNECT_RATE_PER_MIN: '0', WS_CONNECT_BURST: '0' }))
})

test('admit: a burst of 20 connections from one address, then one more every 6 seconds', () => {
  const { limits, c } = make({ concurrentPerIp: 0 })
  const ok = () => limits.admit('10.0.0.1').ok
  let admitted = 0
  for (let i = 0; i < 200; i++) if (ok()) admitted++
  assert.equal(admitted, 20)
  assert.deepEqual(limits.admit('10.0.0.1'), { ok: false, reason: 'too many connections' })
  c.tick(5_000)
  assert.equal(ok(), false)
  c.tick(12_000) // 17 s since the burst: close to three tokens
  assert.equal(ok(), true)
  assert.equal(ok(), true)
  assert.equal(ok(), false)
  c.tick(180_000)
  admitted = 0
  for (let i = 0; i < 200; i++) if (ok()) admitted++
  assert.equal(admitted, 20) // the bucket never holds more than the burst
})

test('admit: at most 8 open connections per address; a release frees a slot once', () => {
  const { limits } = make({ ratePerMin: 0 })
  const leases = []
  for (let i = 0; i < 8; i++) {
    const v = limits.admit('a')
    assert.equal(v.ok, true)
    leases.push(v)
  }
  assert.deepEqual(limits.admit('a'), { ok: false, reason: 'too many connections' })
  assert.equal(limits.admit('b').ok, true) // another address is not affected
  leases[0].release()
  leases[0].release()
  assert.equal(limits.admit('a').ok, true)
  assert.equal(limits.admit('a').ok, false)
  assert.deepEqual(limits.stats(), { tracked: 2, active: 9 })
})

test('admit: six tabs or agents on one address connect; 200 rapid connections from one address do not', () => {
  const { limits } = make()
  const six = Array.from({ length: 6 }, () => limits.admit('home'))
  assert.ok(six.every(v => v.ok))
  let admitted = 0
  for (let i = 0; i < 200; i++) {
    const v = limits.admit('churn')
    if (v.ok) {
      admitted++
      v.release()
    }
  }
  assert.equal(admitted, 20) // opened and closed at once: the burst
  admitted = 0
  for (let i = 0; i < 200; i++) if (limits.admit('flood').ok) admitted++
  assert.equal(admitted, 8) // held open: the concurrency cap
})

test('admit: 0 disables a limit', () => {
  const { limits } = make({ ratePerMin: 0, concurrentPerIp: 0 })
  for (let i = 0; i < 1000; i++) assert.equal(limits.admit('x').ok, true)
  assert.deepEqual(limits.stats(), { tracked: 1, active: 1000 })
})

test('entries: a full table makes room from idle addresses and refuses newcomers while none is idle', () => {
  const { limits } = make({ maxEntries: 2, ratePerMin: 0 })
  const a = limits.admit('a')
  limits.admit('b')
  assert.deepEqual(limits.admit('c'), { ok: false, reason: 'busy' })
  a.release()
  // 'a' is idle now: the next newcomer purges it and takes its place
  assert.equal(limits.admit('c').ok, true)
  assert.equal(limits.stats().tracked, 2)
  assert.deepEqual(limits.admit('d'), { ok: false, reason: 'busy' })
})

test('entries: an address is swept once a minute as soon as nothing is open and its bucket is full again', () => {
  const { limits, c } = make({ concurrentPerIp: 0 })
  for (let i = 0; i < 15; i++) limits.admit('a').release()
  c.tick(SWEEP_INTERVAL_MS)
  limits.admit('b') // sweeps: 'a' holds 15 of 20 tokens again, still refilling
  assert.equal(limits.stats().tracked, 2)
  c.tick(SWEEP_INTERVAL_MS)
  limits.admit('b') // sweeps: 'a' is full and gone; 'b' has connections open
  assert.equal(limits.stats().tracked, 1)
})
