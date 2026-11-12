import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPendingChanges } from '../src/core/extras/pendingChanges.js'

test('a player with one change: the fields as they came, in their order, in an object of its own', () => {
  const pending = createPendingChanges()
  assert.equal(pending.size, 0)
  const fields = { id: 'a', p: [1, 2, 3], q: [0, 0, 0, 1], e: null }
  pending.merge(fields)
  assert.equal(pending.size, 1)
  const [entry] = pending.takeAll()
  assert.deepEqual(entry, fields)
  assert.deepEqual(Object.keys(entry), ['id', 'p', 'q', 'e'])
  assert.notEqual(entry, fields)
})

test('several changes of one player: the latest value of each field, and the fields a later change did not name', () => {
  const pending = createPendingChanges()
  pending.merge({ id: 'a', p: [1, 0, 0], m: 1, e: 'asset://wave.glb' })
  pending.merge({ id: 'a', p: [2, 0, 0], q: [0, 1, 0, 0] })
  pending.merge({ id: 'a', p: [3, 0, 0], e: null, ef: { freeze: true } })
  pending.merge({ id: 'a', ef: null })
  assert.equal(pending.size, 1)
  assert.deepEqual(pending.takeAll(), [{ id: 'a', p: [3, 0, 0], m: 1, e: null, q: [0, 1, 0, 0], ef: null }])
})

test('a teleport stays one when the player moved again in the same tick', () => {
  const pending = createPendingChanges()
  pending.merge({ id: 'a', p: [1, 0, 0] })
  pending.merge({ id: 'a', p: [50, 0, 50], q: [0, 0, 0, 1], t: true })
  pending.merge({ id: 'a', p: [50.1, 0, 50] })
  pending.merge({ id: 'a', a: [0, 0, 1] })
  assert.deepEqual(pending.takeAll(), [{ id: 'a', p: [50.1, 0, 50], q: [0, 0, 0, 1], t: true, a: [0, 0, 1] }])
  // and a tick without one has none
  pending.merge({ id: 'a', p: [51, 0, 50] })
  assert.deepEqual(pending.takeAll(), [{ id: 'a', p: [51, 0, 50] }])
})

test('each player has its own entry; they are taken in the order the players first changed, and nothing is left', () => {
  const pending = createPendingChanges()
  pending.merge({ id: 'b', p: [1, 1, 1] })
  pending.merge({ id: 'a', p: [2, 2, 2] })
  pending.merge({ id: 'c', m: 3 })
  pending.merge({ id: 'b', m: 2 })
  pending.merge({ id: 'a', p: [4, 4, 4] })
  assert.equal(pending.size, 3)
  assert.deepEqual(pending.takeAll(), [
    { id: 'b', p: [1, 1, 1], m: 2 },
    { id: 'a', p: [4, 4, 4] },
    { id: 'c', m: 3 },
  ])
  assert.equal(pending.size, 0)
  assert.deepEqual(pending.takeAll(), [])
  // a change after that starts again
  pending.merge({ id: 'b', g: [0, 0, 1] })
  assert.deepEqual(pending.takeAll(), [{ id: 'b', g: [0, 0, 1] }])
})

test('what the server told everyone is taken out of what is pending for that player, and of nobody else', () => {
  const pending = createPendingChanges()
  pending.merge({ id: 'a', p: [1, 0, 0], ef: { freeze: true }, sessionAvatar: 'asset://mine.vrm' })
  pending.merge({ id: 'b', ef: { freeze: true } })
  pending.supersede('a', { id: 'a', ef: { snare: 0.5 } })
  assert.deepEqual(pending.takeAll(), [
    { id: 'a', p: [1, 0, 0], sessionAvatar: 'asset://mine.vrm' },
    { id: 'b', ef: { freeze: true } },
  ])
  // fields that are not pending, and a player with nothing pending
  pending.merge({ id: 'a', p: [1, 0, 0] })
  pending.supersede('a', { id: 'a', rank: 1, health: 50 })
  pending.supersede('nobody', { id: 'nobody', ef: null })
  pending.supersede(undefined, undefined)
  assert.deepEqual(pending.takeAll(), [{ id: 'a', p: [1, 0, 0] }])
  // a change made after the server's is the later one
  pending.merge({ id: 'a', ef: { freeze: true } })
  pending.supersede('a', { id: 'a', ef: null })
  pending.merge({ id: 'a', ef: { turn: true } })
  assert.deepEqual(pending.takeAll(), [{ id: 'a', ef: { turn: true } }])
})

test('an entry with nothing left to say goes: its id alone, or with the teleport mark of a position that is not there', () => {
  const pending = createPendingChanges()
  pending.merge({ id: 'a', ef: { freeze: true } })
  pending.supersede('a', { id: 'a', ef: null })
  assert.equal(pending.size, 0)
  pending.merge({ id: 'a', t: true, sessionAvatar: 'asset://mine.vrm', name: 'A' })
  pending.supersede('a', { id: 'a', sessionAvatar: null })
  assert.equal(pending.size, 1, 'the name is still to be told')
  pending.supersede('a', { id: 'a', name: 'B' })
  assert.equal(pending.size, 0)
  assert.deepEqual(pending.takeAll(), [])
  // a teleport keeps its mark whatever else is taken out
  pending.merge({ id: 'a', p: [9, 9, 9], t: true, ef: { freeze: true } })
  pending.supersede('a', { id: 'a', ef: null })
  assert.deepEqual(pending.takeAll(), [{ id: 'a', p: [9, 9, 9], t: true }])
})

test('a player that is gone has nothing pending; the others keep theirs', () => {
  const pending = createPendingChanges()
  pending.merge({ id: 'a', p: [1, 0, 0] })
  pending.merge({ id: 'b', p: [2, 0, 0] })
  pending.drop('a')
  pending.drop('never-there')
  assert.equal(pending.size, 1)
  assert.deepEqual(pending.takeAll(), [{ id: 'b', p: [2, 0, 0] }])
})
