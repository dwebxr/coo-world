import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createRelayDrop,
  sanitizePush,
  sanitizeSessionAvatar,
  sanitizeTeleport,
} from '../src/core/extras/playerRelayPolicy.js'

// --- sanitizeTeleport ---

test('sanitizeTeleport: a finite position passes as a copy; rotationY only when it is a finite number', () => {
  const position = [1, 2, 3]
  const safe = sanitizeTeleport({ position, rotationY: 0.5 })
  assert.deepEqual(safe, { position: [1, 2, 3], rotationY: 0.5 })
  assert.notEqual(safe.position, position)
  assert.deepEqual(sanitizeTeleport({ position: [0, 0, 0], rotationY: 0 }), { position: [0, 0, 0], rotationY: 0 })
  assert.deepEqual(sanitizeTeleport({ position: [-1.5, 0, 1e6] }), { position: [-1.5, 0, 1e6] })
})

test('sanitizeTeleport: a rotationY that is not a finite number is left out, not rejected', () => {
  for (const rotationY of [
    undefined,
    null,
    NaN,
    Infinity,
    -Infinity,
    '1',
    { _x: 0, _y: 0, _z: 0, _w: 1 },
    [0, 0, 0, 1],
  ]) {
    const safe = sanitizeTeleport({ position: [1, 2, 3], rotationY })
    assert.deepEqual(safe, { position: [1, 2, 3] }, String(rotationY))
    assert.equal(Object.prototype.hasOwnProperty.call(safe, 'rotationY'), false)
  }
})

test('sanitizeTeleport: anything without three finite numbers is rejected', () => {
  for (const data of [
    undefined,
    null,
    'x',
    1,
    [],
    {},
    { position: null },
    { position: 'x' },
    { position: [1, 2] },
    { position: [1, 2, 3, 4] },
    { position: [1, NaN, 3] },
    { position: [1, Infinity, 3] },
    { position: ['1', 2, 3] },
    { position: [1, 2, null] },
    { position: new Float32Array([1, 2, 3]) },
    { position: { 0: 1, 1: 2, 2: 3, length: 3 } },
  ]) {
    assert.equal(sanitizeTeleport(data), null, JSON.stringify(data))
  }
})

test('sanitizeTeleport: values are read once (a getter cannot change them after the check)', () => {
  let reads = 0
  const position = [1, 2, 3]
  Object.defineProperty(position, 1, {
    get() {
      return reads++ === 0 ? 2 : NaN
    },
  })
  assert.deepEqual(sanitizeTeleport({ position }), { position: [1, 2, 3] })
})

// --- sanitizePush ---

test('sanitizePush: a finite force passes as a copy, everything else is rejected', () => {
  const force = [0, 0, -30]
  const safe = sanitizePush({ force })
  assert.deepEqual(safe, { force: [0, 0, -30] })
  assert.notEqual(safe.force, force)
  for (const data of [undefined, null, {}, { force: [0, 0] }, { force: [NaN, 0, 0] }, { force: '0,0,1' }, [0, 0, 1]]) {
    assert.equal(sanitizePush(data), null, JSON.stringify(data))
  }
})

// --- sanitizeSessionAvatar ---

test('sanitizeSessionAvatar: { avatar } with an accepted url, null or undefined passes', () => {
  assert.deepEqual(sanitizeSessionAvatar({ avatar: 'asset://avatar.vrm' }), { avatar: 'asset://avatar.vrm' })
  assert.deepEqual(sanitizeSessionAvatar({ avatar: 'https://example.com/a.vrm' }), {
    avatar: 'https://example.com/a.vrm',
  })
  assert.deepEqual(sanitizeSessionAvatar({ avatar: null }), { avatar: null })
  assert.deepEqual(sanitizeSessionAvatar({ avatar: undefined }), { avatar: undefined })
  assert.deepEqual(sanitizeSessionAvatar({}), { avatar: undefined })
})

test('sanitizeSessionAvatar: a bare string (the old relay shape) and rejected urls yield null', () => {
  for (const data of [
    'asset://avatar.vrm',
    undefined,
    null,
    { avatar: 'javascript:1' },
    { avatar: 'data:text/plain,x' },
    { avatar: 'asset://a.glb' },
    { avatar: 1 },
    { avatar: `https://example.com/${'a'.repeat(513)}` },
  ]) {
    assert.equal(sanitizeSessionAvatar(data), null, JSON.stringify(data))
  }
})

// --- createRelayDrop ---

test('createRelayDrop: warns once per socket and packet name, never forwards', () => {
  const warnings = []
  const drop = createRelayDrop(message => warnings.push(message))
  const a = { id: 'socket-a' }
  const b = { id: 'socket-b' }
  for (let i = 0; i < 5; i++) {
    drop(a, 'playerTeleport')
    drop(a, 'playerPush')
    drop(a, 'playerSessionAvatar')
  }
  assert.equal(warnings.length, 3)
  assert.match(warnings[0], /playerTeleport from client socket-a/)
  assert.match(warnings[1], /playerPush from client socket-a/)
  assert.match(warnings[2], /playerSessionAvatar from client socket-a/)
  drop(b, 'playerTeleport')
  drop(b, 'playerTeleport')
  assert.equal(warnings.length, 4)
  assert.match(warnings[3], /playerTeleport from client socket-b/)
  // the handlers take no payload: nothing is read from the packet
  assert.equal(drop(a, 'playerTeleport'), undefined)
})
