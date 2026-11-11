// How many AI generations the world runs, and for whom.
//
// A generation (create, edit or fix) is a call to the operator's AI provider on the operator's account, of up to
// 16,000 output tokens. Any builder could start any number of them at once, for as long as they liked; in a world
// where every visitor is a builder (no admin code), so could anyone.
//
// Who a request is counted against is the caller's choice of key: a user id for a stored rank, a wallet address
// for a builder who is one only by holding a token (user ids are free: every new connection gets one). In a world
// open to all, user ids are all there is, and then only the world's own limits hold. They are the ceiling on what
// the operator can be made to spend; the per-user ones keep one builder from using the whole of it.

export const AI_LIMIT_DEFAULTS = Object.freeze({
  perUserConcurrent: 1,
  perUserPerHour: 20,
  concurrent: 2,
  perHour: 60,
})

const HOUR_MS = 60 * 60 * 1000
const MAX_KEYS = 4096

// AI_MAX_PER_USER_PER_HOUR, AI_MAX_PER_HOUR, AI_MAX_CONCURRENT: whole numbers of at least 1; unset keeps the
// default. A bad value throws at start-up rather than run without a limit.
export function readAiLimitsEnv(env) {
  const read = (name, fallback) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1) throw new Error(`[envs] ${name} must be a whole number of at least 1`)
    return value
  }
  return {
    perUserConcurrent: AI_LIMIT_DEFAULTS.perUserConcurrent,
    perUserPerHour: read('AI_MAX_PER_USER_PER_HOUR', AI_LIMIT_DEFAULTS.perUserPerHour),
    concurrent: read('AI_MAX_CONCURRENT', AI_LIMIT_DEFAULTS.concurrent),
    perHour: read('AI_MAX_PER_HOUR', AI_LIMIT_DEFAULTS.perHour),
  }
}

// `now` is a clock that only goes forward (performance.now by default), in milliseconds
export function createAiBudget(limits = AI_LIMIT_DEFAULTS, { now = () => performance.now() } = {}) {
  const { perUserConcurrent, perUserPerHour, concurrent, perHour } = { ...AI_LIMIT_DEFAULTS, ...limits }
  // key -> { running, starts: [time, ...] }
  const users = new Map()
  let running = 0
  let starts = []

  const recent = (list, time) => {
    while (list.length && time - list[0] >= HOUR_MS) list.shift()
    return list
  }

  function forget(time) {
    for (const [key, user] of users) {
      if (!user.running && !recent(user.starts, time).length) users.delete(key)
    }
  }

  // Takes a place for one generation.
  // -> { ok: true, done } (call done() once, when the generation has ended either way)
  //  | { ok: false, reason: 'user_busy' | 'user_limit' | 'world_busy' | 'world_limit' }
  function start(key) {
    const time = now()
    let user = users.get(key)
    if (user) recent(user.starts, time)
    if (user && user.running >= perUserConcurrent) return { ok: false, reason: 'user_busy' }
    if (user && user.starts.length >= perUserPerHour) return { ok: false, reason: 'user_limit' }
    if (running >= concurrent) return { ok: false, reason: 'world_busy' }
    if (recent(starts, time).length >= perHour) return { ok: false, reason: 'world_limit' }
    if (!user) {
      if (users.size >= MAX_KEYS) forget(time)
      // (still full: every key is running or was used this hour, which the world's own limits make impossible
      // at this size; the entry is added all the same)
      user = { running: 0, starts: [] }
      users.set(key, user)
    }
    user.running++
    user.starts.push(time)
    running++
    starts.push(time)
    let ended = false
    return {
      ok: true,
      done() {
        if (ended) return
        ended = true
        user.running--
        running--
      },
    }
  }

  return { start, stats: () => ({ running, lastHour: recent(starts, now()).length, users: users.size }) }
}

// what a refused requester is told
export const AI_REFUSALS = Object.freeze({
  user_busy: 'Your previous AI request is still running.',
  user_limit: 'You have reached the hourly limit for AI requests. Try again later.',
  world_busy: 'The AI is busy with other requests. Try again in a moment.',
  world_limit: 'This world has reached its hourly limit for AI requests. Try again later.',
  invalid: 'That AI request could not be read.',
})

const NAMES = ['create', 'edit', 'fix']
// a prompt or an error text sent to the provider, in characters
export const AI_TEXT_MAX_LENGTH = 16000
const ID_MAX_LENGTH = 64
const ERROR_KEYS = ['name', 'message', 'stack']

// The parts of an `ai` packet the server uses, as plain values, or null when it is not one: { name, blueprintId,
// appId, prompt } for create and edit, { name, blueprintId, appId, error } for fix, where error is the crashed
// script's { name, message, stack } (strings; anything else in it is dropped). Each property is read once, and each
// text is cut to AI_TEXT_MAX_LENGTH: it goes to the provider as part of the request.
export function readAiAction(action) {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) return null
  const name = action.name
  if (!NAMES.includes(name)) return null
  const blueprintId = action.blueprintId
  if (typeof blueprintId !== 'string' || !blueprintId || blueprintId.length > ID_MAX_LENGTH) return null
  const appId = action.appId
  if (appId !== undefined && appId !== null && (typeof appId !== 'string' || appId.length > ID_MAX_LENGTH)) return null
  if (name === 'fix') {
    const given = action.error
    if (given === null || typeof given !== 'object' || Array.isArray(given)) return null
    const error = {}
    for (const key of ERROR_KEYS) {
      const value = given[key]
      if (typeof value === 'string') error[key] = value.slice(0, AI_TEXT_MAX_LENGTH)
    }
    if (!error.message && !error.stack) return null
    return { name, blueprintId, appId, error }
  }
  const prompt = action.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) return null
  return { name, blueprintId, appId, prompt: prompt.slice(0, AI_TEXT_MAX_LENGTH) }
}
