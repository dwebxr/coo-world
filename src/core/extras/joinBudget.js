import { writePacket } from '../packets.js'
import { SNAPSHOT_CAP } from './writeLedger.js'

// The join snapshot (ServerNetwork.onConnection) must fit its cap, writeLedger.js SNAPSHOT_CAP = 1,047,552 bytes
// (1 MiB minus 1 KiB). It holds two kinds of things:
//
// World state, tracked per item as it changes and held to WORLD_JOIN_BYTES (growth only: a world that was already
// larger when it loaded keeps all of it and may shrink, but nothing that adds bytes is accepted until it is back
// under): blueprints (Blueprints.sizes; they also keep their own WORLD_BLUEPRINT_BYTES share), app entities
// (Entities.appSizes, appRecordBytes + the client-set state), settings (settingsBytes, measured when they load and
// before a change is applied) and collections (operator files, measured once at start-up). Each item is measured
// alone, key names included, which the snapshot's msgpack records encode once for all items of a shape: the sum is
// an upper bound of what the snapshot spends on them (a world of eight 60 KB blueprints and 1,639 apps measures
// 814,740 and takes 671,973 of the snapshot; 704,753 with every app's mover and uploader set).
//
// The rest, which no budget tracks, is bounded by construction: whatever of it can be dropped is dropped, step by
// step, when a snapshot does not fit (encodeSnapshot), and what cannot be dropped is bounded by the sanitizers.
// Its worst case after every step, with the real encoder (joinBudget.test.js):
// - 63 other players (WS_MAX_SOCKETS = 64 transports at most, the joiner included), each at most 704 bytes: ids
//   and owner/userId of 64 characters, a 64-unit name of 3-byte characters (192 bytes, NAME_MAX_LENGTH), float
//   transforms, mode, axis and gaze, health, rank, enteredAt, the two flags, and null for avatar, sessionAvatar,
//   emote and effect (the steps clear them);
// - the joiner's own record, at most 8,316 bytes: its avatar may be the world's default avatar URL (2,048 units,
//   settingsPolicy FILE_URL_MAX_LENGTH, 6 KB of 3-byte characters) and its session avatar a 512-unit URL;
// - voice state after the 'voice' step: levels and muted for the 64 present players only, the LiveKit URL and a
//   token (1 KiB allowed);
// - the envelope: two 256-character URLs, the upload size, the AI provider/model/effort (64 each), a 512-character
//   session token, the server time and flags;
// - chat: none after the 'chat' step (up to 50 messages of 500 characters otherwise).
// Together 55,054 bytes. 768 KiB + 55,054 = 841,486, leaving 206,066 bytes (3.7 times that worst case) under the
// cap for what the estimate leaves out: apps being moved or uploaded (their socket ids, about 22 bytes each), user
// ids longer than 64, more than 64 players where WS_MAX_SOCKETS is raised (about 290 more fit) and the encoder's
// container overhead. A world needing more than this would need a snapshot sent in parts (not done here).
export const WORLD_JOIN_BYTES = 768 * 1024

// An app entity is measured as the snapshot carries it, with the fields that change in normal use at their largest
// encoding, so moving, pinning or dragging an app never changes its size: transforms as floats, pinned one byte
// either way, and mover and uploader as a socket id (10 characters, what uuid() makes), which they hold while a
// builder drags or uploads it. Other fields a stored record carries are counted as they are. A 10-character id and
// blueprint id measure 221 bytes.
const F3 = [0.5, 0.5, 0.5]
const F4 = [0.5, 0.5, 0.5, 0.5]
const SOCKET_ID = 'x'.repeat(10)
export function appRecordBytes(data) {
  return writePacket('entityAdded', {
    ...data,
    type: 'app',
    position: F3,
    quaternion: F4,
    scale: F3,
    mover: SOCKET_ID,
    uploader: SOCKET_ID,
    pinned: false,
    state: null,
  }).length
}

// the bytes a client-set app state adds to its record (none for null or undefined). State a server script assigns
// (app.state = …) is never read here; the snapshot leaves it out when it would not fit otherwise (onConnection)
export function stateBytes(state) {
  return state === undefined || state === null ? 0 : writePacket('entityModified', state).length
}

// the world settings, or the collections, as the snapshot carries them
export function settingsBytes(settings) {
  return writePacket('settingsModified', settings).length
}

// the world state every join snapshot carries, as the systems track it (server only)
export function joinStateBytes(world) {
  return (
    (world.blueprints?.bytes || 0) +
    (world.entities?.appBytes || 0) +
    (world.network?.settingsBytes || 0) +
    (world.network?.collectionsBytes || 0)
  )
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
    `(blueprints=${world.blueprints?.bytes || 0} apps=${world.entities?.appBytes || 0} settings=${world.network?.settingsBytes || 0} collections=${world.network?.collectionsBytes || 0}); ` +
    `nothing may grow until it is back under the cap${cap}; largest: ${largest}`
  )
}

// What a snapshot that does not fit is sent without, least harmful first; each step keeps the ones before it.
// None changes the world: each makes shallow copies of what it changes.
export const SNAPSHOT_STEPS = Object.freeze(['voice', 'chat', 'effects', 'appState', 'avatars'])
export const SNAPSHOT_STEP_NAMES = Object.freeze({
  voice: 'voice state of players who are not here',
  chat: 'chat history',
  effects: 'player effects',
  appState: 'app state',
  avatars: "other players' avatars and emotes",
})
const mapEntities = (state, fn) => ({ ...state, entities: state.entities.map(data => fn(data) ?? data) })
const degrade = {
  // levels and muted of players who left: nothing the joiner can use (a level is sent again when they come back)
  voice: state => {
    const livekit = state.livekit
    if (!livekit || typeof livekit !== 'object' || !livekit.levels) return state
    const present = new Set(state.entities.filter(data => data?.type === 'player').map(data => data.id))
    const levels = Object.fromEntries(Object.entries(livekit.levels).filter(([id]) => present.has(id)))
    const muted =
      livekit.muted instanceof Set ? new Set([...livekit.muted].filter(id => present.has(id))) : livekit.muted
    return { ...state, livekit: { ...livekit, levels, muted } }
  },
  chat: state => ({ ...state, chat: [] }),
  effects: state =>
    mapEntities(state, data => (data?.type === 'player' && data.effect ? { ...data, effect: null } : null)),
  // state a server script assigned (app.state), which no budget measures; the apps start from {} on this client
  appState: state => mapEntities(state, data => (data?.type === 'app' ? { ...data, state: {} } : null)),
  // the joiner sees the default avatar (and no emote) for the others until their next change
  avatars: (state, selfId) =>
    mapEntities(state, data =>
      data?.type === 'player' && data.id !== selfId ? { ...data, avatar: null, sessionAvatar: null, emote: null } : null
    ),
}

const tryEncode = state => {
  try {
    return writePacket('snapshot', state)
  } catch {
    return null // a value the encoder refuses (state a script assigned); the 'appState' step removes it
  }
}

// The snapshot packet, taking as many steps as it needs to fit `cap`. `packet` is null or over the cap only when
// even the last step did not make it fit (the world itself is over the cap).
export function encodeSnapshot(state, { selfId, cap = SNAPSHOT_CAP } = {}) {
  const steps = []
  let current = state
  let packet = tryEncode(current)
  for (const step of SNAPSHOT_STEPS) {
    if (packet && packet.length <= cap) break
    current = degrade[step](current, selfId)
    steps.push(step)
    packet = tryEncode(current)
  }
  return { packet, steps }
}
