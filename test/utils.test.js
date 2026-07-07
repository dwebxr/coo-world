import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clamp, num } from '../src/core/utils.js'

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
