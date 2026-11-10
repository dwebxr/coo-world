import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import v8 from 'node:v8'
import vm from 'node:vm'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { checkGLTF, createGLTFBudget, dataURIPayload, GLTF_LIMITS, isDataURI } from '../src/core/extras/gltfLimits.js'
import { readImageHeader } from '../src/core/extras/imageHeader.js'
import { IMAGE_HEADER_BYTES } from '../src/core/extras/imageHeader.js'
import { png, jpeg } from './lib/imageBytes.mjs'
import { glb } from './lib/glb.mjs'

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
  // the first 256 KiB first (a refused image costs only them), then, the image accepted, the whole of it, once: the
  // array returned is what the parser decodes. A PNG of 1 MB (its header in the window), a JPEG whose frame header
  // comes after 325 KB (read from the whole); each array charged before it is made
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
    ['charge', MiB, 'data: image'],
    ['array', MiB],
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

// The reviewer's probe: a percent-encoded JPEG whose bytes differ between a decoder that reads a raw character as its
// low byte (the budget's) and a fetch of the data: URL, whose URL parser drops tabs (or UTF-8-encodes a character past
// ASCII) before it percent-decodes: the budget read a 16 x 16 frame, the browser decoded a 20000 x 20000 one
function twoViews(mode) {
  const sof = (h, w) => [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    0x03,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]
  const T = new Array(65600).fill(0)
  T[0] = 0xff
  T[1] = 0xe2
  T[2] = 0xff
  T[3] = 0xc0
  const big = sof(20000, 20000).slice(2)
  big.forEach((b, i) => (T[4 + i] = b))
  const comAt = 4 + big.length
  T[comAt] = 0xff
  T[comAt + 1] = 0xfe
  T[comAt + 2] = 0xff
  T[comAt + 3] = 0xfe
  ;[...sof(16, 16), ...sos].forEach((b, i) => (T[2 + 0xffc0 + i] = b))
  sos.forEach((b, i) => (T[comAt + 2 + 0xfffe + i] = b))
  const pct = bytes => bytes.map(b => '%' + b.toString(16).padStart(2, '0')).join('')
  const head = pct([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, 1, 2, 3, 4, 5, 6])
  const odd = mode === 'tab' ? '\t\t' : String.fromCharCode(0x800) + '%00'
  return flat('data:image/jpeg,' + head + odd + pct(T))
}
const vec3 = (count, more = {}) => ({ componentType: 5126, type: 'VEC3', count, ...more })
const imageModel = uri =>
  glb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, emissiveTexture: { index: 1 } }],
    textures: [{ source: 0 }, { source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728 }],
    images: [{ uri }],
    accessors: [vec3(3, { min: [0, 0, 0], max: [0, 0, 0] })],
  })

test('a data: image is one byte sequence: refused at the door where decoders disagree, never fetched in a model', async t => {
  // the two views: the budget's decoder and a fetch of the URL make different bytes of the same text
  for (const mode of ['tab', 'utf8']) {
    const uri = twoViews(mode)
    const fetched = new Uint8Array(await (await fetch(uri)).arrayBuffer())
    assert.equal(readImageHeader(dataURIPayload(uri).decode()).width, 16)
    assert.notEqual(readImageHeader(fetched).width, 16, `${mode}: the fetch makes other bytes`)
    // at the door: a percent-encoded payload is printable ASCII without `#`
    assert.throws(() => checkGLTF(imageModel(uri)), /payload has a character other than printable ASCII, or a #/)
  }
  for (const payload of ['%41 %42', '%41#%42', `%41${String.fromCharCode(0x7f)}`, '%41é']) {
    assert.throws(
      () => checkGLTF(imageModel(`data:image/png,${payload}`)),
      /other than printable ASCII, or a #/,
      payload
    )
  }
  // with the check bypassed (a budget, no check), the parser decodes the very bytes the budget sized: the Blob the
  // decoder is handed holds the budget's array, and no data: image URL is fetched
  const handed = []
  t.mock.method(globalThis, 'createImageBitmap', async blob => {
    handed.push(new Uint8Array(await blob.arrayBuffer()))
    return { width: 16, height: 16, close() {} }
  })
  const fetches = []
  const realFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (input, init) => {
    fetches.push(String(typeof input === 'string' ? input : input.url).slice(0, 5))
    return realFetch(input, init)
  })
  const created = []
  const revoked = []
  const realCreate = URL.createObjectURL
  const realRevoke = URL.revokeObjectURL
  t.mock.method(URL, 'createObjectURL', blob => {
    const url = realCreate(blob)
    created.push(url)
    return url
  })
  t.mock.method(URL, 'revokeObjectURL', url => {
    revoked.push(url)
    return realRevoke(url)
  })
  const parse = async uri => {
    const file = imageModel(uri)
    const budget = createGLTFBudget({ fileBytes: file.byteLength })
    const gltf = await new GLTFLoader().parseAsync(file, '', budget)
    let map = null
    gltf.scene.traverse(o => o.isMesh && (map = o.material.map))
    return { map, budget }
  }
  for (const mode of ['tab', 'utf8']) {
    handed.length = 0
    const uri = twoViews(mode)
    const { budget } = await parse(uri)
    assert.equal(handed.length, 1, 'one decode for the two textures on the image')
    assert.deepEqual(handed[0], dataURIPayload(uri).decode(), `${mode}: the decoder got the budget's bytes`)
    assert.equal(budget.used.pixels, 16 * 16)
  }
  // base64 and percent-encoded images still load, through a Blob each, revoked once loaded
  for (const uri of [base64URI('image/png', png(32, 32)), percentURI('image/png', png(32, 32))]) {
    handed.length = 0
    const { map } = await parse(uri)
    assert.ok(map?.image, 'the texture loaded')
    assert.deepEqual(handed[0], dataURIPayload(uri).decode())
  }
  assert.ok(!fetches.includes('data:'), 'no data: URL was fetched')
  assert.equal(created.length, 4)
  assert.deepEqual(revoked, created, 'every object URL revoked')
  // a refused one is revoked too, and costs its window: a 4 MB PNG of 100000 x 100000 (nothing created for it)
  await assert.rejects(parse(base64URI('image/png', padded(png(100000, 100000), 4 * MiB))), /larger than/)
  assert.deepEqual(revoked, created)
})

test('a data: buffer: decoded by the decoder the check sized it with, at least its byteLength, never fetched', async t => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const model = (uri, byteLength = 36) =>
    text({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [1, 1, 0] })],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength, uri }],
    })
  const bytes = new Uint8Array(positions.buffer)
  // the check sizes it with the parser's decoder: data shorter than its byteLength is refused (the parser's arrays
  // threw a RangeError on it)
  assert.throws(
    () => checkGLTF(model(base64URI('application/octet-stream', bytes.subarray(0, 24)))),
    /buffer 0 has 24 bytes of data, fewer than its byteLength \(36\)/
  )
  assert.throws(
    () => checkGLTF(model('data:application/octet-stream;base64,@@@@')),
    /buffer 0 is a data: URI that does not decode/
  )
  // with a budget, the parser decodes it with that decoder, charged at its size, and never fetches the URL
  const fetches = []
  const realFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (input, init) => {
    fetches.push(String(typeof input === 'string' ? input : input.url).slice(0, 5))
    return realFetch(input, init)
  })
  for (const uri of [base64URI('application/octet-stream', bytes), percentURI('application/octet-stream', bytes)]) {
    const file = model(uri)
    const charges = []
    const budget = createGLTFBudget({
      fileBytes: file.byteLength,
      onCharge: (kind, n, what) => charges.push([kind, n, what]),
    })
    checkGLTF(file, GLTF_LIMITS, budget)
    const gltf = await new GLTFLoader().parseAsync(file.buffer, '', budget)
    let geometry = null
    gltf.scene.traverse(o => o.isMesh && (geometry = o.geometry))
    assert.deepEqual([...geometry.attributes.position.array], [...positions])
    assert.deepEqual(
      charges.filter(c => c[2] === 'data: buffer'),
      [['bytes', 36, 'data: buffer']]
    )
  }
  assert.ok(!fetches.includes('data:'), 'no data: URL was fetched')
})

test('only a buffer or an image has a URI: a `uri` elsewhere is a string like any other', () => {
  // the reviewer's probe: a data: string under any key named `uri` (a node's, the asset's) was counted as a payload,
  // out of the structure, though nothing reads it
  const long = 'data:,' + 'x'.repeat(20000)
  assert.throws(
    () => checkGLTF(text({ asset: { version: '2.0' }, nodes: [{ uri: long }] })),
    /nodes 0 uri is 20006 characters long, more than 1024/
  )
  assert.throws(
    () => checkGLTF(text({ asset: { version: '2.0', uri: long } })),
    /asset uri is 20006 characters long, more than 16384/
  )
  assert.ok(checkGLTF(text({ asset: { version: '2.0' }, nodes: [{ uri: 'data:,short' }] })))
})

test('an image is handed to the decoder as the type its bytes are, not the type the document declares', async t => {
  // the reviewer's probe: a PNG declared image/webp went in a Blob of type image/webp (WebKit's <img> may not show
  // it). The Blob's type is the header reader's, on both paths: an image in a bufferView and one in a data: URI
  const types = []
  t.mock.method(globalThis, 'createImageBitmap', async blob => {
    types.push(blob.type)
    return { width: 16, height: 16, close() {} }
  })
  const image = png(16, 16)
  const bin = new Uint8Array(36 + image.length)
  bin.set(image, 36)
  const file = glb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, emissiveTexture: { index: 1 } }],
      textures: [{ source: 0 }, { source: 1 }],
      images: [
        { bufferView: 1, mimeType: 'image/webp' },
        { uri: `data:image/webp;base64,${Buffer.from(image).toString('base64')}`, mimeType: 'image/webp' },
      ],
      accessors: [vec3(3, { bufferView: 0, min: [0, 0, 0], max: [0, 0, 0] })],
      bufferViews: [
        { buffer: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: image.length },
      ],
      buffers: [{ byteLength: bin.length }],
    },
    bin
  )
  const budget = createGLTFBudget({ fileBytes: file.byteLength })
  checkGLTF(file, GLTF_LIMITS, budget)
  await new GLTFLoader().parseAsync(file, '', budget)
  assert.deepEqual(types, ['image/png', 'image/png'])
})
