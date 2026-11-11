// How many AI actions the world runs, for whom, and for how long.
//
// An action (create, edit or fix) makes requests to the operator's AI provider on the operator's account: an edit
// or a fix one, a create two (its script and a name for it). A request for a script has an output limit of 16,000
// tokens, one for a name 4,096 (ServerAI.js). The OpenAI and Anthropic SDKs retry a failed request on their own
// (twice by default). The limits here count admitted actions, not requests or retries. Any builder could start any
// number of actions at once, for as long as they liked; in a world where every visitor is a builder (no admin
// code), so could anyone.
//
// Who a request is counted against is the caller's choice of key: a user id for a stored rank, a wallet address
// for a builder who is one only by holding a token (user ids are free: every new connection gets one). In a world
// open to all, user ids are all there is, and then only the world's own limits hold. They bound the actions the
// operator can be made to pay for; the per-user ones keep one builder from using all of them.

export const AI_LIMIT_DEFAULTS = Object.freeze({
  perUserConcurrent: 1,
  perUserPerHour: 20,
  concurrent: 2,
  perHour: 60,
  // how long one admitted action may run in all, in seconds (ServerAI.run). The Anthropic SDK reckons an hour for
  // 128,000 output tokens when it decides whether a request may be made without streaming, so 7.5 minutes for the
  // 16,000 of a generation; ten minutes leaves room for reading the script and for a slow start.
  maxSeconds: 600,
})

const HOUR_MS = 60 * 60 * 1000
const MAX_KEYS = 4096
// a timer longer than about 24.8 days fires at once in Node.js, so the deadline stays well under it
const MAX_SECONDS = 24 * 60 * 60

// AI_MAX_PER_USER_PER_HOUR, AI_MAX_PER_HOUR, AI_MAX_CONCURRENT: whole numbers of at least 1; AI_MAX_SECONDS: a whole
// number from 1 to 86,400. Unset keeps the default. A bad value throws at start-up rather than run without a limit.
export function readAiLimitsEnv(env) {
  const read = (name, fallback, max = Infinity) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(
        `[envs] ${name} must be a whole number of at least 1${max === Infinity ? '' : ` and at most ${max}`}`
      )
    }
    return value
  }
  return {
    perUserConcurrent: AI_LIMIT_DEFAULTS.perUserConcurrent,
    perUserPerHour: read('AI_MAX_PER_USER_PER_HOUR', AI_LIMIT_DEFAULTS.perUserPerHour),
    concurrent: read('AI_MAX_CONCURRENT', AI_LIMIT_DEFAULTS.concurrent),
    perHour: read('AI_MAX_PER_HOUR', AI_LIMIT_DEFAULTS.perHour),
    maxSeconds: read('AI_MAX_SECONDS', AI_LIMIT_DEFAULTS.maxSeconds, MAX_SECONDS),
  }
}

// `now` is a clock that only goes forward (performance.now by default), in milliseconds
export function createAiBudget(limits = AI_LIMIT_DEFAULTS, { now = () => performance.now() } = {}) {
  const { perUserConcurrent, perUserPerHour, concurrent, perHour } = { ...AI_LIMIT_DEFAULTS, ...limits }
  // key -> { running, starts: [time, ...] }
  const users = new Map()
  let running = 0
  let starts = []
  // When the table is full, the earliest time a scan of it can find a key to forget: a key is forgotten an hour
  // after its last start (or when it ends, if it ran longer than that, see done), so until then a scan would find
  // nothing and is not made.
  let sweepAt = 0
  let sweeps = 0

  const recent = (list, time) => {
    while (list.length && time - list[0] >= HOUR_MS) list.shift()
    return list
  }

  function forget(time) {
    sweeps++
    sweepAt = Infinity
    for (const [key, user] of users) {
      const last = recent(user.starts, time).at(-1)
      if (last !== undefined) sweepAt = Math.min(sweepAt, last + HOUR_MS)
      else if (!user.running) users.delete(key)
    }
  }

  // Takes a place for one generation.
  // -> { ok: true, done } (call done() once, when the generation has ended either way)
  //  | { ok: false, reason: 'user_busy' | 'user_limit' | 'world_busy' | 'world_limit' | 'world_full' }
  function start(key) {
    const time = now()
    let user = users.get(key)
    if (user) recent(user.starts, time)
    if (user && user.running >= perUserConcurrent) return { ok: false, reason: 'user_busy' }
    if (user && user.starts.length >= perUserPerHour) return { ok: false, reason: 'user_limit' }
    if (running >= concurrent) return { ok: false, reason: 'world_busy' }
    if (recent(starts, time).length >= perHour) return { ok: false, reason: 'world_limit' }
    if (!user) {
      if (users.size >= MAX_KEYS && time >= sweepAt) forget(time)
      // Still full: every key started within the hour or still runs (which takes AI_MAX_PER_HOUR near or above the
      // table's size). A new key is refused, and the keys already counted are kept: forgetting one would give it a
      // fresh hour.
      if (users.size >= MAX_KEYS) return { ok: false, reason: 'world_full' }
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
        // a key that ran past the end of its hour has nothing left to count
        if (!user.running && !recent(user.starts, now()).length && users.get(key) === user) users.delete(key)
      },
    }
  }

  return { start, stats: () => ({ running, lastHour: recent(starts, now()).length, users: users.size, sweeps }) }
}

// what a refused requester is told
export const AI_REFUSALS = Object.freeze({
  user_busy: 'Your previous AI request is still running.',
  user_limit: 'You have reached the hourly limit for AI requests. Try again later.',
  world_busy: 'The AI is busy with other requests. Try again in a moment.',
  world_limit: 'This world has reached its hourly limit for AI requests. Try again later.',
  world_full: 'The AI is busy with other requests. Try again later.',
  invalid: 'That AI request could not be read.',
})

const NAMES = ['create', 'edit', 'fix']
// a prompt or an error text sent to the provider, in characters
export const AI_TEXT_MAX_LENGTH = 16000
const ID_MAX_LENGTH = 64
// what serializeError() makes of a thrown value, and ClientAI.fix of it when the packet would be too large
const ERROR_TEXTS = ['name', 'message', 'stack', 'fileName']
const ERROR_NUMBERS = ['lineNumber', 'columnNumber']
// what the provider is told of an error that says nothing itself (a script can throw '' or { code: 'E_BAD' })
export const AI_ERROR_FALLBACK = 'The script threw a value with no message and no stack trace.'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// A crashed script's error as serializeError() gives it: texts cut to AI_TEXT_MAX_LENGTH, a code that is a text or
// a finite number, line and column numbers, and one level of cause (its own cause is dropped). Anything else is
// dropped; nothing in it is required.
function readError(given, depth = 1) {
  const error = {}
  for (const key of ERROR_TEXTS) {
    const value = given[key]
    if (typeof value === 'string') error[key] = value.slice(0, AI_TEXT_MAX_LENGTH)
  }
  const code = given.code
  if (typeof code === 'string') error.code = code.slice(0, AI_TEXT_MAX_LENGTH)
  else if (Number.isFinite(code)) error.code = code
  for (const key of ERROR_NUMBERS) {
    const value = given[key]
    if (Number.isFinite(value)) error[key] = value
  }
  if (depth > 0) {
    const cause = given.cause
    if (isRecord(cause)) {
      const read = readError(cause, depth - 1)
      if (Object.keys(read).length) error.cause = read
    }
  }
  return error
}

// The parts of an `ai` packet the server uses, as plain values, or null when it is not one: { name, blueprintId,
// appId, prompt } for create and edit, { name, blueprintId, appId, error } for fix, where error is the crashed
// script's error as readError() keeps it, with AI_ERROR_FALLBACK as its message when it has neither a message nor
// a stack. Each property is read once, and each text is cut to AI_TEXT_MAX_LENGTH: it goes to the provider as part
// of the request.
export function readAiAction(action) {
  if (!isRecord(action)) return null
  const name = action.name
  if (!NAMES.includes(name)) return null
  const blueprintId = action.blueprintId
  if (typeof blueprintId !== 'string' || !blueprintId || blueprintId.length > ID_MAX_LENGTH) return null
  const appId = action.appId
  if (appId !== undefined && appId !== null && (typeof appId !== 'string' || appId.length > ID_MAX_LENGTH)) return null
  if (name === 'fix') {
    const given = action.error
    if (!isRecord(given)) return null
    const error = readError(given)
    if (!error.message && !error.stack) error.message = AI_ERROR_FALLBACK
    return { name, blueprintId, appId, error }
  }
  const prompt = action.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) return null
  return { name, blueprintId, appId, prompt: prompt.slice(0, AI_TEXT_MAX_LENGTH) }
}
