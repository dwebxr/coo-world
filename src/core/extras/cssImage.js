// The CSS value for a background image that world data names: a blueprint's image in the builder's Add pane, the
// world's image on every visitor's loading screen (a builder's setting).
//
// Both were written into a stylesheet as `background-image: url(${url})`, unquoted. A URL may hold `)`, `;` and `}`,
// so one of them ended the declaration and the rest of the value was read as CSS: rules for the whole page, written
// by whoever could set the image. Here the value is a string in double quotes with its closing characters escaped,
// only for an http(s) or blob URL, and the caller sets it on the element's own style (which holds one declaration's
// value and nothing else), not in a stylesheet. Anything else is `none`; nothing here throws in a render.
//
// `resolve` maps a reference to a URL (World.resolveURL); `base` is what a relative one is read against.
export function cssImage(resolve, value, base = globalThis.location?.href) {
  if (typeof value !== 'string' || !value) return 'none'
  let url
  try {
    url = new URL(resolve(value), base)
  } catch {
    return 'none'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'blob:') return 'none'
  // a parsed URL has no quote, backslash or control character left in most of its parts; whatever it has is escaped
  // as CSS asks inside a string (a backslash, the code point in hex, a space)
  const href = url.href.replace(/[^\x20-\x7e]|["\\]/g, char => `\\${char.codePointAt(0).toString(16)} `)
  return `url("${href}")`
}
