import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CHAT_BODY_MAX_LENGTH, sanitizeChatMessage } from '../src/core/extras/chatPolicy.js'

test('sanitizeChatMessage: a text body and a short string id pass; nothing else is copied', () => {
  assert.deepEqual(
    sanitizeChatMessage({ id: 'abc123', body: 'hello', from: 'spoof', fromId: 'spoof', createdAt: 'x', extra: 1 }),
    { id: 'abc123', body: 'hello' }
  )
  assert.equal(CHAT_BODY_MAX_LENGTH, 500)
})

test('sanitizeChatMessage: the body is trimmed and capped', () => {
  assert.deepEqual(sanitizeChatMessage({ id: 'a', body: '  hi there \n' }), { id: 'a', body: 'hi there' })
  assert.equal(sanitizeChatMessage({ id: 'a', body: 'x'.repeat(500) }).body.length, 500)
  assert.equal(sanitizeChatMessage({ id: 'a', body: 'x'.repeat(501) }).body.length, 500)
  assert.equal(sanitizeChatMessage({ id: 'a', body: ' ' + 'x'.repeat(600) }).body, 'x'.repeat(500))
  const huge = sanitizeChatMessage({ id: 'a', body: 'y'.repeat(5_000_000) })
  assert.equal(huge.body.length, 500)
})

test('sanitizeChatMessage: an empty or blank body is refused', () => {
  for (const body of ['', ' ', '\n\t ', ' ']) {
    assert.equal(sanitizeChatMessage({ id: 'a', body }), null, JSON.stringify(body))
  }
})

test('sanitizeChatMessage: a body that is not a string is refused', () => {
  for (const body of [
    undefined,
    null,
    1,
    0,
    true,
    { bad: true },
    ['x'],
    new String('boxed'),
    new Map([['body', 'x']]),
    new Uint8Array(2),
    Symbol('s'),
    () => 'x',
  ]) {
    assert.equal(sanitizeChatMessage({ id: 'a', body }), null, typeof body === 'symbol' ? 'symbol' : String(body))
  }
  assert.equal(sanitizeChatMessage({ id: 'a' }), null)
})

test('sanitizeChatMessage: the message itself must be a plain object', () => {
  for (const msg of [undefined, null, 'hello', 1, ['hello'], new Map([['body', 'hello']]), new (class M {})()]) {
    assert.equal(sanitizeChatMessage(msg), null, String(msg))
  }
  const bare = Object.create(null)
  bare.id = 'a'
  bare.body = 'hello'
  assert.deepEqual(sanitizeChatMessage(bare), { id: 'a', body: 'hello' })
})

test('sanitizeChatMessage: an invalid id is left undefined for the server to mint', () => {
  for (const id of [undefined, null, '', 1, {}, [], 'i'.repeat(65)]) {
    const safe = sanitizeChatMessage({ id, body: 'hello' })
    assert.deepEqual(safe, { id: undefined, body: 'hello' }, String(id))
  }
  assert.equal(sanitizeChatMessage({ id: 'i'.repeat(64), body: 'hello' }).id, 'i'.repeat(64))
})

test('sanitizeChatMessage: each property is read once (getters and proxies cannot swap the value)', () => {
  let bodyReads = 0
  let idReads = 0
  const msg = {}
  Object.defineProperty(msg, 'body', {
    enumerable: true,
    get() {
      return bodyReads++ === 0 ? 'first' : { bad: true }
    },
  })
  Object.defineProperty(msg, 'id', {
    enumerable: true,
    get() {
      return idReads++ === 0 ? 'ok-id' : {}
    },
  })
  assert.deepEqual(sanitizeChatMessage(msg), { id: 'ok-id', body: 'first' })
  assert.equal(bodyReads, 1)
  assert.equal(idReads, 1)

  let traps = 0
  const proxied = new Proxy(
    { id: 'p', body: 'x' },
    {
      get(target, key) {
        traps++
        if (key === 'body') return traps % 2 ? 'odd' : { bad: true }
        return target[key]
      },
    }
  )
  const safe = sanitizeChatMessage(proxied)
  // whichever read happened, the output is the string that was checked
  assert.ok(safe === null || safe.body === 'odd')
})
