// src/server/adminCode.js: the admin mode a world runs in, what is said about it at start-up, and the brake on wrong
// `/admin` codes.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ADMIN_CODE_MAX_LENGTH,
  SOCKET_ATTEMPTS,
  adminMode,
  adminStartupNotes,
  adminWaitScale,
  createAdminGate,
} from '../src/server/adminCode.js'

const CODE = 'correct-horse-battery-staple'
const SECOND = 1000

function gate(options = {}) {
  let time = 1_000_000
  const lines = []
  const g = createAdminGate({ code: CODE, now: () => time, log: line => lines.push(line), ...options })
  return {
    g,
    lines,
    advance: ms => (time += ms),
    // a new visitor: a socket, a user id, an address
    who: (n, address = `203.0.113.${n}`, parents = []) => ({ socket: {}, user: `user-${n}`, address, parents }),
  }
}

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

test('start-up notes: what the operator is told', () => {
  const levels = env => adminStartupNotes(env).map(note => note.level)
  const text = env =>
    adminStartupNotes(env)
      .map(note => note.message)
      .join('\n')
  assert.deepEqual(levels({ ADMIN_CODE: 'a-long-random-code-of-32-chars-xx' }), [])
  assert.deepEqual(levels({ NODE_ENV: 'production' }), ['error'])
  assert.match(text({ NODE_ENV: 'production' }), /nobody can become admin.*ADMIN_OPEN=true/s)
  assert.deepEqual(levels({}), ['warn'])
  assert.match(text({}), /all users will have admin permissions/)
  assert.match(text({ ADMIN_CODE: '123456' }), /short \(6 characters\).*about 50 days/s)
  assert.match(text({ ADMIN_CODE: 'abcdefgh' }), /short \(8 characters\).*years/s)
  assert.match(text({ ADMIN_CODE: 'two words long enough' }), /whitespace/)
  assert.match(text({ ADMIN_CODE: 'x'.repeat(ADMIN_CODE_MAX_LENGTH + 1) }), /cannot be typed/)
  assert.match(text({ ADMIN_CODE: 'a-long-random-code-of-32-chars-xx', ADMIN_OPEN: 'true' }), /ADMIN_OPEN is ignored/)
  // the code itself is never part of a note
  for (const code of ['123456', 'two words long enough']) {
    assert.ok(!text({ ADMIN_CODE: code }).includes(code))
  }
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

test('three wrong codes are free; then a key waits 10, 20, 40 and 60 seconds, and 60 from then on', () => {
  const { g, advance } = gate()
  // one address, a new socket and a new user for every attempt: only the address holds them
  let n = 0
  const visitor = () => ({ socket: {}, user: `fresh-${n++}`, address: '203.0.113.7', parents: [] })
  for (let i = 0; i < 3; i++) assert.equal(g.attempt(visitor(), 'no').reason, 'wrong', `free failure ${i + 1}`)
  assert.equal(g.attempt(visitor(), 'no').reason, 'wrong', 'the fourth is still looked at')
  for (const seconds of [10, 20, 40, 60, 60, 60]) {
    assert.equal(g.attempt(visitor(), 'no').reason, 'wait', `waiting ${seconds} s`)
    advance(seconds * SECOND - 1)
    assert.equal(g.attempt(visitor(), 'no').reason, 'wait', `still waiting at ${seconds} s less a millisecond`)
    advance(1)
    assert.equal(g.attempt(visitor(), 'no').reason, 'wrong', `looked at again after ${seconds} s`)
  }
})

test('during a wait the right code is refused too, unread, and the wait is not lengthened by trying', () => {
  const { g, advance, who } = gate()
  const admin = who(1)
  for (let i = 0; i < 4; i++) g.attempt({ ...admin, socket: {} }, 'no')
  // 10 s wait: hammering does not move its end
  for (let i = 0; i < 5; i++) {
    advance(1 * SECOND)
    assert.equal(g.attempt({ ...admin, socket: {} }, CODE).reason, 'wait')
  }
  advance(5 * SECOND)
  assert.deepEqual(g.attempt({ ...admin, socket: {} }, CODE), { ok: true }, 'accepted once the 10 s are over')
})

test('the player is told once per wait, not once per packet', () => {
  const { g, advance, who } = gate()
  const visitor = { ...who(1), socket: {} }
  const tells = []
  for (let i = 0; i < 4; i++) tells.push(g.attempt({ ...visitor, socket: {} }, 'no').tell)
  assert.deepEqual(tells, [true, true, true, true], 'each wrong code is answered')
  const during = []
  for (let i = 0; i < 4; i++) during.push(g.attempt({ ...visitor, socket: {} }, 'no').tell)
  assert.deepEqual(during, [true, false, false, false])
  advance(10 * SECOND)
  assert.equal(g.attempt({ ...visitor, socket: {} }, 'no').tell, true)
  assert.equal(g.attempt({ ...visitor, socket: {} }, 'no').tell, true, 'the next wait is said once again')
  assert.equal(g.attempt({ ...visitor, socket: {} }, 'no').tell, false)
})

test('the strictest key applies: a user id is held on a new address, an address holds a new user', () => {
  const { g } = gate()
  for (let i = 0; i < 4; i++) g.attempt({ socket: {}, user: 'mallory', address: `198.51.100.${i}` }, 'no')
  assert.equal(g.attempt({ socket: {}, user: 'mallory', address: '198.51.100.200' }, CODE).reason, 'wait')
  assert.equal(g.attempt({ socket: {}, user: 'someone-else', address: '198.51.100.201' }, CODE).ok, true)
  for (let i = 0; i < 4; i++) g.attempt({ socket: {}, user: `fresh-${i}`, address: '198.51.100.50' }, 'no')
  assert.equal(g.attempt({ socket: {}, user: 'newcomer', address: '198.51.100.50' }, CODE).reason, 'wait')
})

test('the wider networks of an address are charged on a looser schedule; an unknown address is not a key', () => {
  const { g, advance } = gate()
  // a guesser moving through the /64s of one /48: each address is new, the /48 is not
  const parents = ['2001:db8:1:ff00::/56', '2001:db8:1::/48']
  let n = 0
  const from = () => ({ socket: {}, user: `v6-${n}`, address: `2001:db8:1:${(n++).toString(16)}::/64`, parents })
  for (let i = 0; i < 32; i++) assert.equal(g.attempt(from(), 'no').reason, 'wrong', `free failure ${i + 1}`)
  assert.equal(g.attempt(from(), 'no').reason, 'wrong', 'the 33rd is still looked at')
  assert.equal(g.attempt(from(), CODE).reason, 'wait', 'then the /48 waits, whatever /64 it comes from')
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

test('a socket is closed at its twentieth attempt, refused ones included; a new socket starts at zero', () => {
  const { g, who } = gate()
  const visitor = who(1)
  const reasons = []
  for (let i = 0; i < SOCKET_ATTEMPTS + 3; i++) reasons.push(g.attempt(visitor, 'no').reason)
  assert.deepEqual(reasons.slice(0, 4), ['wrong', 'wrong', 'wrong', 'wrong'])
  assert.ok(reasons.slice(4, SOCKET_ATTEMPTS).every(reason => reason === 'wait'))
  assert.deepEqual(reasons.slice(SOCKET_ATTEMPTS), ['closed', 'closed', 'closed'])
  // the same user on a new socket (a reconnect, a takeover): the socket's count is new, the user's is not
  assert.equal(g.attempt({ ...visitor, socket: {} }, CODE).reason, 'wait')
})

test('the right code clears the socket and the user, not the address', () => {
  const { g, advance } = gate()
  const admin = { socket: {}, user: 'admin', address: '203.0.113.80', parents: [] }
  for (let i = 0; i < 3; i++) g.attempt(admin, 'typo')
  assert.equal(g.attempt(admin, CODE).ok, true)
  // the user's three failures are gone: three more are free again from another address
  const elsewhere = { ...admin, address: '203.0.113.81' }
  for (let i = 0; i < 3; i++) assert.equal(g.attempt(elsewhere, 'typo').reason, 'wrong')
  assert.equal(g.attempt(elsewhere, CODE).ok, true)
  // the first address kept its three: one more wrong code there starts its wait
  assert.equal(g.attempt({ socket: {}, user: 'guest', address: '203.0.113.80', parents: [] }, 'no').reason, 'wrong')
  assert.equal(g.attempt({ socket: {}, user: 'guest-2', address: '203.0.113.80', parents: [] }, CODE).reason, 'wait')
  advance(10 * SECOND)
  assert.equal(g.attempt({ socket: {}, user: 'guest-2', address: '203.0.113.80', parents: [] }, CODE).ok, true)
})

test('a key without a failure for 15 minutes is forgotten; the table is bounded and never drops a key that waits', () => {
  const { g, advance } = gate()
  const visitor = n => ({ socket: {}, user: `u-${n}`, address: `a-${n}`, parents: [] })
  for (let i = 0; i < 4; i++) g.attempt({ ...visitor(1), socket: {} }, 'no')
  advance(15 * 60 * SECOND + 1)
  for (let i = 0; i < 3; i++) assert.equal(g.attempt({ ...visitor(1), socket: {} }, 'no').reason, 'wrong', 'free again')

  // one key kept waiting while thousands of others fail once each
  const held = gate()
  const target = { socket: {}, user: 'held', address: 'held-address', parents: [] }
  for (let i = 0; i < 8; i++) held.g.attempt({ ...target, socket: {} }, 'no') // well into its waits
  for (let i = 0; i < 9000; i++) held.g.attempt(visitor(i), 'no')
  assert.ok(held.g.size() <= 8192, `table size ${held.g.size()}`)
  assert.equal(held.g.attempt({ ...target, socket: {} }, CODE).reason, 'wait', 'the waiting key was not dropped')
})

test('wrong codes are logged as one summary a minute, without codes or addresses', () => {
  const { g, lines, advance } = gate()
  for (let i = 0; i < 5; i++)
    g.attempt({ socket: {}, user: `u-${i}`, address: `203.0.113.${i}`, parents: [] }, 'secret?')
  assert.deepEqual(lines, [], 'nothing per attempt')
  advance(61 * SECOND)
  g.attempt({ socket: {}, user: 'later', address: '203.0.113.99', parents: [] }, 'x')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[admin\] 5 wrong admin codes in the last minute, from 5 addresses$/)
  assert.ok(!lines[0].includes('secret?') && !lines[0].includes('203.0.113'))
})

test('waitScale shortens the waits (the e2e harness)', () => {
  const { g, advance } = gate({ waitScale: 0.01 })
  const visitor = { user: 'u', address: '203.0.113.1', parents: [] }
  for (let i = 0; i < 4; i++) g.attempt({ ...visitor, socket: {} }, 'no')
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
