import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLogOnce } from '../src/core/extras/logOnce.js'

test('createLogOnce: logs once per subject and key, and says whether it did', () => {
  const lines = []
  const logOnce = createLogOnce(m => lines.push(m))
  const a = { id: 'a' }
  const b = { id: 'b' }
  assert.equal(logOnce(a, 'size', 'a too big'), true)
  assert.equal(logOnce(a, 'size', 'a too big again'), false)
  assert.equal(logOnce(a, 'rate', 'a too fast'), true)
  assert.equal(logOnce(b, 'size', 'b too big'), true)
  assert.equal(logOnce(b, 'size', 'b too big again'), false)
  assert.deepEqual(lines, ['a too big', 'a too fast', 'b too big'])
})

test('createLogOnce: defaults to console.warn', () => {
  const warn = console.warn
  const lines = []
  console.warn = m => lines.push(m)
  try {
    const logOnce = createLogOnce()
    logOnce({}, 'k', 'hello')
    assert.deepEqual(lines, ['hello'])
  } finally {
    console.warn = warn
  }
})
