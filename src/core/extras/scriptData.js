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
// The copy is what the packer would have read from the value, for the values a script ordinarily sends: null,
// booleans, numbers, strings, bigints, undefined; arrays; plain objects and class instances (their own enumerable
// properties; an instance's toJSON is used, as the packer used it); Map, Set, Date, Error, RegExp, ArrayBuffer and
// typed arrays (new ones of the engine's own classes, with the value's contents). A function is undefined (or its
// toJSON's result), as it was. An object met twice is copied once, so shared and circular references are kept for
// the packer that keeps them (the server's). A symbol is passed on and refused by the packer.
//
// A kind is told by what the value is, not by what it says it is (`constructor`, Symbol.toStringTag): the contents
// of a built-in are read with the built-in's own methods, never with a method the value carries (a typed array's
// slice consults its constructor's Symbol.species, which a script can set).

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
  return read(value, new Map())
}

function read(value, seen) {
  const type = typeof value
  if (value === null || (type !== 'object' && type !== 'function')) return value
  if (seen.has(value)) return seen.get(value)
  if (type === 'function') {
    // as the packer had it: a function's toJSON speaks for it, and without one it is undefined
    const toJSON = value.toJSON
    if (toJSON) {
      const json = toJSON.call(value)
      if (json !== value) return read(json, seen)
    }
    return undefined
  }
  if (Array.isArray(value)) {
    const copy = []
    seen.set(value, copy)
    // (the length is read once; an array a Proxy stands for may answer anything)
    const length = Math.min(Math.max(Math.trunc(Number(value.length)) || 0, 0), 2 ** 32 - 1)
    for (let i = 0; i < length; i++) copy.push(read(value[i], seen))
    return copy
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    const built = readBuiltIn(value, seen)
    if (built !== missing) return built
    // an instance of a class of the script's: its toJSON speaks for it (the packer asked objects that are not
    // plain ones, and only those)
    const toJSON = value.toJSON
    if (toJSON) {
      const json = toJSON.call(value)
      if (json !== value) {
        const copy = read(json, seen)
        seen.set(value, copy)
        return copy
      }
    }
  }
  const copy = {}
  seen.set(value, copy)
  for (const key in value) {
    if (owns.call(value, key)) put(copy, key, read(value[key], seen))
  }
  return copy
}

function readBuiltIn(value, seen) {
  const kind = typedArrayKind.call(value)
  if (kind !== undefined) {
    const Type = TYPED[kind]
    if (!Type) return missing
    const copy = new Type(
      copyBytes(typedArrayBuffer.call(value), typedArrayOffset.call(value), typedArrayBytes.call(value))
    )
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
    for (let i = 0; i < entries.length; i += 2) mapSet.call(copy, read(entries[i], seen), read(entries[i + 1], seen))
    return copy
  }
  if (ask(setSize, value) !== missing) {
    const copy = new Set()
    seen.set(value, copy)
    const entries = []
    setEach.call(value, entry => entries.push(entry))
    for (const entry of entries) setAdd.call(copy, read(entry, seen))
    return copy
  }
  const source = ask(regexSource, value)
  if (source !== missing && value !== RegExp.prototype) {
    const flags = ask(regexFlags, value)
    const copy = new RegExp(source, flags === missing ? '' : flags)
    seen.set(value, copy)
    return copy
  }
  if (value instanceof Error) {
    // what the packer writes of an error: its name, its message and its cause
    const copy = new Error('')
    seen.set(value, copy)
    put(copy, 'name', read(value.name, seen))
    put(copy, 'message', read(value.message, seen))
    put(copy, 'cause', read(value.cause, seen))
    return copy
  }
  return missing
}
