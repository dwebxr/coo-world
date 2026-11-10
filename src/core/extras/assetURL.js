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
  // the assets URL put in literally: as a replacement string, `$&`, `$'`, `` $` `` or `$$` in it would be patterns
  if (url.startsWith(ASSET_PROTOCOL)) return assetsUrl ? `${assetsUrl}${url.slice(ASSET_PROTOCOL.length - 1)}` : url
  if (url.match(/^https?:\/\//i)) return url
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('/')) return url
  return `https://${url}`
}

// a `.` or `..` path segment, with either separator the URL parser accepts for http(s)
const DOT_SEGMENT = /(?:^|[/\\])\.{1,2}(?:[/\\]|$)/

// Why an assets URL is not clean enough for the clean-up to tell where references go (null when it is): it must start
// with the literal lower-case http:// or https://, have no userinfo, `?`, `#`, backslash, dot segment, empty path
// segment or trailing slash, and be its own normalised form (the origin root written without its slash). Each of
// these makes a reference resolve elsewhere than the store, or fail: `https:/host/assets`, `https://host/assets?rev=1`
// (the name lands in the query), `https://host/a//assets` (another path than /a/assets), `https://host/assets/`
// (asset://x becomes …/assets//x), credentials. The clean-up does not run with them; index.js already refuses a
// trailing slash at start-up.
export function assetsUrlProblem(value) {
  if (typeof value !== 'string' || !value) return 'not set'
  if (!/^https?:\/\//.test(value)) return 'it does not start with a lower-case http:// or https://'
  if (/[?#]/.test(value)) return 'it has a query or a fragment'
  if (value.includes('\\')) return 'it has a backslash'
  if (DOT_SEGMENT.test(value)) return 'it has a dot segment'
  if (value.endsWith('/')) return 'it ends with a slash'
  let url
  try {
    url = new URL(value)
  } catch {
    return 'it does not parse'
  }
  if (url.username || url.password) return 'it has userinfo'
  if (url.pathname !== '/' && url.pathname.split('/').slice(1).includes('')) return 'it has an empty path segment'
  if (url.href !== value && url.href !== `${value}/`) return 'it is not in its normalised form'
  return null
}

// an assets URL's origin and path segments (exactly, none dropped), or null when it is not clean
function storeRoot(assetsUrl) {
  if (assetsUrlProblem(assetsUrl)) return null
  const url = new URL(assetsUrl)
  return { origin: url.origin, segments: url.pathname === '/' ? [] : url.pathname.split('/').slice(1) }
}

// Where a blueprint's script comes from, as far as the server can know it for certain (the start-up clean-up):
// - { source: 'none' }: no script: not a string, empty once trimmed, or a value starting with a lower-case `blob:`,
//   which resolveReference leaves as it is (what URL.createObjectURL returns: a browser tab's own object, which
//   nobody else can load). `Blob:x` or `blob/x` is not one: the runtime turns them into a request elsewhere;
// - { source: 'store', name }: a file of the asset store, only with a clean assets URL `assetsUrl` (assetsUrlProblem)
//   and only when the reference (trimmed, as the loaders take it) is the canonical asset://<name>, or an absolute URL
//   that the runtime sends to the store unchanged: it starts with the literal lower-case http:// or https:// that
//   both resolveReference and the server's loader (ServerLoader locate) take as remote, resolveReference returns it
//   as it is, it has no userinfo, its own text has no `?`, `#`, `%`, backslash or dot segment, and its parsed origin
//   and path segments are the assets URL's followed by one valid name. So the file the clean-up reads by that name is
//   the object the loaders fetch;
// - { source: 'unknown' }: anything else. Another origin; a page path such as /assets/x.js or blob/../assets/x.js,
//   which lands wherever the page is served from (a proxy can put another application there); anything the runtime
//   rewrites (`https:/host/x`, a tab inside the scheme and `HTTPS://` become other requests or none); a query, an
//   encoded name, a backslash or a dot segment; a string the URL parser refuses. The source that runs cannot be read
//   for certain.
export function scriptSource(value, assetsUrl) {
  const ref = loaderReference(value)
  if (typeof ref !== 'string' || !ref) return { source: 'none' }
  if (ref.startsWith('blob:')) return { source: 'none' }
  const unknown = { source: 'unknown' }
  const root = storeRoot(assetsUrl)
  if (!root) return unknown
  const canonical = assetName(ref)
  if (canonical) return { source: 'store', name: canonical }
  if (!/^https?:\/\//.test(ref)) return unknown
  if (resolveReference(ref, assetsUrl) !== ref || /[?#%\\]/.test(ref) || DOT_SEGMENT.test(ref)) return unknown
  let url
  try {
    url = new URL(ref)
  } catch {
    return unknown
  }
  if (url.username || url.password || url.origin !== root.origin) return unknown
  const segments = url.pathname.split('/').slice(1)
  if (segments.length !== root.segments.length + 1) return unknown
  if (root.segments.some((segment, i) => segments[i] !== segment)) return unknown
  const name = assetName(ASSET_PROTOCOL + segments[segments.length - 1])
  return name ? { source: 'store', name } : unknown
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
