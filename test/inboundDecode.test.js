import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Packr } from 'msgpackr'

import { REFUSED_EXTENSIONS, decodeInbound, readInboundPacket } from '../src/server/inboundDecode.js'
import { writePacket } from '../src/core/packets.js'

// the client's encoder (core/packets.js uses the same options)
const packr = new Packr({ structuredClone: true })
const ENTITY_EVENT = 8
// generous: every shape below takes about a millisecond on a laptop; the bound is what a tick can absorb
const MAX_MS = 50

const bytes = (...parts) => Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const tuple = body => bytes([0x92, ENTITY_EVENT], body)
const ext32 = (type, payload) => bytes([0xc9, ...u32(payload.length), type], payload)
const timed = fn => {
  const t0 = performance.now()
  let threw = null
  let value
  try {
    value = fn()
  } catch (err) {
    threw = err
  }
  return { ms: performance.now() - t0, threw, value }
}
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1)

// walks a decoded value and fails on anything the inbound decoder must never produce. raw bytes (msgpack bin,
// a Uint8Array) are allowed: they cost what they weigh on the wire. a raw msgpack map decodes as a Map, as it
// always has (clients send records, which become plain objects; the handlers' plain-object checks refuse a Map)
function assertPlain(root) {
  const stack = [root]
  let visited = 0
  while (stack.length) {
    const value = stack.pop()
    if (++visited > 300_000) return
    if (typeof value === 'bigint') assert.fail('a BigInt was decoded')
    if (value === null || typeof value !== 'object') continue
    if (value instanceof Uint8Array) continue
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) assert.fail('a typed array was decoded')
    for (const Type of [Set, Date, RegExp, Error]) {
      if (value instanceof Type) assert.fail(`a ${Type.name} was decoded`)
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item)
    } else if (value instanceof Map) {
      for (const [key, item] of value) stack.push(key, item)
    } else {
      for (const key of Object.keys(value)) stack.push(value[key])
    }
  }
}

test('readInboundPacket: decodes what the client encoder produces, records and undefined included', () => {
  const payloads = [
    ['entityModified', { id: 'p1', p: [1.5, -2, 3], q: [0, 0, 0, 1], m: 2, e: undefined }],
    ['entityEvent', ['app-1', 3, 'ping', { n: 1, s: 'x'.repeat(5000), list: [{ a: 1 }, { a: 2 }, { a: 3 }] }]],
    ['chatAdded', { body: 'héllo 😀' }],
    ['command', { args: ['server', 'stats'] }],
    ['ping', 123456.789],
    ['entityRemoved', 'id-1'],
    ['blueprintModified', { id: 'bp', version: 2 ** 40, props: { a: null, b: true, c: 2 ** 53 - 1, d: -1 } }],
    ['ai', { name: 'create', prompt: 'x'.repeat(100_000) }],
    ['requestBuilderByToken', { walletAddress: 'w', signature: 's', nonce: 'n' }],
  ]
  for (const [name, data] of payloads) {
    const [method, decoded] = readInboundPacket(writePacket(name, data))
    assert.equal(method, `on${capitalize(name)}`)
    assert.deepEqual(decoded, data)
  }
  // the local player clears its emote with an own property whose value is undefined; it survives the wire
  const [, withUndefined] = readInboundPacket(writePacket('entityModified', { id: 'p1', e: undefined }))
  assert.ok(Object.prototype.hasOwnProperty.call(withUndefined, 'e'))
  assert.equal(withUndefined.e, undefined)
  // raw bytes stay raw bytes
  const [, bin] = readInboundPacket(writePacket('entityEvent', ['a', 1, 'x', Buffer.from([1, 2, 3])]))
  assert.ok(bin[3] instanceof Uint8Array)
  assert.deepEqual([...bin[3]], [1, 2, 3])
  // packets decode independently: a record defined by one is not known to the next, whose record token
  // then reads as the plain integer it also is
  readInboundPacket(writePacket('entityEvent', ['a', 1, 'x', [{ k: 1 }, { k: 2 }]]))
  assert.deepEqual(decodeInbound(tuple([0x40])), [ENTITY_EVENT, 0x40])
})

test('regression: a pointer DAG with a trailing byte is refused at once (the expansion is never stringified)', () => {
  const dag = (depth, width) => {
    let o = { x: 1 }
    for (let i = 0; i < depth; i++) {
      const n = {}
      for (let j = 0; j < width; j++) n[`k${j}`] = o
      o = n
    }
    return o
  }
  const packet = bytes(packr.pack([ENTITY_EVENT, dag(16, 4)]), [0xc0])
  assert.ok(packet.length < 500, `${packet.length} bytes on the wire`)
  const r = timed(() => decodeInbound(packet))
  assert.ok(r.threw, 'refused')
  assert.match(r.threw.message, /Structured clone extension is disabled/)
  assert.ok(r.ms < MAX_MS, `${r.ms} ms`)
  // the same DAG without the trailing byte, a cycle, and a value holding one object twice (the one legitimate
  // shape this turns away) are refused the same way
  assert.throws(() => decodeInbound(packr.pack([ENTITY_EVENT, dag(16, 4)])), /Structured clone/)
  const cyclic = { a: 1 }
  cyclic.self = cyclic
  assert.throws(() => decodeInbound(packr.pack([ENTITY_EVENT, cyclic])), /Structured clone/)
  const shared = { n: 1 }
  assert.throws(() => decodeInbound(packr.pack([ENTITY_EVENT, [shared, shared]])), /Structured clone/)
  // while the encoder, which the server uses towards clients, still writes all of them
  assert.ok(packr.pack(cyclic).length > 0)
  assert.ok(packr.pack([shared, shared]).length > 0)
})

test('regression: a 64 KiB BigInt extension is refused at once instead of taking 300 ms', () => {
  const packet = tuple(ext32(0x42, Buffer.alloc(65536, 0x7f)))
  const r = timed(() => decodeInbound(packet))
  assert.ok(r.threw && /refused msgpack extension 0x42/.test(r.threw.message), String(r.threw))
  assert.ok(r.ms < MAX_MS, `${r.ms} ms`)
})

test('regression: 64 KiB of Error extensions is refused at once instead of taking 40 ms and 11 MB', () => {
  const item = bytes([0xd4, 0x65, 0x00, 0x93, 0xa5], 'Error', [0xa1, 0x78, 0xc0])
  const n = Math.floor(65536 / item.length)
  const packet = tuple(bytes([0xdd, ...u32(n)], ...Array(n).fill(item)))
  const r = timed(() => decodeInbound(packet))
  assert.ok(r.threw && /refused msgpack extension 0x65/.test(r.threw.message), String(r.threw))
  assert.ok(r.ms < MAX_MS, `${r.ms} ms`)
})

test('refused extensions: Set, typed array, RegExp, Date and Error throw on decode; the encoder still writes them', () => {
  assert.deepEqual([...REFUSED_EXTENSIONS], [0x42, 0x65, 0x73, 0x74, 0x78, 0xff])
  const samples = {
    set: new Set([1, 2]),
    typed: new Float32Array([1.5]),
    regexp: /a/g,
    date: new Date(0),
    error: new Error('x'),
  }
  for (const [label, value] of Object.entries(samples)) {
    const packet = packr.pack([ENTITY_EVENT, value])
    assert.ok(packet.length > 0, label)
    assert.throws(() => decodeInbound(packet), /refused msgpack extension/, label)
  }
  // a timestamp in each of its three ext sizes
  for (const ts of [
    [0xd6, 0xff, 0, 0, 0, 1],
    [0xd7, 0xff, 0, 0, 0, 0, 0, 0, 0, 1],
    [0xc7, 12, 0xff, ...Array(12).fill(0)],
  ]) {
    assert.throws(() => decodeInbound(tuple(ts)), /0xff/)
  }
  // an ArrayBuffer travels as typed-array code 16
  assert.throws(() => decodeInbound(tuple([0xc7, 3, 0x74, 16, 0, 0])), /0x74/)
})

test('a 64-bit integer decodes as a number, never a BigInt', () => {
  for (const value of [2n ** 60n, -(2n ** 60n), 2n ** 53n + 1n]) {
    const decoded = decodeInbound(packr.pack([ENTITY_EVENT, value]))
    assert.equal(typeof decoded[1], 'number', String(value))
  }
})

test('malformed packets: trailing bytes, non-tuples, unknown ids, empty and over-declared buffers are refused', () => {
  assert.throws(() => decodeInbound(bytes(packr.pack([ENTITY_EVENT, { a: 1 }]), [0xc0])), /1 trailing bytes/)
  assert.throws(() => decodeInbound(bytes(packr.pack([ENTITY_EVENT, 'x']), Buffer.alloc(1000))), /1000 trailing bytes/)
  assert.throws(() => decodeInbound(Buffer.alloc(0)))
  assert.throws(() => readInboundPacket(packr.pack([1, 2, 3])), /not a packet tuple/)
  assert.throws(() => readInboundPacket(packr.pack({ id: ENTITY_EVENT })), /not a packet tuple/)
  assert.throws(() => readInboundPacket(packr.pack('entityEvent')), /not a packet tuple/)
  assert.throws(() => readInboundPacket(packr.pack([999, {}])), /unknown packet id/)
  assert.throws(() => readInboundPacket(packr.pack(['entityEvent', {}])), /unknown packet id/)
  for (const header of [
    [0xdd, 0xff, 0xff, 0xff, 0xff], // array32 of 4 billion
    [0xdd, 0x7f, 0xff, 0xff, 0xff, 0x90], // array32 of 2^31 - 1 with one element present
    [0xdb, 0x7f, 0xff, 0xff, 0xff, 0x61], // str32 of 2 GB with one byte present
    [0xde, 0xff, 0xff, 0xa1, 0x61], // map16 of 65535 with one key present
    [0xc6, 0x7f, 0xff, 0xff, 0xff], // bin32 of 2 GB
    [0xc9, 0x7f, 0xff, 0xff, 0xff, 0x00], // ext32 of 2 GB, type 0
    [0xc1], // the reserved token
  ]) {
    const r = timed(() => decodeInbound(tuple(header)))
    assert.ok(r.ms < MAX_MS, `${header[0].toString(16)}: ${r.ms} ms`)
    if (!r.threw) assertPlain(r.value)
  }
})

test('dense shapes within the 64 KiB cap decode within the time bound', () => {
  const n = 16000
  const shapes = {
    'empty arrays': tuple(bytes([0xdd, ...u32(65520)], Buffer.alloc(65520, 0x90))),
    fixmaps: tuple(bytes([0xdd, ...u32(n)], Buffer.from(Array(n).fill([0x81, 0xa1, 0x61, 0x00]).flat()))),
    'one-element arrays': tuple(bytes([0xdd, ...u32(32760)], Buffer.from(Array(32760).fill([0x91, 0x00]).flat()))),
    'one-char strings': tuple(bytes([0xdd, ...u32(32760)], Buffer.from(Array(32760).fill([0xa1, 0x61]).flat()))),
    'distinct keys': tuple(
      bytes(
        [0xdf, ...u32(10000)],
        ...Array.from({ length: 10000 }, (_, i) => bytes([0xa4], i.toString(36).padStart(4, 'k'), [0x00]))
      )
    ),
    'deep nesting': tuple(bytes(Buffer.alloc(65534, 0x91), [0x90])),
  }
  for (const [label, packet] of Object.entries(shapes)) {
    assert.ok(packet.length <= 65540, `${label}: ${packet.length} bytes`)
    const r = timed(() => decodeInbound(packet))
    assert.ok(r.ms < MAX_MS, `${label}: ${r.ms} ms`)
    if (r.threw) assert.ok(label === 'deep nesting', `${label} threw ${r.threw.message}`)
    else assertPlain(r.value)
  }
})

test('fuzz: random and adversarial bodies within the caps decode or fail within the time bound, never into a refused type', () => {
  let seed = 0x9e3779b9
  const rnd = () => {
    seed ^= seed << 13
    seed >>>= 0
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    return seed / 0x100000000
  }
  const int = n => Math.floor(rnd() * n)
  const pick = list => list[int(list.length)]
  const randomBytes = n => {
    const b = Buffer.alloc(n)
    for (let i = 0; i < n; i++) b[i] = int(256)
    return b
  }
  const extTypes = [0x00, 0x42, 0x62, 0x65, 0x69, 0x70, 0x72, 0x73, 0x74, 0x78, 0xff]
  const extHeader = (type, len) => {
    const forms = [[0xc9, ...u32(len), type]]
    if (len < 65536) forms.push([0xc8, len >> 8, len & 255, type])
    if (len < 256) forms.push([0xc7, len, type])
    for (const [size, token] of [
      [1, 0xd4],
      [2, 0xd5],
      [4, 0xd6],
      [8, 0xd7],
      [16, 0xd8],
    ]) {
      if (len === size) forms.push([token, type])
    }
    return pick(forms)
  }
  const numericTokens = () =>
    pick([
      [0xca, ...randomBytes(4)],
      [0xcb, ...randomBytes(8)],
      [0xcf, ...randomBytes(8)],
      [0xd3, ...randomBytes(8)],
      [0xd2, ...randomBytes(4)],
      [0xc0],
      [0xc2],
      [0xc3],
      [0xa1, 0x78],
      [int(128)],
      [0xe0 | int(32)],
    ])
  const generators = [
    () => randomBytes(1 + int(65535)),
    () => tuple(randomBytes(1 + int(65534))),
    () => tuple(bytes(Buffer.alloc(1 + int(65533), 0x91), [0x90])),
    () => {
      const n = 1 + int(65000)
      return tuple(bytes([0xdd, ...u32(n)], Buffer.alloc(n, 0x90)))
    },
    () => {
      const n = 1 + int(16000)
      return tuple(bytes([0xdd, ...u32(n)], Buffer.from(Array(n).fill([0x81, 0xa1, 0x61, 0x00]).flat())))
    },
    () => {
      const n = 1 + int(12000)
      return tuple(bytes([0xdf, ...u32(n)], ...Array.from({ length: n }, () => bytes([0xa3], randomBytes(3), [0x00]))))
    },
    () => {
      const type = rnd() < 0.7 ? pick(extTypes) : int(256)
      const len = pick([1, 2, 4, 8, 16, int(256), int(65000)])
      return tuple(bytes(extHeader(type, len), randomBytes(len)))
    },
    () => {
      // a record definition with random keys, followed by uses of defined and undefined record ids
      const id = 0x40 + int(64)
      const k = 1 + int(14)
      const keys = bytes([0x90 | k], ...Array.from({ length: k }, () => bytes([0xa2], randomBytes(2))))
      const values = Buffer.alloc(k, 0x00)
      const uses = bytes(...Array.from({ length: int(50) }, () => bytes([rnd() < 0.8 ? id : 0x40 + int(64)], values)))
      return tuple(bytes([0xdc, 0x00, 0x01 + int(50)], [0xd4, 0x72, id], keys, values, uses))
    },
    () =>
      tuple(
        pick([
          [0xdd, 0x7f, 0xff, 0xff, 0xff],
          [0xdb, ...u32(2 ** 31 - 1), 0x61],
          [0xde, 0xff, 0xff],
          [0xc6, ...u32(2 ** 31 - 1)],
          [0xc9, ...u32(2 ** 31 - 1), 0x42],
          [0xd9, 0xff],
          [0xc4, 0xff, 0x00],
        ])
      ),
    () => bytes(writePacket('entityEvent', ['a', 1, 'n', { k: 'v' }]), randomBytes(1 + int(100))),
    () => tuple(bytes(extHeader(0x62, 4), u32(int(70000)), randomBytes(int(200)))),
    () => {
      const n = 1 + int(4000)
      return tuple(bytes([0xdd, ...u32(n)], ...Array.from({ length: n }, numericTokens)))
    },
  ]
  let decoded = 0
  let refused = 0
  let slowest = 0
  for (let i = 0; i < 600; i++) {
    const packet = generators[i % generators.length]()
    const r = timed(() => decodeInbound(packet))
    slowest = Math.max(slowest, r.ms)
    assert.ok(r.ms < MAX_MS, `case ${i} (generator ${i % generators.length}, ${packet.length} bytes): ${r.ms} ms`)
    if (r.threw) refused++
    else {
      decoded++
      assertPlain(r.value)
    }
  }
  assert.ok(decoded > 50, `${decoded} decoded, ${refused} refused`)
  assert.ok(refused > 50, `${decoded} decoded, ${refused} refused`)
  assert.ok(slowest < MAX_MS, `slowest case ${slowest} ms`)
})
