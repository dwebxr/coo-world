// The references a blueprint's model, script and image may hold, and the rules the server and the node agent
// apply before loading one. Pure (no Node modules): the browser's blueprint preflight uses it too.

export const ASSET_PROTOCOL = 'asset://'

// one file directly inside the asset store: a content hash name (<64 hex>.<ext>) or a built-in one (avatar.vrm).
// no separators, so no path; '.' and '..' are refused separately
const ASSET_NAME = /^[A-Za-z0-9._-]{1,128}$/

// the name in `asset://<name>`, or null for anything else (paths, traversal, encoded or query forms, other schemes)
export function assetName(url) {
  if (typeof url !== 'string' || !url.startsWith(ASSET_PROTOCOL)) return null
  const name = url.slice(ASSET_PROTOCOL.length)
  if (!ASSET_NAME.test(name) || name === '.' || name === '..') return null
  return name
}

// A reference as every loader reads it: World.resolveURL (clients, the node agent and the server's remote loads) and
// ServerLoader.locate take it without the white space around it. Anything that decides what a stored reference
// loads (the start-up clean-up) reads it through this too, so it sees what a loader would load.
export function loaderReference(value) {
  return typeof value === 'string' ? value.trim() : value
}

// The asset-store files a reference can make a loader read, as names (an empty list for anything else). After
// loaderReference, `asset://<name>` (the scheme in lower case, as both loaders test it) reads <name>; a client also
// reads it when a ?query or #hash follows, or when the name is percent-encoded (its fetch of <assets>/<name>?v=2 or
// <assets>/%61.glb is answered with that file), spellings the server's own loader refuses. Both the name as written
// and the decoded one are given, so a caller that keeps files keeps either.
export function referencedAssetNames(value) {
  const ref = loaderReference(value)
  if (typeof ref !== 'string' || !ref.startsWith(ASSET_PROTOCOL)) return []
  const written = ref.slice(ASSET_PROTOCOL.length).split(/[?#]/)[0]
  if (!written) return []
  let decoded = written
  try {
    decoded = decodeURIComponent(written)
  } catch {
    // not valid percent-encoding: a fetch sends it as it is
  }
  return decoded === written ? [written] : [written, decoded]
}

// an http(s) URL that parses, with the literal lower-case prefix the server's loader fetches as remote
export function isHttpURL(value) {
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// a model, script or image reference a blueprint may be given: an asset or an http(s) URL
export function isBlueprintURL(value) {
  return assetName(value) !== null || isHttpURL(value)
}

// a short, printable, quoted preview of an untrusted value for logs and errors (never the whole value)
export function previewValue(value, max = 24) {
  if (typeof value !== 'string') return `(${value === null ? 'null' : typeof value})`
  const head = value.slice(0, max).replace(/[^\x20-\x7e]/g, '?')
  return JSON.stringify(value.length > max ? `${head}...` : head)
}

// the error a refused reference raises: the reason and a short preview of the value
export function assetRefusal(reason, value) {
  const err = new Error(`asset refused (${reason}): ${previewValue(value)}`)
  err.code = 'ASSET_REFUSED'
  return err
}
