import Busboy from '@fastify/busboy'
import statics from '@fastify/static'

import {
  assetHeaders,
  authorizeUpload,
  extensionOf,
  isAllowedExtension,
  isUploadCheckFilename,
  matchesSignature,
  parseBearer,
} from './uploadPolicy.js'

// explicit `.js` imports only: this module is exercised directly by node:test

const MULTIPART = /^multipart\/form-data(;|$)/i
const FRAMING_BYTES = 64 * 1024 // multipart headers and boundaries around the single file
const SLICE_BYTES = 64 * 1024 // how much of the body busboy sees per turn of the event loop
// the client sends exactly one `file` part; a few fields are tolerated, anything beyond is refused
const PART_LIMITS = { files: 1, parts: 8, fields: 4, fieldSize: 1024, headerPairs: 64 }

// parses a buffered multipart body with busboy. every listener is attached before the first byte is
// parsed, so a malformed or early-ended body is an ordinary rejection and never an unhandled stream error.
// the body is fed in slices with a turn of the event loop between them, and never past a rejection, so a
// hostile body cannot hold the loop. `accept(ext)` returns null to proceed or `{ status, error }` to refuse.
function parseUpload({ headers, body, maxUploadSize, accept }) {
  return new Promise(resolve => {
    const result = { upload: null, rejection: null }
    const reject = (status, error) => {
      if (!result.rejection) result.rejection = { status, error }
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let bb
    try {
      bb = Busboy({ headers, limits: { fileSize: maxUploadSize * 1024 * 1024, ...PART_LIMITS } })
    } catch (_err) {
      // no boundary, or a content type busboy cannot handle
      reject(400, 'malformed multipart body')
      return finish()
    }
    let files = 0
    bb.on('file', (fieldname, file, filename, encoding, mimetype) => {
      file.on('error', () => {})
      files++
      if (files > 1) {
        reject(400, 'one file per upload')
        return file.resume()
      }
      const ext = extensionOf(filename)
      const verdict = accept(ext)
      if (verdict) {
        reject(verdict.status, verdict.error)
        return file.resume()
      }
      const chunks = []
      file.on('data', chunk => chunks.push(chunk))
      file.on('limit', () => reject(413, `file exceeds ${maxUploadSize}MB`))
      file.on('end', () => {
        if (!file.truncated) result.upload = { filename, ext, mimetype, buffer: Buffer.concat(chunks) }
      })
    })
    bb.on('filesLimit', () => reject(400, 'one file per upload'))
    bb.on('partsLimit', () => reject(400, 'too many parts'))
    bb.on('fieldsLimit', () => reject(400, 'too many parts'))
    bb.on('error', () => {
      reject(400, 'malformed multipart body')
      finish()
    })
    bb.on('finish', finish)
    let offset = 0
    const feed = () => {
      if (settled) return
      if (result.rejection) return finish()
      if (offset >= body.length) return bb.end()
      const slice = body.subarray(offset, offset + SLICE_BYTES)
      offset += slice.length
      bb.write(slice, () => setImmediate(feed))
    }
    feed()
  })
}

/**
 * Upload Routes
 *
 * - readJWT(token) resolves to the token payload or null
 * - getSocket(userId) returns the live socket of a connected user, if any
 * - assets.upload(file) / assets.exists(filename)
 * - getSettings() returns the live world settings (customAvatars)
 * - maxUploadSize is in MB, the same limit the client applies
 *
 */
export async function uploadRoutes(fastify, { readJWT, getSocket, assets, getSettings, maxUploadSize }) {
  const maxBytes = maxUploadSize * 1024 * 1024

  // the body is buffered up to the cap (plus framing) and parsed by the route itself
  fastify.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: maxBytes + FRAMING_BYTES }, (req, body, done) =>
    done(null, body)
  )
  // keep the body-limit answer in the same shape as the other rejections; anything else goes to the parent handler
  fastify.setErrorHandler((err, req, reply) => {
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: `upload exceeds ${maxUploadSize}MB` })
    }
    throw err
  })
  fastify.decorateRequest('uploadSocket', null)

  const resolveSocket = async req => {
    const token = parseBearer(req.headers.authorization)
    if (!token) return null
    const data = await readJWT(token)
    if (!data?.userId) return null
    const socket = getSocket(data.userId)
    return socket && !socket.disconnected ? socket : null
  }

  // runs before any body parsing: the bearer token names the user, the live socket carries the rank
  const authenticate = async (req, reply) => {
    const socket = await resolveSocket(req)
    if (!socket) return reply.code(401).send({ error: 'upload requires a connected session' })
    req.uploadSocket = socket
  }

  // the part of the rank rule that needs no extension, and the body shape, still before parsing
  const authorizeRequest = async (req, reply) => {
    const { player } = req.uploadSocket
    if (!player.isBuilder() && !getSettings().customAvatars) {
      return reply.code(403).send({ error: 'builder rank required' })
    }
    if (!MULTIPART.test(req.headers['content-type'] || '')) {
      return reply.code(415).send({ error: 'expected multipart/form-data' })
    }
  }

  fastify.post('/api/upload', { onRequest: [authenticate, authorizeRequest] }, async (req, reply) => {
    const socket = req.uploadSocket
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: 'expected a multipart file' })
    }
    const { upload, rejection } = await parseUpload({
      headers: req.headers,
      body: req.body,
      maxUploadSize,
      accept: ext => {
        if (!isAllowedExtension(ext)) return { status: 415, error: `file type "${ext.slice(0, 16)}" is not allowed` }
        const auth = authorizeUpload({ player: socket.player, settings: getSettings(), ext })
        return auth.ok ? null : { status: 403, error: auth.reason }
      },
    })
    // the file bytes have been copied out; let the raw body go before the asset is written
    req.body = null
    if (rejection) return reply.code(rejection.status).send({ error: rejection.error })
    if (!upload) return reply.code(400).send({ error: 'expected a multipart file' })
    // the body took time to arrive: the session and the rank rule must still hold when the asset is committed
    if (getSocket(socket.id) !== socket || socket.disconnected) {
      return reply.code(401).send({ error: 'session ended during upload' })
    }
    const auth = authorizeUpload({ player: socket.player, settings: getSettings(), ext: upload.ext })
    if (!auth.ok) return reply.code(403).send({ error: auth.reason })
    const signature = matchesSignature(upload.ext, upload.buffer)
    if (!signature.ok) return reply.code(415).send({ error: signature.reason })
    // upload: the bytes go to storage as they are, without a File copy in between
    await assets.upload({ name: upload.filename, buffer: upload.buffer })
  })

  fastify.get('/api/upload-check', { onRequest: [authenticate] }, async (req, reply) => {
    const filename = req.query.filename
    if (!isUploadCheckFilename(filename)) return reply.code(400).send({ error: 'invalid asset filename' })
    const exists = await assets.exists(filename)
    return { exists }
  })
}

/**
 * Asset Routes
 *
 * serves the local assets dir. uploaded files never run as same-origin documents here: explicit type,
 * no sniffing, and anything that is not plain media is delivered as a sandboxed download.
 *
 */
export async function assetRoutes(fastify, { root }) {
  fastify.addHook('onSend', async (req, reply) => {
    reply.headers(assetHeaders(extensionOf(req.url.split('?')[0])))
  })
  fastify.register(statics, {
    root,
    prefix: '/assets/',
    decorateReply: false,
    setHeaders: res => {
      // all assets are hashed & immutable so we can use aggressive caching
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') // 1 year
      res.setHeader('Expires', new Date(Date.now() + 31536000000).toUTCString()) // older browsers
    },
  })
}
