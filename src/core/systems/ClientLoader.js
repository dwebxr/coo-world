import * as THREE from '../extras/three'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'

import { System } from './System'
import { createNode } from '../extras/createNode'
import { createVRMFactory } from '../extras/createVRMFactory'
import { glbToNodes } from '../extras/glbToNodes'
import { createEmoteFactory } from '../extras/createEmoteFactory'
import { TextureLoader } from 'three'
import { formatBytes } from '../extras/formatBytes'
import { imageElementsPlugin, isAppleMobile } from '../extras/gltfImageElements'
import { emoteUrls } from '../extras/playerEmotes'
import Hls from 'hls.js/dist/hls.js'

// THREE.Cache.enabled = true

// What this client will download and decode for one asset. Files in the world's own store are already capped by
// the upload limit; a URL from somewhere else (a remote avatar, a model or image a script names) has no such
// limit, and every client that sees it loads it.
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
const MAX_BYTES_DEFAULT = 64 * MiB
// decoded size: an image this large is about 150 MB of pixels before mipmaps (an 8192 x 4096 sky fits)
const MAX_IMAGE_PIXELS = 36_000_000
// downloads kept for re-use (exports, the file fields). Files of the world's own store are always kept; of the
// others only the most recent few, and none above this size
const REMOTE_FILE_LIMIT = 16
const REMOTE_FILE_MAX_BYTES = 16 * MiB
// results (models, textures, clips) kept for URLs outside the world's store, least recently used first out. What
// is in use stays alive through its users; this bounds what a stream of new URLs can pin
const REMOTE_RESULT_LIMIT = 128

// reads a response body up to a limit, so an endless or oversized download ends instead of filling memory
async function readBody(resp, maxBytes, signal) {
  const declared = Number(resp.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`file is larger than ${maxBytes} bytes`)
  if (!resp.body?.getReader) {
    const blob = await resp.blob()
    if (blob.size > maxBytes) throw new Error(`file is larger than ${maxBytes} bytes`)
    return blob
  }
  const reader = resp.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      signal?.abort?.()
      await reader.cancel().catch(() => {})
      throw new Error(`file is larger than ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return new Blob(chunks, { type: resp.headers.get('content-type') || '' })
}

// an <img> for a file; rejects when the browser cannot decode it or it is larger than the pixel budget
function decodeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const src = URL.createObjectURL(file)
    img.onload = () => {
      if (img.naturalWidth * img.naturalHeight > MAX_IMAGE_PIXELS) {
        URL.revokeObjectURL(src)
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

/**
 * Client Loader System
 *
 * - Runs on the client
 * - Basic file loader for many different formats, cached.
 *
 */
export class ClientLoader extends System {
  constructor(world) {
    super(world)
    this.files = new Map()
    this.promises = new Map()
    this.results = new Map()
    this.remoteFiles = new Set() // urls outside the world's store whose file is kept, oldest first
    this.remoteKeys = new Set() // load keys outside the world's store, least recently used first
    this.rgbeLoader = new RGBELoader()
    this.texLoader = new TextureLoader()
    this.gltfLoader = new GLTFLoader()
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

  has(type, url) {
    const key = `${type}/${url}`
    return this.promises.has(key)
  }

  get(type, url) {
    const key = `${type}/${url}`
    return this.results.get(key)
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
    this.files.set(url, file)
  }

  hasFile(url) {
    url = this.world.resolveURL(url)
    return this.files.has(url)
  }

  getFile(url, name) {
    url = this.world.resolveURL(url)
    const file = this.files.get(url)
    if (!file) return null
    if (name) {
      return new File([file], name, {
        type: file.type, // Preserve the MIME type
        lastModified: file.lastModified, // Preserve the last modified timestamp
      })
    }
    return file
  }

  // whether a resolved URL is in the world's own asset store (uploads there are already size-limited)
  isOwnAsset(url) {
    const base = this.world.assetsUrl
    return typeof base === 'string' && base.length > 0 && url.startsWith(`${base}/`)
  }

  loadFile = async (url, maxBytes = MAX_BYTES_DEFAULT) => {
    url = this.world.resolveURL(url)
    if (this.files.has(url)) {
      return this.files.get(url)
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const resp = await fetch(url, controller ? { signal: controller.signal } : undefined)
    // an error page is not the asset: it used to be parsed as the model, image or script
    if (!resp.ok) throw new Error(`asset request failed: HTTP ${resp.status}`)
    const blob = await readBody(resp, maxBytes, controller)
    const file = new File([blob], url.split('/').pop(), { type: blob.type })
    this.keepFile(url, file)
    return file
  }

  keepFile(url, file) {
    if (this.isOwnAsset(url)) return this.files.set(url, file)
    if (file.size > REMOTE_FILE_MAX_BYTES) return
    this.remoteFiles.delete(url)
    this.remoteFiles.add(url)
    this.files.set(url, file)
    for (const old of this.remoteFiles) {
      if (this.remoteFiles.size <= REMOTE_FILE_LIMIT) break
      this.remoteFiles.delete(old)
      this.files.delete(old)
    }
  }

  // results for URLs outside the world's store are kept up to a bound, least recently used first out
  trackResult(key, url) {
    if (this.isOwnAsset(this.world.resolveURL(url))) return
    this.remoteKeys.delete(key)
    this.remoteKeys.add(key)
    for (const old of this.remoteKeys) {
      if (this.remoteKeys.size <= REMOTE_RESULT_LIMIT) break
      this.remoteKeys.delete(old)
      this.promises.delete(old)
      this.results.delete(old)
    }
  }

  async load(type, url) {
    if (this.preloader) {
      await this.preloader
    }
    const key = `${type}/${url}`
    if (this.promises.has(key)) {
      if (this.remoteKeys.has(key)) this.trackResult(key, url)
      return this.promises.get(key)
    }
    if (type === 'video') {
      const promise = new Promise(resolve => {
        url = this.world.resolveURL(url)
        const factory = createVideoFactory(this.world, url)
        resolve(factory)
      })
      this.promises.set(key, promise)
      return promise
    }
    const promise = this.loadFile(url, MAX_BYTES[type] ?? MAX_BYTES_DEFAULT).then(async file => {
      if (type === 'hdr') {
        const buffer = await file.arrayBuffer()
        const result = this.rgbeLoader.parse(buffer)
        if (result.width * result.height > MAX_IMAGE_PIXELS) {
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
        this.results.set(key, texture)
        return texture
      }
      if (type === 'image') {
        const img = await decodeImage(file)
        this.results.set(key, img)
        return img
      }
      if (type === 'texture') {
        // the decoded element is the texture's image: no second load of the same object URL
        const img = await decodeImage(file)
        const texture = new THREE.Texture(img)
        texture.colorSpace = THREE.SRGBColorSpace
        texture.needsUpdate = true
        this.results.set(key, texture)
        URL.revokeObjectURL(img.src)
        return texture
      }
      if (type === 'model') {
        const buffer = await file.arrayBuffer()
        const glb = await this.gltfLoader.parseAsync(buffer)
        const model = buildModelResult(glb, this.world, file)
        this.results.set(key, model)
        return model
      }
      if (type === 'emote') {
        const buffer = await file.arrayBuffer()
        const glb = await this.gltfLoader.parseAsync(buffer)
        const emote = buildEmoteResult(glb, url)
        this.results.set(key, emote)
        return emote
      }
      if (type === 'avatar') {
        const buffer = await file.arrayBuffer()
        const glb = await this.gltfLoader.parseAsync(buffer)
        const avatar = buildAvatarResult(glb, this.world, file, this.vrmHooks)
        this.results.set(key, avatar)
        return avatar
      }
      if (type === 'script') {
        const code = await file.text()
        const script = this.world.scripts.evaluate(code)
        this.results.set(key, script)
        return script
      }
      if (type === 'audio') {
        const buffer = await file.arrayBuffer()
        const audioBuffer = await this.world.audio.ctx.decodeAudioData(buffer)
        this.results.set(key, audioBuffer)
        return audioBuffer
      }
    })
    this.promises.set(key, promise)
    this.trackResult(key, url)
    // a failed load is not kept: the asset may exist a moment later (an upload still in flight, a network blip),
    // and a kept rejection used to make it unloadable until the page was reloaded
    promise.catch(() => {
      if (this.promises.get(key) === promise) {
        this.promises.delete(key)
        this.remoteKeys.delete(key)
      }
    })
    return promise
  }

  insert(type, url, file) {
    const key = `${type}/${url}`
    const localUrl = URL.createObjectURL(file)
    let promise
    if (type === 'hdr') {
      promise = this.rgbeLoader.loadAsync(localUrl).then(texture => {
        this.results.set(key, texture)
        return texture
      })
    }
    if (type === 'image') {
      promise = new Promise(resolve => {
        const img = new Image()
        img.onload = () => {
          this.results.set(key, img)
          resolve(img)
        }
        img.src = localUrl
      })
    }
    if (type === 'video') {
      promise = new Promise(resolve => {
        const factory = createVideoFactory(this.world, localUrl)
        resolve(factory)
      })
    }
    if (type === 'texture') {
      promise = this.texLoader.loadAsync(localUrl).then(texture => {
        this.results.set(key, texture)
        return texture
      })
    }
    if (type === 'model') {
      promise = this.gltfLoader.loadAsync(localUrl).then(glb => {
        const model = buildModelResult(glb, this.world, file)
        this.results.set(key, model)
        return model
      })
    }
    if (type === 'emote') {
      promise = this.gltfLoader.loadAsync(localUrl).then(glb => {
        const emote = buildEmoteResult(glb, url)
        this.results.set(key, emote)
        return emote
      })
    }
    if (type === 'avatar') {
      promise = this.gltfLoader.loadAsync(localUrl).then(glb => {
        const avatar = buildAvatarResult(glb, this.world, file, this.vrmHooks)
        this.results.set(key, avatar)
        return avatar
      })
    }
    if (type === 'script') {
      promise = new Promise((resolve, reject) => {
        ;(async () => {
          try {
            const code = await file.text()
            const script = this.world.scripts.evaluate(code)
            this.results.set(key, script)
            resolve(script)
          } catch (err) {
            reject(err)
          }
        })()
      })
    }
    if (type === 'audio') {
      promise = new Promise((resolve, reject) => {
        ;(async () => {
          try {
            const arrayBuffer = await file.arrayBuffer()
            const audioBuffer = await this.world.audio.ctx.decodeAudioData(arrayBuffer)
            this.results.set(key, audioBuffer)
            resolve(audioBuffer)
          } catch (err) {
            reject(err)
          }
        })()
      })
    }
    this.promises.set(key, promise)
  }

  destroy() {
    this.files.clear()
    this.promises.clear()
    this.results.clear()
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
