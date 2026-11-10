import { test } from 'node:test'
import assert from 'node:assert/strict'

// imported without lockdown: there is no harden() here, as in the viewer and standalone client bundles
import { canHarden, hardenForScripts, hardenScriptClasses } from '../src/core/extras/scriptHardening.js'

const deepFreeze = value => {
  if (value && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key])
  }
  return value
}

test('scriptHardening: without harden() everything is a no-op that returns its input', () => {
  assert.equal(typeof globalThis.harden, 'undefined')
  assert.equal(canHarden(), false)
  const value = { fn: () => {} }
  assert.equal(hardenForScripts(value), value)
  assert.equal(Object.isFrozen(value), false)
  assert.doesNotThrow(() => hardenScriptClasses())
  assert.doesNotThrow(() => hardenScriptClasses())
})

test('scriptHardening: the fake hardener of __hardenTaming__ unsafe is treated as absent', () => {
  const fake = Object.assign(x => x, { isFake: true })
  globalThis.harden = fake
  try {
    assert.equal(canHarden(), false)
    const value = { n: 1 }
    assert.equal(hardenForScripts(value), value)
    assert.equal(Object.isFrozen(value), false)
  } finally {
    delete globalThis.harden
  }
})

test('scriptHardening: with a real hardener values are frozen, and classes are prepared, frozen and hooked once', () => {
  let calls = 0
  globalThis.harden = value => {
    calls++
    return deepFreeze(value)
  }
  // shaped like the math classes: the constructor writes a flag to the prototype, an instance replaces a method
  class Vec {
    constructor() {
      Vec.prototype.isVec = true
    }
    _onChange(callback) {
      this._onChangeCallback = callback
      return this
    }
    _onChangeCallback() {}
  }
  new Vec()
  const hooked = []
  globalThis.__scriptClassTestHook = classes => hooked.push(Object.isFrozen(classes[0][1].prototype))
  try {
    assert.equal(canHarden(), true)
    const helpers = { num: () => 1, nested: { deep: () => 2 } }
    assert.equal(hardenForScripts(helpers), helpers)
    assert.equal(Object.isFrozen(helpers), true)
    assert.equal(Object.isFrozen(helpers.num), true)
    assert.equal(Object.isFrozen(helpers.nested.deep), true)
    assert.equal(calls, 1)

    assert.equal(hardenScriptClasses([['Vec', Vec]]), true)
    assert.deepEqual(hooked, [false]) // the test hook saw the class before it was frozen
    assert.equal(Object.isFrozen(Vec), true)
    assert.equal(Object.isFrozen(Vec.prototype), true)
    assert.equal(Object.isFrozen(Vec.prototype._onChange), true) // the methods themselves, not only the slots
    assert.throws(() => {
      'use strict'
      Vec.prototype._onChange = () => {}
    }, TypeError)
    // what a plain freeze would have broken still works
    let changed = 0
    const v = new Vec()._onChange(() => changed++)
    v._onChangeCallback()
    assert.equal(changed, 1)

    // once per realm: a second list is ignored
    class Late {}
    const afterFirst = calls
    assert.equal(hardenScriptClasses([['Late', Late]]), false)
    assert.equal(calls, afterFirst)
    assert.equal(Object.isFrozen(Late.prototype), false)
    assert.deepEqual(hooked, [false])
  } finally {
    delete globalThis.harden
    delete globalThis.__scriptClassTestHook
  }
})
