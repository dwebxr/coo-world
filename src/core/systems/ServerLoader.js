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
import { ASSET_PROTOCOL, assetName, assetRefusal, loaderReference } from '../extras/assetURL'
import { resolveAssetFile } from '../extras/resolveAssetFile'

const isRemote = url => typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))

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
    this.gltfLoader = new GLTFLoader()
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
    const value = loaderReference(url)
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
      const response = await fetch(remote)
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
      const response = await fetch(remote)
      const text = await response.text()
      return text
    } else {
      const text = await fs.readFile(file, { encoding: 'utf8' })
      return text
    }
  }

  load(type, url) {
    const key = `${type}/${url}`
    if (this.promises.has(key)) {
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
    return promise
  }

  destroy() {
    this.promises.clear()
    this.results.clear()
    this.preloadItems = []
  }
}
