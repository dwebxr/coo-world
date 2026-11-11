import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKickList, KICK_LIMIT_DEFAULTS, readKickEnv } from '../src/server/kickList.js'

const MINUTE = 60 * 1000

function clocked(limits, options = {}) {
  const clock = { time: 1000 }
  return { clock, list: createKickList(limits, { now: () => clock.time, ...options }) }
}

test('KICK_MINUTES and KICK_BY_ADDRESS: unset keeps the defaults; a bad value throws', () => {
  assert.deepEqual(KICK_LIMIT_DEFAULTS, { minutes: 10, byAddress: false })
  assert.deepEqual(readKickEnv({}), { minutes: 10, byAddress: false })
  assert.deepEqual(readKickEnv({ KICK_MINUTES: '', KICK_BY_ADDRESS: '' }), { minutes: 10, byAddress: false })
  assert.deepEqual(readKickEnv({ KICK_MINUTES: '0', KICK_BY_ADDRESS: 'true' }), { minutes: 0, byAddress: true })
  assert.deepEqual(readKickEnv({ KICK_MINUTES: '1440', KICK_BY_ADDRESS: 'false' }), { minutes: 1440, byAddress: false })
  for (const value of ['-1', '1441', '1.5', 'ten', ' ', '1e99', 'Infinity']) {
    assert.throws(
      () => readKickEnv({ KICK_MINUTES: value }),
      /KICK_MINUTES must be a whole number from 0 to 1440/,
      value
    )
  }
  for (const value of ['1', 'yes', 'TRUE', 'on']) {
    assert.throws(() => readKickEnv({ KICK_BY_ADDRESS: value }), /KICK_BY_ADDRESS must be true or false/, value)
  }
})

test('a kicked user id is refused for the minutes, and no longer', () => {
  const { clock, list } = clocked({ minutes: 10 })
  assert.equal(list.refusesUser('u1'), false)
  list.add({ userId: 'u1', addressKey: '203.0.113.7', byAdmin: true })
  assert.equal(list.refusesUser('u1'), true)
  assert.equal(list.refusesUser('u2'), false)
  clock.time += 10 * MINUTE - 1
  assert.equal(list.refusesUser('u1'), true)
  clock.time += 1
  assert.equal(list.refusesUser('u1'), false)
  assert.deepEqual(list.stats(), { users: 0, addresses: 0 }, 'an ended entry is dropped when asked')
})

test('a second kick starts the wait again', () => {
  const { clock, list } = clocked({ minutes: 10 })
  list.add({ userId: 'u1' })
  clock.time += 9 * MINUTE
  list.add({ userId: 'u1' })
  clock.time += 9 * MINUTE
  assert.equal(list.refusesUser('u1'), true)
  clock.time += MINUTE
  assert.equal(list.refusesUser('u1'), false)
})

test('KICK_MINUTES=0: a kick keeps nobody out', () => {
  const { list } = clocked({ minutes: 0, byAddress: true })
  list.add({ userId: 'u1', addressKey: '203.0.113.7', byAdmin: true })
  assert.deepEqual(list.stats(), { users: 0, addresses: 0 }, 'nothing is listed')
  assert.equal(list.refusesUser('u1'), false)
  assert.equal(list.refusesNewcomer('203.0.113.7'), false)
})

test('the address of a kick holds newcomers only when asked for, only after an admin, never the unknown address', () => {
  const off = clocked({ minutes: 10 }).list
  off.add({ userId: 'u1', addressKey: '203.0.113.7', byAdmin: true })
  assert.equal(off.refusesNewcomer('203.0.113.7'), false, 'off by default')
  assert.deepEqual(off.stats(), { users: 1, addresses: 0 })

  const { clock, list } = clocked({ minutes: 10, byAddress: true })
  list.add({ userId: 'u1', addressKey: '203.0.113.7', byAdmin: false })
  assert.equal(list.refusesNewcomer('203.0.113.7'), false, 'a builder kicked: no address entry')
  assert.equal(list.refusesUser('u1'), true)
  list.add({ userId: 'u2', addressKey: 'unknown', byAdmin: true })
  assert.equal(list.refusesNewcomer('unknown'), false, 'the key of every unreadable address names nobody')
  for (const addressKey of [undefined, null, '', 7]) {
    list.add({ userId: 'u3', addressKey, byAdmin: true })
    assert.equal(list.refusesNewcomer(addressKey), false)
  }
  assert.deepEqual(list.stats(), { users: 3, addresses: 0 })
  list.add({ userId: 'u4', addressKey: '203.0.113.7', byAdmin: true })
  assert.equal(list.refusesNewcomer('203.0.113.7'), true)
  assert.equal(list.refusesNewcomer('203.0.113.8'), false)
  clock.time += 10 * MINUTE
  assert.equal(list.refusesNewcomer('203.0.113.7'), false)
})

test('the lists are bounded: ended entries go first, then the oldest', () => {
  const { clock, list } = clocked({ minutes: 10, byAddress: true }, { max: 3 })
  for (const id of ['a', 'b', 'c']) {
    list.add({ userId: id, addressKey: `net-${id}`, byAdmin: true })
    clock.time += MINUTE
  }
  list.add({ userId: 'd', addressKey: 'net-d', byAdmin: true })
  assert.deepEqual(list.stats(), { users: 3, addresses: 3 })
  assert.equal(list.refusesUser('a'), false, 'the oldest gave way')
  assert.equal(list.refusesNewcomer('net-a'), false)
  assert.ok(['b', 'c', 'd'].every(id => list.refusesUser(id)))
  // everything has ended by the next kick: it is swept, not counted
  clock.time += 20 * MINUTE
  list.add({ userId: 'e' })
  assert.deepEqual(list.stats(), { users: 1, addresses: 3 })
  list.add({ userId: 'f', addressKey: 'net-f', byAdmin: true })
  assert.deepEqual(list.stats(), { users: 2, addresses: 1 })
})

test('what is not a user id is not listed', () => {
  const { list } = clocked({ minutes: 10 })
  for (const userId of [undefined, null, '', 7, {}]) list.add({ userId })
  assert.deepEqual(list.stats(), { users: 0, addresses: 0 })
})
