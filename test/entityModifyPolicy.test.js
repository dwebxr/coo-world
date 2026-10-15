import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isAvatarUrl,
  isBoundedJsonObject,
  sanitizeAppModify,
  sanitizeAppRelease,
  sanitizeEntityAdd,
  sanitizeName,
  sanitizePlayerSelfModify,
} from '../src/core/extras/entityModifyPolicy.js'

const me = 'socket-me'
const other = 'socket-other'

// --- sanitizeName ---

test('sanitizeName: strings are kept and truncated to 64 characters', () => {
  assert.equal(sanitizeName('Alice'), 'Alice')
  assert.equal(sanitizeName(''), '')
  assert.equal(sanitizeName('a'.repeat(64)), 'a'.repeat(64))
  assert.equal(sanitizeName('a'.repeat(70)), 'a'.repeat(64))
})

test('sanitizeName: non-strings yield undefined', () => {
  for (const v of [undefined, null, 1, true, {}, [], ['a']]) assert.equal(sanitizeName(v), undefined, String(v))
})

// --- isBoundedJsonObject ---

test('isBoundedJsonObject: accepts plain json trees within budget', () => {
  assert.equal(isBoundedJsonObject({}), true)
  assert.equal(isBoundedJsonObject({ n: 1, s: 'x', b: true, z: null, a: [1, 'two', { three: 3 }], o: { p: {} } }), true)
  assert.equal(isBoundedJsonObject(Object.create(null)), true)
  assert.equal(isBoundedJsonObject({ s: 'x'.repeat(8100) }), true)
  assert.equal(isBoundedJsonObject({ s: '漢'.repeat(2000) }), true) // 6000 bytes
})

test('isBoundedJsonObject: rejects non-json values anywhere in the tree', () => {
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(isBoundedJsonObject(cyclic), false)
  assert.equal(isBoundedJsonObject({ m: new Map([['k', 'v'.repeat(20000)]]) }), false)
  assert.equal(isBoundedJsonObject({ a: [new Set()] }), false)
  assert.equal(isBoundedJsonObject({ d: new Date() }), false)
  assert.equal(isBoundedJsonObject({ f() {} }), false)
  assert.equal(isBoundedJsonObject({ u: undefined }), false)
  assert.equal(isBoundedJsonObject({ a: [undefined] }), false)
  assert.equal(isBoundedJsonObject({ n: NaN }), false)
  assert.equal(isBoundedJsonObject({ n: Infinity }), false)
  assert.equal(isBoundedJsonObject({ big: 1n }), false)
  assert.equal(isBoundedJsonObject({ [Symbol('s')]: 1 }), false)
  assert.equal(isBoundedJsonObject({ a: new Uint8Array(2) }), false)
  assert.equal(isBoundedJsonObject([]), false)
  assert.equal(isBoundedJsonObject(null), false)
  assert.equal(isBoundedJsonObject('x'), false)
  assert.equal(isBoundedJsonObject(new Map()), false)
})

test('isBoundedJsonObject: the budget is the exact utf-8 size of the JSON text, 8192 bytes inclusive', () => {
  const bytes = v => Buffer.byteLength(JSON.stringify(v))
  const expect = (value, ok) => {
    assert.equal(isBoundedJsonObject(value), ok, `${bytes(value)} bytes should be ${ok ? 'accepted' : 'rejected'}`)
  }
  // plain ascii: {"s":"..."} is 8 bytes of punctuation
  assert.equal(bytes({ s: 'x'.repeat(8184) }), 8192)
  expect({ s: 'x'.repeat(8184) }, true)
  expect({ s: 'x'.repeat(8185) }, false)
  // escapes count: NUL -> \u0000 (6 bytes), quotes and backslashes -> 2 bytes, lone surrogates -> 6 bytes
  assert.ok(bytes({ s: '\0'.repeat(8180) }) > 8192)
  expect({ s: '\0'.repeat(8180) }, false)
  assert.equal(bytes({ s: '"'.repeat(4092) }), 8192)
  expect({ s: '"'.repeat(4092) }, true)
  expect({ s: '"'.repeat(4093) }, false)
  expect({ s: '\\'.repeat(5000) }, false)
  assert.equal(bytes({ s: '\ud800'.repeat(1364) }), 8192)
  expect({ s: '\ud800'.repeat(1364) }, true)
  expect({ s: '\ud800'.repeat(1365) }, false)
  // escaped keys count too
  assert.equal(bytes({ ['"'.repeat(4093)]: 1 }), 8192)
  expect({ ['"'.repeat(4093)]: 1 }, true)
  expect({ ['"'.repeat(4094)]: 1 }, false)
  // multi-byte characters count their utf-8 size
  assert.equal(bytes({ s: '漢'.repeat(2728) }), 8192)
  expect({ s: '漢'.repeat(2728) }, true)
  expect({ s: '漢'.repeat(2729) }, false)
  expect({ s: '漢'.repeat(3000) }, false)
  // separators are exact: a wide object right at the limit
  const wide = {}
  for (let i = 0; i < 100; i++) wide['k' + String(i).padStart(2, '0')] = 'v'.repeat(72)
  wide.pad = 'p'.repeat(8192 - bytes(wide) - 9) // {"pad":""} adds 9 bytes around the content
  assert.equal(bytes(wide), 8192)
  expect(wide, true)
  wide.pad += 'p'
  expect(wide, false)
  // early limits still apply
  assert.equal(isBoundedJsonObject({ s: 'x'.repeat(8200) }), false)
  assert.equal(isBoundedJsonObject({ ['k'.repeat(9000)]: 1 }), false)
  const many = {}
  for (let i = 0; i < 1100; i++) many[i] = 1
  assert.equal(isBoundedJsonObject(many), false) // too many items
  let deep = {}
  const root = deep
  for (let i = 0; i < 20; i++) deep = deep.d = {}
  assert.equal(isBoundedJsonObject(root), false) // too deep
})

// --- isAvatarUrl ---

test('isAvatarUrl: null and undefined are accepted (they clear a session avatar)', () => {
  assert.equal(isAvatarUrl(undefined), true)
  assert.equal(isAvatarUrl(null), true)
})

test('isAvatarUrl: asset .vrm names (built-in or content hash) and http(s) urls are accepted', () => {
  assert.equal(isAvatarUrl('asset://avatar.vrm'), true)
  assert.equal(isAvatarUrl(`asset://${'0123456789abcdef'.repeat(4)}.vrm`), true)
  assert.equal(isAvatarUrl('asset://My_avatar-v2.0.vrm'), true)
  assert.equal(isAvatarUrl('https://example.com/avatars/a.vrm'), true)
  assert.equal(isAvatarUrl('http://localhost:3000/a.vrm?v=1#x'), true)
  assert.equal(isAvatarUrl('HTTPS://EXAMPLE.COM/A.VRM'), true)
  const longest = `https://example.com/${'a'.repeat(512 - 'https://example.com/'.length)}`
  assert.equal(longest.length, 512)
  assert.equal(isAvatarUrl(longest), true)
})

test('isAvatarUrl: other schemes, non-vrm or nested assets, non-strings and long values are rejected', () => {
  for (const v of [
    'data:text/plain,x',
    'blob:http://localhost/0000',
    'javascript:1',
    'file:///a.vrm',
    'ftp://example.com/a.vrm',
    'asset://a.glb',
    'asset://a.VRM',
    'asset://../a.vrm',
    'asset://a/b.vrm',
    'asset://a.vrm?x=1',
    'asset://a.vrm#x',
    'asset://.vrm',
    'asset://',
    'a.vrm',
    '/assets/a.vrm',
    'http://',
    'https://exa mple.com/a.vrm',
    '',
    1,
    true,
    {},
    [],
    ['asset://avatar.vrm'],
    Symbol('s'),
    () => 'asset://avatar.vrm',
  ]) {
    assert.equal(isAvatarUrl(v), false, typeof v === 'symbol' ? 'symbol' : String(v))
  }
  assert.equal(isAvatarUrl(`https://example.com/${'a'.repeat(513)}`), false)
  assert.equal(isAvatarUrl(`asset://${'a'.repeat(510)}.vrm`), false)
})

// --- sanitizePlayerSelfModify ---

test('sanitizePlayerSelfModify: every owner field with a valid value survives, keyed by the socket id', () => {
  const data = {
    id: me,
    p: [1, 2, 3],
    q: [0, 0, 0, 1],
    m: 2,
    a: [0, 0, 1],
    g: [0, 1, 0],
    e: 'asset://emote.glb',
    ef: { emote: 'asset://x.glb', duration: 1 },
    t: true,
    name: 'Alice',
    sessionAvatar: 'asset://a.vrm',
    avatar: 'asset://b.vrm',
  }
  const safe = sanitizePlayerSelfModify(data, me, { allowAvatar: true })
  assert.deepEqual(safe, data)
  assert.notEqual(safe, data) // a new object
})

test('sanitizePlayerSelfModify: server-controlled fields are dropped, id is preserved', () => {
  const safe = sanitizePlayerSelfModify(
    { id: me, p: [1, 2, 3], rank: 2, health: 0, owner: other, userId: other, junk: 1 },
    me,
    { allowAvatar: true }
  )
  assert.deepEqual(safe, { id: me, p: [1, 2, 3] })
})

test('sanitizePlayerSelfModify: returns null when nothing usable remains', () => {
  assert.equal(sanitizePlayerSelfModify({ id: me, rank: 2 }, me), null)
  assert.equal(sanitizePlayerSelfModify({ id: me }, me), null)
  assert.equal(sanitizePlayerSelfModify(null, me), null)
  assert.equal(sanitizePlayerSelfModify('x', me), null)
  assert.equal(sanitizePlayerSelfModify([], me), null)
})

test('sanitizePlayerSelfModify: a bad value drops only that key', () => {
  const safe = sanitizePlayerSelfModify(
    {
      id: me,
      p: 'nope',
      q: [0, 0, 0],
      a: [0, NaN, 0],
      g: [0, Infinity, 0],
      m: '1',
      name: 42,
      e: 1,
      ef: 'x',
      sessionAvatar: {},
      t: 'yes',
      // the one good field
      avatar: 'asset://ok.vrm',
    },
    me,
    { allowAvatar: true }
  )
  assert.deepEqual(safe, { id: me, avatar: 'asset://ok.vrm' })
})

test('sanitizePlayerSelfModify: e and sessionAvatar preserve undefined and null as received', () => {
  let safe = sanitizePlayerSelfModify({ id: me, e: undefined }, me)
  assert.ok(Object.prototype.hasOwnProperty.call(safe, 'e'))
  assert.equal(safe.e, undefined)
  safe = sanitizePlayerSelfModify({ id: me, e: null, sessionAvatar: undefined }, me)
  assert.equal(safe.e, null)
  assert.ok(Object.prototype.hasOwnProperty.call(safe, 'sessionAvatar'))
  assert.equal(safe.sessionAvatar, undefined)
  safe = sanitizePlayerSelfModify({ id: me, sessionAvatar: null }, me)
  assert.equal(safe.sessionAvatar, null)
})

test('sanitizePlayerSelfModify: ef accepts null or a bounded json object only', () => {
  assert.deepEqual(sanitizePlayerSelfModify({ id: me, ef: null }, me), { id: me, ef: null })
  assert.equal(sanitizePlayerSelfModify({ id: me, ef: new Map() }, me), null)
  assert.equal(sanitizePlayerSelfModify({ id: me, ef: { m: new Map([['k', 'v'.repeat(20000)]]) } }, me), null)
  assert.equal(sanitizePlayerSelfModify({ id: me, ef: { s: 'x'.repeat(9000) } }, me), null)
  assert.equal(sanitizePlayerSelfModify({ id: me, ef: { s: '漢'.repeat(3000) } }, me), null)
})

test('sanitizePlayerSelfModify: name is truncated to 64 characters', () => {
  const safe = sanitizePlayerSelfModify({ id: me, name: 'b'.repeat(70) }, me)
  assert.equal(safe.name, 'b'.repeat(64))
})

test('sanitizePlayerSelfModify: sessionAvatar and avatar follow the avatar url policy', () => {
  assert.deepEqual(sanitizePlayerSelfModify({ id: me, sessionAvatar: 'asset://avatar.vrm' }, me), {
    id: me,
    sessionAvatar: 'asset://avatar.vrm',
  })
  assert.deepEqual(sanitizePlayerSelfModify({ id: me, sessionAvatar: 'https://example.com/a.vrm' }, me), {
    id: me,
    sessionAvatar: 'https://example.com/a.vrm',
  })
  for (const bad of [
    'data:text/plain,x',
    'blob:http://localhost/x',
    'javascript:1',
    'asset://a.glb',
    'x'.repeat(513),
  ]) {
    assert.equal(sanitizePlayerSelfModify({ id: me, sessionAvatar: bad }, me), null, bad.slice(0, 20))
    assert.equal(sanitizePlayerSelfModify({ id: me, avatar: bad }, me, { allowAvatar: true }), null, bad.slice(0, 20))
  }
  // a rejected url drops only that key
  assert.deepEqual(sanitizePlayerSelfModify({ id: me, sessionAvatar: 'javascript:1', p: [1, 2, 3] }, me), {
    id: me,
    p: [1, 2, 3],
  })
  // the equipped avatar is still a string only; null never persists
  assert.equal(sanitizePlayerSelfModify({ id: me, avatar: null }, me, { allowAvatar: true }), null)
})

test('sanitizePlayerSelfModify: avatar is included only when allowed, other fields still apply', () => {
  const data = { id: me, avatar: 'asset://x.vrm', p: [0, 0, 0] }
  assert.deepEqual(sanitizePlayerSelfModify(data, me), { id: me, p: [0, 0, 0] })
  assert.deepEqual(sanitizePlayerSelfModify(data, me, { allowAvatar: false }), { id: me, p: [0, 0, 0] })
  assert.deepEqual(sanitizePlayerSelfModify(data, me, { allowAvatar: true }), data)
  assert.equal(sanitizePlayerSelfModify({ id: me, avatar: 1 }, me, { allowAvatar: true }), null)
})

// --- sanitizeAppModify (builder) ---

const appId = 'app-1'
const transform = { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }

test('sanitizeAppModify: builder keys survive with valid values', () => {
  const data = { id: appId, blueprint: 'bp', uploader: null, mover: me, pinned: true, state: { n: 1 }, ...transform }
  assert.deepEqual(sanitizeAppModify(data, me), data)
  assert.deepEqual(sanitizeAppModify({ id: appId, uploader: null, mover: null, state: null }, me), {
    id: appId,
    uploader: null,
    mover: null,
    state: null,
  })
})

test('sanitizeAppModify: uploader can only be cleared, never claimed (claims happen at entityAdded)', () => {
  assert.deepEqual(sanitizeAppModify({ id: appId, uploader: null }, me), { id: appId, uploader: null })
  assert.equal(sanitizeAppModify({ id: appId, uploader: me }, me), null)
  assert.equal(sanitizeAppModify({ id: appId, uploader: other }, me), null)
  assert.deepEqual(sanitizeAppModify({ id: appId, uploader: me, pinned: true }, me), { id: appId, pinned: true })
  for (const v of [undefined, '', 0, false, {}]) assert.equal(sanitizeAppModify({ id: appId, uploader: v }, me), null)
})

test('sanitizeAppModify: junk keys and bad values are dropped, null when nothing remains', () => {
  const safe = sanitizeAppModify(
    { id: appId, type: 'player', owner: me, blueprint: '', position: [1, 2], quaternion: 'x', scale: [1, 1, 1] },
    me
  )
  assert.deepEqual(safe, { id: appId, scale: [1, 1, 1] })
  assert.equal(sanitizeAppModify({ id: appId, rank: 2 }, me), null)
  assert.equal(sanitizeAppModify({ id: appId, pinned: 'true' }, me), null)
  assert.equal(sanitizeAppModify(null, me), null)
})

test('sanitizeAppModify: mover may only be null or the sender; uploader only null', () => {
  assert.deepEqual(sanitizeAppModify({ id: appId, mover: other }, me), null)
  assert.deepEqual(sanitizeAppModify({ id: appId, uploader: other }, me), null)
  assert.deepEqual(sanitizeAppModify({ id: appId, mover: me, uploader: other }, me), { id: appId, mover: me })
  assert.deepEqual(sanitizeAppModify({ id: appId, mover: me, uploader: me }, me), { id: appId, mover: me })
})

test('sanitizeAppModify: state must be a bounded json object or null', () => {
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(sanitizeAppModify({ id: appId, state: cyclic }, me), null)
  assert.equal(sanitizeAppModify({ id: appId, state: 'x' }, me), null)
  assert.equal(sanitizeAppModify({ id: appId, state: [1] }, me), null)
  assert.equal(sanitizeAppModify({ id: appId, state: { s: 'x'.repeat(9000) } }, me), null)
  assert.equal(sanitizeAppModify({ id: appId, state: { m: new Map([['k', 'v'.repeat(20000)]]) } }, me), null)
  assert.equal(sanitizeAppModify({ id: appId, state: { s: '漢'.repeat(3000) } }, me), null)
  assert.deepEqual(sanitizeAppModify({ id: appId, state: {} }, me), { id: appId, state: {} })
})

test('sanitizeAppModify: blueprint can be required to exist', () => {
  const blueprintExists = id => id === 'known'
  assert.deepEqual(sanitizeAppModify({ id: appId, blueprint: 'known' }, me, { blueprintExists }), {
    id: appId,
    blueprint: 'known',
  })
  assert.equal(sanitizeAppModify({ id: appId, blueprint: 'unknown' }, me, { blueprintExists }), null)
})

// --- sanitizeAppRelease (sender lost builder) ---

test('sanitizeAppRelease (mover): transforms pass, mover only as null, state only with mover: null', () => {
  const opts = { mover: true }
  // transforms while still the mover
  assert.deepEqual(sanitizeAppRelease({ id: appId, ...transform, pinned: true, blueprint: 'bp' }, opts), {
    id: appId,
    ...transform,
  })
  // mover may not be re-claimed, uploader is not held
  assert.equal(sanitizeAppRelease({ id: appId, mover: me }, opts), null)
  assert.equal(sanitizeAppRelease({ id: appId, mover: other }, opts), null)
  assert.equal(sanitizeAppRelease({ id: appId, uploader: null }, opts), null)
  // state alone, or with transforms but without mover: null, is dropped
  assert.equal(sanitizeAppRelease({ id: appId, state: { x: 1 } }, opts), null)
  assert.deepEqual(sanitizeAppRelease({ id: appId, state: { x: 1 }, ...transform }, opts), { id: appId, ...transform })
  // the release packet: state is reset
  assert.deepEqual(sanitizeAppRelease({ id: appId, mover: null, state: { x: 1 }, ...transform }, opts), {
    id: appId,
    mover: null,
    state: {},
    ...transform,
  })
})

test('sanitizeAppRelease (uploader): uploader only as null, nothing else', () => {
  const opts = { uploader: true }
  assert.deepEqual(sanitizeAppRelease({ id: appId, uploader: null, ...transform, state: {} }, opts), {
    id: appId,
    uploader: null,
  })
  assert.equal(sanitizeAppRelease({ id: appId, uploader: me }, opts), null)
  assert.equal(sanitizeAppRelease({ id: appId, mover: null }, opts), null)
  assert.equal(sanitizeAppRelease({ id: appId, ...transform }, opts), null)
})

test('sanitizeAppRelease (mover and uploader): both releases combine; neither masks the other', () => {
  const opts = { mover: true, uploader: true }
  assert.deepEqual(sanitizeAppRelease({ id: appId, uploader: null }, opts), { id: appId, uploader: null })
  assert.deepEqual(sanitizeAppRelease({ id: appId, mover: null, ...transform, state: {} }, opts), {
    id: appId,
    mover: null,
    ...transform,
    state: {},
  })
  assert.deepEqual(sanitizeAppRelease({ id: appId, mover: null, uploader: null, state: { x: 1 } }, opts), {
    id: appId,
    mover: null,
    state: {},
    uploader: null,
  })
  assert.equal(sanitizeAppRelease({ id: appId, mover: me, uploader: me }, opts), null)
  assert.equal(sanitizeAppRelease({ id: appId }, {}), null)
  assert.equal(sanitizeAppRelease(null, opts), null)
})

// --- sanitizeEntityAdd ---

const addBase = {
  id: 'new-app',
  type: 'app',
  blueprint: 'bp',
  ...transform,
  mover: null,
  uploader: null,
  pinned: false,
  state: {},
}
const checks = { blueprintExists: id => id === 'bp', entityExists: id => id === 'taken' }

test('sanitizeEntityAdd: a well-formed app add passes through, extra keys dropped', () => {
  assert.deepEqual(sanitizeEntityAdd({ ...addBase, owner: me, rank: 2 }, me, checks), addBase)
  assert.deepEqual(
    sanitizeEntityAdd({ ...addBase, mover: me, uploader: me, pinned: true, state: { n: 1 } }, me, checks),
    {
      ...addBase,
      mover: me,
      uploader: me,
      pinned: true,
      state: { n: 1 },
    }
  )
})

test('sanitizeEntityAdd: structural problems are rejected', () => {
  assert.equal(sanitizeEntityAdd({ ...addBase, type: 'player' }, me, checks), null)
  assert.equal(sanitizeEntityAdd({ ...addBase, type: 'playerLocal' }, me, checks), null)
  assert.equal(sanitizeEntityAdd({ ...addBase, type: 'constructor' }, me, checks), null)
  assert.equal(sanitizeEntityAdd({ ...addBase, id: 1 }, me, checks), null)
  assert.equal(sanitizeEntityAdd({ ...addBase, id: '' }, me, checks), null)
  assert.equal(sanitizeEntityAdd({ ...addBase, id: 'taken' }, me, checks), null)
  assert.equal(sanitizeEntityAdd({ ...addBase, blueprint: 'missing' }, me, checks), null)
  assert.equal(sanitizeEntityAdd({ ...addBase, blueprint: 1 }, me, checks), null)
  assert.equal(sanitizeEntityAdd({ ...addBase, position: [0, 0] }, me, checks), null)
  assert.equal(sanitizeEntityAdd({ ...addBase, quaternion: [0, 0, 0, NaN] }, me, checks), null)
  assert.equal(sanitizeEntityAdd({ ...addBase, scale: null }, me, checks), null)
  assert.equal(sanitizeEntityAdd(null, me, checks), null)
  assert.equal(sanitizeEntityAdd('app', me, checks), null)
})

test('sanitizeEntityAdd: stale fields from an undo re-add are coerced, not rejected', () => {
  const { pinned: _pinned, ...noPinned } = addBase
  const safe = sanitizeEntityAdd({ ...noPinned, mover: other, uploader: other, state: { n: 1 } }, me, checks)
  assert.deepEqual(safe, { ...addBase, mover: null, uploader: null, pinned: false, state: { n: 1 } })
  const cyclic = {}
  cyclic.self = cyclic
  assert.deepEqual(sanitizeEntityAdd({ ...addBase, pinned: 'yes', state: cyclic }, me, checks).state, {})
  assert.deepEqual(sanitizeEntityAdd({ ...addBase, state: undefined }, me, checks).state, {})
  assert.deepEqual(sanitizeEntityAdd({ ...addBase, state: 'x' }, me, checks).state, {})
  assert.deepEqual(sanitizeEntityAdd({ ...addBase, state: { m: new Map() } }, me, checks).state, {})
  assert.deepEqual(sanitizeEntityAdd({ ...addBase, state: { s: '漢'.repeat(3000) } }, me, checks).state, {})
})
