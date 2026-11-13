// Connection limits per client address for /ws. Pure: in-memory state keyed by the address bucket the caller
// derives (see clientIpKeys in uploadLimits.js), with an injectable clock for tests. Checked before a
// connection touches the database or serialises a snapshot.
import { Ranks } from '../core/extras/ranks.js'

export const SWEEP_INTERVAL_MS = 60_000

const ENV_DEFAULTS = {
  WS_CONNECT_RATE_PER_MIN: 10,
  WS_CONNECT_BURST: 20,
  WS_CONNECT_RATE_PER_MIN_56: 20,
  WS_CONNECT_BURST_56: 40,
  WS_CONNECT_RATE_PER_MIN_48: 40,
  WS_CONNECT_BURST_48: 80,
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
  const parentBucket = suffix => {
    const ratePerMin = read(`WS_CONNECT_RATE_PER_MIN_${suffix}`)
    const burst = read(`WS_CONNECT_BURST_${suffix}`)
    if (ratePerMin > 0 && burst > 0 && burst < 1) {
      throw new Error(
        `[envs] WS_CONNECT_BURST_${suffix} must be 0 or at least 1 while WS_CONNECT_RATE_PER_MIN_${suffix} is set`
      )
    }
    return { [`ratePerMin${suffix}`]: ratePerMin, [`burst${suffix}`]: burst }
  }
  return {
    ratePerMin,
    burst,
    ...parentBucket('56'),
    ...parentBucket('48'),
    concurrentPerIp: read('WS_CONNECT_CONCURRENT_PER_IP'),
    concurrentPer56: read('WS_CONNECT_CONCURRENT_PER_56'),
    concurrentPer48: read('WS_CONNECT_CONCURRENT_PER_48'),
    maxSockets: read('WS_MAX_SOCKETS'),
    maxEntries: read('WS_CONNECT_MAX_TRACKED'),
    ...readReservedEnv(env),
  }
}

// The places kept for users with a stored rank: WS_RESERVED_SOCKETS (`reserved`, R) connections beyond
// WS_MAX_SOCKETS, and R players beyond the world's playerLimit (ServerNetwork onConnection), for a user whose rank
// stored with their user is WS_RESERVED_RANK (`reservedRank`: admin, or builder, which lets builders and admins
// share them) and whose session token the server verifies at the door (wsRoute.js). Off where admin is open to all
// (keptPlacesInEffect, below).
// - At most RESERVED_MAX: the join budget keeps snapshot room for that many ranked users past the last visitor
//   (joinBudget.js RANKED_RESERVE_PLAYERS), so every kept place also fits the join snapshot; and a typo cannot
//   undo WS_MAX_SOCKETS. 0 turns everything off: the server admits as it did before there were kept places.
// - A whole number of digits only: Number() would read ' 2' as 2 and '1e1' as 10.
export const RESERVED_MAX = 8
// a user's connections on the ranked path at once: a registered one and the one that replaces it (the takeover of a
// silent connection, ServerNetwork onConnection)
export const RESERVED_PER_USER = 2
export const RESERVED_DEFAULTS = Object.freeze({ reserved: 4, reservedRank: Ranks.ADMIN })

export function readReservedEnv(env) {
  let reserved = RESERVED_DEFAULTS.reserved
  const raw = env.WS_RESERVED_SOCKETS
  if (raw !== undefined && raw !== '') {
    reserved = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isInteger(reserved) || reserved > RESERVED_MAX) {
      throw new Error(`[envs] WS_RESERVED_SOCKETS must be a whole number from 0 to ${RESERVED_MAX}`)
    }
  }
  let reservedRank = RESERVED_DEFAULTS.reservedRank
  const rank = env.WS_RESERVED_RANK
  if (rank !== undefined && rank !== '') {
    if (rank !== 'admin' && rank !== 'builder') throw new Error('[envs] WS_RESERVED_RANK must be admin or builder')
    reservedRank = rank === 'admin' ? Ranks.ADMIN : Ranks.BUILDER
  }
  return { reserved, reservedRank }
}

// What of the kept places is in effect, for the admin mode `mode` (adminCode.js adminMode): { places, rank }.
// Where admin is open to all (`open`) there are none: anyone can store a rank of admin for themselves there
// (onModifyRank), so a place kept for admins would be anyone's. index.js says so at start-up (keptPlacesNote);
// the route and ServerNetwork.keptPlaces() read it.
export function keptPlacesInEffect(config, mode) {
  return { places: mode === 'open' ? 0 : config.reserved, rank: config.reservedRank }
}

// what index.js says at start-up about the kept places: { level, message }, or null (none are configured)
export function keptPlacesNote(config, mode) {
  if (!(config.reserved > 0)) return null
  if (mode === 'open') {
    return {
      level: 'warn',
      message:
        "[envs] WS_RESERVED_SOCKETS has no effect: admin is open to all (no ADMIN_CODE), so a place kept for admins would be anyone's",
    }
  }
  const who = `users with a stored rank of ${config.reservedRank === Ranks.ADMIN ? 'admin' : 'builder or admin'}`
  const players = `${config.reserved} players beyond playerLimit`
  return {
    level: 'log',
    message:
      config.maxSockets > 0
        ? `[envs] ${config.reserved} connections beyond WS_MAX_SOCKETS (${config.maxSockets}), and ${players}, are kept for ${who}`
        : `[envs] ${players} are kept for ${who} (WS_MAX_SOCKETS is 0: there is no cap on connections to keep places beyond)`,
  }
}

/**
 * Connection Limits
 *
 * - admit({ key, parents }) answers { ok: true, release } for a connection that may proceed, or { ok: false, reason }.
 *   release() gives the concurrency slot back; it is safe to call more than once
 * - per address: a token bucket of `burst` connections refilled at `ratePerMin`, and at most `concurrentPerIp`
 *   open connections. IPv6 /56 and /48 parents have their own rate buckets and concurrency caps
 * - address and parent entries are kept while a connection is open or the bucket is below full; `maxEntries` bounds the table
 *   and, while it is full of live entries, an address not yet in it is refused
 * - the ranked path (`reserved` > 0), admit(origin, { user }): only when the address's own path above refuses, for
 *   `user`, a user id the caller has found to be one with the kept places' stored rank on a session token it has
 *   verified (wsRoute.js). Such a connection is admitted while fewer than `maxSockets + reserved` are open in all
 *   (visitors are still refused at `maxSockets`: a kept place takes nothing from them), the user has fewer than
 *   RESERVED_PER_USER open on this path, and the user's own bucket (the address rate and burst, under the user id)
 *   has a token. It skips the address's, the parents' and the table's limits. Its answer is { ok: true, release,
 *   ranked: true, user, beyond }: `beyond`, the connections open beyond `maxSockets` once it is counted (0 when it
 *   came in past its address's limits only, or `maxSockets` is 0). Its lease is released as any other, once.
 *   The users' entries are not bounded by `maxEntries`: there are no more of them than users with the stored rank,
 *   since the caller names a user only after verifying that; they are swept as the addresses are.
 *
 */
export function createConnectionLimits(config, { now = Date.now } = {}) {
  const { maxSockets, maxEntries } = config
  const address = { rate: config.ratePerMin, burst: config.burst, concurrent: config.concurrentPerIp }
  const parent56 = { rate: config.ratePerMin56, burst: config.burst56, concurrent: config.concurrentPer56 }
  const parent48 = { rate: config.ratePerMin48, burst: config.burst48, concurrent: config.concurrentPer48 }
  const entries = new Map()
  let active = 0
  let lastSweep = 0
  const reserved = config.reserved > 0 ? config.reserved : 0
  const userLimit = { rate: config.ratePerMin, burst: config.burst, concurrent: RESERVED_PER_USER }
  const users = new Map() // user id -> entry, for users admitted on the ranked path
  let ranked = 0

  const refill = (entry, t) => {
    const { rate, burst } = entry.limit
    if (!(rate > 0 && burst > 0)) return
    entry.tokens = Math.min(burst, entry.tokens + ((t - entry.at) / 60_000) * rate)
    entry.at = t
  }
  const idle = (entry, t) => {
    refill(entry, t)
    const { rate, burst } = entry.limit
    return entry.active === 0 && (!(rate > 0 && burst > 0) || entry.tokens >= burst)
  }
  const purge = t => {
    for (const [key, entry] of entries) {
      if (idle(entry, t)) entries.delete(key)
    }
    for (const [key, entry] of users) {
      if (idle(entry, t)) users.delete(key)
    }
  }
  const sweep = t => {
    if (t - lastSweep < SWEEP_INTERVAL_MS) return
    lastSweep = t
    purge(t)
  }
  const refuse = reason => ({ ok: false, reason })

  function admit(origin, { user } = {}) {
    const t = now()
    sweep(t)
    const answer = admitAddress(origin, t)
    if (answer.ok || !(reserved > 0) || typeof user !== 'string' || !user) return answer
    return admitRanked(user, t)
  }

  function admitAddress({ key, parents = [] }, t) {
    if (maxSockets > 0 && active >= maxSockets) return refuse('too many connections')
    const buckets = [[key, address], ...parents.map(parent => [parent, parent.endsWith('/56') ? parent56 : parent48])]
    const pending = []
    for (const [key, limit] of buckets) {
      const entry = entries.get(key) || { tokens: limit.burst, at: t, active: 0, limit }
      if (limit.concurrent > 0 && entry.active >= limit.concurrent) return refuse('too many connections')
      refill(entry, t)
      if (limit.rate > 0 && limit.burst > 0 && entry.tokens < 1) return refuse('too many connections')
      pending.push([key, entry])
    }
    const fits = () => entries.size + buckets.filter(([key]) => !entries.has(key)).length <= maxEntries
    if (maxEntries > 0 && !fits()) {
      purge(t)
      if (!fits()) return refuse('busy')
    }
    // All rates, concurrency caps and table capacity pass before charging or inserting any bucket.
    for (const [key, entry] of pending) {
      if (entry.limit.rate > 0 && entry.limit.burst > 0) entry.tokens -= 1
      entry.active++
      entries.set(key, entry)
    }
    active++
    let released = false
    const release = () => {
      if (released) return
      released = true
      active--
      for (const [, entry] of pending) entry.active--
    }
    return { ok: true, release }
  }

  // (as for an address: every check passes before anything is charged, and a refusal makes no entry)
  function admitRanked(user, t) {
    if (maxSockets > 0 && active >= maxSockets + reserved) return refuse('too many connections')
    const entry = users.get(user) || { tokens: userLimit.burst, at: t, active: 0, limit: userLimit }
    if (entry.active >= RESERVED_PER_USER) return refuse('too many connections')
    refill(entry, t)
    const rated = userLimit.rate > 0 && userLimit.burst > 0
    if (rated && entry.tokens < 1) return refuse('too many connections')
    if (rated) entry.tokens -= 1
    entry.active++
    users.set(user, entry)
    active++
    ranked++
    let released = false
    const release = () => {
      if (released) return
      released = true
      active--
      ranked--
      entry.active--
    }
    const beyond = maxSockets > 0 ? Math.max(0, active - Math.ceil(maxSockets)) : 0
    return { ok: true, release, ranked: true, user, beyond }
  }

  // `ranked`: connections open on the ranked path; `users`: the users' entries of that path
  function stats() {
    return { tracked: entries.size, active, ranked, users: users.size }
  }

  return { admit, stats }
}
