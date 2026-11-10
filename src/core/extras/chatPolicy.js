// Shared chat validation. Client-sent messages use the text-only sanitizer; producer envelopes also keep
// bounded metadata. The server stamps the id, sender identity and time on messages received from clients.
import { isPlainObject, sanitizeName } from './entityModifyPolicy.js'

export const CHAT_BODY_MAX_LENGTH = 500

const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter() : null

// `text` cut to at most `max` UTF-16 units without splitting a grapheme (an emoji with modifiers, a flag, a
// ZWJ family), or a surrogate pair where the runtime has no segmenter. the work is O(max) however long the
// text: a cluster that crosses `max` still crosses it in the slice, and cutting never moves a boundary earlier.
// the slice carries two extra units so a pair that starts at `max` is seen whole
export function cutText(text, max) {
  if (text.length <= max) return text
  if (segmenter) {
    let end = 0
    for (const { index, segment } of segmenter.segment(text.slice(0, max + 2))) {
      if (index + segment.length > max) break
      end = index + segment.length
    }
    if (end > 0) return text.slice(0, end)
  }
  // no segmenter, or a single cluster longer than max: cut at max, stepping back off a high surrogate
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

// `body` must be text: trimmed, cut to CHAT_BODY_MAX_LENGTH, non-empty. each property is read once, so the
// value checked is the value kept
export function sanitizeChatMessage(msg) {
  if (!isPlainObject(msg)) return null
  const body = msg.body
  if (typeof body !== 'string') return null
  const text = cutText(body.trim(), CHAT_BODY_MAX_LENGTH).trimEnd()
  if (!text) return null
  return { body: text }
}

// Who produced a message, assigned by the host, never by a script or a client packet:
// - player: a player's own chat (the server stamps it, with the sender's id and name, on every client packet)
// - app: a script's world.chat(); never carries a player id, names the app it came from
// - system: a line the server or this client wrote (command replies, notices)
// - tip: the server's confirmation of an on-chain tip
// A message without a kind (an older server) shows as a plain line and never as a system or tip line.
export const CHAT_KINDS = ['player', 'app', 'system', 'tip']
export const CHAT_APP_NAME_MAX_LENGTH = 64

export function chatEnvelope(msg) {
  if (!isPlainObject(msg)) return null
  const body = msg.body
  const safe = sanitizeChatMessage({ body: typeof body === 'number' ? String(body) : body })
  if (!safe) return null
  const kind = msg.kind
  if (CHAT_KINDS.includes(kind)) safe.kind = kind
  for (const key of ['id', 'fromId', 'createdAt']) {
    const value = msg[key]
    if (typeof value === 'string') safe[key] = cutText(value, 64)
  }
  // only a player's own message names a player
  if (safe.kind && safe.kind !== 'player') delete safe.fromId
  const from = sanitizeName(msg.from)
  if (from !== undefined) safe.from = from
  if (safe.kind === 'app') {
    const app = msg.app
    if (typeof app === 'string') safe.app = cutText(app, CHAT_APP_NAME_MAX_LENGTH)
  }
  return safe
}

// world.chat(msg) from a script: the script chooses the text and a display name (each read once); the host sets
// the rest, so a script cannot speak as a player (no fromId, no bubble, no per-player chat event) or as the
// server (kind is always 'app' and the message carries the app's name)
export function scriptChatMessage(msg, appName) {
  try {
    if (!isPlainObject(msg)) return null
  } catch {
    return null // a Proxy whose getPrototypeOf trap throws
  }
  let body
  let from
  try {
    body = msg.body
  } catch {
    return null
  }
  try {
    from = msg.from
  } catch {
    from = undefined
  }
  return appChatLine(body, from, appName)
}

// an app's chat line from values already read (a script's message, or an appChat packet relayed by the server)
export function appChatLine(body, from, appName) {
  const safe = sanitizeChatMessage({ body: typeof body === 'number' ? String(body) : body })
  if (!safe) return null
  const name = sanitizeName(from)
  return {
    kind: 'app',
    app: typeof appName === 'string' ? cutText(appName, CHAT_APP_NAME_MAX_LENGTH) : '',
    from: name === undefined ? null : name,
    fromId: null,
    body: safe.body,
  }
}
