// src/core/extras/boundedValue.js: what a node keeps of a number or a text that becomes a size.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { boundedNumber, boundedInteger, boundedText } from '../src/core/extras/boundedValue.js'

test('a number in range is kept as it is; NaN is the fallback; outside the range is the nearest bound', () => {
  assert.equal(boundedNumber(5, 1, 0, 10), 5)
  assert.equal(boundedNumber(0, 1, 0, 10), 0)
  assert.equal(boundedNumber(10, 1, 0, 10), 10)
  assert.equal(boundedNumber(0.25, 1, 0, 10), 0.25)
  assert.equal(boundedNumber(NaN, 1, 0, 10), 1)
  assert.equal(boundedNumber(-1, 1, 0, 10), 0)
  assert.equal(boundedNumber(-Infinity, 1, 0, 10), 0)
  assert.equal(boundedNumber(1e9, 1, 0, 10), 10)
  assert.equal(boundedNumber(Infinity, 1, 0, 10), 10)
  assert.ok(Object.is(boundedNumber(-0, 1, 0, 10), -0), 'a value in range is not rewritten')
})

test('a whole number is rounded down, after the bounds', () => {
  assert.equal(boundedInteger(5.9, 1, 0, 10), 5)
  assert.equal(boundedInteger(10.5, 1, 0, 10), 10)
  assert.equal(boundedInteger(NaN, 3, 0, 10), 3)
  assert.equal(boundedInteger(Infinity, 3, 0, 10), 10)
  assert.equal(boundedInteger(-0.5, 3, 0, 10), 0)
})

test('a text is cut to its limit, and never inside a surrogate pair', () => {
  assert.equal(boundedText('abc', 3), 'abc')
  assert.equal(boundedText('abcd', 3), 'abc')
  assert.equal(boundedText('', 3), '')
  const pair = 'ab\u{1f600}cd'
  assert.equal(boundedText(pair, 3), 'ab', 'the half pair is dropped')
  assert.equal(boundedText(pair, 4), 'ab\u{1f600}')
  assert.equal(boundedText('x'.repeat(100000), 10000).length, 10000)
})
