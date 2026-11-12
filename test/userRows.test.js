// src/server/userRows.js on its own: the order of a user's writes, what a join gets, what a failure leaves, when
// an entry goes, and the final save. The handlers and the join that use it are in test/userRowsNetwork.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createUserRows } from '../src/server/userRows.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const turn = () => new Promise(resolve => setImmediate(resolve))
// counts the turns of the event loop from now on (a timer or a signal would run in each); the call ends the count
const countTurns = () => {
  let turns = 0
  let counting = true
  const count = () => {
    if (!counting) return
    turns++
    setImmediate(count)
  }
  setImmediate(count)
  return () => {
    counting = false
    return turns
  }
}

// A database of one table: update() records the statement and waits to be told how it ends (`held`), or ends at
// once as `decide(userId, values)` says (an error to fail with, or nothing). A statement that lands changes the row.
function fixture({ decide = () => null, hold = false, ...options } = {}) {
  const f = { statements: [], rows: new Map(), failures: [], decide, hold, joining: new Set(), expired: false }
  f.rows_ = createUserRows({
    update: (userId, values) => {
      const statement = { userId, values: { ...values }, ...deferred() }
      f.statements.push(statement)
      // a writer that does not stop (no test here comes near 200 statements) is stopped as the final save's
      // deadline would stop it, and the test fails on what it counts
      if (f.statements.length > 200) f.expired = true
      const land = () => f.rows.set(userId, { ...f.rows.get(userId), ...values })
      if (!f.hold) {
        const error = f.decide(userId, values)
        if (error) return Promise.reject(error)
        land()
        return Promise.resolve()
      }
      return statement.promise.then(land)
    },
    onFailure: failure => f.failures.push(failure),
    expired: () => f.expired,
    held: userId => f.joining.has(userId),
    ...options,
  })
  f.written = () => f.statements.map(statement => statement.values)
  return f
}

test('intend: the statement starts before intend returns, and nothing is kept once it has landed', async () => {
  const f = fixture()
  f.rows_.intend('u', { name: 'Ada' })
  assert.deepEqual(f.written(), [{ name: 'Ada' }], 'started in the same turn')
  assert.deepEqual(f.rows_.intended('u'), { name: 'Ada' })
  // (a copy: what a join does with it changes nothing here)
  f.rows_.intended('u').name = 'changed by the caller'
  assert.deepEqual(f.rows_.intended('u'), { name: 'Ada' })
  assert.equal(f.rows_.unstored(), 1)
  await f.rows_.idle()
  assert.deepEqual(f.rows.get('u'), { name: 'Ada' })
  assert.equal(f.rows_.intended('u'), null)
  assert.equal(f.rows_.size, 0)
  assert.equal(f.rows_.unstored(), 0)
})

test('one statement of a user at a time: changes decided meanwhile go out with the next, as they are then', async () => {
  const f = fixture({ hold: true })
  f.rows_.intend('u', { name: 'one' })
  f.rows_.intend('u', { name: 'two' })
  f.rows_.intend('u', { avatar: 'asset://a.vrm' })
  f.rows_.intend('u', { name: 'three' })
  // another user's writer is its own
  f.rows_.intend('v', { name: 'other' })
  assert.deepEqual(
    f.statements.map(statement => statement.userId),
    ['u', 'v']
  )
  assert.deepEqual(f.rows_.intended('u'), { name: 'three', avatar: 'asset://a.vrm' })
  f.statements[0].resolve()
  await turn()
  assert.deepEqual(f.written(), [{ name: 'one' }, { name: 'other' }, { name: 'three', avatar: 'asset://a.vrm' }])
  assert.equal(f.rows_.unstored(), 2)
  f.statements[2].resolve()
  f.statements[1].resolve()
  await f.rows_.idle()
  assert.deepEqual(f.rows.get('u'), { name: 'three', avatar: 'asset://a.vrm' })
  assert.equal(f.rows_.size, 0)
})

test('statements that would have crossed on a pool of several connections cannot: the row ends on the last decision', async () => {
  // the pool answers the second statement of a user first, when it is given two at once. It never is
  const f = fixture({ hold: true })
  for (const rank of [2, 0, 1, 0]) f.rows_.intend('u', { rank })
  assert.equal(f.statements.length, 1)
  f.statements[0].resolve()
  await turn()
  assert.deepEqual(f.written(), [{ rank: 2 }, { rank: 0 }])
  f.rows_.intend('u', { rank: 1 })
  assert.equal(f.statements.length, 2, 'still one at a time')
  f.statements[1].resolve()
  await turn()
  f.statements[2].resolve()
  await f.rows_.idle()
  assert.deepEqual(f.written(), [{ rank: 2 }, { rank: 0 }, { rank: 1 }])
  assert.deepEqual(f.rows.get('u'), { rank: 1 })
})

test('a column that is stored is not written again with a later change of another column', async () => {
  const f = fixture()
  f.joining.add('u') // keeps the entry
  f.rows_.intend('u', { rank: 1 })
  await f.rows_.idle()
  f.rows_.intend('u', { name: 'Ada' })
  await f.rows_.idle()
  assert.deepEqual(f.written(), [{ rank: 1 }, { name: 'Ada' }])
  assert.deepEqual(f.rows_.intended('u'), { rank: 1, name: 'Ada' })
})

test('a completion runs once, for a statement that carries its change, with what the database then holds', async () => {
  const f = fixture({ hold: true })
  const calls = []
  f.rows_.intend('u', { name: 'first' })
  // decided while the statement for the name is under way: that statement does not carry the rank
  f.rows_.intend('u', { rank: 1 }, written => calls.push(['a', written]))
  f.statements[0].resolve()
  await turn()
  assert.deepEqual(calls, [], 'not for a statement that started before the change')
  assert.deepEqual(f.written(), [{ name: 'first' }, { rank: 1 }])
  // two more decisions while the rank is being written
  f.rows_.intend('u', { rank: 0 }, written => calls.push(['b', written]))
  f.rows_.intend('u', { rank: 2 }, written => calls.push(['c', written]))
  f.statements[1].resolve()
  await turn()
  assert.deepEqual(calls, [['a', { rank: 1 }]], 'the later decisions wait for a statement that carries them')
  assert.deepEqual(f.written().at(-1), { rank: 2 })
  f.statements[2].resolve()
  await f.rows_.idle()
  // the decision of rank 0 was never written by itself: it is told what the database holds, the later rank
  assert.deepEqual(calls, [
    ['a', { rank: 1 }],
    ['b', { rank: 2 }],
    ['c', { rank: 2 }],
  ])
  assert.equal(f.rows_.size, 0)
})

test('a completion of a change of two columns waits for both, and one that throws stops nothing', async () => {
  const error = new Error('completion bug')
  const calls = []
  const f = fixture({ decide: (_userId, values) => ('avatar' in values ? new Error('refused') : null) })
  f.rows_.intend('u', { name: 'Ada', avatar: 'x' }, written => calls.push(written))
  await f.rows_.idle()
  assert.deepEqual(calls, [], 'the avatar is not stored')
  f.decide = () => null
  f.rows_.intend('u', { rank: 1 }, () => {
    throw error
  })
  await f.rows_.idle()
  assert.deepEqual(calls, [{ name: 'Ada', avatar: 'x' }])
  assert.deepEqual(f.failures.at(-1), { userId: 'u', columns: ['rank'], error, completion: true })
  assert.equal(f.rows_.unstored(), 0, 'the values are stored all the same')
  assert.equal(f.rows_.size, 0)
  // and the writer is not stuck
  f.rows_.intend('u', { rank: 2 })
  await f.rows_.idle()
  assert.deepEqual(f.rows.get('u'), { name: 'Ada', avatar: 'x', rank: 2 })
})

test('a failed statement: said once, kept, not tried again by itself, written with the next change', async () => {
  const busy = new Error('SQLITE_BUSY')
  const f = fixture({ decide: () => busy })
  let stored = 0
  f.rows_.intend('u', { rank: 1 }, () => stored++)
  await f.rows_.idle()
  assert.deepEqual(f.failures, [{ userId: 'u', columns: ['rank'], error: busy }])
  assert.equal(stored, 0)
  assert.deepEqual(f.rows_.intended('u'), { rank: 1 }, 'a join still gets it')
  assert.equal(f.rows_.unstored(), 1)
  assert.equal(f.rows_.unsettled('u', 'rank'), 0, 'nothing is under way')
  for (let i = 0; i < 5; i++) await turn()
  assert.equal(f.statements.length, 1, 'no retry by itself')
  // the next change of that user carries what failed; it fails too and is not said again
  f.rows_.intend('u', { name: 'Ada' })
  await f.rows_.idle()
  assert.deepEqual(f.written().slice(1), [{ rank: 1, name: 'Ada' }, { rank: 1 }, { name: 'Ada' }])
  assert.equal(f.failures.length, 1, 'one line for the run of failures')
  // the database is back: the next change stores everything, and the completion hears of it
  f.decide = () => null
  f.rows_.intend('u', { name: 'Bea' })
  await f.rows_.idle()
  assert.deepEqual(f.written().at(-1), { rank: 1, name: 'Bea' })
  assert.deepEqual(f.rows.get('u'), { rank: 1, name: 'Bea' })
  assert.equal(stored, 1)
  assert.equal(f.rows_.size, 0)
  // a new run of failures is said again
  f.decide = () => busy
  f.rows_.intend('u', { rank: 0 })
  await f.rows_.idle()
  assert.equal(f.failures.length, 2)
})

test('a run of failures ends with a statement that lands, also when the entry stays', async () => {
  const busy = () => new Error('SQLITE_BUSY')
  const f = fixture({ decide: busy })
  f.rows_.intend('u', { name: 'one' })
  await f.rows_.idle()
  assert.equal(f.failures.length, 1)
  // the next statement lands, and the one after it (a change decided meanwhile) fails: a new run, said again
  f.hold = true
  f.rows_.intend('u', { name: 'two' })
  f.rows_.intend('u', { name: 'three' })
  f.statements[1].resolve()
  await turn()
  assert.equal(f.statements.length, 3)
  f.statements[2].reject(busy())
  await f.rows_.idle()
  assert.equal(f.failures.length, 2)
  assert.deepEqual(f.rows.get('u'), { name: 'two' })
  assert.deepEqual(f.rows_.intended('u'), { name: 'three' })
})

test('a value the database refuses (too long for its column) does not hold back the other columns', async () => {
  // PostgreSQL: value too long for type character varying(255). Every statement that carries the avatar fails
  const tooLong = Object.assign(new Error('value too long for type character varying(255)'), { code: '22001' })
  const f = fixture({ decide: (_userId, values) => (values.avatar?.length > 255 ? tooLong : null) })
  const avatar = 'https://example.com/' + 'a'.repeat(300)
  f.rows_.intend('u', { avatar })
  await f.rows_.idle()
  assert.equal(f.failures.length, 1)
  let stored = null
  f.rows_.intend('u', { rank: 2 }, written => (stored = written))
  assert.equal(f.rows_.unsettled('u', 'rank'), 1)
  await f.rows_.idle()
  // together (refused), then each on its own
  assert.deepEqual(f.written().slice(1), [{ avatar, rank: 2 }, { avatar }, { rank: 2 }])
  assert.deepEqual(f.rows.get('u'), { rank: 2 }, 'the rank is stored')
  assert.deepEqual(stored, { rank: 2 }, 'and its completion ran')
  assert.equal(f.rows_.unsettled('u', 'rank'), 0)
  assert.deepEqual(f.rows_.intended('u'), { avatar, rank: 2 }, 'the avatar stays decided, for joins')
  assert.equal(f.rows_.unstored(), 1)
  assert.equal(f.failures.length, 1, 'still the same run of failures')
  assert.deepEqual(f.failures[0], { userId: 'u', columns: ['avatar'], error: tooLong })
  // it is tried again with each later change, and fails again: nothing repairs it but a value that fits
  f.rows_.intend('u', { name: 'Ada' })
  await f.rows_.idle()
  assert.deepEqual(f.written().slice(4), [{ avatar, name: 'Ada' }, { avatar }, { name: 'Ada' }])
  assert.equal(f.rows_.unstored(), 1)
  f.rows_.intend('u', { avatar: 'asset://short.vrm' })
  await f.rows_.idle()
  assert.equal(f.rows_.unstored(), 0)
  assert.deepEqual(f.rows.get('u'), { rank: 2, name: 'Ada', avatar: 'asset://short.vrm' })
})

test('a failure of several columns names the ones that failed on their own, with their error', async () => {
  const together = new Error('together')
  const alone = new Error('alone')
  const f = fixture({
    decide: (_userId, values) => (Object.keys(values).length > 1 ? together : 'name' in values ? alone : null),
  })
  f.rows_.intend('u', { name: 'Ada', avatar: 'x' })
  await f.rows_.idle()
  assert.deepEqual(f.failures, [{ userId: 'u', columns: ['name'], error: alone }])
  assert.deepEqual(f.rows.get('u'), { avatar: 'x' })
  // a statement of several columns that fails while each lands on its own is no failure
  const g = fixture({ decide: (_userId, values) => (Object.keys(values).length > 1 ? together : null) })
  g.rows_.intend('u', { name: 'Ada', avatar: 'x' })
  await g.rows_.idle()
  assert.deepEqual(g.failures, [])
  assert.equal(g.rows_.size, 0)
})

test('unsettled: 1 while a statement carrying the column is under way or about to start, 0 otherwise', async () => {
  const f = fixture({ hold: true })
  assert.equal(f.rows_.unsettled('u', 'rank'), 0)
  f.rows_.intend('u', { name: 'Ada' })
  assert.equal(f.rows_.unsettled('u', 'rank'), 0, 'a statement for another column')
  assert.equal(f.rows_.unsettled('u', 'name'), 1)
  f.rows_.intend('u', { rank: 1 })
  assert.equal(f.rows_.unsettled('u', 'rank'), 1, 'about to start, behind the name')
  assert.equal(f.rows_.unsettled('v', 'rank'), 0, 'another user')
  f.statements[0].resolve()
  await turn()
  assert.equal(f.rows_.unsettled('u', 'name'), 0)
  assert.equal(f.rows_.unsettled('u', 'rank'), 1, 'under way')
  f.statements[1].reject(new Error('SQLITE_BUSY'))
  await f.rows_.idle()
  assert.equal(f.rows_.unsettled('u', 'rank'), 0, 'failed: nothing under way')
  assert.equal(f.rows_.unstored(), 1)
})

test('an entry stays while its user is joining, stored or not, and goes when the join ends', async () => {
  const f = fixture()
  f.joining.add('u')
  f.rows_.intend('u', { rank: 0 })
  await f.rows_.idle()
  assert.equal(f.rows_.unstored(), 0)
  assert.deepEqual(f.rows_.intended('u'), { rank: 0 }, 'stored, and still what the join gets')
  f.rows_.sweep('u')
  assert.equal(f.rows_.size, 1, 'still joining')
  f.joining.delete('u')
  f.rows_.sweep('u')
  assert.equal(f.rows_.size, 0)
  // not while something is unstored: a statement that failed, or one that is under way
  f.decide = () => new Error('SQLITE_BUSY')
  f.rows_.intend('u', { rank: 1 })
  await f.rows_.idle()
  f.rows_.sweep('u')
  assert.deepEqual(f.rows_.intended('u'), { rank: 1 })
  const g = fixture({ hold: true })
  g.rows_.intend('u', { rank: 1 })
  g.rows_.sweep('u')
  assert.equal(g.rows_.size, 1)
  g.statements[0].resolve()
  await g.rows_.idle()
  assert.equal(g.rows_.size, 0)
  g.rows_.sweep('nobody')
})

test('flush: waits for what is under way, then tries what failed once more, one user after the other', async () => {
  const busy = () => new Error('SQLITE_BUSY')
  const f = fixture({ decide: busy })
  for (const user of ['a', 'b', 'c']) f.rows_.intend(user, { name: user })
  await f.rows_.idle()
  assert.equal(f.rows_.unstored(), 3)
  // an entry with nothing unstored (its user is joining) gets no statement
  f.decide = () => null
  f.joining.add('j')
  f.rows_.intend('j', { rank: 1 })
  await f.rows_.idle()
  f.hold = true
  f.rows_.intend('d', { name: 'd' })
  let done = false
  const flushing = f.rows_.flush().then(() => (done = true))
  for (let i = 0; i < 3; i++) await turn()
  assert.equal(f.statements.length, 5, 'nothing more while a statement is under way')
  f.statements[4].resolve()
  // the retried statements are held too: the next user's starts only when the one before has ended
  for (const [index, user] of ['a', 'b', 'c'].entries()) {
    for (let i = 0; i < 3; i++) await turn()
    assert.equal(f.statements.length, 6 + index, `one at a time (${user})`)
    assert.equal(f.statements.at(-1).userId, user)
    assert.equal(done, false)
    if (user === 'b') f.statements.at(-1).reject(busy())
    else f.statements.at(-1).resolve()
  }
  await flushing
  assert.equal(f.statements.length, 8, 'one more statement for each user with something unstored, and no more')
  assert.equal(f.rows_.unstored(), 1)
  assert.deepEqual(f.rows_.intended('b'), { name: 'b' })
  assert.equal(f.rows_.size, 2, 'b, and the user that is joining')
})

test('flush: a turn of the event loop passes before each user; past the deadline the users are not gone through', async () => {
  const f = fixture({ decide: () => new Error('SQLITE_BUSY') })
  for (const user of ['a', 'b', 'c']) f.rows_.intend(user, { name: user })
  await f.rows_.idle()
  let turns = countTurns()
  await f.rows_.flush()
  assert.ok(turns() >= 3, 'a turn before each of the three')
  assert.equal(f.statements.length, 6)
  f.expired = true
  turns = countTurns()
  await f.rows_.flush()
  assert.equal(turns(), 0, 'ended at once')
  assert.equal(f.statements.length, 6)
})

test('past the deadline no statement is started: not by a change, not by the writer, not by the flush', async () => {
  const f = fixture({ hold: true })
  f.rows_.intend('u', { name: 'one' })
  f.rows_.intend('u', { name: 'two' })
  f.expired = true
  // (a statement started from here on would land at once)
  f.hold = false
  f.statements[0].resolve()
  await f.rows_.idle()
  assert.equal(f.statements.length, 1, 'the writer stops before its next statement')
  assert.equal(f.rows_.unstored(), 1)
  f.rows_.intend('v', { name: 'late' })
  await f.rows_.idle()
  await f.rows_.flush()
  assert.equal(f.statements.length, 1)
  assert.equal(f.rows_.unstored(), 2)
  // the deadline passing between the users of a flush, and between the statements of the columns of one user
  const g = fixture({ decide: () => new Error('SQLITE_BUSY') })
  g.rows_.intend('a', { name: 'a', avatar: 'x' })
  g.rows_.intend('b', { name: 'b' })
  await g.rows_.idle()
  const before = g.statements.length
  g.decide = (_userId, values) => {
    if (Object.keys(values).length === 1) g.expired = true
    return new Error('SQLITE_BUSY')
  }
  await g.rows_.flush()
  assert.deepEqual(
    g.written().slice(before),
    [{ name: 'a', avatar: 'x' }, { name: 'a' }],
    'nothing after the statement during which the deadline passed'
  )
  assert.equal(g.rows_.unstored(), 2)
  // the deadline passing during the turn the flush yields
  const h = fixture({ decide: () => new Error('SQLITE_BUSY') })
  h.rows_.intend('a', { name: 'a' })
  await h.rows_.idle()
  const flushing = h.rows_.flush()
  h.expired = true
  await flushing
  assert.equal(h.statements.length, 1)
})
