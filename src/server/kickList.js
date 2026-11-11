// Who a kick keeps out, and for how long.
//
// A kick used to close the connection and nothing more: the kicked player reloaded the page and was back, with the
// same user and the same rank. Now the kicked user id is refused for KICK_MINUTES.
//
// What this is: a delay for that user id. User ids are free: a player who clears their browser's storage joins as a
// new user. KICK_BY_ADDRESS=true also makes new users from the kicked connection's address wait: only kicks by an
// admin make such an entry, and it refuses only a connection that arrives without a valid session token (the way
// around the id entry). Everyone else who is new behind that address waits with them: a household, a venue's Wi-Fi,
// and behind a proxy that does not pass client addresses, every new visitor. That is why it is off unless asked for.
// Nothing is stored: a restart forgets the list. At most MAX_ENTRIES user ids and as many addresses are listed: a kick
// that finds that many still waiting ends the oldest one's wait early. Nothing else lifts an entry.

export const KICK_LIMIT_DEFAULTS = Object.freeze({ minutes: 10, byAddress: false })

const MAX_MINUTES = 24 * 60
const MAX_ENTRIES = 4096

// KICK_MINUTES: a whole number from 0 (a kick keeps nobody out) to 1440; KICK_BY_ADDRESS: true or false. Unset keeps
// the default. A bad value throws at start-up rather than run with another meaning than the one written.
export function readKickEnv(env) {
  let minutes = KICK_LIMIT_DEFAULTS.minutes
  const raw = env.KICK_MINUTES
  if (raw !== undefined && raw !== '') {
    // digits only: Number() reads a blank as 0, which here would mean "a kick keeps nobody out"
    minutes = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isInteger(minutes) || minutes > MAX_MINUTES) {
      throw new Error(`[envs] KICK_MINUTES must be a whole number from 0 to ${MAX_MINUTES}`)
    }
  }
  let byAddress = KICK_LIMIT_DEFAULTS.byAddress
  const flag = env.KICK_BY_ADDRESS
  if (flag !== undefined && flag !== '') {
    if (flag !== 'true' && flag !== 'false') throw new Error('[envs] KICK_BY_ADDRESS must be true or false')
    byAddress = flag === 'true'
  }
  return { minutes, byAddress }
}

// a map of key -> the time its entry ends, oldest first, with at most `max` entries
function createEntries(durationMs, now, max) {
  const until = new Map()
  const sweep = time => {
    // entries all last the same time, so the map's order is the order they end in
    for (const [key, end] of until) {
      if (end > time) break
      until.delete(key)
    }
  }
  return {
    add(key) {
      const time = now()
      sweep(time)
      // a second kick starts the wait again, at the end of the order
      until.delete(key)
      if (until.size >= max) until.delete(until.keys().next().value)
      until.set(key, time + durationMs)
    },
    has(key) {
      const end = until.get(key)
      if (end === undefined) return false
      if (end > now()) return true
      until.delete(key)
      return false
    },
    get size() {
      return until.size
    },
  }
}

export function createKickList(
  { minutes = KICK_LIMIT_DEFAULTS.minutes, byAddress = KICK_LIMIT_DEFAULTS.byAddress } = {},
  { now = () => performance.now(), max = MAX_ENTRIES } = {}
) {
  const durationMs = minutes * 60 * 1000
  const users = createEntries(durationMs, now, max)
  const addresses = createEntries(durationMs, now, max)
  return {
    minutes,
    byAddress,
    // a kick of `userId`, whose connection came from `addressKey`; `byAdmin`: the kicker is an admin
    add({ userId, addressKey, byAdmin = false }) {
      if (!durationMs) return
      if (typeof userId === 'string' && userId) users.add(userId)
      // 'unknown' is the key of every address that could not be read: it names nobody
      if (byAddress && byAdmin && typeof addressKey === 'string' && addressKey && addressKey !== 'unknown') {
        addresses.add(addressKey)
      }
    },
    // this user id was kicked within the minutes
    refusesUser(userId) {
      return users.has(userId)
    },
    // a connection without a valid session token, from an address an admin kicked a player at within the minutes
    refusesNewcomer(addressKey) {
      return typeof addressKey === 'string' && addresses.has(addressKey)
    },
    stats() {
      return { users: users.size, addresses: addresses.size }
    },
  }
}
