import {
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import fs from 'fs-extra'
import path from 'path'
import zlib from 'node:zlib'
import { computeAssetFilename, isUploadedAssetFilename } from './assetFilename'
import { createOnce } from './coalesce'
import { assetName } from '../core/extras/assetURL'
import { assetHeaders, extensionOf } from './uploadPolicy'

// DeleteObjects takes at most 1000 keys per request
const DELETE_BATCH = 1000

// at most this many stacked content codings are undone (gzip over deflate is two)
const MAX_CODINGS = 2

const tooLarge = limit => Object.assign(new Error(`larger than ${limit} bytes`), { code: 'TOO_LARGE' })

// the object's bytes, at most `limit` of them (a larger one throws TOO_LARGE before more is read)
async function readBody(response, limit) {
  const body = response.Body
  if (Number(response.ContentLength) > limit) {
    body?.destroy?.()
    throw tooLarge(limit)
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let size = 0
    for await (const chunk of body) {
      size += chunk.length
      if (size > limit) {
        body.destroy?.()
        throw tooLarge(limit)
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  const bytes = await body.transformToByteArray()
  if (bytes.length > limit) throw tooLarge(limit)
  return Buffer.from(bytes)
}

// An object's text as an HTTP client receives it (readText, for the clean-up): a stored Content-Encoding is undone
// the way the server's fetch undoes it, gzip and deflate, in the reverse of the order they were applied, each stage
// held to `limit` bytes of output. Any other coding (br, which the server's fetch never decodes, compress, zstd),
// more than MAX_CODINGS of them, one that does not decode or one that grows past `limit` cannot be read for certain:
// it throws, and the clean-up deletes nothing.
function decodeObject(bytes, encoding, limit) {
  let buffer = Buffer.from(bytes)
  const codings = String(encoding ?? '')
    .split(',')
    .map(coding => coding.trim().toLowerCase())
    .filter(coding => coding && coding !== 'identity')
  if (codings.length > MAX_CODINGS) {
    throw Object.assign(new Error(`more than ${MAX_CODINGS} content codings`), { code: 'ENCODING' })
  }
  const options = Number.isFinite(limit) ? { maxOutputLength: Math.max(1, limit) } : {}
  for (const coding of codings.reverse()) {
    if (coding === 'gzip' || coding === 'x-gzip') buffer = zlib.gunzipSync(buffer, options)
    else if (coding === 'deflate') {
      // the zlib format HTTP means by deflate, or the raw one some servers send
      try {
        buffer = zlib.inflateSync(buffer, options)
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw err
        buffer = zlib.inflateRawSync(buffer, options)
      }
    } else throw Object.assign(new Error(`content encoding ${coding} is not read`), { code: 'ENCODING' })
  }
  return buffer.toString('utf8')
}

export class AssetsS3 {
  // `client`: an S3 client to use instead of one built from ASSETS_S3_URI (tests)
  constructor({ client } = {}) {
    this.url = process.env.ASSETS_BASE_URL

    // Parse S3 URI: s3://access_key:secret_key@endpoint/bucket/prefix
    // or for AWS: s3://access_key:secret_key@bucket.s3.region.amazonaws.com/prefix
    // or simple AWS: s3://access_key:secret_key@bucket/prefix (defaults to us-east-1)
    const uri = process.env.ASSETS_S3_URI
    if (!uri) {
      throw new Error('ASSETS_S3_URI environment variable is required')
    }

    const config = this.parseURI(uri)
    this.bucketName = config.bucket
    this.prefix = config.prefix || 'assets/'
    this.writes = new Map() // content filename -> the put in flight for it

    // Initialize S3 client
    this.client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: config.forcePathStyle,
      })
  }

  parseURI(uri) {
    try {
      // Remove s3:// prefix
      if (!uri.startsWith('s3://')) {
        throw new Error('S3 URI must start with s3://')
      }

      const withoutProtocol = uri.slice(5)

      // Extract credentials
      const credentialsMatch = withoutProtocol.match(/^([^:]+):([^@]+)@(.+)$/)
      if (!credentialsMatch) {
        throw new Error('Invalid S3 URI format')
      }

      const [, accessKeyId, secretAccessKey, rest] = credentialsMatch

      // Parse the rest of the URI
      const parts = rest.split('/')
      const host = parts[0]
      const pathParts = parts.slice(1)

      let config = {
        accessKeyId,
        secretAccessKey,
        forcePathStyle: false,
      }

      // Detect if this is AWS S3 or a custom endpoint
      if (host.includes('.amazonaws.com')) {
        // Example: play.hyperfy.xyz.s3.eu-west-1.amazonaws.com
        const hostParts = host.split('.')

        const s3Index = hostParts.indexOf('s3')
        if (s3Index === -1) {
          throw new Error('Invalid S3 host: missing "s3" in hostname')
        }

        // Bucket is everything before 's3'
        config.bucket = hostParts.slice(0, s3Index).join('.')

        // Region is the part right after 's3', if present
        config.region = hostParts[s3Index + 1] || 'us-east-1'

        // Build prefix and ensure it ends with a single slash
        config.prefix = pathParts.join('/')
        if (config.prefix && !config.prefix.endsWith('/')) {
          config.prefix += '/'
        }
      } else if (host.includes('.')) {
        // Custom endpoint (like R2): endpoint/bucket/prefix
        config.endpoint = `https://${host}`
        config.bucket = pathParts[0]
        config.prefix = pathParts.slice(1).join('/') + (pathParts.length > 1 ? '/' : '')
        config.region = 'auto' // For R2 and similar services
        config.forcePathStyle = true
      } else {
        // Simple format: bucket/prefix (defaults to AWS us-east-1)
        config.bucket = host
        config.prefix = pathParts.join('/') + (pathParts.length > 0 ? '/' : '')
        config.region = 'us-east-1'
      }

      return config
    } catch (error) {
      throw new Error(`Failed to parse S3 URI: ${error.message}`)
    }
  }

  async init({ rootDir, worldDir }) {
    console.log('[assets] initializing')
    // Verify bucket access
    try {
      await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          MaxKeys: 1,
        })
      )
    } catch (error) {
      throw new Error(`Failed to access S3 bucket: ${error.message}`)
    }

    // Upload built-in assets from local directory to S3
    const builtInAssetsDir = path.join(rootDir, 'src/world/assets')
    if (await fs.exists(builtInAssetsDir)) {
      await this.uploadDirectory(builtInAssetsDir, builtInAssetsDir)
    }
  }

  async uploadDirectory(localDir, baseDir, subPath = '') {
    const files = await fs.readdir(localDir)

    for (const file of files) {
      const filePath = path.join(localDir, file)
      const stat = await fs.stat(filePath)

      if (stat.isDirectory()) {
        // Recursively upload subdirectories
        const newSubPath = subPath ? path.join(subPath, file) : file
        await this.uploadDirectory(filePath, baseDir, newSubPath)
      } else {
        // Upload file with its original path structure
        const buffer = await fs.readFile(filePath)
        const relativePath = subPath ? path.join(subPath, file) : file

        // Always upload built-in assets (overwrite existing)
        await this.uploadBuffer(buffer, relativePath)
      }
    }
  }

  // resolves true when the object was written, false when the same content was already stored.
  // uploads of the same content that overlap put it once; the others are told it was already there
  async upload(file) {
    const { filename, buffer } = await computeAssetFilename(file)
    return createOnce(this.writes, filename, async () => {
      // Check if file already exists
      const exists = await this.exists(filename)
      if (exists) return false

      await this.uploadBuffer(buffer, filename)
      return true
    })
  }

  async uploadBuffer(buffer, filename) {
    const key = this.getKey(filename)

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: buffer,
          // Optional: Set content type based on file extension
          ContentType: this.getContentType(filename),
          // Optional: Make objects publicly readable if needed
          // ACL: 'public-read',
        })
      )
    } catch (error) {
      throw new Error(`Failed to upload to S3: ${error.message}`)
    }
  }

  async exists(filename) {
    const key = this.getKey(filename)

    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        })
      )
      return true
    } catch (error) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false
      }
      throw error
    }
  }

  async list() {
    const assets = new Set()
    let continuationToken = undefined

    do {
      try {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucketName,
            Prefix: this.prefix,
            ContinuationToken: continuationToken,
          })
        )

        if (response.Contents) {
          for (const object of response.Contents) {
            // Remove prefix from key to get filename
            const filename = object.Key.replace(this.prefix, '')

            // HACK: we only want to include uploaded assets (not core/assets/*) so we do a check
            // if its filename is a 64 character hash
            const isAsset = isUploadedAssetFilename(filename)
            if (isAsset) {
              assets.add(filename)
            }
          }
        }

        continuationToken = response.NextContinuationToken
      } catch (error) {
        throw new Error(`Failed to list S3 objects: ${error.message}`)
      }
    } while (continuationToken)

    return assets
  }

  // the text of a stored asset://<name>, or null when there is no such object (cleaner: scripts' asset literals).
  // Only S3's definite answer for a missing key (NoSuchKey) is "no such object"; any other error, a 404 for a
  // missing bucket (NoSuchBucket) or a refused read (AccessDenied, 403) included, is thrown. `limit`: the most bytes
  // read, and the most each content-coding stage may produce (the clean-up's largest script); more throws TOO_LARGE
  async readText(name, { limit = Infinity } = {}) {
    if (assetName(`asset://${name}`) === null) throw new Error('invalid asset name')
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: this.getKey(name) }))
      return decodeObject(await readBody(response, limit), response.ContentEncoding, limit)
    } catch (error) {
      if (error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey') return null
      throw error
    }
  }

  // assets: any iterable of filenames (the cleaner passes a Set)
  // Resolves { failed: [{ name, code }] }: DeleteObjects answers per key, and a key it lists under Errors (AccessDenied,
  // InternalError, ...) is still there, so the cleaner does not count it as deleted
  async delete(assets) {
    const names = Array.from(assets)
    const failed = []
    if (names.length === 0) return { failed }

    const chunks = []
    for (let i = 0; i < names.length; i += DELETE_BATCH) {
      chunks.push(names.slice(i, i + DELETE_BATCH))
    }

    for (const chunk of chunks) {
      const objects = chunk.map(asset => ({
        Key: this.getKey(asset),
      }))

      let response
      try {
        response = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucketName,
            Delete: {
              Objects: objects,
            },
          })
        )
      } catch (error) {
        throw new Error(`Failed to delete from S3: ${error.message}`)
      }
      for (const error of response?.Errors ?? []) {
        const key = typeof error?.Key === 'string' ? error.Key : ''
        failed.push({
          name: key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key,
          code: String(error?.Code ?? 'unknown'),
        })
      }
    }
    return { failed }
  }

  // Helper methods
  getKey(filename) {
    return `${this.prefix}${filename}`
  }

  // the type the local /assets/ route serves for this extension (uploadPolicy.js): every extension uploads accept
  // and the built-in assets' own; anything else is application/octet-stream. The bucket's front must still add
  // nosniff and the download headers for non-media files itself (README)
  getContentType(filename) {
    return assetHeaders(extensionOf(filename))['Content-Type']
  }
}
