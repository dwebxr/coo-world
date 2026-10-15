import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILDER_ONLY_PACKETS,
  INBOUND_BURST,
  INBOUND_BYTES_PER_TICK,
  INBOUND_DEFAULT_BYTE_LIMIT,
  INBOUND_RATE_PER_SECOND,
  INBOX_MAX_BYTES,
  createInboundGate,
  packetByteLimit,
  packetCost,
} from '../src/core/extras/inboundPolicy.js'

const KiB = 1024

const clock = (start = 1_000_000) => {
  let t = start
  return { now: () => t, tick: ms => (t += ms) }
}
const make = () => {
  const c = clock()
  const logs = []
  const gate = createInboundGate({ now: c.now, log: m => logs.push(m) })
  return { gate, c, logs }
}
const socket = id => ({ id })

test('constants: the caps and budgets the plan fixed', () => {
  assert.equal(packetByteLimit('entityEvent'), 64 * KiB)
  for (const name of ['blueprintAdded', 'blueprintModified', 'ai']) assert.equal(packetByteLimit(name), 256 * KiB)
  for (const name of ['entityModified', 'entityAdded', 'chatAdded', 'command', 'ping', 'nope']) {
    assert.equal(packetByteLimit(name), 32 * KiB)
  }
  assert.equal(INBOUND_DEFAULT_BYTE_LIMIT, 32 * KiB)
  assert.deepEqual([...BUILDER_ONLY_PACKETS], ['blueprintAdded', 'blueprintModified', 'ai'])
  assert.equal(INBOUND_RATE_PER_SECOND, 1024)
  assert.equal(INBOUND_BURST, 2048)
  assert.equal(INBOUND_BYTES_PER_TICK, 256 * KiB)
  assert.equal(INBOX_MAX_BYTES, 1024 * KiB)
})

test('packetCost: one unit plus one per 2 KiB of wire', () => {
  assert.equal(packetCost(0), 1)
  assert.equal(packetCost(1), 1)
  assert.equal(packetCost(2047), 1)
  assert.equal(packetCost(2048), 2)
  assert.equal(packetCost(64 * KiB), 33)
  assert.equal(packetCost(256 * KiB), 129)
})

test('admit: per-type byte caps on the wire size, inclusive', () => {
  const { gate, logs } = make()
  const s = socket('s1')
  assert.equal(gate.admit(s, 'entityEvent', 64 * KiB), true)
  assert.equal(gate.admit(s, 'entityEvent', 64 * KiB + 1), false)
  assert.equal(gate.admit(s, 'entityModified', 32 * KiB), true)
  assert.equal(gate.admit(s, 'entityModified', 32 * KiB + 1), false)
  assert.equal(gate.admit(s, 'blueprintAdded', 256 * KiB, { builder: true }), true)
  assert.equal(gate.admit(s, 'blueprintAdded', 256 * KiB + 1, { builder: true }), false)
  assert.equal(gate.admit(s, 'ai', 256 * KiB + 1, { builder: true }), false)
  assert.equal(gate.dropped(s), 4)
  assert.ok(
    logs.includes(
      '[network] entityEvent from client s1 dropped: 65537 bytes over the 65536 byte limit (further drops are counted)'
    ),
    logs.join('\n')
  )
})

test('admit: a packet whose header is not one of ours is refused before anything else, whatever its size', () => {
  const { gate, logs } = make()
  const s = socket('s1')
  assert.equal(gate.admit(s, null, 1), false)
  assert.equal(gate.admit(s, null, 10 * KiB, { builder: true }), false)
  assert.equal(gate.admit(s, undefined, 0), false)
  assert.equal(gate.dropped(s), 3)
  assert.deepEqual(logs, ['[network] packet from client s1 dropped: unreadable header (further drops are counted)'])
})

test('admit: builder-only packets are refused for non-builders before the size check', () => {
  const { gate, logs } = make()
  const visitor = socket('v')
  const builder = socket('b')
  for (const name of BUILDER_ONLY_PACKETS) {
    assert.equal(gate.admit(visitor, name, 10), false, name)
    assert.equal(gate.admit(visitor, name, 10, { builder: false }), false, name)
    assert.equal(gate.admit(builder, name, 10, { builder: true }), true, name)
  }
  // a visitor's oversize blueprint is logged as builder only, not as oversize: nothing about it is measured
  assert.equal(gate.admit(visitor, 'blueprintAdded', 300 * KiB), false)
  assert.equal(logs.filter(l => l.includes('builder only')).length, 3)
  assert.equal(logs.filter(l => l.includes('byte limit')).length, 0)
  assert.equal(gate.dropped(visitor), 7)
  assert.equal(gate.dropped(builder), 0)
})

test('admit: the token bucket allows a burst of 2048 units, then 1024 units a second', () => {
  const { gate, c, logs } = make()
  const s = socket('s1')
  let admitted = 0
  for (let i = 0; i < 3000; i++) if (gate.admit(s, 'ping', 1)) admitted++
  assert.equal(admitted, INBOUND_BURST)
  assert.equal(gate.dropped(s), 3000 - INBOUND_BURST)
  assert.equal(logs.filter(l => l.includes('rate limit')).length, 1)
  assert.ok(logs.includes('[network] ping from client s1 dropped: rate limit (further drops are counted)'))
  // a second later exactly 1024 more fit
  c.tick(1000)
  admitted = 0
  for (let i = 0; i < 3000; i++) if (gate.admit(s, 'ping', 1)) admitted++
  assert.equal(admitted, INBOUND_RATE_PER_SECOND)
  // the bucket never holds more than the burst
  c.tick(60_000)
  admitted = 0
  for (let i = 0; i < 3000; i++) if (gate.admit(s, 'ping', 1)) admitted++
  assert.equal(admitted, INBOUND_BURST)
  // refill is continuous: 100 ms buys 102 units
  c.tick(100)
  admitted = 0
  for (let i = 0; i < 200; i++) if (gate.admit(s, 'ping', 1)) admitted++
  assert.equal(admitted, 102)
})

test('admit: large packets cost more units; a .hyp import fits once and the 8 Hz client rate fits for ever', () => {
  const { gate, c } = make()
  const s = socket('s1')
  // 2048 / 33 = 62 maximal events in a burst
  let admitted = 0
  for (let i = 0; i < 100; i++) if (gate.admit(s, 'entityEvent', 64 * KiB)) admitted++
  assert.equal(admitted, 62)
  c.tick(10_000)
  assert.equal(gate.admit(s, 'blueprintAdded', 256 * KiB, { builder: true }), true) // 129 units
  // 8 movement packets and 8 builder moves a second plus 450 script events never drain the bucket
  for (let second = 0; second < 60; second++) {
    for (let i = 0; i < 466; i++) {
      assert.equal(gate.admit(s, i < 16 ? 'entityModified' : 'entityEvent', 200), true, `second ${second} #${i}`)
      c.tick(2)
    }
  }
  assert.equal(gate.dropped(s), 38)
})

test('admit: each kind of refusal is logged once per socket; another socket gets its own lines', () => {
  const { gate, logs } = make()
  const a = socket('a')
  const b = socket('b')
  for (let i = 0; i < 5; i++) {
    gate.admit(a, 'entityEvent', 70 * KiB)
    gate.admit(a, 'chatAdded', 40 * KiB)
    gate.admit(a, 'ai', 1)
    gate.admit(a, null, 1)
  }
  for (let i = 0; i < 2100; i++) gate.admit(a, 'ping', 1)
  assert.equal(logs.length, 5) // size x2 (per name), builder only, unreadable, rate
  gate.admit(b, 'entityEvent', 70 * KiB)
  gate.admit(b, 'entityEvent', 70 * KiB)
  assert.equal(logs.length, 6)
  assert.ok(logs[5].startsWith('[network] entityEvent from client b dropped: 71680 bytes over'))
  assert.equal(gate.dropped(a), 20 + 2100 - INBOUND_BURST)
  assert.equal(gate.dropped(b), 2)
  assert.equal(gate.dropped(socket('never seen')), 0)
})
