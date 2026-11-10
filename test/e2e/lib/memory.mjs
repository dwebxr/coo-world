// The harness side of memory-probe.js: asks the server process for its memory over the IPC channel, and waits for
// that memory to settle after a flood (A12 in fullstack.mjs).
import { TIMEOUT_SCALE, sleep } from './common.mjs'

const TYPE = 'e2e-memory'
const FIELDS = ['heapUsed', 'external', 'rss']

// a memory request that got no reply in time. The process may only be busy, so a caller can ask again
export class MemoryProbeTimeout extends Error {}

function show(value) {
  if (typeof value === 'number') return String(value)
  try {
    return String(JSON.stringify(value)).slice(0, 200)
  } catch {
    return typeof value
  }
}

// what is wrong with a reply, or null: it carries three finite, non-negative byte counts
function problem(reply) {
  for (const field of FIELDS) {
    const value = reply[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return `${field} is ${show(value)}`
  }
  return null
}

// Asks a process that preloads memory-probe.js, spawned with an 'ipc' stdio entry, for its memory. Each request
// sends { type: 'e2e-memory', id } with a fresh id and resolves with the reply that carries that id, once checked:
// { heapUsed, external, rss } in bytes. Replies with any other id are ignored. Only one request is active at a time;
// the probe may still answer a request that timed out, later, and that reply is ignored too.
// A request rejects with MemoryProbeTimeout when no reply comes within `timeout` (scaled like every harness wait,
// and cut to `limit` ms when given), and at once with a plain error when the process exits, the channel closes or
// the reply is malformed.
export function memoryReader(child) {
  if (typeof child.send !== 'function') {
    throw new Error("memoryReader() needs a process spawned with an 'ipc' stdio entry")
  }
  let ids = 0
  let pending = null
  const gone = () => {
    const code = child.exitCode ?? child.signalCode
    if (code !== null) return `server exited (${code}) before reporting its memory`
    if (!child.connected) return 'the IPC channel to the server closed before it reported its memory'
    return null
  }
  child.on('message', message => {
    if (pending === null || message === null || typeof message !== 'object') return
    const current = pending
    try {
      if (message.type !== TYPE || message.id !== current.id) return
      const why = problem(message)
      if (why !== null) current.settle(new Error(`malformed memory reply (${why}): ${show(message)}`))
      else current.settle(null, { heapUsed: message.heapUsed, external: message.external, rss: message.rss })
    } catch (err) {
      current.settle(new Error(`unreadable memory reply: ${err.message}`))
    }
  })
  const request = ({ timeout = 15000, limit = Infinity } = {}) =>
    new Promise((resolve, reject) => {
      const reason = gone()
      if (reason !== null) return reject(new Error(reason))
      const id = ++ids
      const ms = Math.max(0, Math.min(timeout * TIMEOUT_SCALE, limit))
      const onGone = () => settle(new Error(gone() ?? 'the server went away before reporting its memory'))
      const timer = setTimeout(() => settle(new MemoryProbeTimeout(`no memory reply within ${Math.round(ms)} ms`)), ms)
      const settle = (error, value) => {
        if (pending?.id !== id) return
        pending = null
        clearTimeout(timer)
        child.off('exit', onGone)
        child.off('disconnect', onGone)
        if (error) reject(error)
        else resolve(value)
      }
      pending = { id, settle }
      child.on('exit', onGone)
      child.on('disconnect', onGone)
      child.send({ type: TYPE, id }, error => {
        if (error) settle(new Error(`could not ask the server for its memory: ${error.message}`))
      })
    })
  let queue = Promise.resolve()
  return options => {
    const result = queue.then(() => request(options))
    queue = result.catch(() => {})
    return result
  }
}

// Reads `read({ limit })` (resolving with MiB) until a reading is less than `bound` MiB above `baseline`, against an
// absolute deadline `timeout` ms from now, scaled like every harness wait: no request starts after the deadline,
// each request gets at most the time left (`limit`), and a reading that comes back after the deadline fails the wait
// however low it is. A request that times out (MemoryProbeTimeout) only means not settled yet; any other error ends
// the wait at once. The deadline is kept on a monotonic clock, so that setting the wall clock neither stretches nor
// cuts it; `limit` is a duration, and memoryReader's timers are monotonic too. `clock` ({ now, sleep }) is there for
// the tests.
export async function waitForMemoryToSettle(
  read,
  { baseline, bound, timeout, interval = 1000, clock = { now: () => performance.now(), sleep } }
) {
  const total = timeout * TIMEOUT_SCALE
  const deadline = clock.now() + total
  let reading = null
  let error = null
  const fail = why => {
    const last = reading === null ? 'none' : `${reading} MiB`
    return new Error(
      `retained memory did not come back within ${bound} MiB of the ${baseline} MiB baseline in ${total / 1000} s: ` +
        `${why} (last reading: ${last}; last request error: ${error?.message ?? 'none'})`
    )
  }
  for (;;) {
    const left = deadline - clock.now()
    if (left <= 0) throw fail('out of time')
    let value
    try {
      value = await read({ limit: left })
    } catch (err) {
      if (!(err instanceof MemoryProbeTimeout)) throw err
      error = err
      continue
    }
    if (clock.now() > deadline) throw fail(`a reading of ${value} MiB came after the deadline`)
    reading = value
    if (value - baseline < bound) return value
    await clock.sleep(Math.max(0, Math.min(interval, deadline - clock.now())))
  }
}
