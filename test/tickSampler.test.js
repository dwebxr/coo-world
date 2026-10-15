import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTickSampler } from '../src/core/extras/tickSampler.js'

function makeClock() {
  let t = 0
  return { now: () => t, advance: ms => (t += ms) }
}

test('tickSampler: nothing is reported before a window completes or when a window has no samples', () => {
  const clock = makeClock()
  const lines = []
  const sampler = createTickSampler({ windowMs: 1000, now: clock.now, log: line => lines.push(line) })
  sampler.sample(1)
  clock.advance(999)
  sampler.sample(2)
  assert.equal(sampler.last, null)
  assert.deepEqual(lines, [])
  sampler.flush()
  assert.equal(sampler.last.count, 2)
  sampler.flush() // empty window: no new line, last window kept
  assert.equal(lines.length, 1)
  assert.equal(sampler.last.count, 2)
})

test('tickSampler: a completed window reports count, mean, median, p90 and max in ms', () => {
  const clock = makeClock()
  const lines = []
  const sampler = createTickSampler({ windowMs: 1000, now: clock.now, log: line => lines.push(line) })
  for (let i = 1; i <= 10; i++) {
    clock.advance(100)
    sampler.sample(i)
  }
  assert.equal(sampler.last.count, 10)
  assert.equal(sampler.last.seconds, 1)
  assert.equal(sampler.last.mean, 5.5)
  assert.equal(sampler.last.median, 6)
  assert.equal(sampler.last.p90, 10)
  assert.equal(sampler.last.max, 10)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[monitor\] tick ms over 1s: n=10 mean=5\.5 median=6 p90=10 max=10$/)
  // the next window starts empty
  clock.advance(1000)
  sampler.sample(0.1234)
  assert.equal(sampler.last.count, 1)
  assert.equal(sampler.last.max, 0.123)
})

test('tickSampler: works without a log function', () => {
  const clock = makeClock()
  const sampler = createTickSampler({ windowMs: 10, now: clock.now })
  clock.advance(10)
  assert.doesNotThrow(() => sampler.sample(3))
  assert.equal(sampler.last.median, 3)
})
