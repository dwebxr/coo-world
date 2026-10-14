import moment from 'moment'
import { writePacket } from '../packets'
import { Socket } from '../Socket'
import { createDispatchQueue, uuid } from '../utils'
import { System } from './System'
import { createJWT, readJWT } from '../utils-server'
import { cloneDeep, isNumber } from 'lodash-es'
import * as THREE from '../extras/three'
import { Ranks } from '../extras/ranks'
import {
  sanitizeAppModify,
  sanitizeAppRelease,
  sanitizeEntityAdd,
  sanitizeName,
  sanitizePlayerSelfModify,
} from '../extras/entityModifyPolicy'
import { isAdminOnlySettingKey, isKnownSettingKey, normalizeSettingValue } from '../extras/settingsPolicy'
import { internalEvents } from '../extras/internalEvents'
import * as solanaGating from '../../server/solana-gating'

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
    this.socketIntervalId = setInterval(() => this.checkSockets(), PING_RATE * 1000)
    this.saveTimerId = null
    this.dirtyBlueprints = new Set()
    this.dirtyApps = new Set()
    this.isServer = true
    this.queue = createDispatchQueue()
  }

  init({ db }) {
    this.db = db
  }

  async start() {
    // get spawn
    const spawnRow = await this.db('config').where('key', 'spawn').first()
    this.spawn = JSON.parse(spawnRow?.value || defaultSpawn)
    // hydrate blueprints
    const blueprints = await this.db('blueprints')
    for (const blueprint of blueprints) {
      const data = JSON.parse(blueprint.data)
      this.world.blueprints.add(data, true)
    }
    // hydrate entities
    const entities = await this.db('entities')
    for (const entity of entities) {
      const data = JSON.parse(entity.data)
      data.state = {}
      this.world.entities.add(data, true)
    }
    // hydrate settings
    let settingsRow = await this.db('config').where('key', 'settings').first()
    try {
      const settings = JSON.parse(settingsRow?.value || '{}')
      this.world.settings.deserialize(settings)
      this.world.settings.setHasAdminCode(!!process.env.ADMIN_CODE)
    } catch (err) {
      console.error(err)
    }
    // watch settings changes
    this.world.settings.on('change', this.saveSettings)
    // queue first save
    if (SAVE_INTERVAL) {
      this.saveTimerId = setTimeout(this.save, SAVE_INTERVAL * 1000)
    }
  }

  preFixedUpdate() {
    this.flush()
  }

  send(name, data, ignoreSocketId) {
    // console.log('->>>', name, data)
    const packet = writePacket(name, data)
    this.sockets.forEach(socket => {
      if (socket.id === ignoreSocketId) return
      socket.sendPacket(packet)
    })
  }

  sendTo(socketId, name, data) {
    const socket = this.sockets.get(socketId)
    socket?.send(name, data)
  }

  checkSockets() {
    // see: https://www.npmjs.com/package/ws#how-to-detect-and-close-broken-connections
    const dead = []
    this.sockets.forEach(socket => {
      if (!socket.alive) {
        dead.push(socket)
      } else {
        socket.ping()
      }
    })
    dead.forEach(socket => socket.disconnect())
  }

  enqueue(socket, method, data) {
    this.queue.enqueue(socket, method, data)
  }

  flush() {
    this.queue.flush((socket, method, data) => this[method]?.(socket, data))
  }

  getTime() {
    return performance.now() / 1000 // seconds
  }

  requireBuilder(socket, action) {
    if (socket.player.isBuilder()) return true
    console.error(`player attempted to ${action} without builder permission`)
    return false
  }

  save = async () => {
    try {
      const counts = {
        upsertedBlueprints: 0,
        upsertedApps: 0,
        deletedApps: 0,
      }
      const now = moment().toISOString()
      // blueprints
      for (const id of this.dirtyBlueprints) {
        const blueprint = this.world.blueprints.get(id)
        try {
          const record = {
            id: blueprint.id,
            data: JSON.stringify(blueprint),
          }
          await this.db('blueprints')
            .insert({ ...record, createdAt: now, updatedAt: now })
            .onConflict('id')
            .merge({ ...record, updatedAt: now })
          counts.upsertedBlueprints++
          this.dirtyBlueprints.delete(id)
        } catch (err) {
          console.log(`error saving blueprint: ${blueprint.id}`)
          console.error(err)
        }
      }
      // app entities
      for (const id of this.dirtyApps) {
        const entity = this.world.entities.get(id)
        if (entity) {
          // it needs creating/updating
          if (entity.data.uploader || entity.data.mover) {
            continue // ignore while uploading or moving
          }
          try {
            const data = cloneDeep(entity.data)
            data.state = null
            const record = {
              id: entity.data.id,
              data: JSON.stringify(entity.data),
            }
            await this.db('entities')
              .insert({ ...record, createdAt: now, updatedAt: now })
              .onConflict('id')
              .merge({ ...record, updatedAt: now })
            counts.upsertedApps++
            this.dirtyApps.delete(id)
          } catch (err) {
            console.log(`error saving entity: ${entity.data.id}`)
            console.error(err)
          }
        } else {
          // it was removed
          try {
            await this.db('entities').where('id', id).delete()
            counts.deletedApps++
            this.dirtyApps.delete(id)
          } catch (err) {
            console.log(`error deleting entity: ${id}`)
            console.error(err)
          }
        }
      }
      // log
      const didSave = counts.upsertedBlueprints > 0 || counts.upsertedApps > 0 || counts.deletedApps > 0
      if (didSave) {
        console.log(
          `world saved (${counts.upsertedBlueprints} blueprints, ${counts.upsertedApps} apps, ${counts.deletedApps} apps removed)`
        )
      }
    } finally {
      // queue again, even if something above threw
      this.saveTimerId = setTimeout(this.save, SAVE_INTERVAL * 1000)
    }
  }

  saveSettings = async () => {
    try {
      const data = this.world.settings.serialize()
      const value = JSON.stringify(data)
      await this.db('config')
        .insert({
          key: 'settings',
          value,
        })
        .onConflict('key')
        .merge({
          value,
        })
    } catch (err) {
      console.error('error saving settings')
      console.error(err)
    }
  }

  async onConnection(ws, params) {
    try {
      // check player limit
      const playerLimit = this.world.settings.playerLimit
      if (isNumber(playerLimit) && playerLimit > 0 && this.sockets.size >= playerLimit) {
        const packet = writePacket('kick', 'player_limit')
        ws.send(packet)
        ws.close()
        return
      }

      // check connection params
      let authToken = params.authToken
      let name = sanitizeName(params.name)
      let avatar = params.avatar

      // get or create user
      let user
      if (authToken) {
        try {
          const { userId } = await readJWT(authToken)
          user = await this.db('users').where('id', userId).first()
        } catch (err) {
          console.error('failed to read authToken:', authToken)
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
        authToken = await createJWT({ userId: user.id })
      }

      // disconnect if user already in this world
      if (this.sockets.has(user.id)) {
        const packet = writePacket('kick', 'duplicate_user')
        ws.send(packet)
        ws.close()
        return
      }

      // livekit options
      const livekit = await this.world.livekit.serialize(user.id)

      // create socket
      const socket = new Socket({ id: user.id, ws, network: this })

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

      // send snapshot
      socket.send('snapshot', {
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

      this.sockets.set(socket.id, socket)

      // enter events on the server are sent after the snapshot.
      // on the client these are sent during PlayerRemote.js entity instantiation!
      this.world.events.emit('enter', { playerId: socket.player.data.id })
    } catch (err) {
      console.error(err)
    }
  }

  onChatAdded = async (socket, msg) => {
    if (!isObject(msg)) return
    // the sender identity comes from the socket, not the packet
    msg.from = socket.player.data.name
    msg.fromId = socket.player.data.id
    this.world.chat.add(msg, false)
    this.send('chatAdded', msg, socket.id)
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
        player.modify({ rank })
        this.send('entityModified', { id, rank })
        socket.send('chatAdded', {
          id: uuid(),
          from: null,
          fromId: null,
          body: granted ? 'Admin granted!' : 'Admin revoked!',
          createdAt: moment().toISOString(),
        })
        try {
          await this.db('users').where('id', userId).update({ rank })
        } catch (err) {
          console.error('error saving user rank')
          console.error(err)
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
          console.error('error saving user name')
          console.error(err)
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
      if (op === 'stats') {
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
    player.modify({ rank })
    this.send('entityModified', { id: playerId, rank })
    try {
      await this.db('users').where('id', playerId).update({ rank })
    } catch (err) {
      console.error('error saving user rank')
      console.error(err)
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

  // Solanaビルダーゲーティング: ウォレット所有証明用の nonce を発行
  onRequestBuilderNonce = (socket, data) => {
    if (!solanaGating.TOKEN_GATING_ENABLED) return
    const walletAddress = data?.walletAddress
    if (!walletAddress || typeof walletAddress !== 'string') return
    // per-socket レート制限 (RPC 枯渇 DoS 防止)
    if (!solanaGating.checkRateLimit(socket.id)) return
    const nonce = solanaGating.issueNonce(socket.id, walletAddress)
    socket.send('builderNonce', { nonce })
  }

  // Solanaトークンによるビルダー権限リクエスト
  // 署名でウォレット所有を証明し、残高はサーバー側で on-chain 検証する
  // (クライアント自己申告のアドレス/残高は一切信用しない)
  onRequestBuilderByToken = async (socket, data) => {
    if (!solanaGating.TOKEN_GATING_ENABLED) return

    const { walletAddress, signature, nonce } = data || {}
    if (!walletAddress || !signature || !nonce) {
      return console.error('Invalid builder token request (missing walletAddress/signature/nonce)')
    }

    const player = socket.player
    if (!player) return

    // 既にビルダー以上の権限を持っている場合はスキップ
    if (player.data.rank >= Ranks.BUILDER) return

    const result = await solanaGating.verifyAndCheckBalance({
      socketId: socket.id,
      walletAddress,
      signature,
      nonce,
    })

    if (!result.ok) {
      // 残高不足はユーザーに具体的に通知。それ以外の失敗理由は詳細を伏せる
      const body =
        result.reason === 'insufficient'
          ? `ビルダー権限には ${solanaGating.REQUIRED_TOKEN_AMOUNT.toLocaleString()} トークンが必要です (現在: ${Number(
              result.balance || 0
            ).toLocaleString()})`
          : 'ウォレット認証に失敗しました'
      socket.send('chatAdded', { id: uuid(), body, createdAt: moment().toISOString() })
      return
    }

    // ビルダー権限を付与（セッション限定、DBには保存しない）
    const rank = Ranks.BUILDER
    player.modify({ rank })
    player.data.tokenGrantedRank = true // トークンで付与されたことを記録
    this.send('entityModified', { id: player.data.id, rank })

    socket.send('chatAdded', {
      id: uuid(),
      body: `トークン認証成功! ビルダー権限が付与されました (${Number(result.balance).toLocaleString()} tokens)`,
      createdAt: moment().toISOString(),
    })

    console.log(
      `Builder rank granted to ${player.data.name} via verified wallet ownership (${walletAddress}: ${result.balance} tokens)`
    )
  }

  // Solanaウォレット切断時にビルダー権限を剥奪 (自己降格のみ・署名検証不要)
  onRevokeBuilderByToken = async (socket, data) => {
    if (!solanaGating.TOKEN_GATING_ENABLED) {
      return
    }

    const player = socket.player
    if (!player) return

    // 管理者の場合は権限を剥奪しない
    if (player.data.rank >= Ranks.ADMIN) {
      return
    }

    // トークンで付与されたビルダー権限のみ剥奪（ビジターに戻す）
    if (player.data.rank === Ranks.BUILDER && player.data.tokenGrantedRank) {
      const rank = Ranks.VISITOR
      player.modify({ rank })
      player.data.tokenGrantedRank = false
      this.send('entityModified', { id: player.data.id, rank })

      socket.send('chatAdded', {
        id: uuid(),
        body: 'ウォレット切断: ビルダー権限が解除されました',
        createdAt: moment().toISOString(),
      })

      console.log(`Builder rank revoked from ${player.data.name} (wallet disconnected)`)
    }
  }

  onBlueprintAdded = (socket, blueprint) => {
    if (!this.requireBuilder(socket, 'add blueprint')) return
    this.world.blueprints.add(blueprint)
    this.send('blueprintAdded', blueprint, socket.id)
    this.dirtyBlueprints.add(blueprint.id)
  }

  onBlueprintModified = (socket, data) => {
    if (!this.requireBuilder(socket, 'modify blueprint')) return
    const blueprint = this.world.blueprints.get(data.id)
    if (!blueprint) return console.error('onBlueprintModified: no blueprint found', data)
    // if new version is greater than current version, allow it
    if (data.version > blueprint.version) {
      this.world.blueprints.modify(data)
      this.send('blueprintModified', data, socket.id)
      this.dirtyBlueprints.add(data.id)
    }
    // otherwise, send a revert back to client, because someone else modified before them
    else {
      socket.send('blueprintModified', blueprint)
    }
  }

  onEntityAdded = (socket, data) => {
    if (!this.requireBuilder(socket, 'add entity')) return
    // clients may only add apps, with a fresh id and an existing blueprint
    const safe = sanitizeEntityAdd(data, socket.id, {
      blueprintExists: id => !!this.world.blueprints.get(id),
      entityExists: id => !!this.world.entities.get(id),
    })
    if (!safe) return console.error('onEntityAdded: invalid entity', data?.id)
    const entity = this.world.entities.add(safe)
    this.send('entityAdded', safe, socket.id)
    this.dirtyApps.add(entity.data.id)
  }

  onEntityModified = async (socket, data) => {
    if (!isObject(data)) return console.error('onEntityModified: invalid packet')
    const entity = this.world.entities.get(data.id)
    if (!entity) return console.error('onEntityModified: no entity found', data)
    if (entity.isPlayer) {
      // a socket may only modify its own player, and only the client-owned fields
      if (entity !== socket.player) return console.error('player attempted to modify another player')
      const allowAvatar = socket.player.isBuilder() || !!this.world.settings.customAvatars
      const safe = sanitizePlayerSelfModify(data, socket.id, { allowAvatar })
      if (!safe) return console.error('onEntityModified: no permitted fields', data.id)
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
          console.error('error saving user changes')
          console.error(err)
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
          return console.error('player attempted to modify entity without builder permission')
        }
        safe = sanitizeAppRelease(data, { mover, uploader })
      }
      if (!safe) return console.error('onEntityModified: no permitted fields', data.id)
      entity.modify(safe)
      this.send('entityModified', safe, socket.id)
      // mark for saving
      this.dirtyApps.add(entity.data.id)
    }
  }

  onEntityEvent = (socket, event) => {
    if (!Array.isArray(event)) return
    const [id, version, name, data] = event
    // engine hooks and world events are never raised from the network
    if (typeof name !== 'string' || internalEvents.includes(name)) return
    if (typeof version !== 'number') return
    const entity = this.world.entities.get(id)
    entity?.onEvent(version, name, data, socket.id)
  }

  onEntityRemoved = (socket, id) => {
    if (!this.requireBuilder(socket, 'remove entity')) return
    if (typeof id !== 'string') return
    const entity = this.world.entities.get(id)
    if (!entity) return
    if (!entity.isApp) return console.error('player attempted to remove a non-app entity')
    this.world.entities.remove(id)
    this.send('entityRemoved', id, socket.id)
    this.dirtyApps.add(id)
  }

  onSettingsModified = (socket, data) => {
    if (!this.requireBuilder(socket, 'modify settings')) return
    if (!isObject(data)) return
    const { key, value } = data
    if (!isKnownSettingKey(key)) return console.error('onSettingsModified: unknown setting', key)
    if (isAdminOnlySettingKey(key) && !socket.player.isAdmin()) {
      return console.error('player attempted to modify setting without admin permission')
    }
    const result = normalizeSettingValue(key, value)
    if (!result.ok) return console.error('onSettingsModified: invalid value for', key)
    this.world.settings.set(key, result.value)
    this.send('settingsModified', { key, value: result.value }, socket.id)
    // the sender applied its value locally before sending; correct it if it was adjusted
    if (result.changed) socket.send('settingsModified', { key, value: result.value })
  }

  onSpawnModified = async (socket, op) => {
    if (!this.requireBuilder(socket, 'modify spawn')) return
    const player = socket.player
    if (op === 'set') {
      this.spawn = { position: player.data.position.slice(), quaternion: player.data.quaternion.slice() }
    } else if (op === 'clear') {
      this.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
    } else {
      return
    }
    const data = JSON.stringify(this.spawn)
    try {
      await this.db('config')
        .insert({
          key: 'spawn',
          value: data,
        })
        .onConflict('key')
        .merge({
          value: data,
        })
    } catch (err) {
      console.error('error saving spawn')
      console.error(err)
    }
    socket.send('chatAdded', {
      id: uuid(),
      from: null,
      fromId: null,
      body: op === 'set' ? 'Spawn updated' : 'Spawn cleared',
      createdAt: moment().toISOString(),
    })
  }

  onPlayerTeleport = (socket, data) => {
    this.sendTo(data.networkId, 'playerTeleport', data)
  }

  onPlayerPush = (socket, data) => {
    this.sendTo(data.networkId, 'playerPush', data)
  }

  onPlayerSessionAvatar = (socket, data) => {
    this.sendTo(data.networkId, 'playerSessionAvatar', data.avatar)
  }

  onAi = (socket, action) => {
    if (!socket.player.isBuilder()) {
      return console.error('player attempted to use ai but they are not a builder')
    }
    this.world.ai.onAction(action)
  }

  onPing = (socket, time) => {
    socket.send('pong', time)
  }

  onDisconnect = (socket, code) => {
    this.world.livekit.clearModifiers(socket.id)
    solanaGating.clearSocket(socket.id)
    socket.player.destroy(true)
    this.sockets.delete(socket.id)
  }
}
