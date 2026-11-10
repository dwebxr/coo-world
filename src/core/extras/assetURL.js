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

// The world's page, as a stand-in: the server serves it at the root of its origin (index.js), and only where a
// browser resolves a path against it matters here, not its real host.
const PAGE = 'https://page.invalid/'
const PAGE_ORIGIN = new URL(PAGE).origin

// Where the world's asset store is read from (`store`: { assetsUrl, servesStore }): the assets URL, and the page's
// own /assets/ when this server serves the store there (ASSETS=local, index.js assetRoutes)
function storeRoots({ assetsUrl, servesStore }) {
  const roots = []
  for (const base of [assetsUrl, servesStore ? `${PAGE}assets` : null]) {
    if (typeof base !== 'string' || !base) continue
    try {
      roots.push(new URL(base.endsWith('/') ? base : `${base}/`))
    } catch {
      // an assets URL that does not parse holds no store a browser can reach
    }
  }
  return roots
}

// the store file a parsed URL reads: one valid name directly inside a root (decoded, as the static route and S3
// decode it; a ?query and #hash are not part of the file), or null
function storeFile(target, roots) {
  for (const root of roots) {
    if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname)) continue
    const rest = target.pathname.slice(root.pathname.length)
    if (rest.includes('/')) continue
    try {
      const name = assetName(ASSET_PROTOCOL + decodeURIComponent(rest))
      if (name) return name
    } catch {
      // not valid percent-encoding: no file of the store
    }
  }
  return null
}

// What a stored reference loads, decided the way the runtime resolves it (resolveReference, then a browser's URL
// resolution against the world's page), never by a prefix test of its own:
// - { source: 'none' }: nothing persistent: no reference (not a string, or empty once trimmed), or a URL whose
//   scheme parses as blob: (a browser tab's own object, which nobody else can load);
// - { source: 'store', name }: a file of this world's asset store (asset://<name>, also with a ?query, #hash,
//   percent-encoding or `..` that resolves into it; the assets URL written out; a page path into /assets/ when this
//   server serves the store, `blob/../assets/<name>` included);
// - { source: 'external' }: anything else (another host, another path of the page's server, a scheme the browser
//   fetches elsewhere), and anything the URL parser refuses: what it loads cannot be told for certain.
export function classifyReference(value, store) {
  const ref = loaderReference(value)
  if (typeof ref !== 'string' || !ref) return { source: 'none' }
  let target
  try {
    target = new URL(resolveReference(ref, store.assetsUrl), PAGE)
  } catch {
    return { source: 'external' }
  }
  if (target.protocol === 'blob:') return { source: 'none' }
  const name = storeFile(target, storeRoots(store))
  return name ? { source: 'store', name } : { source: 'external' }
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Every store file a text names (a stored value, a script's source), for keeping: the literals that would resolve
// into the store (asset://<name>, the assets URL written out, and /assets/<name> when this server serves the store),
// each name as written and decoded, with and without trailing dots (a name ending a sentence). The prefixes match in
// any case (a URL's scheme and host have none). Keep-more: a name that is no store file keeps nothing. A name built
// at run time cannot be found this way.
export function storeLiteralNames(text, store) {
  const anchors = [ASSET_PROTOCOL]
  for (const root of storeRoots(store)) anchors.push(root.origin === PAGE_ORIGIN ? root.pathname : root.href)
  const pattern = new RegExp(`(?:${anchors.map(escapeRegExp).join('|')})([A-Za-z0-9._%-]{1,384})`, 'gi')
  const names = new Set()
  for (const [, literal] of text.matchAll(pattern)) {
    let decoded = literal
    try {
      decoded = decodeURIComponent(literal)
    } catch {
      // not valid percent-encoding: kept as written
    }
    for (const name of [literal, decoded]) {
      names.add(name)
      const trimmed = name.replace(/\.+$/, '')
      if (trimmed) names.add(trimmed)
    }
  }
  return names
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
