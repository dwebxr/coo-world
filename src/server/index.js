import 'ses'
import '../core/lockdown'
import './fetchGuardInstall'
import './bootstrap'

import fs from 'fs-extra'
import path from 'path'
import Fastify from 'fastify'
import ws from '@fastify/websocket'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import { compressOptions } from './compressOptions'
import statics from '@fastify/static'

import { createServerWorld } from '../core/createServerWorld'
import { PROTOCOL_VERSION, writePacket } from '../core/packets'
import { buildPublicEnv } from '../core/extras/publicEnv'
import { readJWT } from '../core/utils-server'
import { getDB } from './db'
import { Storage, readStorageLimitsEnv } from './Storage'
import { installShutdown, stopApps } from './shutdown'
import { assets } from './assets'
import { collections } from './collections'
import { cleaner } from './cleaner'
import { errorHandler } from './errorHandler'
import { checkJwtSecret, checkPreviousJwtSecret } from './jwtSecret'
import { adminMode, adminStartupNotes } from './adminCode'
import { escapeHtml } from './escapeHtml'
import { walletOf } from './solana-gating'
import { clientIpKeys, createUploadLimits, readUploadLimitsEnv } from './uploadLimits'
import { createConnectionLimits, readConnectionLimitsEnv } from './connectionLimits'
import { assetRoutes, uploadRoutes } from './uploadRoutes'
import { readKickEnv } from './kickList'

const rootDir = path.join(__dirname, '../')
const worldDir = path.join(rootDir, process.env.WORLD)
const port = process.env.PORT

// check envs
if (!process.env.WORLD) {
  throw new Error('[envs] WORLD not set')
}
if (!process.env.PORT) {
  throw new Error('[envs] PORT not set')
}
checkJwtSecret(process.env.JWT_SECRET)
checkPreviousJwtSecret(process.env.JWT_SECRET_PREVIOUS, process.env.JWT_SECRET)
// the admin mode (a code, open to all, or locked: adminCode.js) and what there is to say about it
for (const note of adminStartupNotes(process.env)) console[note.level](note.message)
// what a kick keeps out (kickList.js): a bad value stops here, before the world loads
if (readKickEnv(process.env).byAddress) {
  console.log(
    '[kick] KICK_BY_ADDRESS is on: after an admin kicks a player, new users from that address wait too. Behind a proxy that does not pass client addresses, that is every new user.'
  )
}
if (!process.env.SAVE_INTERVAL) {
  throw new Error('[envs] SAVE_INTERVAL not set')
}
if (!process.env.PUBLIC_MAX_UPLOAD_SIZE) {
  throw new Error('[envs] PUBLIC_MAX_UPLOAD_SIZE not set')
}
const maxUploadSize = Number(process.env.PUBLIC_MAX_UPLOAD_SIZE) // MB, the same limit the client applies
if (!(maxUploadSize > 0)) {
  throw new Error('[envs] PUBLIC_MAX_UPLOAD_SIZE must be a positive number of megabytes')
}
const uploadLimitsConfig = readUploadLimitsEnv(process.env) // UPLOAD_*; throws on a bad value
const connectionLimitsConfig = readConnectionLimitsEnv(process.env) // WS_CONNECT_*; throws on a bad value
// what the per-address limits (connections, uploads, wrong admin codes) take for a client's address: behind a proxy
// that is not named here every client has the proxy's
console.log(
  `[envs] client addresses are read from ${uploadLimitsConfig.clientIpHeader ? `the ${uploadLimitsConfig.clientIpHeader} header` : 'the connection itself'}`
)
const storageLimits = readStorageLimitsEnv(process.env) // STORAGE_*; throws on a bad value
// days the clean-up keeps what it removes in <world>/assets-trash (ASSETS=local); 0 deletes at once
const cleanTrashDays = ['', undefined].includes(process.env.CLEAN_TRASH_DAYS)
  ? 30
  : Number(process.env.CLEAN_TRASH_DAYS)
if (!Number.isSafeInteger(cleanTrashDays) || cleanTrashDays < 0) {
  throw new Error('[envs] CLEAN_TRASH_DAYS must be a whole number of days, 0 or more')
}
if (!process.env.PUBLIC_WS_URL) {
  throw new Error('[envs] PUBLIC_WS_URL not set')
}
if (!process.env.PUBLIC_WS_URL.startsWith('ws')) {
  throw new Error('[envs] PUBLIC_WS_URL must start with ws:// or wss://')
}
if (!process.env.PUBLIC_API_URL) {
  throw new Error('[envs] PUBLIC_API_URL must be set')
}
if (!process.env.ASSETS) {
  throw new Error(`[envs] ASSETS must be set to 'local' or 's3'`)
}
if (!process.env.ASSETS_BASE_URL) {
  throw new Error(`[envs] ASSETS_BASE_URL must be set`)
}
// asset:// URLs resolve to `${ASSETS_BASE_URL}/name` (World.resolveURL), so a trailing slash would turn every
// asset path into `//name`, which @fastify/static refuses as non-canonical
if (process.env.ASSETS_BASE_URL.endsWith('/')) {
  throw new Error(`[envs] ASSETS_BASE_URL must not end with /`)
}
if (process.env.ASSETS === 's3' && !process.env.ASSETS_S3_URI) {
  throw new Error(`[envs] ASSETS_S3_URI must be set when using ASSETS=s3`)
}
// every join snapshot carries these; its size bound counts them at these lengths (joinBudget.js SNAPSHOT_FIXED_BYTES)
for (const [name, max] of [
  ['ASSETS_BASE_URL', 1024],
  ['PUBLIC_API_URL', 1024],
  ['LIVEKIT_WS_URL', 1024],
  ['AI_PROVIDER', 128],
  ['AI_MODEL', 128],
  ['AI_EFFORT', 128],
]) {
  if ((process.env[name] || '').length > max) throw new Error(`[envs] ${name} must be at most ${max} characters`)
}

// SIGINT/SIGTERM from here on (shutdown.js): during start-up the process just exits; once the world exists (below,
// before its scripts start) the final save runs under a deadline
const shutdown = installShutdown()

const fastify = Fastify({ logger: { level: 'error' } })

// create world folder if needed
await fs.ensureDir(worldDir)

// init assets
await assets.init({ rootDir, worldDir })

// init collections
await collections.init({ rootDir, worldDir })

// init db
const db = await getDB({ worldDir })

// init cleaner (before storage is opened: it reads storage.json itself, read-only)
const storageFile = path.join(worldDir, '/storage.json')
// the assets URL tells it which scripts are store files for certain; with ASSETS=local (an assets directory) what
// it removes goes to the trash for CLEAN_TRASH_DAYS
await cleaner.init({
  db,
  storageFile,
  assetsUrl: assets.url,
  localStore: Boolean(assets.dir),
  trashDays: cleanTrashDays,
  // the largest file it reads: a script came through an upload (PUBLIC_MAX_UPLOAD_SIZE), storage.json is held to
  // STORAGE_MAX_BYTES; a larger one (an older limit, a hand-made file) stops the clean-up
  readLimit: Math.max(maxUploadSize * 1024 * 1024, storageLimits.maxBytes || 0),
})

// init storage
const storage = new Storage(storageFile, { limits: storageLimits })

// create world
const world = createServerWorld()
// from now on a stop saves: world.init hydrates the apps and starts their scripts before the server listens
shutdown.attach({
  network: world.network,
  stopWorld: () => {
    world.server.destroy()
    stopApps(world)
  },
  closeServer: () => fastify.close(),
})
await world.init({
  assetsDir: assets.dir,
  assetsUrl: assets.url,
  db,
  assets,
  storage,
  collections: collections.list,
  maxUploadSize,
})
// World.start() does not wait for the systems: no connection is taken before the network has loaded the world, the
// user ids and the join-state accounting (it refuses any that arrives earlier, too)
await world.network.ready
// the join snapshot's fixed part for this configuration (its tokens, URLs and largest joiner), measured before
// anyone can join: world growth and visitors' joins count it (joinBudget.js)
await world.network.measureFixedBytes()

fastify.register(cors)
fastify.register(compress, compressOptions())
fastify.get('/', async (req, reply) => {
  const title = world.settings.title || 'World'
  const desc = world.settings.desc || ''
  const image = world.resolveURL(world.settings.image?.url) || ''
  const url = process.env.ASSETS_BASE_URL
  const filePath = path.join(__dirname, 'public', 'index.html')
  let html = fs.readFileSync(filePath, 'utf-8')
  // function replacers insert the escaped text literally (no `$` pattern expansion)
  html = html.replaceAll('{url}', () => escapeHtml(url))
  html = html.replaceAll('{title}', () => escapeHtml(title))
  html = html.replaceAll('{desc}', () => escapeHtml(desc))
  html = html.replaceAll('{image}', () => escapeHtml(image))
  reply.type('text/html').send(html)
})
fastify.register(statics, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
  decorateReply: false,
  // Cache-Control stays @fastify/static's default (public, max-age=0: revalidate by ETag), which is what
  // production has always served: before v10, send overwrote a Cache-Control set here
  setHeaders: reply => {
    reply.header('Pragma', 'no-cache')
    reply.header('Expires', '0')
  },
})
if (world.assetsDir) {
  fastify.register(assetRoutes, { root: world.assetsDir })
}
fastify.register(ws, {
  options: {
    maxPayload: 65536,
    maxFragments: 8,
    maxBufferedChunks: 1024,
    autoPong: false,
    perMessageDeflate: false,
    closeTimeout: 2000,
  },
})
// per-address connection limits, checked before a connection touches the database (see connectionLimits.js)
const connectionLimits = createConnectionLimits(connectionLimitsConfig)
const kLease = Symbol('wsLease')
fastify.register(worldNetwork)

const publicEnvs = buildPublicEnv(process.env)
const envsCode = `
  if (!globalThis.env) globalThis.env = {}
  globalThis.env = ${JSON.stringify(publicEnvs)}
`
fastify.get('/env.js', async (req, reply) => {
  reply.type('application/javascript').send(envsCode)
})

// uploads are accepted from a connected session only: the bearer token names the user,
// the live socket carries the rank. headers are never logged.
const uploadLimits = createUploadLimits(uploadLimitsConfig)
fastify.register(uploadRoutes, {
  readJWT,
  getSocket: userId => world.network.sockets.get(userId),
  getWallet: walletOf,
  assets,
  getSettings: () => world.settings,
  maxUploadSize,
  limits: uploadLimits,
  clientIpHeader: uploadLimitsConfig.clientIpHeader,
  slotTimeoutMs: uploadLimitsConfig.slotTimeoutMs,
  minFreeBytes: uploadLimitsConfig.minFreeBytes,
  logClientIp: uploadLimitsConfig.logClientIp,
})

fastify.get('/health', async (request, reply) => {
  try {
    // Basic health check
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    }

    return reply.code(200).send(health)
  } catch (error) {
    console.error('Health check failed:', error)
    return reply.code(503).send({
      status: 'error',
      timestamp: new Date().toISOString(),
    })
  }
})

fastify.get('/status', async (request, reply) => {
  try {
    const status = {
      uptime: Math.round(world.time),
      // whether admin rights need something: a code, or (locked) a stored rank
      protected: adminMode(process.env) !== 'open',
      // how many are here; who they are and where is not for an unauthenticated request from any origin
      connectedUsers: world.network.sockets.size,
      commitHash: process.env.COMMIT_HASH,
      uploads: uploadLimits.stats(),
    }
    return reply.code(200).send(status)
  } catch (error) {
    console.error('Status failed:', error)
    return reply.code(503).send({
      status: 'error',
      timestamp: new Date().toISOString(),
    })
  }
})

fastify.setErrorHandler(errorHandler)

try {
  await fastify.listen({ port, host: '0.0.0.0' })
} catch (err) {
  console.error(err)
  console.error(`failed to launch on port ${port}`)
  process.exit(1)
}

function admitConnection(request, reply, done) {
  if (request.ws !== true) return done()
  const transport = request.raw.socket
  if (transport[kLease]) return reply.code(503).header('Retry-After', '10').send()
  const header = uploadLimitsConfig.clientIpHeader
  const lease = connectionLimits.admit(clientIpKeys(header ? request.headers[header] : undefined, request.ip))
  if (!lease.ok) return reply.code(503).header('Retry-After', '10').send()
  transport[kLease] = lease
  transport.once('close', lease.release)
  // An abort before ws takes over must not become an unhandled transport error.
  transport.once('error', () => transport.destroy())
  if (transport.destroyed) lease.release()
  done()
}

async function worldNetwork(fastify) {
  fastify.get('/ws', { websocket: true, preValidation: admitConnection }, (ws, req) => {
    if (req.query.v !== String(PROTOCOL_VERSION)) {
      world.network.write(ws, writePacket('kick', 'outdated'), { name: 'kick' })
      ws.close(1008, 'outdated')
      return
    }
    // the address the connection limits counted it under: the brake on wrong admin codes uses the same key
    const header = uploadLimitsConfig.clientIpHeader
    world.network.onConnection(ws, req.query, clientIpKeys(header ? req.headers[header] : undefined, req.ip))
  })
}

console.log(`server listening on port ${port}`)
