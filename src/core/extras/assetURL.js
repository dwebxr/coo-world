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
