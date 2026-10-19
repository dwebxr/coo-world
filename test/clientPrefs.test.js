import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { isBoolean, isNumber } from 'lodash-es'
import { loadClient } from './lib/clientHarness.mjs'

function load({ isTouch, saved = {} }) {
  const writes = []
  const storage = { get: () => structuredClone(saved), set: (key, value) => writes.push([key, value]) }
  const ClientPrefs = loadClient('core/systems/ClientPrefs.js', 'ClientPrefs', {
    isBoolean,
    isNumber,
    System: class extends EventEmitter {
      constructor(world) {
        super()
        this.world = world
      }
    },
    storage,
    isTouch,
    navigator: { userAgent: 'test' },
  })
  return { prefs: new ClientPrefs({}), writes }
}

test('prefs: lip sync defaults on for desktop and off for touch devices', () => {
  assert.equal(load({ isTouch: false }).prefs.lipsync, true)
  assert.equal(load({ isTouch: true }).prefs.lipsync, false)
})

test('prefs: a stored lip sync choice wins over the device default', () => {
  assert.equal(load({ isTouch: true, saved: { v: 4, lipsync: true } }).prefs.lipsync, true)
  assert.equal(load({ isTouch: false, saved: { v: 4, lipsync: false } }).prefs.lipsync, false)
  assert.equal(load({ isTouch: false, saved: { v: 4, lipsync: 'yes' } }).prefs.lipsync, true)
})

test('prefs: setLipsync emits a change and persists the value', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { prefs, writes } = load({ isTouch: false })
  const changes = []
  prefs.on('change', c => changes.push(c))
  prefs.setLipsync(false)
  prefs.preFixedUpdate()
  assert.deepEqual(changes, [{ lipsync: { prev: true, value: false } }])
  t.mock.timers.tick(2000)
  await Promise.resolve()
  assert.equal(writes.at(-1)?.[1].lipsync, false)
})
