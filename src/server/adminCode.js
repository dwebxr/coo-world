import { createHash, timingSafeEqual } from 'node:crypto'

// The admin code: who may become admin by typing `/admin <code>`, and how fast a wrong one may be tried.
//
// The code's own entropy is the defence. What is here is a brake on guessing, and it is only as strong as the
// addresses a guesser has: every new connection is a new socket and a new user id, so those two hold nobody, and an
// address key holds one address. Under the waits below one IPv4 address gets about 1,400 guesses a day and one IPv6
// /48 about 8,600. A six-digit code does not survive that for long; a long random one does not care.
//
// It is not a lock that keeps the operator in: someone on the admin's own address (a shared network, a proxy that
// hides addresses) can keep that address's wait armed. An admin's rank is stored with their user and needs no code;
// the code is for the first grant and for a new browser.

// What the world does about admin rights, decided once from the environment:
//   code    a non-empty ADMIN_CODE: `/admin <code>` grants (and, entered again, revokes) admin
//   open    no code and ADMIN_OPEN=true, or no code outside production: everyone is admin (what an unset code has
//           always meant)
//   locked  production with neither: nobody is admin by default and `/admin` does nothing; stored ranks still apply.
//           The server starts all the same: a forgotten setting must not become an outage, and it must not make
//           every visitor an admin either.
export function adminMode(env) {
  if (env.ADMIN_CODE) return 'code'
  if (env.ADMIN_OPEN === 'true') return 'open'
  return env.NODE_ENV === 'production' ? 'locked' : 'open'
}

// the longest candidate that is compared: a chat line
export const ADMIN_CODE_MAX_LENGTH = 500
const CODE_WARN_LENGTH = 16
// guesses a day one network gets through the brake below (an IPv6 /48: one per 10 s), rounded up; used only to tell
// the operator how long a short code would hold
const GUESSES_PER_DAY = 10000

// What to say about the admin setting at start-up: [{ level: 'error' | 'warn', message }]
export function adminStartupNotes(env) {
  const notes = []
  const mode = adminMode(env)
  const code = env.ADMIN_CODE
  if (mode === 'locked') {
    notes.push({
      level: 'error',
      message:
        '[envs] ADMIN_CODE is not set: nobody can become admin with a code (users whose rank is stored keep it). ' +
        'Set ADMIN_CODE, or ADMIN_OPEN=true if every visitor is meant to be an admin.',
    })
  } else if (mode === 'open') {
    notes.push({ level: 'warn', message: '[envs] ADMIN_CODE not set - all users will have admin permissions!' })
  } else {
    if (env.ADMIN_OPEN === 'true') {
      notes.push({ level: 'warn', message: '[envs] ADMIN_OPEN is ignored: ADMIN_CODE is set' })
    }
    if (/\s/.test(code)) {
      notes.push({
        level: 'warn',
        message: '[envs] ADMIN_CODE contains whitespace: the /admin command splits on spaces, so it cannot be typed',
      })
    }
    if (code.length > ADMIN_CODE_MAX_LENGTH) {
      notes.push({
        level: 'warn',
        message: `[envs] ADMIN_CODE is longer than ${ADMIN_CODE_MAX_LENGTH} characters: it cannot be typed in chat`,
      })
    }
    if (code.length < CODE_WARN_LENGTH) {
      notes.push({
        level: 'warn',
        message:
          `[envs] ADMIN_CODE is short (${code.length} characters): wrong codes are only slowed down, and at the rate ` +
          `one network can try them a code like this holds for about ${holdsFor(code)}. Use 16 or more random characters.`,
      })
    }
  }
  return notes
}

// how long a code of this length and these kinds of character lasts on average against GUESSES_PER_DAY
function holdsFor(code) {
  let alphabet = 0
  if (/[0-9]/.test(code)) alphabet += 10
  if (/[a-z]/.test(code)) alphabet += 26
  if (/[A-Z]/.test(code)) alphabet += 26
  if (/[^0-9a-zA-Z]/.test(code)) alphabet += 32
  const days = Math.pow(alphabet, code.length) / 2 / GUESSES_PER_DAY
  if (days < 1) return 'less than a day'
  if (days < 730) return `${Math.round(days)} days`
  if (days < 1e6 * 365) return `${Math.round(days / 365).toLocaleString('en-US')} years`
  return 'a very long time'
}

const digest = text => createHash('sha256').update(text, 'utf8').digest()

// free wrong codes for a key before it has to wait, and the waits that follow (the last one repeats)
const NARROW = { free: 3, waits: [10000, 20000, 40000, 60000] }
// an address's wider networks (an IPv6 /56 and /48): looser, since they hold many people, but a guesser who moves
// around inside one is held by them
const WIDE = { free: 32, waits: [10000] }
const FORGET_MS = 15 * 60 * 1000
const MAX_KEYS = 8192
// attempts on one socket, refused ones included, before it is closed. Housekeeping, not a defence: a new connection
// is a new socket.
export const SOCKET_ATTEMPTS = 20
const SUMMARY_MS = 60000

// A factor on the waits, for the test harness (ADMIN_ATTEMPT_WAIT_SCALE=0.01): never honoured in production.
export function adminWaitScale(env) {
  if (env.NODE_ENV === 'production') return 1
  const scale = Number(env.ADMIN_ATTEMPT_WAIT_SCALE)
  return scale > 0 && scale <= 1 ? scale : 1
}

// `waitScale` shortens the waits in tests (adminWaitScale)
export function createAdminGate({ code, now = Date.now, log = console.warn, waitScale = 1 } = {}) {
  const expected = code ? digest(code) : null
  // key -> { failures, readyAt, lastFailure, told }
  const keys = new Map()
  const sockets = new WeakMap()
  let wrongInWindow = 0
  let addressesInWindow = new Set()
  let windowStart = now()

  const wait = (rule, failures) =>
    failures <= rule.free ? 0 : rule.waits[Math.min(failures - rule.free, rule.waits.length) - 1] * waitScale

  function summarise(time) {
    if (time - windowStart < SUMMARY_MS) return
    if (wrongInWindow) {
      log(`[admin] ${wrongInWindow} wrong admin codes in the last minute, from ${addressesInWindow.size} addresses`)
    }
    wrongInWindow = 0
    addressesInWindow = new Set()
    windowStart = time
  }

  // a key's entry, unless its last failure is long enough ago to be forgotten
  function entryOf(key, time) {
    const entry = keys.get(key)
    if (entry && time - entry.lastFailure > FORGET_MS) {
      keys.delete(key)
      return undefined
    }
    return entry
  }

  // makes room for a new key: the one that failed longest ago and is not inside a wait. False when every key is.
  function makeRoom(time) {
    for (const [key, entry] of keys) {
      if (time - entry.lastFailure > FORGET_MS) keys.delete(key)
    }
    if (keys.size < MAX_KEYS) return true
    let oldest = null
    let oldestTime = Infinity
    for (const [key, entry] of keys) {
      if (entry.readyAt > time) continue
      if (entry.lastFailure < oldestTime) {
        oldest = key
        oldestTime = entry.lastFailure
      }
    }
    if (oldest === null) return false
    keys.delete(oldest)
    return true
  }

  // the keys an attempt is charged to: [name, rule]
  function charged({ user, address, parents }) {
    const list = []
    if (typeof user === 'string' && user) list.push([`u:${user}`, NARROW])
    // an address nobody could work out holds everyone at once: it is not a key
    if (typeof address === 'string' && address && address !== 'unknown') {
      list.push([`a:${address}`, NARROW])
      for (const parent of Array.isArray(parents) ? parents : []) {
        if (typeof parent === 'string' && parent) list.push([`p:${parent}`, WIDE])
      }
    }
    return list
  }

  // One `/admin <candidate>`. `who` is { socket, user, address, parents }: the socket object, the user id, and the
  // connection's address key with its wider networks (clientIpKeys).
  // -> { ok: true } | { ok: false, reason: 'wrong' | 'wait' | 'closed' | 'off', tell }
  //    `tell`: whether to answer the player (once per wait, not per packet)
  function attempt(who, candidate) {
    if (!expected) return { ok: false, reason: 'off', tell: false }
    const time = now()
    summarise(time)
    const socket = who?.socket && typeof who.socket === 'object' ? who.socket : null
    if (socket) {
      const count = (sockets.get(socket) || 0) + 1
      sockets.set(socket, count)
      if (count > SOCKET_ATTEMPTS) return { ok: false, reason: 'closed', tell: count === SOCKET_ATTEMPTS + 1 }
    }
    const list = charged(who || {})
    // a key that is waiting: the candidate is not looked at, and the wait is not lengthened
    for (const [key] of list) {
      const entry = entryOf(key, time)
      if (entry && entry.readyAt > time) {
        const tell = !entry.told
        entry.told = true
        return { ok: false, reason: 'wait', tell }
      }
    }
    const right =
      typeof candidate === 'string' &&
      candidate.length <= ADMIN_CODE_MAX_LENGTH &&
      timingSafeEqual(digest(candidate), expected)
    if (right) {
      // the socket's and the user's slate is clean again; the address's is not (others share it)
      if (socket) sockets.delete(socket)
      if (typeof who?.user === 'string') keys.delete(`u:${who.user}`)
      return { ok: true }
    }
    wrongInWindow++
    if (typeof who?.address === 'string') addressesInWindow.add(who.address)
    for (const [key, rule] of list) {
      let entry = entryOf(key, time)
      if (!entry) {
        // no room for another key: this attempt is treated as made by one that waits
        if (!makeRoom(time)) return { ok: false, reason: 'wait', tell: true }
        entry = { failures: 0, readyAt: 0, lastFailure: time, told: false }
      } else {
        keys.delete(key) // moved to the end: the map's order is the order of last failure
      }
      entry.failures++
      entry.lastFailure = time
      entry.readyAt = time + wait(rule, entry.failures)
      entry.told = false
      keys.set(key, entry)
    }
    return { ok: false, reason: 'wrong', tell: true }
  }

  return { attempt, size: () => keys.size }
}
