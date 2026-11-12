// scripts/lib/finalizePhysxBuild.mjs, the last step of the server and node-client builds: a build that failed must
// fail the script (it exited 0), and in dev it must leave the running fork alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { context } from 'esbuild'
import { makePhysxFinalizePlugin } from '../scripts/lib/finalizePhysxBuild.mjs'

// a project of the test's own: the two PhysX files the plugin copies, and one entry
function project(t, source) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-finalize-'))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(rootDir, 'src/core'), { recursive: true })
  fs.writeFileSync(path.join(rootDir, 'src/core/physx-js-webidl.js'), '// physx')
  fs.writeFileSync(path.join(rootDir, 'src/core/physx-js-webidl.wasm'), 'wasm')
  fs.writeFileSync(path.join(rootDir, 'entry.js'), source)
  return rootDir
}

// one build of `source` through the plugin: what it exited with, what it said, and what is in build/
async function build(t, source, { dev = false } = {}) {
  const rootDir = project(t, source)
  const exits = []
  const said = []
  const started = []
  const ctx = await context({
    entryPoints: [path.join(rootDir, 'entry.js')],
    outfile: path.join(rootDir, 'build/index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [
      makePhysxFinalizePlugin({
        rootDir,
        dev,
        forkEntry: 'build/index.js',
        // (what dev starts is recorded, not run)
        start: entry => (started.push(path.relative(rootDir, entry)), { kill() {} }),
        exit: code => exits.push(code),
        log: { error: line => said.push(line) },
      }),
    ],
  })
  t.after(() => ctx.dispose())
  const failed = await ctx.rebuild().then(
    () => false,
    () => true
  )
  const built = fs.existsSync(path.join(rootDir, 'build')) ? fs.readdirSync(path.join(rootDir, 'build')).sort() : []
  return { exits, said, started, built, failed }
}

test('build: a production build that fails exits 1, and one that succeeds copies PhysX and exits 0', async t => {
  const good = await build(t, 'export const a = 1')
  assert.deepEqual(good.exits, [0])
  assert.deepEqual(good.started, [], 'a production build starts nothing')
  assert.equal(good.failed, false)
  assert.deepEqual(good.built, ['index.js', 'physx-js-webidl.js', 'physx-js-webidl.wasm'])
  // a syntax error, and an import that does not resolve
  for (const source of ['export const a = ;', "import x from './nothing-here.js'\nexport default x"]) {
    const bad = await build(t, source)
    assert.deepEqual(bad.exits, [1], source)
    assert.equal(bad.failed, true)
    assert.deepEqual(bad.said, [])
    assert.ok(!bad.built.includes('physx-js-webidl.js'), 'nothing is finished for a build that failed')
  }
})

test('build: in dev a failed build leaves the running fork alone and says so', async t => {
  const bad = await build(t, 'export const a = ;', { dev: true })
  assert.deepEqual(bad.exits, [], 'the dev process goes on')
  assert.deepEqual(bad.started, [], 'and nothing is started on the output of a failed build')
  assert.equal(bad.said.length, 1)
  assert.match(bad.said[0], /^\[build\] failed \(1 errors\): build\/index\.js is left running as it was$/)
  assert.ok(!bad.built.includes('physx-js-webidl.js'))
  // (a dev build that succeeds starts its output and does not exit)
  const good = await build(t, 'export const a = 1', { dev: true })
  assert.deepEqual(good.exits, [])
  assert.deepEqual(good.started, [path.join('build', 'index.js')])
  assert.deepEqual(good.said, [])
  assert.deepEqual(good.built, ['index.js', 'physx-js-webidl.js', 'physx-js-webidl.wasm'])
})
