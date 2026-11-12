// `node scripts/prod-smoke.mjs [dir]`: does the built server start from a production install?
//
// `dir` (default: this repository) must hold a built tree: build/ (all of `npm run build`), src/, package.json and
// package-lock.json, which with scripts/ is what the Dockerfile's production stage copies. The script
//   1. copies those into a new folder under os.tmpdir() and runs `npm ci --omit=dev` there (never in `dir`),
//   2. checks that no package the lock file marks as dev-only was installed,
//   3. starts `node build/index.js` there with made-up settings, a world folder inside the copy and a free port,
//   4. waits (bounded) for GET /health to answer 200, then asks for / and /env.js (200 each),
//   5. stops the server with SIGTERM and expects exit code 0, and removes the folder.
// Any step that fails ends with a non-zero exit code and the end of the server's output.
// A SIGINT or SIGTERM to this script (Ctrl-C, `kill -INT`) at any step goes through the same cleanup: the install or
// the server is stopped (SIGTERM to its process group, SIGKILL to what is left after STOP_TIMEOUT_MS), the folder
// is removed, and the script exits with 130 (SIGINT) or 143 (SIGTERM). A SIGKILL to this script cannot be handled:
// then the folder and whatever was running stay.
//
// What this does NOT check: the Docker image itself (its Alpine/musl base and the native modules built for it, its
// `npm install` followed by `npm prune --omit=dev` where this runs `npm ci --omit=dev`, its HEALTHCHECK command and
// the curl that runs it), a browser loading the client, a WebSocket connection, an existing world's data,
// PostgreSQL or S3. It runs on this machine's own Node and libc.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const HEALTH_TIMEOUT_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 5 * 1000
const STOP_TIMEOUT_MS = 20 * 1000
// how long what npm started may outlive npm before it is stopped
const LINGER_MS = 5_000
// what the image's production stage copies besides node_modules; scripts/ is not needed to start
const REQUIRED = ['build/index.js', 'build/public/index.html', 'src', 'package.json', 'package-lock.json']
const COPIED = ['build', 'src', 'scripts', 'package.json', 'package-lock.json']

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.resolve(process.argv[2] || repoDir)
const started = Date.now()
const seconds = since => ((Date.now() - since) / 1000).toFixed(1)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// the install and the server run in a process group of their own (POSIX), so that a stop reaches what they started
const GROUPS = process.platform !== 'win32'
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 }

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'manual' })
  const body = await response.text()
  return { status: response.status, bytes: body.length }
}

let tempDir = null
let install = null // { proc, exited } of `npm ci` from its start
let child = null
let output = ''
let exited = null // { code, signal } once the server process is gone
let interrupted = null // 'SIGINT' or 'SIGTERM' once one has arrived

class Interrupted extends Error {}
// called after every wait of run(): nothing new is started once the cleanup may have begun
const stopIfInterrupted = () => {
  if (interrupted) throw new Interrupted(`stopped by ${interrupted}`)
}

function signalGroup(proc, signal) {
  try {
    if (GROUPS) process.kill(-proc.pid, signal)
    else proc.kill(signal)
  } catch {
    // (already gone)
  }
}

// whether a process of the group is still running (a group id is not given out again while one is)
function groupAlive(proc) {
  if (!GROUPS) return false
  try {
    process.kill(-proc.pid, 0)
    return true
  } catch {
    return false
  }
}

// Process groups this run could not stop (their leaders' pids): said at the end, and the run then fails.
const survivors = []

// SIGTERM to the process group; SIGKILL to the group when the leader is not gone after STOP_TIMEOUT_MS or when
// processes of the group outlive it. `gone` says whether the leader has exited: the group is stopped also when the
// leader is gone and something it started is not (npm exiting with a child that still holds its pipes).
// Resolves with { killed: the leader needed SIGKILL, survived: something of the group was still there after the
// last wait }. That last wait is bounded: a process that cannot be killed (stuck in the kernel) must not hold the
// run for good. On Linux a group of which only zombies are left still answers a signal until they are reaped, which
// normally takes no time; should it take longer than the wait, the group is reported as surviving.
async function stopGroup(proc, gone) {
  const over = () => gone() && !groupAlive(proc)
  signalGroup(proc, 'SIGTERM')
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (!over() && Date.now() < deadline) await sleep(100)
  const killed = !gone()
  if (!over()) signalGroup(proc, 'SIGKILL')
  const last = Date.now() + STOP_TIMEOUT_MS
  while (!over() && Date.now() < last) await sleep(100)
  const survived = !over()
  if (survived) survivors.push(proc.pid)
  return { killed, survived }
}

// The install and the server are each stopped once, and their record is given up before the stop: the number of a
// process group that is gone can be given to another group, and a later look at the old record would signal that.
async function stopInstall() {
  const state = install
  if (!state) return
  install = null
  await stopGroup(state.proc, () => state.exited)
  state.settle()
}

async function stopServer() {
  const proc = child
  if (!proc) return exited
  child = null
  if (exited && !groupAlive(proc)) return exited
  const { killed } = await stopGroup(proc, () => exited)
  return killed ? { ...exited, killed: true } : exited
}

// `npm ci --omit=dev` in tempDir, not blocking: a signal that arrives meanwhile is handled at once
function runInstall() {
  return new Promise(resolve => {
    const proc = spawn('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: tempDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      detached: GROUPS,
    })
    const state = { proc, exited: false }
    install = state
    let log = ''
    const keep = data => (log = (log + data).slice(-200_000))
    proc.stdout.on('data', keep)
    proc.stderr.on('data', keep)
    let error = null
    let timedOut = false
    let end = { code: null, signal: null }
    let lingering = null
    // The install is over, once: by its output ending, by the stop of what it left behind, or by its time running
    // out. From then on its record is given up (see stopInstall).
    let settled = false
    state.settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(lingering)
      if (install === state) install = null
      resolve({ ...end, error, timedOut, log })
    }
    const timer = setTimeout(() => {
      timedOut = true
      stopInstall()
    }, INSTALL_TIMEOUT_MS)
    proc.once('error', err => {
      // (it could not be started: there is no process and no group)
      error = err
      state.exited = true
      state.settle()
    })
    // npm is gone, but its output is read to the end only when everything that holds its pipes is gone too. Something
    // npm started and left behind would keep this waiting until the install's time is up: after a moment it is
    // stopped, and the install is over whether or not the output then ends
    proc.once('exit', (code, signal) => {
      state.exited = true
      end = { code, signal }
      lingering = setTimeout(() => stopInstall(), LINGER_MS)
    })
    // after the exit, once the output is read to its end. What npm left in its group without holding a pipe is
    // stopped here, so that nothing of the install runs beside the server
    proc.once('close', () => {
      if (install === state && groupAlive(proc)) stopInstall()
      else state.settle()
    })
  })
}

async function run() {
  for (const name of REQUIRED) {
    if (!fs.existsSync(path.join(sourceDir, name))) {
      throw new Error(`${path.join(sourceDir, name)} is missing: run the four builds first (see ci.yml)`)
    }
  }

  // 1. the tree, and a production install inside it
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-smoke-'))
  for (const name of COPIED) {
    const from = path.join(sourceDir, name)
    if (fs.existsSync(from)) fs.cpSync(from, path.join(tempDir, name), { recursive: true })
  }
  let step = Date.now()
  const installed = await runInstall()
  stopIfInterrupted()
  if (installed.error || installed.timedOut || installed.code !== 0) {
    output = installed.log
    const why =
      installed.error?.message ?? (installed.timedOut ? `not done within ${INSTALL_TIMEOUT_MS / 1000} s` : null)
    throw new Error(`npm ci --omit=dev failed (${why ?? `exit code ${installed.code}, signal ${installed.signal}`})`)
  }
  console.log(`[prod-smoke] npm ci --omit=dev in ${tempDir}: ${seconds(step)} s`)

  // 2. a dev-only package that is present would mean the install was not the production one
  const lock = JSON.parse(fs.readFileSync(path.join(tempDir, 'package-lock.json'), 'utf8'))
  const devOnly = Object.entries(lock.packages ?? {}).filter(([key, entry]) => key && entry.dev === true)
  const present = devOnly.filter(([key]) => fs.existsSync(path.join(tempDir, key))).map(([key]) => key)
  if (!devOnly.length) throw new Error('package-lock.json marks no package as dev-only: cannot tell the installs apart')
  if (present.length) {
    throw new Error(`dev-only packages were installed: ${present.slice(0, 5).join(', ')} (${present.length} in all)`)
  }
  console.log(`[prod-smoke] none of the ${devOnly.length} dev-only packages of the lock file is installed`)

  // 3. the server, with only the settings its start-up asks for (src/server/index.js); all values are made up
  const port = await freePort()
  stopIfInterrupted()
  const origin = `http://127.0.0.1:${port}`
  step = Date.now()
  child = spawn(process.execPath, ['build/index.js'], {
    // (the server reads .env files from its working directory: the copy has none)
    cwd: tempDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'production', // as the image sets it
      COMMIT_HASH: 'prod-smoke',
      WORLD: 'world-smoke',
      PORT: String(port),
      JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      SAVE_INTERVAL: '60',
      PUBLIC_MAX_UPLOAD_SIZE: '12',
      PUBLIC_WS_URL: `ws://127.0.0.1:${port}/ws`,
      PUBLIC_API_URL: `${origin}/api`,
      ASSETS: 'local',
      ASSETS_BASE_URL: `${origin}/assets`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: GROUPS,
  })
  child.stdout.on('data', data => (output += data))
  child.stderr.on('data', data => (output += data))
  child.once('error', err => {
    output += `\n${err.message}`
    exited = { code: null, signal: null }
  })
  child.once('exit', (code, signal) => (exited = { code, signal }))

  // 4. /health within the bound, then the page and its settings script
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let health = null
  while (Date.now() < deadline) {
    stopIfInterrupted()
    if (exited) throw new Error(`the server exited during start-up (code ${exited.code}, signal ${exited.signal})`)
    health = await get(`${origin}/health`).catch(() => null)
    stopIfInterrupted()
    if (health?.status === 200) break
    await sleep(250)
  }
  if (health?.status !== 200) {
    throw new Error(
      `GET /health did not answer 200 within ${HEALTH_TIMEOUT_MS / 1000} s (last: ${health?.status ?? 'no answer'})`
    )
  }
  console.log(`[prod-smoke] GET /health 200 after ${seconds(step)} s`)
  for (const route of ['/', '/env.js']) {
    const reply = await get(`${origin}${route}`)
    stopIfInterrupted()
    if (reply.status !== 200 || !reply.bytes) {
      throw new Error(`GET ${route} answered ${reply.status} with ${reply.bytes} characters (expected 200 and a body)`)
    }
    console.log(`[prod-smoke] GET ${route} 200 (${reply.bytes} characters)`)
  }

  // 5. a stop that saves and exits 0 (src/server/shutdown.js)
  step = Date.now()
  const end = await stopServer()
  stopIfInterrupted()
  if (end.killed) throw new Error(`the server did not stop within ${STOP_TIMEOUT_MS / 1000} s of SIGTERM`)
  if (end.code !== 0) throw new Error(`the server exited with code ${end.code} (signal ${end.signal}) after SIGTERM`)
  console.log(`[prod-smoke] SIGTERM: exit code 0 after ${seconds(step)} s`)
}

// The one way out, after a pass, a failure or a signal: stop what runs, remove the folder, exit. Called more than
// once (a signal during a failure, or during this), it runs once.
let failed = false
let finishing = null
function finish() {
  finishing ??= (async () => {
    await stopInstall().catch(() => {})
    await stopServer().catch(() => {})
    if (failed && !interrupted && output.trim()) {
      console.error('[prod-smoke] the end of the output:')
      console.error(output.trim().split('\n').slice(-40).join('\n').slice(-6000))
    }
    if (survivors.length) {
      failed = true
      console.error(
        `[prod-smoke] could not stop process group${survivors.length > 1 ? 's' : ''} ${survivors.join(', ')}: ` +
          'something this run started is still running'
      )
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
    if (interrupted) {
      console.error(
        `[prod-smoke] stopped by ${interrupted} after ${seconds(started)} s; ${tempDir ?? 'no folder'} removed`
      )
      process.exit(SIGNAL_EXIT_CODES[interrupted])
    }
    console.log(`[prod-smoke] ${failed ? 'failed' : 'passed'} in ${seconds(started)} s`)
    process.exit(failed ? 1 : 0)
  })()
  return finishing
}

for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    if (interrupted) return // (the cleanup of the first one is running)
    interrupted = signal
    const running = child && !exited ? 'the server' : install && !install.exited ? 'the install' : 'the run'
    console.error(`[prod-smoke] ${signal}: stopping ${running}`)
    finish()
  })
}

try {
  await run()
} catch (err) {
  failed = true
  if (!interrupted) console.error(`[prod-smoke] FAILED: ${err.message}`)
}
await finish()
