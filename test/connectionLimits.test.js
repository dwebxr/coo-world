import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RESERVED_MAX,
  RESERVED_PER_USER,
  SWEEP_INTERVAL_MS,
  createConnectionLimits,
  keptPlacesInEffect,
  keptPlacesNote,
  readConnectionLimitsEnv,
  readReservedEnv,
} from '../src/server/connectionLimits.js'
import { clientIpKeys } from '../src/server/uploadLimits.js'
import { RANKED_RESERVE_PLAYERS } from '../src/core/extras/joinBudget.js'

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
  assert.deepEqual(defaults, {
    ratePerMin: 10,
    burst: 20,
    ratePerMin56: 20,
    burst56: 40,
    ratePerMin48: 40,
    burst48: 80,
    concurrentPerIp: 8,
    concurrentPer56: 16,
    concurrentPer48: 32,
    maxSockets: 64,
    maxEntries: 40_000,
    reserved: 4,
    reservedRank: 2,
  })
  assert.deepEqual(
    readConnectionLimitsEnv({
      WS_CONNECT_RATE_PER_MIN: '0',
      WS_CONNECT_BURST: '',
      WS_CONNECT_CONCURRENT_PER_IP: '16',
      WS_CONNECT_MAX_TRACKED: '100',
    }),
    {
      ratePerMin: 0,
      burst: 20,
      ratePerMin56: 20,
      burst56: 40,
      ratePerMin48: 40,
      burst48: 80,
      concurrentPerIp: 16,
      concurrentPer56: 16,
      concurrentPer48: 32,
      maxSockets: 64,
      maxEntries: 100,
      reserved: 4,
      reservedRank: 2,
    }
  )
  for (const bad of ['-1', 'ten', 'NaN', 'Infinity']) {
    assert.throws(() => readConnectionLimitsEnv({ WS_CONNECT_RATE_PER_MIN: bad }), /WS_CONNECT_RATE_PER_MIN/, bad)
  }
  assert.throws(() => readConnectionLimitsEnv({ WS_CONNECT_BURST: '0' }), /WS_CONNECT_BURST/)
  assert.doesNotThrow(() => readConnectionLimitsEnv({ WS_CONNECT_RATE_PER_MIN: '0', WS_CONNECT_BURST: '0' }))
})

test('admit: a burst of 20 connections from one address, then one more every 6 seconds', () => {
  const { limits, c } = make({ concurrentPerIp: 0 })
  const ok = () => limits.admit({ key: '10.0.0.1' }).ok
  let admitted = 0
  for (let i = 0; i < 200; i++) if (ok()) admitted++
  assert.equal(admitted, 20)
  assert.deepEqual(limits.admit({ key: '10.0.0.1' }), { ok: false, reason: 'too many connections' })
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
    const v = limits.admit({ key: 'a' })
    assert.equal(v.ok, true)
    leases.push(v)
  }
  assert.deepEqual(limits.admit({ key: 'a' }), { ok: false, reason: 'too many connections' })
  assert.equal(limits.admit({ key: 'b' }).ok, true) // another address is not affected
  leases[0].release()
  leases[0].release()
  assert.equal(limits.admit({ key: 'a' }).ok, true)
  assert.equal(limits.admit({ key: 'a' }).ok, false)
  assert.deepEqual(limits.stats(), { tracked: 2, active: 9, ranked: 0, users: 0 })
})

test('admit: six tabs or agents on one address connect; 200 rapid connections from one address do not', () => {
  const { limits } = make()
  const six = Array.from({ length: 6 }, () => limits.admit({ key: 'home' }))
  assert.ok(six.every(v => v.ok))
  let admitted = 0
  for (let i = 0; i < 200; i++) {
    const v = limits.admit({ key: 'churn' })
    if (v.ok) {
      admitted++
      v.release()
    }
  }
  assert.equal(admitted, 20) // opened and closed at once: the burst
  admitted = 0
  for (let i = 0; i < 200; i++) if (limits.admit({ key: 'flood' }).ok) admitted++
  assert.equal(admitted, 8) // held open: the concurrency cap
})

test('admit: 0 disables a limit', () => {
  const { limits } = make({ ratePerMin: 0, concurrentPerIp: 0, maxSockets: 0 })
  for (let i = 0; i < 1000; i++) assert.equal(limits.admit({ key: 'x' }).ok, true)
  assert.deepEqual(limits.stats(), { tracked: 1, active: 1000, ranked: 0, users: 0 })
})

test('entries: a full table makes room from idle addresses and refuses newcomers while none is idle', () => {
  const { limits } = make({ maxEntries: 2, ratePerMin: 0 })
  const a = limits.admit({ key: 'a' })
  limits.admit({ key: 'b' })
  assert.deepEqual(limits.admit({ key: 'c' }), { ok: false, reason: 'busy' })
  a.release()
  // 'a' is idle now: the next newcomer purges it and takes its place
  assert.equal(limits.admit({ key: 'c' }).ok, true)
  assert.equal(limits.stats().tracked, 2)
  assert.deepEqual(limits.admit({ key: 'd' }), { ok: false, reason: 'busy' })
})

test('entries: an address is swept once a minute as soon as nothing is open and its bucket is full again', () => {
  const { limits, c } = make({ concurrentPerIp: 0 })
  for (let i = 0; i < 15; i++) limits.admit({ key: 'a' }).release()
  c.tick(SWEEP_INTERVAL_MS)
  limits.admit({ key: 'b' }) // sweeps: 'a' holds 15 of 20 tokens again, still refilling
  assert.equal(limits.stats().tracked, 2)
  c.tick(SWEEP_INTERVAL_MS)
  limits.admit({ key: 'b' }) // sweeps: 'a' is full and gone; 'b' has connections open
  assert.equal(limits.stats().tracked, 1)
})

test('admit: IPv6 /56 and /48 caps aggregate different /64 keys and release once', () => {
  const { limits } = make({ ratePerMin: 0 })
  const leases = []
  for (let i = 0; i < 32; i++) {
    const parents = [`2001:db8:1:${i < 16 ? '100' : '200'}::/56`, '2001:db8:1::/48']
    const lease = limits.admit({ key: `key-${i}`, parents })
    assert.equal(lease.ok, true)
    leases.push(lease)
    if (i === 15) assert.equal(limits.admit({ key: 'overflow56', parents }).ok, false)
  }
  const next = { key: 'next', parents: ['2001:db8:1:300::/56', '2001:db8:1::/48'] }
  assert.equal(limits.admit(next).ok, false)
  leases[0].release()
  leases[0].release()
  assert.equal(limits.admit(next).ok, true)
  assert.equal(limits.admit(next).ok, false)
  assert.equal(limits.admit({ key: 'elsewhere', parents: ['2001:db8:2:100::/56', '2001:db8:2::/48'] }).ok, true)
})

test('admit: global cap includes IPv4 and IPv6, with no token or parent charge on refusal', () => {
  const { limits } = make({ maxSockets: 2, burst: 1 })
  const a = limits.admit({ key: 'a' })
  const b = limits.admit({ key: 'b', parents: ['prefix::/56', 'prefix::/48'] })
  assert.equal(limits.admit({ key: 'c' }).ok, false)
  a.release()
  a.release()
  assert.equal(limits.admit({ key: 'c' }).ok, true)
  assert.equal(limits.stats().active, 2)
  b.release()
  assert.equal(limits.stats().active, 1)
})

test('admit: parent/global defaults, overrides, disabled values and validation', () => {
  const keys = ['WS_CONNECT_CONCURRENT_PER_56', 'WS_CONNECT_CONCURRENT_PER_48', 'WS_MAX_SOCKETS']
  for (const key of keys) {
    for (const value of ['-1', 'NaN', 'Infinity']) assert.throws(() => readConnectionLimitsEnv({ [key]: value }))
  }
  const config = readConnectionLimitsEnv(Object.fromEntries(keys.map(key => [key, '0'])))
  assert.equal(config.concurrentPer56, 0)
  assert.equal(config.concurrentPer48, 0)
  assert.equal(config.maxSockets, 0)
  const limits = createConnectionLimits({ ...config, ratePerMin: 0, ratePerMin56: 0, ratePerMin48: 0 })
  for (let i = 0; i < 100; i++) assert.equal(limits.admit({ key: `${i}`, parents: ['p::/56', 'p::/48'] }).ok, true)
  const custom = readConnectionLimitsEnv(Object.fromEntries(keys.map(key => [key, '1'])))
  assert.equal(custom.concurrentPer56, 1)
  assert.equal(custom.concurrentPer48, 1)
  assert.equal(custom.maxSockets, 1)
})

test('parent rate envs: overrides, either zero disables the bucket, and invalid values throw', () => {
  for (const suffix of ['56', '48']) {
    const rate = `WS_CONNECT_RATE_PER_MIN_${suffix}`
    const burst = `WS_CONNECT_BURST_${suffix}`
    for (const key of [rate, burst]) {
      for (const value of ['-1', 'NaN', 'Infinity', 'bad']) {
        assert.throws(() => readConnectionLimitsEnv({ [key]: value }), new RegExp(key))
      }
      const config = readConnectionLimitsEnv({ [key]: '0' })
      const limits = createConnectionLimits({ ...config, concurrentPer56: 0, concurrentPer48: 0, maxSockets: 0 })
      for (let i = 0; i < 100; i++) {
        assert.equal(limits.admit({ key: `key-${i}`, parents: [`prefix::/${suffix}`] }).ok, true)
      }
    }
    assert.throws(() => readConnectionLimitsEnv({ [burst]: '0.5' }), new RegExp(burst))
    const config = readConnectionLimitsEnv({ [rate]: '12', [burst]: '24' })
    assert.equal(config[`ratePerMin${suffix}`], 12)
    assert.equal(config[`burst${suffix}`], 24)
  }
})

test('admit: rotating /64s exhausts /56 and /48 bursts, then refills at their own rates', () => {
  for (const [suffix, burst, interval] of [
    ['56', 40, 3000],
    ['48', 80, 1500],
  ]) {
    const { limits, c } = make()
    let i = 0
    const attempt = () => {
      const lease = limits.admit({ key: `key-${i++}`, parents: [`prefix::/${suffix}`] })
      if (lease.ok) lease.release()
      return lease.ok
    }
    for (let j = 0; j < burst; j++) assert.equal(attempt(), true)
    assert.equal(attempt(), false)
    c.tick(interval - 1)
    assert.equal(attempt(), false)
    c.tick(2) // allow for floating-point refill rounding
    assert.equal(attempt(), true)
    assert.equal(attempt(), false)
    c.tick(180000)
    for (let j = 0; j < burst; j++) assert.equal(attempt(), true)
    assert.equal(attempt(), false)
  }
})

test('admit: parent rate or concurrency refusals charge no address or parent bucket', () => {
  for (const concurrency of [false, true]) {
    const { limits, c } = make({
      burst: 1,
      ratePerMin56: 1,
      burst56: 1,
      ratePerMin48: 60,
      burst48: concurrency ? 10 : 1,
      concurrentPer48: concurrency ? 1 : 0,
    })
    const first = limits.admit({ key: 'first', parents: ['first::/56', 'shared::/48'] })
    assert.equal(first.ok, true)
    if (!concurrency) first.release()
    const candidate = { key: 'candidate', parents: ['candidate::/56', 'shared::/48'] }
    for (let i = 0; i < 50; i++) assert.equal(limits.admit(candidate).ok, false)
    assert.equal(limits.stats().tracked, 3, 'refused candidates create no partial entries')
    if (concurrency) first.release()
    else c.tick(1000)
    assert.equal(limits.admit(candidate).ok, true, 'earlier buckets retained their only token')
  }
  const { limits } = make({ burst: 1, burst56: 1, burst48: 2 })
  limits.admit({ key: 'first', parents: ['shared::/56', 'shared::/48'] }).release()
  for (let i = 0; i < 50; i++) {
    assert.equal(limits.admit({ key: 'refused', parents: ['shared::/56', 'shared::/48'] }).ok, false)
  }
  assert.equal(limits.admit({ key: 'other', parents: ['other::/56', 'shared::/48'] }).ok, true)
})

test('parent entries: shared table cap and idle purge preserve partially refilled and active buckets', () => {
  const { limits, c } = make({ maxEntries: 4 })
  const parents = ['prefix::/56', 'prefix::/48']
  const first = limits.admit({ key: 'a', parents })
  const second = limits.admit({ key: 'b', parents })
  assert.equal(first.ok && second.ok, true)
  assert.equal(limits.stats().tracked, 4)
  assert.deepEqual(limits.admit({ key: 'c', parents }), { ok: false, reason: 'busy' })
  first.release()
  second.release()
  assert.equal(limits.admit({ key: 'c', parents }).ok, false, 'unfilled buckets are retained')
  c.tick(6000)
  const next = limits.admit({ key: 'next', parents: ['next::/56', 'next::/48'] })
  assert.equal(next.ok, true, 'on-demand purge frees all three bucket levels')
  assert.equal(limits.stats().tracked, 3)
  c.tick(SWEEP_INTERVAL_MS)
  assert.equal(limits.admit({ key: 'ipv4' }).ok, true)
  assert.equal(limits.stats().tracked, 4, 'active parent entries survive the sweep')
  next.release()
  c.tick(SWEEP_INTERVAL_MS)
  limits.admit({ key: 'ipv4' })
  assert.equal(limits.stats().tracked, 1)
})

test('admit: reviewer /48 churn stays below burst plus 40 per minute', () => {
  let now = 0
  const limits = createConnectionLimits(defaults, { now: () => now })
  const live = []
  let admitted = 0
  let address = 0
  for (; now < 60000; now++) {
    while (live.length && live[0].end <= now) live.shift().release()
    while (live.length < 32) {
      const keys = clientIpKeys(`2001:db8:1:${(address++ % 65536).toString(16)}::1`)
      const lease = limits.admit(keys)
      if (!lease.ok) break
      admitted++
      live.push({ end: now + 20, release: lease.release })
    }
  }
  assert.ok(admitted >= 118 && admitted <= 120, `admitted ${admitted}`)
  assert.ok(limits.stats().tracked <= defaults.maxEntries)
})

// --- the places kept for ranked users (WS_RESERVED_SOCKETS): the ranked path, admit(origin, { user }) ---

test('kept places, settings: 4 for admins by default; 0 to 8 in digits, admin or builder; anything else throws', () => {
  assert.deepEqual(readReservedEnv({}), { reserved: 4, reservedRank: 2 })
  assert.deepEqual(readReservedEnv({ WS_RESERVED_SOCKETS: '', WS_RESERVED_RANK: '' }), { reserved: 4, reservedRank: 2 })
  assert.deepEqual(readReservedEnv({ WS_RESERVED_SOCKETS: '0' }), { reserved: 0, reservedRank: 2 })
  assert.deepEqual(readReservedEnv({ WS_RESERVED_SOCKETS: '8', WS_RESERVED_RANK: 'builder' }), {
    reserved: 8,
    reservedRank: 1,
  })
  assert.deepEqual(readReservedEnv({ WS_RESERVED_RANK: 'admin' }), { reserved: 4, reservedRank: 2 })
  for (const bad of ['-1', '1.5', ' 2', '2 ', '9', '10', 'two', '1e1', '0x2', '+2', 'Infinity']) {
    assert.throws(
      () => readReservedEnv({ WS_RESERVED_SOCKETS: bad }),
      /^Error: \[envs\] WS_RESERVED_SOCKETS must be a whole number from 0 to 8$/,
      bad
    )
    assert.throws(() => readConnectionLimitsEnv({ WS_RESERVED_SOCKETS: bad }), /WS_RESERVED_SOCKETS/, bad)
  }
  for (const bad of ['Admin', 'visitor', '2', ' admin']) {
    assert.throws(
      () => readReservedEnv({ WS_RESERVED_RANK: bad }),
      /^Error: \[envs\] WS_RESERVED_RANK must be admin or builder$/,
      bad
    )
  }
  // the cap is the join budget's room for ranked users past the last visitor: every kept place fits the snapshot
  assert.equal(RESERVED_MAX, RANKED_RESERVE_PLAYERS)
  assert.equal(RESERVED_PER_USER, 2)
})

test('kept places, in effect: none where admin is open to all; said at start-up, or why they have no effect', () => {
  const config = readConnectionLimitsEnv({})
  assert.deepEqual(keptPlacesInEffect(config, 'code'), { places: 4, rank: 2 })
  assert.deepEqual(keptPlacesInEffect(config, 'locked'), { places: 4, rank: 2 })
  assert.deepEqual(keptPlacesInEffect(config, 'open'), { places: 0, rank: 2 })
  assert.deepEqual(keptPlacesInEffect(readConnectionLimitsEnv({ WS_RESERVED_SOCKETS: '0' }), 'code'), {
    places: 0,
    rank: 2,
  })
  assert.deepEqual(keptPlacesNote(config, 'code'), {
    level: 'log',
    message:
      '[envs] 4 connections beyond WS_MAX_SOCKETS (64), and 4 players beyond playerLimit, are kept for users with a stored rank of admin',
  })
  assert.deepEqual(keptPlacesNote(config, 'open'), {
    level: 'warn',
    message:
      "[envs] WS_RESERVED_SOCKETS has no effect: admin is open to all (no ADMIN_CODE), so a place kept for admins would be anyone's",
  })
  assert.equal(
    keptPlacesNote(readConnectionLimitsEnv({ WS_RESERVED_RANK: 'builder', WS_MAX_SOCKETS: '0' }), 'locked').message,
    '[envs] 4 players beyond playerLimit are kept for users with a stored rank of builder or admin (WS_MAX_SOCKETS is 0: there is no cap on connections to keep places beyond)'
  )
  // 0: nothing to say, in any mode (as before there were kept places)
  for (const mode of ['code', 'open', 'locked']) {
    assert.equal(keptPlacesNote(readConnectionLimitsEnv({ WS_RESERVED_SOCKETS: '0' }), mode), null)
  }
})

test('kept places: at WS_MAX_SOCKETS a visitor is refused, ranked users fill exactly the kept places, and no more', () => {
  const { limits } = make({ maxSockets: 3, reserved: 2, ratePerMin: 0 })
  const held = [0, 1, 2].map(i => limits.admit({ key: `v${i}` }))
  assert.ok(held.every(lease => lease.ok))
  assert.deepEqual(limits.admit({ key: 'v3' }), { ok: false, reason: 'too many connections' }, 'a visitor at the cap')
  const a = limits.admit({ key: 'v3' }, { user: 'admin-a' })
  assert.equal(a.ok, true)
  assert.equal(a.ranked, true)
  assert.equal(a.user, 'admin-a')
  assert.equal(a.beyond, 1, 'one connection beyond WS_MAX_SOCKETS')
  const b = limits.admit({ key: 'x' }, { user: 'admin-b' })
  assert.deepEqual([b.ok, b.ranked, b.beyond], [true, true, 2])
  assert.deepEqual(
    limits.admit({ key: 'y' }, { user: 'admin-c' }),
    { ok: false, reason: 'too many connections' },
    'the kept places are in use: a third ranked user is refused'
  )
  assert.equal(limits.admit({ key: 'z' }).ok, false, 'and so is a visitor')
  assert.deepEqual(limits.stats(), { tracked: 3, active: 5, ranked: 2, users: 2 })
  // the refused ones made no entry and charged nothing
  a.release()
  const c = limits.admit({ key: 'y' }, { user: 'admin-c' })
  assert.equal(c.ok, true, 'a kept place freed is taken by the next ranked user')
  assert.equal(limits.stats().users, 3)
})

test('kept places: visitors never get one, and ranked users on them still count against visitors', () => {
  const { limits } = make({ maxSockets: 3, reserved: 2, ratePerMin: 0 })
  const held = [0, 1, 2].map(i => limits.admit({ key: `v${i}` }))
  const a = limits.admit({ key: 'a' }, { user: 'admin-a' })
  const b = limits.admit({ key: 'b' }, { user: 'admin-b' })
  assert.ok(a.ok && b.ok)
  // visitors who leave free visitors' places only once fewer than WS_MAX_SOCKETS are open in all
  held[0].release()
  assert.equal(limits.admit({ key: 'v9' }).ok, false, '4 open of 3')
  held[1].release()
  assert.equal(limits.admit({ key: 'v9' }).ok, false, '3 open (a visitor and two ranked users) is the cap: as before')
  held[2].release()
  const visitor = limits.admit({ key: 'v9' })
  assert.equal(visitor.ok, true, '2 open: a visitor again')
  assert.equal(visitor.ranked, undefined, 'on the address path')
  assert.equal(limits.admit({ key: 'v10' }).ok, false)
  // a user named on the ranked path is the caller's finding: without one, never the kept places
  for (const user of [undefined, null, '', 42, {}]) assert.equal(limits.admit({ key: 'v11' }, { user }).ok, false)
  assert.equal(limits.stats().users, 2)
})

test('kept places: the ranked path is a fallback; with room, a named user takes an address place as before', () => {
  const { limits } = make({ maxSockets: 3, reserved: 2, ratePerMin: 0 })
  const lease = limits.admit({ key: 'a' }, { user: 'admin' })
  assert.equal(lease.ok, true)
  assert.equal(lease.ranked, undefined)
  assert.deepEqual(limits.stats(), { tracked: 1, active: 1, ranked: 0, users: 0 })
  lease.release()
  assert.deepEqual(limits.stats(), { tracked: 1, active: 0, ranked: 0, users: 0 })
})

test('kept places: an admin behind a busy address is held to their own 2 instead of the address limits', () => {
  // no cap on connections: the ranked path is about the address only
  const { limits } = make({ maxSockets: 0, reserved: 2, ratePerMin: 0, concurrentPerIp: 2 })
  limits.admit({ key: 'shared' })
  limits.admit({ key: 'shared' })
  assert.equal(limits.admit({ key: 'shared' }).ok, false, 'the address is at its limit')
  const one = limits.admit({ key: 'shared' }, { user: 'admin' })
  const two = limits.admit({ key: 'shared' }, { user: 'admin' })
  assert.deepEqual([one.ok, one.ranked, one.beyond, two.ok], [true, true, 0, true])
  assert.equal(limits.admit({ key: 'shared' }, { user: 'admin' }).ok, false, 'a third of the same user')
  assert.equal(limits.admit({ key: 'elsewhere' }, { user: 'admin' }).ok, true, 'from another address: as before')
  assert.equal(limits.admit({ key: 'shared' }, { user: 'other-admin' }).ok, true, 'another user has their own 2')
  one.release()
  assert.equal(limits.admit({ key: 'shared' }, { user: 'admin' }).ok, true, 'one released, one more')
  // a table of addresses full of live entries is skipped too
  const full = make({ maxSockets: 0, reserved: 2, ratePerMin: 0, maxEntries: 1 })
  full.limits.admit({ key: 'first' })
  assert.deepEqual(full.limits.admit({ key: 'second' }), { ok: false, reason: 'busy' })
  assert.equal(full.limits.admit({ key: 'second' }, { user: 'admin' }).ok, true)
})

test('kept places: a user on the ranked path has the rate and burst of one address, under the user id', () => {
  const { limits, c } = make({ maxSockets: 1, reserved: 2, ratePerMin: 10, burst: 3 })
  limits.admit({ key: 'v' })
  let admitted = 0
  for (let i = 0; i < 10; i++) {
    const lease = limits.admit({ key: `k${i}` }, { user: 'admin' })
    if (lease.ok) {
      admitted++
      lease.release()
    }
  }
  assert.equal(admitted, 3, 'the burst, from ten addresses')
  c.tick(5_000)
  assert.equal(limits.admit({ key: 'k' }, { user: 'admin' }).ok, false, 'not yet')
  c.tick(1_001) // (a millisecond for the refill's floating-point rounding)
  const next = limits.admit({ key: 'k' }, { user: 'admin' })
  assert.equal(next.ok, true, 'one more 6 s after the burst')
  next.release()
  assert.equal(limits.admit({ key: 'k' }, { user: 'admin' }).ok, false)
  assert.equal(limits.admit({ key: 'k' }, { user: 'another' }).ok, true, "another user's bucket is their own")
})

test('kept places: a lease released twice is counted back once, and a refusal makes no user entry', () => {
  const { limits } = make({ maxSockets: 1, reserved: 1, ratePerMin: 0 })
  limits.admit({ key: 'v' })
  const lease = limits.admit({ key: 'a' }, { user: 'admin' })
  // (the ranked path charges no address: 'a' is not in the table)
  assert.deepEqual(limits.stats(), { tracked: 1, active: 2, ranked: 1, users: 1 })
  // refused: the kept place is in use. No entry is made for that user
  assert.equal(limits.admit({ key: 'b' }, { user: 'other' }).ok, false)
  assert.equal(limits.stats().users, 1)
  lease.release()
  lease.release()
  assert.deepEqual(limits.stats(), { tracked: 1, active: 1, ranked: 0, users: 1 })
  // the user's own count went back once: two more fit (the kept place one at a time)
  const again = limits.admit({ key: 'a' }, { user: 'admin' })
  assert.equal(again.ok, true)
  again.release()
  const twoOfThem = make({ maxSockets: 0, reserved: 1, ratePerMin: 0, concurrentPerIp: 1 })
  twoOfThem.limits.admit({ key: 'busy' })
  const first = twoOfThem.limits.admit({ key: 'busy' }, { user: 'admin' })
  first.release()
  first.release()
  const both = [0, 1].map(() => twoOfThem.limits.admit({ key: 'busy' }, { user: 'admin' }))
  assert.ok(
    both.every(l => l.ok),
    "a double release does not take a place from the user's own 2"
  )
  assert.equal(twoOfThem.limits.admit({ key: 'busy' }, { user: 'admin' }).ok, false)
})

test('kept places: an idle user entry is swept as the addresses are; an open one or a refilling one stays', () => {
  const { limits, c } = make({ maxSockets: 1, reserved: 2, ratePerMin: 10, burst: 20 })
  limits.admit({ key: 'v' })
  const open = limits.admit({ key: 'a' }, { user: 'open' })
  limits.admit({ key: 'b' }, { user: 'gone' }).release()
  assert.equal(limits.stats().users, 2)
  c.tick(SWEEP_INTERVAL_MS)
  limits.admit({ key: 'v' }) // sweeps: 'gone' holds 19 + 10 tokens again (full), 'open' has a connection open
  assert.equal(limits.stats().users, 1)
  open.release()
  c.tick(SWEEP_INTERVAL_MS)
  limits.admit({ key: 'v' })
  assert.equal(limits.stats().users, 0)
})

test('kept places: WS_RESERVED_SOCKETS=0 admits as before there were any', () => {
  const { limits } = make({ maxSockets: 1, reserved: 0, ratePerMin: 0, concurrentPerIp: 1 })
  limits.admit({ key: 'v' })
  assert.deepEqual(limits.admit({ key: 'a' }, { user: 'admin' }), { ok: false, reason: 'too many connections' })
  const busy = make({ maxSockets: 0, reserved: 0, ratePerMin: 0, concurrentPerIp: 1 })
  busy.limits.admit({ key: 'shared' })
  assert.equal(busy.limits.admit({ key: 'shared' }, { user: 'admin' }).ok, false, 'nor past an address limit')
  assert.deepEqual(limits.stats(), { tracked: 1, active: 1, ranked: 0, users: 0 })
})
