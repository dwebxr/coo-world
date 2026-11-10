import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import Database from 'better-sqlite3'
import { WireClient } from './e2e/lib/ws.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function run(args, { cwd = root, env = {} } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const proc = { child, out: '', code: undefined }
  child.stdout.on('data', data => (proc.out += data))
  child.stderr.on('data', data => (proc.out += data))
  proc.exited = once(child, 'exit').then(([code, signal]) => (proc.code = code ?? signal))
  proc.waitFor = async (text, ms = 60000) => {
    const deadline = Date.now() + ms
    while (!proc.out.includes(text)) {
      if (proc.code !== undefined) throw new Error(`exited (${proc.code}) before "${text}":\n${proc.out.slice(-3000)}`)
      if (Date.now() > deadline) throw new Error(`no "${text}" within ${ms} ms:\n${proc.out.slice(-3000)}`)
      await sleep(20)
    }
  }
  return proc
}

// the signal handling itself, in a process of its own (src/server/shutdown.js with a scripted final save)
const child = mode => run([path.join(root, 'test/lib/shutdownChild.mjs'), mode, '300'])

test('shutdown: a second signal during a stalled final save exits at once with 1', async () => {
  const proc = child('stall')
  await proc.waitFor('ready', 10000)
  proc.child.kill('SIGTERM')
  await proc.waitFor('flush started deadline=300')
  const sent = Date.now()
  proc.child.kill('SIGINT')
  await proc.exited
  assert.equal(proc.code, 1)
  assert.ok(Date.now() - sent < 300, 'did not wait for the deadline')
  assert.match(proc.out, /SIGINT again: exiting without waiting for the final save/)
  assert.ok(proc.out.indexOf('world stopped') < proc.out.indexOf('server closing'))
})

test('shutdown: a final save that never returns still ends the process after its deadline, with 1', async () => {
  const proc = child('stall')
  await proc.waitFor('ready', 10000)
  const sent = Date.now()
  proc.child.kill('SIGTERM')
  await proc.exited
  assert.equal(proc.code, 1)
  assert.ok(Date.now() - sent >= 300)
  assert.match(proc.out, /the final save did not return in time; exiting/)
})

test('shutdown: a failed final save exits 1, a completed one 0', async () => {
  for (const [mode, code] of [
    ['reject', 1],
    ['ok', 0],
  ]) {
    const proc = child(mode)
    await proc.waitFor('ready', 10000)
    proc.child.kill('SIGTERM')
    await proc.exited
    assert.equal(proc.code, code, mode)
    if (mode === 'reject') assert.match(proc.out, /final save failed: final save incomplete/)
  }
})

// the built server on a throwaway world with real SQLite: what was edited just before the stop is on disk after it
let dir
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-world-'))
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  // the server finds src/world (built-in assets, collections, scene) and build/public beside its build
  fs.symlinkSync(path.join(root, 'src'), path.join(dir, 'src'), 'dir')
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const build = path.join(dir, 'build')
  fs.mkdirSync(build)
  fs.cpSync(path.join(root, 'src/client/public'), path.join(build, 'public'), { recursive: true })
  for (const name of ['physx-js-webidl.js', 'physx-js-webidl.wasm']) {
    fs.copyFileSync(path.join(root, 'src/core', name), path.join(build, name))
  }
  await esbuild.build({
    entryPoints: [path.join(root, 'src/server/index.js')],
    outfile: path.join(build, 'index.js'),
    platform: 'node',
    format: 'esm',
    bundle: true,
    packages: 'external',
    external: ['*physx-js-webidl.js'],
    define: { 'process.env.CLIENT': 'false', 'process.env.SERVER': 'true' },
    logLevel: 'silent',
  })
})
after(() => dir && fs.rmSync(dir, { recursive: true, force: true }))

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  server.close()
  await once(server, 'close')
  return port
}

test('shutdown: SIGTERM saves the edited blueprint and app and the pending world.set, then exits 0', async t => {
  const port = await freePort()
  const world = path.join(dir, 'world')
  fs.mkdirSync(path.join(world, 'assets'), { recursive: true })
  // sets a key once at start, and again 100 ms later: that second write is throttled to a second after the first
  fs.writeFileSync(
    path.join(world, 'assets', 'shutdown-probe.js'),
    `if (world.isServer) {
      world.set('shutdown-key', { saved: 1 })
      setTimeout(() => {
        world.set('shutdown-key', { saved: 2 })
        console.log('[shutdown-probe] stored')
      }, 100)
    }`
  )
  const server = run([path.join(dir, 'build/index.js')], {
    cwd: dir,
    env: {
      WORLD: 'world',
      PORT: String(port),
      JWT_SECRET: 'shutdown-test-secret-0123456789abcdef',
      ADMIN_CODE: 'shutdown',
      SAVE_INTERVAL: '60',
      CLEAN: 'false',
      ASSETS: 'local',
      ASSETS_BASE_URL: `http://localhost:${port}/assets`,
      PUBLIC_WS_URL: `ws://localhost:${port}/ws`,
      PUBLIC_API_URL: `http://localhost:${port}/api`,
      PUBLIC_MAX_UPLOAD_SIZE: '12',
    },
  })
  t.after(() => server.code === undefined && server.child.kill('SIGKILL'))
  await server.waitFor(`server listening on port ${port}`)
  const client = await new WireClient(port, 'builder').connect()
  t.after(() => client.close())
  await client.becomeAdmin('shutdown')
  client.installApp({ id: 'shutdown-app', script: 'asset://shutdown-probe.js', props: { edited: true } })
  await server.waitFor('[shutdown-probe] stored', 20000)
  // a connection is still open: the stop does not wait for it
  server.child.kill('SIGTERM')
  await server.exited
  assert.equal(server.code, 0, server.out.slice(-2000))
  assert.match(server.out, /\[server\] SIGTERM: saving the world before exit/)
  assert.match(server.out, /\[network\] final save complete/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(world, 'storage.json'), 'utf8')), {
    'shutdown-key': { saved: 2 },
  })
  const db = new Database(path.join(world, 'db.sqlite'), { readonly: true })
  try {
    const blueprint = db.prepare('select data from blueprints where id = ?').get('shutdown-app-bp')
    assert.ok(blueprint, 'the blueprint added before the stop is stored')
    assert.deepEqual(JSON.parse(blueprint.data).props, { edited: true })
    const app = db.prepare('select data from entities where id = ?').get('shutdown-app')
    assert.equal(JSON.parse(app.data).blueprint, 'shutdown-app-bp')
  } finally {
    db.close()
  }
})
