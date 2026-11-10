// Type checks for the values scripts give node setters and methods.
//
// lodash's isNumber, isString and isBoolean also accept a boxed primitive (`new Number(1)`, whose `valueOf` a script
// can replace) and any object, a Proxy included, whose Symbol.toStringTag says so (the check itself runs the Proxy's
// traps). A setter keeps what it accepts, and host code converts it later: arithmetic, a WebIDL call, a template, a
// structured clone, often in the middle of an engine operation (a commit, a mount, another app's frame) or in another
// app's callback. Script code reached that way could end its run while the operation is half done. These checks accept
// the primitives only, so what a node keeps is plain data and no script code runs when the engine uses it.
export function isNumber(value) {
  return typeof value === 'number'
}

export function isString(value) {
  return typeof value === 'string'
}

export function isBoolean(value) {
  return typeof value === 'boolean'
}

// null, undefined, a number, a string, a boolean, a bigint or a symbol: nothing that can hold script code
export function isPrimitive(value) {
  return value === null || (typeof value !== 'object' && typeof value !== 'function')
}
