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

// Where a reference points, as World.resolveURL maps it (it calls this): after loaderReference, a value starting
// with `blob` and a path are left for the browser to resolve against the page, asset://<x> goes under the assets
// URL, an http(s) URL stays as it is, and `//host/x` and any other string become https://… . A falsy value is
// returned as it is; another value that is not a string throws, as it always has.
export function resolveReference(url, assetsUrl) {
  if (!url) return url
  url = loaderReference(url)
  if (url.startsWith('blob')) return url
  if (url.startsWith(ASSET_PROTOCOL)) return assetsUrl ? url.replace('asset:/', assetsUrl) : url
  if (url.match(/^https?:\/\//i)) return url
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('/')) return url
  return `https://${url}`
}

// an absolute http(s) URL: a protocol-relative (`//host/x`) or relative one resolves against a page the server
// does not know
export function isAbsoluteHttpURL(value) {
  if (typeof value !== 'string') return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// Where a blueprint's script comes from, as far as the server can know it for certain (the start-up clean-up):
// - { source: 'none' }: no script (not a string, empty once trimmed) or a URL whose scheme parses as blob: (a
//   browser tab's own object, which nobody else can load);
// - { source: 'store', name }: a file of the asset store, only when the reference (trimmed, as the loaders take it)
//   is the canonical asset://<name> or an absolute URL directly under the absolute assets URL `assetsUrl` (one valid
//   name, no ?query, #hash or percent-encoding);
// - { source: 'unknown' }: anything else. Another origin; a page path such as /assets/x.js or blob/../assets/x.js,
//   which lands wherever the page is served from (a proxy can put another application there); a query, an encoded
//   name or a `..`; a string that does not parse. The source that runs cannot be read for certain.
export function scriptSource(value, assetsUrl) {
  const ref = loaderReference(value)
  if (typeof ref !== 'string' || !ref) return { source: 'none' }
  const canonical = assetName(ref)
  if (canonical) return { source: 'store', name: canonical }
  let url
  try {
    url = new URL(ref)
  } catch {
    return { source: 'unknown' }
  }
  if (url.protocol === 'blob:') return { source: 'none' }
  if (!isAbsoluteHttpURL(assetsUrl) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return { source: 'unknown' }
  }
  const root = new URL(assetsUrl.endsWith('/') ? assetsUrl : `${assetsUrl}/`)
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.search || url.hash) {
    return { source: 'unknown' }
  }
  const name = assetName(ASSET_PROTOCOL + url.pathname.slice(root.pathname.length))
  return name ? { source: 'store', name } : { source: 'unknown' }
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
