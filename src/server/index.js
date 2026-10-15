import 'ses'
import '../core/lockdown'
import './bootstrap'

import fs from 'fs-extra'
import path from 'path'
import Fastify from 'fastify'
import ws from '@fastify/websocket'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import statics from '@fastify/static'

import { createServerWorld } from '../core/createServerWorld'
import { writePacket } from '../core/packets'
import { readJWT } from '../core/utils-server'
import { getDB } from './db'
import { Storage } from './Storage'
import { assets } from './assets'
import { collections } from './collections'
import { cleaner } from './cleaner'
import { escapeHtml } from './escapeHtml'
import { walletOf } from './solana-gating'
import { clientIpKey, createUploadLimits, readUploadLimitsEnv } from './uploadLimits'
import { createConnectionLimits, readConnectionLimitsEnv } from './connectionLimits'
import { assetRoutes, uploadRoutes } from './uploadRoutes'

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
if (!process.env.JWT_SECRET) {
  throw new Error('[envs] JWT_SECRET not set')
}
if (!process.env.ADMIN_CODE) {
  console.warn('[envs] ADMIN_CODE not set - all users will have admin permissions!')
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
// a client frame above this closes the connection (1009) before it is buffered. legitimate client packets
// are a few KB; the per-type caps below this live in core/extras/inboundPolicy.js
const WS_MAX_PAYLOAD = 1024 * 1024
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
if (process.env.ASSETS === 's3' && !process.env.ASSETS_S3_URI) {
  throw new Error(`[envs] ASSETS_S3_URI must be set when using ASSETS=s3`)
}

const fastify = Fastify({ logger: { level: 'error' } })

// create world folder if needed
await fs.ensureDir(worldDir)

// init assets
await assets.init({ rootDir, worldDir })

// init collections
await collections.init({ rootDir, worldDir })

// init db
const db = await getDB({ worldDir })

// init cleaner
await cleaner.init({ db })

// init storage
const storage = new Storage(path.join(worldDir, '/storage.json'))

// create world
const world = createServerWorld()
await world.init({
  assetsDir: assets.dir,
  assetsUrl: assets.url,
  db,
  assets,
  storage,
  collections: collections.list,
})

fastify.register(cors)
fastify.register(compress)
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
  setHeaders: res => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  },
})
if (world.assetsDir) {
  fastify.register(assetRoutes, { root: world.assetsDir })
}
fastify.register(ws, { options: { maxPayload: WS_MAX_PAYLOAD } })
// per-address connection limits, checked before a connection touches the database (see connectionLimits.js)
const connectionLimits = createConnectionLimits(connectionLimitsConfig)
fastify.register(worldNetwork)

const publicEnvs = {}
for (const key in process.env) {
  if (key.startsWith('PUBLIC_')) {
    const value = process.env[key]
    publicEnvs[key] = value
  }
}
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
      protected: process.env.ADMIN_CODE !== undefined ? true : false,
      connectedUsers: [],
      commitHash: process.env.COMMIT_HASH,
      uploads: uploadLimits.stats(),
    }
    for (const socket of world.network.sockets.values()) {
      status.connectedUsers.push({
        id: socket.player.data.userId,
        position: socket.player.position.value.toArray(),
        name: socket.player.data.name,
      })
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

fastify.setErrorHandler((err, req, reply) => {
  console.error(err)
  reply.status(500).send()
})

try {
  await fastify.listen({ port, host: '0.0.0.0' })
} catch (err) {
  console.error(err)
  console.error(`failed to launch on port ${port}`)
  process.exit(1)
}

async function worldNetwork(fastify) {
  fastify.get('/ws', { websocket: true }, (ws, req) => {
    // the address bucket is the one the upload limits use; a refused connection is told why and closed with
    // 1013 (try again later) before anything is looked up or serialised for it
    const header = uploadLimitsConfig.clientIpHeader
    const verdict = connectionLimits.admit(clientIpKey(header ? req.headers[header] : undefined, req.ip))
    if (!verdict.ok) {
      ws.send(writePacket('kick', 'connection_limit'))
      ws.close(1013, verdict.reason)
      return
    }
    ws.on('close', verdict.release)
    world.network.onConnection(ws, req.query)
  })
}

console.log(`server listening on port ${port}`)

// Graceful shutdown
process.on('SIGINT', async () => {
  await fastify.close()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await fastify.close()
  process.exit(0)
})
