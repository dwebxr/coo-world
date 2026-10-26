import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quantizeRadiusRatio, quantizeTubeRatio } from '../src/core/extras/primQuantize.js'

test('quantizeRadiusRatio: a 1/64 grid that keeps the sign and the ends', () => {
  assert.equal(quantizeRadiusRatio(1), 1)
  assert.equal(quantizeRadiusRatio(0), 0)
  assert.equal(quantizeRadiusRatio(-1), -1)
  assert.equal(quantizeRadiusRatio(0.5), 0.5)
  assert.equal(quantizeRadiusRatio(0.501), 0.5)
  assert.equal(quantizeRadiusRatio(0.51), 33 / 64)
  // 1000 distinct ratios land on at most 129 values
  const seen = new Set()
  for (let i = 0; i <= 1000; i++) seen.add(quantizeRadiusRatio(-1 + (2 * i) / 1000))
  assert.ok(seen.size <= 129, `${seen.size} values`)
})

test('quantizeTubeRatio: a log2 grid of 1/8 octave inside 2^-10..2^10, exact powers of two and 0 kept', () => {
  assert.equal(quantizeTubeRatio(0), 0)
  for (let e = -10; e <= 10; e++) assert.equal(quantizeTubeRatio(2 ** e), 2 ** e, `2^${e}`)
  assert.equal(quantizeTubeRatio(-0.25), -0.25)
  // the inclusive ends, and just outside them
  assert.equal(quantizeTubeRatio(2 ** 10), 1024)
  assert.equal(quantizeTubeRatio(2 ** 10 * 1.05), null)
  assert.equal(quantizeTubeRatio(2 ** -10 * 0.98), 2 ** -10, 'rounds up onto the lower end')
  assert.equal(quantizeTubeRatio(2 ** -10 * 0.9), null)
  // not finite, denormal
  for (const value of [NaN, Infinity, -Infinity, 5e-324, 1e-310]) assert.equal(quantizeTubeRatio(value), null, String(value))
  // a midpoint and its neighbours: just below rounds down, at or above rounds up
  const mid = 1.0442737824274138
  const below = mid - Number.EPSILON
  assert.equal(quantizeTubeRatio(below), 1)
  assert.equal(quantizeTubeRatio(mid), 1.0905077326652577)
  // relative error within half a step (2^(1/16) - 1 ≈ 4.4%)
  for (let i = 1; i < 2000; i++) {
    const x = 2 ** (-10 + (20 * i) / 2000)
    const q = quantizeTubeRatio(x)
    assert.ok(Math.abs(q / x - 1) <= 0.0444, `${x} -> ${q}`)
  }
  // 1000 distinct ratios land on at most 161 values
  const seen = new Set()
  for (let i = 0; i < 1000; i++) seen.add(quantizeTubeRatio(0.001 + i * 0.73))
  assert.ok(seen.size <= 161, `${seen.size} values`)
})
