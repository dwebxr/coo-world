// The tips (the tokens of EVM_TIP_TOKENS, sent from one player's wallet to another's): the opt-in to receive them,
// the intent that gives a verified sender the recipient's verified address and a ticket, the report of the transfer's
// transaction, its watch on the chain and its result, and a confirmed tip's event and announcement (their rate and
// the timer of an announcement that waits). The server makes no transfer and holds nothing. Moved here as written
// from src/core/systems/ServerNetwork.js (P16): it is a part of that class's file, not a module of its own design.
// Each function's `this` is the network (ServerNetwork declares every one as a member of the kind it had and calls it
// with itself); the state is where it was, on the connection (socket.evmWallet: the opt-in, the intent bucket, the
// tickets) and on the network (tipWatcher, tipSeen, tipFloorSec and tipAnnounce, made by init()). The sign-in's own
// check (currentEvm, evmWallet.js) is called through the network.
import moment from 'moment'
import { uuid } from '../../core/utils'
import * as evmGating from '../evm-gating'
import { parseTipAmount, tipAmountReason } from '../../core/extras/evmTokens'
import { formatUnits, isTxHash } from '../../core/extras/evmAbi'

// inbound packet payloads are untrusted; handlers check the root shape before any lookup
const isObject = value => value !== null && typeof value === 'object'

// 投げゼニの受け取り (オプトイン)。アドレスは配らず、真偽値 evmTips だけをプレイヤーに載せる
export function onSetEvmTipReceive(socket, data) {
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
export function confirmsTips() {
  return !!this.tipWatcher && this.tipWatcher.canConfirm()
}

// 送金の意思表示 (tip intent)。受取人のアドレスは、検証済みの送り手にだけ、ここで返す。
// サーバーは送金を作らず預からない: 返すのは受取人の検証済みアドレスと最小単位の金額だけ
export function onRequestEvmTipIntent(socket, data) {
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
export function issueTipTicket(socket, data) {
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
export function onEvmTip(socket, data) {
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
  // 数えた送金の鍵は tx と送り手 (チケットの from)。同じ tx でも送り手が違えば別の送金
  if (this.tipSeen.has(`${hash}:${ticket.from.toLowerCase()}`)) {
    state.tickets.delete(id)
    return reply('failed', 'duplicate')
  }
  // 上限に当たってもチケットはそのまま (再提出の回数は減らさない)
  let watchingHere = 0
  for (const other of state.tickets.values()) if (other.state === 'watching') watchingHere++
  // 同じ txHash ごとの上限は設けない (他人の報告で枠を埋められないように)。他人の見張りは from が違うので確定しない。
  // TIP_WATCH_MAX is 2 x WS_MAX_SOCKETS (evm-gating.js), so with a connection limit the per-socket 2 is the limit
  // a sender meets. Being watched is a place in the table, not a share of the chain calls
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
    // not before the ticket (less the skew), and not before this process started (tipFloorSec, in init)
    notBeforeSec: Math.max(ticket.issuedAt / 1000 - evmGating.TIP_TIME_SKEW_SEC, this.tipFloorSec),
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

export function pruneTipSeen(now) {
  for (const [key, until] of this.tipSeen) {
    if (until > now && this.tipSeen.size <= evmGating.TIP_SEEN_MAX) break
    this.tipSeen.delete(key)
  }
}

export function onTipResult(socket, id, hash, result) {
  if (this.stopping || this.world.fatalError) return
  const tickets = socket.evmWallet?.tickets
  const ticket = tickets?.get(id)
  if (!ticket || ticket.state !== 'watching') return
  let { state, reason } = result
  if (state === 'confirmed') {
    const now = Date.now()
    this.pruneTipSeen(now)
    // 同じ tx の同じ送り手の送金を別のチケットで先に確定していれば、二度目は数えない
    const key = `${hash}:${ticket.from.toLowerCase()}`
    if (this.tipSeen.has(key)) {
      state = 'failed'
      reason = 'duplicate'
    } else {
      this.tipSeen.set(key, now + evmGating.TIP_SEEN_TTL_MS)
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
export function tipConfirmed(socket, ticket) {
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
export function announceTip({ fromId, toPlayerId, body, privateBody }) {
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

export function drainTipAnnouncements() {
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
export function dropTipTickets(socket) {
  const tickets = socket.evmWallet?.tickets
  if (!tickets) return
  tickets.clear()
  this.tipWatcher?.cancel(job => job.socket === socket)
}
