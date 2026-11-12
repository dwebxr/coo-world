// URL policy for world.open().
//
// Only http(s) documents are opened. Scheme URLs (javascript:, data:, blob:, file:, ...) never
// navigate, and neither does anything served from the world's own assets store, since an uploaded
// file must not become a top-level document through the script API.

const OPEN_PROTOCOLS = ['http:', 'https:']

function parseURL(value, base) {
  try {
    return new URL(value, base)
  } catch {
    return null
  }
}

// The asset route matches the request path after percent-decoding, so the policy compares decoded,
// dot-resolved paths (case-sensitive, like the static file server). Encodings the server and the policy
// could read differently are rejected outright: an encoded separator (%2F, %5C) or a double encoding (%25).
function normalizePath(pathname) {
  if (/%(2f|5c|25)/i.test(pathname)) return null
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('%')) return null
  const segments = []
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

function isUnderPrefix(path, prefix) {
  const root = prefix.replace(/\/+$/, '')
  return path === root || path.startsWith(`${root}/`)
}

function isAssetURL(target, base, assetsUrl) {
  const page = base ? parseURL(base) : null
  const assets = assetsUrl ? parseURL(assetsUrl, base) : null
  const onPageOrigin = !!page && target.origin === page.origin
  const onAssetsOrigin = !!assets && target.origin === assets.origin
  if (!onPageOrigin && !onAssetsOrigin) return false
  const path = normalizePath(target.pathname)
  // an ambiguous encoding on an origin that serves assets is refused rather than guessed
  if (path === null) return true
  if (onPageOrigin && isUnderPrefix(path, '/assets')) return true
  if (onAssetsOrigin) {
    const prefix = normalizePath(assets.pathname)
    if (prefix === null || isUnderPrefix(path, prefix)) return true
  }
  return false
}

// returns the absolute http(s) href to open, or null when the URL is not allowed
// - resolve: the world's own URL resolution (asset:// and bare hosts), applied as before
// - base: the current document URL; assetsUrl: the configured assets base URL
export function resolveOpenURL(url, { resolve, base, assetsUrl } = {}) {
  if (typeof url !== 'string') return null
  const raw = url.trim()
  if (!raw) return null
  // an explicit scheme other than http(s) or asset: is rejected before any resolution
  const explicit = parseURL(raw)
  if (explicit && explicit.protocol !== 'asset:' && !OPEN_PROTOCOLS.includes(explicit.protocol)) return null
  const resolved = resolve ? resolve(raw) : raw
  if (typeof resolved !== 'string') return null
  const target = parseURL(resolved, base)
  if (!target || !OPEN_PROTOCOLS.includes(target.protocol)) return null
  // `https://this-world.example@other.example/` reads as this world and goes to the other host
  if (target.username || target.password) return null
  if (isAssetURL(target, base, assetsUrl)) return null
  return target.href
}

// What the visitor is shown before a script's link leaves the world's origin (scheme, host and port of the page).
// `host` and `href` come from the URL parser: the host is lower case with international names in their ASCII
// (xn--) form, and everything else that is not ASCII is percent-encoded, so neither can carry a look-alike letter
// or a character that reorders the text. A long address is cut in what is shown, never in what is opened.
export const OPEN_SHOWN_MAX = 300

export function describeOpenURL(href, base) {
  const target = parseURL(href)
  const page = base ? parseURL(base) : null
  if (!target || !OPEN_PROTOCOLS.includes(target.protocol)) return null
  return {
    href: target.href,
    host: target.host,
    shown: target.href.length > OPEN_SHOWN_MAX ? `${target.href.slice(0, OPEN_SHOWN_MAX)}…` : target.href,
    // a page this cannot place (no base) is treated as another site
    external: !page || page.origin === 'null' || target.origin !== page.origin,
  }
}

// The Open button of that question works only after the question has been on screen, untouched, for a moment: a
// press before that is not an answer, and starts the moment again. A visitor who is clicking fast where the button
// appears (a script can time the question, and can draw where it will appear) does not answer it by those clicks.
// This is a hurdle against an accidental answer, not a judgement of the page that is opened.
export const OPEN_ARM_MS = 1000

export function createOpenGuard(now, delayMs = OPEN_ARM_MS) {
  let since = now
  return {
    armed: at => at - since >= delayMs,
    // true when this press is an answer; false when it came too soon (and the wait starts over)
    press(at) {
      if (at - since >= delayMs) return true
      since = at
      return false
    },
    // ms until the button works, as of `at`
    remaining: at => Math.max(0, delayMs - (at - since)),
  }
}
