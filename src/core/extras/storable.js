// What a math object stores for a component it is given: a primitive as it is, an object or a function as NaN, without
// converting it (converting would run a valueOf, toString or Symbol.toPrimitive a script defined, later, in the
// middle of the engine's own arithmetic). See Vector3Enhanced and extras/three.js.
export function storable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') ? NaN : value
}
