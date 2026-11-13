// first of the server's own modules, so before lockdown runs: from here until the server listens, a start-up that
// fails ends the process with code 1 (startupExit.js)
import { startup } from './startupExitInstall'
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

import { createServerWorld } from '../core/createServerWorld'
import { buildPublicEnv, unlistedPublicEnvNote } from '../core/extras/publicEnv'
import { claimedSessionUser, readJWT, readJWTNow } from '../core/utils-server'
import { getDB } from './db'
import { Storage, readStorageLimitsEnv } from './Storage'
import { installShutdown, stopApps } from './shutdown'
import { assets } from './assets'
import { collections } from './collections'
import { cleaner } from './cleaner'
import { errorHandler } from './errorHandler'
import { checkJwtSecret, checkPreviousJwtSecret } from './jwtSecret'
import { adminMode, adminStartupNotes } from './adminCode'
import { pageRoutes, readHstsEnv, securityHeaders } from './pageRoutes'
import { cspReportRoute } from './cspReports'
import { walletOf } from './solana-gating'
import { createUploadLimits, readUploadLimitsEnv } from './uploadLimits'
import { createConnectionLimits, keptPlacesNote, readConnectionLimitsEnv } from './connectionLimits'
import { createWsRoute } from './wsRoute'
import { assetRoutes, uploadRoutes } from './uploadRoutes'
import { readKickEnv } from './kickList'
import { describeHoldingContracts, readHoldingContractsEnv } from './evmHoldings'

// check envs
if (!process.env.WORLD) {
  throw new Error('[envs] WORLD not set')
}
const rootDir = path.join(__dirname, '../')
// (after the check: path.join throws its own error for a missing name, which said nothing about WORLD)
const worldDir = path.join(rootDir, process.env.WORLD)
const port = process.env.PORT
if (!process.env.PORT) {
  throw new Error('[envs] PORT not set')
}
// HSTS_MAX_AGE (pageRoutes.js): a bad value stops here
const hstsMaxAge = readHstsEnv(process.env)
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
// the contracts player.getEvmHolding() may ask about (evmHoldings.js): a bad value stops here, before the world
// loads. Said only where EVM wallets are configured
const holdingContracts = readHoldingContractsEnv(process.env)
if (process.env.PUBLIC_EVM_CHAIN_IDS?.trim()) {
  console.log(
    `[envs] player.getEvmHolding() asks only about ${
      holdingContracts.length ? describeHoldingContracts(holdingContracts) : 'no contract'
    } (${process.env.EVM_HOLDING_CONTRACTS === undefined ? 'the default: EVM_HOLDING_CONTRACTS is not set' : 'EVM_HOLDING_CONTRACTS'})`
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
const connectionLimitsConfig = readConnectionLimitsEnv(process.env) // WS_CONNECT_*, WS_RESERVED_*; throws on a bad value
// the places kept for ranked users (connectionLimits.js), as they are in effect for the admin mode, or why not
const keptPlacesLine = keptPlacesNote(connectionLimitsConfig, adminMode(process.env))
if (keptPlacesLine) console[keptPlacesLine.level](keptPlacesLine.message)
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
await startup.step(() => fs.ensureDir(worldDir))

// init assets
await startup.step(() => assets.init({ rootDir, worldDir }))

// init collections
await startup.step(() => collections.init({ rootDir, worldDir }))

// init db
const db = await startup.step(() => getDB({ worldDir }))

// init cleaner (before storage is opened: it reads storage.json itself, read-only)
const storageFile = path.join(worldDir, '/storage.json')
// the assets URL tells it which scripts are store files for certain; with ASSETS=local (an assets directory) what
// it removes goes to the trash for CLEAN_TRASH_DAYS
await startup.step(() =>
  cleaner.init({
    db,
    storageFile,
    assetsUrl: assets.url,
    localStore: Boolean(assets.dir),
    trashDays: cleanTrashDays,
    // the largest file it reads: a script came through an upload (PUBLIC_MAX_UPLOAD_SIZE), storage.json is held to
    // STORAGE_MAX_BYTES; a larger one (an older limit, a hand-made file) stops the clean-up
    readLimit: Math.max(maxUploadSize * 1024 * 1024, storageLimits.maxBytes || 0),
  })
)

// init storage
const storage = new Storage(storageFile, { limits: storageLimits })

// create world (its systems read their settings as they are made: one that refuses a value throws here, which
// still ends the start-up)
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
// The world's app scripts start in world.init: from here an uncaught exception no longer ends the start-up (content
// in a world must not be able to keep its server from starting), and the steps that can fail are awaited through
// startup.step
startup.scriptsStart()
await startup.step(() =>
  world.init({
    assetsDir: assets.dir,
    assetsUrl: assets.url,
    db,
    assets,
    storage,
    collections: collections.list,
    maxUploadSize,
  })
)
// World.start() does not wait for the systems: no connection is taken before the network has loaded the world, the
// user ids and the join-state accounting (it refuses any that arrives earlier, too)
await startup.step(() => world.network.ready)
// the join snapshot's fixed part for this configuration (its tokens, URLs and largest joiner), measured before
// anyone can join: world growth and visitors' joins count it (joinBudget.js)
await startup.step(() => world.network.measureFixedBytes())

// what the page is handed of the environment: the names on the lists of publicEnv.js (the ones the client reads, and
// three served as before). Any other PUBLIC_ name that is set is left out and said here once, by name (but
// PUBLIC_RPC_URL, which is left out without a word); the server starts all the same
const publicEnvs = buildPublicEnv(process.env)
const unlistedPublicEnvs = unlistedPublicEnvNote(process.env)
if (unlistedPublicEnvs) console.error(unlistedPublicEnvs)
const envsCode = `
  if (!globalThis.env) globalThis.env = {}
  globalThis.env = ${JSON.stringify(publicEnvs)}
`
fastify.register(cors)
fastify.register(compress, compressOptions())
// the headers of the replies and of the pages (pageRoutes.js says which, what they do and what they do not)
securityHeaders(fastify, { hstsMaxAge })
fastify.register(pageRoutes, {
  publicDir: path.join(__dirname, 'public'),
  page: () => ({
    title: world.settings.title || 'World',
    desc: world.settings.desc || '',
    image: world.resolveURL(world.settings.image?.url) || '',
    url: process.env.ASSETS_BASE_URL,
  }),
  envsCode,
})
// where browsers post what the world page's report-only policy would have refused (cspReports.js)
fastify.register(cspReportRoute, { clientIpHeader: uploadLimitsConfig.clientIpHeader })
if (world.assetsDir) {
  fastify.register(assetRoutes, { root: world.assetsDir })
}
// per-address connection limits, checked before a connection touches the database (see connectionLimits.js)
const connectionLimits = createConnectionLimits(connectionLimitsConfig)
// the /ws route (wsRoute.js): the transport's options, the admission by those limits and the route. `sessions`: what
// it asks of a session token for a place kept for ranked users, in the turn the request is admitted in
const wsRoute = createWsRoute({
  connectionLimits,
  clientIpHeader: uploadLimitsConfig.clientIpHeader,
  world,
  sessions: { readNow: readJWTNow, claimedUserId: claimedSessionUser },
})
fastify.register(ws, wsRoute.options)
fastify.register(wsRoute.register)

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

await startup.step(async () => {
  try {
    await fastify.listen({ port, host: '0.0.0.0' })
  } catch (err) {
    console.error(`failed to launch on port ${port}`)
    throw err
  }
})
// start-up is over: from here the exit code is the shutdown's (shutdown.js)
startup.listening()

console.log(`server listening on port ${port}`)
