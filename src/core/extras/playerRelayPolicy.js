// The player packets a server script sends to one client (playerTeleport, playerPush, playerSessionAvatar).
// Pure: the client checks a payload before it reaches physics or the avatar loader, and the server drops
// the same packets when a client sends them. The client-originated relays of these packets to other
// players were removed; the names stay registered for the server -> client direction.
import { isAvatarUrl } from './entityModifyPolicy.js'

const isObject = value => value !== null && typeof value === 'object'

// three finite numbers, read once, returned as a new array
function finiteTriple(value) {
  if (!Array.isArray(value) || value.length !== 3) return null
  const x = value[0]
  const y = value[1]
  const z = value[2]
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return [x, y, z]
}

export function sanitizeTeleport(data) {
  if (!isObject(data)) return null
  const position = finiteTriple(data.position)
  if (!position) return null
  const safe = { position }
  // a rotationY that is not a finite number is left out, not rejected: respawn hooks pass a quaternion here
  if (Number.isFinite(data.rotationY)) safe.rotationY = data.rotationY
  return safe
}

export function sanitizePush(data) {
  if (!isObject(data)) return null
  const force = finiteTriple(data.force)
  if (!force) return null
  return { force }
}

// `{ avatar }`, where null/undefined clears the session avatar
export function sanitizeSessionAvatar(data) {
  if (!isObject(data) || !isAvatarUrl(data.avatar)) return null
  return { avatar: data.avatar }
}

// the server's handling of a relay packet a client sent: ignore it and say so once per socket and packet
// name, since a script may send one every frame
export function createRelayDrop(warn = console.warn) {
  const seen = new WeakMap()
  return (socket, name) => {
    let names = seen.get(socket)
    if (!names) seen.set(socket, (names = new Set()))
    if (names.has(name)) return
    names.add(name)
    warn(`[network] ${name} from client ${socket.id} ignored: only server scripts may act on other players`)
  }
}
