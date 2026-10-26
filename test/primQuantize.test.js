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
  for (const value of [NaN, Infinity, -Infinity, 5e-324, 1e-310])
    assert.equal(quantizeTubeRatio(value), null, String(value))
  // every midpoint at several octaves: one ulp below rounds down, the midpoint itself rounds up
  const steps = [
    1, 1.0905077326652577, 1.189207115002721, 1.2968395546510096, 1.4142135623730951, 1.5422108254079407,
    1.681792830507429, 1.8340080864093424, 2,
  ]
  const mids = [
    1.0442737824274138, 1.1387886347566916, 1.241857812073484, 1.3542555469368927, 1.4768261459394993,
    1.6104903319492543, 1.7562521603732995, 1.9152065613971474,
  ]
  const below = x => x - Number.EPSILON * 2 ** Math.floor(Math.log2(x))
  for (const e of [-9, -3, 0, 4, 9]) {
    for (let k = 0; k < 8; k++) {
      const mid = mids[k] * 2 ** e
      assert.equal(quantizeTubeRatio(below(mid)), steps[k] * 2 ** e, `2^${e} mid ${k} - ulp`)
      assert.equal(quantizeTubeRatio(mid), steps[k + 1] * 2 ** e, `2^${e} mid ${k}`)
    }
  }
  // the literals are 2^(k/8) and 2^((k+0.5)/8): their 8th / 16th powers come back to powers of two
  for (let k = 0; k < 8; k++) {
    assert.ok(Math.abs(steps[k] ** 8 / 2 ** k - 1) < 1e-14, `step ${k}`)
    assert.ok(Math.abs(mids[k] ** 16 / 2 ** (2 * k + 1) - 1) < 1e-14, `mid ${k}`)
  }
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
