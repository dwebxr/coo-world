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
      const id = ++ids
      const timer = setTimeout(() => {
        timers.delete(id)
        try {
          fn()
        } catch (err) {
          console.error(err)
        }
      }, ms)
      timers.set(id, timer)
      return id
    },
    clear() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
    get size() {
      return timers.size
    },
  }
}
