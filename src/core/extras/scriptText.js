// Values that reach host UI (React children, DOM attributes, canvas text) from scripts, blueprints or other
// clients. The host renders only primitives it made itself: a string or a number becomes a string cut to `max`
// (whole graphemes, see cutText), anything else becomes ''. Boxed strings, objects shaped like React elements,
// Proxies and objects with their own toString/valueOf are never converted, so no script code runs here and no
// script object reaches a renderer.
import { cutText } from './chatPolicy.js'

export const TEXT_MAX = 256

export function toText(value, max = TEXT_MAX) {
  let text
  if (typeof value === 'string') text = value
  else if (typeof value === 'number') text = String(value)
  else return ''
  return cutText(text, max)
}

// a finite number, or `fallback`; `allowInfinite` also keeps ±Infinity (open bounds such as min/max)
export function toNumber(value, fallback, allowInfinite = false) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  if (!allowInfinite && !Number.isFinite(value)) return fallback
  return value
}

// one read of `object[key]`; a getter or Proxy trap that throws reads as undefined
export function readOnce(object, key) {
  try {
    return object[key]
  } catch {
    return undefined
  }
}

// a JSON copy made by the host (functions, symbols and accessors' later answers do not survive), or undefined
// when the value cannot be serialized (cycles, BigInt, a throwing toJSON or getter)
export function jsonCopy(value) {
  if (value === undefined) return undefined
  try {
    const text = JSON.stringify(value)
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}
