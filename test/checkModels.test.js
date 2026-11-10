// scripts/check-models.mjs is what an operator runs before upgrading a world: it must accept the bundled files,
// name a refused one with its reason, say so with its exit status, and never request what a file names.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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

test('a wrong argument is an error and nothing is checked', () => {
  const unknown = run('--max-texture=4096')
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown option --max-texture=4096/)
  // a size the budget would quietly ignore must not pass for the size asked
  for (const value of ['0', '-1', '4096.5', '1e999', '99999999999999999999', 'abc', '']) {
    const result = run(`--max-texture-size=${value}`, path.join('src', 'world', 'assets'))
    assert.equal(result.status, 2, `--max-texture-size=${value}: ${result.stdout}`)
    assert.match(result.stderr, /--max-texture-size needs a positive whole number/)
    assert.equal(result.stdout, '', 'nothing was checked')
  }
  assert.equal(run('--max-texture-size=4096', path.join('src', 'world', 'assets', 'avatar.vrm')).status, 0)
})

test('a long report reaches a slow reader whole, with its last line', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-models-many-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // far more output than a pipe holds (64 KiB): 1,500 lines of about 150 characters
  const COUNT = 1500
  for (let i = 0; i < COUNT; i++) {
    fs.writeFileSync(path.join(dir, `file-${String(i).padStart(4, '0')}.gltf`), '{"asset":{"version":"2.0"}}')
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'check-models.mjs'), dir], { cwd: ROOT })
  t.after(() => child.kill('SIGKILL'))
  let out = ''
  child.stdout.setEncoding('utf8').on('data', text => (out += text))
  child.stderr.resume()
  // the reader is not there while the report is written
  child.stdout.pause()
  await new Promise(resolve => setTimeout(resolve, 3000))
  child.stdout.resume()
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the script did not finish within 60 s')), 60_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  assert.equal(status, 0)
  const lines = out.split('\n').filter(Boolean)
  assert.equal(lines.filter(text => text.startsWith('ok ')).length, COUNT, 'every file has its line')
  assert.equal(lines.at(-1), `${COUNT} files checked, 0 refused, 0 unreadable`)
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
