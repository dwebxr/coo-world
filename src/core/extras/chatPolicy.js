// Server-side validation of a chat message a client sent. Pure: returns a fresh object holding only the
// allowed fields, or null. The sender identity and the time are stamped by the server, never copied.
import { isPlainObject } from './entityModifyPolicy.js'

export const CHAT_BODY_MAX_LENGTH = 500
const CHAT_ID_MAX_LENGTH = 64

// `body` must be text: trimmed, non-empty, capped. `id` is kept when it is a short string (the sender already
// shows its own copy under that id) and left undefined otherwise, for the caller to mint. each property is
// read once, so the value checked is the value kept
export function sanitizeChatMessage(msg) {
  if (!isPlainObject(msg)) return null
  const id = msg.id
  const body = msg.body
  if (typeof body !== 'string') return null
  const text = body.trim().slice(0, CHAT_BODY_MAX_LENGTH)
  if (!text) return null
  return {
    id: typeof id === 'string' && id.length > 0 && id.length <= CHAT_ID_MAX_LENGTH ? id : undefined,
    body: text,
  }
}
