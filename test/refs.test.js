import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  getNodeRef,
  getRef,
  isRefAllowed,
  registerAppProxy,
  registerNodeRefGetter,
  resolveValueRef,
  secureRef,
} from '../src/core/nodes/refs.js'

// mimics Node.getProxy() plus a subclass proxy copying the base descriptors
function makeNodeProxy() {
  const node = {}
  const base = {
    get _ref() {
      return isRefAllowed() ? node : null
    },
  }
  registerNodeRefGetter(base)
  const sub = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base))
  node.getProxy = () => sub
  return { node, base, sub }
}

test('getNodeRef: a subclass proxy with the copied descriptor resolves to its node', () => {
  const { node, sub } = makeNodeProxy()
  assert.equal(getNodeRef(sub), node)
  assert.equal(getRef(sub), node)
  assert.equal(sub._ref, null) // closed outside the resolver
})

test('getNodeRef: a registered getter on an object that is not the node proxy resolves to null', () => {
  const { base } = makeNodeProxy()
  assert.equal(getNodeRef(base), null)
})

test('getNodeRef: plain objects and primitives resolve to null', () => {
  const { node } = makeNodeProxy()
  assert.equal(getNodeRef({ _ref: node }), null)
  assert.equal(getNodeRef({}), null)
  assert.equal(getNodeRef(null), null)
  assert.equal(getNodeRef(undefined), null)
  assert.equal(getNodeRef('node'), null)
  assert.equal(getNodeRef(1), null)
})

test('getNodeRef: a script-defined _ref accessor is never invoked', () => {
  const { node } = makeNodeProxy()
  let called = false
  const fake = {
    get _ref() {
      called = true
      return node
    },
  }
  assert.equal(getNodeRef(fake), null)
  assert.equal(getRef(fake), fake)
  assert.equal(called, false)
})

test('getNodeRef: the gate closes again when a registered getter throws', () => {
  const base = {
    get _ref() {
      throw new Error('boom')
    },
  }
  registerNodeRefGetter(base)
  assert.throws(() => getNodeRef(base), /boom/)
  assert.equal(isRefAllowed(), false)
})

test('secureRef: unwraps only through getRef / resolveValueRef and reads null outside them', () => {
  const geom = { isBufferGeometry: true }
  const ref = secureRef({}, () => geom)
  assert.equal(ref._ref, null)
  assert.equal(ref._isRef, true)
  assert.deepEqual(resolveValueRef(ref), { value: geom })
  assert.equal(getRef(ref), geom)
  assert.equal(getNodeRef(ref), null)
  assert.equal(isRefAllowed(), false)
})

test('resolveValueRef: anything that is not a host value ref resolves to null without running accessors', () => {
  const raw = { isBufferGeometry: true }
  let called = false
  const fake = {
    get _ref() {
      called = true
      return raw
    },
  }
  assert.equal(resolveValueRef(raw), null)
  assert.equal(resolveValueRef({ _ref: raw }), null)
  assert.equal(resolveValueRef(fake), null)
  assert.equal(called, false)
  assert.equal(resolveValueRef(null), null)
  assert.equal(resolveValueRef('x'), null)
  // a node proxy is not a value ref
  const { sub } = makeNodeProxy()
  assert.equal(resolveValueRef(sub), null)
})

test('resolveValueRef: the descriptor is read once, so a proxy that changes its answer cannot pass and then slip through', () => {
  const geom = { isBufferGeometry: true }
  const real = secureRef({}, () => geom)
  const realDesc = Object.getOwnPropertyDescriptor(real, '_ref')
  let reads = 0
  const flipping = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(target, key) {
        if (key !== '_ref') return undefined
        reads++
        return reads === 1 ? realDesc : undefined
      },
    }
  )
  // first (and only) read sees the registered getter: the result is the resolved target, never the proxy
  assert.deepEqual(resolveValueRef(flipping), { value: geom })
  assert.equal(reads, 1)
  // a later read sees no descriptor and is rejected outright
  assert.equal(resolveValueRef(flipping), null)
  assert.equal(reads, 2)
  assert.equal(isRefAllowed(), false)
})

test('getRef: a non-ref value passes through unchanged', () => {
  const raw = { isBufferGeometry: true }
  assert.equal(getRef(raw), raw)
  assert.equal(getRef(null), null)
  assert.equal(getRef(undefined), undefined)
})

test('registerAppProxy: a host-registered app proxy resolves to its root node, a lookalike does not', () => {
  const { node, sub } = makeNodeProxy()
  const appProxy = registerAppProxy(new Proxy({}, {}), () => sub)
  assert.equal(getNodeRef(appProxy), node)
  assert.equal(getNodeRef(new Proxy({}, {})), null)
})
