// The EVM wallet of a connection: the sign-in with an Ethereum account by a signed message (SIWE; a contract
// account's signature is checked through the chain), its cooldown and its revoke, and the holdings a server script
// reads for a player. Moved here as written from src/core/systems/ServerNetwork.js (P16): it is a part of that
// class's file, not a module of its own design. Each function's `this` is the network (ServerNetwork declares every
// one as a member of the kind it had and calls it with itself); the state is where it was, on the connection
// (socket.evmWallet, which onConnection makes with evm-gating.js) and on the network. The tips (tips.js) keep their
// part of the connection's state in the same object; what one file calls of the other (currentEvm, confirmsTips) it
// calls through the network.
import * as evmGating from '../evm-gating'

// inbound packet payloads are untrusted; handlers check the root shape before any lookup
const isObject = value => value !== null && typeof value === 'object'

// EVM (SIWE) の所有証明。Solana の socket.wallet とは世代もクールダウンも独立させ、互いの試行を取り消さない。
// 検証はランクを変えない (P1)
export function invalidateEvmWallet(socket, { clearVerified }) {
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

export function currentEvm(socket, generation, player) {
  return (
    this.sockets.get(socket.id) === socket &&
    !socket.disconnected &&
    !this.stopping &&
    !this.world.fatalError &&
    socket.evmWallet?.generation === generation &&
    socket.player === player
  )
}

export function onRequestEvmNonce(socket, data) {
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

export async function onRequestEvmVerify(socket, data) {
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

export function onRevokeEvmWallet(socket, data) {
  if (this.stopping || this.world.fatalError) return
  if (!evmGating.EVM_ENABLED || !isObject(data) || Array.isArray(data) || Object.keys(data).length) return
  const state = socket.evmWallet
  if (!state) return
  const changed = !!(state.verified || state.challenge)
  this.invalidateEvmWallet(socket, { clearVerified: true })
  if (!this.currentEvm(socket, state.generation, socket.player)) return
  if (changed) socket.send('evmWalletStatus', { verified: false })
}

// サーバースクリプトの player.getEvmHolding から呼ばれる。アドレスはスクリプトに渡さず、ここで引く。
// The script is not handed the address; it gets what the contract answers about it, and a contract's answer can
// carry the address. That is why the read is made only for a contract the operator listed (evmHoldings.js)
export async function evmHolding(playerId, spec) {
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
