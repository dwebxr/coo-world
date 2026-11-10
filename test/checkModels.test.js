// scripts/check-models.mjs is what an operator runs before upgrading a world: it must accept the bundled files,
// name a refused one with its reason, and say so with its exit status.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const run = (...args) =>
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-models.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })

test('the bundled models, avatar and emotes pass the check', () => {
  const result = run(path.join('src', 'world', 'assets'))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /^ok {7}src\/world\/assets\/avatar\.vrm {2}\(/m)
  assert.match(result.stdout, /^\d+ files checked, 0 refused or unreadable$/m)
  assert.doesNotMatch(result.stdout, /REFUSED/)
})

test('a refused file is named with its reason and makes the exit status 1; only model files are read', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-models-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const external = { asset: { version: '2.0' }, buffers: [{ uri: 'http://example.invalid/x.bin', byteLength: 4 }] }
  fs.writeFileSync(path.join(dir, 'external.gltf'), JSON.stringify(external))
  fs.writeFileSync(path.join(dir, 'fine.gltf'), JSON.stringify({ asset: { version: '2.0' } }))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a model')
  const result = run(dir, path.join(dir, 'missing'))
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /^REFUSED {2}.*external\.gltf {2}model file: a model may not reference external files/m)
  assert.match(result.stdout, /^ok {7}.*fine\.gltf/m)
  assert.doesNotMatch(result.stdout, /notes\.txt/)
  assert.match(result.stderr, /cannot read .*missing/)
  assert.match(result.stdout, /^2 files checked, 2 refused or unreadable$/m)
})
