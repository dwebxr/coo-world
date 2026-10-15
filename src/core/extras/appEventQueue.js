// The events an app receives while it is (re)building, held until the build is done. Pure, so the bound and
// the drain can be tested without an App (which needs the three/PhysX bundle).

export const APP_EVENT_QUEUE_MAX = 64

export function createEventQueue({ max = APP_EVENT_QUEUE_MAX } = {}) {
  const events = []

  // keeps the newest `max` events; true when the oldest was dropped to make room
  function push(event) {
    events.push(event)
    if (events.length <= max) return false
    events.shift()
    return true
  }

  // emits, in order, every queued event whose version is at or below `version`; a newer one is dropped rather
  // than left at the head, where it would hold back the events behind it. a throwing emit is handed to
  // `onError` and the drain goes on, so the caller always reaches the end of its build. events pushed while
  // draining are drained too
  function drain(version, emit, onError) {
    let delivered = 0
    let dropped = 0
    while (events.length) {
      const event = events.shift()
      if (event.version > version) {
        dropped++
        continue
      }
      try {
        emit(event)
        delivered++
      } catch (err) {
        onError?.(err, event)
      }
    }
    return { delivered, dropped }
  }

  function clear() {
    events.length = 0
  }

  return {
    push,
    drain,
    clear,
    get size() {
      return events.length
    },
  }
}
