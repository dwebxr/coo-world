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
import { createSolanaRpc } from '../../server/solanaRpc'
import { createTokenBalanceService } from '../../server/tokenBalance'
import { grantTokenRank, persistRank, revokeTokenRank } from '../../server/rankGrants'

const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL || '60') // seconds
const PING_RATE = 10 // seconds
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

  init({ db, tokenBalanceService }) {
    this.db = db
    this.tokenBalanceService = solanaGating.TOKEN_GATING_ENABLED
      ? (tokenBalanceService ?? createTokenBalanceService({ readRaw: createSolanaRpc().readRaw }))
      : null
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

  checkSockets() {
    this.world.apps.eventLedger.sweepExpired(Date.now())
    // see: https://www.npmjs.com/package/ws#how-to-detect-and-close-broken-connections
    const dead = []
    this.sockets.forEach(socket => {
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
    ws.once('close', () => (cancelled = true))
    let reserved = null
    let socket = null
    try {
      // check player limit
      const playerLimit = this.world.settings.playerLimit
      if (isNumber(playerLimit) && playerLimit > 0 && this.sockets.size >= playerLimit) {
        const packet = writePacket('kick', 'player_limit')
        this.write(ws, packet, { name: 'kick' })
        ws.close()
        return
      }

      // check connection params
      let authToken = params.authToken
      let name = sanitizeName(params.name)
      const avatar = isAvatarUrl(params.avatar) ? params.avatar : null

      // get or create user
      let user
      if (authToken) {
        const auth = await readJWT(authToken)
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

      // disconnect if user already in this world, or still connecting (the id is reserved before the next await)
      if (this.sockets.has(user.id) || this.connecting.has(user.id)) {
        const packet = writePacket('kick', 'duplicate_user')
        this.write(ws, packet, { name: 'kick' })
        ws.close()
        return
      }
      reserved = user.id
      this.connecting.add(user.id)

      // livekit options
      const livekit = await this.world.livekit.serialize(user.id)
      if (cancelled) return

      // create socket
      socket = new Socket({ id: user.id, ws, network: this })
      socket.wallet = solanaGating.createWalletSession()

      // spawn player
      socket.player = this.world.entities.add(
        {
          id: user.id,
          type: 'player',
          position: this.spawn.position.slice(),
          quaternion: this.spawn.quaternion.slice(),
          owner: socket.id, // deprecated, same as userId
          userId: user.id, // deprecated, same as userId
          name: name || user.name,
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
        try {
          await persistRank({
            db: this.db,
            player,
            rank,
            wallets: solanaGating,
            isCurrent: () => this.sockets.get(player.data.id)?.player === player,
          })
        } catch (err) {
          this.logOnce(
            socket,
            'user-rank-save',
            `error saving user rank for ${String(userId).slice(0, 64)}; the session keeps its previous grant state: ${briefError(err)}`
          )
        } finally {
          player.rankWritesPending--
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
    try {
      await persistRank({
        db: this.db,
        player,
        rank,
        wallets: solanaGating,
        isCurrent: () => this.sockets.get(player.data.id)?.player === player,
      })
    } catch (err) {
      this.logOnce(
        socket,
        'user-rank-save',
        `error saving user rank for ${String(playerId).slice(0, 64)}; the session keeps its previous grant state: ${briefError(err)}`
      )
    } finally {
      player.rankWritesPending--
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
    const challenge = solanaGating.buildChallenge(walletAddress, solanaGating.WALLET_HOST, now)
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
    if (!solanaGating.isWalletRequestId(attempt)) return
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
        body: 'ウォレット認証に失敗しました',
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
      body = `トークン認証成功! ビルダー権限が付与されました (${Number(result.balance).toLocaleString()} tokens)`
    } else if (result.known && result.balance < solanaGating.REQUIRED_TOKEN_AMOUNT) {
      if (!notifyInsufficient) return
      body = `ビルダー権限には ${solanaGating.REQUIRED_TOKEN_AMOUNT.toLocaleString()} トークンが必要です (現在: ${Number(result.balance).toLocaleString()})`
    } else {
      body = '残高を確認できませんでした。しばらくしてから更新ボタンを押してください'
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
        body: 'ウォレット切断: ビルダー権限が解除されました',
        createdAt: moment().toISOString(),
      })
    }
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
    this.scheduler.purge(socket)
    this.world.apps.eventLedger.purgeSocket(socket.id)
    this.world.livekit.clearModifiers(socket.id)
    solanaGating.clearSocket(socket.id)
    if (!this.stopping) socket.player?.destroy(true)
    // only drop the entry that still refers to this socket
    if (this.sockets.get(socket.id) === socket) this.sockets.delete(socket.id)
  }
}
