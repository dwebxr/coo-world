import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeOverridable, ownedPrototypes } from '../src/core/extras/scriptClassPrep.js'

// a class shaped like the math classes: a method an instance replaces (`_onChange`), a flag the constructor
// writes to the prototype on every construction, accessors, a symbol-keyed method
function makeClass() {
  class Vec {
    constructor(x = 0) {
      Vec.prototype.isVec = true
      this._x = x
    }
    get x() {
      return this._x
    }
    set x(value) {
      this._x = value
      this._onChangeCallback()
    }
    add(v) {
      this._x += v._x
      return this
    }
    _onChange(callback) {
      this._onChangeCallback = callback
      return this
    }
    _onChangeCallback() {}
    *[Symbol.iterator]() {
      yield this._x
    }
  }
  return Vec
}

function strict(fn) {
  'use strict'
  return fn()
}

test('a plain freeze breaks the class: the constructor flag and _onChange both throw', () => {
  const Vec = makeClass()
  new Vec()
  Object.freeze(Vec.prototype)
  assert.throws(() => new Vec(), TypeError)
  const v = Object.create(Vec.prototype)
  assert.throws(() => v._onChange(() => {}), TypeError)
})

test('makeOverridable + freeze: construction, _onChange and instance overrides keep working', () => {
  const Vec = makeClass()
  new Vec() // the flag exists before the prototype is prepared
  makeOverridable(Vec.prototype)
  Object.freeze(Vec.prototype)
  const v = new Vec(1)
  assert.equal(v.isVec, true)
  let changes = 0
  v._onChange(() => changes++)
  v.x = 5
  assert.equal(changes, 1)
  assert.equal(Object.hasOwn(v, '_onChangeCallback'), true)
  // an instance may replace any method; other instances are not affected
  v.add = () => 'mine'
  assert.equal(v.add(new Vec()), 'mine')
  assert.equal(new Vec(1).add(new Vec(2)).x, 3)
  // the own property is an ordinary one: writable, enumerable, configurable, and assignable again
  assert.deepEqual(Object.getOwnPropertyDescriptor(v, 'add'), {
    value: v.add,
    writable: true,
    enumerable: true,
    configurable: true,
  })
  v.add = () => 'again'
  assert.equal(v.add(), 'again')
  assert.deepEqual([...new Vec(7)], [7])
})

test('makeOverridable + freeze: the prototype itself cannot be changed by any route', () => {
  const Vec = makeClass()
  new Vec()
  makeOverridable(Vec.prototype)
  Object.freeze(Vec.prototype)
  const add = Vec.prototype.add
  const attempts = {
    assign: () => (Vec.prototype.add = () => 42),
    assignNew: () => (Vec.prototype.extra = 1),
    assignSymbol: () => (Vec.prototype[Symbol.iterator] = function* () {}),
    define: () => Object.defineProperty(Vec.prototype, 'add', { value: () => 42 }),
    defineAccessor: () => Object.defineProperty(Vec.prototype, 'x', { get: () => 1 }),
    remove: () => delete Vec.prototype.add,
    reflectSet: () =>
      assert.equal(
        Reflect.set(Vec.prototype, 'add', () => 42),
        true
      ),
    reflectSetReceiver: () =>
      assert.equal(
        Reflect.set(Vec.prototype, 'add', () => 42, Vec.prototype),
        true
      ),
    setProto: () => Object.setPrototypeOf(Vec.prototype, {}),
    differentFlag: () => (Vec.prototype.isVec = false),
  }
  for (const [name, attempt] of Object.entries(attempts)) {
    assert.throws(() => strict(attempt), TypeError, name)
  }
  assert.equal(Vec.prototype.add, add)
  assert.equal(new Vec(1).add(new Vec(1)).x, 2)
  assert.equal(Vec.prototype.isVec, true)
  assert.equal('extra' in Vec.prototype, false)
  // the one tolerated write: the identical value (what THREE's constructors do on every construction)
  assert.doesNotThrow(() => strict(() => (Vec.prototype.isVec = true)))
})

test('makeOverridable: the setter cannot be used to write onto a frozen or primitive receiver', () => {
  const Vec = makeClass()
  new Vec()
  makeOverridable(Vec.prototype)
  Object.freeze(Vec.prototype)
  const setter = Object.getOwnPropertyDescriptor(Vec.prototype, 'add').set
  const frozen = Object.freeze(new Vec())
  assert.throws(() => setter.call(frozen, () => 1), TypeError)
  assert.throws(() => setter.call(5, () => 1), TypeError)
  assert.throws(() => setter.call(undefined, () => 1), TypeError)
  // another class's prototype is an ordinary receiver; ours still serves the original
  const other = {}
  setter.call(other, 'x')
  assert.equal(other.add, 'x')
  assert.equal(typeof Vec.prototype.add, 'function')
})

test('makeOverridable keeps enumerability and leaves accessors and fixed properties alone', () => {
  const proto = { visible: 1 }
  Object.defineProperty(proto, 'hidden', { value: 2, writable: true, enumerable: false, configurable: true })
  Object.defineProperty(proto, 'fixed', { value: 3, writable: true, enumerable: true, configurable: false })
  const getter = () => 4
  Object.defineProperty(proto, 'computed', { get: getter, enumerable: true, configurable: true })
  // the converted properties' original values are handed back, for the caller to freeze
  assert.deepEqual(makeOverridable(proto), [1, 2])
  assert.deepEqual(Object.keys(proto), ['visible', 'fixed', 'computed'])
  assert.equal(proto.hidden, 2)
  assert.equal(Object.getOwnPropertyDescriptor(proto, 'fixed').value, 3)
  assert.equal(Object.getOwnPropertyDescriptor(proto, 'computed').get, getter)
  const keys = []
  for (const key in Object.create(proto)) keys.push(key)
  assert.deepEqual(keys, ['visible', 'fixed', 'computed'])
})

test('ownedPrototypes walks a subclass chain and stops at frozen prototypes', () => {
  class Base {}
  class Mid extends Base {}
  class Leaf extends Mid {}
  // Object.prototype is never included, frozen (after lockdown) or not
  assert.deepEqual(ownedPrototypes(Leaf), [Leaf.prototype, Mid.prototype, Base.prototype])
  Object.freeze(Base.prototype)
  assert.deepEqual(ownedPrototypes(Leaf), [Leaf.prototype, Mid.prototype])
})
