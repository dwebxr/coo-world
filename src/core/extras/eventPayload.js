// Engine events (enter, leave, health, command) reach every app's `world.on` listeners as one object. It is a
// frozen copy, so a listener cannot change what the next app (or the engine) sees, or plant an accessor on it.
// Plain data only: arrays and plain objects are copied (to a bounded depth), other objects and functions are
// left out, primitives are kept.

const MAX_DEPTH = 8

function copy(value, depth) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(value)) return Object.freeze(Array.from(value, item => copy(item, depth + 1)))
  // a plain object of any realm: its prototype is an Object.prototype (whose own prototype is null), or null
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return undefined
  const out = {}
  for (const key of Object.keys(value)) {
    const item = copy(value[key], depth + 1)
    if (item !== undefined) Object.defineProperty(out, key, { value: item, enumerable: true })
  }
  return Object.freeze(out)
}

export function eventPayload(data) {
  return copy(data, 0)
}
