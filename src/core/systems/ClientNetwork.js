import moment from 'moment'
import { createTokenBalanceClient } from '../extras/tokenBalanceClient'
import { emoteUrls } from '../extras/playerEmotes'
import {
  CHECK_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  createUploadQueue,
  describeAbort,
  fetchWithRetry,
} from '../extras/uploadQueue'
import { PROTOCOL_VERSION, readPacket, writeClientPacket } from '../packets'
import { sanitizePush, sanitizeSessionAvatar, sanitizeTeleport } from '../extras/playerRelayPolicy'
import { storage } from '../storage'
import { createDispatchQueue, uuid } from '../utils'
import { hashFile } from '../utils-client'
import { System } from './System'
import { BUILDER_ONLY_PACKETS, packetByteLimit, packetNodeLimit } from '../extras/inboundPolicy'
import { strictDecode } from '../extras/strictDecode'
import { CHANGE_TOO_LARGE } from '../extras/clientPreflight'

/**
 * Client Network System
 *
 * - runs on the client
 * - provides abstract network methods matching ServerNetwork
 *
 */
export class ClientNetwork extends System {
  constructor(world) {
    super(world)
    this.ids = -1
    this.ws = null
    this.apiUrl = null
    this.authToken = null
    this.id = null
    this.isClient = true
    this.queue = createDispatchQueue()
    this.uploads = createUploadQueue()
    this.refusedEvents = new Set()
    this.tokenBalance = createTokenBalanceClient({
      send: (name, data) => this.send(name, data),
      isVerified: () => this.world.solana?.isVerified() ?? false,
      onChange: () => this.world.emit('solana:balance'),
    })
    this.world.on('fatal', this.onFatal)
  }

  init({ wsUrl, name, avatar, authToken, onAuthToken }) {
    // authToken/onAuthToken を渡すと、プロセス共有の singleton storage
    // (localstorage.json) を使わず呼び出し側がトークンを管理する。
    // これにより同一マシンで複数の node-client エージェントを衝突なく起動できる。
    this.onAuthToken = onAuthToken || null
    const token = authToken ?? (this.onAuthToken ? '' : storage.get('authToken'))
    let url = `${wsUrl}?authToken=${token}&v=${PROTOCOL_VERSION}`
    if (name) url += `&name=${encodeURIComponent(name)}`
    if (avatar) url += `&avatar=${encodeURIComponent(avatar)}`
    this.ws = new WebSocket(url)
    this.ws.binaryType = 'arraybuffer'
    this.ws.addEventListener('message', this.onPacket)
    this.ws.addEventListener('close', this.onClose)
  }

  preFixedUpdate() {
    this.flush()
  }

  fits(name, data) {
    return this.packetFits(name, writeClientPacket(name, data))
  }

  packetFits(name, packet) {
    return (
      packet.length <= packetByteLimit(name) &&
      strictDecode(packet, { maxNodes: packetNodeLimit(name), build: false }).ok
    )
  }

  send(name, data) {
    if (this.world.fatalError) return
    const packet = writeClientPacket(name, data)
    if (!this.packetFits(name, packet)) {
      if (BUILDER_ONLY_PACKETS.includes(name)) {
        this.world.emit('toast', CHANGE_TOO_LARGE)
      } else if (name === 'entityEvent' && !this.refusedEvents.has(data[2])) {
        this.refusedEvents.add(data[2])
        console.error('[network] entityEvent refused: packet does not fit')
      }
      return false
    }
    this.ws.send(packet)
    return true
  }

  // uploads run one at a time per tab: the server admits one transfer per user. callers uploading a batch
  // (the assets of one .hyp) pass one AbortController for all of them: the queue aborts it when one fails,
  // so the rest of the batch is dropped before it is sent
  upload(file, { batch } = {}) {
    // the server enforces the same cap; refusing here spares a doomed transfer and keeps the reason readable
    const maxBytes = this.maxUploadSize * 1024 * 1024
    if (maxBytes > 0 && file.size > maxBytes) {
      const err = new Error(`Upload failed: file exceeds ${this.maxUploadSize}MB`)
      err.status = 413
      batch?.abort()
      return Promise.reject(err)
    }
    return this.uploads.enqueue(signal => this.uploadNow(file, signal), { batch })
  }

  async uploadNow(file, signal) {
    // the server only accepts uploads from a connected session; the token says which one
    const headers = { Authorization: `Bearer ${this.authToken}` }
    try {
      {
        // first check if we even need to upload it
        const hash = await hashFile(file)
        const ext = file.name.split('.').pop().toLowerCase()
        const filename = `${hash}.${ext}`
        // the size lets the server say now whether the upload itself would be refused
        const url = `${this.apiUrl}/upload-check?filename=${filename}&size=${file.size}`
        const resp = await fetchWithRetry(url, { headers }, { timeoutMs: CHECK_TIMEOUT_MS, signal })
        if (!resp.ok) throw await uploadError(resp)
        const data = await resp.json()
        if (data.exists) return // console.log('already uploaded:', filename)
      }
      // then upload it
      const form = new FormData()
      form.append('file', file)
      const url = `${this.apiUrl}/upload`
      const resp = await fetchWithRetry(
        url,
        { method: 'POST', body: form, headers },
        { timeoutMs: UPLOAD_TIMEOUT_MS, signal }
      )
      if (!resp.ok) throw await uploadError(resp)
    } catch (err) {
      throw describeAbort(err)
    }
  }

  enqueue(method, data) {
    if (this.world.fatalError) return
    this.queue.enqueue(method, data)
  }

  flush() {
    this.queue.flush((method, data) => {
      if (!this.world.fatalError) this[method]?.(data)
    })
  }

  getTime() {
    return (performance.now() + this.serverTimeOffset) / 1000 // seconds
  }

  onPacket = e => {
    const [method, data] = readPacket(e.data)
    this.enqueue(method, data)
    // console.log('<-', method, data)
  }

  onSnapshot(data) {
    this.id = data.id
    this.serverTimeOffset = data.serverTime - performance.now()
    this.apiUrl = data.apiUrl
    this.maxUploadSize = data.maxUploadSize
    this.world.assetsUrl = data.assetsUrl

    // preload environment model and avatar
    // if (this.world.environment.base) {
    //   this.world.loader.preload('model', this.world.environment.base.model)
    // }
    if (data.settings.avatar) {
      this.world.loader.preload('avatar', data.settings.avatar.url)
    }
    // preload some blueprints
    for (const item of data.blueprints) {
      if (item.preload && !item.disabled) {
        if (item.model) {
          const type = item.model.endsWith('.vrm') ? 'avatar' : 'model'
          this.world.loader.preload(type, item.model)
        }
        if (item.script) {
          this.world.loader.preload('script', item.script)
        }
        for (const value of Object.values(item.props || {})) {
          if (value === undefined || value === null || !value?.url || !value?.type) continue
          this.world.loader.preload(value.type, value.url)
        }
      }
    }
    // preload emotes
    for (const url of emoteUrls) {
      this.world.loader.preload('emote', url)
    }
    // preload local player avatar
    for (const item of data.entities) {
      if (item.type === 'player' && item.owner === this.id) {
        const url = item.sessionAvatar || item.avatar
        this.world.loader.preload('avatar', url)
      }
    }
    this.world.loader.execPreload()

    this.world.collections.deserialize(data.collections)
    this.world.settings.deserialize(data.settings)
    this.world.settings.setHasAdminCode(data.hasAdminCode)
    this.world.chat.deserialize(data.chat)
    this.world.ai?.deserialize(data.ai)
    this.world.blueprints.deserialize(data.blueprints)
    this.world.entities.deserialize(data.entities)
    this.world.livekit?.deserialize(data.livekit)
    // kept for authenticated api calls (uploads), whoever stores the token
    this.authToken = data.authToken
    // caller がトークン管理する場合は singleton storage を汚さない
    if (this.onAuthToken) {
      this.onAuthToken(data.authToken)
    } else {
      storage.set('authToken', data.authToken)
    }
  }

  onSettingsModified = data => {
    this.world.settings.set(data.key, data.value)
  }

  onChatAdded = msg => {
    this.world.chat.add(msg, false)
  }

  onChatCleared = () => {
    this.world.chat.clear()
  }

  onBlueprintAdded = blueprint => {
    this.world.blueprints.add(blueprint)
  }

  onBlueprintModified = change => {
    this.world.blueprints.modify(change)
  }

  onEntityAdded = data => {
    this.world.entities.add(data)
  }

  onEntityModified = data => {
    const entity = this.world.entities.get(data.id)
    if (!entity) return console.error('onEntityModified: no entity found', data)
    entity.modify(data)
  }

  onEntityEvent = event => {
    const [id, version, name, data] = event
    const entity = this.world.entities.get(id)
    entity?.onEvent(version, name, data, undefined)
  }

  onEntityRemoved = id => {
    this.world.entities.remove(id)
  }

  // sent by the server when a server script acts on this player (or queued by a local script for its own
  // player); the payload is checked before it is applied
  onPlayerTeleport = data => {
    const safe = sanitizeTeleport(data)
    if (!safe) return console.error('onPlayerTeleport: invalid payload', data)
    this.world.entities.player?.teleport(safe)
  }

  onPlayerPush = data => {
    const safe = sanitizePush(data)
    if (!safe) return console.error('onPlayerPush: invalid payload', data)
    this.world.entities.player?.push(safe.force)
  }

  onPlayerSessionAvatar = data => {
    const safe = sanitizeSessionAvatar(data)
    if (!safe) return console.error('onPlayerSessionAvatar: invalid payload', data)
    this.world.entities.player?.setSessionAvatar(safe.avatar)
  }

  onLiveKitLevel = data => {
    this.world.livekit.setLevel(data.playerId, data.level)
  }

  onMute = data => {
    this.world.livekit.setMuted(data.playerId, data.muted)
  }

  // Solanaビルダーゲーティング: サーバー発行 nonce を solana-integration に中継
  onBuilderNonce = data => {
    this.world.emit('solana:builderNonce', data)
  }

  onWalletStatus = data => {
    this.world.emit('solana:walletStatus', data)
  }

  onTokenBalance = data => {
    this.tokenBalance.onTokenBalance(data)
  }

  disposeWallet(reason) {
    this.world.solana?.dispose(reason)
    this.tokenBalance.dispose()
  }

  onFatal = () => {
    this.disposeWallet('fatal')
  }

  onPong = time => {
    this.world.stats?.onPong(time)
  }

  onKick = code => {
    this.world.emit('kick', code)
  }

  onClose = code => {
    if (this.world.fatalError) {
      this.disposeWallet('fatal')
      return
    }
    // 切断前に受信済みのパケット (kick 等) を処理しておく。
    // これをしないと、キューされた 'kick' が tick で flush される前に
    // 'disconnect' が発火し、consumer が world を破棄して kick 理由を取りこぼす。
    this.flush()
    this.disposeWallet('close')
    this.world.chat.add({
      id: uuid(),
      from: null,
      fromId: null,
      body: `You have been disconnected.`,
      createdAt: moment().toISOString(),
    })
    this.world.emit('disconnect', code || true)
    console.log('disconnect', code)
  }

  destroy() {
    this.disposeWallet('destroy')
    this.world.off('fatal', this.onFatal)
    if (this.ws) {
      this.ws.removeEventListener('message', this.onPacket)
      this.ws.removeEventListener('close', this.onClose)
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
  }
}

// a rejected upload becomes an Error carrying the status and the server's reason, so callers can abort and report it
async function uploadError(resp) {
  let reason = resp.statusText || `HTTP ${resp.status}`
  try {
    reason = (await resp.json()).error || reason
  } catch (_err) {
    // not a json body; keep the status text
  }
  const err = new Error(`Upload failed: ${reason}`)
  err.status = resp.status
  return err
}
