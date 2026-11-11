// A host copy of data a script hands the engine to send (app.send, app.sendTo), made by reading the script's value
// here, in our own code, before any packer sees it.
//
// Reading a script's value runs the script's code (a getter, a toJSON, a Proxy trap), and that code may do anything
// a script may do: send another message, end its app's run. The packer (msgpackr) cannot be the reader: it keeps one
// buffer and one write position for all its packers, and each keeps where its message began, so a message packed
// from inside the reading of another left the outer one's bytes wrong, could come out unreadable itself, and (when
// it moved the buffer on) made the outer one write outside it and the next message of anyone throw. So the value is
// read first, by readScriptData, and what the packer is given is the copy: plain host objects holding primitives,
// with nothing in them a script wrote code for. Packing the copy runs no script code, so no pack begins inside
// another (packets.js refuses one that would, as a backstop).
//
// What the copy holds, and how it compares with what the packer read from the value itself:
//
// - null, booleans, numbers, strings, bigints and undefined are themselves. A symbol is passed on, and refused by
//   the packer as it was.
// - An array is an array of its elements up to its length (holes are undefined). A plain object, and an instance
//   of a class of the script's, is a plain object of its own enumerable properties; where the packer asked an
//   object's toJSON (one whose `constructor` is not Object: a class instance, an object without a prototype), it
//   is asked here, and its result is copied in the object's place. A function is its toJSON's result, or undefined.
// - Map, Set, Date, Error (its name, message and cause), RegExp, ArrayBuffer and typed arrays are new ones of the
//   engine's own classes with the value's contents (a Node Buffer stays a Buffer).
// - A value met twice is copied once, so shared and circular references are kept for the packer that keeps them
//   (the server's), also when the circle passes through a toJSON.
//
// For these the copy packs to the bytes the value packed to, on the server's packer and a client's
// (test/scriptData.test.js compares them). Where it does not:
// - an instance whose toJSON returns a primitive, or a function, met twice, was written the second time as a
//   reference to the first and is now written as the value again (the receiver reads the same);
// - entries of a Map or a Set that become equal once read (two functions, both undefined) are one entry here. They
//   were one at the receiver too, except that a client's packer writes a Set as an array, which is now that much
//   shorter;
// - a subclass of a built-in is copied as the built-in, with its contents (the packer wrote `class Rows extends
//   Map` as an empty object, and tagged a subclass of a typed array with no known type).
// - a toJSON result stands for its owner wherever the owner is met in the message, so two owners that return the
//   same object holding both of them are both that object (the packer made one of them a second copy).
//
// A kind is told by what the value is, not by what it says it is (`constructor`, Symbol.toStringTag): the contents
// of a built-in are read with the built-in's own methods, never with a method the value carries (a typed array's
// slice consults its constructor's Symbol.species, which a script can set).
//
// The values of one message are counted (an owner and its toJSON result as one): a message of more than MAX_VALUES
// could not be sent (the largest packet is PACKET_CAP bytes, and a value takes at least one), and an array may say
// any length (a Proxy's, or
// `list.length = 2 ** 32 - 1`), which was read element by element until memory ran out.

import { PACKET_CAP } from './writeLedger.js'

export const MAX_VALUES = PACKET_CAP
export const TOO_MANY_VALUES = `the data has more than ${MAX_VALUES} values and cannot be sent`

const TypedArray = Object.getPrototypeOf(Uint8Array.prototype).constructor
const typedArrayKind = Object.getOwnPropertyDescriptor(TypedArray.prototype, Symbol.toStringTag).get
const typedArrayBuffer = Object.getOwnPropertyDescriptor(TypedArray.prototype, 'buffer').get
const typedArrayOffset = Object.getOwnPropertyDescriptor(TypedArray.prototype, 'byteOffset').get
const typedArrayBytes = Object.getOwnPropertyDescriptor(TypedArray.prototype, 'byteLength').get
const bufferBytes = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const dateTime = Date.prototype.getTime
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get
const mapEach = Map.prototype.forEach
const mapSet = Map.prototype.set
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get
const setEach = Set.prototype.forEach
const setAdd = Set.prototype.add
const regexSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get
const regexFlags = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags').get
const owns = Object.prototype.hasOwnProperty
const tagOf = Object.prototype.toString
const TYPED = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
}
if (typeof Float16Array === 'function') TYPED.Float16Array = Float16Array // eslint-disable-line no-undef
const NodeBuffer = typeof Buffer === 'function' ? Buffer : null

// the result of a built-in's own method on the value, or `missing` when the value is not of that built-in's kind
const missing = Symbol('missing')
function ask(method, value) {
  try {
    return method.call(value)
  } catch {
    return missing
  }
}

// a property of the copy: defined, not assigned, so a key such as `__proto__` is an ordinary property of it
function put(copy, key, value) {
  Object.defineProperty(copy, key, { value, writable: true, enumerable: true, configurable: true })
}

// the bytes of a buffer, in a new buffer of the engine's
function copyBytes(buffer, offset, length) {
  const bytes = new Uint8Array(length)
  bytes.set(new Uint8Array(buffer, offset, length))
  return bytes.buffer
}

export function readScriptData(value) {
  // seen: the copy of each object read; pending: an object whose toJSON result is being read, and that result
  return read(value, { seen: new Map(), pending: new Map(), left: MAX_VALUES })
}

function read(value, state) {
  if (--state.left < 0) throw new RangeError(TOO_MANY_VALUES)
  const type = typeof value
  if (value === null || (type !== 'object' && type !== 'function')) return value
  const { seen, pending } = state
  if (seen.has(value)) return seen.get(value)
  // met again inside its own toJSON result (`toJSON() { return { owner: this } }`): it is that result. Owners
  // whose results are each other, and nothing else, are an empty object (as the server's packer had them)
  if (pending.has(value)) {
    const met = new Set()
    let result = value
    while (pending.has(result)) {
      if (met.has(result)) return {}
      met.add(result)
      result = pending.get(result)
    }
    state.left++ // (the owner and what stands for it are one value)
    return read(result, state)
  }
  if (type === 'function') return readJSON(value, state, undefined)
  if (Array.isArray(value)) {
    const copy = []
    seen.set(value, copy)
    // (the length is read once; an array a Proxy stands for may answer anything, and the count above bounds it)
    const length = Math.min(Math.max(Math.trunc(Number(value.length)) || 0, 0), 2 ** 32 - 1)
    if (length > state.left) throw new RangeError(TOO_MANY_VALUES)
    for (let i = 0; i < length; i++) copy.push(read(value[i], state))
    return copy
  }
  // the packer wrote an object whose `constructor` is Object as a plain object, without asking anything else
  if (value.constructor !== Object) {
    const built = readBuiltIn(value, state)
    if (built !== missing) return built
    const json = readJSON(value, state, missing)
    if (json !== missing) return json
  }
  const copy = {}
  seen.set(value, copy)
  for (const key in value) {
    if (owns.call(value, key)) put(copy, key, read(value[key], state))
  }
  return copy
}

// what a value's toJSON says in its place (the copy of its result), or `otherwise` when it has none or names itself
function readJSON(value, state, otherwise) {
  const toJSON = value.toJSON
  if (toJSON) {
    const json = toJSON.call(value)
    if (json !== value) {
      state.pending.set(value, json)
      state.left++ // (the owner and what stands for it are one value)
      const copy = read(json, state)
      state.pending.delete(value)
      state.seen.set(value, copy)
      return copy
    }
  }
  if (otherwise !== missing) state.seen.set(value, otherwise)
  return otherwise
}

function readBuiltIn(value, state) {
  const { seen } = state
  // What a value says it is decides nothing, but one that says it is an ordinary object is not asked whether it
  // is a Map, a Date and so on (each such question is a refused call for a class instance): a built-in that hides
  // behind that tag is copied as the ordinary object it claims to be.
  if (tagOf.call(value) !== '[object Object]') {
    const built = readBranded(value, seen, state)
    if (built !== missing) return built
  }
  // An error has no mark of its own to ask for, so it is told by its prototypes, after everything that has one (a
  // Map over a prototype chain that passes through Error's is a Map), and also when it says it is an ordinary
  // object: a Proxy of an error says so, and the packer took it for the error it stands for.
  if (value instanceof Error) {
    // what the packer writes of an error: its name, its message and its cause
    const copy = new Error('')
    seen.set(value, copy)
    put(copy, 'name', read(value.name, state))
    put(copy, 'message', read(value.message, state))
    put(copy, 'cause', read(value.cause, state))
    return copy
  }
  return missing
}

// the built-ins that are told by a mark of their own: a typed array, a Date, an ArrayBuffer, a Map, a Set, a RegExp
function readBranded(value, seen, state) {
  const kind = typedArrayKind.call(value)
  if (kind !== undefined) {
    const Type = TYPED[kind]
    if (!Type) return missing
    const bytes = copyBytes(typedArrayBuffer.call(value), typedArrayOffset.call(value), typedArrayBytes.call(value))
    // (a Node Buffer is packed as bytes; a Uint8Array has its own form on the server's packer)
    const copy = NodeBuffer && value instanceof NodeBuffer ? NodeBuffer.from(bytes) : new Type(bytes)
    seen.set(value, copy)
    return copy
  }
  const time = ask(dateTime, value)
  if (time !== missing) {
    const copy = new Date(time)
    seen.set(value, copy)
    return copy
  }
  const bytes = ask(bufferBytes, value)
  if (bytes !== missing) {
    const copy = copyBytes(value, 0, bytes)
    seen.set(value, copy)
    return copy
  }
  if (ask(mapSize, value) !== missing) {
    const copy = new Map()
    seen.set(value, copy)
    // the entries as they are now, then each read (reading one can run script code, which may change the map)
    const entries = []
    mapEach.call(value, (entry, key) => entries.push(key, entry))
    for (let i = 0; i < entries.length; i += 2) mapSet.call(copy, read(entries[i], state), read(entries[i + 1], state))
    return copy
  }
  if (ask(setSize, value) !== missing) {
    const copy = new Set()
    seen.set(value, copy)
    const entries = []
    setEach.call(value, entry => entries.push(entry))
    for (const entry of entries) setAdd.call(copy, read(entry, state))
    return copy
  }
  const source = ask(regexSource, value)
  if (source !== missing && value !== RegExp.prototype) {
    const flags = ask(regexFlags, value)
    const copy = new RegExp(source, flags === missing ? '' : flags)
    seen.set(value, copy)
    return copy
  }
  return missing
}
