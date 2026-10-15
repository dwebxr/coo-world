import { test } from 'node:test'
import assert from 'node:assert/strict'

import { APP_EVENT_QUEUE_MAX, createEventQueue } from '../src/core/extras/appEventQueue.js'

const event = (n, version = 0) => ({ version, name: `e${n}`, data: n, networkId: 's' })

test('push: keeps the newest 64 events and reports each drop of the oldest', () => {
  assert.equal(APP_EVENT_QUEUE_MAX, 64)
  const q = createEventQueue()
  let dropped = 0
  for (let i = 0; i < 70; i++) if (q.push(event(i))) dropped++
  assert.equal(dropped, 6)
  assert.equal(q.size, 64)
  const names = []
  q.drain(0, e => names.push(e.name))
  assert.equal(names[0], 'e6')
  assert.equal(names[63], 'e69')
  assert.equal(q.size, 0)
})

test('drain: delivers in order, counts deliveries and empties the queue', () => {
  const q = createEventQueue({ max: 3 })
  q.push(event(1))
  q.push(event(2))
  q.push(event(3))
  const seen = []
  const result = q.drain(5, e => seen.push(e.data))
  assert.deepEqual(seen, [1, 2, 3])
  assert.deepEqual(result, { delivered: 3, dropped: 0 })
  assert.equal(q.size, 0)
  assert.deepEqual(
    q.drain(5, () => assert.fail('nothing to deliver')),
    { delivered: 0, dropped: 0 }
  )
})

test('drain: a throwing listener is reported and the events behind it are still delivered', () => {
  const q = createEventQueue()
  for (let i = 0; i < 4; i++) q.push(event(i))
  const seen = []
  const errors = []
  const result = q.drain(
    0,
    e => {
      if (e.data === 1) throw new Error('boom')
      seen.push(e.data)
    },
    (err, e) => errors.push([err.message, e.data])
  )
  assert.deepEqual(seen, [0, 2, 3])
  assert.deepEqual(errors, [['boom', 1]])
  assert.deepEqual(result, { delivered: 3, dropped: 0 })
  assert.equal(q.size, 0)
  // without an error callback the drain still completes
  q.push(event(9))
  q.push(event(10))
  assert.deepEqual(
    q.drain(0, e => {
      if (e.data === 9) throw new Error('boom')
    }),
    { delivered: 1, dropped: 0 }
  )
})

test('drain: an event newer than the current version is dropped, not left at the head', () => {
  const q = createEventQueue()
  q.push(event(1, 1e12)) // a far-future version at the head
  q.push(event(2, 3))
  q.push(event(3, 4))
  q.push(event(4, 2))
  const seen = []
  const result = q.drain(3, e => seen.push(e.data))
  assert.deepEqual(seen, [2, 4])
  assert.deepEqual(result, { delivered: 2, dropped: 2 })
  assert.equal(q.size, 0)
})

test('drain: events pushed by a listener while draining are drained in the same pass', () => {
  const q = createEventQueue()
  q.push(event(1))
  const seen = []
  q.drain(0, e => {
    seen.push(e.data)
    if (e.data === 1) q.push(event(2))
  })
  assert.deepEqual(seen, [1, 2])
  assert.equal(q.size, 0)
})

test('clear: forgets everything queued', () => {
  const q = createEventQueue({ max: 2 })
  q.push(event(1))
  q.push(event(2))
  q.clear()
  assert.equal(q.size, 0)
  assert.deepEqual(
    q.drain(0, () => assert.fail('cleared')),
    { delivered: 0, dropped: 0 }
  )
})
