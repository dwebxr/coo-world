// Script-safe blobs.
//
// fetch().blob() hands scripts a frozen facade over the bytes instead of a host Blob, so no Web API
// prototype (Blob, ReadableStream, ...) is reachable from a script. The host side of a facade (bytes and
// the type the host saw on the response) lives in a module-private WeakMap, which is also how
// URL.createObjectURL tells a facade from any other object a script may pass.

import { toScriptError } from './scriptValues.js'
import { stoppedError } from './physicsFailure.js'
import { Teardown, tornDown } from './runTeardown.js'

// object URLs minted for scripts only ever carry one of these types; anything else is served as opaque bytes
const SAFE_BLOB_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/ktx2',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'model/gltf-binary',
  'model/gltf+json',
])
const OPAQUE_TYPE = 'application/octet-stream'

const facades = new WeakMap() // facade -> { buffer, type, owner }
// Object URLs are owned by the app run whose fetch made the blob: refused once that run has ended (or its object-URL
// teardown stage has started), revoked when it ends, at most OBJECT_URL_LIMIT live ones per run
export const OBJECT_URL_LIMIT = 256
const urlOwners = new Map() // url minted for a script -> its run
const runURLs = new WeakMap() // run -> Set(url)

export function safeBlobType(type) {
  const essence = String(type ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return SAFE_BLOB_TYPES.has(essence) ? essence : OPAQUE_TYPE
}

// the whole body is read once, up front; the facade keeps that copy for its lifetime. `owner` is the app run whose
// fetch read it ({ entity, run }; App.fetchFor)
export async function createScriptBlob(hostBlob, owner = null) {
  let buffer
  try {
    buffer = await hostBlob.arrayBuffer()
  } catch (err) {
    throw toScriptError(err)
  }
  const type = typeof hostBlob.type === 'string' ? hostBlob.type : ''
  return createFacade(buffer, type, owner)
}

// Blob.slice() index rules: negative values count from the end, everything is clamped to the size
function clampIndex(value, size, fallback) {
  if (value === undefined) return fallback
  const n = Math.trunc(Number(value)) || 0
  return n < 0 ? Math.max(size + n, 0) : Math.min(n, size)
}

function createFacade(buffer, type, owner) {
  const size = buffer.byteLength
  const facade = {
    size,
    type,
    arrayBuffer: async () => buffer.slice(0),
    text: async () => new TextDecoder().decode(buffer),
    // a script cannot choose the type of a slice; it keeps the type the host saw
    slice: (start, end) => {
      const from = clampIndex(start, size, 0)
      const to = Math.max(clampIndex(end, size, size), from)
      return createFacade(buffer.slice(from, to), type, owner)
    },
  }
  facades.set(facade, { buffer, type, owner })
  return Object.freeze(facade)
}

export function isScriptBlob(value) {
  return facades.has(value)
}

// a fresh host Blob with the facade's bytes and host type (request bodies)
export function toHostBlob(value) {
  const entry = facades.get(value)
  if (!entry) throw new TypeError('expected a blob returned by fetch()')
  return new Blob([entry.buffer], { type: entry.type })
}

// the URL.createObjectURL endowment: facades only, with the type forced through the allowlist
export function createScriptObjectURL(value) {
  const entry = facades.get(value)
  if (!entry) throw new TypeError('URL.createObjectURL expects a blob returned by fetch()')
  const { owner } = entry
  let urls = null
  if (owner?.run) {
    const { entity, run } = owner
    if (run !== entity.deadHook || run.dead || tornDown(run, Teardown.OBJECT_URLS)) throw stoppedError(entity)
    urls = runURLs.get(run)
    if (!urls) runURLs.set(run, (urls = new Set()))
    if (urls.size >= OBJECT_URL_LIMIT) {
      throw new Error(
        `[app] URL.createObjectURL: more than ${OBJECT_URL_LIMIT} object URLs (revoke the ones you are done with)`
      )
    }
  }
  const url = URL.createObjectURL(new Blob([entry.buffer], { type: safeBlobType(entry.type) }))
  if (urls) {
    urls.add(url)
    urlOwners.set(url, owner.run)
  }
  return url
}

// the URL.revokeObjectURL endowment: only a URL minted for a script (never one the engine made)
export function revokeScriptObjectURL(url) {
  if (typeof url !== 'string') return
  const run = urlOwners.get(url)
  if (!run) return
  urlOwners.delete(url)
  runURLs.get(run)?.delete(url)
  URL.revokeObjectURL(url)
}

// App.unbuild: every object URL the run made goes with it
export function revokeRunObjectURLs(run) {
  const urls = runURLs.get(run)
  if (!urls) return
  runURLs.delete(run)
  for (const url of urls) {
    urlOwners.delete(url)
    URL.revokeObjectURL(url)
  }
}
