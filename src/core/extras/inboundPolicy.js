// Admission pays for bytes before inspecting the header, then for every node the strict scan charges.
import { packetNameById, peekPacketId } from '../packets.js'
import { createLogOnce } from './logOnce.js'
import { strictDecode } from './strictDecode.js'

export const INBOUND_BYTE_LIMITS = Object.freeze({
  entityEvent: 64 * 1024,
  blueprintAdded: 64 * 1024,
  blueprintModified: 64 * 1024,
  ai: 64 * 1024,
})
export const INBOUND_DEFAULT_BYTE_LIMIT = 32 * 1024
export const INBOUND_NODE_LIMITS = Object.freeze({
  entityEvent: 8192,
  blueprintAdded: 8192,
  blueprintModified: 8192,
  ai: 1024,
})
export const INBOUND_DEFAULT_NODE_LIMIT = 4096
export const BUILDER_ONLY_PACKETS = Object.freeze(['blueprintAdded', 'blueprintModified', 'ai'])

export const INBOUND_RATE_PER_SECOND = 1024
export const INBOUND_BURST = 2048
export const INBOUND_UNIT_BYTES = 2048

// The flat inbox and its wire budget stay in place until the scheduler lands.
export const INBOUND_BYTES_PER_TICK = 256 * 1024
export const INBOX_MAX_BYTES = 1024 * 1024

export function packetByteLimit(name) {
  return INBOUND_BYTE_LIMITS[name] ?? INBOUND_DEFAULT_BYTE_LIMIT
}

export function packetNodeLimit(name) {
  return INBOUND_NODE_LIMITS[name] ?? INBOUND_DEFAULT_NODE_LIMIT
}

export function packetCost(bytes) {
  return 1 + Math.floor(bytes / INBOUND_UNIT_BYTES)
}

export function createInboundGate({ now = Date.now, log = console.warn, scan = strictDecode } = {}) {
  const states = new WeakMap()
  const logOnce = createLogOnce(log)

  const stateOf = socket => {
    let state = states.get(socket)
    if (!state) states.set(socket, (state = { tokens: INBOUND_BURST, at: now(), dropped: 0 }))
    return state
  }
  const refuse = (socket, key, name, reason) => {
    stateOf(socket).dropped++
    logOnce(socket, key, `[network] ${name} from client ${socket.id} dropped: ${reason} (further drops are counted)`)
    return false
  }

  function admit(socket, packet, { builder = false } = {}) {
    const bytes = packet.length
    const state = stateOf(socket)
    const t = now()
    state.tokens = Math.min(INBOUND_BURST, state.tokens + ((t - state.at) / 1000) * INBOUND_RATE_PER_SECOND)
    state.at = t
    const cost = packetCost(bytes)
    const ok = state.tokens >= cost
    state.tokens = Math.max(-INBOUND_BURST, state.tokens - cost)
    if (!ok) return refuse(socket, 'rate', 'packet', 'rate limit')

    const name = packetNameById(peekPacketId(packet))
    if (!name) return refuse(socket, 'unknown', 'packet', 'unreadable header')
    if (!builder && BUILDER_ONLY_PACKETS.includes(name)) {
      return refuse(socket, `${name}:builder`, name, 'builder only')
    }
    const limit = packetByteLimit(name)
    if (bytes > limit) {
      return refuse(socket, `${name}:size`, name, `${bytes} bytes over the ${limit} byte limit`)
    }
    const result = scan(packet, { maxNodes: packetNodeLimit(name), build: false })
    state.tokens = Math.max(-INBOUND_BURST, state.tokens - Math.floor(result.nodes / 32))
    if (!result.ok) {
      return refuse(socket, 'undecodable', name, `undecodable (${result.reason} at pos ${result.pos})`)
    }
    return { name, bytes, nodes: result.nodes, builder }
  }

  function dropped(socket) {
    return states.get(socket)?.dropped ?? 0
  }

  return { admit, refuse, dropped }
}
