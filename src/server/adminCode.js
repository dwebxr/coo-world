import { createHash, timingSafeEqual } from 'node:crypto'
import { CHAT_BODY_MAX_LENGTH } from '../core/extras/chatPolicy.js'
import { ADMIN_CODE_TYPED_MAX_LENGTH, commandWords } from '../core/extras/chatCommand.js'

// The admin code: who may become admin by typing `/admin <code>`, and how fast a wrong one may be tried.
//
// The code's own entropy is the defence. What is here is a brake on guessing, and it is only as strong as the
// addresses a guesser has: every new connection is a new socket and a new user id, so those two hold nobody, and an
// address key holds one address. Under the waits below one IPv4 address gets about 1,400 guesses a day and one IPv6
// /48 about 8,600. A six-digit code does not survive that for long; a long random one does not care.
//
// It is not a lock that keeps the operator in: someone on the admin's own address (a shared network, a proxy that
// hides addresses) can keep that address's wait armed, and someone who keeps thousands of networks waiting at once
// fills the table of failing keys, after which a code from a network not in it is not looked at. An admin's rank is
// stored with their user and needs no code; the code is for the first grant and for a new browser.

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

// the longest candidate that is compared: a chat line (a typed code is shorter, ADMIN_CODE_TYPED_MAX_LENGTH)
export const ADMIN_CODE_MAX_LENGTH = CHAT_BODY_MAX_LENGTH
const CODE_WARN_LENGTH = 16

// What to say about the admin setting at start-up: [{ level: 'error' | 'warn' | 'log', message }]. Neither the code
// nor its length is ever part of it.
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
    notes.push({ level: 'log', message: '[envs] ADMIN_CODE is set: /admin <code> in chat makes a player admin' })
    if (env.ADMIN_OPEN === 'true') {
      notes.push({ level: 'warn', message: '[envs] ADMIN_OPEN is ignored: ADMIN_CODE is set' })
    }
    // what the chat makes of `/admin <code>` (chatCommand.js parseCommand): the line is cut to a chat message's
    // length and split into words at each space, each word trimmed
    const words = commandWords(code)
    if (words.length !== 1 || words[0] !== code) {
      notes.push({
        level: 'warn',
        message:
          '[envs] ADMIN_CODE cannot be typed in chat: it contains a space, or starts or ends with whitespace, and ' +
          '/admin splits a line into words at spaces and trims each word',
      })
    }
    if (code.length > ADMIN_CODE_TYPED_MAX_LENGTH) {
      notes.push({
        level: 'warn',
        message:
          `[envs] ADMIN_CODE cannot be typed in chat: it is longer than the ${ADMIN_CODE_TYPED_MAX_LENGTH} ` +
          `characters a chat line (${CHAT_BODY_MAX_LENGTH}) leaves after "/admin "`,
      })
    }
    if (code.length < CODE_WARN_LENGTH) {
      notes.push({
        level: 'warn',
        message:
          `[envs] ADMIN_CODE is shorter than ${CODE_WARN_LENGTH} characters. Wrong codes are only slowed down, to ` +
          'thousands of guesses a day from each network, so the code itself has to be long and random: ' +
          `${CODE_WARN_LENGTH} or more random characters, not a word or a short number.`,
      })
    }
  }
  return notes
}

const digest = text => createHash('sha256').update(text, 'utf8').digest()

// The wrong code that brings a key's count to `limit` starts its first wait, and each one after a wait starts the
// next (the last one repeats).
const NARROW = { limit: 3, waits: [10000, 20000, 40000, 60000] }
// an address's wider networks (an IPv6 /56 and /48): looser, since they hold many people, but a guesser who moves
// around inside one is held by them
const WIDE = { limit: 32, waits: [10000] }
const FORGET_MS = 15 * 60 * 1000
const MAX_KEYS = 8192
// how long a socket whose attempt found no room in the table is refused before the table is looked at again
const OVERFLOW_MS = 10000
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

// a timer that does not keep the process alive; returns what cancels it
function unrefTimeout(fn, ms) {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

// addresses told apart in one summary line
const SUMMARY_MAX_ADDRESSES = 10000

// `now`: the clock every wait and interval here is measured with, in milliseconds. Monotonic by default, so a step of
// the wall clock neither stretches a wait nor ends one. `schedule(fn, ms)` runs `fn` later and returns what cancels
// it (it sends the summary line). `waitScale` shortens the waits in tests (adminWaitScale).
// -> { attempt, close, size }. `close()` sends the summary of what is counted so far and cancels its timer.
export function createAdminGate({
  code,
  now = () => performance.now(),
  log = console.warn,
  waitScale = 1,
  schedule = unrefTimeout,
} = {}) {
  const expected = code ? digest(code) : null
  // key -> { failures, readyAt, lastFailure }, in the order of last failure (a failing key moves to the end)
  const keys = new Map()
  // socket object -> { count, told, overflowUntil }: its attempts, the wait it was last told about, and the end of
  // its own wait after an attempt that found no room
  const sockets = new WeakMap()
  // what the next summary line counts, from the first attempt after the previous line; null when nothing is counted
  let summary = null
  let cancelSummary = null

  const wait = (rule, failures) =>
    failures < rule.limit ? 0 : rule.waits[Math.min(failures - rule.limit, rule.waits.length - 1)] * waitScale

  function sendSummary() {
    cancelSummary?.()
    cancelSummary = null
    if (!summary) return
    const { start, wrong, addresses, unread } = summary
    summary = null
    const seconds = Math.max(1, Math.ceil((now() - start) / 1000))
    let line = `[admin] ${wrong} wrong admin codes in the last ${seconds} s, from ${addresses.size} addresses`
    if (unread) line += `; ${unread} attempts refused unread, the table of failing addresses being full`
    log(line)
  }

  // counted for the summary, which is sent a minute after the first attempt it counts
  function count(time, kind, address) {
    if (!summary) {
      summary = { start: time, wrong: 0, unread: 0, addresses: new Set() }
      cancelSummary = schedule(sendSummary, SUMMARY_MS)
    }
    summary[kind]++
    // (counted up to a bound: the line then says that many, which is already the news)
    if (kind === 'wrong' && typeof address === 'string' && summary.addresses.size < SUMMARY_MAX_ADDRESSES) {
      summary.addresses.add(address)
    }
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

  // Room in the table for those of `list`'s keys that have no entry, found before the candidate is looked at, so a
  // wrong code can be charged to every one of them. What gives way, in this order: keys already forgotten; user ids,
  // waiting or not (anyone can make a new one, so they hold nobody an address does not); then the addresses and
  // networks that failed longest ago, unless they are inside a wait. An address or network inside a wait is never
  // dropped. False, and nothing dropped, when that is not enough.
  function reserve(list, time) {
    const own = new Set(list.map(([key]) => key))
    let needed = 0
    for (const key of own) if (!keys.has(key)) needed++
    if (keys.size + needed <= MAX_KEYS) return true
    for (const [key, entry] of keys) {
      if (time - entry.lastFailure <= FORGET_MS) break
      keys.delete(key)
    }
    const drop = []
    const pick = givesWay => {
      for (const [key, entry] of keys) {
        if (keys.size - drop.length + needed <= MAX_KEYS) return
        if (!own.has(key) && givesWay(key, entry)) drop.push(key)
      }
    }
    pick(key => key.startsWith('u:'))
    pick((key, entry) => !key.startsWith('u:') && entry.readyAt <= time)
    if (keys.size - drop.length + needed > MAX_KEYS) return false
    for (const key of drop) keys.delete(key)
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

  // a refused attempt, said once per socket and per wait (`which` names the wait: a key, or overflow, and its end)
  function refused(mine, which) {
    const tell = mine?.told !== which
    if (mine) mine.told = which
    return { ok: false, reason: 'wait', tell }
  }

  // One `/admin <candidate>`. `who` is { socket, user, address, parents }: the socket object, the user id, and the
  // connection's address key with its wider networks (clientIpKeys).
  // -> { ok: true } | { ok: false, reason: 'wrong' | 'wait' | 'closed' | 'off', tell }
  //    `tell`: whether to answer the player (once per wait and socket, not per packet)
  function attempt(who, candidate) {
    if (!expected) return { ok: false, reason: 'off', tell: false }
    const time = now()
    const socket = who?.socket && typeof who.socket === 'object' ? who.socket : null
    let mine = null
    if (socket) {
      mine = sockets.get(socket)
      if (!mine) sockets.set(socket, (mine = { count: 0, told: null, overflowUntil: -Infinity }))
      mine.count++
      if (mine.count > SOCKET_ATTEMPTS) {
        return { ok: false, reason: 'closed', tell: mine.count === SOCKET_ATTEMPTS + 1 }
      }
    }
    const list = charged(who || {})
    // a key that is waiting: the candidate is not looked at, and the wait is not lengthened
    for (const [key] of list) {
      const entry = entryOf(key, time)
      if (entry && entry.readyAt > time) return refused(mine, `${key}@${entry.readyAt}`)
    }
    if (mine && mine.overflowUntil > time) return refused(mine, `overflow@${mine.overflowUntil}`)
    // no room to charge a wrong code to: not looked at either, since nothing would then hold the next attempt
    if (!reserve(list, time)) {
      count(time, 'unread')
      if (!mine) return { ok: false, reason: 'wait', tell: true }
      mine.overflowUntil = time + OVERFLOW_MS * waitScale
      return refused(mine, `overflow@${mine.overflowUntil}`)
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
    count(time, 'wrong', who?.address)
    for (const [key, rule] of list) {
      // (room for a new entry was made above)
      const entry = keys.get(key) ?? { failures: 0, readyAt: 0, lastFailure: time }
      keys.delete(key) // moved to the end: the map's order is the order of last failure
      entry.failures++
      entry.lastFailure = time
      entry.readyAt = time + wait(rule, entry.failures)
      keys.set(key, entry)
    }
    return { ok: false, reason: 'wrong', tell: true }
  }

  return { attempt, close: sendSummary, size: () => keys.size }
}
