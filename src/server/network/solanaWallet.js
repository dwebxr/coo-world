// The Solana wallet of a connection (the token gate): the sign-in by a signed message and its cooldown, the builder
// rank granted for a token balance and taken back, and the balance the wallet panel asks for. Moved here as written
// from src/core/systems/ServerNetwork.js (P16): it is a part of that class's file, not a module of its own design.
// Each function's `this` is the network (ServerNetwork declares every one as a member of the kind it had and calls
// it with itself); the state is where it was, on the connection (socket.wallet, which onConnection makes with
// solana-gating.js) and on the network.
import moment from 'moment'
import { uuid } from '../../core/utils'
import { Ranks } from '../../core/extras/ranks'
import * as solanaGating from '../solana-gating'
import { grantTokenRank, revokeTokenRank } from '../rankGrants'

// inbound packet payloads are untrusted; handlers check the root shape before any lookup
const isObject = value => value !== null && typeof value === 'object'

export function invalidateWallet(socket, { clearVerified }) {
  const state = socket.wallet
  state.generation++
  state.challenge = null
  state.pendingBalance = null
  if (clearVerified) state.verified = null
}

export function current(socket, generation, player) {
  return (
    this.sockets.get(socket.id) === socket &&
    !socket.disconnected &&
    !this.stopping &&
    !this.world.fatalError &&
    socket.wallet.generation === generation &&
    socket.player === player
  )
}

export function onRequestBuilderNonce(socket, data) {
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

export async function onRequestBuilderByToken(socket, data) {
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

export async function checkBuilderBalance(socket, notifyInsufficient) {
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
  try {
    result = await this.tokenBalanceService.get(walletAddress, { fresh: true })
  } catch {
    // The production service resolves unknown; an injected service may reject.
  }
  if (!this.current(socket, generation, player) || player.rankRevision !== revision) return
  if (!(player.data.rank < Ranks.BUILDER)) return
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

export async function onRequestBuilderRecheck(socket, data) {
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

export async function onTokenBalanceRequest(socket, data) {
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

export function onRevokeBuilderByToken(socket, data) {
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
export function endTokenGrant(socket, body) {
  const player = socket.player
  if (!player) return false
  if (!(player.data.rank === Ranks.BUILDER && player.tokenGrantedRank)) return false
  const rank = Ranks.VISITOR
  player.rankRevision++
  player.modify({ rank })
  revokeTokenRank({ socket, player, wallets: solanaGating })
  this.send('entityModified', { id: player.data.id, rank })
  this.dropBuilderUrls(player)
  socket.send('chatAdded', { id: uuid(), kind: 'system', body, createdAt: moment().toISOString() })
  return true
}
