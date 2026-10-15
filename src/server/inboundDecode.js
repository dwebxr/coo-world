import { Unpackr, addExtension } from 'msgpackr'
import { packetMethodById } from '../core/packets.js'

// Decoding of the packets clients send. The shared Packr in core/packets.js stays as it is for encoding and
// for a client's decoding of server packets; this decoder is what the server runs on untrusted bytes.
//
// - structuredClone is off: the id and pointer extensions (0x69, 0x70) throw, so a packet whose references
//   form a DAG or a cycle is refused before anything is built from it. Client senders put plain values on the
//   wire; a value that holds the same object twice is the one legitimate shape this turns away.
// - the first value is read in the decoder's sequential mode, which never stringifies what it read when bytes
//   remain; trailing bytes are refused by position here instead.
// - the extensions for BigInt, Error, Set, typed arrays, RegExp and Date are replaced with handlers that
//   throw. No client packet carries them, and each costs far more to decode than it takes on the wire. The
//   extension table is shared by every decoder in a process (msgpackr keeps it module-wide), which is why
//   only the server network imports this module: the server decodes nothing but client packets.
// - 64-bit integers decode as numbers, so no BigInt reaches a handler either.

const unpackr = new Unpackr({ structuredClone: false, int64AsType: 'number' })

export const REFUSED_EXTENSIONS = Object.freeze([0x42, 0x65, 0x73, 0x74, 0x78, 0xff])
for (const type of REFUSED_EXTENSIONS) {
  addExtension({
    type,
    unpack: () => {
      throw new Error(`refused msgpack extension 0x${type.toString(16)}`)
    },
  })
}

// the decoded value, or a throw. nothing here logs or stringifies the value
export function decodeInbound(packet) {
  let value
  let end = -1
  unpackr.unpackMultiple(packet, (first, start, position) => {
    value = first
    end = position
    return false
  })
  if (end !== packet.length) throw new Error(`${packet.length - end} trailing bytes`)
  return value
}

// [method, data] for a client packet, or a throw when the bytes are not one
export function readInboundPacket(packet) {
  const value = decodeInbound(packet)
  if (!Array.isArray(value) || value.length !== 2) throw new Error('not a packet tuple')
  const method = packetMethodById(value[0])
  if (!method) throw new Error('unknown packet id')
  return [method, value[1]]
}
