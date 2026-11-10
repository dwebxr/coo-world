import { writePacket } from '../packets.js'

// The join snapshot (ServerNetwork.onConnection) must fit its cap, writeLedger.js SNAPSHOT_CAP (1 MiB minus 1 KiB).
// The world's own state in it (blueprints, app entities and settings) is held to three quarters of that, tracked
// per item as it changes, so the rest is left for players, chat, collections and voice state. Blueprints alone
// also keep their own share (WORLD_BLUEPRINT_BYTES). Growth only: a world that was already larger when it loaded
// keeps all of it and may shrink, but nothing that adds bytes is accepted until it is back under the budget.
export const WORLD_JOIN_BYTES = 768 * 1024

// An app entity is measured as the snapshot carries it, with the fields that change in normal use at their largest
// encoding (transforms as floats; pinned is one byte either way), so moving or pinning an app never changes its
// size. mover/uploader count as unset: they hold a socket id only while a builder drags or uploads it.
// Measured alone, an entity also carries its key names, which the snapshot's records encode once for all of them,
// so the sum is an upper bound of what the snapshot spends. A 10-character id and blueprint id measure 201 bytes.
const F3 = [0.5, 0.5, 0.5]
const F4 = [0.5, 0.5, 0.5, 0.5]
export function appRecordBytes(id, blueprint) {
  return writePacket('entityAdded', {
    id,
    type: 'app',
    blueprint,
    position: F3,
    quaternion: F4,
    scale: F3,
    mover: null,
    uploader: null,
    pinned: false,
    state: null,
  }).length
}

// the bytes a client-set app state adds to its record (none for null or undefined). State a server script assigns
// (app.state = …) is never read here; the snapshot leaves it out when it would not fit otherwise (onConnection)
export function stateBytes(state) {
  return state === undefined || state === null ? 0 : writePacket('entityModified', state).length
}

// the world settings as the snapshot carries them (measured when they load and when a builder changes one)
export function settingsBytes(settings) {
  return writePacket('settingsModified', settings).length
}

// the world state every join snapshot carries, as the systems track it (server only)
export function joinStateBytes(world) {
  return (world.blueprints?.bytes || 0) + (world.entities?.appBytes || 0) + (world.network?.settingsBytes || 0)
}

// whether a change of `delta` bytes may be applied: anything that does not grow is
export function fitsJoinState(world, delta) {
  return delta <= 0 || joinStateBytes(world) + delta <= WORLD_JOIN_BYTES
}

// The start-up line for a world that loaded over the budget (null when it fits): the totals and the five largest
// blueprints and app entities, so an operator knows what to shrink. Nothing is dropped or rewritten.
export function joinStateReport(world, { snapshotCap } = {}) {
  const total = joinStateBytes(world)
  if (total <= WORLD_JOIN_BYTES) return null
  const items = []
  for (const [id, bytes] of world.blueprints?.sizes || []) items.push({ kind: 'blueprint', id, bytes })
  for (const [id, size] of world.entities?.appSizes || [])
    items.push({ kind: 'app', id, bytes: size.record + size.state })
  items.sort((a, b) => b.bytes - a.bytes)
  const largest = items
    .slice(0, 5)
    .map(
      item =>
        `${item.kind} ${JSON.stringify(
          String(item.id)
            .slice(0, 24)
            .replace(/[^\x20-\x7e]/g, '?')
        )} ${item.bytes}`
    )
    .join(', ')
  const cap =
    snapshotCap && total > snapshotCap ? `; over the snapshot cap (${snapshotCap}): joins fail until it shrinks` : ''
  return (
    `[network] world join-state budget exceeded at startup: bytes=${total} cap=${WORLD_JOIN_BYTES} ` +
    `(blueprints=${world.blueprints?.bytes || 0} apps=${world.entities?.appBytes || 0} settings=${world.network?.settingsBytes || 0}); ` +
    `nothing may grow until it is back under the cap${cap}; largest: ${largest}`
  )
}
