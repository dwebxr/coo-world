import { Packr } from 'msgpackr'

export const PROTOCOL_VERSION = 2

const packr = new Packr({ structuredClone: true })
const clientPackr = new Packr({ useRecords: false, structuredClone: false, moreTypes: false, bundleStrings: false })

// External agents (Coo: dwebxr/coo-hyperliza lib/world-protocol.ts) pin PROTOCOL_VERSION and a copy of this table.
// Append new names at the end only; inserting or reordering shifts their ids, and a version bump kicks them.
// prettier-ignore
const names = [
  'snapshot',
  'command',
  'chatAdded',
  'chatCleared',
  'blueprintAdded',
  'blueprintModified',
  'entityAdded',
  'entityModified',
  'entityEvent',
  'entityRemoved',
  'playerTeleport',
  'playerPush',
  'playerSessionAvatar',
  'liveKitLevel',
  'mute',
  'settingsModified',
  'spawnModified',
  'modifyRank',
  'kick',
  'ai',
  'ping',
  'pong',
  'requestBuilderByToken',
  'revokeBuilderByToken',
  'requestBuilderNonce',
  'builderNonce',
  'walletStatus',
  'tokenBalanceRequest',
  'tokenBalance',
  'requestBuilderRecheck',
  'requestEvmNonce',
  'evmNonce',
  'requestEvmVerify',
  'evmWalletStatus',
  'revokeEvmWallet',
  'setEvmTipReceive',
  'requestEvmTipIntent',
  'evmTipIntent',
  'evmTip',
  'evmTipStatus',
  // client -> server: a client script's broadcast world.chat(); the server relays it as an app line (kind 'app')
  'appChat',
]

const byName = {}
const byId = {}

let ids = -1

for (const name of names) {
  const id = ++ids
  const info = {
    id,
    name,
    method: `on${capitalize(name)}`, // eg 'connect' -> 'onConnect'
  }
  byName[name] = info
  byId[id] = info
}

// peekPacketId reads the id from the second byte, which holds as long as every id is a positive fixint
if (names.length > 128) throw new Error('packets: more than 128 names; peekPacketId relies on fixint ids')

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// the id of a packet without decoding it. msgpackr writes `[id, data]` as a 2-element fixarray whose first
// element is a positive fixint for every id this table can hold; anything else is not a packet of this protocol
export function peekPacketId(packet) {
  if (!packet || packet.length < 2 || packet[0] !== 0x92 || packet[1] > 0x7f) return -1
  return byId[packet[1]] ? packet[1] : -1
}

export function packetNameById(id) {
  return byId[id]?.name
}

export function packetMethodById(id) {
  return byId[id]?.method
}

// Packing reads the value it is given, and a value from a script runs the script's code while it is read (a getter, a
// toJSON, a Proxy trap). That code can pack another message (an app.send, an app teardown that announces a change),
// and msgpackr's packers share one buffer and one write position: the packet whose packing was interrupted would come
// out with the other one's bytes in it. Every pack here is counted, and a packet another pack interrupted is refused
// (it throws) instead of being returned.
export const PACK_INTERRUPTED = 'the data cannot be packed: reading it packed another message'
let packs = 0

function packOnce(packer, value) {
  const mark = ++packs
  const packet = packer.pack(value)
  if (packs !== mark) throw new Error(PACK_INTERRUPTED)
  return packet
}

export function writePacket(name, data) {
  const info = byName[name]
  if (!info) throw new Error(`writePacket failed: ${name} (name not found)`)
  return packOnce(packr, [info.id, data])
}

export function writeClientPacket(name, data) {
  const info = byName[name]
  if (!info) throw new Error(`writeClientPacket failed: ${name} (name not found)`)
  return packOnce(clientPackr, [info.id, data])
}

// A host copy of data a script hands the network (app.send, app.sendTo). Packing reads the script's object, and its
// code can end the script's run: the data is packed here, once, before the host decides whether to send it, and what
// goes out is the copy, plain host data whose packing runs no script code. The copy is packed and read back by this
// side's packer, so packing it again writes the message the data itself would have. A primitive needs no copy.
export function scriptPacketData(data, client) {
  if (data === null || (typeof data !== 'object' && typeof data !== 'function')) return data
  const packer = client ? clientPackr : packr
  return packer.unpack(packOnce(packer, data))
}

export function readPacket(packet) {
  try {
    const [id, data] = packr.unpack(packet)
    const info = byId[id]
    if (!info) throw new Error(`readPacket failed: ${id} (id not found)`)
    return [info.method, data]
  } catch (err) {
    console.error(err)
    return []
  }
}
