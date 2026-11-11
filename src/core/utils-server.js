import crypto from 'crypto'
import jwt from 'jsonwebtoken'

/**
 *
 * Hash File
 *
 * takes a file and generates a sha256 unique hash.
 * carefully does this the same way as the client function.
 *
 */

export async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  hash.update(file)
  return hash.digest('hex')
}

/**
 * Session tokens (JSON Web Tokens)
 *
 * A token says which user a connection is: `{ userId }`, signed with JWT_SECRET. Whoever holds one is that user,
 * and whoever holds the secret is any user.
 *
 * - A token lasts SESSION_DAYS without being used. Every connect with a token older than a day gets a new one (the
 *   join snapshot carries it and the client stores what the snapshot carries), so a user who keeps coming back never
 *   notices, and a copy of a token that leaked stops working that long after its last renewal... of that copy: a
 *   renewal does not cancel the token it replaces. Only a new secret does.
 * - Tokens made before tokens had an end have none, and stay valid until the secret changes. They are renewed, with
 *   an end, the first time they are used.
 * - JWT_SECRET_PREVIOUS (optional) is accepted when a token is read and never used to sign: the secret can be changed
 *   without every visitor becoming a new user (their rank is stored with the user). A token it verifies is renewed
 *   under the current secret. It is for planned changes only: after a leak of the old secret it must not be set,
 *   since anyone holding that secret can sign a token for any user and have it renewed.
 * - The algorithm is pinned (HS256). The library already refuses unsigned tokens for a string secret; the pin also
 *   refuses the other HMAC sizes.
 */

export const SESSION_DAYS = 180
const DAY_SECONDS = 24 * 60 * 60
const ALGORITHM = 'HS256'

// `now` in milliseconds, for tests
export function createSessionTokens({ secret, previous = null, now = Date.now }) {
  const seconds = () => Math.floor(now() / 1000)

  // a new token for a user: always a fresh payload (signing a verified payload again would keep its old `iat`, and
  // the end is counted from that)
  function sign(userId) {
    const iat = seconds()
    return new Promise((resolve, reject) => {
      jwt.sign(
        { userId, iat, exp: iat + SESSION_DAYS * DAY_SECONDS },
        secret,
        { algorithm: ALGORITHM },
        (err, token) => {
          if (err) return reject(err)
          resolve(token)
        }
      )
    })
  }

  function verify(token, key, options) {
    return new Promise(resolve => {
      jwt.verify(token, key, { algorithms: [ALGORITHM], clockTimestamp: seconds(), ...options }, (err, data) => {
        resolve(err ? null : data)
      })
    })
  }

  // -> { userId, renew } for a token that is good now, or null. `renew`: the connection should get a new token
  //    (this one is older than a day, has no end, or was signed with the previous secret).
  async function read(token) {
    if (typeof token !== 'string' || !token) return null
    let data = await verify(token, secret)
    let old = false
    if (!data && previous) {
      data = await verify(token, previous)
      old = true
    }
    if (!data || typeof data.userId !== 'string') return null
    const age = typeof data.iat === 'number' ? seconds() - data.iat : Infinity
    const renew = old || typeof data.exp !== 'number' || age > DAY_SECONDS
    return { ...data, renew }
  }

  // the user id of a token that is genuine but past its end, or null (also for a token that is still good): to tell
  // an operator that a ranked user came back too late, never to sign anyone in
  async function expiredUser(token) {
    if (typeof token !== 'string' || !token) return null
    if (await read(token)) return null
    for (const key of [secret, previous]) {
      if (!key) continue
      const data = await verify(token, key, { ignoreExpiration: true })
      if (data && typeof data.userId === 'string') return data.userId
    }
    return null
  }

  return { sign, read, expiredUser }
}

// the server's own, from the environment
const sessions = createSessionTokens({
  secret: process.env.JWT_SECRET,
  previous: process.env.JWT_SECRET_PREVIOUS || null,
})

export function createJWT(data) {
  return sessions.sign(data.userId)
}

// the token's payload ({ userId, renew, ... }) or null
export function readJWT(token) {
  return sessions.read(token)
}

export function expiredSessionUser(token) {
  return sessions.expiredUser(token)
}
