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
// - app: a script's world.chat(), or what a connection sent as one (appChat); never carries a player id; names the
//   app it was posted under (a relayed line: the name of that app's blueprint record when the server relayed it).
//   Only an app line has `via`, and only one the server relayed from a visitor's connection (appChat, which a
//   client script's broadcast sends): the server sets it on every such line (ServerNetwork.onAppChat), from the
//   connection, to the id and the name that visitor's player has on the server, never from the packet; the
//   sender's own client sets the same on its own copy of a broadcast (Apps.js chat). A server script's line has
//   none. It is an attribution, not an authentication: it says whose connection relayed the line, not what wrote
//   it (a modified client can send any text under any app's name), and the name is the one that visitor chose, as
//   on their own chat lines
// - system: a line the server or this client wrote (command replies, notices)
// - tip: the server's confirmation of an on-chain tip
// A message without a kind (an older server) shows as a plain line and never as a system or tip line.
export const CHAT_KINDS = ['player', 'app', 'system', 'tip']
export const CHAT_APP_NAME_MAX_LENGTH = 64
export const CHAT_VIA_ID_MAX_LENGTH = 64

// an app line's `via` as a message keeps it: a frozen { id, name } made of the two (each read once), the id text cut
// to CHAT_VIA_ID_MAX_LENGTH, the name as a player's (sanitizeName; '' when it has none), nothing else; undefined for
// anything without a text id. (Frozen: the `chat` event hands listeners a shallow copy of the message, so one
// listener cannot change it for the next, or in the stored chat. A copy a client decodes from its join snapshot is
// a plain object again: Chat.deserialize keeps the snapshot's messages as they come.)
export function chatVia(value) {
  let id
  let name
  try {
    if (!isPlainObject(value)) return undefined
    id = value.id
    name = value.name
  } catch {
    return undefined // a Proxy whose trap throws, or a getter that does
  }
  if (typeof id !== 'string') return undefined
  return Object.freeze({ id: cutText(id, CHAT_VIA_ID_MAX_LENGTH), name: sanitizeName(name) ?? '' })
}

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
    // who relayed it (read on an app line only: on any other kind it is dropped unread)
    const via = chatVia(msg.via)
    if (via) safe.via = via
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
