import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MOUTH, mouthTarget, nextMouth, quantizeMouth } from '../src/core/extras/voiceLevel.js'
import { createVoiceTap } from '../src/core/extras/voiceTap.js'

test('voice level: target from RMS uses the floor and gain, clamped', () => {
  assert.deepEqual(MOUTH, { floor: 0.01, gain: 6, attack: 0.06, release: 0.12, epsilon: 0.005 })
  assert.equal(mouthTarget(0), 0)
  assert.equal(mouthTarget(0.01), 0)
  assert.ok(Math.abs(mouthTarget(0.06) - 0.3) < 1e-12)
  assert.equal(mouthTarget(0.5), 1)
  for (const bad of [NaN, Infinity, -Infinity, undefined, '0.1']) assert.equal(mouthTarget(bad), 0)
  assert.ok(Math.abs(mouthTarget(0.03, { floor: 0.02, gain: 10 }) - 0.1) < 1e-12)
})

test('voice level: opening follows the attack, closing the release, and settles at exactly 0', () => {
  // half way in tau * ln 2
  const half = nextMouth(0, 1, MOUTH.attack * Math.LN2)
  assert.ok(Math.abs(half - 0.5) < 1e-9, half)
  const closing = nextMouth(1, 0, MOUTH.release * Math.LN2)
  assert.ok(Math.abs(closing - 0.5) < 1e-9, closing)
  // opening is faster than closing for the same step
  assert.ok(nextMouth(0, 1, 0.016) > 1 - nextMouth(1, 0, 0.016))
  let mouth = 1
  let frames = 0
  while (mouth > 0 && frames < 1000) {
    mouth = nextMouth(mouth, 0, 1 / 60)
    frames++
  }
  assert.equal(mouth, 0)
  assert.ok(frames < 60, `closed within a second (${frames} frames)`)
  // a small open target is not snapped away
  assert.ok(nextMouth(0, 0.004, 1) > 0)
})

test('voice level: zero, negative and non-finite deltas and inputs are safe', () => {
  assert.equal(nextMouth(0.4, 1, 0), 0.4)
  assert.equal(nextMouth(0.4, 1, -1), 0.4)
  assert.equal(nextMouth(0.4, 1, NaN), 0.4)
  // non-finite deltas count as no time; non-finite levels as closed
  assert.equal(nextMouth(0.4, 1, Infinity), 0.4)
  assert.equal(nextMouth(NaN, 1, 10), 1)
  assert.equal(nextMouth(0.5, NaN, 10), 0)
  assert.equal(nextMouth(5, 2, 0), 1)
  assert.equal(quantizeMouth(0.123), 0.12)
  assert.equal(quantizeMouth(0.126), 0.13)
  assert.equal(quantizeMouth(0), 0)
})

function fakeContext() {
  const log = []
  const node = name => ({
    name,
    connect: target => log.push(['connect', name, target.name]),
    disconnect: () => log.push(['disconnect', name]),
  })
  let samples = new Float32Array(0)
  const ctx = {
    destination: { name: 'destination' },
    createMediaStreamSource: stream => ({ ...node('source'), stream }),
    createAnalyser: () => ({
      ...node('analyser'),
      fftSize: 2048,
      getFloatTimeDomainData: buffer => buffer.set(samples.subarray(0, buffer.length)),
    }),
    createGain: () => ({ ...node('sink'), gain: { value: 1 } }),
  }
  return { ctx, log, setSamples: s => (samples = s) }
}

test('voice tap: a silent listen-only branch, RMS of the window, idempotent teardown', () => {
  const { ctx, log, setSamples } = fakeContext()
  const sinks = []
  const createGain = ctx.createGain
  ctx.createGain = () => {
    const gain = createGain()
    sinks.push(gain)
    return gain
  }
  const tap = createVoiceTap(ctx, { id: 'stream' })
  assert.deepEqual(log, [
    ['connect', 'source', 'analyser'],
    ['connect', 'analyser', 'sink'],
    ['connect', 'sink', 'destination'],
  ])
  assert.equal(sinks[0].gain.value, 0)
  // a sine of amplitude a has RMS a / sqrt(2)
  const a = 0.2
  setSamples(Float32Array.from({ length: 2048 }, (_, i) => a * Math.sin((2 * Math.PI * i) / 64)))
  assert.ok(Math.abs(tap.rms() - a / Math.SQRT2) < 1e-6)
  setSamples(new Float32Array(2048))
  assert.equal(tap.rms(), 0)
  setSamples(Float32Array.from({ length: 2048 }, () => NaN))
  assert.equal(tap.rms(), 0)
  log.length = 0
  tap.destroy()
  tap.destroy()
  assert.deepEqual(log, [
    ['disconnect', 'source'],
    ['disconnect', 'analyser'],
    ['disconnect', 'sink'],
  ])
  assert.equal(tap.rms(), 0)
})
