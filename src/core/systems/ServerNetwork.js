import moment from 'moment'
import { packetNameById, peekPacketId, writePacket } from '../packets'
import { Socket } from '../Socket'
import { uuid } from '../utils'
import { System } from './System'
import { createJWT, expiredSessionUser, readJWT } from '../utils-server'
import { isNumber } from 'lodash-es'
import { appPersistenceData, persistenceRecord } from '../extras/persistenceRecord.js'
import * as THREE from '../extras/three'
import { hasRank, Ranks } from '../extras/ranks'
import {
  PLAYER_NAME_MAX_LENGTH,
  SESSION_AVATAR_MAX_LENGTH,
  isAvatarUrl,
  isExternalUrl,
  isBoundedJsonObject,
  sanitizeAppModify,
  sanitizeAppRelease,
  sanitizeEntityAdd,
  sanitizeName,
  sanitizePlayerSelfModify,
  sanitizePersistedApp,
  sanitizeSpawn,
  sessionAvatarRequest,
} from '../extras/entityModifyPolicy'
import { createRelayDrop } from '../extras/playerRelayPolicy'
import { appChatLine, sanitizeChatMessage } from '../extras/chatPolicy'
import { isAdminCommand } from '../extras/chatCommand'
import { sanitizeBlueprintAdd, sanitizeBlueprintModify, WORLD_BLUEPRINT_BYTES } from '../extras/blueprintPolicy'
import { previewValue } from '../extras/assetURL'
import { isAdminOnlySettingKey, isKnownSettingKey, normalizeSettingValue } from '../extras/settingsPolicy'
import { internalEvents } from '../extras/internalEvents'
import { createInboundGate, createInboundScheduler, packetNodeLimit } from '../extras/inboundPolicy'
import { SNAPSHOT_CAP, createWriteLedger } from '../extras/writeLedger'
import {
  GROWTH_RESERVE_BYTES,
  OWN_AVATAR_MAX_LENGTH,
  RANKED_RESERVE_PLAYERS,
  SNAPSHOT_FIXED_BYTES,
  SNAPSHOT_STEP_NAMES,
  encodeSnapshot,
  envelopeBytes,
  fitsJoinState,
  joinStateBytes,
  joinStateReport,
  settingsBytes,
  visitorShortfall,
} from '../extras/joinBudget'
import { briefError, createLogOnce } from '../extras/logOnce'
import { readInboundPacket } from '../../server/inboundDecode'
import * as solanaGating from '../../server/solana-gating'
import * as evmGating from '../../server/evm-gating'
import { createEvmRpcs } from '../../server/evmRpc'
import { createEvmHoldingService, readHoldingContractsEnv } from '../../server/evmHoldings'
import { createTipWatcher } from '../../server/evmTipWatcher'
import { parseTipAmount, tipAmountReason } from '../extras/evmTokens'
import { formatUnits, isTxHash } from '../extras/evmAbi'
import { createSolanaRpc } from '../../server/solanaRpc'
import { createTokenBalanceService } from '../../server/tokenBalance'
import { grantTokenRank, persistRank, revokeTokenRank } from '../../server/rankGrants'
import { adminMode, adminWaitScale, createAdminGate } from '../../server/adminCode'
import { createKickList, readKickEnv } from '../../server/kickList'
import { createActionBudgets } from '../extras/actionBudget'
import { createPendingChanges } from '../extras/pendingChanges'
import { eventPayload } from '../extras/eventPayload.js'

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
    // every user id this world has issued (start-up read and new users): a new app id may not be one of them
    this.userIds = new Set()
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

  // maxUploadSize: PUBLIC_MAX_UPLOAD_SIZE as index.js parsed it (MB); the join snapshot carries the number
  init({ db, maxUploadSize, tokenBalanceService, evmHoldings, tipWatcher, evmSignatureVerifier }) {
    this.db = db
    this.maxUploadSize = maxUploadSize
    this.tokenBalanceService = solanaGating.TOKEN_GATING_ENABLED
      ? (tokenBalanceService ?? createTokenBalanceService({ readRaw: createSolanaRpc().readRaw }))
      : null
    const rpcs = evmGating.EVM_ENABLED ? createEvmRpcs() : new Map()
    // NFT 保有判定 (EVM_RPC_URL_<chainId> があるチェーンだけ)。スクリプトの player.getEvmHolding が使う。
    // It asks only about the contracts of EVM_HOLDING_CONTRACTS (evmHoldings.js; index.js has refused a bad value)
    this.evmHoldings = evmGating.EVM_ENABLED
      ? (evmHoldings ?? createEvmHoldingService({ rpcs, contracts: readHoldingContractsEnv(process.env) }))
      : null
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

  // World.start() does not wait for this. Until `ready` settles (spawn, blueprints, apps, settings, the user ids and
  // the join-state accounting all loaded) no connection or packet is taken (onConnection, admit); the server
  // listens only after it (index.js)
  start() {
    this.starting = true
    this.ready = this.hydrate().finally(() => {
      this.starting = false
    })
    return this.ready
  }

  async hydrate() {
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
        // persisted: a stored model/script is kept whatever it holds; the loader decides what it reads (below)
        const result = sanitizeBlueprintAdd(JSON.parse(blueprint.data), { persisted: true })
        if (!result.ok || result.value.id !== blueprint.id) throw new Error('invalid blueprint')
        this.world.blueprints.add(result.value)
      } catch {
        skippedBlueprints.push(blueprint.id)
      }
    }
    // a stored model/script the loader now refuses (a local path, asset:// traversal, another scheme) is reported
    // once per blueprint and left as it is: the app shows the crash block on the server until a builder replaces it.
    // (only test worlds lack the loader)
    if (typeof this.world.loader?.refusedSources === 'function') {
      for (const item of this.world.blueprints.items.values()) {
        const refused = this.world.loader.refusedSources(item)
        if (!refused.length) continue
        const id = previewValue(item.id, 16)
        console.warn(`[network] blueprint ${id} keeps a source the server no longer loads; ${refused.join('; ')}`)
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
    // Before the stored settings are read: a settings row that cannot be parsed left this unset, and unset means
    // "no code, so everyone is admin" (Settings.effectiveRank), with a code configured.
    this.world.settings.setHasAdminCode(this.admin().mode !== 'open')
    try {
      const settings = JSON.parse(settingsRow?.value || '{}')
      this.world.settings.deserialize(settings)
      this.loadedConfig.set('settings', JSON.stringify(this.world.settings.serialize()))
    } catch (err) {
      console.error(err)
    }
    // the user ids, so that no new app takes one: an app holding the id of a user who is away would otherwise make
    // that user's next join collide with it (ids only, about 60 bytes each in memory)
    try {
      for (const row of await this.db('users').select('id')) this.userIds.add(row.id)
    } catch (err) {
      console.error(
        `[network] user ids could not be read (${briefError(err)}); an app that takes one is moved to a new id when that user joins`
      )
    }
    // the join snapshot's world state (joinBudget.js): a world stored over the budget loads whole, is reported,
    // and only shrinks from here. Collections are the operator's files and do not change while the server runs
    this.settingsBytes = settingsBytes(this.world.settings.serialize())
    this.collectionsBytes = settingsBytes(this.world.collections?.serialize() ?? [])
    const joinReport = joinStateReport(this.world, { snapshotCap: SNAPSHOT_CAP })
    if (joinReport) console.warn(joinReport)
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
    // world settings held over the settings budget (onSettingsModified), after this tick's packets (a value held
    // that one of them replaced is not applied first), the connection whose oldest value came first first
    if (this.heldSettings?.size) {
      const now = performance.now()
      const oldest = mine => mine.values().next().value?.seq ?? Infinity
      const order = [...this.heldSettings].sort((a, b) => oldest(a[1]) - oldest(b[1])).map(([socket]) => socket)
      for (const socket of order) this.releaseSettings(socket, now)
    }
  }

  asScript(fn, source, name) {
    return this.writer.asScript(fn, source, name)
  }

  write(ws, packet, options = {}) {
    const name = packet === null ? 'ping' : packetNameById(peekPacketId(packet)) || 'packet'
    return this.writer.write(ws, packet, { name, ...options })
  }

  // Sends a packet to every socket but ignoreSocketId and says what became of it. 'refused': it was not admitted (over
  // the size cap, or a script's while this tick's budget for script writes is used up), and nobody got it.
  // 'partial': it was admitted and one or more recipients did not get it (a socket at its backlog limit, or closing),
  // while the others did. 'delivered': every recipient got it. A caller that changes state along with the packet
  // tells the first apart from the others: only a refused packet left every client as it was.
  // `skippable`: a packet a recipient can do without (writeLedger.js): left out for a connection whose backlog is
  // high, which then counts as not delivered
  broadcast(name, data, ignoreSocketId, { skippable = false } = {}) {
    // a player that is removed takes along what was pending for it (flushPending): no change of a player is told
    // after its removal
    if (name === 'entityRemoved') this.pending?.drop(data)
    const packet = this.writer.prepare(writePacket(name, data), { name })
    if (packet === false) return 'refused'
    // What the server itself tells everyone about a player (a script's effect or session avatar, health, a name,
    // a rank, urls a former builder may not show) is later than what that player's client sent before in this
    // tick: those fields are taken out of what is pending for the player, which would otherwise go out after this
    // packet and set the others back to the older value. Only for a packet that was admitted: one refused reached
    // nobody. A recipient this packet does not reach (a script's write is left out for a connection whose backlog
    // is high) misses the client's value too, and stays on an older one.
    if (name === 'entityModified') this.pending?.supersede(data?.id, data)
    let delivered = true
    this.sockets.forEach(socket => {
      if (socket.id === ignoreSocketId) return
      if (!this.write(socket.ws, packet, { name, prepared: true, skippable })) delivered = false
    })
    return delivered ? 'delivered' : 'partial'
  }

  // true when every recipient got the packet (broadcast)
  send(name, data, ignoreSocketId, options) {
    return this.broadcast(name, data, ignoreSocketId, options) === 'delivered'
  }

  sendTo(socketId, name, data) {
    const socket = this.sockets.get(socketId)
    return socket ? socket.send(name, data) : false
  }

  // The places taken, for the player limit: one per user who is registered or has a join being set up (`joining`:
  // user id -> how many of that user's joins hold its place), each id once, and one for every join being set up
  // whose user is not known (`arriving`). See onConnection.
  playersPresent() {
    let count = this.sockets.size + (this.arriving ?? 0)
    for (const id of this.joining?.keys() ?? []) if (!this.sockets.has(id)) count++
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
    if (this.stopping || this.starting) return false
    const entry = this.gate.admit(socket, packet, { builder: socket.player?.isBuilder() === true })
    // when it arrived, for the budgets of what it sets off (spend): a packet may wait in the inbox for its turn,
    // and those that waited together did not arrive together
    if (entry) entry.at = performance.now()
    return entry
  }

  // One action of a connection against its budget for that kind (actionBudget.js), asked once the action is known
  // to be one the server would carry out. Over it, the action is not carried out now (the handler says what becomes
  // of it): said in the log once per connection and kind, and, where a person can get there by hand, to the sender
  // once per wait (`told`, a line of their own chat).
  // -> whether the action is within the budget
  spend(socket, action, meta, told) {
    const budgets = (this.actionBudgets ??= createActionBudgets())
    const result = budgets.spend(socket, action, meta?.at ?? performance.now(), !!told)
    if (result.ok) return true
    this.logOnce(
      socket,
      `budget:${action}`,
      `[network] ${previewValue(socket.id, 64)} is over its ${action} budget: dropped (further ones from this connection are not logged)`
    )
    if (result.tell && told) {
      socket.send('chatAdded', {
        id: uuid(),
        kind: 'system',
        from: null,
        fromId: null,
        body: told,
        createdAt: moment().toISOString(),
      })
    }
    return false
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

  // The scheduler releases inbox credit before decoding and bounds each tick's work. What the players' own clients
  // changed on their players in this tick is told to the others when it ends (flushPending), whatever happened in it.
  flush() {
    try {
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
          this.logOnce(
            socket,
            `${name}:handler`,
            `[network] ${name} from client ${socket.id} failed: ${briefError(err)}`
          )
        }
        try {
          const meta = { bytes, nodes, socketId: socket.id, builder, at: entry.at }
          const result = this[method]?.(socket, data, meta)
          // async handlers reject later; keep those failures contained too
          if (typeof result?.then === 'function') result.then(undefined, failed)
        } catch (err) {
          failed(err)
        }
      })
    } finally {
      this.flushPending()
    }
  }

  // What the handlers of this flush kept for its end (onEntityModified, a player's own change): for each player, one
  // packet with the latest value of every field its client changed in this tick, to every connection but its own.
  // So one connection has at most one own-player packet written to each other connection per tick, however many it
  // sent; the server applied each as it came, and the values in between are not told. Every entry is taken before
  // any is sent, so nothing stays for a later tick, also when a write throws. When the server is stopping they are
  // let go unsent: its connections are being closed.
  flushPending() {
    if (!this.pending?.size) return
    const changes = this.pending.takeAll()
    if (this.stopping) return
    // (a player's id is its connection's)
    for (const change of changes) this.send('entityModified', change, change.id)
  }

  getTime() {
    return performance.now() / 1000 // seconds
  }

  requireBuilder(socket, action) {
    if (socket.player.isBuilder()) return true
    this.logOnce(
      socket,
      `builder:${action}`,
      `player attempted to ${action} without builder permission: ${previewValue(socket.id, 64)}`
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
    this.dirtyApps.set(settled.id, { ...this.replacementOf(settled.id), revision: ++this.persistenceRevision, record })
  }

  markAppDeleted(id) {
    this.dirtyApps.set(id, { ...this.replacementOf(id), revision: ++this.persistenceRevision, record: null })
  }

  // a later change to a re-keyed app (rekeyApp) keeps the old row's removal with it until it is written
  replacementOf(id) {
    const replaces = this.dirtyApps.get(id)?.replaces
    return replaces === undefined ? {} : { replaces }
  }

  // An app that holds a joining user's id moves to a fresh id, with its blueprint, transform, pinned flag and state
  // (when it is plain bounded JSON; anything else a script put there, a throwing getter or a Proxy included, becomes
  // {}). Its script starts again; a move or upload in progress is dropped. Broadcast as a removal and an addition.
  // One migration that cannot lose the app: the record under the new id is queued first, as a row that replaces
  // the old one (saveDirty writes both in one transaction where the database has them, the new row before the old
  // one's removal otherwise), and only then is the old entity torn down, whose failure does not stop the move. An
  // interruption at any point leaves the record under the old id, the new one, or (without a transaction) both;
  // a duplicate left that way is moved again at that user's next join.
  rekeyApp(entity) {
    const old = entity.data
    let id
    do id = uuid()
    while (this.world.entities.get(id) || this.userIds.has(id))
    let state = {}
    try {
      if (isBoundedJsonObject(old.state)) state = JSON.parse(JSON.stringify(old.state))
    } catch {
      // script state that cannot be read as JSON never stops the move or the join
    }
    const data = {
      id,
      type: 'app',
      blueprint: old.blueprint,
      position: [...old.position],
      quaternion: [...old.quaternion],
      scale: [...old.scale],
      mover: null,
      uploader: null,
      pinned: old.pinned === true,
      state,
    }
    // the replacement first; a pending change under the old id is folded into it
    this.dirtyApps.delete(old.id)
    this.dirtyApps.set(id, {
      revision: ++this.persistenceRevision,
      record: persistenceRecord(appPersistenceData(data)),
      replaces: old.id,
    })
    try {
      this.world.entities.remove(old.id)
    } catch (err) {
      this.logOnce(
        this,
        `rekey-teardown:${old.id}`,
        `[network] app teardown failed while moving it: ${briefError(err)}`
      )
      // the entity is gone from the world all the same
      this.world.entities.items.delete(old.id)
      this.world.entities.untrackApp?.(old.id)
    }
    // the old row is removed by the replacement's own write, never on its own before it
    this.dirtyApps.delete(old.id)
    this.send('entityRemoved', old.id)
    this.send('entityAdded', data)
    try {
      this.world.entities.add(data)
    } catch (err) {
      // the record is queued: the app comes back at the next start
      this.logOnce(this, `rekey-add:${id}`, `[network] app could not be started under its new id: ${briefError(err)}`)
    }
    this.logOnce(
      this,
      `rekey:${old.id}`,
      `[network] app ${previewValue(old.id, 16)} held the id of a joining user and now has id ${previewValue(id, 16)}`
    )
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

  // past the final save's deadline (flushBeforeExit): no further row is started
  saveExpired() {
    if (!this.flushExpired && this.flushDeadline && Date.now() >= this.flushDeadline) this.flushExpired = true
    return this.flushExpired
  }

  // Each row is its own write, as before: a row that fails stays dirty and the others are still saved. They are
  // not grouped in transactions, because on Postgres one failing statement aborts the whole transaction (the rows
  // after it would fail with it). better-sqlite3 runs each statement synchronously and knex settles it in a
  // microtask, so the loop yields a turn of the event loop after every row: the deadline timer, other timers and a
  // second signal run between rows, and the deadline is also checked by the clock before each one. On Postgres the
  // queries are asynchronous anyway; a statement already sent finishes or is cut off by the exit.
  // The one exception is a row that replaces another (rekeyApp): its insert and the old row's removal are one
  // transaction where the database has them, and otherwise the insert comes first, so the app is never lost.
  // The server's database is always knex (db.js, SQLite or Postgres), which has transactions: the path without one
  // is for stand-in databases only (tests). An interrupted re-key there can leave the app under both ids, and
  // nothing at start-up merges the two.
  async saveDirty() {
    const counts = { blueprints: 0, apps: 0, deleted: 0 }
    const now = moment().toISOString()
    for (const [table, dirty] of [
      ['blueprints', this.dirtyBlueprints],
      ['entities', this.dirtyApps],
    ]) {
      for (const [id, { revision, record, replaces }] of [...dirty]) {
        if (this.saveExpired()) return
        await new Promise(resolve => setImmediate(resolve))
        if (this.saveExpired()) return
        try {
          const upsert = db =>
            db(table)
              .insert({ ...record, createdAt: now, updatedAt: now })
              .onConflict('id')
              .merge({ ...record, updatedAt: now })
          if (record === null) {
            await this.db(table).where('id', id).delete()
            if (replaces !== undefined) await this.db(table).where('id', replaces).delete()
            counts.deleted++
          } else if (replaces !== undefined && typeof this.db.transaction === 'function') {
            await this.db.transaction(async trx => {
              await upsert(trx)
              await trx(table).where('id', replaces).delete()
            })
            counts.apps++
          } else {
            await upsert(this.db)
            if (replaces !== undefined) await this.db(table).where('id', replaces).delete()
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
    this.flushDeadline = Date.now() + deadlineMs
    const config = new Set()
    for (const [key, saved] of this.loadedConfig) {
      const data = key === 'settings' ? this.world.settings.serialize() : this.spawn
      if (this.dirtyConfig.has(key) || JSON.stringify(data) !== saved) config.add(key)
    }
    // the script storage file (world.set) is written by its own queue, alongside the database writes. Its flush
    // refuses every later world.set, and it counts as saved only if, at the very end, nothing it accepted is unwritten
    const storage = typeof this.world.storage?.flush === 'function' ? this.world.storage : null
    let storageSaved = !storage
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
    const flushStorage = async () => {
      if (storage) await storage.flush()
    }
    const incomplete = () => {
      if (storage) storageSaved = storage.saved()
      return this.dirtyBlueprints.size || this.dirtyApps.size || config.size || !storageSaved
    }
    try {
      await Promise.race([
        Promise.all([flush(), flushStorage()]),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            this.flushExpired = true
            reject(new Error('save deadline exceeded'))
          }, deadlineMs)
        }),
      ])
      if (incomplete()) {
        throw new Error('final save incomplete')
      }
      console.log('[network] final save complete')
    } finally {
      clearTimeout(timer)
      if (incomplete()) {
        console.error(
          `[network] not persisted: blueprints=${JSON.stringify([...this.dirtyBlueprints.keys()])} apps=${JSON.stringify([...this.dirtyApps.keys()])} config=${JSON.stringify([...config])} storage=${storageSaved ? 'saved' : 'unsaved'}`
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
    // past the final save's deadline (saveExpired)
    const expired = () => this.flushExpired || Date.now() >= (this.flushDeadline ?? Infinity)
    const promise = (this.configPromise || Promise.resolve())
      .then(async () => {
        if (expired()) return false
        // a turn of the event loop between queued writes, as in saveDirty: a synchronous database would otherwise
        // run the whole queue before a timer or a signal is seen
        await new Promise(resolve => setImmediate(resolve))
        if (expired()) return false
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

  // A joining player's record, as the join snapshot carries it and the player is added with (onConnection). Its
  // own avatar is the one part of it no step drops: a stored value longer than the policy allows (only legacy data
  // can be) falls back to the default.
  joinRecord(id, { name, avatar, sessionAvatar, rank }) {
    return {
      id,
      type: 'player',
      position: this.spawn.position.slice(),
      quaternion: this.spawn.quaternion.slice(),
      owner: id, // deprecated, same as userId
      userId: id, // deprecated, same as userId
      name,
      health: HEALTH_MAX,
      avatar: typeof avatar === 'string' && avatar.length <= OWN_AVATAR_MAX_LENGTH ? avatar : 'asset://avatar.vrm',
      sessionAvatar: sessionAvatar || null,
      rank,
      enteredAt: Date.now(),
    }
  }

  // the avatar of a player without one of their own, or with one they may not show: the world's, else the built-in one
  defaultAvatar() {
    return this.world.settings.avatar?.url || 'asset://avatar.vrm'
  }

  // What a player may show only as a builder goes when they stop being one, whichever way that happens (an admin
  // lowers their rank, `/admin` again, their token grant ends, the world's rank setting is lowered): a session
  // avatar or an emote outside this world (entityModifyPolicy.js isExternalUrl), unless a server script chose it for
  // this player, and a stored avatar outside this world, which shows as the world's default from here on, as it
  // does at a join (the database keeps it). Everyone, the player included, is told in an entityModified packet, as
  // of any other change to the player. A player who is still a builder keeps everything.
  dropBuilderUrls(player) {
    if (!player?.isPlayer || player.destroyed || player.isBuilder()) return
    const assetsUrl = process.env.ASSETS_BASE_URL
    const { sessionAvatar, emote, avatar } = player.data
    const change = {}
    if (isExternalUrl(sessionAvatar, assetsUrl) && sessionAvatar !== player.scriptAvatar) change.sessionAvatar = null
    if (isExternalUrl(emote, assetsUrl) && player.scriptEmotes?.has(emote) !== true) change.e = null
    if (isExternalUrl(avatar, assetsUrl)) change.avatar = this.defaultAvatar()
    if (!Object.keys(change).length) return
    player.modify(change)
    this.send('entityModified', { id: player.data.id, ...change })
  }

  // The join snapshot. Every value from the environment is the one the server uses: the upload size as the number
  // index.js parsed, the URLs and AI names as given (index.js limits their length).
  snapshotState(id, { livekit, authToken, entities }) {
    return {
      id,
      serverTime: performance.now(),
      assetsUrl: process.env.ASSETS_BASE_URL,
      apiUrl: process.env.PUBLIC_API_URL,
      maxUploadSize: this.maxUploadSize,
      collections: this.world.collections.serialize(),
      settings: this.world.settings.serialize(),
      chat: this.world.chat.serialize(),
      ai: this.world.ai.serialize(),
      blueprints: this.world.blueprints.serialize(),
      entities,
      livekit,
      authToken,
      hasAdminCode: this.admin().mode !== 'open',
    }
  }

  // The fixed part of a join snapshot at its largest for this configuration (joinBudget.js), measured once before
  // anyone can join (index.js): the envelope of a joiner with a 64-character id, the longest name and avatars the
  // rules allow and float transforms, with its real session and voice tokens (a voice token grows with
  // LIVEKIT_API_KEY). World growth counts it, and so does each visitor's join when it is larger than their own.
  async measureFixedBytes() {
    const id = 'i'.repeat(64)
    const wide = n => '€'.repeat(n) // a 3-byte character: the most a UTF-16 unit costs in UTF-8
    const record = {
      ...this.joinRecord(id, {
        name: wide(PLAYER_NAME_MAX_LENGTH),
        avatar: wide(OWN_AVATAR_MAX_LENGTH),
        sessionAvatar: wide(SESSION_AVATAR_MAX_LENGTH),
        rank: Ranks.ADMIN,
      }),
      position: [0.5, 0.5, 0.5],
      quaternion: [0.5, 0.5, 0.5, 0.5],
      emote: null,
    }
    const livekit = await this.world.livekit.serialize(id)
    const authToken = await createJWT({ userId: id })
    this.fixedBytes = envelopeBytes(this.snapshotState(id, { livekit, authToken, entities: [record] }), id)
    if (this.fixedBytes > SNAPSHOT_FIXED_BYTES) {
      console.warn(
        `[network] the join snapshot's fixed part measures ${this.fixedBytes} bytes, more than the ${SNAPSHOT_FIXED_BYTES} expected (a long LIVEKIT_API_KEY, LIVEKIT_WS_URL or other URL?); world growth and visitors are held to the measured size`
      )
    }
    return this.fixedBytes
  }

  // The world's admin mode and the brake on `/admin` codes (adminCode.js), made from the environment on first use:
  // `open` (everyone is admin), `code`, or `locked` (nobody becomes admin by a code; clients are told there is one,
  // so nobody is admin by default either).
  admin() {
    if (!this.adminState) {
      const mode = adminMode(process.env)
      this.adminState = {
        mode,
        gate: createAdminGate({
          code: mode === 'code' ? process.env.ADMIN_CODE : '',
          waitScale: adminWaitScale(process.env),
        }),
      }
    }
    return this.adminState
  }

  // who a kick keeps out for a while (kickList.js), made from the environment on first use
  kicks() {
    return (this.kickList ??= createKickList(readKickEnv(process.env)))
  }

  // `origin`: the connection's address key and its wider networks (clientIpKeys), for the brake on admin codes and
  // for a kick that holds new users at its address
  async onConnection(ws, params, origin) {
    // still loading (start): the user ids and the join-state accounting are not complete yet
    if (this.stopping || this.starting) return ws.close()
    let cancelled = false
    // a wait that ends early when this connection closes (the takeover ping)
    let stopWaiting = null
    // What the join holds while it is set up:
    // - `place`, its place under the player limit (playersPresent): `{ user: id }` when its session token names a
    //   user, whose one place it shares with that user's other connections (registered, being replaced, or joining
    //   too), or `{ user: null }`, a place of its own. A join is counted as a socket only once registered, after waits
    //   on the database and the voice token: without a place held meanwhile, joins arriving together all found room.
    // - `reserved`, its user id against a second join of the same user (`connecting`).
    let place = null
    let reserved = null
    const releasePlace = () => {
      if (!place) return
      const id = place.user
      place = null
      if (id === null) this.arriving--
      else if (this.joining.get(id) > 1) this.joining.set(id, this.joining.get(id) - 1)
      else this.joining.delete(id)
    }
    // Takes the place of user `id` (null: a place of its own), giving back the one held before. A user who has a
    // place already shares it, whatever the limit; otherwise the limit is asked here, with no wait between the
    // question and the taking. The limit is asked only when a place is taken: a limit lowered while joins are being
    // set up does not turn away those that hold one.
    const takePlace = id => {
      releasePlace()
      const shared = id !== null && (this.sockets.has(id) || !!this.joining?.has(id))
      const limit = this.world.settings.playerLimit
      if (!shared && isNumber(limit) && limit > 0 && this.playersPresent() >= limit) return false
      if (id === null) this.arriving = (this.arriving ?? 0) + 1
      else (this.joining ??= new Map()).set(id, (this.joining.get(id) ?? 0) + 1)
      place = { user: id }
      return true
    }
    // Run when the join ends (the finally below: registered, refused or failed) and when its connection closes, which
    // can come while a wait (the database, the voice token) has not settled, or never will: the first gives back what
    // the join holds and the second finds nothing. Nothing is taken after a close: the join checks `cancelled` after
    // every wait before it takes anything.
    const release = () => {
      releasePlace()
      if (reserved) this.connecting.delete(reserved)
      reserved = null
    }
    ws.once('close', () => {
      cancelled = true
      stopWaiting?.()
      release()
    })
    let carriedRankWrites = []
    let socket = null
    try {
      let authToken = params.authToken
      // The session token says whose join this is, so it is read before a place is taken: a player who is here and
      // connects again (a reload) shares the place they have. Reading it is local work (its signature), no wait on
      // the database or the network.
      const auth = authToken ? await readJWT(authToken) : null
      if (cancelled) return
      const refuseFull = () => {
        this.write(ws, writePacket('kick', 'player_limit'), { name: 'kick' })
        ws.close()
      }
      if (!takePlace(auth?.userId ?? null)) return refuseFull()

      // A kicked user waits (kickList.js): told so and closed, with nothing added or announced. Asked where the
      // user is first known, and once more after the join's last wait (below)
      const refuseKicked = () => {
        this.write(ws, writePacket('kick', 'kicked'), { name: 'kick' })
        ws.close()
      }

      // check connection params
      let name = sanitizeName(params.name)
      // the avatar a connection asks for becomes its session avatar; whether a url outside this world is taken is
      // decided below, once the user and their rank are known
      const askedAvatar = isAvatarUrl(params.avatar) ? params.avatar : null

      // get or create user
      let user
      if (auth) {
        user = await this.db('users').where('id', auth.userId).first()
        if (user) this.userIds.add(user.id)
        if (cancelled) return
        // A token due for renewal (older than a day, without an end, or signed with the previous secret:
        // utils-server.js) is replaced; the snapshot carries the new one and the client keeps what it carries.
        if (user && auth.renew) {
          authToken = await createJWT({ userId: user.id })
          if (cancelled) return
        }
      } else if (authToken) {
        // A genuine token past its end: its user starts again as a new visitor, below. When that user had a rank
        // it is gone with the session, and only the operator can give it back: said in the log.
        const lapsed = await expiredSessionUser(authToken)
        if (cancelled) return
        if (lapsed) {
          const row = await this.db('users').where('id', lapsed).first()
          if (cancelled) return
          if (row?.rank > 0) {
            // once per user for as long as the server runs: the same expired token can be presented again and
            // again, and only tokens that were really signed here get this far, so the keys are no more than the
            // ranked users
            this.logOnce(
              this,
              `session-ended:${lapsed}`,
              `[auth] the session of a ranked user ended unused: ${previewValue(lapsed, 64)} (rank ${row.rank}); they join as a new visitor`
            )
          }
        }
      }
      // A token whose user row is gone makes a new user (below), not the one the token names: the place held so far is
      // that user's, and the new one needs a place of its own (the limit is asked again)
      if (place.user !== (user?.id ?? null) && !takePlace(user?.id ?? null)) return refuseFull()
      if (!user) {
        // no valid session token: a new user. Where an admin's kick holds new users at this address, it waits
        // before a row is made for it
        if (this.kicks().refusesNewcomer(origin?.key)) return refuseKicked()
        user = {
          id: uuid(),
          name: 'Anonymous',
          avatar: null,
          rank: 0,
          createdAt: moment().toISOString(),
        }
        // reserved before the row exists, so a join cancelled from here on still keeps the id from apps
        this.userIds.add(user.id)
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
      if (this.kicks().refusesUser(user.id)) return refuseKicked()
      // disconnect if user still connecting elsewhere (the id is reserved before the next await)
      if (this.connecting.has(user.id)) return refuseDuplicate()
      reserved = user.id
      this.connecting.add(user.id)
      // Already in this world: refused while the old connection is alive (another window or device). A stale one
      // gives way: a phone that switched to a wallet app often comes back as a reload while its old socket still
      // looks open here (iOS suspends or discards the tab without closing it), and the regular ping check takes
      // up to 2 x PING_RATE to notice.
      // (The place of a player being replaced is the one this join holds, its token having named that user: nobody
      // else takes it while the old connection is closed and this one is set up.)
      const existing = this.sockets.get(user.id)
      if (existing) {
        const alive = await this.answersPing(existing, undefined, stop => (stopWaiting = stop))
        stopWaiting = null
        if (cancelled) return
        if (alive && this.sockets.get(user.id) === existing) return refuseDuplicate()
        const oldPlayer = existing.player
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

      // a kick that landed on this user's old connection while this one waited above (the takeover, the database)
      if (this.kicks().refusesUser(user.id)) return refuseKicked()

      // an app holding this user's id (stored before new app ids were kept apart from user ids): it moves to a new
      // id and the player joins. Nothing awaits between here and the player's add
      const holder = this.world.entities.get(user.id)
      if (holder?.isApp) this.rekeyApp(holder)

      // The joiner's record and the snapshot are made before the player is added (nothing awaits from here on), so
      // a refused join leaves nothing behind. The snapshot carries the record as the player will hold it once added
      // (PlayerRemote sets a missing emote to null).
      // A url outside this world, as the avatar a connection asks for or as the one stored with the user: only for a
      // builder (the stored rank or the world's own: a token's grant comes after the join). Anyone else gets the
      // world's avatar; the stored value is left as it is, for the day the user is a builder. isExternalUrl reads a
      // value as the loaders will, so a stored value of any spelling (written before these rules, or by hand) is
      // kept for a visitor only when what every client would load is a file of the world's store. (The asked avatar
      // has passed isAvatarUrl, which takes only the asset form and a literal http(s) url.)
      const mayUseExternal = hasRank(Math.max(user.rank, this.world.settings.effectiveRank), Ranks.BUILDER)
      const taken = url => (mayUseExternal || !isExternalUrl(url, process.env.ASSETS_BASE_URL) ? url : null)
      if (askedAvatar && !taken(askedAvatar)) {
        this.logOnce(ws, 'avatar-refused', 'a connection asked for an avatar outside this world without builder rank')
      }
      const record = this.joinRecord(user.id, {
        name: name || sanitizeName(user.name) || 'Anonymous',
        avatar: taken(user.avatar) || this.defaultAvatar(),
        sessionAvatar: taken(askedAvatar),
        rank: user.rank,
      })
      const state = this.snapshotState(user.id, {
        livekit,
        authToken,
        entities: [...this.world.entities.serialize(), { ...record, emote: null }],
      })
      const refuseJoin = (reason, detail) => {
        this.logOnce(this, `join-refused:${reason}`, `[network] ${detail}`)
        this.write(ws, writePacket('kick', 'player_limit'), { name: 'kick' })
        ws.close()
      }
      // A visitor (no rank of builder or above stored on the user) joins only while the bound leaves room for
      // ranked users and growth after them (joinBudget.js visitorShortfall), so a crowd of visitors cannot keep an
      // admin out or stop building. A user with a stored rank skips this: an admin can always come into a world that
      // is over its budget or crowded, to shrink or moderate it, and only the snapshot's real size counts for them.
      if (!(user.rank >= Ranks.BUILDER)) {
        const envelope = envelopeBytes(state, user.id)
        const shortfall = visitorShortfall(this.world, envelope)
        if (shortfall === 'world') {
          return refuseJoin(
            shortfall,
            `a visitor was turned away: the world's state (${joinStateBytes(this.world)} bytes counted) and the snapshot's fixed part (${Math.max(envelope, this.fixedBytes ?? SNAPSHOT_FIXED_BYTES)} bytes) leave the join snapshot no room for visitors; users with a stored rank of builder or above can still join, and visitors can again once the world is smaller`
          )
        }
        if (shortfall) {
          return refuseJoin(
            shortfall,
            `a visitor was turned away: with ${this.world.entities.players?.size ?? 0} players here, the join snapshot keeps its last room for ${RANKED_RESERVE_PLAYERS} users with a stored rank of builder or above and ${GROWTH_RESERVE_BYTES / 1024} KiB of world growth; the world's size, not playerLimit or WS_MAX_SOCKETS, is the limit here`
          )
        }
      }
      // the one hard condition, for everyone: the real snapshot, after the steps it needs (what no budget tracks is
      // dropped step by step until it fits, joinBudget.js encodeSnapshot), fits its cap
      const { packet: snapshot, steps } = encodeSnapshot(state, { selfId: user.id })
      if (!snapshot || snapshot.length > SNAPSHOT_CAP) {
        return refuseJoin(
          'snapshot',
          `a player was turned away: the join snapshot is ${snapshot ? `${snapshot.length} bytes` : 'not encodable'} after every step, over its cap (${SNAPSHOT_CAP}); joins fit again once the world's state, or the number of players here, is smaller`
        )
      }

      // create socket
      socket = new Socket({ id: user.id, ws, network: this })
      socket.addressKey = origin?.key
      socket.addressParents = origin?.parents
      socket.wallet = solanaGating.createWalletSession()
      socket.evmWallet = evmGating.createEvmWalletSession()

      // spawn player
      socket.player = this.world.entities.add(record, true)

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

      // send the snapshot made above
      if (steps.length) {
        this.logOnce(
          this,
          `snapshot-steps:${steps.join(',')}`,
          `[network] the join snapshot did not fit its cap (${SNAPSHOT_CAP}); sent without ${steps.map(step => SNAPSHOT_STEP_NAMES[step]).join(', ')}: ${snapshot.length} bytes`
        )
      }
      if (!this.write(ws, snapshot, { name: 'snapshot', snapshot: true })) throw new Error('snapshot write failed')

      this.sockets.set(socket.id, socket)

      // A muted player who comes back is said to be muted again: a join snapshot made under pressure leaves the
      // mutes of absent players out (joinBudget.js), so someone who joined meanwhile may not have this one
      if (this.world.livekit.muted?.has(user.id)) this.send('mute', { playerId: user.id, muted: true })

      // enter events on the server are sent after the snapshot.
      // on the client these are sent during PlayerRemote.js entity instantiation!
      this.world.events.emit('enter', eventPayload({ playerId: socket.player.data.id }))
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
      // registered (counted as a socket from here on) or not, the join gives back what it held
      release()
    }
  }

  onChatAdded = async (socket, msg, meta) => {
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
    // A line of chat is written to every connection: a line a second, with a few at once (actionBudget.js). What
    // is not a line was dropped above and is not counted. The sender's own client has shown the line already, so
    // it is told that some did not go out.
    if (!this.spend(socket, 'chat', meta, 'You are sending messages too fast. Some were not sent.')) return
    const message = {
      id: uuid(),
      kind: 'player',
      from: socket.player.data.name,
      fromId: socket.player.data.id,
      body: safe.body,
      createdAt: moment().toISOString(),
    }
    this.world.chat.add(message, false)
    // a recipient that lags misses the line rather than being closed for its backlog (writeLedger.js skippable)
    this.send('chatAdded', message, socket.id, { skippable: true })
  }

  // a client script's broadcast world.chat(): relayed as that app's line. Only the text and a display name come
  // from the packet (through the script chat rules); the kind, the missing player id and the app's name (from the
  // server's blueprint) are the server's. Any visitor may send it, since client scripts run in visitors' browsers
  onAppChat = async (socket, data, meta) => {
    if (!isObject(data) || Array.isArray(data) || typeof data.id !== 'string') {
      return this.logOnce(
        socket,
        'appChat-invalid',
        `onAppChat: invalid message from ${socket.id} (further ones are not logged)`
      )
    }
    const entity = this.world.entities.get(data.id)
    if (!entity?.isApp) {
      return this.logOnce(
        socket,
        'appChat-app',
        `onAppChat: no such app from ${socket.id} (further ones are not logged)`
      )
    }
    const line = appChatLine(data.body, data.from, entity.blueprint?.name)
    if (!line) {
      return this.logOnce(
        socket,
        'appChat-invalid',
        `onAppChat: invalid message from ${socket.id} (further ones are not logged)`
      )
    }
    // a client script speaking through the player's connection: a budget of its own, and nothing said to a player
    // who typed nothing
    if (!this.spend(socket, 'appChat', meta)) return
    const message = { id: uuid(), ...line, createdAt: moment().toISOString() }
    this.world.chat.add(message, false)
    this.send('chatAdded', message, socket.id, { skippable: true })
  }

  onCommand = async (socket, data, meta) => {
    if (!isObject(data) || !Array.isArray(data.args)) return
    const { args } = data
    // handle slash commands
    const player = socket.player
    const playerId = player.data.id
    const [cmd, arg1, arg2] = args
    // The admin command (chatCommand.js, as the client decides it): it is never handed on as a command event (the
    // code is in it). A wrong code is answered and, past a few, slowed down (adminCode.js); this socket's line only,
    // never a broadcast.
    const adminCommand = isAdminCommand(args)
    // A command is a line a person types: two a second, with a few at once (actionBudget.js). The admin command is
    // not counted here: its attempts have a brake of their own (adminCode.js), which must see every one of them.
    if (!adminCommand && !this.spend(socket, 'command', meta, 'You are sending commands too fast.')) return
    if (adminCommand) {
      const attempt = this.admin().gate.attempt(
        { socket, user: player.data.userId, address: socket.addressKey, parents: socket.addressParents },
        arg1
      )
      if (!attempt.ok && attempt.tell) {
        socket.send('chatAdded', {
          id: uuid(),
          kind: 'system',
          from: null,
          fromId: null,
          body: attempt.reason === 'wrong' ? 'Wrong admin code.' : 'Too many attempts. Try again later.',
          createdAt: moment().toISOString(),
        })
      }
      if (attempt.reason === 'closed') {
        socket.send('kick', 'admin_attempts')
        socket.disconnect()
        return
      }
      // The right code clears its own brake, so a holder could turn admin on and off without end: each turn is a
      // rank written to everyone and to the database, and is counted with the other changes of rank.
      if (attempt.ok && !this.spend(socket, 'moderation', meta, 'You are changing ranks too fast.')) return
      if (attempt.ok) {
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
        this.dropBuilderUrls(player)
        socket.send('chatAdded', {
          id: uuid(),
          kind: 'system',
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
            `error saving user rank for ${previewValue(userId, 64)}; the session keeps its previous grant state: ${briefError(err)}`
          )
        } finally {
          player.rankWritesPending--
          player.rankWrites.delete(write)
        }
      }
    }
    if (cmd === 'name') {
      const name = sanitizeName(arg1)
      // A name is written to everyone and to the database: one every two seconds, with a few at once. The name
      // the player has already is answered and changes nothing.
      const changed = !!name && name !== player.data.name
      if (changed && !this.spend(socket, 'identity', meta, 'You are changing your name too fast.')) return
      if (name) {
        const id = player.data.id
        const userId = player.data.userId
        if (changed) {
          player.data.name = name
          player.modify({ name })
          this.send('entityModified', { id, name })
        }
        socket.send('chatAdded', {
          id: uuid(),
          kind: 'system',
          from: null,
          fromId: null,
          body: `Name set to ${name}!`,
          createdAt: moment().toISOString(),
        })
        if (changed) {
          try {
            await this.db('users').where('id', userId).update({ name })
          } catch (err) {
            this.logOnce(socket, 'user-name-save', `error saving user name: ${briefError(err)}`)
          }
        }
      }
    }
    if (cmd === 'spawn') {
      const op = arg1
      this.onSpawnModified(socket, op, meta)
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
            kind: 'system',
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
    if (!adminCommand) {
      this.world.events.emit('command', eventPayload({ playerId, args }))
    }
  }

  onModifyRank = async (socket, data, meta) => {
    if (!socket.player.isAdmin()) return
    if (!isObject(data)) return
    const { playerId, rank } = data
    if (!playerId) return
    if (rank !== Ranks.VISITOR && rank !== Ranks.BUILDER && rank !== Ranks.ADMIN) return
    const player = this.world.entities.get(playerId)
    if (!player || !player.isPlayer) return
    // Where no admin code is set (`locked`), nobody becomes admin by typing one: an admin who lowers their own rank
    // has no way back but an edit of the database. That is refused, as a guard against a slip of the hand, and no
    // more than that: an admin can still lower every other admin, and two can lower each other.
    if (player === socket.player && rank < Ranks.ADMIN && this.admin().mode === 'locked') {
      socket.send('chatAdded', {
        id: uuid(),
        kind: 'system',
        from: null,
        fromId: null,
        body: 'This world has no admin code: you could not become admin again. Your rank was not changed.',
        createdAt: moment().toISOString(),
      })
      return
    }
    // a rank is written to everyone and to the database: counted with kicks and mutes, once it is one that is made
    if (!this.spend(socket, 'moderation', meta, 'You are changing ranks too fast.')) return
    player.rankRevision++
    player.modify({ rank })
    this.send('entityModified', { id: playerId, rank })
    this.dropBuilderUrls(player)
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
        `error saving user rank for ${previewValue(playerId, 64)}; the session keeps its previous grant state: ${briefError(err)}`
      )
    } finally {
      player.rankWritesPending--
      player.rankWrites.delete(write)
    }
  }

  // The player a kick or a mute names, when the sender may: a player here (an app's id named none, and passed the
  // rank comparison this replaces, since an app has no rank), outranked by the sender. Ranks are compared as the
  // players pane compares them (playerRanks.outranks: the rank of the session, a token's grant included, and the
  // world's): admins over builders and visitors, builders over visitors. Where everyone is an admin (a world open
  // to all) nobody outranks anybody, so nobody kicks or mutes.
  moderated(socket, playerId) {
    const player = this.world.entities.getPlayer(playerId)
    if (!player || !socket.player.outranks(player)) return null
    return player
  }

  // The kicked player is told, closed, and kept out for a while (kickList.js: that user id, and with
  // KICK_BY_ADDRESS new users from its address when an admin kicks). Its client leaves the voice room on the kick
  // and every other client drops its voice and screen with the player (ClientLiveKit).
  onKick = (socket, playerId, meta) => {
    const player = this.moderated(socket, playerId)
    if (!player) return
    const tSocket = this.sockets.get(playerId)
    if (!tSocket) return
    // counted with mutes and ranks, once it is a kick that is made
    if (!this.spend(socket, 'moderation', meta)) return
    this.kicks().add({ userId: playerId, addressKey: tSocket.addressKey, byAdmin: socket.player.isAdmin() })
    console.log(
      `[network] ${previewValue(socket.id, 64)} kicked ${previewValue(playerId, 64)}` +
        (this.kicks().minutes ? `: kept out for ${this.kicks().minutes} min` : '')
    )
    tSocket.send('kick', 'moderation')
    tSocket.disconnect()
  }

  onMute = (socket, data, meta) => {
    if (!isObject(data) || typeof data.muted !== 'boolean') return
    const player = this.moderated(socket, data.playerId)
    if (!player) return
    // a mute is written to everyone; the players pane shows the state the server has, so a dropped one is seen
    if (!this.spend(socket, 'moderation', meta)) return
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
    // a new sign-in takes the verification away, and the grant made on it goes with it: the rank used to stay
    // with a session that no longer had a verified wallet. A request refused by the cooldown above changes nothing
    this.endTokenGrant(socket, 'Signing in with a wallet again: builder access removed until the wallet is verified.')
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
        kind: 'system',
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
    // checked here, where the grant is made, and not only where the setting is read: with an amount of 0 a known
    // balance of 0 (a wallet without a token account) would be enough. The chain is not asked
    const required = solanaGating.REQUIRED_TOKEN_AMOUNT
    if (!(Number.isFinite(required) && required > 0)) {
      if (notifyInsufficient) {
        socket.send('chatAdded', {
          id: uuid(),
          kind: 'system',
          body: 'Wallet verified. Builder access by token is not set up in this world.',
          createdAt: moment().toISOString(),
        })
      }
      return
    }
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
    if (result.known && result.balance >= required) {
      if (!grantTokenRank({ socket, player, walletAddress, wallets: solanaGating })) return
      const rank = Ranks.BUILDER
      player.rankRevision++
      player.modify({ rank })
      this.send('entityModified', { id: player.data.id, rank })
      body = `Token verified! Builder access granted (${Number(result.balance).toLocaleString()} tokens)`
    } else if (result.known && result.balance < required) {
      if (!notifyInsufficient) return
      body = `Builder access requires ${required.toLocaleString()} tokens (current: ${Number(result.balance).toLocaleString()})`
    } else {
      body = 'Could not check your balance. Press refresh in a moment.'
    }
    socket.send('chatAdded', { id: uuid(), kind: 'system', body, createdAt: moment().toISOString() })
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
    this.endTokenGrant(socket, 'Wallet disconnected: builder access removed.')
  }

  // takes back a builder rank that was granted for a token balance in this session, and says so to that player.
  // A rank that is stored (given by an admin, or by the admin code) is not a grant and is left alone
  endTokenGrant(socket, body) {
    const player = socket.player
    if (!player) return false
    if (!(player.data.rank === Ranks.BUILDER && player.data.tokenGrantedRank)) return false
    const rank = Ranks.VISITOR
    player.rankRevision++
    player.modify({ rank })
    revokeTokenRank({ socket, player, wallets: solanaGating })
    this.send('entityModified', { id: player.data.id, rank })
    this.dropBuilderUrls(player)
    socket.send('chatAdded', { id: uuid(), kind: 'system', body, createdAt: moment().toISOString() })
    return true
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
    socket.send('evmWalletStatus', {
      verified: true,
      wallet: challenge.address,
      attempt,
      reason: 'ok',
      // only where tips are on: whether a tip sent now would be confirmed (the form says so before it asks)
      ...(evmGating.EVM_TIP_TOKENS.length ? { confirmsTips: this.confirmsTips() } : {}),
    })
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

  // Whether this world, as last observed, is confirming tips: it has a chain RPC to watch with (a watcher exists),
  // and that RPC answered the `finalized` tag the last time it was asked (evmTipWatcher.js: while it does not, a
  // watched tip ends `no_finality`; the watcher asks again later, and a tip sent meanwhile can still be confirmed
  // if the RPC has recovered by then). Told to clients with the sign-in result and with each tip intent, so the
  // form can say that the tip "may not be confirmed or announced here" before the wallet is asked. The transfer
  // itself never depends on it.
  confirmsTips() {
    return !!this.tipWatcher && this.tipWatcher.canConfirm()
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
      return refuse(tipAmountReason(err))
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
      confirms: this.confirmsTips(),
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
        kind: 'tip',
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
      this.world.chat.add(
        { id: uuid(), kind: 'tip', from: null, fromId: null, body, createdAt: moment().toISOString() },
        true
      )
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

  // サーバースクリプトの player.getEvmHolding から呼ばれる。アドレスはスクリプトに渡さず、ここで引く。
  // The script is not handed the address; it gets what the contract answers about it, and a contract's answer can
  // carry the address. That is why the read is made only for a contract the operator listed (evmHoldings.js)
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
    // an add never replaces: changing a blueprint takes blueprintModified and its version rule
    const existing = ok ? this.world.blueprints.get(safe.id) : undefined
    const fits = ok && !existing && this.world.blueprints.canFit(safe, true)
    if (!fits) {
      // Clients announce the blueprint immediately before the entity that uses it.
      if (typeof blueprint?.id === 'string') {
        socket.refusedBlueprint = { id: blueprint.id, expiresAt: Date.now() + 10000 }
      }
      if (existing) {
        // the sender replaced its own copy: give it the stored one back
        this.revertBlueprint(socket, existing)
        return this.logOnce(socket, 'blueprint-add-exists', 'onBlueprintAdded: blueprint id already exists')
      }
      if (!ok) return this.logOnce(socket, 'blueprint-add-invalid', 'onBlueprintAdded: invalid blueprint')
      const refusal = this.world.blueprints.budgetRefusal(safe, true)
      return this.logOnce(
        socket,
        `blueprint-add-${refusal}`,
        refusal === 'world'
          ? 'onBlueprintAdded: world is full (join-state budget exceeded)'
          : 'onBlueprintAdded: world blueprint budget exceeded'
      )
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
      // a model/script the packet repeats unchanged is not checked again (only what it sets is)
      current: typeof data?.id === 'string' ? this.world.blueprints.get(data.id) : undefined,
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
        `onBlueprintModified: no blueprint found: ${previewValue(safe.id, 64)}`
      )
    }
    // if new version is greater than current version, allow it
    if (safe.version > blueprint.version) {
      if (!this.world.blueprints.canFit(safe)) {
        const refusal = this.world.blueprints.budgetRefusal(safe)
        this.logOnce(
          socket,
          `blueprint-modify-${refusal}`,
          refusal === 'world'
            ? 'onBlueprintModified: world is full (join-state budget exceeded)'
            : 'onBlueprintModified: world blueprint budget exceeded'
        )
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
      // ids share one map with players, and any user (present or not) may join as a player under their id
      entityExists: id => !!this.world.entities.get(id) || this.userIds.has(id),
    })
    if (!safe) {
      return this.logOnce(socket, 'entity-invalid', `onEntityAdded: invalid entity: ${previewValue(data?.id, 64)}`)
    }
    if (!this.world.entities.canFitApp(safe.id, safe)) {
      // the id is new here, so the sender's optimistic copy is the only one to take back
      socket.send('entityRemoved', safe.id)
      return this.logOnce(socket, 'entity-add-budget', 'onEntityAdded: world is full (join-state budget exceeded)')
    }
    this.markAppDirty(safe)
    this.send('entityAdded', safe, socket.id)
    this.world.entities.add(safe)
  }

  onEntityModified = async (socket, data, meta) => {
    if (this.stopping) return
    if (!isObject(data)) return this.logOnce(socket, 'entity-packet-invalid', 'onEntityModified: invalid packet')
    const entity = this.world.entities.get(data.id)
    if (!entity) {
      return this.logOnce(socket, 'entity-missing', `onEntityModified: no entity found: ${previewValue(data.id, 64)}`)
    }
    if (entity.isPlayer) {
      // a socket may only modify its own player, and only the client-owned fields
      if (entity !== socket.player) {
        return this.logOnce(socket, 'player-modify-other', 'player attempted to modify another player')
      }
      // The stored avatar: a builder, or anyone with Custom Avatars on (a VRM uploaded here). A url outside this
      // world (entityModifyPolicy.js isExternalUrl), for the avatar, the session avatar or the emote: a builder only,
      // or the very url a server script chose for this player.
      const builder = socket.player.isBuilder()
      const safe = sanitizePlayerSelfModify(data, socket.id, {
        allowAvatar: builder || !!this.world.settings.customAvatars,
        allowExternal: builder,
        assetsUrl: process.env.ASSETS_BASE_URL,
        scriptAvatar: entity.scriptAvatar,
        scriptEmotes: entity.scriptEmotes,
      })
      const namesSessionAvatar = Object.prototype.hasOwnProperty.call(data, 'sessionAvatar')
      if (namesSessionAvatar && !(safe && Object.prototype.hasOwnProperty.call(safe, 'sessionAvatar'))) {
        this.logOnce(
          socket,
          'avatar-refused',
          'a session avatar was not taken: a url outside this world needs builder rank or a server script'
        )
      }
      // What is applied and told to the others: the permitted fields, without an identity field (name, avatar,
      // session avatar) that says what the player has already (nothing to tell, nothing to store), and without
      // those fields altogether when the connection is over its budget for them. Each change of one is written to
      // everyone, and name and avatar to the database: one every two seconds, with a few at once
      // (actionBudget.js). The movement fields of the same packet go on. The sender applied its values before
      // sending, so it is told the ones the server keeps: here for name and avatar, below for the session avatar.
      const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
      const IDENTITY = ['name', 'avatar', 'sessionAvatar']
      let fields = safe ? { ...safe } : null
      // whether the sender was given back the name the server keeps (over the budget, below)
      let nameTold = false
      if (fields) {
        for (const key of IDENTITY) {
          if (has(fields, key) && (fields[key] ?? null) === (entity.data[key] ?? null)) delete fields[key]
        }
        const identity = IDENTITY.filter(key => has(fields, key))
        if (identity.length && !this.spend(socket, 'identity', meta)) {
          const kept = { id: entity.data.id }
          for (const key of identity) {
            delete fields[key]
            if (key !== 'sessionAvatar') kept[key] = entity.data[key] ?? null
          }
          if (Object.keys(kept).length > 1) socket.send('entityModified', kept)
          nameTold = has(kept, 'name')
        }
        if (Object.keys(fields).length <= 1) fields = null
      }
      // Applied now; told to the others once, at the end of this tick's flush, merged with what else this
      // connection changes on its player in the tick (flushPending). Kept after the apply: what a script tells
      // everyone from inside it (the end of an effect that this change ends) goes out before this change, as it
      // did when both were written at once.
      if (fields) {
        entity.modify(fields)
        ;(this.pending ??= createPendingChanges()).merge(fields)
      }
      // The sender applied its session avatar before sending it. Whether it was taken or not, the sender is told the
      // session avatar the server now has, after everything the server told it before, with the number the sender
      // gave the update (entityModifyPolicy.js sessionAvatarRequest; none when it gave none). Told only when a value
      // is refused, the sender would end elsewhere for good when packets cross: the answer to an earlier refused
      // value arriving after a later value it set, or a server script's choice arriving after a value of its own
      // that the server takes later. Its own client applies the answer to its latest update and passes over the
      // answers to the ones before (PlayerLocal modify), so it ends on the server's value without going back to an
      // older choice of its own on the way.
      if (namesSessionAvatar) {
        const answer = { id: entity.data.id, sessionAvatar: entity.data.sessionAvatar ?? null }
        const request = sessionAvatarRequest(data)
        if (request !== undefined) answer.sessionAvatarRequest = request
        socket.send('entityModified', answer)
      }
      if (!safe) {
        return this.logOnce(
          socket,
          'entity-fields',
          `onEntityModified: no permitted fields: ${previewValue(data.id, 64)}`
        )
      }
      // The sender applied its name locally before sending; correct it if it was truncated. Decided for the name
      // alone: only a name given back over the budget (above) needs nothing more, whatever became of the other fields
      // (a truncated name equal to the one kept is taken out above as no change, and is still corrected here).
      if (!nameTold && has(safe, 'name') && safe.name !== data.name) {
        socket.send('entityModified', { id: entity.data.id, name: safe.name })
      }
      // persist player name and avatar changes: one write for each change that was taken
      const changes = {}
      let changed
      if (fields && has(fields, 'name')) {
        changes.name = fields.name
        changed = true
      }
      if (fields && has(fields, 'avatar')) {
        changes.avatar = fields.avatar
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
          `onEntityModified: no permitted fields: ${previewValue(data.id, 64)}`
        )
      }
      // only the blueprint id and a client-set state change an app's join-snapshot size (joinBudget.js)
      const sized =
        Object.prototype.hasOwnProperty.call(safe, 'blueprint') || Object.prototype.hasOwnProperty.call(safe, 'state')
      if (sized && !this.world.entities.canFitApp(entity.data.id, safe)) {
        this.logOnce(socket, 'entity-modify-budget', 'onEntityModified: world is full (join-state budget exceeded)')
        // the sender applied its change: the stored fields it touched go back (a server script owns the state)
        const revert = { id: entity.data.id }
        for (const key of Object.keys(safe)) {
          if (key !== 'id' && key !== 'state') revert[key] = entity.data[key]
        }
        if (Object.keys(revert).length > 1) socket.send('entityModified', revert)
        return
      }
      this.markAppDirty(entity.data, safe)
      this.send('entityModified', safe, socket.id)
      entity.modify(safe)
      if (sized) this.world.entities.trackApp(entity.data.id, this.world.entities.measureApp(entity.data.id, safe))
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
    // `allow`: asked by the app once it knows it would take the event (App.onEvent), so that an event for an app
    // that is not here, of a version the app refuses, or that nothing listens to uses none of the connection's
    // budget for script events (actionBudget.js event). Counted by when the packet arrived, as the other budgets
    entity?.onEvent(version, name, data, socket.id, { ...meta, allow: () => this.spend(socket, 'event', meta) })
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

  // A world setting from a builder's settings pane. Each one applied is written to everyone, so they have a budget
  // per connection (actionBudget.js settings). A number field sends a change per key repeat, about thirty a second
  // while an arrow key is held, so what goes over is not dropped: the latest value of each setting from this
  // connection is held and applied when the budget allows (releaseSettings, here and from the tick). The value a
  // builder ends on is the one the world keeps, and a flood of them reaches everyone at most five times a second
  // after the first thirty. The sender applied its value before sending and is not answered while it is held (its
  // field would jump back under the key). A value is checked against the sender's rank and the settings rules when it
  // arrives, so that one refused by those never takes the place of one held, and again when it is applied. Whether
  // the world has room for it (the join-state budget) is asked only when it is applied: a value refused for that is
  // let go, the earlier value of the same connection it had replaced is gone with it, and the sender is told the
  // value the world keeps. One still held when the server stops is not kept, as one that arrives then is not.
  // Several builders: of the values of one setting held for different connections, only the one that came last can
  // be applied. One that came earlier waits (releaseSettings) and is let go once the later one is applied; if the
  // later one goes first (its connection closes, its builder loses the rank, it is refused when checked again), the
  // earlier one is applied after all, on a later tick. So between a value's arrival and its application no other
  // value of that setting is applied, and the builder who sent it is not shown another value meanwhile. A held value
  // that is refused when it comes to be applied (its builder lost the rank) is answered to its sender with the
  // value the server has. So every pane that sent or was told a value of a setting ends on the value the world
  // keeps. Not covered, as without any budget: two values crossing in flight. The builder whose value reached the
  // server second is told the first one, and when that message comes after its own change its field shows the first
  // value while the world keeps its own (as before the budgets).
  onSettingsModified = (socket, data, meta) => {
    if (this.stopping) return
    if (!this.requireBuilder(socket, 'modify settings')) return
    if (!isObject(data)) return
    const { key, value } = data
    if (!isKnownSettingKey(key)) {
      return this.logOnce(socket, 'setting-unknown', `onSettingsModified: unknown setting: ${previewValue(key, 64)}`)
    }
    const result = this.settingAllowed(socket, key, value)
    if (!result) return
    // socket -> setting -> { value, changed, seq }: the latest value of a setting takes the place of the one held
    // and goes after the others; `seq` is the order of arrival among all connections
    const held = (this.heldSettings ??= new Map())
    if (!held.has(socket)) held.set(socket, new Map())
    const mine = held.get(socket)
    mine.delete(key)
    this.settingsSeq = (this.settingsSeq ?? 0) + 1
    mine.set(key, { value: result.value, changed: result.changed, seq: this.settingsSeq })
    this.releaseSettings(socket, meta?.at ?? performance.now())
  }

  // Whether this connection may set this value: a builder, an admin for an admin's setting, and a value the settings
  // rules take. Asked when it arrives and again when it is applied (the rank may have changed while it was held).
  // -> the value to store ({ value, changed }: normalizeSettingValue), or null
  settingAllowed(socket, key, value) {
    if (!this.requireBuilder(socket, 'modify settings')) return null
    if (isAdminOnlySettingKey(key) && !socket.player.isAdmin()) {
      this.logOnce(socket, 'setting-admin', 'player attempted to modify setting without admin permission')
      return null
    }
    const result = normalizeSettingValue(key, value)
    if (!result.ok) {
      this.logOnce(socket, 'setting-invalid', `onSettingsModified: invalid value for ${previewValue(key, 64)}`)
      return null
    }
    return result
  }

  // Applies the settings this connection has held, the oldest first, while its settings budget allows (`at`: the
  // time counted). A value refused now is let go without using the budget, and its sender is told the server's; one
  // that another connection's later value of the same setting is waiting behind stays held, without using it
  // either. Nothing is kept for a connection that is gone, or once the server stops.
  releaseSettings(socket, at) {
    const mine = this.heldSettings?.get(socket)
    if (!mine) return
    if (this.stopping || socket.closed || socket.disconnected) {
      this.heldSettings.delete(socket)
      return
    }
    const budgets = (this.actionBudgets ??= createActionBudgets())
    for (const [key, held] of mine) {
      const result = this.settingAllowed(socket, key, held.value)
      if (!result) {
        // Let go, and its sender (alone) is told the value the server has, which its pane showed before it sent
        // this one. A newer value it may have typed meanwhile is not set back by that: it came from someone who is
        // no longer a builder (or was refused when it came), and was not taken either.
        mine.delete(key)
        socket.send('settingsModified', { key, value: this.world.settings.serialize()[key] })
        continue
      }
      if (this.heldAfter(socket, key, held.seq)) continue
      // settings are part of the join snapshot's world state (joinBudget.js): measured as they would be
      const next = settingsBytes({ ...this.world.settings.serialize(), [key]: result.value })
      if (!fitsJoinState(this.world, next - (this.settingsBytes || 0))) {
        mine.delete(key)
        this.logOnce(socket, 'setting-budget', 'onSettingsModified: world is full (join-state budget exceeded)')
        // the sender applied its value locally before sending: it gets the stored one back
        socket.send('settingsModified', { key, value: this.world.settings.serialize()[key] })
        continue
      }
      if (!budgets.spend(socket, 'settings', at, false).ok) {
        this.logOnce(
          socket,
          'budget:settings',
          `[network] ${previewValue(socket.id, 64)} is over its settings budget: the latest value of each setting is held and applied as the budget allows (further ones from this connection are not logged)`
        )
        return
      }
      mine.delete(key)
      // A value of this setting held for another connection that arrived before this one is replaced by it, not
      // applied after it: that connection is told this value now.
      for (const [other, theirs] of this.heldSettings) {
        if (other === socket || !(theirs.get(key)?.seq < held.seq)) continue
        theirs.delete(key)
        if (!theirs.size) this.heldSettings.delete(other)
      }
      this.world.settings.set(key, result.value)
      this.settingsBytes = settingsBytes(this.world.settings.serialize())
      this.send('settingsModified', { key, value: result.value }, socket.id)
      // the sender applied its value locally before sending; correct it if it was adjusted
      if (held.changed) socket.send('settingsModified', { key, value: result.value })
      // the world's rank is everyone's least rank: lowered, it can end "everyone is a builder"
      if (key === 'rank') this.sockets.forEach(other => this.dropBuilderUrls(other.player))
    }
    if (!mine.size) this.heldSettings.delete(socket)
  }

  // Whether another connection holds a value of this setting that came after `seq`. One that can no longer be
  // applied (its connection closed, its builder's rank gone) is let go by that connection's own release, at the
  // latest on the next tick, and the earlier value goes then.
  heldAfter(socket, key, seq) {
    for (const [other, theirs] of this.heldSettings) {
      if (other !== socket && theirs.get(key)?.seq > seq) return true
    }
    return false
  }

  onSpawnModified = async (socket, op, meta) => {
    if (this.stopping) return
    if (!this.requireBuilder(socket, 'modify spawn')) return
    if (op !== 'set' && op !== 'clear') return
    const spawn = op === 'set' ? sanitizeSpawn(socket.player.data) : { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
    if (!spawn) {
      socket.send('chatAdded', {
        id: uuid(),
        kind: 'system',
        from: null,
        fromId: null,
        body: 'Spawn not updated: invalid player transform',
        createdAt: moment().toISOString(),
      })
      return
    }
    // The spawn is a row of the world's config: counted with the settings, once it is one that is made (through
    // /spawn the command's own budget was asked first)
    if (!this.spend(socket, 'settings', meta, 'You are changing the spawn too fast.')) return
    this.spawn = spawn
    await this.saveConfig('spawn', this.spawn)
    socket.send('chatAdded', {
      id: uuid(),
      kind: 'system',
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
    // Counted against the builder (aiBudget.js): the user for a stored rank, the wallet for one who is a builder
    // only by holding a token (a user id is free: every new connection gets one). A refused request is answered to
    // that player.
    const player = socket.player
    const wallet = player.data.tokenGrantedRank ? solanaGating.walletOf(socket.id) : null
    const refusal = this.world.ai.onAction(action, wallet ? `wallet:${wallet}` : `user:${player.data.userId}`)
    if (refusal) {
      socket.send('chatAdded', {
        id: uuid(),
        kind: 'system',
        from: null,
        fromId: null,
        body: refusal,
        createdAt: moment().toISOString(),
      })
    }
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
    // not for a connection another one of the same user has already replaced: what that user holds now is the new
    // connection's
    const current = this.sockets.get(socket.id)
    if (!this.stopping && (!current || current === socket)) this.releaseApps(socket.id)
    // only drop the entry that still refers to this socket
    if (current === socket) this.sockets.delete(socket.id)
  }

  // What a connection that is gone was holding. Only the holder's client ends a move or an upload (it sends
  // `mover: null` when the app is placed and `uploader: null` when its files are in the store), so an app whose
  // holder left stayed as it was for everyone: in the middle of a move, or showing "loading" for good, and never
  // saved (markAppDirty leaves out an app that is held).
  // - a move ends where the app is: the hold is lifted, said to everyone, and the app is saved there.
  // - an upload that never reported its end is taken as not finished: the app is removed, as the uploader's own
  //   client does when an upload fails. (If the files did arrive, dropping the file again finds them there.)
  releaseApps(holder) {
    for (const entity of [...this.world.entities.items.values()]) {
      if (!entity.isApp) continue
      const id = entity.data.id
      if (entity.data.uploader === holder) {
        try {
          this.world.entities.remove(id)
        } catch (err) {
          this.logOnce(this, 'release-remove', `[network] removing an app whose uploader left: ${briefError(err)}`)
          // the app is gone from the world all the same (as in rekeyApp)
          this.world.entities.items.delete(id)
          this.world.entities.untrackApp?.(id)
        }
        this.send('entityRemoved', id)
      } else if (entity.data.mover === holder) {
        const change = { id, mover: null }
        this.markAppDirty(entity.data, change)
        this.send('entityModified', change)
        entity.modify(change)
      }
    }
  }
}
