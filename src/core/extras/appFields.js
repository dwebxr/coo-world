// app.configure(fields): the script's field list is copied into plain host objects through an explicit
// schema, and only the copy reaches the builder sidebar (Sidebar.js AppFields/AppField, Fields.js).
// Every script property is read once (a getter or Proxy trap cannot answer differently later), text becomes a
// host string (see scriptText.js), numbers must be numbers, `initial` and option values are JSON copies, and
// anything not listed below is dropped. A button's `onClick` stays a function: the sidebar calls it through
// callScript and never renders it.
import { jsonCopy, readOnce, toNumber, toText } from './scriptText.js'

export const FIELD_LIMIT = 256
export const FIELD_KEY_MAX = 64
const OPTION_LIMIT = 256
const RULE_LIMIT = 32
const LABEL_MAX = 256
const HINT_MAX = 1024
const SHORT_MAX = 64

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// these store nothing on props, so they may go without a key
const VALUELESS = new Set(['section', 'button'])
// `type: 'avatar'` etc. is shorthand for a file field of that kind
const FILE_SHORTCUTS = new Set(['avatar', 'emote', 'model', 'texture', 'image', 'video', 'hdr', 'audio'])

export function isFieldKey(key) {
  return typeof key === 'string' && key.length >= 1 && key.length <= FIELD_KEY_MAX && !FORBIDDEN_KEYS.has(key)
}

// a value a script may compare or store: primitives as they are, anything else as a JSON copy
function copyValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return jsonCopy(value)
}

function readList(value, limit, onTruncate) {
  if (!Array.isArray(value)) return []
  const length = readOnce(value, 'length')
  if (typeof length !== 'number' || !(length > 0)) return []
  if (length > limit) onTruncate?.()
  const items = []
  for (let i = 0; i < Math.min(length, limit); i++) items.push(readOnce(value, i))
  return items
}

function set(target, key, value) {
  if (value !== undefined) target[key] = value
}

function copyOptions(value) {
  return readList(value, OPTION_LIMIT).map(option => {
    const isObject = option !== null && typeof option === 'object'
    return {
      label: toText(isObject ? readOnce(option, 'label') : undefined, LABEL_MAX),
      value: copyValue(isObject ? readOnce(option, 'value') : undefined) ?? null,
    }
  })
}

function copyRules(value) {
  const rules = []
  for (const rule of readList(value, RULE_LIMIT)) {
    if (rule === null || typeof rule !== 'object') continue
    rules.push({
      op: toText(readOnce(rule, 'op'), SHORT_MAX),
      key: toText(readOnce(rule, 'key'), FIELD_KEY_MAX),
      value: copyValue(readOnce(rule, 'value')),
    })
  }
  return rules
}

function copyField(field, warn) {
  if (field === null || typeof field !== 'object') return null
  let type = readOnce(field, 'type')
  type = typeof type === 'string' ? toText(type, SHORT_MAX) : undefined
  let kind = readOnce(field, 'kind')
  if (FILE_SHORTCUTS.has(type)) {
    kind = type
    type = 'file'
  }
  const key = readOnce(field, 'key')
  const copy = { type }
  if (isFieldKey(key)) {
    copy.key = key
  } else if (!VALUELESS.has(type)) {
    warn(
      'key',
      '[app.configure] a field was dropped: its key must be a string of 1-64 characters other than __proto__, constructor or prototype'
    )
    return null
  }
  const label = readOnce(field, 'label')
  if (label !== undefined) copy.label = toText(label, LABEL_MAX)
  const hint = readOnce(field, 'hint')
  if (hint !== undefined) copy.hint = toText(hint, HINT_MAX)
  if (readOnce(field, 'hidden')) copy.hidden = true
  const when = readOnce(field, 'when')
  if (Array.isArray(when)) copy.when = copyRules(when)
  set(copy, 'initial', jsonCopy(readOnce(field, 'initial')))
  switch (copy.type) {
    case 'text':
    case 'textarea': {
      const placeholder = readOnce(field, 'placeholder')
      if (placeholder !== undefined) copy.placeholder = toText(placeholder, LABEL_MAX)
      break
    }
    case 'number': {
      const dp = toNumber(readOnce(field, 'dp'), undefined)
      // toFixed accepts 0..100 digits
      if (dp !== undefined && dp >= 0 && dp <= 100) copy.dp = Math.trunc(dp)
      set(copy, 'min', toNumber(readOnce(field, 'min'), undefined, true))
      set(copy, 'max', toNumber(readOnce(field, 'max'), undefined, true))
      set(copy, 'step', toNumber(readOnce(field, 'step'), undefined))
      set(copy, 'bigStep', toNumber(readOnce(field, 'bigStep'), undefined))
      break
    }
    case 'range':
      set(copy, 'min', toNumber(readOnce(field, 'min'), undefined))
      set(copy, 'max', toNumber(readOnce(field, 'max'), undefined))
      set(copy, 'step', toNumber(readOnce(field, 'step'), undefined))
      break
    case 'curve':
      set(copy, 'yMin', toNumber(readOnce(field, 'yMin'), undefined))
      set(copy, 'yMax', toNumber(readOnce(field, 'yMax'), undefined))
      break
    case 'file':
      copy.kind = toText(kind, SHORT_MAX)
      break
    case 'switch':
    case 'dropdown':
      copy.options = copyOptions(readOnce(field, 'options'))
      break
    case 'toggle': {
      const trueLabel = readOnce(field, 'trueLabel')
      const falseLabel = readOnce(field, 'falseLabel')
      if (trueLabel !== undefined) copy.trueLabel = toText(trueLabel, SHORT_MAX)
      if (falseLabel !== undefined) copy.falseLabel = toText(falseLabel, SHORT_MAX)
      break
    }
    case 'button': {
      const onClick = readOnce(field, 'onClick')
      if (typeof onClick === 'function') copy.onClick = onClick
      break
    }
  }
  return copy
}

// `warn(reason, message)` reports a dropped field or a truncated list (the caller says it once per app run)
export function copyFields(value, warn = () => {}) {
  const fields = []
  const list = readList(value, FIELD_LIMIT, () =>
    warn('limit', `[app.configure] only the first ${FIELD_LIMIT} fields are shown`)
  )
  for (const field of list) {
    const copy = copyField(field, warn)
    if (copy) fields.push(copy)
  }
  return fields
}

// `initial` applies to a key the props do not hold as their own value
export function applyInitials(fields, props) {
  for (const field of fields) {
    if (field.initial === undefined || typeof field.key !== 'string') continue
    if (!Object.prototype.hasOwnProperty.call(props, field.key) || props[field.key] === undefined) {
      props[field.key] = jsonCopy(field.initial)
    }
  }
  return props
}

// what the sidebar shows and exports for an app: a copy of the blueprint's props, with each field's `initial`
// standing in for a key the blueprint does not set (the rule configure applies to the app's own props copy)
export function fieldValues(fields, props) {
  return applyInitials(fields || [], props && typeof props === 'object' ? { ...props } : {})
}

// the props object an app instance's script works with: its own JSON copy of the blueprint's props, so a script
// that changes it changes nothing another instance, the snapshot or the sidebar sees
export function copyProps(props) {
  const copy = props && typeof props === 'object' && !Array.isArray(props) ? jsonCopy(props) : undefined
  return copy && typeof copy === 'object' ? copy : {}
}
