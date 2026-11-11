// The fetch() handed to app scripts: a whitelisted request init and a response object that exposes
// plain values only. Body reads resolve to intrinsics or a script-safe blob, and any failure reaches
// the script as an intrinsic error.

import { createScriptBlob, isScriptBlob, toHostBlob } from './scriptBlob.js'
import { toScriptError } from './scriptValues.js'

const STRING_OPTIONS = ['method', 'mode', 'credentials', 'cache', 'redirect']

// every script property is read exactly once (a getter may answer differently on a second read)
function read(object, key) {
  try {
    return object[key]
  } catch {
    return undefined
  }
}

// only these keys of a script's options reach the host fetch; headers are copied as a string map and
// a body may be a string, an ArrayBuffer, a typed array/DataView, or a blob returned by fetch()
export function toHostFetchOptions(options) {
  const init = {}
  if (!options || typeof options !== 'object') return init
  for (const key of STRING_OPTIONS) {
    const value = read(options, key)
    if (typeof value === 'string') init[key] = value
  }
  const headers = read(options, 'headers')
  if (headers && typeof headers === 'object') {
    init.headers = {}
    let names = []
    try {
      names = Object.keys(headers)
    } catch {
      // a Proxy whose ownKeys trap throws contributes no headers
    }
    for (const name of names) {
      const value = read(headers, name)
      if (typeof value === 'string') init.headers[name] = value
    }
  }
  const body = read(options, 'body')
  if (typeof body === 'string') {
    init.body = body
  } else if (isScriptBlob(body)) {
    init.body = toHostBlob(body)
  } else {
    const bytes = copyBytes(body)
    if (bytes) init.body = bytes
  }
  return init
}

const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const viewGetters = [TypedArrayPrototype, DataView.prototype].map(proto => ({
  buffer: Object.getOwnPropertyDescriptor(proto, 'buffer').get,
  byteOffset: Object.getOwnPropertyDescriptor(proto, 'byteOffset').get,
  byteLength: Object.getOwnPropertyDescriptor(proto, 'byteLength').get,
}))

// the bytes [offset, offset + length) of a buffer in a new ArrayBuffer of the host's. Not ArrayBuffer's slice: it
// makes its result with the constructor the buffer names (Symbol.species), so a script's subclass would run its code
// here and choose the object handed on (Codex: one with an own byteLength of 1 over a megabyte of bytes)
function copyRange(buffer, offset, length) {
  const bytes = new Uint8Array(length)
  bytes.set(new Uint8Array(buffer, offset, length))
  return bytes.buffer
}

// a brand-checked copy of a script's ArrayBuffer or view: the intrinsic getters throw for anything that merely
// inherits from the prototypes, own properties a script added to a buffer or a view are never read, and none of the
// script's code runs
function copyBytes(value) {
  if (value === null || typeof value !== 'object') return null
  try {
    return copyRange(value, 0, bufferLength.call(value))
  } catch {
    // not an ArrayBuffer (or a detached one)
  }
  if (!ArrayBuffer.isView(value)) return null
  for (const getters of viewGetters) {
    try {
      return copyRange(getters.buffer.call(value), getters.byteOffset.call(value), getters.byteLength.call(value))
    } catch {
      // the other kind of view, or a detached/shared buffer
    }
  }
  return null
}

// A reader of a run that has ended (rebuild, crash, removal) never settles: not when it is called after the end,
// not when the read finishes after it (successfully or not), so a continuation of the old run cannot resume, even
// into the app's next run. `isDead` is the request's run check (App.fetch).
const PENDING = () => new Promise(() => {})
async function guarded(fn, isDead) {
  if (isDead?.()) return PENDING()
  let value
  try {
    value = await fn()
  } catch (err) {
    if (isDead?.()) return PENDING()
    throw toScriptError(err)
  }
  if (isDead?.()) return PENDING()
  return value
}

export function createScriptResponse(resp, isDead, owner = null) {
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    headers: Object.fromEntries(resp.headers.entries()),
    json: () => guarded(() => resp.json(), isDead),
    text: () => guarded(() => resp.text(), isDead),
    blob: () => guarded(async () => createScriptBlob(await resp.blob(), owner), isDead),
    arrayBuffer: () => guarded(() => resp.arrayBuffer(), isDead),
  }
}
