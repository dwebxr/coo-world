import fs from 'fs-extra'
import path from 'path'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
// import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFLoader } from '../libs/gltfloader/GLTFLoader.js'
// import { VRMLoaderPlugin } from '@pixiv/three-vrm'

import { System } from './System'
import { createVRMFactory } from '../extras/createVRMFactory'
import { glbToNodes } from '../extras/glbToNodes'
import { createNode } from '../extras/createNode'
import { createEmoteFactory } from '../extras/createEmoteFactory'
import { ASSET_PROTOCOL, assetName, assetRefusal } from '../extras/assetURL'
import { resolveAssetFile } from '../extras/resolveAssetFile'
import { createOutboundFetch } from '../extras/outboundFetch'
import { LoadingManager } from 'three'

const isRemote = url => typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))

// a remote model or script: larger and slower than a script's own request may be (outboundFetch.js defaults)
const REMOTE_LOAD = { maxBytes: 32 * 1024 * 1024, timeoutMs: 30_000 }
// loaded models, emotes and scripts kept for reuse. Apps hold what they use; this only bounds what a world
// that keeps loading new URLs (world.load in a script) can pin in memory
const CACHE_LIMIT = 512
// every avatar is the same stub on the server, so they share one entry whatever URL a player names
const AVATAR_KEY = 'avatar/*'

// A model's own files may only come from inside it (data: and blob: URLs). A .glb can name external buffers
// and images by URL; the parser would fetch them from wherever the file says, outside the outbound policy.
function createEmbeddedOnlyManager() {
  const manager = new LoadingManager()
  manager.setURLModifier(url => {
    if (typeof url === 'string' && (url.startsWith('data:') || url.startsWith('blob:'))) return url
    throw assetRefusal('a model may not load external files on the server', url)
  })
  return manager
}

/**
 * Server Loader System
 *
 * - Runs on the server
 * - Basic file loader for many different formats, cached.
 *
 */
export class ServerLoader extends System {
  constructor(world) {
    super(world)
    this.promises = new Map()
    this.results = new Map()
    this.rgbeLoader = new RGBELoader()
    this.gltfLoader = new GLTFLoader(createEmbeddedOnlyManager())
    this.outbound = null
    this.preloadItems = []
    // this.gltfLoader.register(parser => new VRMLoaderPlugin(parser))

    // mock globals to allow gltf loader to work in nodejs
    globalThis.self = { URL }
    globalThis.window = {}
    globalThis.document = {
      createElementNS: () => ({ style: {} }),
    }
  }

  start() {
    // ...
  }

  key(type, url) {
    return type === 'avatar' ? AVATAR_KEY : `${type}/${url}`
  }

  has(type, url) {
    return this.promises.has(this.key(type, url))
  }

  get(type, url) {
    const key = this.key(type, url)
    const result = this.results.get(key)
    if (result !== undefined) this.touch(key)
    return result
  }

  // most recently used last; the oldest entries leave once there are more than CACHE_LIMIT
  touch(key) {
    for (const map of [this.promises, this.results]) {
      if (!map.has(key)) continue
      const value = map.get(key)
      map.delete(key)
      map.set(key, value)
    }
  }

  trim() {
    for (const key of this.promises.keys()) {
      if (this.promises.size <= CACHE_LIMIT) break
      this.promises.delete(key)
      this.results.delete(key)
    }
  }

  // The world's one fetch for URLs it did not choose (remote models and scripts here, app scripts' fetch through
  // App.fetch): public addresses only, bounded in time, size and number (outboundFetch.js). The world's own
  // assets origin is trusted, and so are the origins the operator lists in OUTBOUND_TRUSTED_ORIGINS.
  get outboundFetch() {
    if (!this.outbound) {
      const listed = String(globalThis.process?.env?.OUTBOUND_TRUSTED_ORIGINS || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)
      this.outbound = createOutboundFetch({ trustedOrigins: [this.world.assetsUrl, ...listed].filter(Boolean) })
    }
    return this.outbound
  }

  async fetchRemote(url) {
    const response = await this.outboundFetch(url, {}, REMOTE_LOAD)
    if (!response.ok) throw new Error(`asset request failed: HTTP ${response.status}`)
    return response
  }

  preload(type, url) {
    this.preloadItems.push({ type, url })
  }

  execPreload() {
    const promises = this.preloadItems.map(item => this.load(item.type, item.url))
    this.preloader = Promise.allSettled(promises).then(() => {
      this.preloader = null
    })
  }

  // Where a load reads its bytes: { file } or { remote }. An asset://<name> is a file directly inside the assets
  // directory when this world has one (server with ASSETS=local, through resolveAssetFile); otherwise (ASSETS=s3,
  // the node agent) it is the assets URL over HTTP. http(s) URLs are fetched, and so is whatever
  // World.resolveURL maps to one: `//host/x` and any bare string become `https://...`, which covers relative
  // paths and spellings such as `file:///x` (a fetch of a host by that name, never a file). What throws here is
  // an absolute path, `blob:`, an invalid asset:// name and a non-string, so no other string reaches fs.readFile.
  locate(url) {
    if (typeof url !== 'string') throw assetRefusal('not a string', url)
    const value = url.trim()
    if (value.startsWith(ASSET_PROTOCOL)) {
      if (this.world.assetsDir) return { file: resolveAssetFile(value, this.world.assetsDir) }
      if (assetName(value) === null) throw assetRefusal('invalid asset name', value)
      if (!this.world.assetsUrl) throw assetRefusal('no assets location', value)
    }
    const remote = this.world.resolveURL(value)
    if (isRemote(remote)) return { remote }
    throw assetRefusal('not an asset:// or http(s) URL', value)
  }

  // the model/script fields of a blueprint that locate() refuses, as `field: reason` texts (nothing is read)
  refusedSources(blueprint) {
    const refused = []
    for (const field of ['model', 'script']) {
      const value = blueprint?.[field]
      if (value === null || value === undefined || value === '') continue
      try {
        this.locate(value)
      } catch (err) {
        refused.push(`${field}: ${err.message}`)
      }
    }
    return refused
  }

  async fetchArrayBuffer(url) {
    const { file, remote } = this.locate(url)
    if (remote) {
      const response = await this.fetchRemote(remote)
      const arrayBuffer = await response.arrayBuffer()
      return arrayBuffer
    } else {
      const buffer = await fs.readFile(file)
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      return arrayBuffer
    }
  }

  async fetchText(url) {
    const { file, remote } = this.locate(url)
    if (remote) {
      const response = await this.fetchRemote(remote)
      const text = await response.text()
      return text
    } else {
      const text = await fs.readFile(file, { encoding: 'utf8' })
      return text
    }
  }

  load(type, url) {
    const key = this.key(type, url)
    if (this.promises.has(key)) {
      this.touch(key)
      return this.promises.get(key)
    }
    // the url stays as given: fetchArrayBuffer/fetchText locate() it when they read

    let promise
    if (type === 'hdr') {
      // promise = this.rgbeLoader.loadAsync(url).then(texture => {
      //   return texture
      // })
    }
    if (type === 'image') {
      // ...
    }
    if (type === 'texture') {
      // ...
    }
    if (type === 'model') {
      promise = new Promise((resolve, reject) => {
        ;(async () => {
          try {
            const arrayBuffer = await this.fetchArrayBuffer(url)
            // parse settles asynchronously (external buffers are fetched), so its errors need their own path
            this.gltfLoader.parse(
              arrayBuffer,
              '',
              glb => {
                try {
                  const node = glbToNodes(glb, this.world)
                  const model = {
                    toNodes() {
                      return node.clone(true)
                    },
                  }
                  this.results.set(key, model)
                  resolve(model)
                } catch (err) {
                  reject(err)
                }
              },
              reject
            )
          } catch (err) {
            reject(err)
          }
        })()
      })
    }
    if (type === 'emote') {
      promise = new Promise((resolve, reject) => {
        ;(async () => {
          try {
            const arrayBuffer = await this.fetchArrayBuffer(url)
            this.gltfLoader.parse(
              arrayBuffer,
              '',
              glb => {
                try {
                  const factory = createEmoteFactory(glb, url)
                  const emote = {
                    toClip(options) {
                      return factory.toClip(options)
                    },
                  }
                  this.results.set(key, emote)
                  resolve(emote)
                } catch (err) {
                  reject(err)
                }
              },
              reject
            )
          } catch (err) {
            reject(err)
          }
        })()
      })
    }
    if (type === 'avatar') {
      promise = new Promise((resolve, reject) => {
        ;(async () => {
          try {
            // NOTE: we can't load vrms on the server yet but we don't need 'em anyway
            let node
            const glb = {
              toNodes: () => {
                if (!node) {
                  node = createNode('group')
                  const node2 = createNode('avatar', { id: 'avatar', factory: null })
                  node.add(node2)
                }
                return node.clone(true)
              },
            }
            this.results.set(key, glb)
            resolve(glb)
          } catch (err) {
            reject(err)
          }
        })()
      })
    }
    if (type === 'script') {
      promise = new Promise((resolve, reject) => {
        ;(async () => {
          try {
            const code = await this.fetchText(url)
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
        reject(null)
      })
    }
    this.promises.set(key, promise)
    // a failed load is not kept: the next request tries again (the asset may have been uploaded since)
    promise?.catch?.(() => {
      if (this.promises.get(key) === promise) this.promises.delete(key)
    })
    this.trim()
    return promise
  }

  destroy() {
    this.promises.clear()
    this.results.clear()
    this.preloadItems = []
  }
}
