import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clamp, createDispatchQueue, num } from '../src/core/utils.js'

test('clamp: returns the value when within range', () => {
  assert.equal(clamp(5, 0, 10), 5)
})

test('clamp: clamps to the low bound', () => {
  assert.equal(clamp(-5, 0, 10), 0)
})

test('clamp: clamps to the high bound', () => {
  assert.equal(clamp(15, 0, 10), 10)
})

test('clamp: is inclusive of both bounds', () => {
  assert.equal(clamp(0, 0, 10), 0)
  assert.equal(clamp(10, 0, 10), 10)
})

test('num: stays within [min, max]', () => {
  for (let i = 0; i < 1000; i++) {
    const value = num(1, 2)
    assert.ok(value >= 1 && value <= 2)
  }
})

test('num: rounds to the requested decimal places', () => {
  const value = num(1, 2, 2)
  const decimals = (value.toString().split('.')[1] || '').length
  assert.ok(decimals <= 2)
})

test('num: defaults to 0 decimal places (integers)', () => {
  const value = num(0, 100)
  assert.equal(value, Math.round(value))
})

function captureErrors() {
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args)
  return {
    errors,
    restore() {
      console.error = original
    },
  }
}

test('createDispatchQueue: a throwing item is logged and the rest still dispatch in order', () => {
  const queue = createDispatchQueue()
  const seen = []
  queue.enqueue('a')
  queue.enqueue('b')
  queue.enqueue('c')
  const capture = captureErrors()
  try {
    queue.flush(item => {
      seen.push(item)
      if (item === 'b') throw new Error('sync failure')
    })
  } finally {
    capture.restore()
  }
  assert.deepEqual(seen, ['a', 'b', 'c'])
  assert.equal(capture.errors.length, 1)
  assert.match(String(capture.errors[0][0]), /sync failure/)
})

test('createDispatchQueue: a rejected async handler is logged and never escapes as unhandled', async () => {
  const queue = createDispatchQueue()
  const seen = []
  let unhandled = 0
  const onUnhandled = () => unhandled++
  process.on('unhandledRejection', onUnhandled)
  queue.enqueue('a')
  queue.enqueue('b')
  queue.enqueue('c')
  const capture = captureErrors()
  try {
    queue.flush(async item => {
      seen.push(item)
      if (item === 'b') throw new Error('async failure')
    })
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    capture.restore()
    process.off('unhandledRejection', onUnhandled)
  }
  assert.deepEqual(seen, ['a', 'b', 'c'])
  assert.equal(unhandled, 0)
  assert.equal(capture.errors.length, 1)
  assert.match(String(capture.errors[0][0]), /async failure/)
})
