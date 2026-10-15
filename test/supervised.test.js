import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runSupervised } from './lib/supervised.mjs'

async function fixture(t, source) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbound-supervised-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'child.mjs')
  await fs.writeFile(file, source)
  return file
}

test('runSupervised: child uses the requested heap and exposes GC', async t => {
  const file = await fixture(
    t,
    `
    import assert from 'node:assert/strict'
    assert.equal(typeof global.gc, 'function')
    assert.ok(process.execArgv.includes('--max-old-space-size=24'))
    process.stdout.write('ok')
  `
  )
  const result = await runSupervised(file, { heapMb: 24 })
  assert.equal(result.stdout, 'ok')
  assert.equal(result.code, 0)
})

test('runSupervised: an assertion failure is reported separately from OOM', async t => {
  const file = await fixture(t, "throw new Error('ordinary failure')")
  await assert.rejects(runSupervised(file), err => err.kind === 'failure' && /ordinary failure/.test(err.stderr))
})

test('runSupervised: real child heap exhaustion is reported as OOM', async t => {
  const file = await fixture(t, 'const held = []; while (true) held.push(new Array(100000).fill(42))')
  await assert.rejects(runSupervised(file, { heapMb: 16 }), err => err.kind === 'oom')
})

test('runSupervised: a stalled child is killed and reported as a timeout', async t => {
  const file = await fixture(t, 'setInterval(() => {}, 1000)')
  await assert.rejects(runSupervised(file, { timeout: 200 }), err => err.kind === 'timeout')
})
