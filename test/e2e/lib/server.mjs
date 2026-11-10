// Boots the built server against a throwaway world directory at the repo root (world-e2e-*, gitignored by
// /world*). The process runs with an explicit environment and a cwd without a .env file, so nothing from
// the developer's own configuration leaks into a run.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'

import { BUILD_ROOT, E2E_DIR, REPO_ROOT, TIMEOUT_SCALE, sleep } from './common.mjs'

const MEMORY_PROBE = path.join(E2E_DIR, 'lib', 'memory-probe.js')
const MEMORY_REPORT = 'E2E_MEMORY '
const MiB = 1024 * 1024

// a memory request that got no report in time. The process may only be busy, so a caller can ask again
export class MemoryProbeTimeout extends Error {}

// Asks a process that preloads memory-probe.js for its memory: each request sends one SIGUSR2 and resolves with
// the report numbered for that signal ({ n, heapUsed, external, rss }, bytes). Requests run one at a time, and a
// report that arrives after its request timed out carries an older number, so the next request does not take it.
// Reports are read from the process's stdout alone: output merged with stderr can have a stderr chunk inside a line.
// `exited()` returns null while the process runs.
export function memoryReader(child, { exited }) {
  const decoder = new StringDecoder('utf8')
  let partial = ''
  let latest = null
  let unreadable = null
  child.stdout.on('data', data => {
    const lines = (partial + decoder.write(data)).split('\n')
    partial = lines.pop()
    for (const line of lines) {
      if (!line.startsWith(MEMORY_REPORT)) continue
      let report
      try {
        report = JSON.parse(line.slice(MEMORY_REPORT.length))
      } catch {
        unreadable = line
        continue
      }
      if (latest === null || report.n > latest.n) latest = report
    }
  })
  let signals = 0
  const request = async timeout => {
    const n = ++signals
    child.kill('SIGUSR2')
    const deadline = Date.now() + timeout
    // at or past n: a report with a higher number also answers this signal
    while (!(latest?.n >= n)) {
      if (unreadable !== null) throw new Error(`unreadable memory report: ${unreadable.slice(0, 200)}`)
      const code = exited()
      if (code !== null) throw new Error(`server exited (${code}) before reporting its memory`)
      if (Date.now() > deadline) throw new MemoryProbeTimeout(`no memory report within ${timeout} ms`)
      await sleep(50)
    }
    return latest
  }
  let queue = Promise.resolve()
  return ({ timeout = 15000 } = {}) => {
    const result = queue.then(() => request(timeout * TIMEOUT_SCALE))
    queue = result.catch(() => {})
    return result
  }
}

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
    SOLANA_WATCH_ADDRESS: '',
    SOLANA_PKEY_ARRAY: '',
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
// `memoryProbe`: also preload memory-probe.js and start node with --expose-gc, for server.retainedMiB()
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
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const server = { child, port, world, worldDir, url: `http://localhost:${port}/`, out: '', exited: null }
  const onData = data => {
    server.out += data
    if (log !== null) fs.writeSync(log, data)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('exit', code => (server.exited = code ?? 'signal'))
  const readMemory = memoryProbe ? memoryReader(child, { exited: () => server.exited }) : null
  const deadline = Date.now() + timeout
  while (!server.out.includes(`server listening on port ${port}`)) {
    if (server.exited !== null) throw new Error(`server exited early (${server.exited}):\n${server.out.slice(-3000)}`)
    if (Date.now() > deadline) throw new Error(`server did not start:\n${server.out.slice(-3000)}`)
    await sleep(200)
  }
  server.count = text => server.out.split(text).length - 1
  server.lines = pattern => server.out.split('\n').filter(line => pattern.test(line))
  // `heapUsed + external` after a full collection, in MiB (memory-probe.js). Unlike resident memory it does not
  // depend on when the collector last ran. Throws MemoryProbeTimeout when no report comes within the (scaled)
  // timeout, and a plain error when the server has exited.
  server.retainedMiB = async options => {
    if (!readMemory) throw new Error('retainedMiB() needs startServer({ memoryProbe: true })')
    const { heapUsed, external } = await readMemory(options)
    return Math.round((heapUsed + external) / MiB)
  }
  server.stop = async () => {
    if (server.exited === null) {
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), sleep(5000)])
      if (server.exited === null) child.kill('SIGKILL')
    }
    if (log !== null) fs.closeSync(log)
    fs.rmSync(worldDir, { recursive: true, force: true })
  }
  return server
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
