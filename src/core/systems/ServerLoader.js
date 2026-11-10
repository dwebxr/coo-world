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
// Finished loads kept for reuse, of every kind and from every location (the world's store and remote URLs alike):
// at most this many, the least recently used leaving first. A load in progress is never dropped, so the same
// location is never loaded twice at once; while more than this many are in progress the cache holds them all.
// What a load in progress holds is bounded per kind: a model or emote reads and parses its file only in one of
// MODEL_TURNS (below); a remote script takes one of the outbound policy's 16 slots while it downloads (more are
// refused); a local script read has no bound of its own. Apps hold what they use: this bounds what a world that
// keeps loading new locations (world.load in a script) can pin in memory, not what a loaded model takes
const CACHE_LIMIT = 512
// Turns for models and emotes, local and remote alike. A turn covers reading the file and parsing it, so loads
// beyond these wait holding nothing yet. While no turn has been given up, at most this many files (up to 32 MiB
// each from a remote URL) are read or parsed at once, however many loads are asked for
const MODEL_TURNS = 4
// Deadlines that free a turn whose read or parse does not settle (it waits on something that never answers).
// When one runs, that load fails and its turn goes to the next load. A read given up is cancelled (the outbound
// request is aborted, a local read stops); a parse cannot be, so a parse whose turn expired may still be running
// and holding its memory until it settles, outside the four turns. A deadline cannot interrupt synchronous work
// either: while a parse blocks the event loop nothing else runs, the timer included. And a phase that does
// complete before its timer has run is accepted however long it took, so a large but valid model still loads on
// a slow host. The read has a remote load's deadline (a local read too); a parse gets a generous fixed one
const READ_DEADLINE_MS = REMOTE_LOAD.timeoutMs
const PARSE_DEADLINE_MS = 60_000
// every avatar is the same stub on the server (nothing is fetched), so they share one entry whatever URL a player
// names
const AVATAR_KEY = 'avatar/*'

// A model's own files may only come from inside it (data: and blob: URLs). A .glb or .gltf can name external
// buffers and images by URL, and the parser would fetch them from wherever the file says, outside the outbound
// policy; here nothing outside the file is ever requested. An external buffer fails the load (the model cannot be
// built without it). An external image is not fetched either, and the model loads without it: GLTFLoader turns a
// texture that fails into no texture (the server draws nothing, so it never needed one).
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
    // key -> the load's promise, least recently used first; `results` holds what finished loads produced, for
    // keys that are in `promises` only
    this.promises = new Map()
    this.results = new Map()
    this.settled = new WeakSet() // promises of loads that have finished
    this.turns = { active: new Set(), waiting: [] } // model and emote loads reading or parsing, and those waiting
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

  // A cache key names what a load reads, so one resource has one entry whatever its spelling: surrounding spaces,
  // a fragment, a default port or letter case in the host are the same location. An asset:// name and the assets
  // URL it maps to share an entry only where assets are read over HTTP (no assets directory); with an assets
  // directory asset://<name> is the local file and the URL a remote resource, which can differ, so they stay
  // apart. A query is kept: outside the store it can name another resource. A value locate() refuses keys as
  // itself, trimmed (its load fails, and a failed load is not kept)
  key(type, url) {
    if (type === 'avatar') return AVATAR_KEY
    return `${type}/${this.location(url)}`
  }

  location(url) {
    const value = typeof url === 'string' ? url.trim() : String(url)
    try {
      const { file, remote } = this.locate(value)
      if (file) return `${ASSET_PROTOCOL}${assetName(value)}`
      const parsed = new URL(remote)
      parsed.hash = ''
      return parsed.href
    } catch {
      return value
    }
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

  // most recently used last
  touch(key) {
    const promise = this.promises.get(key)
    this.promises.delete(key)
    this.promises.set(key, promise)
  }

  // Down to CACHE_LIMIT entries, the least recently used finished ones first. A load in progress is never dropped
  // (it would be started again by the next request for it), so while more than CACHE_LIMIT are in progress the
  // cache holds them and nothing else. `results` only holds keys that are in `promises`, so it is bounded too
  trim() {
    if (this.promises.size <= CACHE_LIMIT) return
    for (const [key, promise] of this.promises) {
      if (this.promises.size <= CACHE_LIMIT) break
      if (!this.settled.has(promise)) continue
      this.promises.delete(key)
      this.results.delete(key)
    }
  }

  // The world's one fetch for URLs it did not choose: remote models, emotes and scripts a blueprint names go
  // through it, and app scripts' fetch (App.fetch) will too. Public addresses only, bounded in time, size and
  // number (outboundFetch.js). The world's own assets origin is trusted, and so are the origins the operator lists
  // in OUTBOUND_TRUSTED_ORIGINS.
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

  async fetchRemote(url, signal) {
    const response = await this.outboundFetch(url, signal ? { signal } : {}, REMOTE_LOAD)
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

  // `signal` cancels the read: the outbound request (and its body) or the local file read
  async fetchArrayBuffer(url, signal) {
    const { file, remote } = this.locate(url)
    if (remote) {
      const response = await this.fetchRemote(remote, signal)
      const arrayBuffer = await response.arrayBuffer()
      return arrayBuffer
    } else {
      const buffer = await fs.readFile(file, signal ? { signal } : undefined)
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

  // parse settles asynchronously, so its errors need their own path
  parseGLB(arrayBuffer) {
    return new Promise((resolve, reject) => {
      try {
        this.gltfLoader.parse(arrayBuffer, '', resolve, reject)
      } catch (err) {
        reject(err)
      }
    })
  }

  // Reads, then parses what was read, in one of MODEL_TURNS, in the order asked: until a turn is free the load
  // waits without having started. The turn is held through both, each within its deadline (see PARSE_DEADLINE_MS
  // for what one can and cannot do), and goes to the next load once the load settles or is given up (a deadline,
  // or destroy()). `read` gets a signal that is aborted then, so a read given up stops
  inTurn(read, parse) {
    return new Promise((resolve, reject) => {
      const turn = { done: false, timer: null, reading: new AbortController() }
      turn.settle = (ok, value) => {
        if (turn.done) return
        turn.done = true
        clearTimeout(turn.timer)
        turn.reading.abort() // nothing still reading for it (a finished read is not affected)
        this.turns.active.delete(turn)
        if (ok) resolve(value)
        else reject(value)
        this.turns.waiting.shift()?.run()
      }
      const within = (ms, what, step) =>
        new Promise((done, fail) => {
          clearTimeout(turn.timer)
          turn.timer = setTimeout(() => fail(new Error(`a model's ${what} took longer than ${ms / 1000} s`)), ms)
          turn.timer?.unref?.() // a deadline does not keep a closing process alive
          // started a microtask later, and only while the turn is live: a load given up meanwhile (destroy() right
          // after load()) starts nothing
          Promise.resolve()
            .then(() => (turn.done ? undefined : step()))
            .then(done, fail)
        })
      turn.run = () => {
        this.turns.active.add(turn)
        within(READ_DEADLINE_MS, 'read', () => read(turn.reading.signal))
          // a load given up while reading parses nothing
          .then(data => (turn.done ? undefined : within(PARSE_DEADLINE_MS, 'parse', () => parse(data))))
          .then(
            value => turn.settle(true, value),
            err => turn.settle(false, err)
          )
      }
      if (this.turns.active.size < MODEL_TURNS) turn.run()
      else this.turns.waiting.push(turn)
    })
  }

  // what a load of `type` does: a function producing its result (or a promise of it), or null for a type the
  // server does not load. The url stays as given: fetchArrayBuffer/fetchText locate() it when they read
  task(type, url) {
    if (type === 'model') {
      return () =>
        this.inTurn(
          signal => this.fetchArrayBuffer(url, signal),
          async arrayBuffer => {
            const node = glbToNodes(await this.parseGLB(arrayBuffer), this.world)
            return {
              toNodes() {
                return node.clone(true)
              },
            }
          }
        )
    }
    if (type === 'emote') {
      return () =>
        this.inTurn(
          signal => this.fetchArrayBuffer(url, signal),
          async arrayBuffer => {
            const factory = createEmoteFactory(await this.parseGLB(arrayBuffer), url)
            return {
              toClip(options) {
                return factory.toClip(options)
              },
            }
          }
        )
    }
    if (type === 'avatar') {
      // NOTE: we can't load vrms on the server yet but we don't need 'em anyway
      return () => {
        let node
        return {
          toNodes: () => {
            if (!node) {
              node = createNode('group')
              const node2 = createNode('avatar', { id: 'avatar', factory: null })
              node.add(node2)
            }
            return node.clone(true)
          },
        }
      }
    }
    if (type === 'script') {
      return async () => this.world.scripts.evaluate(await this.fetchText(url))
    }
    if (type === 'audio') {
      return () => Promise.reject(null)
    }
    // hdr, image, texture, video: nothing to load on the server
    return null
  }

  load(type, url) {
    const key = this.key(type, url)
    if (this.promises.has(key)) {
      this.touch(key)
      return this.promises.get(key)
    }
    const task = this.task(type, url)
    if (!task) return undefined
    let settle
    const promise = new Promise((resolve, reject) => (settle = { resolve, reject }))
    this.promises.set(key, promise)
    // A load writes to the cache only while it is the one registered for its key: not after it was dropped or
    // replaced by a newer load of the same key, and not after destroy(), which empties `promises` (so no load from
    // before it is ever the registered one again)
    const current = () => this.promises.get(key) === promise
    const finish = (ok, value) => {
      this.settled.add(promise)
      if (current()) {
        if (ok) this.results.set(key, value)
        // a failed load is not kept: the next request tries again (the asset may have been uploaded since)
        else this.promises.delete(key)
        this.trim()
      }
      if (ok) settle.resolve(value)
      else settle.reject(value)
    }
    let work
    try {
      work = Promise.resolve(task())
    } catch (err) {
      work = Promise.reject(err)
    }
    work.then(
      value => finish(true, value),
      err => finish(false, err)
    )
    // whoever awaits the load sees its failure; the cache's own reference is not an unhandled rejection
    promise.catch(() => {})
    this.trim()
    return promise
  }

  destroy() {
    // loads still waiting for a turn never start, and those reading or parsing fail now and give their turns back
    // (their work may still finish; it writes nothing)
    const destroyed = () => new Error('the server loader was destroyed')
    for (const turn of this.turns.waiting.splice(0)) turn.settle(false, destroyed())
    for (const turn of [...this.turns.active]) turn.settle(false, destroyed())
    this.promises.clear()
    this.results.clear()
    this.preloadItems = []
  }
}
