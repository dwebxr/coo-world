import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTokenBalanceService, parseTokenBalanceTtlMs } from '../src/server/tokenBalance.js'

const unknown = { known: false }
const known = balance => ({ known: true, balance })
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const calls = []
  const service = createTokenBalanceService({
    decimals: 6,
    ttlMs: 30_000,
    readRaw(wallet, signal) {
      const deferred = Promise.withResolvers()
      calls.push({ wallet, signal, ...deferred })
      return deferred.promise
    },
    ...options,
  })
  return {
    ...service,
    calls,
    async tick(ms) {
      t.mock.timers.tick(ms)
      await flush()
    },
    async finish(index, amount = 1_000_000n) {
      calls[index].resolve({ exists: true, amount })
      await flush()
    },
  }
}

test('cache: TTL and non-fresh join', async t => {
  const f = fixture(t)
  const first = f.get('a')
  const joined = f.get('a')
  assert.equal(f.calls.length, 1)
  await f.finish(0, 1_250_000n)
  assert.deepEqual(await first, known(1.25))
  assert.deepEqual(await joined, known(1.25))
  const cached = await f.get('a')
  cached.balance = 999
  await f.tick(29_999)
  assert.deepEqual(await f.get('a'), known(1.25))
  assert.equal(f.calls.length, 1)
  await f.tick(1)
  const expired = f.get('a')
  assert.equal(f.calls.length, 2)
  await f.finish(1, 2_000_000n)
  assert.deepEqual(await expired, known(2))
})

test('cache: negative TTL suppresses retries', async t => {
  const f = fixture(t)
  const first = f.get('a')
  f.calls[0].reject(new Error('RPC failure'))
  assert.deepEqual(await first, unknown)
  assert.deepEqual(await f.get('a'), unknown)
  await f.tick(4999)
  assert.deepEqual(await f.get('a'), unknown)
  assert.equal(f.calls.length, 1)
  await f.tick(1)
  const retried = f.get('a')
  assert.equal(f.calls.length, 2)
  await f.finish(1)
  assert.deepEqual(await retried, known(1))
})

test('fresh: cache bypass', async t => {
  const f = fixture(t)
  const first = f.get('a')
  await f.finish(0)
  await first
  const fresh = f.get('a', { fresh: true })
  assert.equal(f.calls.length, 2)
  assert.deepEqual(await f.get('a'), known(1), 'cache precedes joining the fresh operation')
  await f.finish(1, 2_000_000n)
  assert.deepEqual(await fresh, known(2))
})

test('fresh: snapshotted batches never overlap', async t => {
  const f = fixture(t)
  const predecessor = f.get('a')
  const batch1 = [f.get('a', { fresh: true }), f.get('a', { fresh: true })]
  assert.equal(f.calls.length, 1)
  await f.finish(0)
  assert.deepEqual(await predecessor, known(1))
  assert.equal(f.calls.length, 2)
  const batch2 = [f.get('a', { fresh: true }), f.get('a', { fresh: true })]
  let laterSettled = false
  batch2[0].then(() => {
    laterSettled = true
  })
  assert.equal(f.calls.length, 2)
  await f.finish(1, 2_000_000n)
  assert.deepEqual(await Promise.all(batch1), [known(2), known(2)])
  assert.equal(laterSettled, false)
  assert.equal(f.calls.length, 3)
  await f.finish(2, 3_000_000n)
  assert.deepEqual(await Promise.all(batch2), [known(3), known(3)])
  assert.deepEqual(await f.get('a'), known(3))
})

test('fresh: failed predecessor still starts the waiter batch', async t => {
  const f = fixture(t)
  const predecessor = f.get('a')
  const fresh = f.get('a', { fresh: true })
  f.calls[0].reject(new Error('RPC failure'))
  await flush()
  assert.deepEqual(await predecessor, unknown)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(await f.get('a'), unknown, 'negative cache precedes a running operation')
  await f.finish(1)
  assert.deepEqual(await fresh, known(1))
  assert.deepEqual(await f.get('a'), known(1), 'success clears the negative cache')
})

test('fresh: rich cache with exhausted budget (C1)', async t => {
  const f = fixture(t, { burst: 1, ratePerSecond: 0 })
  const first = f.get('rich')
  const queued = f.get('rich', { fresh: true })
  await f.finish(0, 20_000_000_000n)
  assert.deepEqual(await first, known(20_000))
  assert.deepEqual(await queued, unknown, 'follow-up admission must not fall back to the rich cache')
  assert.deepEqual(await f.get('rich', { fresh: true }), unknown)
  assert.deepEqual(await f.get('rich'), known(20_000))
  assert.equal(f.calls.length, 1)
})

test('budget: concurrency has no stale fallback or queue', async t => {
  const f = fixture(t, { maxConcurrent: 1, ttlMs: 100 })
  const cached = f.get('rich')
  await f.finish(0, 20_000_000_000n)
  await cached
  const busy = f.get('busy')
  assert.deepEqual(await f.get('rich', { fresh: true }), unknown)
  await f.tick(100)
  assert.deepEqual(await f.get('rich'), unknown)
  assert.deepEqual(await f.get('other'), unknown)
  assert.equal(f.calls.length, 2)
  await f.finish(1)
  await busy
  assert.equal(f.calls.length, 2, 'budget-denied callers are not queued')
  const admitted = f.get('other')
  await f.finish(2)
  assert.deepEqual(await admitted, known(1))
})

test('budget: bucket exhaustion and refill', async t => {
  const f = fixture(t, { burst: 2, ratePerSecond: 1, ttlMs: 100 })
  const a = f.get('a')
  const b = f.get('b')
  assert.deepEqual(await f.get('c'), unknown)
  await f.finish(0)
  await f.finish(1)
  await Promise.all([a, b])
  await f.tick(999)
  assert.deepEqual(await f.get('a'), unknown, 'an expired cache cannot bypass bucket exhaustion')
  await f.tick(1)
  const c = f.get('c')
  await f.finish(2)
  assert.deepEqual(await c, known(1))
  assert.deepEqual(await f.get('d'), unknown)
  await f.tick(10_000)
  const e = f.get('e')
  const g = f.get('g')
  assert.deepEqual(await f.get('h'), unknown, 'refill is capped at burst')
  await f.finish(3)
  await f.finish(4)
  await Promise.all([e, g])
})

for (const cached of [false, true]) {
  test(`timeout: waiters, zombies and cache precedence (cached=${cached})`, async t => {
    const f = fixture(t)
    if (cached) {
      const seed = f.get('a')
      await f.finish(0, 20_000_000_000n)
      await seed
    }
    const index = f.calls.length
    const predecessor = f.get('a', { fresh: true })
    const waiters = [f.get('a', { fresh: true }), f.get('a', { fresh: true })]
    await f.tick(4999)
    assert.equal(f.calls[index].signal.aborted, false)
    await f.tick(1)
    assert.deepEqual(await predecessor, unknown)
    assert.deepEqual(await Promise.all(waiters), [unknown, unknown])
    assert.equal(f.calls[index].signal.aborted, true)
    assert.deepEqual(await f.get('a', { fresh: true }), unknown)
    assert.deepEqual(await f.get('a'), cached ? known(20_000) : unknown)
    await f.tick(5000)
    assert.deepEqual(await f.get('a'), cached ? known(20_000) : unknown)
    assert.deepEqual(await f.get('a', { fresh: true }), unknown)
    await f.tick(20_000)
    assert.deepEqual(await f.get('a'), unknown, 'zombie remains after both caches expire')
    assert.equal(f.calls.length, index + 1)
    await f.finish(index, 999_000_000n)
    assert.equal(f.calls.length, index + 1, 'timed-out waiters never start a follow-up')
    const retry = f.get('a')
    assert.equal(f.calls.length, index + 2)
    await f.finish(index + 1, 2_000_000n)
    assert.deepEqual(await retry, known(2), 'late result did not populate the cache')
  })
}

test('caller: fresh batches stay within 10s', async t => {
  const f = fixture(t)
  const predecessor = f.get('a')
  const fresh = f.get('a', { fresh: true })
  let freshAt
  fresh.then(() => {
    freshAt = Date.now()
  })
  await f.tick(4999)
  await f.finish(0)
  await predecessor
  assert.equal(f.calls.length, 2)
  const joined = f.get('a', { fresh: true })
  await f.tick(4999)
  assert.equal(freshAt, undefined)
  await f.tick(1)
  assert.deepEqual(await fresh, unknown)
  assert.deepEqual(await joined, unknown)
  assert.equal(freshAt, 9999)
  assert.equal(f.calls[1].signal.aborted, true)
})

test('caller: independent 10s timer survives a delayed operation timer', async t => {
  const f = fixture(t, {
    // Fault injection: delay only the RPC timer to exercise the independent caller bound.
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms === 5000 ? 20_000 : ms),
  })
  const running = f.get('a')
  const joined = f.get('a')
  const fresh = f.get('a', { fresh: true })
  let resolved = 0
  for (const promise of [running, joined, fresh]) promise.then(() => resolved++)
  await f.tick(9999)
  assert.equal(resolved, 0)
  await f.tick(1)
  assert.deepEqual(await Promise.all([running, joined, fresh]), [unknown, unknown, unknown])
  assert.equal(resolved, 3)
  await f.finish(0)
  assert.equal(f.calls.length, 1, 'expired fresh callers have been removed from the queue')
})

test('deadline: abort, held slot and discarded late success', async t => {
  const f = fixture(t, { maxConcurrent: 1 })
  const first = f.get('a')
  const joined = f.get('a')
  assert.ok(f.calls[0].signal instanceof AbortSignal)
  await f.tick(5000)
  assert.deepEqual(await first, unknown)
  assert.deepEqual(await joined, unknown)
  assert.equal(f.calls[0].signal.aborted, true)
  assert.deepEqual(await f.get('b'), unknown, 'aborting an uncooperative read does not free its slot')
  await f.finish(0, 20_000_000_000n)
  assert.deepEqual(await f.get('a'), unknown, 'negative cache survives late success')
  const b = f.get('b')
  await f.finish(1)
  assert.deepEqual(await b, known(1))
  await f.tick(5000)
  const retry = f.get('a')
  assert.equal(f.calls.length, 3)
  await f.finish(2, 2_000_000n)
  assert.deepEqual(await retry, known(2))
})

test('deadline: late rejection releases the slot without renewing negative cache', async t => {
  const f = fixture(t, { maxConcurrent: 1 })
  const first = f.get('a')
  await f.tick(5000)
  assert.deepEqual(await first, unknown)
  await f.tick(5000)
  f.calls[0].reject(new Error('late abort'))
  await flush()
  const retry = f.get('a')
  assert.equal(f.calls.length, 2)
  await f.finish(1)
  assert.deepEqual(await retry, known(1))
})

test('data: missing account is known zero', async t => {
  const f = fixture(t)
  const result = f.get('a')
  f.calls[0].resolve({ exists: false })
  assert.deepEqual(await result, known(0))
  assert.deepEqual(await f.get('a'), known(0))
})

for (const [name, raw] of [
  ['negative', { exists: true, amount: -1n }],
  ['non-finite', { exists: true, amount: 10n ** 400n }],
  ['number amount', { exists: true, amount: 1 }],
  ['missing amount', { exists: true }],
  ['missing exists', { amount: 1n }],
  ['null', null],
]) {
  test(`data: rejects ${name}`, async t => {
    const f = fixture(t)
    const result = f.get('a')
    f.calls[0].resolve(raw)
    assert.deepEqual(await result, unknown)
    assert.deepEqual(await f.get('a'), unknown)
    assert.equal(f.calls.length, 1)
  })
}

test('data: synchronous throws fail closed and release the slot', async t => {
  let calls = 0
  const f = fixture(t, {
    maxConcurrent: 1,
    readRaw() {
      calls++
      throw new Error('synchronous failure')
    },
  })
  assert.deepEqual(await f.get('a'), unknown)
  assert.deepEqual(await f.get('a'), unknown)
  assert.deepEqual(await f.get('b'), unknown)
  assert.equal(calls, 2)
})

test('data: decimals validate 0..18 with one boot warning', async () => {
  for (const decimals of [0, 6, 18, '0', '6', '18']) {
    const service = createTokenBalanceService({
      decimals,
      readRaw: async () => ({ exists: true, amount: 10n ** BigInt(decimals) }),
      log: { warn: () => assert.fail('valid decimals warned') },
    })
    assert.deepEqual(await service.get('a'), known(1))
  }
  for (const decimals of [-1, 19, 1.5, Infinity, NaN, '', '6x', null, true, {}, '1e1']) {
    const warnings = []
    const service = createTokenBalanceService({
      decimals,
      readRaw: async () => ({ exists: true, amount: 1_000_000n }),
      log: { warn: message => warnings.push(message) },
    })
    assert.equal(warnings.length, 1, 'invalid decimals warn at construction')
    assert.deepEqual(await service.get('a'), known(1))
    assert.deepEqual(await service.get('b'), known(1))
    assert.equal(warnings.length, 1)
  }
})

test('config: TTL parses integer seconds 1..300', () => {
  for (const [value, expected] of [
    [1, 1000],
    ['1', 1000],
    ['30', 30_000],
    [300, 300_000],
    ['300', 300_000],
  ]) {
    assert.equal(parseTokenBalanceTtlMs(value), expected)
  }
  for (const value of [null, '', ' ', '30x', '1e2', '1.0', -1, 0, 301, 1.5, Infinity, NaN, true, {}]) {
    assert.equal(parseTokenBalanceTtlMs(value), 30_000)
  }
})

test('config: environment defaults and TTL are applied at construction', async t => {
  const before = {
    decimals: process.env.PUBLIC_TOKEN_DECIMALS,
    ttl: process.env.TOKEN_BALANCE_TTL_SECONDS,
  }
  t.after(() => {
    for (const [key, value] of [
      ['PUBLIC_TOKEN_DECIMALS', before.decimals],
      ['TOKEN_BALANCE_TTL_SECONDS', before.ttl],
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  delete process.env.PUBLIC_TOKEN_DECIMALS
  delete process.env.TOKEN_BALANCE_TTL_SECONDS
  assert.equal(parseTokenBalanceTtlMs(), 30_000)
  const defaults = fixture(t, {
    decimals: undefined,
    ttlMs: undefined,
    log: { warn: () => assert.fail('absent decimals should use the default silently') },
  })
  const first = defaults.get('a')
  await defaults.finish(0)
  assert.deepEqual(await first, known(1))
  await defaults.tick(29_999)
  assert.deepEqual(await defaults.get('a'), known(1))
  await defaults.tick(1)
  const expired = defaults.get('a')
  assert.equal(defaults.calls.length, 2)
  await defaults.finish(1)
  await expired

  process.env.PUBLIC_TOKEN_DECIMALS = '2'
  process.env.TOKEN_BALANCE_TTL_SECONDS = '1'
  let calls = 0
  const configured = createTokenBalanceService({
    readRaw: async () => {
      calls++
      return { exists: true, amount: 100n }
    },
  })
  assert.equal(parseTokenBalanceTtlMs(), 1000)
  assert.deepEqual(await configured.get('a'), known(1))
  await defaults.tick(999)
  assert.deepEqual(await configured.get('a'), known(1))
  assert.equal(calls, 1)
  await defaults.tick(1)
  assert.deepEqual(await configured.get('a'), known(1))
  assert.equal(calls, 2)
})

test('eviction: oldest idle entry is evicted while ops and waiters stay pinned', async t => {
  const f = fixture(t, { maxEntries: 3 })
  const pinned = f.get('pinned')
  const fresh = f.get('pinned', { fresh: true })
  const oldest = f.get('oldest')
  await f.finish(1)
  await oldest
  const newest = f.get('newest')
  await f.finish(2)
  await newest
  const replacement = f.get('replacement')
  assert.equal(f.calls[3].wallet, 'replacement')
  assert.deepEqual(await f.get('newest'), known(1))
  const joined = f.get('pinned')
  assert.equal(f.calls.length, 4)
  await f.finish(0)
  assert.deepEqual(await pinned, known(1))
  assert.deepEqual(await joined, known(1))
  assert.equal(f.calls[4].wallet, 'pinned', 'waiter batch retains the same entry')
  await f.finish(4, 2_000_000n)
  assert.deepEqual(await fresh, known(2))
  await f.finish(3)
  await replacement
  const evicted = f.get('oldest')
  assert.equal(f.calls[5].wallet, 'oldest')
  await f.finish(5)
  await evicted
})

test('eviction: all pinned gives unknown, including zombies', async t => {
  const f = fixture(t, { maxEntries: 1 })
  const first = f.get('a')
  const fresh = f.get('a', { fresh: true })
  assert.deepEqual(await f.get('b'), unknown)
  const joined = f.get('a')
  assert.equal(f.calls.length, 1)
  await f.tick(5000)
  assert.deepEqual(await Promise.all([first, fresh, joined]), [unknown, unknown, unknown])
  assert.deepEqual(await f.get('b'), unknown)
  assert.deepEqual(await f.get('a', { fresh: true }), unknown)
  await f.finish(0)
  const replacement = f.get('b')
  assert.equal(f.calls.length, 2)
  await f.finish(1)
  assert.deepEqual(await replacement, known(1))
})
