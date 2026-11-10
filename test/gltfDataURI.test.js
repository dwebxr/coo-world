import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import v8 from 'node:v8'
import vm from 'node:vm'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { checkGLTF, createGLTFBudget, dataURIPayload, GLTF_LIMITS, isDataURI } from '../src/core/extras/gltfLimits.js'
import { IMAGE_HEADER_BYTES } from '../src/core/extras/imageHeader.js'
import { png, jpeg } from './lib/imageBytes.mjs'

// A model's data: URIs: the budget's own decode of a data: image (charged before each array it makes, straight into
// arrays of the decoded size, the whole image only when its header is not settled in the first 256 KiB), the one test
// of what a data: URI is, and a .gltf's structure held to a GLB's JSON limit without its data: payloads.
const MiB = 1024 * 1024
const text = json => new TextEncoder().encode(JSON.stringify(json))
// a URI as the parser meets it: one flat string, as JSON.parse makes it (a concatenation is flattened, a copy, the
// first time it is read)
const flat = uri => JSON.parse(JSON.stringify(uri))
const base64URI = (type, bytes) => flat(`data:${type};base64,${Buffer.from(bytes).toString('base64')}`)
const HEX = new TextEncoder().encode('0123456789abcdef')
const percentURI = (type, bytes) => {
  const chars = new Uint8Array(bytes.length * 3)
  for (let i = 0; i < bytes.length; i++) {
    chars[3 * i] = 37
    chars[3 * i + 1] = HEX[bytes[i] >> 4]
    chars[3 * i + 2] = HEX[bytes[i] & 15]
  }
  return flat(`data:${type},${new TextDecoder('latin1').decode(chars)}`)
}
// an image of `size` bytes: its header, then zeros
const padded = (header, size) => {
  const bytes = new Uint8Array(size)
  bytes.set(header)
  return bytes
}
// a JPEG whose frame header comes after 325 KB of APP1 segments: not settled within the first 256 KiB
const LATE_JPEG = jpeg(64, 64, { before: Array(5).fill([0xe1, 65000]) })
const lateJPEG = size => padded(LATE_JPEG, size)

// (the tests' own garbage collected between them: the fixtures are tens of MB)
v8.setFlagsFromString('--expose_gc')
const gc = vm.runInNewContext('gc')

const globals = {}
before(() => {
  for (const name of ['self', 'createImageBitmap', 'ProgressEvent']) globals[name] = globalThis[name]
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => ({ width: 64, height: 64, close() {} })
  globalThis.ProgressEvent ??= class extends Event {}
})
after(() => {
  for (const [name, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[name]
    else globalThis[name] = value
  }
})

test('a data: URI is one whatever the case of its scheme: the check, the parser, the budget and the client agree', () => {
  for (const uri of ['data:,', 'DATA:image/png;base64,AA==', 'Data:x/y,1', 'dAtA:;base64,'])
    assert.ok(isDataURI(uri), uri)
  for (const uri of [' data:,', 'data', 'datax:,', 'blob:data:,', 'https://data:x', 'dat:a,', undefined, 5]) {
    assert.equal(isDataURI(uri), false, String(uri))
  }
  // the reviewer's probe: an upper-case scheme was a relative URI to the check (capped, a buffer refused as an
  // external file) and data to the parser and the budget
  const long = 'DATA:image/png;base64,' + Buffer.from(padded(png(4, 4), 3000)).toString('base64')
  assert.ok(checkGLTF(text({ asset: { version: '2.0' }, images: [{ uri: long }] })))
  const buffer = 'DATA:application/octet-stream;base64,AAAAAA=='
  assert.ok(checkGLTF(text({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: buffer }] })))
  // a space before base64, and base64 broken into lines, stay refused
  for (const uri of ['data:image/png; base64,AAAA', 'data:image/png;base64,AAAA\nAAAA']) {
    assert.throws(
      () => checkGLTF(text({ asset: { version: '2.0' }, images: [{ uri }] })),
      /a parameter that is not|a line break/
    )
  }
})

test('a data: payload decodes as atob and the old decoder did, into an array of its size', () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) % 256)
  for (const length of [0, 1, 2, 3, 4, 5, 999, 1000]) {
    const part = bytes.subarray(0, length)
    const b64 = Buffer.from(part).toString('base64')
    for (const payload of [b64, b64.replace(/=+$/, ''), ` ${b64.slice(0, 3)}\t${b64.slice(3)} `]) {
      const decoded = dataURIPayload(`data:x/y;base64,${payload}`)
      assert.equal(decoded.size, length, payload)
      assert.deepEqual(decoded.decode(), part)
      assert.deepEqual(decoded.decode(7), part.subarray(0, 7), 'its first bytes')
    }
    const percent = dataURIPayload(percentURI('x/y', part))
    assert.equal(percent.size, length)
    assert.deepEqual(percent.decode(), part)
  }
  // percent-encoded: any other character is its low byte, a `%` without two hex digits itself
  assert.deepEqual(dataURIPayload('data:,a%4Gb%41%z').decode(), Uint8Array.from([97, 37, 52, 71, 98, 65, 37, 122]))
  // base64 that atob refuses is refused
  for (const payload of ['@@@@', 'A', 'AAAAA', 'AA=A', 'AAA==', 'AA===', '=AAA', 'AAÀA']) {
    let atobRefused = false
    try {
      atob(payload)
    } catch {
      atobRefused = true
    }
    assert.ok(atobRefused, `atob takes ${payload}`)
    assert.throws(() => dataURIPayload(`data:x/y;base64,${payload}`), /not valid base64/, payload)
  }
})

test("the budget's decode of a data: image: charged before each array, the decoded size, the whole only when needed", () => {
  // a PNG of 1 MB: its header in the first 256 KiB, which are all that is decoded and charged. A JPEG whose frame
  // header comes after 325 KB: the first 256 KiB, then the whole of it, each charged before it is made
  const uris = [
    base64URI('image/png', padded(png(16, 16), MiB)),
    base64URI('image/jpeg', lateJPEG(2 * MiB)),
    percentURI('image/jpeg', lateJPEG(MiB)),
  ]
  const RealArray = Uint8Array
  const events = []
  const budget = createGLTFBudget({ onCharge: (kind, n, what) => kind === 'bytes' && events.push(['charge', n, what]) })
  // the arrays of the decode (64 KiB and more), in order with the charges
  globalThis.Uint8Array = class extends RealArray {
    constructor(...args) {
      if (typeof args[0] === 'number' && args[0] >= 65536) events.push(['array', args[0]])
      super(...args)
    }
  }
  try {
    uris.forEach((uri, i) => budget.imageURI(uri, `image ${i}`))
  } finally {
    globalThis.Uint8Array = RealArray
  }
  const window = IMAGE_HEADER_BYTES
  assert.deepEqual(events, [
    ['charge', window, 'data: image'],
    ['array', window],
    ['charge', window, 'data: image'],
    ['array', window],
    ['charge', 2 * MiB, 'data: image'],
    ['array', 2 * MiB],
    ['charge', window, 'data: image'],
    ['array', window],
    ['charge', MiB, 'data: image'],
    ['array', MiB],
  ])
  assert.equal(budget.used.counts.images, 3)
  // a refused image costs its window: a 4 MB PNG of 100000 x 100000 is refused from its first 256 KiB
  const refused = createGLTFBudget()
  const huge = base64URI('image/png', padded(png(100000, 100000), 4 * MiB))
  assert.throws(() => refused.imageURI(huge, 'image 0'), /larger than/)
  assert.equal(refused.used.bytes, window)
})

test('decoding an N-byte data: image allocates about N, not an intermediate string or list of it', () => {
  // the reviewer's probe: a 15 MB URI took 300 to 380 MB of heap, through an atob string and a list of numbers, with
  // nothing charged. Here, 2 MiB decoded (a JPEG the whole of which is read) must grow the heap by less than 3 x 2 MiB
  const size = 2 * MiB
  for (const [encoding, uri] of [
    ['base64', base64URI('image/jpeg', lateJPEG(size))],
    ['percent-encoded', percentURI('image/jpeg', lateJPEG(size))],
  ]) {
    const budget = createGLTFBudget()
    gc()
    const before = process.memoryUsage()
    budget.imageURI(uri, 'image 0')
    const after = process.memoryUsage()
    const grown = after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers
    assert.ok(grown < 3 * size, `${encoding}: ${(grown / MiB).toFixed(1)} MiB for ${size / MiB} MiB decoded`)
    assert.equal(budget.used.bytes, IMAGE_HEADER_BYTES + size)
  }
})

test('a .gltf is held to the JSON limit without its data: payloads; a large data: buffer in it loads', async () => {
  gc()
  // a .gltf's text of `size` characters of `char` between a prefix and a suffix, built as bytes (no string of it)
  const document = (prefix, char, size, suffix) => {
    const [head, tail] = [prefix, suffix].map(part => new TextEncoder().encode(part))
    const bytes = new Uint8Array(head.length + size + tail.length)
    bytes.set(head)
    bytes.fill(char.charCodeAt(0), head.length, head.length + size)
    bytes.set(tail, head.length + size)
    return bytes
  }
  // the reviewer's probe: a plain .gltf was not held to the 16 MiB a GLB's JSON chunk is (a 20 MB one passed). Its
  // structure is now: 17 MiB of it is refused (here an extension's text nothing reads)
  const big = document('{"asset":{"version":"2.0"},"extensions":{"X_notes":{"text":"', 'x', 17 * MiB, '"}}}')
  assert.throws(() => checkGLTF(big), /the JSON is \d+ characters without its data: URIs' payloads, more than 16777216/)
  // 1 MiB of structure (1000 nodes named with 1000 characters) and a data: buffer of 17 MiB of base64 pass: the
  // payload is data, charged where it is decoded
  const structure = buffer => ({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: Array.from({ length: 1000 }, (_, i) => ({
      name: `${i}`.padEnd(1000, 'n'),
      ...(i === 0 ? { mesh: 0 } : {}),
    })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [0, 0, 0] }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: buffer, uri: 'URI' }],
  })
  const [before, after] = JSON.stringify(structure(12.75 * MiB)).split('"URI"')
  const large = document(`${before}"data:application/octet-stream;base64,`, 'A', 17 * MiB, `"${after}`)
  assert.ok(large.length > 17 * MiB)
  assert.ok(checkGLTF(large))
  // and such a .gltf loads, as the client loads it (a data: buffer of 1 MiB here: the parse fetches and decodes it)
  const [head, tail] = JSON.stringify(structure(0.75 * MiB)).split('"URI"')
  const file = document(`${head}"data:application/octet-stream;base64,`, 'A', MiB, `"${tail}`)
  const budget = createGLTFBudget({ fileBytes: file.byteLength })
  checkGLTF(file, GLTF_LIMITS, budget)
  const parsed = await new GLTFLoader().parseAsync(file.buffer, '', budget)
  assert.equal(parsed.scene.children.length, 1)
})
