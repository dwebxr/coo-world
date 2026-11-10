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
// The rest, which no budget tracks, is dropped where it can be, step by step, when a snapshot does not fit
// (encodeSnapshot), and what cannot be dropped is counted per player and once (snapshotBound below):
// - each player other than the joiner, at most 695 bytes in the snapshot after every step (its record alone measures
//   704; joinBudget.test.js, with the real encoder) counted as SNAPSHOT_PLAYER_BYTES = 1,024: its record (ids and
//   owner/userId of 64 characters, which the 10 of uuid() ids, the only place user ids are made, are far under; a
//   64-unit name of 3-byte characters, NAME_MAX_LENGTH; float transforms, mode, axis and gaze, health, rank,
//   enteredAt, the two flags; avatar, sessionAvatar, emote and effect null after the steps) and its voice level and
//   mute entries (present players only after the 'voice' step);
// - the fixed part, measured, not assumed (envelopeBytes): the joiner's own record and the snapshot's own fields
//   (ServerNetwork.snapshotState: the URLs, the upload size as the number the server parsed, the AI names, the
//   session and voice tokens, the time and flags; chat is none after the 'chat' step). The network measures it at
//   start-up for the largest joiner this configuration can have (ServerNetwork.measureFixedBytes: a 64-character
//   id, the longest name and avatars the rules allow, its real tokens, whose size follows LIVEKIT_API_KEY), and
//   each join measures its own. SNAPSHOT_FIXED_BYTES = 24 KiB is only what that is expected to stay under (8,811
//   bytes for .env.example, 9,378 with LiveKit, 18,903 with a 4,096-character LIVEKIT_API_KEY): start-up logs when
//   it does not, and the measured value counts all the same. Until it is measured, 24 KiB counts.
// Three rules use the bound W + fixed + P x 1 KiB <= SNAPSHOT_CAP (W the world state as counted, P the players):
// - World growth is held to max(64, players present) with the start-up fixed part (fitsJoinState), so 64 players
//   always fit a world at its budget.
// - A visitor (no rank of builder or above stored on the user) joins only while the bound holds for the players
//   here, the visitor, RANKED_RESERVE_PLAYERS = 8 more and GROWTH_RESERVE_BYTES = 64 KiB more world state
//   (visitorShortfall), so a crowd of visitors cannot keep a ranked user out or stop building.
// - Everyone, ranked users included, joins when the real snapshot after its steps fits the cap (ServerNetwork
//   onConnection). That is the only hard condition: the counted W is an upper bound (a world stored over its budget
//   can still send a far smaller snapshot), so a ranked user can come into a world that is over its budget or
//   crowded, to shrink or moderate it.
// With the fixed part of .env.example, a full 768 KiB world takes 174 visitors and an empty one (1,879 bytes: the
// default collection and settings) 940; with 24 KiB, 159 and 925. After them the bound still holds 73 ranked users
// at the full world (the 8 kept and the growth room it cannot use), and 64 KiB of growth plus 8 ranked users in the
// empty one; a ranked user is admitted beyond that whenever the real snapshot fits. WS_MAX_SOCKETS (64 by default) and playerLimit can only lower that. A world that needs more
// would need a snapshot sent in parts (not done here).
export const WORLD_JOIN_BYTES = 768 * 1024
export const SNAPSHOT_PLAYER_BYTES = 1024
export const SNAPSHOT_FIXED_BYTES = 24 * 1024
// players a world at its budget always has room for (growth is held to it even when fewer are present)
export const GUARANTEED_PLAYERS = 64
// the room a visitor's join must leave: this many more players, and this much more world state
export const RANKED_RESERVE_PLAYERS = 8
export const GROWTH_RESERVE_BYTES = 64 * 1024
// the joiner's own avatar (the world's default avatar URL, settingsPolicy FILE_URL_MAX_LENGTH, or its stored one)
export const OWN_AVATAR_MAX_LENGTH = 2048

// the most the join snapshot can take with world state `worldBytes`, `players` players and the fixed part
// `fixedBytes`, after every step
export function snapshotBound(worldBytes, players, fixedBytes = SNAPSHOT_FIXED_BYTES) {
  return worldBytes + fixedBytes + players * SNAPSHOT_PLAYER_BYTES
}

const playersOf = world => world.entities?.players?.size ?? 0
// the fixed part the network measured at start-up (the expected one until then)
const fixedOf = world => world.network?.fixedBytes ?? SNAPSHOT_FIXED_BYTES

// The fixed part of a join snapshot, measured with the real encoder: `state` (ServerNetwork.snapshotState) with
// its world state, its chat, the other players and their voice entries left out, keeping the key names and the
// joiner's own record (`selfId`), the parts no step drops.
export function envelopeBytes(state, selfId) {
  const livekit =
    state.livekit && typeof state.livekit === 'object'
      ? { ...state.livekit, levels: {}, muted: new Set() }
      : state.livekit
  return writePacket('snapshot', {
    ...state,
    collections: [],
    settings: {},
    chat: [],
    blueprints: [],
    entities: state.entities.filter(data => data?.type === 'player' && data.id === selfId),
    livekit,
  }).length
}

// Why a visitor may not join now (null when they may): 'world' when the world's state alone leaves no room for
// them, 'players' when the players here took it. `envelope` is this join's measured fixed part; the start-up one
// counts when it is larger, as it does for growth, so a visitor cannot take room growth was promised.
export function visitorShortfall(world, envelope) {
  const fixed = Math.max(envelope, fixedOf(world))
  const worldBytes = joinStateBytes(world) + GROWTH_RESERVE_BYTES
  if (snapshotBound(worldBytes, 1 + RANKED_RESERVE_PLAYERS, fixed) > SNAPSHOT_CAP) return 'world'
  if (snapshotBound(worldBytes, playersOf(world) + 1 + RANKED_RESERVE_PLAYERS, fixed) > SNAPSHOT_CAP) return 'players'
  return null
}

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

// whether a change of `delta` bytes may be applied: anything that does not grow is; growth must stay within the
// budget and leave room for the players here (at least GUARANTEED_PLAYERS) in the join snapshot
export function fitsJoinState(world, delta) {
  if (delta <= 0) return true
  const next = joinStateBytes(world) + delta
  return (
    next <= WORLD_JOIN_BYTES &&
    snapshotBound(next, Math.max(GUARANTEED_PLAYERS, playersOf(world)), fixedOf(world)) <= SNAPSHOT_CAP
  )
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
