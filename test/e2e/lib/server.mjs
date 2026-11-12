// Boots the built server against a throwaway world directory at the repo root (world-e2e-*, gitignored by
// /world*). The process runs with an explicit environment and a cwd without a .env file, so nothing from
// the developer's own configuration leaks into a run.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BUILD_ROOT, E2E_DIR, REPO_ROOT, sleep } from './common.mjs'
import { memoryReader } from './memory.mjs'

const MEMORY_PROBE = path.join(E2E_DIR, 'lib', 'memory-probe.js')
const MiB = 1024 * 1024

export function serverEnv(port, world, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    WORLD: world,
    PORT: String(port),
    JWT_SECRET: 'e2e',
    ADMIN_CODE: 'e2e',
    SAVE_INTERVAL: '0',
    CLEAN: 'false',
    DB_URI: 'local',
    DB_SCHEMA: '',
    ASSETS: 'local',
    ASSETS_BASE_URL: `http://localhost:${port}/assets`,
    ASSETS_S3_URI: '',
    PUBLIC_WS_URL: `ws://localhost:${port}/ws`,
    PUBLIC_API_URL: `http://localhost:${port}/api`,
    PUBLIC_MAX_UPLOAD_SIZE: '12',
    PUBLIC_PLAYER_COLLISION: 'false',
    LIVEKIT_WS_URL: '',
    LIVEKIT_API_KEY: '',
    LIVEKIT_API_SECRET: '',
    AI_PROVIDER: 'anthropic',
    AI_MODEL: 'e2e-mock',
    AI_EFFORT: 'medium',
    AI_API_KEY: '',
    PUBLIC_RPC_URL: '',
    PUBLIC_TOKEN_MINT: '',
    PUBLIC_REQUIRED_TOKEN_AMOUNT: '100000',
    PUBLIC_TOKEN_DECIMALS: '6',
    // the harness opens dozens of connections from one address; the churn probe boots its own server with
    // the defaults (pass '' to get them back)
    WS_CONNECT_RATE_PER_MIN: '0',
    WS_CONNECT_BURST: '0',
    WS_CONNECT_RATE_PER_MIN_56: '0',
    WS_CONNECT_RATE_PER_MIN_48: '0',
    WS_CONNECT_CONCURRENT_PER_IP: '0',
    ...extra,
  }
}

// `worldSource`: an existing world directory to copy (local runs with the 5-app world); without it the
// server bootstraps the default world from src/world on first boot
// `preload`: a script the server process imports before its own entry (node --import), eg a test hook
// `memoryProbe`: also preload memory-probe.js, start node with --expose-gc and open an IPC channel to it, for
// server.retainedMiB()
export async function startServer({
  port,
  worldSource,
  env = {},
  logPath,
  timeout = 120000,
  preload,
  memoryProbe = false,
}) {
  const world = `world-e2e-${Math.random().toString(36).slice(2, 8)}`
  const worldDir = path.join(BUILD_ROOT, world)
  if (worldSource) fs.cpSync(worldSource, worldDir, { recursive: true })
  else fs.mkdirSync(worldDir, { recursive: true })
  const log = logPath ? fs.openSync(logPath, 'w') : null
  const preloads = [preload, memoryProbe && MEMORY_PROBE].filter(Boolean)
  const nodeArgs = [
    ...(memoryProbe ? ['--expose-gc'] : []),
    ...preloads.flatMap(file => ['--import', pathToFileURL(file).href]),
  ]
  const child = spawn(process.execPath, [...nodeArgs, path.join(BUILD_ROOT, 'build/index.js')], {
    cwd: E2E_DIR,
    env: serverEnv(port, world, env),
    stdio: memoryProbe ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  })
  const server = { child, port, world, worldDir, url: `http://localhost:${port}/`, out: '', exited: null }
  const onData = data => {
    server.out += data
    if (log !== null) fs.writeSync(log, data)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('exit', code => (server.exited = code ?? 'signal'))
  const readMemory = memoryProbe ? memoryReader(child) : null
  const deadline = Date.now() + timeout
  while (!server.out.includes(`server listening on port ${port}`)) {
    if (server.exited !== null) throw new Error(`server exited early (${server.exited}):\n${server.out.slice(-3000)}`)
    if (Date.now() > deadline) throw new Error(`server did not start:\n${server.out.slice(-3000)}`)
    await sleep(200)
  }
  server.count = text => server.out.split(text).length - 1
  server.lines = pattern => server.out.split('\n').filter(line => pattern.test(line))
  // `heapUsed + external` after a full collection, in MiB (memory-probe.js). Unlike resident memory it does not
  // depend on when the collector last ran. `options` and errors as for memoryReader() in memory.mjs.
  server.retainedMiB = async options => {
    if (!readMemory) throw new Error('retainedMiB() needs startServer({ memoryProbe: true })')
    const { heapUsed, external } = await readMemory(options)
    return Math.round((heapUsed + external) / MiB)
  }
  server.stop = async () => {
    if (server.exited === null) {
      const asked = Date.now()
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), sleep(5000)])
      const how =
        server.exited === null
          ? 'did not exit within 5 s of SIGTERM and was killed'
          : `exited (${server.exited}) ${Date.now() - asked} ms after SIGTERM`
      if (server.exited === null) child.kill('SIGKILL')
      if (log !== null) fs.writeSync(log, `[harness] server ${how}\n`)
    }
    if (log !== null) fs.closeSync(log)
    fs.rmSync(worldDir, { recursive: true, force: true })
  }
  return server
}

// Starts the built server with settings (or a world directory) it cannot start with, and waits for the process to
// end by itself. -> { code, out }: the exit code, or 'hung' when it was still up after `timeout` and had to be
// killed. `prepare(worldDir)` runs before the start, eg to put an unreadable database there.
export async function failedStart({ port, env = {}, prepare, timeout = 30000 }) {
  const world = `world-e2e-${Math.random().toString(36).slice(2, 8)}`
  const worldDir = path.join(BUILD_ROOT, world)
  fs.mkdirSync(worldDir, { recursive: true })
  try {
    prepare?.(worldDir)
    const child = spawn(process.execPath, [path.join(BUILD_ROOT, 'build/index.js')], {
      cwd: E2E_DIR,
      env: serverEnv(port, world, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', data => (out += data))
    child.stderr.on('data', data => (out += data))
    const exited = once(child, 'exit').then(([code]) => code ?? 'signal')
    const code = await Promise.race([exited, sleep(timeout).then(() => 'hung')])
    if (code === 'hung') {
      child.kill('SIGKILL')
      await exited
    }
    return { code, out }
  } finally {
    fs.rmSync(worldDir, { recursive: true, force: true })
  }
}

export function worldAssetsDir(server) {
  return path.join(server.worldDir, 'assets')
}

// copies a probe script into the world's assets so a blueprint can reference it as asset://<name>
export function installAsset(server, sourcePath, name = path.basename(sourcePath)) {
  fs.mkdirSync(worldAssetsDir(server), { recursive: true })
  fs.copyFileSync(sourcePath, path.join(worldAssetsDir(server), name))
  return `asset://${name}`
}

export const defaultWorldAssets = path.join(REPO_ROOT, 'src/world/assets')
