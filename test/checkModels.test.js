// scripts/check-models.mjs is what an operator runs before upgrading a world: it must accept the bundled files,
// name a refused one with its reason, say so with its exit status, and never request what a file names.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkModel } from '../scripts/lib/checkModels.mjs'
import { glb } from './lib/glb.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const run = (...args) =>
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-models.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const line = (status, file) => new RegExp(`^${status}\\s+${escaped(file)}\\s`, 'm')

test('the bundled models, avatar and emotes pass the check', () => {
  const dir = path.join('src', 'world', 'assets')
  const result = run(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, line('ok', path.join(dir, 'avatar.vrm')))
  assert.match(result.stdout, /^\d+ files checked, 0 refused, 0 unreadable$/m)
  assert.doesNotMatch(result.stdout, /REFUSED/)
})

test('a refused file is named with its reason and makes the exit status 1; only model files are read', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-models-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const external = { asset: { version: '2.0' }, buffers: [{ uri: 'http://example.invalid/x.bin', byteLength: 4 }] }
  fs.writeFileSync(path.join(dir, 'external.gltf'), JSON.stringify(external))
  fs.writeFileSync(path.join(dir, 'fine.gltf'), JSON.stringify({ asset: { version: '2.0' } }))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a model')
  // entries that cannot be read: a model-named link to nothing, another link that is not a model, a missing path.
  // None of them may hide the files after it ("z" sorts last)
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'broken.glb'))
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'aaa-broken.txt'))
  fs.writeFileSync(path.join(dir, 'z-external.gltf'), JSON.stringify(external))
  const result = run(dir, path.join(dir, 'missing'))
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const refusal = /model file: a model may not reference external files/
  assert.match(result.stdout, line('REFUSED', path.join(dir, 'external.gltf')))
  assert.match(result.stdout, line('REFUSED', path.join(dir, 'z-external.gltf')))
  assert.match(result.stdout, refusal)
  assert.match(result.stdout, line('ok', path.join(dir, 'fine.gltf')))
  assert.doesNotMatch(result.stdout, /notes\.txt|aaa-broken/)
  assert.match(result.stderr, /cannot read .*broken\.glb/)
  assert.match(result.stderr, /cannot read .*missing/)
  assert.match(result.stdout, /^3 files checked, 2 refused, 2 unreadable$/m)
})

test('an unknown option is an error, not a path', () => {
  const result = run('--max-texture=4096')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown option --max-texture=4096/)
})

test('nothing a file names is requested: an external image is left out and the file is still judged', async t => {
  const requested = []
  t.mock.method(globalThis, 'fetch', async url => {
    requested.push(String(url))
    throw new Error('the check requested a URL')
  })
  // a triangle with a material whose texture is an image at a private address
  const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const file = glb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
      images: [{ uri: 'http://127.0.0.1:9/private.png' }],
      textures: [{ source: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    },
    new Uint8Array(triangle.buffer)
  )
  const used = await checkModel(file)
  assert.ok(used.bytes > 0 && used.bytes < 1)
  assert.deepEqual(requested, [], 'the external image was not requested')
})
