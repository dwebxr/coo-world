import * as THREE from '../extras/three'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
// the vendored parser: it charges a per-file budget where it allocates (see its COO_BUDGET sites)
import { GLTFLoader } from '../libs/gltfloader/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'

import { System } from './System'
import { createNode } from '../extras/createNode'
import { createVRMFactory } from '../extras/createVRMFactory'
import { glbToNodes } from '../extras/glbToNodes'
import { createEmoteFactory } from '../extras/createEmoteFactory'
import { formatBytes } from '../extras/formatBytes'
import { imageElementsPlugin, isAppleMobile } from '../extras/gltfImageElements'
import { checkGLTF, createGLTFBudget, GLTF_LIMITS, isDataURI } from '../extras/gltfLimits'
import { IMAGE_HEADER_BYTES, MAX_IMAGE_PIXELS, readImageHeader } from '../extras/imageHeader'
import { emoteUrls } from '../extras/playerEmotes'
import Hls from 'hls.js/dist/hls.js'

// THREE.Cache.enabled = true

// What this client downloads and decodes for one asset. A URL from outside the world's store (a remote avatar, a
// model or image a script names) is limited by its kind, below: nothing limited it at upload, and every client
// that sees it loads it. A file in the world's own store may also be as large as the world's upload limit,
// whatever its kind, so a file that could be uploaded can be loaded (see maxBytes).
const MiB = 1024 * 1024
const MAX_BYTES = {
  script: 2 * MiB,
  image: 32 * MiB,
  texture: 32 * MiB,
  hdr: 64 * MiB,
  audio: 64 * MiB,
  model: 64 * MiB,
  avatar: 64 * MiB,
  emote: 32 * MiB,
}
// any other kind, and the world's own store while its upload limit is not known (the viewer, before the snapshot)
const MAX_BYTES_DEFAULT = 64 * MiB
// The pixel budget, MAX_IMAGE_PIXELS, is in imageHeader.js (shared with the model checks). It applies to images,
// textures, HDRs and every texture inside a model, avatar or emote.
// The bytes read for an image's size before it is decoded (IMAGE_HEADER_BYTES, 256 KiB): enough for any PNG or WebP
// header, and for a JPEG whose start of frame comes after its usual EXIF and colour-profile segments (a longer one is
// read whole). The data: images inside a model are read the same way (gltfLimits.js)
// downloads kept for re-use (exports, the file fields). Files of the world's own store are always kept; of the
// others only the most recently used few, and none above this size
const REMOTE_FILE_LIMIT = 16
const REMOTE_FILE_MAX_BYTES = 16 * MiB
// results (models, textures, clips, video factories) kept for URLs outside the world's store, least recently used
// first out. What is in use stays alive through its users; this bounds what a stream of new URLs can pin. A load
// still in progress is never dropped: it ends within the download deadlines and is counted then
const REMOTE_RESULT_LIMIT = 128
// a download that receives nothing for this long, or is still running after this long, is abandoned (counted from
// when it starts, not while it waits for a slot)
const STALL_MS = 30_000
const DOWNLOAD_MS = 120_000
// transfers (download and decode) at once: the world's own store and other hosts have pools of their own, so slow
// hosts cannot hold up the world's assets. A request waiting for a slot has not opened its download. This is also
// the bound on the bytes in flight: each transfer is within its kind's limit (a stated length over it is refused
// before reading, a body that grows past it is cut off), so downloads from other hosts hold at most 4 x 64 MiB =
// 256 MiB at the very worst, and the world's own at most 8 x the upload limit (or the kind's limit, if larger).
// Responses are decoded, so a stated length does not bound the body, and no tighter promise is made
const OWN_TRANSFERS = 8
const REMOTE_TRANSFERS = 4
// requests for other hosts waiting or running at once; past this a new one fails at once and is not kept. The
// world's own requests are not capped in number (a large world preloads every asset at once), only in concurrency
const REMOTE_REQUEST_LIMIT = 256

const destroyedError = () => new Error('the loader was destroyed')
const createPools = () => ({
  own: { limit: OWN_TRANSFERS, active: 0, queue: [] },
  remote: { limit: REMOTE_TRANSFERS, active: 0, queue: [] },
})
// a Radiance header is a few lines; one that has not given its size and format by this point is refused
const HDR_HEADER_MAX = 64 * 1024

const tooLarge = maxBytes => new Error(`file is larger than ${maxBytes} bytes`)

function parseURL(url, base) {
  try {
    return new URL(url, base)
  } catch {
    return null
  }
}

// a relative URL (a relative assets URL, '/day2.hdr') is read against the page, as fetch reads it
const pageURL = () => globalThis.location?.href || 'http://localhost/'

// reads a response body up to a limit, so an oversized or endless download ends instead of filling memory. `race`
// settles a wait as soon as the transfer is abandoned; `onData` is told when bytes arrive. The caller aborts the
// transfer when this throws
async function readBody(resp, maxBytes, race, onData) {
  const type = resp.headers.get('content-type') || ''
  const length = resp.headers.get('content-length')
  const declared = length === null ? NaN : Number(length)
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes)
  if (resp.body === null) return new Blob([], { type })
  if (typeof resp.body?.getReader !== 'function') {
    // nothing to count as it arrives: only a body whose length is stated, and within the limit, is read whole
    if (!(Number.isFinite(declared) && declared >= 0)) throw new Error('asset response has no length and no stream')
    const blob = await race(resp.blob())
    if (blob.size > maxBytes) throw tooLarge(maxBytes)
    return blob
  }
  const reader = resp.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await race(reader.read())
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw tooLarge(maxBytes)
      onData(size)
      chunks.push(value)
    }
  } catch (err) {
    reader.cancel().catch(() => {})
    throw err
  }
  return new Blob(chunks, { type })
}

// The size of a PNG, JPEG or WebP read from its header, checked before anything decodes it: a file of a few hundred
// bytes can declare 100000 x 100000. One that is malformed (a second JPEG frame header, a second IHDR, a WebP frame
// that does not match its canvas) is refused: decoders disagree about such files. Any other format (GIF, AVIF, SVG,
// BMP, ...) goes to the browser's decoder as before, and decodeImage checks what it decoded.
async function checkImageHeader(file) {
  const head = new Uint8Array(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer())
  let header = readImageHeader(head)
  // not settled in the first bytes (a long colour profile, an animated WebP): the whole file
  if (header?.incomplete && file.size > head.length) header = readImageHeader(new Uint8Array(await file.arrayBuffer()))
  if (!header) return
  if (header.malformed) throw new Error(`image is a malformed ${header.type} (${header.malformed})`)
  if (header.incomplete) throw new Error(`image is a ${header.type} cut short`)
  if (!(header.width > 0 && header.height > 0)) throw new Error('image has no width or height')
  if (header.width * header.height > MAX_IMAGE_PIXELS)
    throw new Error(`image is larger than ${MAX_IMAGE_PIXELS} pixels`)
}

// an <img> for a file; rejects when the browser cannot decode it, it has no size, or it is larger than the pixel
// budget. The object URL is released either way: no consumer reads the element's src, and a registered URL keeps
// the file's bytes alive for as long as the page lives, whatever the caches drop
function decodeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const src = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(src)
      // no intrinsic size (an SVG without width and height, in some browsers): nothing to size a texture or a
      // layout from, and its aspect ratio would be NaN
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return reject(new Error('image has no width or height'))
      if (img.naturalWidth * img.naturalHeight > MAX_IMAGE_PIXELS) {
        return reject(new Error(`image is larger than ${MAX_IMAGE_PIXELS} pixels`))
      }
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(src)
      reject(new Error('image could not be decoded'))
    }
    img.src = src
  })
}

// The width and height RGBELoader.parse will read from a Radiance header, checked before it allocates width x
// height pixels (a file of a few bytes can declare a billion rows). It mirrors the parser: the first line is the
// `#?` magic, `#` lines are comments, and the header ends at the first point where both FORMAT= and a
// `-Y <height> +X <width>` line (the only orientation the parser takes) have been seen. Every resolution line up
// to there, in any orientation the format defines, must name positive whole numbers within the pixel budget.
const HDR_FORMAT = /^\s*FORMAT=(\S+)\s*$/
const HDR_RESOLUTION = /^\s*([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)\s*$/
function readHDRSize(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, HDR_HEADER_MAX))
  let line = ''
  let first = true
  let format = false
  let size = null
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 10) {
      line += String.fromCharCode(bytes[i])
      continue
    }
    const current = line
    line = ''
    if (first) {
      if (!/^#\?\S/.test(current)) throw new Error('not a Radiance HDR file')
      first = false
      continue
    }
    if (current.charAt(0) === '#') continue
    if (HDR_FORMAT.test(current)) format = true
    const match = current.match(HDR_RESOLUTION)
    if (match) {
      const a = Number(match[3])
      const b = Number(match[6])
      if (match[2] === match[5] || !Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < 1) {
        throw new Error('HDR size is not two positive whole numbers')
      }
      if (a * b > MAX_IMAGE_PIXELS) throw new Error(`image is larger than ${MAX_IMAGE_PIXELS} pixels`)
      if (match[1] === '-' && match[2] === 'Y' && match[4] === '+' && match[5] === 'X') size = { width: b, height: a }
    }
    if (format && size) return size
  }
  throw new Error('HDR header gives no size and format')
}

// A model, avatar or emote may only use what is inside its file. An external buffer or image (a URI in the file)
// would be fetched outside this loader's limits, deadlines and caches, and the server cannot load one either; it
// never worked for an uploaded .glb or .vrm (they are parsed without a base path). data: URIs and the blob: URLs
// the parser makes for embedded images get through. An external buffer fails the load; an external image leaves
// its material without that texture (the parser's own handling of a texture that fails).
function embeddedOnly(url) {
  // (a data: URI's scheme in any case, as the check and the parser read it; a blob: URL is the parser's own)
  if (isDataURI(url) || (typeof url === 'string' && url.startsWith('blob:'))) return url
  throw new Error(`a model may not reference external files (${String(url).slice(0, 100)})`)
}

// every texture a parsed file holds: the material slots three fills and the uniforms of shader materials (three-vrm's
// MToon keeps its textures there), in every scene of the file, plus any the parser made
function gltfTextures(glb) {
  const textures = new Set()
  const add = value => {
    if (value?.isTexture) textures.add(value)
  }
  const materials = new Set()
  for (const scene of glb?.scenes?.length ? glb.scenes : [glb?.scene]) {
    scene?.traverse?.(node => {
      for (const material of [node.material].flat()) if (material) materials.add(material)
    })
  }
  for (const material of materials) {
    for (const key of Object.keys(material)) add(material[key])
    for (const uniform of Object.values(material.uniforms || {})) add(uniform?.value)
  }
  for (const object of glb?.parser?.associations?.keys?.() || []) add(object)
  return textures
}

function imagePixels(image) {
  if (Array.isArray(image)) return Math.max(0, ...image.map(imagePixels))
  if (!image) return 0
  // an <img> (the iPhone path) has natural dimensions; an ImageBitmap or raw data has width and height
  const width = Number(image.naturalWidth ?? image.width) || 0
  const height = Number(image.naturalHeight ?? image.height) || 0
  return width * height
}

// the textures of a parsed file within the pixel budget, as images and textures loaded on their own are. Its images
// are already decoded by then (the browser decodes them inside the parser): what this prevents is keeping and
// uploading them
function assertTextureBudget(glb) {
  for (const texture of gltfTextures(glb)) {
    if (imagePixels(texture.image) > MAX_IMAGE_PIXELS) {
      throw new Error(`a texture in the file is larger than ${MAX_IMAGE_PIXELS} pixels`)
    }
  }
}

// releases what a refused file made: its decoded images, textures, geometries and materials
function disposeGLTF(glb) {
  for (const texture of gltfTextures(glb)) {
    for (const image of [texture.image].flat()) image?.close?.()
    texture.dispose()
  }
  for (const scene of glb?.scenes?.length ? glb.scenes : [glb?.scene]) {
    scene?.traverse?.(node => {
      node.geometry?.dispose?.()
      for (const material of [node.material].flat()) material?.dispose?.()
    })
  }
}

function renamed(file, name) {
  return new File([file], name, {
    type: file.type, // Preserve the MIME type
    lastModified: file.lastModified, // Preserve the last modified timestamp
  })
}

/**
 * Client Loader System
 *
 * - Runs on the client
 * - Basic file loader for many different formats, cached.
 *
 * Every load is filed under its kind and the URL of its resource (resourceURL): in the world's own store the query
 * and hash are not part of it. has/get/load/insert and setFile/getFile/hasFile all use that form, while callers
 * keep passing the URL they have.
 */
export class ClientLoader extends System {
  constructor(world) {
    super(world)
    this.files = new Map() // resource url -> File
    this.promises = new Map() // load key -> the request filed under it
    this.results = new Map() // load key -> its result, once that request has succeeded
    this.pending = new Set() // requests not yet settled (never dropped by the bound)
    this.remoteFiles = new Set() // urls outside the world's store whose file is kept, least recently used first
    this.remoteKeys = new Set() // load keys outside the world's store, least recently used first
    this.stallMs = STALL_MS
    this.downloadMs = DOWNLOAD_MS
    this.remoteFileMaxBytes = REMOTE_FILE_MAX_BYTES
    // bounded transfers: slots per pool, requests for other hosts
    this.pools = createPools()
    this.remoteRequestLimit = REMOTE_REQUEST_LIMIT
    this.remoteRequests = 0
    // transfers asked for, per resource url, from the moment they are queued: marked stale when a newer file is put
    // or the kept one removed, so they do not write theirs over it
    this.transfers = new Map()
    // bumped by destroy(): nothing that started before writes afterwards
    this.life = 0
    this.rgbeLoader = new RGBELoader()
    const manager = new THREE.LoadingManager()
    manager.setURLModifier(embeddedOnly)
    this.gltfLoader = new GLTFLoader(manager)
    // iPhone and iPad: images as <img> elements, which WebKit can let go of when memory runs low
    if (isAppleMobile()) this.gltfLoader.register(imageElementsPlugin)
    this.gltfLoader.register(parser => new VRMLoaderPlugin(parser))
    this.preloadItems = []
  }

  start() {
    this.vrmHooks = {
      camera: this.world.camera,
      scene: this.world.stage.scene,
      octree: this.world.stage.octree,
      setupMaterial: this.world.setupMaterial,
      loader: this.world.loader,
    }
  }

  // the canonical form (origin and path) of a resolved URL in the world's own asset store, or null for any other
  // URL. Compared parsed, so a relative assets URL, a differently-cased host or a `..` segment does not decide it
  ownAssetURL(url) {
    if (typeof url !== 'string') return null
    const raw = this.world.assetsUrl
    if (typeof raw !== 'string' || !raw) return null
    if (this.assetsBase?.raw !== raw) {
      const parsed = parseURL(raw, pageURL())
      const ok = !!parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      this.assetsBase = { raw, ok, origin: parsed?.origin, prefix: `${parsed?.pathname.replace(/\/+$/, '')}/` }
    }
    const base = this.assetsBase
    if (!base.ok) return null
    const target = parseURL(url, pageURL())
    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) return null
    if (target.origin !== base.origin || !target.pathname.startsWith(base.prefix)) return null
    return `${target.origin}${target.pathname}`
  }

  // whether a resolved URL is in the world's own asset store
  isOwnAsset(url) {
    return this.ownAssetURL(url) !== null
  }

  // the URL a file and a load are filed under. In the world's own store the query and hash are not part of the
  // resource (a stored file is named by its hash, and `?s=1.5` on an emote is a playback option the avatar reads
  // from the URL itself), so `asset://x.glb?i=1` and `asset://x.glb?i=2` are one download, one file and one result.
  // Any other URL is kept as resolved
  resourceURL(url) {
    if (typeof url !== 'string') return url
    const resolved = this.world.resolveURL(url)
    return this.ownAssetURL(resolved) ?? resolved
  }

  keyFor(type, url) {
    return `${type}/${this.resourceURL(url)}`
  }

  // the most this client reads for one asset of a kind, wherever the file comes from (network, cache, insert). In
  // the world's own store: the upload limit (a 3 MiB script that a 12 MB limit accepted loads after a reload), and
  // never less than the table, so a file uploaded while the limit was higher still loads after it is lowered
  maxBytes(type, resource) {
    const table = MAX_BYTES[type] ?? MAX_BYTES_DEFAULT
    if (!this.isOwnAsset(resource)) return table
    const mb = Number(this.world.network?.maxUploadSize)
    return Math.max(table, mb > 0 ? mb * MiB : MAX_BYTES_DEFAULT)
  }

  has(type, url) {
    return this.promises.has(this.keyFor(type, url))
  }

  get(type, url) {
    const key = this.keyFor(type, url)
    const result = this.results.get(key)
    if (result !== undefined && this.remoteKeys.has(key)) this.touch(key)
    return result
  }

  preload(type, url) {
    this.preloadItems.push({ type, url })
  }

  execPreload() {
    let loadedItems = 0
    let totalItems = this.preloadItems.length
    let progress = 0
    const promises = this.preloadItems.map(item => {
      return this.load(item.type, item.url).then(() => {
        loadedItems++
        progress = (loadedItems / totalItems) * 100
        this.world.emit('progress', progress)
      })
    })
    this.preloader = Promise.allSettled(promises).then(() => {
      this.preloader = null
      // this.world.emit('ready', true)
    })
  }

  setFile(url, file) {
    this.keepFile(this.resourceURL(url), file)
  }

  hasFile(url) {
    return this.files.has(this.resourceURL(url))
  }

  getFile(url, name) {
    const file = this.cachedFile(this.resourceURL(url))
    if (!file) return null
    return name ? renamed(file, name) : file
  }

  // a kept file, which becomes the most recently used
  cachedFile(resource) {
    const file = this.files.get(resource)
    if (!file) return null
    if (this.remoteFiles.has(resource)) {
      this.remoteFiles.delete(resource)
      this.remoteFiles.add(resource)
    }
    return file
  }

  keepFile(resource, file) {
    // whatever a download in progress for this url brings is older than this
    this.invalidate(resource)
    if (this.isOwnAsset(resource)) {
      this.files.set(resource, file)
      return
    }
    // a newer file for the url replaces the kept one, also when it is too large to keep
    if (file.size > this.remoteFileMaxBytes) return this.forgetFile(resource)
    this.remoteFiles.delete(resource)
    this.remoteFiles.add(resource)
    this.files.set(resource, file)
    for (const old of this.remoteFiles) {
      if (this.remoteFiles.size <= REMOTE_FILE_LIMIT) break
      this.remoteFiles.delete(old)
      this.files.delete(old)
      this.invalidate(old)
    }
  }

  // forgets the kept file for a url; with `file`, only while that is still the one kept (a newer download or insert
  // stays)
  forgetFile(resource, file) {
    if (file && this.files.get(resource) !== file) return
    this.files.delete(resource)
    this.remoteFiles.delete(resource)
    this.invalidate(resource)
  }

  // downloads in progress for a url no longer write their file when they finish
  invalidate(resource) {
    for (const transfer of this.transfers.get(resource) || []) transfer.stale = true
  }

  // the file behind a URL, from the cache or the network, within the size limit (`maxBytes`, by default the one for
  // a file of no particular kind). `name`: a copy under that name (a download for the user). The returned file is
  // the caller's even when it is not kept. A download waits for a transfer slot, as a load does
  loadFile = async (url, { maxBytes, name } = {}) => {
    const resource = this.resourceURL(url)
    const limit = maxBytes ?? this.maxBytes(null, resource)
    let file = this.cachedFile(resource)
    if (file) {
      if (file.size > limit) throw tooLarge(limit)
    } else {
      const remote = !this.isOwnAsset(resource)
      const leave = this.enter(remote)
      const transfer = this.beginTransfer(resource, remote)
      try {
        file = await this.transferFile(resource, limit, transfer)
      } finally {
        this.endTransfer(transfer)
        leave()
      }
    }
    return name ? renamed(file, name) : file
  }

  // A transfer is filed from the moment it is asked for, so a newer file put while it waits for a slot or
  // downloads marks it stale (invalidate). `life`: the loader's lifecycle it belongs to
  beginTransfer(resource, remote) {
    const transfer = { resource, remote, stale: false, life: this.life, fail: null }
    let list = this.transfers.get(resource)
    if (!list) this.transfers.set(resource, (list = new Set()))
    list.add(transfer)
    return transfer
  }

  endTransfer(transfer) {
    const list = this.transfers.get(transfer.resource)
    if (!list) return
    list.delete(transfer)
    if (list.size === 0) this.transfers.delete(transfer.resource)
  }

  // waits for a slot, then reads the file (and, with `decode`, turns it into the result while it holds the slot). A
  // request from before destroy() fails before it takes a slot and again after it got one; the cache is read only
  // once the slot is granted, so a file put while the request waited is the one used
  async transferFile(resource, limit, transfer, decode) {
    if (transfer.life !== this.life) throw destroyedError()
    const release = await this.acquire(transfer.remote)
    try {
      if (transfer.life !== this.life) throw destroyedError()
      const file = await this.readFile(resource, limit, transfer)
      return decode ? await decode(file) : file
    } finally {
      release()
    }
  }

  // the file for a transfer that holds a slot: kept, or downloaded
  async readFile(resource, limit, transfer) {
    const file = this.cachedFile(resource)
    if (!file) return this.fetchFile(resource, limit, transfer)
    // the same limit as a download: a file kept from another kind of load (or setFile) is checked again
    if (file.size > limit) throw tooLarge(limit)
    return file
  }

  // downloads a file and keeps it, unless a newer file was put for the url meanwhile or the loader was destroyed
  async fetchFile(resource, limit, transfer) {
    const blob = await this.download(resource, limit, transfer)
    const file = new File([blob], resource.split('/').pop(), { type: blob.type })
    if (!transfer.stale && transfer.life === this.life) this.keepFile(resource, file)
    return file
  }

  // requests for other hosts are capped while they wait or run; returns the function that leaves the count
  enter(remote) {
    if (!remote) return () => {}
    if (this.remoteRequests >= this.remoteRequestLimit) {
      throw new Error(`too many downloads from other hosts at once (${this.remoteRequestLimit}); try again later`)
    }
    this.remoteRequests++
    const life = this.life
    let left = false
    return () => {
      if (left || life !== this.life) return
      left = true
      this.remoteRequests--
    }
  }

  // a transfer slot in the pool for the url's host, in order of asking; resolves to the function that frees it
  acquire(remote) {
    const pool = remote ? this.pools.remote : this.pools.own
    const life = this.life
    return new Promise((resolve, reject) => {
      const grant = () => {
        pool.active++
        let freed = false
        resolve(() => {
          if (freed || life !== this.life) return
          freed = true
          pool.active--
          while (pool.active < pool.limit && pool.queue.length) pool.queue.shift().grant()
        })
      }
      if (pool.active < pool.limit) grant()
      else pool.queue.push({ grant, reject })
    })
  }

  // one transfer, abandoned (and its connection aborted) on any refusal: an error status, a size over the limit, no
  // data for stallMs, longer than downloadMs in all, or destroy()
  async download(url, maxBytes, transfer) {
    const controller = new AbortController()
    let failure = null
    let stall
    let abandoned
    const ended = new Promise((resolve, reject) => (abandoned = reject))
    ended.catch(() => {})
    const fail = err => {
      if (failure) return
      failure = err
      abandoned(err)
      controller.abort(err)
    }
    transfer.fail = fail
    // a request from before destroy() does not start a transfer after it
    if (transfer.life !== this.life) fail(destroyedError())
    const onData = () => {
      clearTimeout(stall)
      stall = setTimeout(() => fail(new Error(`download stalled: no data for ${this.stallMs / 1000} s`)), this.stallMs)
    }
    const deadline = setTimeout(
      () => fail(new Error(`download took longer than ${this.downloadMs / 1000} s`)),
      this.downloadMs
    )
    // a wait ends when the transfer is abandoned, also where the transport does not honour the abort
    const race = promise => Promise.race([promise, ended])
    onData()
    try {
      if (failure) throw failure
      const resp = await race(fetch(url, { signal: controller.signal }))
      onData()
      // an error page is not the asset: it used to be parsed as the model, image or script
      if (!resp.ok) throw new Error(`asset request failed: HTTP ${resp.status}`)
      return await readBody(resp, maxBytes, race, onData)
    } catch (err) {
      fail(err)
      throw failure
    } finally {
      clearTimeout(deadline)
      clearTimeout(stall)
      transfer.fail = null
    }
  }

  // keeps a request under its key. Only the request still filed there writes its result: one that was dropped by
  // the bound or replaced (an insert), or one from before destroy(), must not bring its key back. A failure is
  // forgotten, so the asset can be asked for again (an upload still in flight, a network blip); `onFailure`
  // releases what it leaves behind
  register(key, remote, run, onFailure) {
    const life = this.life
    const current = () => life === this.life && this.promises.get(key) === promise
    const promise = Promise.resolve()
      .then(run)
      .then(
        result => {
          this.pending.delete(promise)
          if (current()) this.results.set(key, result)
          this.evict()
          return result
        },
        err => {
          this.pending.delete(promise)
          if (current()) this.forget(key)
          if (life === this.life) onFailure?.()
          throw err
        }
      )
    this.pending.add(promise)
    this.promises.set(key, promise)
    this.results.delete(key)
    if (remote) this.touch(key)
    // a caller that ignores a failure does not turn it into an unhandled rejection
    promise.catch(() => {})
    return promise
  }

  forget(key) {
    this.promises.delete(key)
    this.results.delete(key)
    this.remoteKeys.delete(key)
  }

  // a key outside the world's store becomes the most recently used
  touch(key) {
    this.remoteKeys.delete(key)
    this.remoteKeys.add(key)
    this.evict()
  }

  // settled loads outside the world's store beyond the bound, least recently used first
  evict() {
    for (const old of this.remoteKeys) {
      if (this.remoteKeys.size <= REMOTE_RESULT_LIMIT) break
      if (this.pending.has(this.promises.get(old))) continue
      this.forget(old)
    }
  }

  async load(type, url) {
    if (this.preloader) {
      await this.preloader
    }
    const resource = this.resourceURL(url)
    const key = `${type}/${resource}`
    const existing = this.promises.get(key)
    if (existing) {
      if (this.remoteKeys.has(key)) this.touch(key)
      return existing
    }
    const remote = !this.isOwnAsset(resource)
    if (type === 'video') {
      // the element streams the video itself; only the factory is kept, under the same bound
      return this.register(key, remote, () => createVideoFactory(this.world, resource))
    }
    // past the cap for other hosts this fails at once and nothing is kept
    const leave = this.enter(remote)
    const transfer = this.beginTransfer(resource, remote)
    let file = null
    return this.register(
      key,
      remote,
      async () => {
        try {
          return await this.transferFile(resource, this.maxBytes(type, resource), transfer, read => {
            file = read
            return this.decode(type, url, read)
          })
        } finally {
          this.endTransfer(transfer)
          leave()
        }
      },
      // bytes that do not decode are not kept: the next load fetches them again (the url may have been repaired)
      () => file && this.forgetFile(resource, file)
    )
  }

  // a file the user just picked, before its upload finishes: this client loads it from the file, validated and
  // decoded as a download is, and later loads of the url (of any kind) read that file. It needs no transfer slot:
  // there is nothing to download, and the user is waiting to see it
  insert(type, url, file) {
    const resource = this.resourceURL(url)
    const key = `${type}/${resource}`
    const remote = !this.isOwnAsset(resource)
    if (type === 'video') {
      return this.register(key, remote, () => createVideoFactory(this.world, URL.createObjectURL(file)))
    }
    const maxBytes = this.maxBytes(type, resource)
    if (file.size <= maxBytes) this.keepFile(resource, file)
    else this.forgetFile(resource)
    return this.register(
      key,
      remote,
      () => {
        if (file.size > maxBytes) throw tooLarge(maxBytes)
        return this.decode(type, url, file)
      },
      () => this.forgetFile(resource, file)
    )
  }

  // a file's bytes as the result of its kind; throws when they do not decode or are refused
  async decode(type, url, file) {
    if (type === 'hdr') {
      const buffer = await file.arrayBuffer()
      // the size comes from the header, before the parser allocates it
      readHDRSize(buffer)
      const result = this.rgbeLoader.parse(buffer)
      if (!(result.width * result.height <= MAX_IMAGE_PIXELS)) {
        throw new Error(`image is larger than ${MAX_IMAGE_PIXELS} pixels`)
      }
      // we just mimicing what rgbeLoader.load() does behind the scenes
      const texture = new THREE.DataTexture(result.data, result.width, result.height)
      texture.colorSpace = THREE.LinearSRGBColorSpace
      texture.minFilter = THREE.LinearFilter
      texture.magFilter = THREE.LinearFilter
      texture.generateMipmaps = false
      texture.flipY = true
      texture.type = result.type
      texture.needsUpdate = true
      return texture
    }
    if (type === 'image') {
      await checkImageHeader(file)
      return decodeImage(file)
    }
    if (type === 'texture') {
      // the decoded element is the texture's image: no second load of the same object URL
      await checkImageHeader(file)
      const img = await decodeImage(file)
      const texture = new THREE.Texture(img)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.needsUpdate = true
      return texture
    }
    if (type === 'model' || type === 'emote' || type === 'avatar') {
      const buffer = await file.arrayBuffer()
      // one budget per file, made first: the structure check before parsing is charged to it (and its clock), then
      // what the parser allocates and does, where it does
      const budget = createGLTFBudget({
        fileBytes: buffer.byteLength,
        maxTextureSize: this.world.graphics?.renderer?.capabilities?.maxTextureSize,
      })
      checkGLTF(buffer, GLTF_LIMITS, budget)
      const glb = await this.gltfLoader.parseAsync(buffer, '', budget)
      try {
        assertTextureBudget(glb)
        if (type === 'model') return buildModelResult(glb, this.world, file)
        if (type === 'emote') return buildEmoteResult(glb, url)
        return buildAvatarResult(glb, this.world, file, this.vrmHooks)
      } catch (err) {
        disposeGLTF(glb)
        throw err
      }
    }
    if (type === 'script') {
      const code = await file.text()
      return this.world.scripts.evaluate(code)
    }
    if (type === 'audio') {
      const buffer = await file.arrayBuffer()
      return this.world.audio.ctx.decodeAudioData(buffer)
    }
    throw new Error(`cannot load type: ${String(type).slice(0, 40)}`)
  }

  // nothing that started before writes afterwards: transfers are aborted, requests waiting for a slot fail, and the
  // counts start again
  destroy() {
    this.life++
    for (const list of this.transfers.values()) for (const transfer of list) transfer.fail?.(destroyedError())
    this.transfers.clear()
    for (const pool of Object.values(this.pools)) for (const waiter of pool.queue) waiter.reject(destroyedError())
    this.pools = createPools()
    this.remoteRequests = 0
    this.files.clear()
    this.promises.clear()
    this.results.clear()
    this.pending.clear()
    this.remoteFiles.clear()
    this.remoteKeys.clear()
    this.preloadItems = []
  }
}

function buildModelResult(glb, world, file) {
  const node = glbToNodes(glb, world)
  return {
    toNodes() {
      return node.clone(true)
    },
    getStats() {
      const stats = node.getStats(true)
      // append file size
      stats.fileBytes = file.size
      return stats
    },
  }
}

function buildEmoteResult(glb, url) {
  const factory = createEmoteFactory(glb, url)
  return {
    toClip(options) {
      return factory.toClip(options)
    },
  }
}

function buildAvatarResult(glb, world, file, vrmHooks) {
  const factory = createVRMFactory(glb, world.setupMaterial)
  const hooks = vrmHooks
  const node = createNode('group', { id: '$root' })
  const node2 = createNode('avatar', { id: 'avatar', factory, hooks })
  node.add(node2)
  return {
    factory,
    hooks,
    toNodes(customHooks) {
      const clone = node.clone(true)
      if (customHooks) {
        clone.get('avatar').hooks = customHooks
      }
      return clone
    },
    getStats() {
      const stats = node.getStats(true)
      // append file size
      stats.fileBytes = file.size
      return stats
    },
  }
}

/**
 * A regular video will load data automatically BUT a stream
 * needs to hit play() before it gets that data.
 *
 * The following code handles this for us, and when streaming
 * will hit play just until we get the data needed, then pause.
 *
 * Shared between ClientLoader.js (createVideoFactory) and ClientLiveKit.js (createPlayerScreen).
 */
export function prepareVideoElement(
  elem,
  state,
  { trackDuration = false, forcePlayOnMetadata = true, logDimensions = false } = {}
) {
  return new Promise(resolve => {
    let playing = false
    let data = false
    elem.addEventListener(
      'loadeddata',
      async () => {
        // if we needed to hit play to fetch data then revert back to paused
        if (playing) elem.pause()
        data = true
        state.width = elem.videoWidth
        state.height = elem.videoHeight
        if (trackDuration) state.duration = elem.duration
        if (logDimensions) console.log({ width: state.width, height: state.height })
        state.ready = true
        resolve()
      },
      { once: true }
    )
    elem.addEventListener(
      'loadedmetadata',
      async () => {
        // we need a gesture before we can potentially hit play
        // if we already have data do nothing, we're done!
        if (data) return
        // otherwise hit play to force data loading for streams
        if (forcePlayOnMetadata) {
          elem.play()
          playing = true
        }
      },
      { once: true }
    )
  })
}

function createVideoFactory(world, url) {
  const isHLS = url?.endsWith('.m3u8')
  const sources = {}
  const state = { width: undefined, height: undefined, duration: undefined, ready: false }
  let prepare
  function createSource(key) {
    const elem = document.createElement('video')
    elem.crossOrigin = 'anonymous'
    elem.playsInline = true
    elem.loop = false
    elem.muted = true
    elem.style.width = '1px'
    elem.style.height = '1px'
    elem.style.position = 'absolute'
    elem.style.opacity = '0'
    elem.style.zIndex = '-1000'
    elem.style.pointerEvents = 'none'
    elem.style.overflow = 'hidden'
    const needsPolyfill = isHLS && !elem.canPlayType('application/vnd.apple.mpegurl') && Hls.isSupported()
    if (needsPolyfill) {
      const hls = new Hls()
      hls.loadSource(url)
      hls.attachMedia(elem)
    } else {
      elem.src = url
    }
    const audio = world.audio.ctx.createMediaElementSource(elem)
    let n = 0
    let dead
    world.audio.ready(() => {
      if (dead) return
      elem.muted = false
    })
    // set linked=false to have a separate source (and texture)
    const texture = new THREE.VideoTexture(elem)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.anisotropy = world.graphics.maxAnisotropy
    if (!prepare) {
      prepare = prepareVideoElement(elem, state, { trackDuration: true })
    }
    function isPlaying() {
      return elem.currentTime > 0 && !elem.paused && !elem.ended && elem.readyState > 2
    }
    function play(restartIfPlaying = false) {
      if (restartIfPlaying) elem.currentTime = 0
      elem.play()
    }
    function pause() {
      elem.pause()
    }
    function stop() {
      elem.currentTime = 0
      elem.pause()
    }
    function release() {
      n--
      if (n === 0) {
        stop()
        audio.disconnect()
        texture.dispose()
        document.body.removeChild(elem)
        delete sources[key]
        // help to prevent chrome memory leaks
        // see: https://github.com/facebook/react/issues/15583#issuecomment-490912533
        elem.src = ''
        elem.load()
      }
    }
    const handle = {
      elem,
      audio,
      texture,
      prepare,
      get ready() {
        return state.ready
      },
      get width() {
        return state.width
      },
      get height() {
        return state.height
      },
      get duration() {
        return state.duration
      },
      get loop() {
        return elem.loop
      },
      set loop(value) {
        elem.loop = value
      },
      get isPlaying() {
        return isPlaying()
      },
      get currentTime() {
        return elem.currentTime
      },
      set currentTime(value) {
        elem.currentTime = value
      },
      play,
      pause,
      stop,
      release,
    }
    return {
      createHandle() {
        n++
        if (n === 1) {
          document.body.appendChild(elem)
        }
        return handle
      },
    }
  }
  return {
    get(key) {
      let source = sources[key]
      if (!source) {
        source = createSource(key)
        sources[key] = source
      }
      return source.createHandle()
    },
  }
}
