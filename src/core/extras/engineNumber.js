// What an engine number slot keeps of a value it is given: a component of a vector, quaternion or euler (their
// setters, set, copy, fromArray and the like, the views of sealMath.js, Node's transform guards) and an entry of a
// matrix (the views, Stage's instance reads). One rule everywhere:
//   - a number is kept;
//   - a string, a boolean or null is converted (`Number(value)`: '2' is 2, true is 1, null is 0, 'abc' is NaN);
//     converting a primitive runs no script code;
//   - anything else is NaN, without being converted: undefined, a Symbol and a BigInt (converting them throws, so a
//     number slot holding one throws in the engine later), and any object or function, a boxed primitive
//     (`new Number(1)`) included, whose valueOf, toString or Symbol.toPrimitive is script code.
export function toEngineNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return Number(value)
  return NaN
}

// What an euler keeps of an order it is given: a string; anything else leaves the order it has.
export function toEngineOrder(value, current) {
  return typeof value === 'string' ? value : current
}
