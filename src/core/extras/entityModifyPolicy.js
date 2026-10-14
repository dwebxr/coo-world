// Server-side validation of client-sent entity mutations. Pure: no world, no sockets.
// Each sanitizer returns a new object holding only the permitted, well-formed fields
// (plus `id`), or null when nothing usable remains.

const NAME_MAX_LENGTH = 64
const JSON_MAX_BYTES = 8 * 1024
const JSON_MAX_DEPTH = 16
const JSON_MAX_ITEMS = 1024

const encoder = new TextEncoder()

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isFiniteArray(value, length) {
  if (!Array.isArray(value) || value.length !== length) return false
  for (let i = 0; i < length; i++) {
    if (!Number.isFinite(value[i])) return false
  }
  return true
}

function isOptionalString(value) {
  return value === undefined || value === null || typeof value === 'string'
}

// structural check of a tree made only of plain objects with string keys, arrays, strings,
// finite numbers, booleans and null, within depth and item limits. `state.chars` accumulates
// string and key characters: each is at least one serialized byte, so going over the byte
// budget here rejects early and keeps the final stringify small
function isJsonTree(value, depth, state) {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
      state.chars += value.length
      return state.chars <= JSON_MAX_BYTES
    case 'number':
      return Number.isFinite(value)
    case 'boolean':
      return true
    case 'object':
      break
    default:
      return false
  }
  if (depth >= JSON_MAX_DEPTH) return false
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    for (let i = 0; i < value.length; i++) {
      if (++state.items > JSON_MAX_ITEMS) return false
      if (!isJsonTree(value[i], depth + 1, state)) return false
    }
    return true
  }
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length) return false
  for (const key of Object.keys(value)) {
    if (++state.items > JSON_MAX_ITEMS) return false
    state.chars += key.length
    if (state.chars > JSON_MAX_BYTES) return false
    if (!isJsonTree(value[key], depth + 1, state)) return false
  }
  return true
}

// a plain object holding only json values whose exact serialized size (utf-8 bytes of its
// JSON, escapes included) stays within budget. this is what gets retained, persisted and
// rebroadcast, so the retained value is what is bounded
export function isBoundedJsonObject(value) {
  if (!isPlainObject(value)) return false
  if (!isJsonTree(value, 0, { items: 0, chars: 0 })) return false
  try {
    return encoder.encode(JSON.stringify(value)).length <= JSON_MAX_BYTES
  } catch (err) {
    return false
  }
}

export function sanitizeName(value) {
  if (typeof value !== 'string') return undefined
  return value.slice(0, NAME_MAX_LENGTH)
}

// fields the owning socket may change on its own player.
// rank, health, owner and userId are server-controlled and never copied.
export function sanitizePlayerSelfModify(data, socketId, { allowAvatar = false } = {}) {
  if (!isPlainObject(data)) return null
  const safe = { id: socketId }
  if (isFiniteArray(data.p, 3)) safe.p = data.p
  if (isFiniteArray(data.q, 4)) safe.q = data.q
  if (Number.isFinite(data.m)) safe.m = data.m
  if (isFiniteArray(data.a, 3)) safe.a = data.a
  if (isFiniteArray(data.g, 3)) safe.g = data.g
  if (has(data, 'e') && isOptionalString(data.e)) safe.e = data.e // undefined clears the emote
  if (has(data, 'ef') && (data.ef === null || isBoundedJsonObject(data.ef))) safe.ef = data.ef
  if (data.t === true) safe.t = true
  if (has(data, 'name')) {
    const name = sanitizeName(data.name)
    if (name !== undefined) safe.name = name
  }
  if (has(data, 'sessionAvatar') && isOptionalString(data.sessionAvatar)) safe.sessionAvatar = data.sessionAvatar
  if (allowAvatar && typeof data.avatar === 'string') safe.avatar = data.avatar
  return Object.keys(safe).length > 1 ? safe : null
}

// fields a builder may change on an app
export function sanitizeAppModify(data, socketId, { blueprintExists } = {}) {
  if (!isPlainObject(data)) return null
  const safe = { id: data.id }
  const isOwnerOrNull = value => value === null || value === socketId
  if (typeof data.blueprint === 'string' && data.blueprint) {
    if (!blueprintExists || blueprintExists(data.blueprint)) safe.blueprint = data.blueprint
  }
  if (isOwnerOrNull(data.uploader)) safe.uploader = data.uploader
  if (isOwnerOrNull(data.mover)) safe.mover = data.mover
  if (isFiniteArray(data.position, 3)) safe.position = data.position
  if (isFiniteArray(data.quaternion, 4)) safe.quaternion = data.quaternion
  if (isFiniteArray(data.scale, 3)) safe.scale = data.scale
  if (typeof data.pinned === 'boolean') safe.pinned = data.pinned
  if (has(data, 'state') && (data.state === null || isBoundedJsonObject(data.state))) safe.state = data.state
  return Object.keys(safe).length > 1 ? safe : null
}

// a sender that is no longer a builder may only finish or cancel its own move and/or upload:
// `mover`/`uploader` may be cleared, transforms still apply while it is the mover, and state is
// reset (only together with mover: null). both releases combine when the sender holds both.
export function sanitizeAppRelease(data, { mover = false, uploader = false } = {}) {
  if (!isPlainObject(data)) return null
  const safe = { id: data.id }
  if (mover) {
    if (data.mover === null) safe.mover = null
    if (isFiniteArray(data.position, 3)) safe.position = data.position
    if (isFiniteArray(data.quaternion, 4)) safe.quaternion = data.quaternion
    if (isFiniteArray(data.scale, 3)) safe.scale = data.scale
    if (has(data, 'state') && safe.mover === null) safe.state = {}
  }
  if (uploader && data.uploader === null) safe.uploader = null
  return Object.keys(safe).length > 1 ? safe : null
}

// a new app entity. structural fields are required; the fields an undo re-add may carry
// stale (mover, uploader, pinned, state) are coerced instead of rejected.
export function sanitizeEntityAdd(data, socketId, { blueprintExists, entityExists } = {}) {
  if (!isPlainObject(data)) return null
  if (data.type !== 'app') return null
  if (typeof data.id !== 'string' || !data.id || (entityExists && entityExists(data.id))) return null
  if (typeof data.blueprint !== 'string' || (blueprintExists && !blueprintExists(data.blueprint))) return null
  if (!isFiniteArray(data.position, 3) || !isFiniteArray(data.quaternion, 4) || !isFiniteArray(data.scale, 3)) {
    return null
  }
  const isOwnerOrNull = value => value === null || value === socketId
  return {
    id: data.id,
    type: 'app',
    blueprint: data.blueprint,
    position: data.position,
    quaternion: data.quaternion,
    scale: data.scale,
    mover: isOwnerOrNull(data.mover) ? data.mover : null,
    uploader: isOwnerOrNull(data.uploader) ? data.uploader : null,
    pinned: data.pinned === true,
    state: isBoundedJsonObject(data.state) ? data.state : {},
  }
}
