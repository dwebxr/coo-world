import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createScriptTimers } from '../src/core/extras/scriptTimers.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('createScriptTimers: handles are opaque increasing numbers and callbacks fire without a receiver', async () => {
  const timers = createScriptTimers()
  let seenThis = 'unset'
  let seenArgs
  const a = timers.set(function (...args) {
    seenThis = this
    seenArgs = args
  }, 1)
  const b = timers.set(() => {}, 1)
  assert.equal(typeof a, 'number')
  assert.equal(b, a + 1)
  assert.equal(timers.size, 2)
  await sleep(20)
  assert.equal(seenThis, undefined)
  assert.deepEqual(seenArgs, [])
  assert.equal(timers.size, 0)
})

test('createScriptTimers: clear() cancels every pending timer', async () => {
  const timers = createScriptTimers()
  let fired = 0
  timers.set(() => fired++, 1)
  timers.set(() => fired++, 1)
  timers.clear()
  assert.equal(timers.size, 0)
  await sleep(20)
  assert.equal(fired, 0)
})

test('createScriptTimers: a throwing callback is logged and does not affect the others', async () => {
  const timers = createScriptTimers()
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args)
  let fired = 0
  try {
    timers.set(() => {
      throw new Error('timer boom')
    }, 1)
    timers.set(() => fired++, 2)
    await sleep(30)
  } finally {
    console.error = original
  }
  assert.equal(fired, 1)
  assert.equal(errors.length, 1)
  assert.match(String(errors[0][0]), /timer boom/)
  assert.equal(timers.size, 0)
})

test('createScriptTimers: the delay is never coerced through script code, so the cap cannot be overrun', () => {
  const timers = createScriptTimers()
  let calls = 0
  try {
    const reentrant = {
      valueOf() {
        calls++
        for (let i = 0; i < 1024; i++) timers.set(() => {}, 60000)
        return 60000
      },
    }
    timers.set(() => {}, reentrant)
    assert.equal(calls, 0, 'valueOf is not called')
    assert.equal(timers.size, 1)
    for (let i = 1; i < 1024; i++) timers.set(() => {}, 60000)
    assert.equal(timers.size, 1024)
    assert.throws(() => timers.set(() => {}, reentrant), /more than 1024 pending timers/)
    assert.equal(timers.size, 1024)
  } finally {
    timers.clear()
  }
  assert.equal(timers.size, 0)
})

test('createScriptTimers: numeric strings still work as delays', async () => {
  const timers = createScriptTimers()
  let fired = 0
  timers.set(() => fired++, '1')
  await sleep(20)
  assert.equal(fired, 1)
})
