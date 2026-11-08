import moment from 'moment'
import { packetNameById, peekPacketId, writePacket } from '../packets'
import { Socket } from '../Socket'
import { uuid } from '../utils'
import { System } from './System'
import { createJWT, readJWT } from '../utils-server'
import { isNumber } from 'lodash-es'
import { appPersistenceData, persistenceRecord } from '../extras/persistenceRecord.js'
import * as THREE from '../extras/three'
import { Ranks } from '../extras/ranks'
import {
  isAvatarUrl,
  sanitizeAppModify,
  sanitizeAppRelease,
  sanitizeEntityAdd,
  sanitizeName,
  sanitizePlayerSelfModify,
  sanitizePersistedApp,
  sanitizeSpawn,
} from '../extras/entityModifyPolicy'
import { createRelayDrop } from '../extras/playerRelayPolicy'
import { sanitizeChatMessage } from '../extras/chatPolicy'
import { sanitizeBlueprintAdd, sanitizeBlueprintModify, WORLD_BLUEPRINT_BYTES } from '../extras/blueprintPolicy'
import { isAdminOnlySettingKey, isKnownSettingKey, normalizeSettingValue } from '../extras/settingsPolicy'
import { internalEvents } from '../extras/internalEvents'
import { createInboundGate, createInboundScheduler, packetNodeLimit } from '../extras/inboundPolicy'
import { SNAPSHOT_CAP, createWriteLedger } from '../extras/writeLedger'
import { briefError, createLogOnce } from '../extras/logOnce'
import { readInboundPacket } from '../../server/inboundDecode'
import * as solanaGating from '../../server/solana-gating'
import * as evmGating from '../../server/evm-gating'
import { createEvmRpcs } from '../../server/evmRpc'
import { createEvmHoldingService } from '../../server/evmHoldings'
import { createTipWatcher } from '../../server/evmTipWatcher'
import { parseTipAmount } from '../extras/evmTokens'
import { formatUnits, isTxHash } from '../extras/evmAbi'
import { createSolanaRpc } from '../../server/solanaRpc'
import { createTokenBalanceService } from '../../server/tokenBalance'
import { grantTokenRank, persistRank, revokeTokenRank } from '../../server/rankGrants'

const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL || '60') // seconds
const PING_RATE = 10 // seconds
// A player who connects again while an old connection is still registered: the old one gets one ping. Answered
// within this time, it is a live window and the newcomer is refused; silent, it is stale and gives way.
const TAKEOVER_PING_MS = 3000
// how long the newcomer waits for the stale connection's cleanup (its player leaves the world)
const TAKEOVER_CLOSE_MS = 2000
const defaultSpawn = '{ "position": [0, 0, 0], "quaternion": [0, 0, 0, 1] }'

const HEALTH_MAX = 100

// inbound packet payloads are untrusted; handlers check the root shape before any lookup
const isObject = value => value !== null && typeof value === 'object'

/**
 * Server Network System
 *
 * - runs on the server
 * - provides abstract network methods matching ClientNetwork
 *
 */
export class ServerNetwork extends System {
  constructor(world) {
    super(world)
    this.id = 0
    this.ids = -1
    this.sockets = new Map()
    this.connecting = new Set() // user ids reserved while their connection is still being set up
    this.socketIntervalId = setInterval(() => this.checkSockets(), PING_RATE * 1000)
    this.saveTimerId = null
    this.stopping = false
    this.dirtyBlueprints = new Map()
    this.dirtyApps = new Map()
    this.persistenceRevision = 0
    this.savePromise = null
    this.configPromise = null
    this.loadedConfig = new Map()
    this.dirtyConfig = new Map()
    this.flushExpired = false
    this.isServer = true
    this.scheduler = createInboundScheduler()
    this.gate = createInboundGate()
    this.logOnce = createLogOnce()
    this.dropRelay = createRelayDrop()
    this.writer = createWriteLedger({ log: line => console.error(line) })
  }

  init({ db, tokenBalanceService, evmHoldings, tipWatcher, evmSignatureVerifier }) {
    this.db = db
    this.tokenBalanceService = solanaGating.TOKEN_GATING_ENABLED
      ? (tokenBalanceService ?? createTokenBalanceService({ readRaw: createSolanaRpc().readRaw }))
      : null
    const rpcs = evmGating.EVM_ENABLED ? createEvmRpcs() : new Map()
    // NFT 保有判定 (EVM_RPC_URL_<chainId> があるチェーンだけ)。スクリプトの player.getEvmHolding が使う
    this.evmHoldings = evmGating.EVM_ENABLED ? (evmHoldings ?? createEvmHoldingService({ rpcs })) : null
    // 投げゼニの確定確認 (投げゼニが有効で、サインインのチェーンの RPC がある時だけ。無ければ送金のみ)
    const tipRpc = rpcs.get(evmGating.EVM_CHAIN_ID)
    // コントラクトのアカウント (Myna Wallet など) のサインイン確認。サインインのチェーンの RPC がある時だけ
    this.evmSignatureVerifier = evmGating.EVM_ENABLED
      ? (evmSignatureVerifier ?? evmGating.createEvmSignatureVerifier({ rpc: tipRpc }))
      : null
    this.tipWatcher =
      evmGating.EVM_ENABLED && evmGating.EVM_TIP_TOKENS.length
        ? (tipWatcher ?? (tipRpc ? createTipWatcher({ rpc: tipRpc }) : null))
        : null
    // 確定した txHash → 覚えておく期限、ワールド全体の告知の間引き
    this.tipSeen = new Map()
    this.tipAnnounce = { queue: [], tokens: evmGating.TIP_ANNOUNCE_BURST, at: Date.now(), timer: null, last: new Map() }
  }

  async start() {
    // get spawn
    const spawnRow = await this.db('config').where('key', 'spawn').first()
    this.spawn = null
    try {
      this.spawn = sanitizeSpawn(JSON.parse(spawnRow ? spawnRow.value : defaultSpawn))
    } catch (err) {
      // invalid stored JSON uses the same fallback as an invalid pose
    }
    if (!this.spawn) {
      this.spawn = JSON.parse(defaultSpawn)
      this.logOnce(this, 'spawn-invalid', '[network] invalid stored spawn; using default spawn')
    }
    this.loadedConfig.set('spawn', JSON.stringify(this.spawn))
    // hydrate blueprints
    const skippedBlueprints = []
    const skippedApps = []
    const repairedApps = []
    const blueprints = await this.db('blueprints')
    for (const blueprint of blueprints) {
      try {
        const result = sanitizeBlueprintAdd(JSON.parse(blueprint.data))
        if (!result.ok || result.value.id !== blueprint.id) throw new Error('invalid blueprint')
        this.world.blueprints.add(result.value)
      } catch {
        skippedBlueprints.push(blueprint.id)
      }
    }
    if (this.world.blueprints.bytes > WORLD_BLUEPRINT_BYTES) {
      console.warn(
        `[network] world blueprint budget exceeded at startup: bytes=${this.world.blueprints.bytes} cap=${WORLD_BLUEPRINT_BYTES}`
      )
    }
    // hydrate entities
    const entities = await this.db('entities')
    for (const entity of entities) {
      try {
        const result = sanitizePersistedApp(JSON.parse(entity.data), {
          blueprintExists: id => !!this.world.blueprints.get(id),
        })
        if (!result || result.data.id !== entity.id) throw new Error('invalid app')
        this.world.entities.add(result.data, true)
        if (result.repaired.length) repairedApps.push({ id: entity.id, fields: result.repaired })
      } catch {
        skippedApps.push(entity.id)
      }
    }
    console.log(
      `[network] hydration: blueprints=${blueprints.length - skippedBlueprints.length} apps=${entities.length - skippedApps.length} repaired=${repairedApps.length} skipped=${skippedBlueprints.length + skippedApps.length} skippedBlueprints=${JSON.stringify(skippedBlueprints)} skippedApps=${JSON.stringify(skippedApps)} repairedApps=${JSON.stringify(repairedApps)}`
    )
    // hydrate settings
    let settingsRow = await this.db('config').where('key', 'settings').first()
    try {
      const settings = JSON.parse(settingsRow?.value || '{}')
      this.world.settings.deserialize(settings)
      this.world.settings.setHasAdminCode(!!process.env.ADMIN_CODE)
      this.loadedConfig.set('settings', JSON.stringify(this.world.settings.serialize()))
    } catch (err) {
      console.error(err)
    }
    // watch settings changes
    this.world.settings.on('change', this.saveSettings)
    // queue first save
    if (SAVE_INTERVAL && !this.stopping) {
      this.saveTimerId = setTimeout(this.save, SAVE_INTERVAL * 1000)
    }
  }

  preFixedUpdate() {
    this.writer.resetTick()
    this.flush()
  }

  asScript(fn, source, name) {
    return this.writer.asScript(fn, source, name)
  }

  write(ws, packet, options = {}) {
    const name = packet === null ? 'ping' : packetNameById(peekPacketId(packet)) || 'packet'
    return this.writer.write(ws, packet, { name, ...options })
  }

  send(name, data, ignoreSocketId) {
    const packet = this.writer.prepare(writePacket(name, data), { name })
    if (packet === false) return false
    let delivered = true
    this.sockets.forEach(socket => {
      if (socket.id === ignoreSocketId) return
      if (!this.write(socket.ws, packet, { name, prepared: true })) delivered = false
    })
    return delivered
  }

  sendTo(socketId, name, data) {
    const socket = this.sockets.get(socketId)
    return socket ? socket.send(name, data) : false
  }

  // players in the world for the limit: the registered ones, plus those being replaced whose old connection is
  // already gone (each id once)
  playersPresent() {
    let count = this.sockets.size
    for (const id of this.replacing ?? []) if (!this.sockets.has(id)) count++
    return count
  }

  // Whether a registered connection answers a ping within ms (its transport is alive). A ping already on its
  // way counts too: only an answer matters.
  // While it is asked, the regular check leaves it alone: this ping's write may still be pending (backpressure),
  // which that check would read as a missed heartbeat. register(stop) lets the caller end the wait early.
  answersPing(socket, ms = this.takeoverPingMs ?? TAKEOVER_PING_MS, register) {
    const ws = socket?.ws
    if (!ws || socket.closed || socket.disconnected || ws.readyState !== 1) return Promise.resolve(false)
    return new Promise(resolve => {
      // this probe's mark; a later probe of the same socket has its own, which this one never clears
      const probe = {}
      let settled = false
      const unmark = () => {
        if (socket.probing === probe) socket.probing = null
      }
      // the mark stays until the deadline whatever the outcome: this probe's ping may still be in the write
      // queue (an earlier heartbeat's late pong can answer first), and the regular check would read that
      // pending write as a missed heartbeat
      const finish = value => {
        if (settled) return
        settled = true
        ws.off('pong', onPong)
        ws.off('close', onClose)
        resolve(value)
      }
      const onPong = () => finish(true)
      const onClose = () => finish(false)
      ws.on('pong', onPong)
      ws.on('close', onClose)
      socket.probing = probe
      const deadline = setTimeout(() => {
        unmark()
        finish(false)
      }, ms)
      deadline.unref?.()
      // ended early by the caller (the newcomer closed)
      register?.(() => finish(false))
      this.write(ws, null)
    })
  }

  // Close a stale connection and wait (briefly) until its player has left, so the same id can join again
  async retireSocket(socket, ms = this.takeoverCloseMs ?? TAKEOVER_CLOSE_MS) {
    if (socket.disconnected) return
    // in case the old window is only slow, not gone: it learns why when it wakes
    socket.send('kick', 'duplicate_user')
    this.logOnce(socket, 'takeover', '[network] a silent connection gave way to its player connecting again')
    await new Promise(resolve => {
      let timer = null
      const done = () => {
        clearTimeout(timer)
        socket.ws.off('close', done)
        resolve()
      }
      socket.ws.on('close', done)
      timer = setTimeout(done, ms)
      // terminate: its close runs onDisconnect (Socket listens first, so the player is gone before done)
      socket.disconnect()
    })
    // a transport that never reported its close: finish the cleanup here
    if (!socket.disconnected) {
      socket.closed = true
      socket.disconnect()
    }
  }

  checkSockets() {
    this.world.apps.eventLedger.sweepExpired(Date.now())
    // see: https://www.npmjs.com/package/ws#how-to-detect-and-close-broken-connections
    const dead = []
    this.sockets.forEach(socket => {
      // being asked by a takeover (answersPing): its fate is decided there within seconds
      if (socket.probing) return
      if (socket.pingPending || !socket.alive) {
        dead.push(socket)
      } else {
        socket.ping()
      }
    })
    dead.forEach(socket => socket.disconnect())
  }

  // Admission charges the bytes and nodes before the inbox retains a copy.
  admit(socket, packet) {
    if (this.stopping) return false
    return this.gate.admit(socket, packet, { builder: socket.player?.isBuilder() === true })
  }

  // Capacity is reserved before copying, including arrivals deferred during dispatch.
  enqueue(socket, packet, entry) {
    if (this.stopping) return false
    if (socket.disconnected) return this.gate.refuse(socket, 'disconnected', entry.name, 'disconnected')
    if (!this.scheduler.reserve(socket, entry)) {
      return this.gate.refuse(socket, 'inbox', entry.name, 'inbox full')
    }
    try {
      entry.copy = Uint8Array.prototype.slice.call(packet)
    } catch (err) {
      this.scheduler.release(socket, entry)
      throw err
    }
    this.scheduler.enqueue(socket, entry)
  }

  // The scheduler releases inbox credit before decoding and bounds each tick's work.
  flush() {
    this.scheduler.flush((socket, entry) => {
      if (this.stopping) return
      const { copy, bytes, nodes, name, builder } = entry
      let decoded
      try {
        decoded = readInboundPacket(copy, { maxNodes: packetNodeLimit(name) })
      } catch (err) {
        this.gate.refuse(
          socket,
          'decoder-bug',
          name,
          `decoder bug (${err.message} at pos ${err.pos}, nodes ${err.nodes})`
        )
        return
      }
      const [method, data] = decoded
      const failed = err => {
        this.logOnce(socket, `${name}:handler`, `[network] ${name} from client ${socket.id} failed: ${briefError(err)}`)
      }
      try {
        const meta = { bytes, nodes, socketId: socket.id, builder }
        const result = this[method]?.(socket, data, meta)
        // async handlers reject later; keep those failures contained too
        if (typeof result?.then === 'function') result.then(undefined, failed)
      } catch (err) {
        failed(err)
      }
    })
  }

  getTime() {
    return performance.now() / 1000 // seconds
  }

  requireBuilder(socket, action) {
    if (socket.player.isBuilder()) return true
    this.logOnce(
      socket,
      `builder:${action}`,
      `player attempted to ${action} without builder permission: ${String(socket.id).slice(0, 64)}`
    )
    return false
  }

  markBlueprintDirty(data) {
    const record = persistenceRecord(data)
    this.dirtyBlueprints.set(data.id, { revision: ++this.persistenceRevision, record })
  }

  markAppDirty(data, change) {
    const settled = appPersistenceData(data, change)
    if (settled.mover || settled.uploader) return
    const record = persistenceRecord(settled)
    this.dirtyApps.set(settled.id, { revision: ++this.persistenceRevision, record })
  }

  markAppDeleted(id) {
    this.dirtyApps.set(id, { revision: ++this.persistenceRevision, record: null })
  }

  save = () => {
    clearTimeout(this.saveTimerId)
    const promise = (this.savePromise || Promise.resolve())
      .then(() => this.saveDirty())
      .finally(() => {
        if (this.savePromise !== promise) return
        this.savePromise = null
        if (!this.stopping) this.saveTimerId = setTimeout(this.save, SAVE_INTERVAL * 1000)
      })
    this.savePromise = promise
    return promise
  }

  async saveDirty() {
    const counts = { blueprints: 0, apps: 0, deleted: 0 }
    const now = moment().toISOString()
    for (const [table, dirty] of [
      ['blueprints', this.dirtyBlueprints],
      ['entities', this.dirtyApps],
    ]) {
      for (const [id, { revision, record }] of [...dirty]) {
        if (this.flushExpired) return
        try {
          if (record === null) {
            await this.db(table).where('id', id).delete()
            counts.deleted++
          } else {
            await this.db(table)
              .insert({ ...record, createdAt: now, updatedAt: now })
              .onConflict('id')
              .merge({ ...record, updatedAt: now })
            counts[table === 'blueprints' ? 'blueprints' : 'apps']++
          }
          if (dirty.get(id)?.revision === revision) dirty.delete(id)
        } catch (err) {
          console.error(`[network] error saving ${table} ${id}: ${briefError(err)}`)
        }
      }
    }
    if (counts.blueprints || counts.apps || counts.deleted) {
      console.log(`world saved (${counts.blueprints} blueprints, ${counts.apps} apps, ${counts.deleted} apps removed)`)
    }
  }

  stopForFatal() {
    this.stopping = true
    clearTimeout(this.saveTimerId)
    clearInterval(this.socketIntervalId)
    this.tipWatcher?.stop()
    if (this.tipAnnounce?.timer) clearTimeout(this.tipAnnounce.timer)
  }

  async flushBeforeExit(deadlineMs) {
    this.stopForFatal()
    const config = new Set()
    for (const [key, saved] of this.loadedConfig) {
      const data = key === 'settings' ? this.world.settings.serialize() : this.spawn
      if (this.dirtyConfig.has(key) || JSON.stringify(data) !== saved) config.add(key)
    }
    let timer
    const flush = async () => {
      await Promise.all([this.savePromise, this.configPromise])
      if (this.flushExpired) return
      await Promise.all([
        this.save(),
        (async () => {
          // Settings may have broadcast without another preFixedUpdate to emit change.
          if (config.has('settings') && (await this.saveSettings())) config.delete('settings')
          if (config.has('spawn') && (await this.saveConfig('spawn', this.spawn))) config.delete('spawn')
        })(),
      ])
    }
    try {
      await Promise.race([
        flush(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            this.flushExpired = true
            reject(new Error('save deadline exceeded'))
          }, deadlineMs)
        }),
      ])
      if (this.dirtyBlueprints.size || this.dirtyApps.size || config.size) {
        throw new Error('final save incomplete')
      }
      console.log('[network] final save complete')
    } finally {
      clearTimeout(timer)
      if (this.dirtyBlueprints.size || this.dirtyApps.size || config.size) {
        console.error(
          `[network] not persisted: blueprints=${JSON.stringify([...this.dirtyBlueprints.keys()])} apps=${JSON.stringify([...this.dirtyApps.keys()])} config=${JSON.stringify([...config])}`
        )
      }
    }
  }

  saveConfig(key, data) {
    if (!this.loadedConfig.has(key)) {
      // the stored row was never read (or failed to parse); keep it untouched for inspection
      this.logOnce(this, `config-unloaded:${key}`, `[network] ${key} was not loaded; changes will not be saved`)
      return Promise.resolve(false)
    }
    const value = JSON.stringify(data)
    this.dirtyConfig.set(key, value)
    const promise = (this.configPromise || Promise.resolve())
      .then(async () => {
        if (this.flushExpired) return false
        try {
          if (this.loadedConfig.get(key) !== value) {
            await this.db('config').insert({ key, value }).onConflict('key').merge({ value })
            this.loadedConfig.set(key, value)
          }
          if (this.dirtyConfig.get(key) === value) this.dirtyConfig.delete(key)
          return true
        } catch (err) {
          this.logOnce(this, `config:${key}`, `[network] error saving ${key}: ${briefError(err)}`)
          return false
        }
      })
      .finally(() => {
        if (this.configPromise === promise) this.configPromise = null
      })
    this.configPromise = promise
    return promise
  }

  saveSettings = () => {
    return this.saveConfig('settings', this.world.settings.serialize())
  }

  async onConnection(ws, params) {
    if (this.stopping) return ws.close()
    let cancelled = false
    // a wait that ends early when this connection closes (the takeover ping)
    let stopWaiting = null
    ws.once('close', () => {
      cancelled = true
      stopWaiting?.()
    })
    let reserved = null
    let replacing = null
    let carriedRankWrites = []
    let socket = null
    try {
      let authToken = params.authToken
      let auth
      // check player limit. A player who is already here (a stale connection about to be replaced) does not
      // count twice; telling that needs only the token, not the database
      const playerLimit = this.world.settings.playerLimit
      // a player being replaced (takeover below) keeps its place while the old connection is closed and the new
      // one is set up, so nobody else can take it in between
      if (isNumber(playerLimit) && playerLimit > 0 && this.playersPresent() >= playerLimit) {
        auth = authToken ? await readJWT(authToken) : null
        if (cancelled) return
        if (!auth || !this.sockets.has(auth.userId)) {
          const packet = writePacket('kick', 'player_limit')
          this.write(ws, packet, { name: 'kick' })
          ws.close()
          return
        }
      }

      // check connection params
      let name = sanitizeName(params.name)
      const avatar = isAvatarUrl(params.avatar) ? params.avatar : null

      // get or create user
      let user
      if (authToken) {
        if (auth === undefined) auth = await readJWT(authToken)
        if (cancelled) return
        if (auth) {
          user = await this.db('users').where('id', auth.userId).first()
          if (cancelled) return
        }
      }
      if (!user) {
        user = {
          id: uuid(),
          name: 'Anonymous',
          avatar: null,
          rank: 0,
          createdAt: moment().toISOString(),
        }
        await this.db('users').insert(user)
        if (cancelled) return
        authToken = await createJWT({ userId: user.id })
        if (cancelled) return
      }

      const refuseDuplicate = () => {
        const packet = writePacket('kick', 'duplicate_user')
        this.write(ws, packet, { name: 'kick' })
        ws.close()
      }
      // disconnect if user still connecting elsewhere (the id is reserved before the next await)
      if (this.connecting.has(user.id)) return refuseDuplicate()
      reserved = user.id
      this.connecting.add(user.id)
      // Already in this world: refused while the old connection is alive (another window or device). A stale one
      // gives way: a phone that switched to a wallet app often comes back as a reload while its old socket still
      // looks open here (iOS suspends or discards the tab without closing it), and the regular ping check takes
      // up to 2 x PING_RATE to notice.
      const existing = this.sockets.get(user.id)
      if (existing) {
        const alive = await this.answersPing(existing, undefined, stop => (stopWaiting = stop))
        stopWaiting = null
        if (cancelled) return
        if (alive && this.sockets.get(user.id) === existing) return refuseDuplicate()
        const oldPlayer = existing.player
        ;(this.replacing ??= new Set()).add(user.id)
        replacing = user.id
        if (this.sockets.get(user.id) === existing) await this.retireSocket(existing)
        if (cancelled) return
        if (this.sockets.has(user.id)) return refuseDuplicate()
        // The old player's rank as it ended (an admin may have changed it while it was asked or retiring; it is
        // gone from the world now, so nothing changes it any more). Its database writes still on their way get a
        // moment to land, so the row read next has them. A write not settled when that read starts makes the
        // in-world rank the answer (the read may have missed it), and one still unsettled is carried to the
        // replacement, so a next takeover before it lands decides the same way
        const inWorldRank = oldPlayer?.data?.rank
        const writes = [...(oldPlayer?.rankWrites ?? [])].map(promise => {
          const write = { promise, settled: false }
          promise.then(
            () => (write.settled = true),
            () => (write.settled = true)
          )
          return write
        })
        if (writes.length) {
          await new Promise(resolve => {
            const timer = setTimeout(resolve, this.takeoverCloseMs ?? TAKEOVER_CLOSE_MS)
            timer.unref?.()
            Promise.allSettled(writes.map(write => write.promise)).then(() => {
              clearTimeout(timer)
              resolve()
            })
          })
          if (cancelled) return
        }
        const unsettledBeforeRead = writes.some(write => !write.settled)
        user = (await this.db('users').where('id', user.id).first()) ?? user
        if (cancelled) return
        carriedRankWrites = writes.filter(write => !write.settled).map(write => write.promise)
        if (unsettledBeforeRead && Number.isInteger(inWorldRank)) user = { ...user, rank: inWorldRank }
      }

      // livekit options
      const livekit = await this.world.livekit.serialize(user.id)
      if (cancelled) return

      // create socket
      socket = new Socket({ id: user.id, ws, network: this })
      socket.wallet = solanaGating.createWalletSession()
      socket.evmWallet = evmGating.createEvmWalletSession()

      // spawn player
      socket.player = this.world.entities.add(
        {
          id: user.id,
          type: 'player',
          position: this.spawn.position.slice(),
          quaternion: this.spawn.quaternion.slice(),
          owner: socket.id, // deprecated, same as userId
          userId: user.id, // deprecated, same as userId
          name: name || sanitizeName(user.name) || 'Anonymous',
          health: HEALTH_MAX,
          avatar: user.avatar || this.world.settings.avatar?.url || 'asset://avatar.vrm',
          sessionAvatar: avatar || null,
          rank: user.rank,
          enteredAt: Date.now(),
        },
        true
      )

      socket.player.rankRevision = 0
      socket.player.rankWritesPending = 0
      socket.player.rankWrites = new Set()
      for (const write of carriedRankWrites) {
        const player = socket.player
        player.rankWritesPending++
        player.rankWrites.add(write)
        const done = () => {
          player.rankWritesPending--
          player.rankWrites.delete(write)
        }
        write.then(done, done)
      }

      // send snapshot
      const snapshot = writePacket('snapshot', {
        id: socket.id,
        serverTime: performance.now(),
        assetsUrl: process.env.ASSETS_BASE_URL,
        apiUrl: process.env.PUBLIC_API_URL,
        maxUploadSize: process.env.PUBLIC_MAX_UPLOAD_SIZE,
        collections: this.world.collections.serialize(),
        settings: this.world.settings.serialize(),
        chat: this.world.chat.serialize(),
        ai: this.world.ai.serialize(),
        blueprints: this.world.blueprints.serialize(),
        entities: this.world.entities.serialize(),
        livekit,
        authToken,
        hasAdminCode: !!process.env.ADMIN_CODE,
      })

      if (snapshot.length > SNAPSHOT_CAP) throw new Error('snapshot too large')
      if (!this.write(ws, snapshot, { name: 'snapshot', snapshot: true })) throw new Error('snapshot write failed')

      this.sockets.set(socket.id, socket)

      // enter events on the server are sent after the snapshot.
      // on the client these are sent during PlayerRemote.js entity instantiation!
      this.world.events.emit('enter', { playerId: socket.player.data.id })
    } catch (err) {
      this.logOnce(ws, 'connection', `onConnection: ${briefError(err)}`)
      try {
        if (socket && !socket.disconnected) {
          // add() can throw from a listener after registering the entity.
          socket.player ||= this.world.entities.get(socket.id)
          this.onDisconnect(socket)
        }
      } catch (err) {
        this.logOnce(ws, 'connection-cleanup', `onConnection cleanup: ${briefError(err)}`)
      } finally {
        if (socket && this.sockets.get(socket.id) === socket) this.sockets.delete(socket.id)
        ws.close(1011)
      }
    } finally {
      if (reserved) this.connecting.delete(reserved)
      if (replacing) this.replacing.delete(replacing)
    }
  }

  onChatAdded = async (socket, msg) => {
    // the stored and broadcast message is built here from the allowed fields only; the sender identity
    // and the time come from the server, not the packet
    const safe = sanitizeChatMessage(msg)
    if (!safe) {
      return this.logOnce(
        socket,
        'chat-invalid',
        `onChatAdded: invalid message from ${socket.id} (further ones from this connection are not logged)`
      )
    }
    const message = {
      id: uuid(),
      from: socket.player.data.name,
      fromId: socket.player.data.id,
      body: safe.body,
      createdAt: moment().toISOString(),
    }
    this.world.chat.add(message, false)
    this.send('chatAdded', message, socket.id)
  }

  onCommand = async (socket, data) => {
    if (!isObject(data) || !Array.isArray(data.args)) return
    const { args } = data
    // handle slash commands
    const player = socket.player
    const playerId = player.data.id
    const [cmd, arg1, arg2] = args
    // become admin command
    if (cmd === 'admin') {
      const code = arg1
      if (process.env.ADMIN_CODE && process.env.ADMIN_CODE === code) {
        const id = player.data.id
        const userId = player.data.userId
        const granted = !player.isAdmin()
        let rank
        if (granted) {
          rank = Ranks.ADMIN
        } else {
          rank = Ranks.VISITOR
        }
        player.rankRevision++
        player.modify({ rank })
        this.send('entityModified', { id, rank })
        socket.send('chatAdded', {
          id: uuid(),
          from: null,
          fromId: null,
          body: granted ? 'Admin granted!' : 'Admin revoked!',
          createdAt: moment().toISOString(),
        })
        player.rankWritesPending++
        const write = persistRank({
          db: this.db,
          player,
          rank,
          wallets: solanaGating,
          isCurrent: () => this.sockets.get(player.data.id)?.player === player,
        })
        // kept on the player so a takeover can wait for it (or carry it to the replacement)
        ;(player.rankWrites ??= new Set()).add(write)
        try {
          await write
        } catch (err) {
          this.logOnce(
            socket,
            'user-rank-save',
            `error saving user rank for ${String(userId).slice(0, 64)}; the session keeps its previous grant state: ${briefError(err)}`
          )
        } finally {
          player.rankWritesPending--
          player.rankWrites.delete(write)
        }
      }
    }
    if (cmd === 'name') {
      const name = sanitizeName(arg1)
      if (name) {
        const id = player.data.id
        const userId = player.data.userId
        player.data.name = name
        player.modify({ name })
        this.send('entityModified', { id, name })
        socket.send('chatAdded', {
          id: uuid(),
          from: null,
          fromId: null,
          body: `Name set to ${name}!`,
          createdAt: moment().toISOString(),
        })
        try {
          await this.db('users').where('id', userId).update({ name })
        } catch (err) {
          this.logOnce(socket, 'user-name-save', `error saving user name: ${briefError(err)}`)
        }
      }
    }
    if (cmd === 'spawn') {
      const op = arg1
      this.onSpawnModified(socket, op)
    }
    if (cmd === 'chat') {
      const op = arg1
      if (op === 'clear' && socket.player.isBuilder()) {
        this.world.chat.clear(true)
      }
    }
    if (cmd === 'server') {
      const op = arg1
      // process figures are for builders; a visitor's /server stats is ignored like any other unknown command
      if (op === 'stats' && socket.player.isBuilder()) {
        const send = body => {
          socket.send('chatAdded', {
            id: uuid(),
            from: null,
            fromId: null,
            body,
            createdAt: moment().toISOString(),
          })
        }
        const stats = await this.world.monitor.getStats()
        send(`CPU: ${stats.currentCPU.toFixed(3)}%`)
        send(
          `Memory: ${stats.currentMemory} / ${stats.maxMemory} MB (${((stats.currentMemory / stats.maxMemory) * 100).toFixed(1)}%)`
        )
      }
    }
    // emit event for all except admin
    if (cmd !== 'admin') {
      this.world.events.emit('command', { playerId, args })
    }
  }

  onModifyRank = async (socket, data) => {
    if (!socket.player.isAdmin()) return
    if (!isObject(data)) return
    const { playerId, rank } = data
    if (!playerId) return
    if (rank !== Ranks.VISITOR && rank !== Ranks.BUILDER && rank !== Ranks.ADMIN) return
    const player = this.world.entities.get(playerId)
    if (!player || !player.isPlayer) return
    player.rankRevision++
    player.modify({ rank })
    this.send('entityModified', { id: playerId, rank })
    // once the rank is in the database any session-only token grant is over
    player.rankWritesPending++
    const write = persistRank({
      db: this.db,
      player,
      rank,
      wallets: solanaGating,
      isCurrent: () => this.sockets.get(player.data.id)?.player === player,
    })
    // kept on the player so a takeover can wait for it (or carry it to the replacement)
    ;(player.rankWrites ??= new Set()).add(write)
    try {
      await write
    } catch (err) {
      this.logOnce(
        socket,
        'user-rank-save',
        `error saving user rank for ${String(playerId).slice(0, 64)}; the session keeps its previous grant state: ${briefError(err)}`
      )
    } finally {
      player.rankWritesPending--
      player.rankWrites.delete(write)
    }
  }

  onKick = (socket, playerId) => {
    const player = this.world.entities.get(playerId)
    if (!player) return
    // admins can kick builders + visitors
    // builders can kick visitors
    // visitors cannot kick anyone
    if (socket.player.data.rank <= player.data.rank) return
    const tSocket = this.sockets.get(playerId)
    if (!tSocket) return
    tSocket.send('kick', 'moderation')
    tSocket.disconnect()
  }

  onMute = (socket, data) => {
    if (!isObject(data)) return
    const player = this.world.entities.get(data.playerId)
    if (!player) return
    // admins can mute builders + visitors
    // builders can mute visitors
    // visitors cannot mute anyone
    if (socket.player.data.rank <= player.data.rank) return
    this.world.livekit.setMuted(data.playerId, data.muted)
  }

  invalidateWallet(socket, { clearVerified }) {
    const state = socket.wallet
    state.generation++
    state.challenge = null
    state.pendingBalance = null
    if (clearVerified) state.verified = null
  }

  current(socket, generation, player) {
    return (
      this.sockets.get(socket.id) === socket &&
      !socket.disconnected &&
      !this.stopping &&
      !this.world.fatalError &&
      socket.wallet.generation === generation &&
      socket.player === player
    )
  }

  onRequestBuilderNonce = (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!solanaGating.TOKEN_GATING_ENABLED || !isObject(data) || Array.isArray(data)) return
    const { walletAddress, attempt } = data
    if (!solanaGating.isWalletAddress(walletAddress) || !solanaGating.isWalletRequestId(attempt)) return
    const state = socket.wallet
    if (!this.current(socket, state.generation, socket.player)) return
    const now = Date.now()
    const retryAfterMs = solanaGating.CHALLENGE_COOLDOWN_MS - (now - state.lastChallengeAt)
    if (retryAfterMs > 0) {
      if (!state.challengeCooldownReplied) {
        state.challengeCooldownReplied = true
        socket.send('builderNonce', { attempt, retryAfterMs })
      }
      return
    }
    const wasVerified = !!state.verified
    this.invalidateWallet(socket, { clearVerified: true })
    if (wasVerified) socket.send('walletStatus', { verified: false })
    state.lastChallengeAt = now
    state.challengeCooldownReplied = false
    const challenge = solanaGating.buildChallenge(walletAddress, solanaGating.WALLET_HOST, now, solanaGating.WALLET_URI)
    state.challenge = { ...challenge, attempt }
    socket.send('builderNonce', { attempt, nonce: challenge.nonce, message: challenge.message })
  }

  onRequestBuilderByToken = async (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!solanaGating.TOKEN_GATING_ENABLED || !isObject(data) || Array.isArray(data) || !socket.player) return
    const { walletAddress, signature, nonce, attempt } = data
    if (!walletAddress || !signature || !nonce) {
      return this.logOnce(
        socket,
        'builder-token-invalid',
        'Invalid builder token request (missing walletAddress/signature/nonce)'
      )
    }
    if (!solanaGating.isWalletRequestId(attempt) || !solanaGating.isWalletNonce(nonce)) return
    const player = socket.player
    const state = socket.wallet
    if (!this.current(socket, state.generation, player)) return
    const challenge = state.challenge
    // An obsolete packet cannot consume the current attempt or produce another failure reply.
    if (!challenge || challenge.nonce !== nonce || challenge.attempt !== attempt) return
    state.challenge = null
    const result = solanaGating.checkChallenge(challenge, { walletAddress, signature, nonce }, Date.now())
    if (!result.ok) {
      this.invalidateWallet(socket, { clearVerified: true })
      socket.send('walletStatus', { verified: false, attempt })
      socket.send('chatAdded', {
        id: uuid(),
        body: 'Wallet verification failed.',
        createdAt: moment().toISOString(),
      })
      return
    }
    state.verified = walletAddress
    socket.send('walletStatus', { verified: true, wallet: walletAddress, attempt })
    if (player.data.rank >= Ranks.BUILDER) return
    await this.checkBuilderBalance(socket, true)
  }

  async checkBuilderBalance(socket, notifyInsufficient) {
    const player = socket.player
    const { generation, verified: walletAddress } = socket.wallet
    const revision = player.rankRevision
    let result = { known: false }
    if (!player.rankWritesPending) {
      try {
        result = await this.tokenBalanceService.get(walletAddress, { fresh: true })
      } catch {
        // The production service resolves unknown; an injected service may reject.
      }
    }
    if (!this.current(socket, generation, player) || player.rankRevision !== revision) return
    if (!(player.data.rank < Ranks.BUILDER)) return
    if (player.rankWritesPending) result = { known: false }
    let body
    if (result.known && result.balance >= solanaGating.REQUIRED_TOKEN_AMOUNT) {
      if (!grantTokenRank({ socket, player, walletAddress, wallets: solanaGating })) return
      const rank = Ranks.BUILDER
      player.rankRevision++
      player.modify({ rank })
      this.send('entityModified', { id: player.data.id, rank })
      body = `Token verified! Builder access granted (${Number(result.balance).toLocaleString()} tokens)`
    } else if (result.known && result.balance < solanaGating.REQUIRED_TOKEN_AMOUNT) {
      if (!notifyInsufficient) return
      body = `Builder access requires ${solanaGating.REQUIRED_TOKEN_AMOUNT.toLocaleString()} tokens (current: ${Number(result.balance).toLocaleString()})`
    } else {
      body = 'Could not check your balance. Press refresh in a moment.'
    }
    socket.send('chatAdded', { id: uuid(), body, createdAt: moment().toISOString() })
  }

  onRequestBuilderRecheck = async (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!solanaGating.TOKEN_GATING_ENABLED || !isObject(data) || Array.isArray(data) || Object.keys(data).length) return
    const player = socket.player
    const state = socket.wallet
    if (!player || !state.verified || !(player.data.rank < Ranks.BUILDER)) return
    if (!this.current(socket, state.generation, player)) return
    const now = Date.now()
    if (now - state.builderRecheckAt < solanaGating.BUILDER_RECHECK_MS) return
    state.builderRecheckAt = now
    await this.checkBuilderBalance(socket, false)
  }

  onTokenBalanceRequest = async (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!solanaGating.TOKEN_GATING_ENABLED) return
    if (!isObject(data) || Array.isArray(data) || !solanaGating.isWalletRequestId(data.id)) return
    const { id } = data
    const state = socket.wallet
    const player = socket.player
    if (!this.current(socket, state.generation, player)) return
    const bucket = state.balanceBucket
    const now = Date.now()
    bucket.tokens = Math.min(3, bucket.tokens + Math.max(0, now - bucket.at) / 2000)
    bucket.at = now
    if (bucket.tokens < 1) return
    bucket.tokens--
    if (state.pendingBalance) return
    if (!state.verified) {
      socket.send('tokenBalance', { id, verified: false, known: false, balance: 0 })
      return
    }
    const { generation, verified: wallet } = state
    const pending = { id }
    state.pendingBalance = pending
    let result = { known: false }
    try {
      try {
        result = await this.tokenBalanceService.get(wallet)
      } catch {
        // Operational failures still produce a bounded unknown answer.
      }
      if (!this.current(socket, generation, player) || state.verified !== wallet) return
      socket.send('tokenBalance', {
        id,
        verified: true,
        known: result.known,
        balance: result.known ? result.balance : 0,
      })
    } finally {
      if (state.pendingBalance === pending) state.pendingBalance = null
    }
  }

  onRevokeBuilderByToken = (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!solanaGating.TOKEN_GATING_ENABLED || !isObject(data) || Array.isArray(data) || Object.keys(data).length) return
    const state = socket.wallet
    const changed = !!(state.verified || state.challenge)
    this.invalidateWallet(socket, { clearVerified: true })
    if (!this.current(socket, state.generation, socket.player)) return
    if (changed) socket.send('walletStatus', { verified: false })
    const player = socket.player
    if (!player) return
    if (player.data.rank === Ranks.BUILDER && player.data.tokenGrantedRank) {
      const rank = Ranks.VISITOR
      player.rankRevision++
      player.modify({ rank })
      revokeTokenRank({ socket, player, wallets: solanaGating })
      this.send('entityModified', { id: player.data.id, rank })
      socket.send('chatAdded', {
        id: uuid(),
        body: 'Wallet disconnected: builder access removed.',
        createdAt: moment().toISOString(),
      })
    }
  }

  // EVM (SIWE) の所有証明。Solana の socket.wallet とは世代もクールダウンも独立させ、互いの試行を取り消さない。
  // 検証はランクを変えない (P1)
  invalidateEvmWallet(socket, { clearVerified }) {
    const state = socket.evmWallet
    const wasVerified = clearVerified && !!state.verified
    state.generation++
    state.challenge = null
    if (clearVerified) {
      state.verified = null
      state.verifiedContract = false
    }
    // チケットは捨てない: 送金の途中でウォレットが切り替わると、取り下げが tx の報告より先に届く。
    // チケットの送り手 (from) は発行時にこの接続で検証済みで変わらず、確定はその from のログでしか起きない
    if (!wasVerified) return
    // 検証が消えたら投げゼニの受け取りも止め (他の人の一覧から Tip を消す)、スクリプトにも知らせる
    const player = socket.player
    if (state.receiveTips) {
      state.receiveTips = false
      if (player?.data.evmTips) {
        player.modify({ evmTips: false })
        this.send('entityModified', { id: player.data.id, evmTips: false })
      }
    }
    if (player) this.world.events?.emit('evmWallet', Object.freeze({ playerId: player.data.id, verified: false }))
  }

  currentEvm(socket, generation, player) {
    return (
      this.sockets.get(socket.id) === socket &&
      !socket.disconnected &&
      !this.stopping &&
      !this.world.fatalError &&
      socket.evmWallet?.generation === generation &&
      socket.player === player
    )
  }

  onRequestEvmNonce = (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!evmGating.EVM_ENABLED || !isObject(data) || Array.isArray(data)) return
    const { address, attempt } = data
    if (!evmGating.isEvmAddress(address) || evmGating.isZeroAddress(address) || !evmGating.isWalletRequestId(attempt))
      return
    const state = socket.evmWallet
    if (!state || !this.currentEvm(socket, state.generation, socket.player)) return
    const now = Date.now()
    const retryAfterMs = evmGating.CHALLENGE_COOLDOWN_MS - (now - state.lastChallengeAt)
    if (retryAfterMs > 0) {
      if (!state.challengeCooldownReplied) {
        state.challengeCooldownReplied = true
        socket.send('evmNonce', { attempt, retryAfterMs })
      }
      return
    }
    const wasVerified = !!state.verified
    this.invalidateEvmWallet(socket, { clearVerified: true })
    if (wasVerified) socket.send('evmWalletStatus', { verified: false })
    state.lastChallengeAt = now
    state.challengeCooldownReplied = false
    const challenge = evmGating.buildEvmChallenge(address, {
      host: evmGating.WALLET_HOST,
      uri: evmGating.WALLET_URI,
      chainId: evmGating.EVM_CHAIN_ID,
      now,
    })
    state.challenge = { ...challenge, attempt }
    socket.send('evmNonce', { attempt, nonce: challenge.nonce, message: challenge.message })
  }

  onRequestEvmVerify = async (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!evmGating.EVM_ENABLED || !isObject(data) || Array.isArray(data) || !socket.player) return
    const { address, signature, nonce, attempt } = data
    if (!evmGating.isWalletRequestId(attempt) || !evmGating.isWalletNonce(nonce)) return
    const player = socket.player
    const state = socket.evmWallet
    if (!state) return
    const generation = state.generation
    if (!this.currentEvm(socket, generation, player)) return
    const challenge = state.challenge
    // 古いパケットは現在の試行を消費せず、失敗の返信も出さない
    if (!challenge || challenge.nonce !== nonce || challenge.attempt !== attempt) return
    // await の前に使い切る (同じ nonce の二重検証を防ぐ)
    state.challenge = null
    const result = await evmGating.checkEvmChallenge(challenge, { address, signature, nonce }, Date.now(), {
      verifyContract: this.evmSignatureVerifier,
    })
    if (!this.currentEvm(socket, generation, player)) return
    if (!result.ok) {
      this.invalidateEvmWallet(socket, { clearVerified: true })
      socket.send('evmWalletStatus', { verified: false, attempt, reason: evmGating.publicReason(result.reason) })
      return
    }
    state.verified = challenge.address
    // a contract account's ownership is proven on the sign-in chain only
    state.verifiedContract = result.contract === true
    socket.send('evmWalletStatus', { verified: true, wallet: challenge.address, attempt, reason: 'ok' })
    this.world.events?.emit('evmWallet', Object.freeze({ playerId: player.data.id, verified: true }))
  }

  onRevokeEvmWallet = (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!evmGating.EVM_ENABLED || !isObject(data) || Array.isArray(data) || Object.keys(data).length) return
    const state = socket.evmWallet
    if (!state) return
    const changed = !!(state.verified || state.challenge)
    this.invalidateEvmWallet(socket, { clearVerified: true })
    if (!this.currentEvm(socket, state.generation, socket.player)) return
    if (changed) socket.send('evmWalletStatus', { verified: false })
  }

  // 投げゼニの受け取り (オプトイン)。アドレスは配らず、真偽値 evmTips だけをプレイヤーに載せる
  onSetEvmTipReceive = (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!evmGating.EVM_ENABLED || !evmGating.EVM_TIP_TOKENS.length) return
    if (!isObject(data) || Array.isArray(data) || typeof data.enabled !== 'boolean' || Object.keys(data).length !== 1)
      return
    const state = socket.evmWallet
    const player = socket.player
    if (!state || !player || !this.currentEvm(socket, state.generation, player)) return
    const enabled = data.enabled && !!state.verified
    if (state.receiveTips === enabled) return
    // 切替のたびに全員へ配るので、受け取りの開始はソケットあたり 1 秒に 1 回まで。
    // やめる方は待たせない (アドレスを渡し続けないため)
    const now = Date.now()
    if (enabled && now - state.receiveChangedAt < evmGating.TIP_RECEIVE_COOLDOWN_MS) return
    state.receiveChangedAt = now
    state.receiveTips = enabled
    player.modify({ evmTips: enabled })
    this.send('entityModified', { id: player.data.id, evmTips: enabled })
  }

  // 送金の意思表示 (tip intent)。受取人のアドレスは、検証済みの送り手にだけ、ここで返す。
  // サーバーは送金を作らず預からない: 返すのは受取人の検証済みアドレスと最小単位の金額だけ
  onRequestEvmTipIntent = (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!evmGating.EVM_ENABLED || !evmGating.EVM_TIP_TOKENS.length || !isObject(data) || Array.isArray(data)) return
    const { id, to, token, amount } = data
    if (!evmGating.isWalletRequestId(id) || typeof to !== 'string' || !to || to.length > 64) return
    if (typeof token !== 'string' || typeof amount !== 'string' || amount.length > 40) return
    const state = socket.evmWallet
    const player = socket.player
    if (!state || !player || !this.currentEvm(socket, state.generation, player)) return
    // アドレス収集の摩擦: 理由を問わず 1 件ずつ消費する (3 件、10 秒に 1 件回復)
    const bucket = state.intentBucket
    const now = Date.now()
    bucket.tokens = Math.min(
      evmGating.TIP_INTENT_BURST,
      bucket.tokens + Math.max(0, now - bucket.at) / evmGating.TIP_INTENT_REFILL_MS
    )
    bucket.at = now
    const refuse = reason => socket.send('evmTipIntent', { id, ok: false, reason })
    if (bucket.tokens < 1) return refuse('rate_limited')
    bucket.tokens--
    if (!state.verified) return refuse('not_verified')
    const tip = evmGating.EVM_TIP_TOKENS.find(entry => entry.symbol === token)
    if (!tip) return refuse('bad_token')
    let units
    try {
      units = parseTipAmount(amount, tip)
    } catch (err) {
      return refuse(err?.message === 'below minimum' ? 'below_minimum' : 'bad_amount')
    }
    const target = this.sockets.get(to)
    const recipient =
      target && target !== socket && !target.disconnected && target.evmWallet?.receiveTips
        ? target.evmWallet.verified
        : null
    if (!recipient) return refuse('recipient_unavailable')
    // 同じウォレットを別のソケットで検証していても自分宛ては出さない
    if (evmGating.sameEvmAddress(recipient, state.verified)) return refuse('same_wallet')
    const ticket = this.issueTipTicket(socket, {
      from: state.verified,
      toPlayerId: to,
      toName: target.player?.data.name,
      recipient,
      token: tip,
      units,
    })
    socket.send('evmTipIntent', {
      id,
      ok: true,
      to,
      recipient,
      chainId: evmGating.EVM_CHAIN_ID,
      token: { symbol: tip.symbol, address: tip.address, decimals: tip.decimals },
      amount,
      units: units.toString(),
      ticket,
    })
  }

  // intent の控え (P2b)。送金後の tx の報告はこれに対してだけ受ける。受取人はソケットではなく id で持つ
  issueTipTicket(socket, data) {
    const tickets = socket.evmWallet.tickets
    const now = Date.now()
    for (const [id, ticket] of tickets) {
      if (ticket.state !== 'watching' && now - ticket.issuedAt >= evmGating.TIP_TICKET_TTL_MS) tickets.delete(id)
    }
    // 上限では古い未使用のものから、次に古い再提出待ちから捨てる。見張り中は捨てない (ソケットあたり 2 件まで)
    while (tickets.size >= evmGating.TIP_TICKETS_PER_SOCKET) {
      const all = [...tickets.values()]
      const victim = all.find(t => t.state === 'issued') ?? all.find(t => t.state === 'retryable')
      if (!victim) break
      tickets.delete(victim.ticket)
    }
    const ticket = evmGating.createTipTicket()
    tickets.set(ticket, { ...data, ticket, issuedAt: now, state: 'issued', retriesLeft: 1, txHash: null })
    return ticket
  }

  // 送金の tx の報告 (P2b)。チェーンで確かめ、確定したら告知と tip イベント。クライアントの申告は信じない
  onEvmTip = (socket, data) => {
    if (this.stopping || this.world.fatalError) return
    if (!evmGating.EVM_ENABLED || !evmGating.EVM_TIP_TOKENS.length || !isObject(data) || Array.isArray(data)) return
    const { ticket: id, txHash } = data
    if (!evmGating.isTipTicket(id) || typeof txHash !== 'string' || Object.keys(data).length !== 2) return
    const state = socket.evmWallet
    const player = socket.player
    if (!state || !player || !this.currentEvm(socket, state.generation, player)) return
    const reply = (result, reason) =>
      socket.send('evmTipStatus', { ticket: id, txHash, state: result, ...(reason ? { reason } : {}) })
    if (!isTxHash(txHash)) return reply('failed', 'bad_tx')
    const hash = txHash.toLowerCase()
    const ticket = state.tickets.get(id)
    const now = Date.now()
    const reusable =
      ticket?.state === 'issued' || (ticket?.state === 'retryable' && ticket.retriesLeft > 0 && ticket.txHash === hash)
    // 無い・期限切れ・使用済み・別の tx での再提出は区別しない。今の検証状態は問わない (チケットの from で照合する)
    if (!reusable || now - ticket.issuedAt >= evmGating.TIP_TICKET_TTL_MS) return reply('failed', 'unknown_ticket')
    if (!this.tipWatcher) {
      state.tickets.delete(id)
      return reply('unverified', 'no_rpc')
    }
    this.pruneTipSeen(now)
    if (this.tipSeen.has(hash)) {
      state.tickets.delete(id)
      return reply('failed', 'duplicate')
    }
    // 上限に当たってもチケットはそのまま (再提出の回数は減らさない)
    let watchingHere = 0
    for (const other of state.tickets.values()) if (other.state === 'watching') watchingHere++
    // 同じ txHash ごとの上限は設けない (他人の報告で枠を埋められないように)。他人の見張りは from が違うので確定しない
    if (watchingHere >= evmGating.TIP_WATCH_PER_SOCKET || this.tipWatcher.size() >= evmGating.TIP_WATCH_MAX) {
      return reply('unverified', 'busy')
    }
    if (ticket.state === 'retryable') ticket.retriesLeft--
    ticket.state = 'watching'
    ticket.txHash = hash
    // 既読にするのは確定した時だけ (他人の txHash を先に報告されても、本人の報告は妨げられない)
    const watching = this.tipWatcher.watch({
      socket,
      txHash: hash,
      from: ticket.from,
      recipient: ticket.recipient,
      token: ticket.token.address,
      units: ticket.units,
      notBeforeSec: ticket.issuedAt / 1000 - evmGating.TIP_TIME_SKEW_SEC,
      isLive: () =>
        this.sockets.get(socket.id) === socket && !socket.disconnected && !this.stopping && !this.world.fatalError,
      onDone: result => this.onTipResult(socket, id, hash, result),
    })
    if (!watching) {
      ticket.state = 'issued'
      return reply('unverified', 'busy')
    }
    reply('watching')
  }

  pruneTipSeen(now) {
    for (const [hash, until] of this.tipSeen) {
      if (until > now && this.tipSeen.size <= evmGating.TIP_SEEN_MAX) break
      this.tipSeen.delete(hash)
    }
  }

  onTipResult(socket, id, hash, result) {
    if (this.stopping || this.world.fatalError) return
    const tickets = socket.evmWallet?.tickets
    const ticket = tickets?.get(id)
    if (!ticket || ticket.state !== 'watching') return
    let { state, reason } = result
    if (state === 'confirmed') {
      const now = Date.now()
      this.pruneTipSeen(now)
      // 同じ tx を別のチケットで先に確定していれば、二度目は数えない
      if (this.tipSeen.has(hash)) {
        state = 'failed'
        reason = 'duplicate'
      } else {
        this.tipSeen.set(hash, now + evmGating.TIP_SEEN_TTL_MS)
      }
    }
    // 確認できなかった時は 1 回だけ再提出できる (RPC が無い・送り手の離脱は除く)
    if (state === 'unverified' && reason !== 'left' && ticket.retriesLeft > 0) ticket.state = 'retryable'
    else tickets.delete(id)
    if (this.sockets.get(socket.id) === socket && !socket.disconnected) {
      socket.send('evmTipStatus', { ticket: id, txHash: hash, state, ...(reason ? { reason } : {}) })
    }
    if (state === 'confirmed') this.tipConfirmed(socket, ticket)
  }

  // 確定した投げゼニ: サーバースクリプトへ tip イベント (必ず) とワールドへの告知 (間引きあり)
  tipConfirmed(socket, ticket) {
    const player = socket.player
    if (!player) return
    const { symbol, decimals } = ticket.token
    const amount = formatUnits(ticket.units, decimals)
    // アドレスと tx ハッシュはスクリプトに渡さない (tx ハッシュから両者のアドレスが分かる)
    this.world.events?.emit(
      'tip',
      Object.freeze({
        tipId: ticket.ticket,
        fromPlayerId: player.data.id,
        toPlayerId: ticket.toPlayerId,
        token: symbol,
        amount,
        units: ticket.units.toString(),
        decimals,
        chainId: evmGating.EVM_CHAIN_ID,
        at: Date.now(),
      })
    )
    // 告知文の名前: 改行・制御文字・書式文字は空白にし、32 文字 (コードポイント) で切る
    const shown = name => {
      const text = String(name ?? '')
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return Array.from(text).slice(0, 32).join('') || 'Anonymous'
    }
    const fromName = shown(player.data.name)
    const toName = shown(this.sockets.get(ticket.toPlayerId)?.player?.data.name ?? ticket.toName)
    this.announceTip({
      fromId: player.data.id,
      toPlayerId: ticket.toPlayerId,
      body: `${fromName} tipped ${toName} ${amount} ${symbol}`,
      privateBody: `(only you) ${fromName} tipped you ${amount} ${symbol}`,
    })
  }

  // 告知は全体で 3 秒に 1 件 (バースト 3)、待ちは 20 件、同じ送り手は 30 秒に 1 回。
  // 告知しない時は受取人にだけ知らせる (公開の告知と見分けられる文面で)
  announceTip({ fromId, toPlayerId, body, privateBody }) {
    const announce = this.tipAnnounce
    const now = Date.now()
    if (announce.last.size > 256) {
      for (const [id, at] of announce.last) if (now - at >= evmGating.TIP_ANNOUNCE_COOLDOWN_MS) announce.last.delete(id)
    }
    const last = announce.last.get(fromId)
    const cooled = last === undefined || now - last >= evmGating.TIP_ANNOUNCE_COOLDOWN_MS
    if (cooled && announce.queue.length < evmGating.TIP_ANNOUNCE_QUEUE) {
      announce.last.set(fromId, now)
      announce.queue.push(body)
      this.drainTipAnnouncements()
      return
    }
    const socket = this.sockets.get(toPlayerId)
    if (socket && !socket.disconnected) {
      socket.send('chatAdded', {
        id: uuid(),
        from: null,
        fromId: null,
        body: privateBody,
        createdAt: moment().toISOString(),
      })
    }
  }

  drainTipAnnouncements() {
    const announce = this.tipAnnounce
    if (announce.timer || this.stopping || this.world.fatalError) return
    const now = Date.now()
    announce.tokens = Math.min(
      evmGating.TIP_ANNOUNCE_BURST,
      announce.tokens + Math.max(0, now - announce.at) / evmGating.TIP_ANNOUNCE_INTERVAL_MS
    )
    announce.at = now
    while (announce.queue.length && announce.tokens >= 1) {
      announce.tokens--
      const body = announce.queue.shift()
      this.world.chat.add({ id: uuid(), from: null, fromId: null, body, createdAt: moment().toISOString() }, true)
    }
    if (announce.queue.length) {
      announce.timer = setTimeout(() => {
        announce.timer = null
        this.drainTipAnnouncements()
      }, evmGating.TIP_ANNOUNCE_INTERVAL_MS)
    }
  }

  // 切断: そのソケットのチケットを捨て、送り手としての見張りを止める (結果は出さない)
  dropTipTickets(socket) {
    const tickets = socket.evmWallet?.tickets
    if (!tickets) return
    tickets.clear()
    this.tipWatcher?.cancel(job => job.socket === socket)
  }

  // サーバースクリプトの player.getEvmHolding から呼ばれる。アドレスはスクリプトに見せず、ここで引く
  async evmHolding(playerId, spec) {
    const socket = this.sockets.get(playerId)
    const state = socket && !socket.disconnected ? socket.evmWallet : null
    const address = state?.verified ?? null
    if (!address) return { verified: false, known: false, balance: 0 }
    // a contract account proved its ownership on the sign-in chain only: on another chain the same address may
    // belong to someone else (a Safe with other owners), so it is not verified there
    const provenHere = () => !state.verifiedContract || Number(spec?.chainId) === evmGating.EVM_CHAIN_ID
    if (!provenHere()) return { verified: false, known: false, balance: 0 }
    if (!this.evmHoldings) return { verified: true, known: false, balance: 0 }
    // every new sign-in (even of the same address, or the same address proven another way) bumps the generation
    const generation = state.generation
    let result = { known: false }
    try {
      result = await this.evmHoldings.get(address, spec)
    } catch {
      // 予期しない失敗も unknown
    }
    // 待っている間に検証が変わったら、古い検証での結果は使わない
    if (
      this.sockets.get(playerId) !== socket ||
      socket.disconnected ||
      socket.evmWallet !== state ||
      state.generation !== generation ||
      state.verified !== address ||
      !provenHere()
    ) {
      return { verified: false, known: false, balance: 0 }
    }
    const known = result?.known === true && Number.isFinite(result.balance) && result.balance >= 0
    return { verified: true, known, balance: known ? result.balance : 0 }
  }

  onBlueprintAdded = (socket, blueprint) => {
    if (this.stopping) return
    if (!this.requireBuilder(socket, 'add blueprint')) return
    const { ok, value: safe } = sanitizeBlueprintAdd(blueprint, {
      onUnknownKey: key => this.logOnce(socket, 'blueprint-unknown', `blueprint: unknown key ${key}`),
    })
    const fits = ok && this.world.blueprints.canFit(safe, true)
    if (!fits) {
      // Clients announce the blueprint immediately before the entity that uses it.
      if (typeof blueprint?.id === 'string') {
        socket.refusedBlueprint = { id: blueprint.id, expiresAt: Date.now() + 10000 }
      }
      return ok
        ? this.logOnce(socket, 'blueprint-add-budget', 'onBlueprintAdded: world blueprint budget exceeded')
        : this.logOnce(socket, 'blueprint-add-invalid', 'onBlueprintAdded: invalid blueprint')
    }
    if (socket.refusedBlueprint?.id === safe.id) socket.refusedBlueprint = null
    this.markBlueprintDirty(safe)
    this.world.blueprints.add(safe)
    this.send('blueprintAdded', safe, socket.id)
  }

  onBlueprintModified = (socket, data) => {
    if (this.stopping) return
    if (!this.requireBuilder(socket, 'modify blueprint')) return
    const { ok, value: safe } = sanitizeBlueprintModify(data, {
      onUnknownKey: key => this.logOnce(socket, 'blueprint-unknown', `blueprint: unknown key ${key}`),
    })
    if (!ok) {
      this.logOnce(socket, 'blueprint-modify-invalid', 'onBlueprintModified: invalid blueprint')
      if (typeof data?.id === 'string') this.revertBlueprint(socket, this.world.blueprints.get(data.id))
      return
    }
    const blueprint = this.world.blueprints.get(safe.id)
    if (!blueprint) {
      return this.logOnce(
        socket,
        'blueprint-missing',
        `onBlueprintModified: no blueprint found: ${String(safe.id).slice(0, 64)}`
      )
    }
    // if new version is greater than current version, allow it
    if (safe.version > blueprint.version) {
      if (!this.world.blueprints.canFit(safe)) {
        this.logOnce(socket, 'blueprint-modify-budget', 'onBlueprintModified: world blueprint budget exceeded')
        this.revertBlueprint(socket, blueprint)
        return
      }
      this.markBlueprintDirty({ ...blueprint, ...safe })
      this.send('blueprintModified', safe, socket.id)
      this.world.blueprints.modify(safe, false, { authorSocketId: socket.id })
    }
    // otherwise, send a revert back to client, because someone else modified before them
    else {
      this.revertBlueprint(socket, blueprint)
    }
  }

  revertBlueprint(socket, blueprint) {
    if (!blueprint) return
    const now = Date.now()
    const reverts = (socket.blueprintReverts ||= new Map())
    for (const [id, expiresAt] of reverts) {
      if (expiresAt <= now) reverts.delete(id)
    }
    if (reverts.has(blueprint.id)) return
    reverts.set(blueprint.id, now + 1000)
    socket.send('blueprintModified', blueprint)
  }

  onEntityAdded = (socket, data) => {
    if (this.stopping) return
    if (!this.requireBuilder(socket, 'add entity')) return
    const refused = socket.refusedBlueprint
    if (refused) {
      if (refused.expiresAt <= Date.now()) {
        socket.refusedBlueprint = null
      } else if (data?.blueprint === refused.id) {
        socket.refusedBlueprint = null
        if (typeof data.id === 'string') socket.send('entityRemoved', data.id)
        return
      }
    }
    // clients may only add apps, with a fresh id and an existing blueprint
    const safe = sanitizeEntityAdd(data, socket.id, {
      blueprintExists: id => !!this.world.blueprints.get(id),
      entityExists: id => !!this.world.entities.get(id),
    })
    if (!safe) {
      return this.logOnce(socket, 'entity-invalid', `onEntityAdded: invalid entity: ${String(data?.id).slice(0, 64)}`)
    }
    this.markAppDirty(safe)
    this.send('entityAdded', safe, socket.id)
    this.world.entities.add(safe)
  }

  onEntityModified = async (socket, data) => {
    if (this.stopping) return
    if (!isObject(data)) return this.logOnce(socket, 'entity-packet-invalid', 'onEntityModified: invalid packet')
    const entity = this.world.entities.get(data.id)
    if (!entity) {
      return this.logOnce(
        socket,
        'entity-missing',
        `onEntityModified: no entity found: ${String(data.id).slice(0, 64)}`
      )
    }
    if (entity.isPlayer) {
      // a socket may only modify its own player, and only the client-owned fields
      if (entity !== socket.player) {
        return this.logOnce(socket, 'player-modify-other', 'player attempted to modify another player')
      }
      const allowAvatar = socket.player.isBuilder() || !!this.world.settings.customAvatars
      const safe = sanitizePlayerSelfModify(data, socket.id, { allowAvatar })
      if (!safe) {
        return this.logOnce(
          socket,
          'entity-fields',
          `onEntityModified: no permitted fields: ${String(data.id).slice(0, 64)}`
        )
      }
      entity.modify(safe)
      this.send('entityModified', safe, socket.id)
      // the sender applied its name locally before sending; correct it if it was truncated
      if (Object.prototype.hasOwnProperty.call(safe, 'name') && safe.name !== data.name) {
        socket.send('entityModified', { id: entity.data.id, name: safe.name })
      }
      // persist player name and avatar changes
      const changes = {}
      let changed
      if (Object.prototype.hasOwnProperty.call(safe, 'name')) {
        changes.name = safe.name
        changed = true
      }
      if (Object.prototype.hasOwnProperty.call(safe, 'avatar')) {
        changes.avatar = safe.avatar
        changed = true
      }
      if (changed) {
        try {
          await this.db('users').where('id', entity.data.userId).update(changes)
        } catch (err) {
          this.logOnce(socket, 'user-changes-save', `error saving user changes: ${briefError(err)}`)
        }
      }
      return
    }
    if (entity.isApp) {
      let safe
      if (socket.player.isBuilder()) {
        safe = sanitizeAppModify(data, socket.id, { blueprintExists: id => !!this.world.blueprints.get(id) })
      } else {
        // a sender that lost builder may still finish or cancel its own move and upload
        const mover = entity.data.mover === socket.id
        const uploader = entity.data.uploader === socket.id
        if (!mover && !uploader) {
          this.requireBuilder(socket, 'modify entity')
          return
        }
        safe = sanitizeAppRelease(data, { mover, uploader })
      }
      if (!safe) {
        return this.logOnce(
          socket,
          'entity-fields',
          `onEntityModified: no permitted fields: ${String(data.id).slice(0, 64)}`
        )
      }
      this.markAppDirty(entity.data, safe)
      this.send('entityModified', safe, socket.id)
      entity.modify(safe)
    }
  }

  onEntityEvent = (socket, event, meta) => {
    if (this.stopping) return
    if (!Array.isArray(event)) return
    const [id, version, name, data] = event
    // engine hooks and world events are never raised from the network
    if (typeof name !== 'string' || internalEvents.includes(name)) return
    if (!Number.isSafeInteger(version) || version < 0) return
    const entity = this.world.entities.get(id)
    entity?.onEvent(version, name, data, socket.id, meta)
  }

  onEntityRemoved = (socket, id) => {
    if (this.stopping) return
    if (typeof id !== 'string') return
    const entity = this.world.entities.get(id)
    if (!entity) return
    if (!entity.isApp) {
      return this.logOnce(socket, 'entity-remove-player', 'player attempted to remove a non-app entity')
    }
    // a sender that lost builder may still cancel its own pending upload (see onEntityModified)
    const uploader = entity.data.uploader === socket.id
    if (!uploader && !this.requireBuilder(socket, 'remove entity')) return
    this.world.entities.remove(id)
    this.send('entityRemoved', id, socket.id)
  }

  onSettingsModified = (socket, data) => {
    if (this.stopping) return
    if (!this.requireBuilder(socket, 'modify settings')) return
    if (!isObject(data)) return
    const { key, value } = data
    if (!isKnownSettingKey(key)) {
      return this.logOnce(socket, 'setting-unknown', `onSettingsModified: unknown setting: ${String(key).slice(0, 64)}`)
    }
    if (isAdminOnlySettingKey(key) && !socket.player.isAdmin()) {
      return this.logOnce(socket, 'setting-admin', 'player attempted to modify setting without admin permission')
    }
    const result = normalizeSettingValue(key, value)
    if (!result.ok) {
      return this.logOnce(
        socket,
        'setting-invalid',
        `onSettingsModified: invalid value for ${String(key).slice(0, 64)}`
      )
    }
    this.world.settings.set(key, result.value)
    this.send('settingsModified', { key, value: result.value }, socket.id)
    // the sender applied its value locally before sending; correct it if it was adjusted
    if (result.changed) socket.send('settingsModified', { key, value: result.value })
  }

  onSpawnModified = async (socket, op) => {
    if (this.stopping) return
    if (!this.requireBuilder(socket, 'modify spawn')) return
    const player = socket.player
    if (op === 'set') {
      const spawn = sanitizeSpawn(player.data)
      if (!spawn) {
        socket.send('chatAdded', {
          id: uuid(),
          from: null,
          fromId: null,
          body: 'Spawn not updated: invalid player transform',
          createdAt: moment().toISOString(),
        })
        return
      }
      this.spawn = spawn
    } else if (op === 'clear') {
      this.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
    } else {
      return
    }
    await this.saveConfig('spawn', this.spawn)
    socket.send('chatAdded', {
      id: uuid(),
      from: null,
      fromId: null,
      body: op === 'set' ? 'Spawn updated' : 'Spawn cleared',
      createdAt: moment().toISOString(),
    })
  }

  // these packets travel server -> client only (server scripts use sendTo directly); a client acts on
  // other players through server scripts, so a copy sent by a client is dropped
  onPlayerTeleport = socket => {
    this.dropRelay(socket, 'playerTeleport')
  }

  onPlayerPush = socket => {
    this.dropRelay(socket, 'playerPush')
  }

  onPlayerSessionAvatar = socket => {
    this.dropRelay(socket, 'playerSessionAvatar')
  }

  onAi = (socket, action) => {
    if (this.stopping) return
    if (!this.requireBuilder(socket, 'use ai')) return
    this.world.ai.onAction(action)
  }

  onPing = (socket, time) => {
    socket.send('pong', time)
  }

  onDisconnect = (socket, code) => {
    socket.disconnected = true
    this.dropTipTickets(socket)
    this.scheduler.purge(socket)
    this.world.apps.eventLedger.purgeSocket(socket.id)
    this.world.livekit.clearModifiers(socket.id)
    solanaGating.clearSocket(socket.id)
    if (!this.stopping) socket.player?.destroy(true)
    // only drop the entry that still refers to this socket
    if (this.sockets.get(socket.id) === socket) this.sockets.delete(socket.id)
  }
}
