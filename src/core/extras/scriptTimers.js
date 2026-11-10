// Timers handed to app scripts.
//
// Scripts get an opaque numeric handle; the real timers stay host-private and are all
// cleared when the app is unbuilt, so a script's callbacks never outlive its run.
// At most TIMER_LIMIT timers are pending per app; setTimeout past that throws.

export const TIMER_LIMIT = 1024

export function createScriptTimers({ limit = TIMER_LIMIT } = {}) {
  const timers = new Map()
  let ids = 0
  return {
    set(fn, ms) {
      if (timers.size >= limit) throw new Error(`[app] setTimeout: more than ${limit} pending timers`)
      // the slot is taken before anything else runs, and the delay must be a primitive: the native setTimeout
      // would call an object's valueOf, which could schedule more timers while this one is not counted yet
      const id = ++ids
      timers.set(id, null)
      const delay = typeof ms === 'number' || typeof ms === 'string' ? Number(ms) : 0
      let timer
      try {
        timer = setTimeout(() => {
          timers.delete(id)
          try {
            fn()
          } catch (err) {
            console.error(err)
          }
        }, delay)
      } catch (err) {
        timers.delete(id)
        throw err
      }
      // cleared while being set (a clear() cannot run in between, but stay exact)
      if (timers.has(id)) timers.set(id, timer)
      else clearTimeout(timer)
      return id
    },
    clear() {
      for (const timer of timers.values()) if (timer !== null) clearTimeout(timer)
      timers.clear()
    },
    get size() {
      return timers.size
    },
  }
}
