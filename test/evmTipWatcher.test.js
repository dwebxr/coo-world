import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RpcError } from '../src/server/evmRpc.js'
import { createTipWatcher } from '../src/server/evmTipWatcher.js'
import { TRANSFER_TOPIC, encodeAddressWord, encodeUintWord } from '../src/core/extras/evmAbi.js'
import { KNOWN_TOKENS } from '../src/core/extras/evmTokens.js'

const JPYC = KNOWN_TOKENS[137].JPYC
const from = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a'
const recipient = '0x1563915e194d8cfba1943570603f7606a3115508'
const units = 100n * 10n ** 18n
const txHash = `0x${'ab'.repeat(32)}`
const blockHash = `0x${'cd'.repeat(32)}`
const otherHash = `0x${'ee'.repeat(32)}`

const receiptFor = (patch = {}) => ({
  transactionHash: txHash,
  status: '0x1',
  blockNumber: '0x10',
  blockHash,
  logs: [
    {
      address: JPYC.address.toLowerCase(),
      topics: [TRANSFER_TOPIC, `0x${encodeAddressWord(from)}`, `0x${encodeAddressWord(recipient)}`],
      data: `0x${encodeUintWord(units)}`,
      logIndex: '0x0',
    },
  ],
  ...patch,
})
const blockAt = (patch = {}) => ({ number: '0x10', hash: blockHash, timestamp: '0x3e8', ...patch })

// A manual clock with timers, and a fake RPC whose answers the test can change between steps.
function setup({ answers = {}, options = {}, live = () => true } = {}) {
  let clock = 0
  const timers = new Set()
  const setTimeout = (fn, ms) => {
    const timer = { at: clock + ms, fn }
    timers.add(timer)
    return timer
  }
  const clearTimeout = timer => timers.delete(timer)
  const calls = []
  const signals = []
  const state = {
    receipt: null,
    finalized: { number: '0x0' },
    block: blockAt(),
    tx: { hash: txHash },
    ...answers,
  }
  const rpc = {
    async call(method, params, signal) {
      calls.push([method, ...params])
      signals.push(signal)
      if (state.hang) return new Promise(() => {})
      if (state.hangFinalized && params[0] === 'finalized') return new Promise(() => {})
      const value =
        method === 'eth_getTransactionReceipt'
          ? state.receipts
            ? (state.receipts[params[0]] ?? null)
            : state.receipt
          : method === 'eth_getTransactionByHash'
            ? state.tx
            : method === 'eth_getBlockByNumber' && params[0] === 'finalized'
              ? state.finalized
              : method === 'eth_getBlockByNumber'
                ? state.block
                : undefined
      if (value instanceof Error) throw value
      signal?.throwIfAborted()
      return value
    },
  }
  const lines = []
  const watcher = createTipWatcher({
    rpc,
    now: () => clock,
    setTimeout,
    clearTimeout,
    log: { error: line => lines.push(String(line)) },
    ...options,
  })
  const results = []
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  }
  // advance the clock in 1 s steps, running due timers and letting the async steps settle
  const advance = async ms => {
    const end = clock + ms
    while (clock < end) {
      clock = Math.min(end, clock + 1000)
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > clock || !timers.has(timer)) continue
        timers.delete(timer)
        timer.fn()
      }
      await flush()
    }
  }
  const job = (patch = {}) => ({
    txHash,
    from,
    recipient,
    token: JPYC.address,
    units,
    notBeforeSec: 900,
    isLive: live,
    onDone: result => results.push(result),
    ...patch,
  })
  return { watcher, state, calls, signals, results, lines, advance, flush, job, timers, now: () => clock }
}

const count = (calls, method, arg) => calls.filter(c => c[0] === method && (arg === undefined || c[1] === arg)).length

test('tip watcher: pending, then a matching receipt, then finality confirms once', async () => {
  const t = setup()
  t.watcher.watch(t.job())
  await t.advance(4000)
  assert.equal(t.results.length, 0, 'still pending')
  t.state.receipt = receiptFor()
  await t.advance(3000)
  assert.equal(t.results.length, 0, 'matched but not final')
  t.state.finalized = { number: '0x10' }
  await t.advance(6000)
  assert.deepEqual(t.results, [{ state: 'confirmed' }])
  assert.ok(Object.isFrozen(t.results[0]))
  assert.equal(t.watcher.size(), 0)
  assert.equal(t.timers.size, 0, 'the loop stops when idle')
  // the block at the receipt height was fetched by number
  assert.ok(t.calls.some(c => c[0] === 'eth_getBlockByNumber' && c[1] === '0x10'))
})

test('tip watcher: the finalized block is fetched once per tick for all waiting jobs', async () => {
  const t = setup({ answers: { receipt: receiptFor() } })
  // two jobs for the same transaction (eg two tickets); both wait for finality
  t.watcher.watch(t.job())
  t.watcher.watch(t.job())
  await t.advance(1000)
  const before = count(t.calls, 'eth_getBlockByNumber', 'finalized')
  await t.advance(1000)
  const after = count(t.calls, 'eth_getBlockByNumber', 'finalized')
  assert.ok(after - before <= 1, `one finalized read per tick, got ${after - before}`)
})

test('tip watcher: a reorg at the receipt height goes back to the receipt, a block before the ticket fails', async () => {
  const t = setup({ answers: { receipt: receiptFor(), finalized: { number: '0x20' } } })
  t.state.block = blockAt({ hash: otherHash })
  t.watcher.watch(t.job())
  await t.advance(2000)
  assert.equal(t.results.length, 0, 'reorged: not confirmed')
  t.state.receipt = receiptFor({ blockHash: otherHash })
  await t.advance(8000)
  assert.deepEqual(t.results, [{ state: 'confirmed' }])

  const old = setup({ answers: { receipt: receiptFor(), finalized: { number: '0x20' } } })
  old.watcher.watch(old.job({ notBeforeSec: 1001 }))
  await old.advance(3000)
  assert.deepEqual(old.results, [{ state: 'failed', reason: 'too_old' }])
})

test('tip watcher: reverted and missing transfers fail; a malformed receipt is retried', async () => {
  const reverted = setup({ answers: { receipt: receiptFor({ status: '0x0' }) } })
  reverted.watcher.watch(reverted.job())
  await reverted.advance(1000)
  assert.deepEqual(reverted.results, [{ state: 'failed', reason: 'reverted' }])

  const elsewhere = setup({ answers: { receipt: receiptFor({ logs: [] }) } })
  elsewhere.watcher.watch(elsewhere.job())
  await elsewhere.advance(1000)
  assert.deepEqual(elsewhere.results, [{ state: 'failed', reason: 'no_transfer' }])

  const malformed = setup({ answers: { receipt: receiptFor({ transactionHash: otherHash }) } })
  malformed.watcher.watch(malformed.job())
  await malformed.advance(10_000)
  assert.equal(malformed.results.length, 0, 'not a failure of the tip')
  assert.ok(count(malformed.calls, 'eth_getTransactionReceipt') >= 3, 'asked again')
})

test('tip watcher: only a JSON-RPC error makes finality unavailable; transport failures are retried', async () => {
  const flaky = setup({ answers: { receipt: receiptFor(), finalized: new Error('socket hang up') } })
  flaky.watcher.watch(flaky.job())
  await flaky.advance(5000)
  assert.equal(flaky.results.length, 0, 'transport failure: keep trying')
  flaky.state.finalized = { number: '0x10' }
  await flaky.advance(4000)
  assert.deepEqual(flaky.results, [{ state: 'confirmed' }])

  const unsupported = setup({ answers: { receipt: receiptFor(), finalized: new RpcError(-32602) } })
  assert.equal(unsupported.watcher.canConfirm(), true, 'nothing known against the RPC yet')
  unsupported.watcher.watch(unsupported.job())
  unsupported.watcher.watch(unsupported.job())
  await unsupported.advance(2000)
  assert.equal(unsupported.watcher.canConfirm(), false, 'the world stops saying that it confirms tips')
  assert.deepEqual(unsupported.results, [
    { state: 'unverified', reason: 'no_finality' },
    { state: 'unverified', reason: 'no_finality' },
  ])
  assert.equal(unsupported.lines.length, 1, 'logged once')

  // a non-null block without a number is the same; it is asked again after a minute
  const malformed = setup({ answers: { receipt: receiptFor(), finalized: { hash: blockHash } } })
  malformed.watcher.watch(malformed.job())
  await malformed.advance(2000)
  assert.deepEqual(malformed.results, [{ state: 'unverified', reason: 'no_finality' }])
  const asked = count(malformed.calls, 'eth_getBlockByNumber', 'finalized')
  malformed.state.finalized = { number: '0x10' }
  malformed.watcher.watch(malformed.job())
  await malformed.advance(2000)
  assert.equal(count(malformed.calls, 'eth_getBlockByNumber', 'finalized'), asked, 'not asked again yet')
  assert.equal(malformed.results.at(-1).reason, 'no_finality')
  // after a minute the tag is tried again
  await malformed.advance(60_000)
  assert.equal(malformed.watcher.canConfirm(), false, 'time alone does not change the answer')
  malformed.watcher.watch(malformed.job())
  await malformed.advance(4000)
  assert.deepEqual(malformed.results.at(-1), { state: 'confirmed' })
  assert.equal(malformed.watcher.canConfirm(), true, 'a read of the tag that worked does')
  malformed.watcher.stop()
  assert.equal(malformed.watcher.canConfirm(), false, 'a stopped watcher confirms nothing')
})

test('tip watcher: an unknown transaction stops early; a known pending one times out', async () => {
  const unknown = setup({ answers: { tx: null } })
  unknown.watcher.watch(unknown.job())
  await unknown.advance(59_000)
  assert.equal(unknown.results.length, 0)
  assert.equal(count(unknown.calls, 'eth_getTransactionByHash'), 0, 'not before a minute')
  await unknown.advance(12_000)
  assert.deepEqual(unknown.results, [{ state: 'unverified', reason: 'not_found' }])

  const stuck = setup()
  stuck.watcher.watch(stuck.job())
  await stuck.advance(179_000)
  assert.equal(stuck.results.length, 0)
  assert.equal(count(stuck.calls, 'eth_getTransactionByHash'), 1, 'looked up once')
  await stuck.advance(2000)
  assert.deepEqual(stuck.results, [{ state: 'unverified', reason: 'timeout' }])
  // backoff: every 3 s for 30 s, then every 10 s
  const polls = count(stuck.calls, 'eth_getTransactionReceipt')
  assert.ok(polls >= 20 && polls <= 30, `polls ${polls}`)
})

test('tip watcher: the RPC budget is shared and never exceeded; starved jobs time out', async () => {
  const t = setup({ options: { ratePerSecond: 0.1, burst: 2 } })
  for (let i = 0; i < 5; i++) t.watcher.watch(t.job({ txHash: `0x${String(i).repeat(64)}` }))
  await t.advance(181_000)
  assert.equal(t.results.length, 5)
  assert.ok(t.results.every(r => r.state === 'unverified' && r.reason === 'timeout'))
  assert.ok(t.calls.length <= 2 + 19, `calls ${t.calls.length}`)
})

test('tip watcher: a job whose sender left ends as left; cancel and stop end jobs without a result', async () => {
  let live = true
  const t = setup({ live: () => live })
  t.watcher.watch(t.job())
  await t.advance(1000)
  live = false
  await t.advance(1000)
  assert.deepEqual(t.results, [{ state: 'unverified', reason: 'left' }])

  const c = setup()
  c.watcher.watch(c.job({ tag: 'a' }))
  c.watcher.watch(c.job({ tag: 'b' }))
  c.watcher.cancel(job => job.tag === 'a')
  assert.equal(c.watcher.size(), 1)
  c.watcher.cancel(() => true)
  await c.advance(5000)
  assert.equal(c.results.length, 0)

  // stop while a call is in flight: the late answer is ignored and nothing is scheduled again
  const s = setup({ answers: { hang: true } })
  s.watcher.watch(s.job())
  await s.advance(1000)
  s.watcher.stop()
  s.state.hang = false
  await s.advance(10_000)
  assert.equal(s.results.length, 0)
  assert.equal(s.timers.size, 0)
  assert.equal(s.watcher.watch(s.job()), false, 'no new jobs after stop')
})

test('tip watcher: a hung call is aborted at its deadline and its slot is kept until it settles', async () => {
  let release
  const settled = new Promise(resolve => (release = resolve))
  let aborted = 0
  let started = 0
  const t = setup({ options: { maxConcurrentCalls: 1 } })
  t.state.hang = false
  const rpcCall = async (method, params, signal) => {
    started++
    signal.addEventListener('abort', () => aborted++)
    await settled
    throw new Error('aborted')
  }
  const watcher = createTipWatcher({
    rpc: { call: rpcCall },
    now: t.now,
    setTimeout: (fn, ms) => {
      const timer = { at: t.now() + ms, fn }
      t.timers.add(timer)
      return timer
    },
    clearTimeout: timer => t.timers.delete(timer),
    log: { error() {} },
    maxConcurrentCalls: 1,
  })
  const results = []
  watcher.watch(t.job({ onDone: r => results.push(r) }))
  watcher.watch(t.job({ txHash: otherHash, onDone: r => results.push(r) }))
  await t.advance(6000)
  assert.equal(aborted, 1, 'aborted at 5 s')
  assert.equal(started, 1, 'the aborted call still holds the only slot')
  release()
  await t.flush()
  await t.advance(3000)
  assert.ok(started >= 2, 'the slot is free once the call settled')
  watcher.stop()
})

test('tip watcher: with the default budget a job is never starved by the jobs before it', async () => {
  const hashes = Array.from({ length: 5 }, (_, i) => `0x${String(i + 1).repeat(64)}`)
  const t = setup({ answers: { finalized: { number: '0x10' } } })
  // only the last job's transaction is mined; the four before it stay pending and keep asking
  t.state.receipts = { [hashes[4]]: receiptFor({ transactionHash: hashes[4] }) }
  for (const hash of hashes) t.watcher.watch(t.job({ txHash: hash }))
  await t.advance(10_000)
  assert.deepEqual(t.results, [{ state: 'confirmed' }])
  assert.ok(count(t.calls, 'eth_getTransactionReceipt', hashes[4]) >= 1)
})

test('tip watcher: a null finalized block is retried, not taken as an unsupported tag', async () => {
  const t = setup({ answers: { receipt: receiptFor(), finalized: null } })
  t.watcher.watch(t.job())
  await t.advance(6000)
  assert.equal(t.results.length, 0, 'still waiting')
  assert.equal(t.lines.length, 0, 'nothing logged')
  assert.equal(t.watcher.canConfirm(), true, 'a chain with no finalized block yet is not an RPC without the tag')
  t.state.finalized = { number: '0x10' }
  await t.advance(4000)
  assert.deepEqual(t.results, [{ state: 'confirmed' }])
})

test('tip watcher: stop aborts a finalized-block read in flight', async () => {
  const t = setup({ answers: { receipt: receiptFor(), hangFinalized: true } })
  t.watcher.watch(t.job())
  await t.advance(2000)
  const finalizedIndex = t.calls.findIndex(c => c[0] === 'eth_getBlockByNumber' && c[1] === 'finalized')
  assert.ok(finalizedIndex >= 0, 'finality asked')
  const signal = t.signals[finalizedIndex]
  assert.equal(signal.aborted, false)
  t.watcher.stop()
  assert.equal(signal.aborted, true)
  assert.equal(t.results.length, 0)
})
