import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_BUDGETS, createActionBudgets } from '../src/core/extras/actionBudget.js'

const spendMany = (budgets, socket, action, at, n) =>
  Array.from({ length: n }, () => budgets.spend(socket, action, at).ok).filter(Boolean).length

test('the budgets: one for each kind of thing a person does by hand', () => {
  assert.deepEqual(ACTION_BUDGETS, {
    chat: { rate: 1, burst: 6 },
    appChat: { rate: 2, burst: 10 },
    identity: { rate: 0.5, burst: 5 },
    command: { rate: 2, burst: 10 },
    settings: { rate: 5, burst: 30 },
    moderation: { rate: 2, burst: 10 },
  })
  assert.ok(Object.isFrozen(ACTION_BUDGETS) && Object.isFrozen(ACTION_BUDGETS.chat))
})

test('a burst is let through, then the rate; what waited is not lost beyond the burst', () => {
  const budgets = createActionBudgets()
  const socket = {}
  assert.equal(spendMany(budgets, socket, 'chat', 1000, 100), 6, 'the burst')
  assert.equal(budgets.refused(socket, 'chat'), 94)
  // one more a second
  assert.equal(spendMany(budgets, socket, 'chat', 1999, 5), 0)
  assert.equal(spendMany(budgets, socket, 'chat', 2000, 5), 1)
  assert.equal(spendMany(budgets, socket, 'chat', 4500, 5), 2)
  // a long quiet time refills to the burst and no further
  assert.equal(spendMany(budgets, socket, 'chat', 10_000_000, 100), 6)
  // half a token a second for a name: one every two seconds
  assert.equal(spendMany(budgets, socket, 'identity', 0, 10), 5)
  assert.equal(spendMany(budgets, socket, 'identity', 1999, 10), 0)
  assert.equal(spendMany(budgets, socket, 'identity', 2000, 10), 1)
})

test('a flood at the rate the inbound gate admits: over a minute, the burst plus the rate', () => {
  const budgets = createActionBudgets()
  const socket = {}
  let passed = 0
  // 1000 packets a second for 60 seconds
  for (let ms = 0; ms < 60000; ms++) if (budgets.spend(socket, 'chat', ms).ok) passed++
  assert.equal(passed, 6 + 59)
  assert.equal(budgets.refused(socket, 'chat'), 60000 - 65)
})

test('a person typing is never refused', () => {
  const budgets = createActionBudgets()
  const socket = {}
  // a line every two seconds for ten minutes, with a burst of five quick lines every minute
  let refused = 0
  for (let s = 0; s < 600; s += 2) {
    if (!budgets.spend(socket, 'chat', s * 1000).ok) refused++
    if (s % 60 === 0) for (let i = 1; i <= 4; i++) if (!budgets.spend(socket, 'chat', s * 1000 + i * 150).ok) refused++
  }
  assert.equal(refused, 0)
})

test('each connection and each kind has its own budget', () => {
  const budgets = createActionBudgets()
  const a = {}
  const b = {}
  assert.equal(spendMany(budgets, a, 'chat', 0, 50), 6)
  assert.equal(spendMany(budgets, b, 'chat', 0, 50), 6, 'another connection')
  assert.equal(spendMany(budgets, a, 'command', 0, 50), 10, 'another kind')
  assert.equal(spendMany(budgets, a, 'appChat', 0, 50), 10)
  assert.equal(spendMany(budgets, a, 'settings', 0, 50), 30)
  assert.equal(spendMany(budgets, a, 'moderation', 0, 50), 10, 'a moderator is not held by the settings edited')
  assert.equal(budgets.refused(a, 'chat'), 44)
  assert.equal(budgets.refused(b, 'command'), 0)
  assert.equal(budgets.refused({}, 'chat'), 0, 'a connection never seen')
})

test('the sender is told once per wait, not once per packet', () => {
  const budgets = createActionBudgets({ chat: { rate: 1, burst: 2 } })
  const socket = {}
  const results = []
  const go = at => results.push(budgets.spend(socket, 'chat', at))
  go(0)
  go(0)
  go(0) // refused: told
  go(10) // refused: not told again
  go(500)
  go(1000) // let through
  go(1001) // refused: told again, a new wait
  go(1002)
  assert.deepEqual(results, [
    { ok: true },
    { ok: true },
    { ok: false, tell: true },
    { ok: false, tell: false },
    { ok: false, tell: false },
    { ok: true },
    { ok: false, tell: true },
    { ok: false, tell: false },
  ])
})

test('time that does not advance, or goes back, gives nothing', () => {
  const budgets = createActionBudgets({ chat: { rate: 1, burst: 1 } })
  const socket = {}
  assert.equal(budgets.spend(socket, 'chat', 5000).ok, true)
  // packets that waited in the inbox carry their arrival times; one stamped earlier is not a refill
  assert.equal(budgets.spend(socket, 'chat', 1000).ok, false)
  assert.equal(budgets.spend(socket, 'chat', 5000).ok, false)
  assert.equal(budgets.spend(socket, 'chat', 5999).ok, false)
  assert.equal(budgets.spend(socket, 'chat', 6000).ok, true)
  // and the earlier stamp did not move the clock back: no second token for the same second
  assert.equal(budgets.spend(socket, 'chat', 6000).ok, false)
})

test('a kind without a budget is a mistake in the caller, said at once', () => {
  const budgets = createActionBudgets()
  assert.throws(() => budgets.spend({}, 'teleport', 0), /no budget for teleport/)
})

test('the state goes with the connection object', () => {
  // (a WeakMap: nothing is kept for a connection that is gone; a new connection object starts with a full burst)
  const budgets = createActionBudgets({ chat: { rate: 1, burst: 1 } })
  let socket = {}
  assert.equal(budgets.spend(socket, 'chat', 0).ok, true)
  assert.equal(budgets.spend(socket, 'chat', 0).ok, false)
  socket = {}
  assert.equal(budgets.spend(socket, 'chat', 0).ok, true)
})
