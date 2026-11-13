// src/core/utils-server.js createSessionTokens: what a session token is, how long it lasts, and how the secret is
// changed without every visitor becoming a new user.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET ||= 'session-tokens-test-secret-of-32-chars-x'
const { createSessionTokens, SESSION_DAYS } = await import('../src/core/utils-server.js')

const SECRET = 'the-current-secret-0123456789abcdef-xyz'
const OLD = 'the-previous-secret-0123456789abcdef-xyz'
const DAY = 24 * 60 * 60 * 1000

function clock(start = Date.UTC(2026, 10, 12)) {
  let time = start
  return { now: () => time, advance: ms => (time += ms), seconds: () => Math.floor(time / 1000) }
}

test('a new token names its user, ends after 180 days, and is signed HS256', async () => {
  const c = clock()
  const tokens = createSessionTokens({ secret: SECRET, now: c.now })
  const token = await tokens.sign('user-1')
  const { header, payload } = jwt.decode(token, { complete: true })
  assert.equal(header.alg, 'HS256')
  assert.deepEqual(payload, { userId: 'user-1', iat: c.seconds(), exp: c.seconds() + SESSION_DAYS * 86400 })
  const read = await tokens.read(token)
  assert.equal(read.userId, 'user-1')
  assert.equal(read.renew, false, 'a token just made is not renewed')
})

test('a token older than a day is renewed, and the renewal is a new token that is good for another 180 days', async () => {
  const c = clock()
  const tokens = createSessionTokens({ secret: SECRET, now: c.now })
  const first = await tokens.sign('user-1')
  c.advance(DAY - 1000)
  assert.equal((await tokens.read(first)).renew, false)
  c.advance(2000)
  assert.equal((await tokens.read(first)).renew, true)
  // 179 days later, still good, renewed: the renewal must count its 180 days from now, not from the first token's
  // start (signing the verified payload again keeps its old `iat`, and gives a token that ends with the first one)
  c.advance(178 * DAY)
  const read = await tokens.read(first)
  assert.equal(read.renew, true)
  const second = await tokens.sign(read.userId)
  c.advance(10 * DAY)
  assert.equal(await tokens.read(first), null, 'the first token has ended')
  const later = await tokens.read(second)
  assert.equal(later?.userId, 'user-1', 'the renewal has not')
  assert.equal(jwt.decode(second).exp - jwt.decode(second).iat, SESSION_DAYS * 86400)
})

test('a token past its end is refused, and tells only the operator whose it was', async () => {
  const c = clock()
  const tokens = createSessionTokens({ secret: SECRET, now: c.now })
  const token = await tokens.sign('user-1')
  assert.equal(await tokens.expiredUser(token), null, 'a good token is not an expired one')
  c.advance(SESSION_DAYS * DAY + 1000)
  assert.equal(await tokens.read(token), null)
  assert.equal(await tokens.expiredUser(token), 'user-1')
  // a forgery is neither
  const forged = jwt.sign({ userId: 'user-1', iat: 1, exp: 2 }, 'not-the-secret', { algorithm: 'HS256' })
  assert.equal(await tokens.read(forged), null)
  assert.equal(await tokens.expiredUser(forged), null)
})

test('a token from before tokens had an end is still good, and is renewed', async () => {
  const c = clock()
  const tokens = createSessionTokens({ secret: SECRET, now: c.now })
  // as the server signed them: { userId } with the library's own iat, no exp
  const legacy = jwt.sign({ userId: 'old-timer', iat: c.seconds() - 400 * 86400 }, SECRET)
  const read = await tokens.read(legacy)
  assert.equal(read.userId, 'old-timer')
  assert.equal(read.renew, true)
  const fresh = jwt.sign({ userId: 'old-timer', iat: c.seconds() }, SECRET)
  assert.equal((await tokens.read(fresh)).renew, true, 'without an end it is renewed whatever its age')
})

test('the previous secret is accepted for reading only, and its tokens are renewed under the current one', async () => {
  const c = clock()
  const before = createSessionTokens({ secret: OLD, now: c.now })
  const token = await before.sign('user-1')
  const after = createSessionTokens({ secret: SECRET, previous: OLD, now: c.now })
  const read = await after.read(token)
  assert.equal(read.userId, 'user-1')
  assert.equal(read.renew, true, 'even a token made a moment ago')
  const renewed = await after.sign(read.userId)
  // (checked at the test's own time: the tokens are made by its clock, and the library would use today's)
  const at = { clockTimestamp: c.seconds() }
  assert.throws(() => jwt.verify(renewed, OLD, at), /invalid signature/, 'never signed with the previous secret')
  assert.equal(jwt.verify(renewed, SECRET, at).userId, 'user-1')
  // without the previous secret configured the old token is nobody's
  const rotatedOut = createSessionTokens({ secret: SECRET, now: c.now })
  assert.equal(await rotatedOut.read(token), null)
  // an expired token of the previous secret is still reported as lapsed
  c.advance(SESSION_DAYS * DAY + 1000)
  assert.equal(await after.read(token), null)
  assert.equal(await after.expiredUser(token), 'user-1')
})

test('only HS256 tokens with a string user id are sessions', async () => {
  const c = clock()
  const tokens = createSessionTokens({ secret: SECRET, now: c.now })
  const iat = c.seconds()
  // another HMAC size with the right secret: accepted by the library's defaults, refused by the pin
  const hs512 = jwt.sign({ userId: 'user-1', iat, exp: iat + 1000 }, SECRET, { algorithm: 'HS512' })
  assert.equal(jwt.verify(hs512, SECRET, { clockTimestamp: iat }).userId, 'user-1', 'the library alone would take it')
  assert.equal(await tokens.read(hs512), null)
  // unsigned
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
    JSON.stringify({ userId: 'user-1', iat, exp: iat + 1000 })
  ).toString('base64url')}.`
  assert.equal(await tokens.read(none), null)
  for (const payload of [{ userId: 7 }, { userId: { id: 'user-1' } }, { user: 'user-1' }, {}]) {
    const token = jwt.sign({ ...payload, iat, exp: iat + 1000 }, SECRET, { algorithm: 'HS256' })
    assert.equal(await tokens.read(token), null, JSON.stringify(payload))
  }
  for (const value of [undefined, null, '', 7, {}, 'not.a.token']) assert.equal(await tokens.read(value), null)
})

// readNow: what the door asks for a place kept for ranked users (wsRoute.js), in the turn it is asked
test('readNow gives the answer read gives, in the same turn, for every kind of token', async () => {
  const c = clock()
  const old = createSessionTokens({ secret: OLD, now: c.now })
  const tokens = createSessionTokens({ secret: SECRET, previous: OLD, now: c.now })
  const iat = c.seconds()
  const fresh = await tokens.sign('user-1')
  const previous = await old.sign('user-2')
  const legacy = jwt.sign({ userId: 'old-timer', iat: iat - 400 * 86400 }, SECRET)
  const forged = jwt.sign({ userId: 'user-1', iat, exp: iat + 1000 }, 'not-the-secret')
  const hs512 = jwt.sign({ userId: 'user-1', iat, exp: iat + 1000 }, SECRET, { algorithm: 'HS512' })
  const noUser = jwt.sign({ iat, exp: iat + 1000 }, SECRET)
  const cases = [fresh, previous, legacy, forged, hs512, noUser, undefined, null, '', 7, {}, 'not.a.token']
  const answers = async () => {
    for (const token of cases) {
      const now = tokens.readNow(token)
      assert.ok(!(now instanceof Promise), 'not a promise')
      assert.deepEqual(now, await tokens.read(token), String(token))
    }
  }
  await answers()
  assert.equal(tokens.readNow(fresh).userId, 'user-1')
  assert.equal(tokens.readNow(previous).renew, true)
  assert.equal(tokens.readNow(forged), null)
  // a day on (renewal), and past the end (null): still the same answers
  c.advance(DAY + 1000)
  await answers()
  assert.equal(tokens.readNow(fresh).renew, true)
  c.advance(SESSION_DAYS * DAY)
  await answers()
  assert.equal(tokens.readNow(fresh), null)
})

// claimedUserId: the id a token NAMES, which the door asks about before it checks the signature
test('claimedUserId reads the user id a token names, forged or expired, and checks nothing', async () => {
  const c = clock()
  const tokens = createSessionTokens({ secret: SECRET, now: c.now })
  const iat = c.seconds()
  const forged = jwt.sign({ userId: 'an-admin', iat, exp: iat + 1000 }, 'not-the-secret')
  assert.equal(tokens.readNow(forged), null)
  assert.equal(tokens.claimedUserId(forged), 'an-admin', 'the id inside a forged token')
  const expired = jwt.sign({ userId: 'an-admin', iat: 1, exp: 2 }, SECRET)
  assert.equal(tokens.claimedUserId(expired), 'an-admin')
  const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
    '{"userId":"an-admin"}'
  ).toString('base64url')}.`
  assert.equal(tokens.claimedUserId(unsigned), 'an-admin')
  assert.equal(tokens.claimedUserId(await tokens.sign('user-1')), 'user-1')
  // nothing that does not decode to a payload with a string user id: never a throw
  const notJson = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from('{nope').toString(
    'base64url'
  )}.x`
  for (const value of [
    undefined,
    null,
    '',
    7,
    {},
    'not.a.token',
    'a.b',
    notJson,
    jwt.sign({ userId: 7 }, SECRET),
    jwt.sign({ user: 'x' }, SECRET),
  ]) {
    assert.equal(tokens.claimedUserId(value), null, String(value))
  }
})
