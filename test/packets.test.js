import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Packr } from 'msgpackr'

import { packetMethodById, packetNameById, peekPacketId, readPacket, writePacket } from '../src/core/packets.js'

// Mirrors the `names` array in src/core/packets.js (lines 6-31). This is a
// frozen snapshot of the wire protocol's name -> id ordering. It is
// intentionally duplicated here (not imported) so that reordering, inserting,
// or removing an entry in packets.js changes the runtime id assigned to a
// name and is caught below, even though writePacket/readPacket stay
// internally self-consistent with each other.
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
]

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// used only to inspect the raw [id, data] tuple packed by writePacket,
// independently of packets.js's own byId/byName maps.
const packr = new Packr({ structuredClone: true })

test('writePacket/readPacket: round-trips every known packet name at its expected wire id', () => {
  for (let expectedId = 0; expectedId < names.length; expectedId++) {
    const name = names[expectedId]
    const payload = { name, n: expectedId }

    const packet = writePacket(name, payload)

    const [rawId, rawData] = packr.unpack(packet)
    assert.equal(rawId, expectedId, `expected "${name}" to be wire id ${expectedId}`)
    assert.deepEqual(rawData, payload)

    const [method, data] = readPacket(packet)
    assert.equal(method, `on${capitalize(name)}`)
    assert.deepEqual(data, payload)
  }
})

test('writePacket: throws when the packet name is not registered', () => {
  assert.throws(() => writePacket('notARealPacketName', {}), /name not found/)
})

test('readPacket: returns an empty array when the wire id is not registered', () => {
  const packet = packr.pack([names.length + 1000, { foo: 'bar' }])
  const result = readPacket(packet)
  assert.deepEqual(result, [])
})

test('peekPacketId: reads the id of every known packet from its header without decoding', () => {
  for (let expectedId = 0; expectedId < names.length; expectedId++) {
    const name = names[expectedId]
    for (const payload of [undefined, null, 1, 'x', [1, 2], { a: { b: [1] } }, 'y'.repeat(70000)]) {
      const packet = writePacket(name, payload)
      assert.equal(peekPacketId(packet), expectedId, `${name} with ${typeof payload}`)
    }
    assert.equal(packetNameById(expectedId), name)
    assert.equal(packetMethodById(expectedId), `on${capitalize(name)}`)
  }
  // the peek relies on the ids being positive fixints; the module refuses to load past that
  assert.ok(names.length < 128)
})

test('peekPacketId: anything that is not a 2-element fixarray with a known fixint id is -1', () => {
  assert.equal(peekPacketId(new Uint8Array([])), -1)
  assert.equal(peekPacketId(new Uint8Array([0x92])), -1)
  assert.equal(peekPacketId(new Uint8Array([0x93, 0x00, 0x00, 0x00])), -1) // 3-element array
  assert.equal(peekPacketId(new Uint8Array([0x92, 0x80, 0x00])), -1) // not a positive fixint
  assert.equal(peekPacketId(new Uint8Array([0x92, 0x7f, 0x00])), -1) // unknown id
  assert.equal(peekPacketId(new Uint8Array([0x92, names.length + 50, 0x00])), -1)
  assert.equal(peekPacketId(packr.pack([names.length + 1000, {}])), -1)
  assert.equal(peekPacketId(packr.pack({ id: 0 })), -1)
  assert.equal(peekPacketId(packr.pack('snapshot')), -1)
  assert.equal(peekPacketId(null), -1)
  assert.equal(peekPacketId(undefined), -1)
  assert.equal(packetNameById(-1), undefined)
  assert.equal(packetMethodById(999), undefined)
})
