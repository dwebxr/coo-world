import { cutText } from './chatPolicy.js'
import { isPlainObject } from './entityModifyPolicy.js'
import { isBlueprintURL } from './assetURL.js'

export const WORLD_BLUEPRINT_BYTES = 512 * 1024

const textLimits = { name: 256, desc: 4096, author: 256, url: 2048, model: 2048, script: 2048 }
const flags = new Set(['preload', 'public', 'locked', 'frozen', 'unique', 'scene', 'disabled'])
const fields = new Set(['id', 'version', ...Object.keys(textLimits), ...flags, 'image', 'props'])
const nullable = new Set([...Object.keys(textLimits), 'image', 'props'])
// fields the loaders dereference: when set, an asset://<name> or an http(s) URL (assetURL.js)
const references = new Set(['model', 'script'])
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

// A reference is checked only where it is being set. A persisted record keeps what it holds (the server's loader
// refuses what it must, and start-up reports it), and a modify that repeats the stored value sets nothing new.
function referenceAllowed(value, stored, persisted) {
  return value === null || persisted || value === stored || isBlueprintURL(value)
}

// Count values and keys, copying only JSON values. Undefined follows JSON semantics; strings stay whole.
function walk(value, depth, state) {
  if (++state.items > 8192 || depth > 16) throw new Error('json limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const array = Array.isArray(value)
  if (!array && !isPlainObject(value)) throw new Error('json value')
  if (Object.getOwnPropertySymbols(value).length) throw new Error('json key')
  const result = array ? [] : {}
  const keys = array ? Array.prototype.keys.call(value) : Object.keys(value)
  for (const key of keys) {
    let item = value[key]
    if (item === undefined) {
      state.changed = true
      if (!array) continue
      item = null
    }
    if (!array && ++state.items > 8192) throw new Error('json limit')
    const copy = walk(item, depth + 1, state)
    if (array) result.push(copy)
    else Object.defineProperty(result, key, { value: copy, enumerable: true, writable: true, configurable: true })
  }
  return result
}

function sanitize(data, add, { onUnknownKey, current, persisted = false } = {}) {
  const reject = () => ({ ok: false, value: null, changed: false })
  try {
    if (!isPlainObject(data)) return reject()
    // the stored blueprint a modify applies to (its values pass unchanged), never consulted for an add
    const stored = !add && isPlainObject(current) ? current : null
    const storedValue = key => (stored && has(stored, key) ? stored[key] : undefined)
    const value = {}
    const state = { items: 0, changed: false }
    for (const key of Object.keys(data)) {
      if (!fields.has(key)) {
        // The caller owns per-socket deduplication; the pure policy reports only an escaped, bounded name.
        onUnknownKey?.(JSON.stringify(cutText(key, 32)))
        state.changed = true
        continue
      }
      const item = data[key]
      if (item === undefined || (item === null && !nullable.has(key))) {
        state.changed = true
        continue
      }
      if (key === 'id') {
        if (typeof item !== 'string' || !item.length || item.length > 64) return reject()
        value[key] = item
      } else if (key === 'version') {
        if (!Number.isSafeInteger(item) || item < 0) return reject()
        value[key] = item
      } else if (flags.has(key)) {
        if (typeof item !== 'boolean') return reject()
        value[key] = item
      } else if (key === 'image' || key === 'props') {
        if (item !== null && !isPlainObject(item)) return reject()
        value[key] = walk(item, 1, state)
        if (key === 'image' && value.image !== null && has(value.image, 'url')) {
          const storedImage = storedValue('image')
          const storedUrl = isPlainObject(storedImage) && has(storedImage, 'url') ? storedImage.url : undefined
          if (!referenceAllowed(value.image.url, storedUrl, persisted)) return reject()
        }
      } else {
        if (item !== null && typeof item !== 'string') return reject()
        value[key] = item === null ? null : cutText(item, textLimits[key])
        if (value[key] !== item) state.changed = true
        if (references.has(key) && !referenceAllowed(value[key], storedValue(key), persisted)) return reject()
      }
    }
    if (add && (!has(value, 'id') || !has(value, 'version'))) return reject()
    return { ok: true, value, changed: state.changed }
  } catch (_err) {
    return reject()
  }
}

export function sanitizeBlueprintAdd(data, options) {
  return sanitize(data, true, options)
}

export function sanitizeBlueprintModify(data, options) {
  return sanitize(data, false, options)
}
