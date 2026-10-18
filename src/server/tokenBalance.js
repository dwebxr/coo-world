const UNKNOWN = Object.freeze({ known: false })

function integer(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return NaN
  const number = Number(value)
  return Number.isInteger(number) ? number : NaN
}

export function parseTokenBalanceTtlMs(value = process.env.TOKEN_BALANCE_TTL_SECONDS) {
  const seconds = integer(value)
  return (seconds >= 1 && seconds <= 300 ? seconds : 30) * 1000
}

export function createTokenBalanceService({
  readRaw,
  decimals = process.env.PUBLIC_TOKEN_DECIMALS,
  now = Date.now,
  ttlMs = parseTokenBalanceTtlMs(),
  failTtlMs = 5_000,
  deadlineMs = 5_000,
  maxConcurrent = 4,
  ratePerSecond = 5,
  burst = 10,
  maxEntries = 4096,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  log = console,
}) {
  const parsedDecimals = integer(decimals)
  if (parsedDecimals >= 0 && parsedDecimals <= 18) {
    decimals = parsedDecimals
  } else {
    if (decimals !== undefined) log.warn('[tokenBalance] invalid PUBLIC_TOKEN_DECIMALS; using 6')
    decimals = 6
  }

  const entries = new Map()
  let active = 0
  let tokens = burst
  let bucketAt = now()

  function resolveBatch(callers, result) {
    for (const caller of callers) caller.finish(result)
  }

  function makeCaller() {
    let resolve
    const promise = new Promise(done => {
      resolve = done
    })
    const caller = {
      group: null,
      expiresAt: now() + 2 * deadlineMs,
      finish(result) {
        if (!resolve) return
        clearTimeout(timer)
        caller.group?.delete(caller)
        resolve({ ...(now() >= caller.expiresAt ? UNKNOWN : result) })
        resolve = null
      },
    }
    const timer = setTimeout(() => caller.finish(UNKNOWN), 2 * deadlineMs)
    return { caller, promise }
  }

  function expire(entry, op) {
    if (entry.op !== op || op.expired) return
    op.expired = true
    entry.failedAt = now()
    resolveBatch(op.callers, UNKNOWN)
    resolveBatch(entry.freshWaiters, UNKNOWN)
    op.controller.abort()
    // The operation and its slot remain owned until readRaw actually settles.
  }

  async function run(entry, op) {
    let result = UNKNOWN
    try {
      const raw = await readRaw(entry.wallet, op.controller.signal)
      let balance
      if (raw?.exists === false) {
        balance = 0
      } else if (raw?.exists === true && typeof raw.amount === 'bigint') {
        balance = Number(raw.amount) / 10 ** decimals
      }
      if (!Number.isFinite(balance) || balance < 0) throw new Error('invalid token balance')
      result = { known: true, balance }
    } catch {
      // All RPC and validation failures are unknown, never a cached fallback.
    }

    if (entry.op !== op) return
    if (now() >= op.expiresAt) expire(entry, op)
    clearTimeout(op.timer)
    active--
    entry.op = null
    if (op.expired) return

    if (result.known) {
      entry.value = result
      entry.at = now()
      entry.failedAt = null
    } else {
      entry.failedAt = now()
    }
    resolveBatch(op.callers, result)
    // Detach this batch before starting: arrivals during its read wait for the next one.
    const batch = entry.freshWaiters
    entry.freshWaiters = new Set()
    if (batch.size) start(entry, batch)
  }

  function start(entry, callers) {
    const at = now()
    tokens = Math.min(burst, tokens + (Math.max(0, at - bucketAt) * ratePerSecond) / 1000)
    bucketAt = at
    if (active >= maxConcurrent || tokens < 1) {
      resolveBatch(callers, UNKNOWN)
      return
    }
    tokens--
    active++
    const op = {
      callers,
      controller: new AbortController(),
      expiresAt: at + deadlineMs,
      expired: false,
      timer: null,
    }
    entry.op = op
    op.timer = setTimeout(() => expire(entry, op), deadlineMs)
    run(entry, op)
  }

  function get(wallet, { fresh = false } = {}) {
    let entry = entries.get(wallet)
    if (!entry) {
      if (entries.size >= maxEntries) {
        for (const [key, candidate] of entries) {
          if (candidate.op || candidate.freshWaiters.size) continue
          entries.delete(key)
          break
        }
        if (entries.size >= maxEntries) return Promise.resolve({ ...UNKNOWN })
      }
      entry = { wallet, value: null, at: null, failedAt: null, op: null, freshWaiters: new Set() }
      entries.set(wallet, entry)
    }
    const at = now()
    if (entry.op && at >= entry.op.expiresAt) expire(entry, entry.op)
    if (!fresh) {
      if (entry.value && at - entry.at < ttlMs) return Promise.resolve({ ...entry.value })
      if (entry.failedAt !== null && at - entry.failedAt < failTtlMs) return Promise.resolve({ ...UNKNOWN })
    }
    if (entry.op?.expired) return Promise.resolve({ ...UNKNOWN })

    const { caller, promise } = makeCaller()
    if (entry.op) {
      caller.group = fresh ? entry.freshWaiters : entry.op.callers
      caller.group.add(caller)
    } else {
      caller.group = new Set([caller])
      start(entry, caller.group)
    }
    return promise
  }

  return { get }
}
