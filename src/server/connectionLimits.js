// Connection limits per client address for /ws. Pure: in-memory state keyed by the address bucket the caller
// derives (see clientIpKey in uploadLimits.js), with an injectable clock for tests. Checked before a
// connection touches the database or serialises a snapshot.

export const SWEEP_INTERVAL_MS = 60_000

const ENV_DEFAULTS = {
  WS_CONNECT_RATE_PER_MIN: 10,
  WS_CONNECT_BURST: 20,
  WS_CONNECT_CONCURRENT_PER_IP: 8,
  WS_CONNECT_CONCURRENT_PER_56: 16,
  WS_CONNECT_CONCURRENT_PER_48: 32,
  WS_MAX_SOCKETS: 64,
  WS_CONNECT_MAX_TRACKED: 40_000,
}

// every value is a number >= 0, and 0 disables that limit. unset or empty means the default
export function readConnectionLimitsEnv(env) {
  const read = key => {
    const raw = env[key]
    if (raw === undefined || raw === '') return ENV_DEFAULTS[key]
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`[envs] ${key} must be a number >= 0 (0 disables the limit)`)
    }
    return value
  }
  const ratePerMin = read('WS_CONNECT_RATE_PER_MIN')
  const burst = read('WS_CONNECT_BURST')
  if (ratePerMin > 0 && burst < 1) {
    throw new Error('[envs] WS_CONNECT_BURST must be at least 1 while WS_CONNECT_RATE_PER_MIN is set')
  }
  return {
    ratePerMin,
    burst,
    concurrentPerIp: read('WS_CONNECT_CONCURRENT_PER_IP'),
    concurrentPer56: read('WS_CONNECT_CONCURRENT_PER_56'),
    concurrentPer48: read('WS_CONNECT_CONCURRENT_PER_48'),
    maxSockets: read('WS_MAX_SOCKETS'),
    maxEntries: read('WS_CONNECT_MAX_TRACKED'),
  }
}

/**
 * Connection Limits
 *
 * - admit({ key, parents }) answers { ok: true, release } for a connection that may proceed, or { ok: false, reason }.
 *   release() gives the concurrency slot back; it is safe to call more than once
 * - per address: a token bucket of `burst` connections refilled at `ratePerMin`, and at most `concurrentPerIp`
 *   open connections. Several tabs or agents on one address fit inside the burst and the concurrency cap; a
 *   reconnect storm after a restart arrives from many addresses and is not held back
 * - entries are kept while a connection is open or the bucket is below full; `maxEntries` bounds the table
 *   and, while it is full of live entries, an address not yet in it is refused
 *
 */
export function createConnectionLimits(config, { now = Date.now } = {}) {
  const { ratePerMin, burst, concurrentPerIp, concurrentPer56, concurrentPer48, maxSockets, maxEntries } = config
  const entries = new Map()
  const parentCounts = new Map()
  let active = 0
  let lastSweep = 0

  const refill = (entry, t) => {
    if (!(ratePerMin > 0)) return
    entry.tokens = Math.min(burst, entry.tokens + ((t - entry.at) / 60_000) * ratePerMin)
    entry.at = t
  }
  const idle = (entry, t) => {
    refill(entry, t)
    return entry.active === 0 && (!(ratePerMin > 0) || entry.tokens >= burst)
  }
  const purge = t => {
    for (const [key, entry] of entries) {
      if (idle(entry, t)) entries.delete(key)
    }
  }
  const sweep = t => {
    if (t - lastSweep < SWEEP_INTERVAL_MS) return
    lastSweep = t
    purge(t)
  }
  const refuse = reason => ({ ok: false, reason })

  function admit({ key, parents = [] }) {
    const t = now()
    sweep(t)
    if (maxSockets > 0 && active >= maxSockets) return refuse('too many connections')
    for (const parent of parents) {
      const cap = parent.endsWith('/56') ? concurrentPer56 : concurrentPer48
      if (cap > 0 && (parentCounts.get(parent) || 0) >= cap) return refuse('too many connections')
    }
    let entry = entries.get(key)
    if (!entry) {
      if (maxEntries > 0 && entries.size >= maxEntries) {
        purge(t)
        if (entries.size >= maxEntries) return refuse('busy')
      }
      entry = { tokens: burst, at: t, active: 0 }
      entries.set(key, entry)
    }
    if (concurrentPerIp > 0 && entry.active >= concurrentPerIp) return refuse('too many connections')
    if (ratePerMin > 0) {
      refill(entry, t)
      if (entry.tokens < 1) return refuse('too many connections')
      entry.tokens -= 1
    }
    entry.active++
    active++
    for (const parent of parents) parentCounts.set(parent, (parentCounts.get(parent) || 0) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      entry.active--
      active--
      for (const parent of parents) {
        const count = parentCounts.get(parent) - 1
        if (count) parentCounts.set(parent, count)
        else parentCounts.delete(parent)
      }
    }
    return { ok: true, release }
  }

  function stats() {
    return { tracked: entries.size, active }
  }

  return { admit, stats }
}
