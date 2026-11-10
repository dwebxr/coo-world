import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import v8 from 'node:v8'
import vm from 'node:vm'
import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { checkGLTF, createGLTFBudget, GLTF_LIMITS } from '../src/core/extras/gltfLimits.js'

// A .gltf's structure held to a GLB's JSON limit without the payloads of its data: URIs (a file of its own: its
// documents are tens of MB)
const MiB = 1024 * 1024
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
