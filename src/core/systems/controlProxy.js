// Script-facing control handle. Wraps an empty object so nothing but the resolver's
// results is reachable (enumeration and `in` see no keys).
export function createControlProxy(resolve) {
  return new Proxy({}, { get: (_target, prop) => resolve(prop) })
}
