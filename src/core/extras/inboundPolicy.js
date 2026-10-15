// The gate a client packet passes before the server decodes it. Pure: it sees the packet name (read from the
// header without decoding), the raw byte length and a clock. What a hostile packet can cost the server is then
// bounded by its size on the wire, not by what it decodes into.
import { createLogOnce } from './logOnce.js'

// per-type caps on the wire size. the largest legitimate client packets are a blueprint carrying a .hyp's
// props or a textarea prop (a few KB) and an `ai` prompt; a script event is whatever `app.send` was given.
// on a world whose settings grant builder to everyone (effectiveRank >= BUILDER) every socket counts as a
// builder, so the builder caps apply to all of them
export const INBOUND_BYTE_LIMITS = Object.freeze({
  entityEvent: 64 * 1024,
  blueprintAdded: 256 * 1024,
  blueprintModified: 256 * 1024,
  ai: 256 * 1024,
})
export const INBOUND_DEFAULT_BYTE_LIMIT = 32 * 1024
export const BUILDER_ONLY_PACKETS = Object.freeze(['blueprintAdded', 'blueprintModified', 'ai'])

// a token bucket per connection: a packet costs one unit plus one per 2 KiB of wire, the bucket refills at
// 1024 units a second and holds 2048. a client at the 8 Hz network rate plus a few scripts sending every
// frame stays near 450 a second; a .hyp import costs about 130 once
export const INBOUND_RATE_PER_SECOND = 1024
export const INBOUND_BURST = 2048
export const INBOUND_UNIT_BYTES = 2048

// the server decodes at most this much wire per tick, and keeps at most this much undecoded wire per socket
export const INBOUND_BYTES_PER_TICK = 256 * 1024
export const INBOX_MAX_BYTES = 1024 * 1024

export function packetByteLimit(name) {
  return INBOUND_BYTE_LIMITS[name] ?? INBOUND_DEFAULT_BYTE_LIMIT
}

export function packetCost(bytes) {
  return 1 + Math.floor(bytes / INBOUND_UNIT_BYTES)
}

/**
 * Inbound Gate
 *
 * - admit(socket, name, bytes, { builder }) says whether the packet may be decoded. `name` is null when the
 *   header is not one of this protocol's packets
 * - a refused packet is counted per socket and the first refusal of each kind is logged; a socket is never
 *   closed for it, so a slow or buggy client loses packets, not its session
 *
 */
export function createInboundGate({ now = Date.now, log = console.warn } = {}) {
  const states = new WeakMap()
  const logOnce = createLogOnce(log)

  const stateOf = socket => {
    let state = states.get(socket)
    if (!state) states.set(socket, (state = { tokens: INBOUND_BURST, at: now(), dropped: 0 }))
    return state
  }
  const refuse = (socket, state, key, name, reason) => {
    state.dropped++
    logOnce(socket, key, `[network] ${name} from client ${socket.id} dropped: ${reason} (further drops are counted)`)
    return false
  }

  function admit(socket, name, bytes, { builder = false } = {}) {
    const state = stateOf(socket)
    if (!name) return refuse(socket, state, 'unknown', 'packet', 'unreadable header')
    if (!builder && BUILDER_ONLY_PACKETS.includes(name)) {
      return refuse(socket, state, `${name}:builder`, name, 'builder only')
    }
    const limit = packetByteLimit(name)
    if (bytes > limit) {
      return refuse(socket, state, `${name}:size`, name, `${bytes} bytes over the ${limit} byte limit`)
    }
    const t = now()
    state.tokens = Math.min(INBOUND_BURST, state.tokens + ((t - state.at) / 1000) * INBOUND_RATE_PER_SECOND)
    state.at = t
    const cost = packetCost(bytes)
    if (cost > state.tokens) return refuse(socket, state, 'rate', name, 'rate limit')
    state.tokens -= cost
    return true
  }

  // how many packets this socket has had refused
  function dropped(socket) {
    return states.get(socket)?.dropped ?? 0
  }

  return { admit, dropped }
}
