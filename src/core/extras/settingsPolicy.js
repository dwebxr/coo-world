// Server-side validation of client-sent world settings. Pure: no world, no sockets.
import { Ranks } from './ranks.js'

export const BUILDER_SETTING_KEYS = new Set(['title', 'desc', 'image', 'avatar', 'voice', 'playerLimit', 'ao'])
export const ADMIN_SETTING_KEYS = new Set(['rank', 'customAvatars'])

const TITLE_MAX_LENGTH = 256
const DESC_MAX_LENGTH = 2048
const FILE_TYPE_MAX_LENGTH = 32
const FILE_NAME_MAX_LENGTH = 256
const FILE_URL_MAX_LENGTH = 2048

const voices = ['disabled', 'spatial', 'global']

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const reject = () => ({ ok: false })
const accept = value => ({ ok: true, value, changed: false })

// null or a string, truncated to the cap (the UI has no input length limit)
function nullOrText(value, maxLength) {
  if (value === null) return accept(null)
  if (typeof value !== 'string') return reject()
  const text = value.slice(0, maxLength)
  return { ok: true, value: text, changed: text !== value }
}

// a fresh `{ type, name, url }` record from a FieldFile value, so only bounded strings are stored
function nullOrFile(value) {
  if (value === null) return accept(null)
  if (!isPlainObject(value) || typeof value.url !== 'string') return reject()
  const record = {
    type: typeof value.type === 'string' ? value.type.slice(0, FILE_TYPE_MAX_LENGTH) : null,
    name: typeof value.name === 'string' ? value.name.slice(0, FILE_NAME_MAX_LENGTH) : null,
    url: value.url.slice(0, FILE_URL_MAX_LENGTH),
  }
  const same =
    Object.keys(value).length === 3 &&
    value.type === record.type &&
    value.name === record.name &&
    value.url === record.url
  return { ok: true, value: record, changed: !same }
}

export function isKnownSettingKey(key) {
  return BUILDER_SETTING_KEYS.has(key) || ADMIN_SETTING_KEYS.has(key)
}

export function isAdminOnlySettingKey(key) {
  return ADMIN_SETTING_KEYS.has(key)
}

// returns { ok, value, changed }: the value to store (a fresh, bounded copy for text and file
// records) and whether it differs from what the client sent, so the sender can be corrected
export function normalizeSettingValue(key, value) {
  switch (key) {
    case 'title':
      return nullOrText(value, TITLE_MAX_LENGTH)
    case 'desc':
      return nullOrText(value, DESC_MAX_LENGTH)
    case 'image':
    case 'avatar':
      return nullOrFile(value)
    case 'voice':
      return voices.includes(value) ? accept(value) : reject()
    case 'playerLimit':
      return value === null || Number.isInteger(value) ? accept(value) : reject() // <= 0 means unlimited
    case 'ao':
    case 'customAvatars':
      return typeof value === 'boolean' ? accept(value) : reject()
    case 'rank':
      // free build toggles everyone between visitor and builder, never admin
      return value === Ranks.VISITOR || value === Ranks.BUILDER ? accept(value) : reject()
    default:
      return reject()
  }
}
