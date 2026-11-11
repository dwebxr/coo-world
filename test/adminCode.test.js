// src/server/adminCode.js: the admin mode a world runs in, what is said about it at start-up, and the brake on wrong
// `/admin` codes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import {
  ADMIN_CODE_MAX_LENGTH,
  SOCKET_ATTEMPTS,
  adminMode,
  adminStartupNotes,
  adminWaitScale,
  createAdminGate,
} from '../src/server/adminCode.js'
import { loadClient } from './lib/clientHarness.mjs'

const CODE = 'correct-horse-battery-staple'
const SECOND = 1000

function gate(options = {}) {
  let time = 1_000_000
  const lines = []
  // the summary's timers, run by the test (fire)
  const timers = []
  const g = createAdminGate({
    code: CODE,
    now: () => time,
    log: line => lines.push(line),
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false, ran: false }
      timers.push(timer)
      return () => (timer.cancelled = true)
    },
    ...options,
  })
  return {
    g,
    lines,
    timers,
    advance: ms => (time += ms),
    fire: () => {
      for (const timer of timers) {
        if (timer.cancelled || timer.ran) continue
        timer.ran = true
        timer.fn()
      }
    },
    // a new visitor: a socket, a user id, an address
    who: (n, address = `203.0.113.${n}`, parents = []) => ({ socket: {}, user: `user-${n}`, address, parents }),
  }
}

const notes = env => adminStartupNotes(env)
const levels = env => notes(env).map(note => note.level)
const text = env =>
  notes(env)
    .map(note => note.message)
    .join('\n')

test('mode: a code, open by choice, open outside production, locked in production', () => {
  assert.equal(adminMode({ ADMIN_CODE: 'x' }), 'code')
  assert.equal(adminMode({ ADMIN_CODE: 'x', ADMIN_OPEN: 'true', NODE_ENV: 'production' }), 'code')
  assert.equal(adminMode({ ADMIN_OPEN: 'true', NODE_ENV: 'production' }), 'open')
  assert.equal(adminMode({}), 'open')
  assert.equal(adminMode({ ADMIN_CODE: '' }), 'open')
  assert.equal(adminMode({ NODE_ENV: 'development' }), 'open')
  assert.equal(adminMode({ NODE_ENV: 'production' }), 'locked')
  assert.equal(adminMode({ ADMIN_CODE: '', NODE_ENV: 'production' }), 'locked')
  assert.equal(adminMode({ ADMIN_OPEN: 'yes', NODE_ENV: 'production' }), 'locked', 'only the literal true opens')
})

test('start-up notes: each mode is said, and what is said about a code is true of it', () => {
  const good = 'a-long-random-code-of-33-chars-xx'
  assert.deepEqual(levels({ ADMIN_CODE: good }), ['log'], 'a good code: the mode, and nothing to warn about')
  assert.match(text({ ADMIN_CODE: good }), /ADMIN_CODE is set: \/admin <code> in chat makes a player admin/)
  assert.deepEqual(levels({ NODE_ENV: 'production' }), ['error'])
  assert.match(text({ NODE_ENV: 'production' }), /nobody can become admin.*ADMIN_OPEN=true/s)
  assert.deepEqual(levels({}), ['warn'])
  assert.match(text({}), /all users will have admin permissions/)
  assert.match(text({ ADMIN_CODE: good, ADMIN_OPEN: 'true' }), /ADMIN_OPEN is ignored/)
  // a short code: how fast it can be guessed, never how long it would hold (a word falls at its first guess)
  for (const code of ['123456', 'password', 'Tr0ub4dor&3', 'x'.repeat(15)]) {
    assert.deepEqual(levels({ ADMIN_CODE: code }), ['log', 'warn'], code)
    assert.match(
      text({ ADMIN_CODE: code }),
      /shorter than 16 characters.*thousands of guesses a day.*16 or more random characters, not a word or a short number/s
    )
    assert.doesNotMatch(text({ ADMIN_CODE: code }), /days|years|holds/)
  }
  assert.deepEqual(levels({ ADMIN_CODE: 'x'.repeat(16) }), ['log'])
  // neither the code nor its length is ever part of a note
  for (const code of ['123456', 'two words long enough', good, 'x'.repeat(600)]) {
    const said = text({ ADMIN_CODE: code })
    assert.ok(!said.includes(code), code)
    assert.doesNotMatch(said, new RegExp(`\\b${code.length}\\b`), `${code.length}`)
  }
})

test('start-up: a code is said not to be typeable exactly when the chat would not hand it to the server whole', () => {
  // the real Chat.command, which reads the line a player types
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const sent = []
  const chat = new Chat({
    network: { isServer: false, id: 'me', send: (name, data) => sent.push(data) },
    events: { emit() {} },
  })
  const codes = [
    'plain-code-long-enough',
    'inner no-break-space-long-enough',
    'inner\ttab-long-enough',
    'inner space-long-enough',
    ' leading-space-long-enough',
    'trailing-tab-long-enough\t',
    ' leading-no-break-space',
    'trailing-no-break-space ',
    '　leading-ideographic-space',
    '   ',
    'x'.repeat(492),
    'x'.repeat(493),
    'x'.repeat(494),
    'x'.repeat(500),
    'x'.repeat(501),
    '\u{1F600}'.repeat(246),
    '\u{1F600}'.repeat(247),
  ]
  const typeable = []
  for (const code of codes) {
    chat.command(`/admin ${code}`)
    const { args } = sent.at(-1)
    const typed = args.length === 2 && args[1] === code
    if (typed) typeable.push(code)
    const warned = /cannot be typed/.test(text({ ADMIN_CODE: code }))
    assert.equal(warned, !typed, `${JSON.stringify(code.slice(0, 30))} (${code.length}): typed ${typed}`)
  }
  // (so the cases above are not all on one side)
  assert.deepEqual(typeable, [codes[0], codes[1], codes[2], codes[10], codes[11], codes[15]])
})

test('the right code is accepted, anything else is wrong, and no code set means off', () => {
  const { g, who } = gate()
  assert.deepEqual(g.attempt(who(1), CODE), { ok: true })
  for (const candidate of [
    'wrong',
    '',
    CODE + 'x',
    CODE.slice(1),
    CODE.toUpperCase(),
    undefined,
    null,
    7,
    {},
    [CODE],
    'x'.repeat(ADMIN_CODE_MAX_LENGTH + 1),
  ]) {
    const result = g.attempt(who(Math.random()), candidate)
    assert.equal(result.ok, false, String(candidate))
    assert.equal(result.reason, 'wrong')
  }
  const off = createAdminGate({ code: '' })
  assert.deepEqual(off.attempt({ socket: {}, user: 'u', address: '203.0.113.9' }, ''), {
    ok: false,
    reason: 'off',
    tell: false,
  })
  assert.equal(off.attempt({ socket: {}, user: 'u', address: '203.0.113.9' }, undefined).reason, 'off')
  // a code longer than a chat line can never be typed, and is never matched (the start-up note says so)
  const tooLong = 'k'.repeat(ADMIN_CODE_MAX_LENGTH + 1)
  assert.equal(createAdminGate({ code: tooLong }).attempt({ socket: {} }, tooLong).reason, 'wrong')
  // a code as long as a chat line can be
  const long = 'k'.repeat(ADMIN_CODE_MAX_LENGTH)
  assert.equal(createAdminGate({ code: long }).attempt({ socket: {} }, long).ok, true)
})

test('three wrong codes, then a key waits 10, 20, 40 and 60 seconds between attempts, and 60 from then on', () => {
  const { g, advance } = gate()
  // one address, a new socket and a new user for every attempt: only the address holds them
  let n = 0
  const visitor = () => ({ socket: {}, user: `fresh-${n++}`, address: '203.0.113.7', parents: [] })
  for (let i = 0; i < 3; i++) assert.equal(g.attempt(visitor(), 'no').reason, 'wrong', `wrong code ${i + 1}`)
  // the third started the first wait: the next attempt, the right code included, is not looked at
  for (const seconds of [10, 20, 40, 60, 60, 60]) {
    assert.equal(g.attempt(visitor(), CODE).reason, 'wait', `waiting ${seconds} s`)
    advance(seconds * SECOND - 1)
    assert.equal(g.attempt(visitor(), CODE).reason, 'wait', `still waiting at ${seconds} s less a millisecond`)
    advance(1)
    assert.equal(g.attempt(visitor(), 'no').reason, 'wrong', `looked at again after ${seconds} s`)
  }
})

test('during a wait the right code is refused too, unread, and the wait is not lengthened by trying', () => {
  const { g, advance, who } = gate()
  const admin = who(1)
  for (let i = 0; i < 3; i++) g.attempt({ ...admin, socket: {} }, 'no')
  // 10 s wait: hammering does not move its end
  for (let i = 0; i < 5; i++) {
    advance(1 * SECOND)
    assert.equal(g.attempt({ ...admin, socket: {} }, CODE).reason, 'wait')
  }
  advance(5 * SECOND)
  assert.deepEqual(g.attempt({ ...admin, socket: {} }, CODE), { ok: true }, 'accepted once the 10 s are over')
})

test('a refused attempt is answered once per wait on each socket: another visitor on the address is told too', () => {
  const { g, advance } = gate()
  const address = '203.0.113.1'
  const first = { socket: {}, user: 'first', address, parents: [] }
  const second = { socket: {}, user: 'second', address, parents: [] }
  const tell = who => g.attempt(who, 'no').tell
  assert.deepEqual([tell(first), tell(first), tell(first)], [true, true, true], 'each wrong code is answered')
  // the address waits now
  assert.deepEqual([tell(first), tell(first)], [true, false])
  assert.deepEqual([tell(second), tell(second)], [true, false], "the first visitor's answer is not the second's")
  advance(10 * SECOND)
  assert.equal(tell(first), true, 'a wrong code after the wait')
  assert.deepEqual([tell(first), tell(first)], [true, false], 'the next wait is said once again')
  assert.deepEqual([tell(second), tell(second)], [true, false])
})

test('the strictest key applies: a user id is held on a new address, an address holds a new user', () => {
  const { g } = gate()
  for (let i = 0; i < 3; i++) g.attempt({ socket: {}, user: 'mallory', address: `198.51.100.${i}` }, 'no')
  assert.equal(g.attempt({ socket: {}, user: 'mallory', address: '198.51.100.200' }, CODE).reason, 'wait')
  assert.equal(g.attempt({ socket: {}, user: 'someone-else', address: '198.51.100.201' }, CODE).ok, true)
  for (let i = 0; i < 3; i++) g.attempt({ socket: {}, user: `fresh-${i}`, address: '198.51.100.50' }, 'no')
  assert.equal(g.attempt({ socket: {}, user: 'newcomer', address: '198.51.100.50' }, CODE).reason, 'wait')
})

test('the wider networks of an address are charged on a looser schedule; an unknown address is not a key', () => {
  const { g, advance } = gate()
  // a guesser moving through the /64s of one /48: each address is new, the /48 is not
  const parents = ['2001:db8:1:ff00::/56', '2001:db8:1::/48']
  let n = 0
  const from = () => ({ socket: {}, user: `v6-${n}`, address: `2001:db8:1:${(n++).toString(16)}::/64`, parents })
  for (let i = 0; i < 32; i++) assert.equal(g.attempt(from(), 'no').reason, 'wrong', `wrong code ${i + 1}`)
  assert.equal(g.attempt(from(), CODE).reason, 'wait', 'the 32nd started the /48 wait, whatever /64 comes next')
  advance(10 * SECOND)
  assert.equal(g.attempt(from(), 'no').reason, 'wrong')
  assert.equal(g.attempt(from(), 'no').reason, 'wait', 'one attempt per 10 s from then on')
  // another /48 is not held by it
  assert.equal(g.attempt({ socket: {}, user: 'other', address: '2001:db8:2::/64', parents: [] }, CODE).ok, true)

  // behind a proxy that hides addresses every visitor is "unknown": that must not be one shared key
  const hidden = gate()
  for (let i = 0; i < 50; i++) hidden.g.attempt({ socket: {}, user: `h-${i}`, address: 'unknown', parents: [] }, 'no')
  assert.equal(hidden.g.attempt({ socket: {}, user: 'admin', address: 'unknown', parents: [] }, CODE).ok, true)
})

test('a socket is closed at its 21st attempt, refused ones included; a new socket starts at zero', () => {
  const { g, who } = gate()
  const visitor = who(1)
  const reasons = []
  for (let i = 0; i < SOCKET_ATTEMPTS + 3; i++) reasons.push(g.attempt(visitor, 'no').reason)
  assert.deepEqual(reasons.slice(0, 3), ['wrong', 'wrong', 'wrong'])
  assert.ok(reasons.slice(3, SOCKET_ATTEMPTS).every(reason => reason === 'wait'))
  assert.deepEqual(reasons.slice(SOCKET_ATTEMPTS), ['closed', 'closed', 'closed'])
  // the same user on a new socket (a reconnect, a takeover): the socket's count is new, the user's is not
  assert.equal(g.attempt({ ...visitor, socket: {} }, CODE).reason, 'wait')
})

test('the right code on a late attempt clears the socket: the attempts after it do not close it', () => {
  const { g, advance } = gate()
  const admin = { socket: {}, user: 'admin', address: '203.0.113.60', parents: [] }
  for (let i = 0; i < 3; i++) g.attempt(admin, 'typo')
  for (let i = 0; i < SOCKET_ATTEMPTS - 4; i++) assert.equal(g.attempt(admin, CODE).reason, 'wait')
  advance(10 * SECOND)
  assert.deepEqual(g.attempt(admin, CODE), { ok: true }, `accepted at attempt ${SOCKET_ATTEMPTS}`)
  // the socket's count starts again from there: it gets as many attempts as a new socket before it is closed
  const after = []
  for (let i = 0; i < SOCKET_ATTEMPTS + 1; i++) after.push(g.attempt(admin, 'typo').reason)
  assert.ok(!after.slice(0, SOCKET_ATTEMPTS).includes('closed'), after.join())
  assert.equal(after.at(-1), 'closed')
})

test('the right code clears the socket and the user, not the address', () => {
  const { g, advance } = gate()
  const admin = { socket: {}, user: 'admin', address: '203.0.113.80', parents: [] }
  for (let i = 0; i < 2; i++) g.attempt(admin, 'typo')
  assert.equal(g.attempt(admin, CODE).ok, true)
  // the user's two failures are gone: two more from another address leave it short of a wait
  const elsewhere = { ...admin, address: '203.0.113.81' }
  for (let i = 0; i < 2; i++) assert.equal(g.attempt(elsewhere, 'typo').reason, 'wrong')
  assert.equal(g.attempt(elsewhere, CODE).ok, true)
  // the first address kept its two: one more wrong code there starts its wait
  assert.equal(g.attempt({ socket: {}, user: 'guest', address: '203.0.113.80', parents: [] }, 'no').reason, 'wrong')
  assert.equal(g.attempt({ socket: {}, user: 'guest-2', address: '203.0.113.80', parents: [] }, CODE).reason, 'wait')
  advance(10 * SECOND)
  assert.equal(g.attempt({ socket: {}, user: 'guest-2', address: '203.0.113.80', parents: [] }, CODE).ok, true)
})

test('a key without a failure for 15 minutes is forgotten; the table is bounded and never drops an address that waits', () => {
  const { g, advance } = gate()
  const visitor = n => ({ socket: {}, user: `u-${n}`, address: `a-${n}`, parents: [] })
  for (let i = 0; i < 3; i++) g.attempt({ ...visitor(1), socket: {} }, 'no')
  advance(15 * 60 * SECOND + 1)
  for (let i = 0; i < 3; i++) assert.equal(g.attempt({ ...visitor(1), socket: {} }, 'no').reason, 'wrong', 'free again')

  // one address kept waiting while thousands of others fail once each
  const held = gate()
  const target = { socket: {}, user: 'held', address: 'held-address', parents: [] }
  for (let i = 0; i < 8; i++) held.g.attempt({ ...target, socket: {} }, 'no')
  for (let i = 0; i < 9000; i++) held.g.attempt(visitor(i), 'no')
  assert.ok(held.g.size() <= 8192, `table size ${held.g.size()}`)
  const after = { ...target, user: 'someone-new', socket: {} }
  assert.equal(held.g.attempt(after, CODE).reason, 'wait', 'the waiting address was not dropped')

  // when room is short, keys forgotten already make it before anything else: a user id that waits is kept
  const swept = gate()
  for (let i = 0; i < 8190; i++) swept.g.attempt({ socket: {}, address: `old-${i}`, parents: [] }, 'no')
  swept.advance(15 * 60 * SECOND + 1)
  for (let i = 0; i < 3; i++) swept.g.attempt({ socket: {}, user: 'mallory' }, 'no')
  for (let i = 0; i < 2; i++) swept.g.attempt({ socket: {}, user: `new-${i}`, address: `new-${i}`, parents: [] }, 'no')
  assert.equal(swept.g.attempt({ socket: {}, user: 'mallory' }, CODE).reason, 'wait', 'the waiting user id was kept')
})

test('when every place in the table is held by a waiting address, an attempt from another is not looked at', () => {
  const { g, advance, lines, fire } = gate()
  // 8,192 addresses, each kept waiting by three wrong codes (no user id: only address keys are made)
  for (let i = 0; i < 8192; i++) {
    const address = `10.${i >> 8}.${i & 255}.1`
    for (let j = 0; j < 3; j++) g.attempt({ socket: {}, address, parents: [] }, 'no')
  }
  assert.equal(g.size(), 8192)
  advance(5 * SECOND)
  // a guesser from an address that is not in it: every guess refused unread, the right code too
  const guesser = { user: 'guesser', address: '198.51.100.1', parents: [] }
  for (let i = 0; i < 100; i++) assert.equal(g.attempt({ ...guesser, socket: {} }, `guess-${i}`).reason, 'wait')
  assert.equal(g.attempt({ ...guesser, socket: {} }, CODE).reason, 'wait', 'the right code is not looked at either')
  // such a socket then waits 10 s of its own, and is told once
  const socket = {}
  assert.deepEqual(g.attempt({ ...guesser, socket }, CODE), { ok: false, reason: 'wait', tell: true })
  assert.deepEqual(g.attempt({ ...guesser, socket }, CODE), { ok: false, reason: 'wait', tell: false })
  // the other addresses' waits end 5 s later and there is room again: at once for a new connection, for that
  // socket when its own 10 s are over
  advance(5 * SECOND)
  assert.equal(g.attempt({ ...guesser, socket }, CODE).reason, 'wait')
  assert.deepEqual(g.attempt({ ...guesser, socket: {} }, CODE), { ok: true })
  advance(5 * SECOND)
  assert.deepEqual(g.attempt({ ...guesser, socket }, CODE), { ok: true })
  fire()
  assert.deepEqual(lines, [
    '[admin] 24576 wrong admin codes in the last 15 s, from 8192 addresses; 102 attempts refused unread, the table of failing addresses being full',
  ])
})

test('when room is short, user ids give way to addresses, even while they wait', () => {
  const { g } = gate()
  // 4,096 visitors, each with three wrong codes from an address of its own: its user id and its address both wait
  for (let i = 0; i < 4096; i++) {
    const who = { user: `u-${i}`, address: `10.0.${i >> 8}.${i & 255}`, parents: [] }
    for (let j = 0; j < 3; j++) g.attempt({ ...who, socket: {} }, 'no')
  }
  assert.equal(g.size(), 8192)
  // a visitor from elsewhere is looked at: the user ids that failed first made room
  assert.deepEqual(g.attempt({ socket: {}, user: 'newcomer', address: '198.51.100.2', parents: [] }, CODE), {
    ok: true,
  })
  // every address still waits, the one whose user id gave way included
  assert.equal(g.attempt({ socket: {}, user: 'u-0', address: '10.0.0.0', parents: [] }, CODE).reason, 'wait')
  assert.equal(g.attempt({ socket: {}, user: 'other', address: '10.0.15.255', parents: [] }, CODE).reason, 'wait')
})

test('wrong codes are summed up by a timer a minute after the first, without codes or addresses', () => {
  const { g, lines, timers, fire, advance } = gate()
  for (let i = 0; i < 5; i++) {
    g.attempt({ socket: {}, user: `u-${i}`, address: `203.0.113.${i}`, parents: [] }, 'secret?')
  }
  assert.deepEqual(lines, [], 'nothing per attempt')
  assert.deepEqual(
    timers.map(timer => timer.ms),
    [60 * SECOND],
    'one timer for the line'
  )
  // then silence: the timer sends the line, with no later attempt needed
  advance(60 * SECOND)
  fire()
  assert.deepEqual(lines, ['[admin] 5 wrong admin codes in the last 60 s, from 5 addresses'])
  // a much later attempt starts a line of its own, counting itself only; a timer that runs late says how late
  advance(3600 * SECOND)
  g.attempt({ socket: {}, user: 'later', address: '203.0.113.99', parents: [] }, 'x')
  advance(75 * SECOND)
  fire()
  assert.equal(lines[1], '[admin] 1 wrong admin codes in the last 75 s, from 1 addresses')
  assert.ok(!lines.join('\n').includes('secret?') && !lines.join('\n').includes('203.0.113'))
  // close() sends what is counted at once and cancels the timer
  g.attempt({ socket: {}, user: 'last', address: '203.0.113.98', parents: [] }, 'x')
  advance(2 * SECOND)
  g.close()
  assert.equal(lines[2], '[admin] 1 wrong admin codes in the last 2 s, from 1 addresses')
  assert.equal(timers.at(-1).cancelled, true)
  g.close()
  assert.equal(lines.length, 3, 'nothing more to send')
})

test('the summary timer does not keep the process alive', { timeout: 60000 }, async () => {
  const module = new URL('../src/server/adminCode.js', import.meta.url).href
  const script =
    `const { createAdminGate } = await import(${JSON.stringify(module)});` +
    `createAdminGate({ code: 'x', log: () => {} }).attempt({ socket: {}, address: '203.0.113.1' }, 'wrong')`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' })
  // the line is due 60 s after that wrong code: a process held by its timer would still be running at 30
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)))
  let timer
  const result = await Promise.race([exit, new Promise(resolve => (timer = setTimeout(resolve, 30000, 'running')))])
  clearTimeout(timer)
  child.kill()
  assert.equal(result, 0)
})

test('by default waits are measured on the monotonic clock: setting the wall clock back or forward does not move them', t => {
  // both clocks under the test's hand: the monotonic one moves as time passes, the wall clock jumps an hour
  let monotonic = 50 * SECOND
  let wall = Date.UTC(2026, 10, 12)
  t.mock.method(performance, 'now', () => monotonic)
  t.mock.method(Date, 'now', () => wall)
  const quiet = { log: () => {}, schedule: () => () => {} }
  const who = () => ({ socket: {}, user: 'u', address: '203.0.113.1', parents: [] })
  // forward: a 10 s wait is not over an hour early
  const forward = createAdminGate({ code: CODE, ...quiet })
  for (let i = 0; i < 3; i++) forward.attempt(who(), 'no')
  wall += 3600 * SECOND
  monotonic += 1 * SECOND
  assert.equal(forward.attempt(who(), CODE).reason, 'wait')
  // back: a 10 s wait is over after 10 s, not after an hour and 10 s
  const back = createAdminGate({ code: CODE, ...quiet })
  for (let i = 0; i < 3; i++) back.attempt(who(), 'no')
  wall -= 3600 * SECOND
  monotonic += 10 * SECOND
  assert.deepEqual(back.attempt(who(), CODE), { ok: true })
})

test('waitScale shortens the waits (the e2e harness)', () => {
  const { g, advance } = gate({ waitScale: 0.01 })
  const visitor = { user: 'u', address: '203.0.113.1', parents: [] }
  for (let i = 0; i < 3; i++) g.attempt({ ...visitor, socket: {} }, 'no')
  assert.equal(g.attempt({ ...visitor, socket: {} }, CODE).reason, 'wait')
  advance(100)
  assert.equal(g.attempt({ ...visitor, socket: {} }, CODE).ok, true)
})

test('the factor on the waits is for test harnesses: never honoured in production, and never above 1', () => {
  assert.equal(adminWaitScale({ ADMIN_ATTEMPT_WAIT_SCALE: '0.01' }), 0.01)
  assert.equal(adminWaitScale({ ADMIN_ATTEMPT_WAIT_SCALE: '0.2', NODE_ENV: 'development' }), 0.2)
  assert.equal(adminWaitScale({ ADMIN_ATTEMPT_WAIT_SCALE: '0.01', NODE_ENV: 'production' }), 1)
  for (const value of [undefined, '', '0', '-1', '2', 'fast', 'NaN']) {
    assert.equal(adminWaitScale({ ADMIN_ATTEMPT_WAIT_SCALE: value }), 1, String(value))
  }
})

test('the addresses a summary line tells apart are bounded', () => {
  let time = 0
  const lines = []
  const tasks = []
  const g = createAdminGate({
    code: 'a-code-long-enough-for-this',
    now: () => time,
    log: line => lines.push(line),
    schedule: (fn, ms) => {
      tasks.push(fn)
      return () => {}
    },
  })
  for (let i = 0; i < 12000; i++) g.attempt({ socket: {}, user: `u-${i}`, address: `addr-${i}`, parents: [] }, 'no')
  g.close()
  assert.equal(lines.length, 1)
  assert.match(lines[0], /from 10000 addresses/)
})
