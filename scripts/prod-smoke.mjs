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
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const HEALTH_TIMEOUT_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 5 * 1000
const STOP_TIMEOUT_MS = 20 * 1000
// what the image's production stage copies besides node_modules; scripts/ is not needed to start
const REQUIRED = ['build/index.js', 'build/public/index.html', 'src', 'package.json', 'package-lock.json']
const COPIED = ['build', 'src', 'scripts', 'package.json', 'package-lock.json']

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.resolve(process.argv[2] || repoDir)
const started = Date.now()
const seconds = since => ((Date.now() - since) / 1000).toFixed(1)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
let child = null
let output = ''
let exited = null // { code, signal } once the server process is gone

async function stopServer() {
  if (!child || exited) return exited
  child.kill('SIGTERM')
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (!exited && Date.now() < deadline) await sleep(100)
  if (!exited) {
    child.kill('SIGKILL')
    while (!exited) await sleep(100)
    return { ...exited, killed: true }
  }
  return exited
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
  const install = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: tempDir,
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  if (install.error || install.status !== 0) {
    output = `${install.stdout ?? ''}\n${install.stderr ?? ''}`
    throw new Error(`npm ci --omit=dev failed (${install.error?.message ?? `exit code ${install.status}`})`)
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
    if (exited) throw new Error(`the server exited during start-up (code ${exited.code}, signal ${exited.signal})`)
    health = await get(`${origin}/health`).catch(() => null)
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
    if (reply.status !== 200 || !reply.bytes) {
      throw new Error(`GET ${route} answered ${reply.status} with ${reply.bytes} characters (expected 200 and a body)`)
    }
    console.log(`[prod-smoke] GET ${route} 200 (${reply.bytes} characters)`)
  }

  // 5. a stop that saves and exits 0 (src/server/shutdown.js)
  step = Date.now()
  const end = await stopServer()
  if (end.killed) throw new Error(`the server did not stop within ${STOP_TIMEOUT_MS / 1000} s of SIGTERM`)
  if (end.code !== 0) throw new Error(`the server exited with code ${end.code} (signal ${end.signal}) after SIGTERM`)
  console.log(`[prod-smoke] SIGTERM: exit code 0 after ${seconds(step)} s`)
}

let failed = false
try {
  await run()
} catch (err) {
  failed = true
  console.error(`[prod-smoke] FAILED: ${err.message}`)
} finally {
  await stopServer().catch(() => {})
  if (failed && output.trim()) {
    console.error('[prod-smoke] the end of the output:')
    console.error(output.trim().split('\n').slice(-40).join('\n').slice(-6000))
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
}
console.log(`[prod-smoke] ${failed ? 'failed' : 'passed'} in ${seconds(started)} s`)
process.exit(failed ? 1 : 0)
