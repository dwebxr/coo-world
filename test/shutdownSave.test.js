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
import { loadNetwork } from './lib/network.mjs'

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
  // 'close': the process has exited and its output streams are drained
  proc.exited = once(child, 'close').then(([code, signal]) => (proc.code = code ?? signal))
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

// the real network the `slowdb` and `slowconfig` children save with, built here and handed to them: a child that
// is killed leaves no folder behind, and the folder goes once the children are gone
let network
before(async () => {
  network = await loadNetwork()
})
after(() => network?.destroy())

// the signal handling itself, in a process of its own (src/server/shutdown.js with a scripted final save). No
// assertion depends on how fast a loaded machine runs: each test only bounds the whole run (its timeout)
const child = (mode, deadline = 300) =>
  run([
    path.join(root, 'test/lib/shutdownChild.mjs'),
    mode,
    String(deadline),
    JSON.stringify({ url: network.url, env: network.env }),
  ])
const lines = proc => proc.out.split('\n')

test(
  'shutdown: a second signal during a stalled final save exits with 1 without waiting',
  { timeout: 60000 },
  async () => {
    // a deadline far beyond the test's timeout: only the second signal can end the process in time
    const proc = child('stall', 600000)
    await proc.waitFor('ready')
    proc.child.kill('SIGTERM')
    await proc.waitFor('flush started deadline=600000')
    proc.child.kill('SIGINT')
    await proc.exited
    assert.equal(proc.code, 1)
    const out = lines(proc)
    const order = ['world stopped', 'flush started deadline=600000', 'server closing']
    assert.deepEqual(
      out.filter(line => order.includes(line)),
      order,
      'world stopped, then the save, then the listener'
    )
    assert.ok(out.includes('[server] SIGINT again: exiting without waiting for the final save'))
    assert.ok(!proc.out.includes('did not return in time'))
  }
)

test(
  'shutdown: a final save that never returns still ends the process after its deadline, with 1',
  { timeout: 60000 },
  async () => {
    const proc = child('stall')
    await proc.waitFor('ready')
    proc.child.kill('SIGTERM')
    await proc.exited
    assert.equal(proc.code, 1)
    assert.ok(lines(proc).includes('[server] the final save did not return in time; exiting'))
  }
)

test('shutdown: a failed final save exits 1, a completed one 0', { timeout: 60000 }, async () => {
  for (const [mode, code] of [
    ['reject', 1],
    ['ok', 0],
  ]) {
    const proc = child(mode)
    await proc.waitFor('ready')
    proc.child.kill('SIGTERM')
    await proc.exited
    assert.equal(proc.code, code, mode)
    if (mode === 'reject') assert.ok(lines(proc).includes('[server] final save failed: final save incomplete'))
  }
})

test(
  'shutdown: a signal during start-up, before the world exists, exits 0 and says there is nothing to save',
  { timeout: 60000 },
  async () => {
    const proc = child('early')
    await proc.waitFor('ready')
    proc.child.kill('SIGTERM')
    await proc.exited
    assert.equal(proc.code, 0)
    assert.ok(
      lines(proc).includes('[server] SIGTERM during start-up, before the world was loaded: nothing to save; exiting')
    )
  }
)

test(
  'shutdown: a database that blocks on every write is stopped at the deadline, reported, and the exit is 1',
  { timeout: 60000 },
  async () => {
    // 40 rows of 50 ms each (2 s back to back), written only by the final save: without a turn of the event loop
    // between them the 500 ms deadline could never stop it. However slow the machine, the save stops before all 40
    const proc = child('slowdb', 500)
    await proc.waitFor('ready')
    proc.child.kill('SIGTERM')
    await proc.exited
    assert.equal(proc.code, 1)
    const saved = lines(proc).filter(line => line.startsWith('saved bp'))
    assert.ok(saved.length < 40, `${saved.length} of 40 rows written before the deadline`)
    const report = lines(proc).find(line => line.startsWith('[network] not persisted:'))
    assert.ok(report, proc.out)
    const unsaved = JSON.parse(/blueprints=(\[[^\]]*\])/.exec(report)[1])
    assert.equal(unsaved.length + saved.length, 40, 'every row is either written or reported')
    // the deadline timer or the clock check before the next row, whichever comes first
    assert.match(proc.out, /\[server\] final save failed: (save deadline exceeded|final save incomplete)/)
  }
)

test(
  'shutdown: queued config writes that block the thread are stopped at the deadline too, and the exit is 1',
  { timeout: 60000 },
  async () => {
    // 200 writes of 50 ms each (10 s back to back), queued before the signal. The signal is sent once the first one
    // has been written, not at `ready`: the child prints that before the writes start, and a signal it takes before
    // then sets the deadline before any write begins, so the writes would stop at it even if they were not queued one
    // behind the other (each checks the clock) and this test could not tell. Sent while they run, it is seen between
    // two queued writes; writes that did not wait for each other would all run before it (they were all waiting for
    // the same turn of the event loop)
    const proc = child('slowconfig', 500)
    await proc.waitFor('config written')
    proc.child.kill('SIGTERM')
    await proc.exited
    assert.equal(proc.code, 1)
    const written = lines(proc).filter(line => line === 'config written').length
    assert.ok(written < 200, `${written} of 200 config writes before the deadline`)
    const report = lines(proc).find(line => line.startsWith('[network] not persisted:'))
    assert.ok(report?.includes('config=["spawn"]'), proc.out.slice(-1000))
  }
)

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

const serverEnv = (port, world) => ({
  WORLD: world,
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
})

test(
  'shutdown: a signal while the server starts exits 0; once the world is loading it runs the final save',
  { timeout: 120000 },
  async t => {
    for (const [world, at] of [
      ['early-world', '[assets] initializing'],
      ['loading-world', '[network] hydration:'],
    ]) {
      const port = await freePort()
      const server = run([path.join(dir, 'build/index.js')], { cwd: dir, env: serverEnv(port, world) })
      t.after(() => server.code === undefined && server.child.kill('SIGKILL'))
      await server.waitFor(at)
      server.child.kill('SIGTERM')
      await server.exited
      assert.equal(server.code, 0, server.out.slice(-2000))
      const early = server.out.includes('during start-up, before the world was loaded: nothing to save')
      const saved = server.out.includes('[network] final save complete')
      // a signal sent at the assets step may still arrive after the world was created
      if (world === 'early-world') assert.ok(early || saved, server.out.slice(-2000))
      else assert.ok(saved && !early, server.out.slice(-2000))
    }
  }
)

test(
  'shutdown: SIGTERM saves the edited blueprint and app and the pending world.set, then exits 0',
  { timeout: 120000 },
  async t => {
    const port = await freePort()
    const world = path.join(dir, 'world')
    fs.mkdirSync(path.join(world, 'assets'), { recursive: true })
    // sets a new value every 20 ms and logs each one it set; storage writes at most once a second, so whenever the
    // signal comes the latest accepted value is (almost always) still waiting, and only the final save can write it
    fs.writeFileSync(
      path.join(world, 'assets', 'shutdown-probe.js'),
      `if (world.isServer) {
      let n = 0
      const tick = () => {
        world.set('shutdown-key', { saved: ++n })
        console.log('[shutdown-probe] set ' + n)
        setTimeout(tick, 20)
      }
      tick()
    }`
    )
    const server = run([path.join(dir, 'build/index.js')], { cwd: dir, env: serverEnv(port, 'world') })
    t.after(() => server.code === undefined && server.child.kill('SIGKILL'))
    await server.waitFor(`server listening on port ${port}`)
    const client = await new WireClient(port, 'builder').connect()
    t.after(() => client.close())
    await client.becomeAdmin('shutdown')
    client.installApp({ id: 'shutdown-app', script: 'asset://shutdown-probe.js', props: { edited: true } })
    await server.waitFor('[shutdown-probe] set 10')
    // a connection is still open: the stop does not wait for it
    server.child.kill('SIGTERM')
    await server.exited
    assert.equal(server.code, 0, server.out.slice(-2000))
    assert.match(server.out, /\[server\] SIGTERM: saving the world before exit/)
    assert.match(server.out, /\[network\] final save complete/)
    // the last value the script set (the stop clears its timer; nothing is accepted after the final save starts)
    const last = Math.max(...[...server.out.matchAll(/\[shutdown-probe\] set (\d+)/g)].map(match => Number(match[1])))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(world, 'storage.json'), 'utf8')), {
      'shutdown-key': { saved: last },
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
  }
)
