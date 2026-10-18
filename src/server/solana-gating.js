import { PublicKey } from '@solana/web3.js'
import nacl from 'tweetnacl'

const numOr = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

export const TOKEN_GATING_ENABLED = !!process.env.PUBLIC_TOKEN_MINT
export const REQUIRED_TOKEN_AMOUNT = numOr(process.env.PUBLIC_REQUIRED_TOKEN_AMOUNT, 10000)
export const CHALLENGE_TTL_MS = 60_000
export const CHALLENGE_COOLDOWN_MS = 5_000
export const BUILDER_RECHECK_MS = 10_000

export function challengeHost(env = process.env) {
  for (const url of [env.PUBLIC_API_URL, env.PUBLIC_WS_URL]) {
    try {
      const host = new URL(url).host
      if (/^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(host)) return host
    } catch {
      // Try the next configured URL, then the literal world name.
    }
  }
  return 'coo-world'
}

export const WALLET_HOST = challengeHost()

export function isWalletAddress(address) {
  if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false
  try {
    return new PublicKey(address).toBase58() === address
  } catch {
    return false
  }
}

export function isWalletRequestId(id) {
  return Number.isInteger(id) && id >= 1 && id <= 0x7fffffff
}

export function signatureBytes(signature) {
  if (signature instanceof Uint8Array) return signature.length === 64 ? signature : null
  if (Array.isArray(signature)) {
    if (signature.length !== 64) return null
    for (const byte of signature) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null
    }
    return Uint8Array.from(signature)
  }
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return null
  const bytes = Buffer.from(signature, 'base64')
  return bytes.length === 64 && bytes.toString('base64') === signature ? bytes : null
}

export function buildChallenge(address, host, now) {
  const nonce = Buffer.from(nacl.randomBytes(32)).toString('base64')
  const message = `${host} wants you to verify your Solana wallet.\nWallet: ${address}\nNonce: ${nonce}`
  if (!isWalletAddress(address) || Buffer.byteLength(message) > 512) throw new Error('invalid challenge')
  return { nonce, message, address, expiresAt: now + CHALLENGE_TTL_MS }
}

export function checkChallenge(challenge, { walletAddress, signature, nonce }, now) {
  if (!challenge) return { ok: false, reason: 'no_nonce' }
  if (typeof nonce !== 'string' || nonce.length !== 44 || challenge.nonce !== nonce) {
    return { ok: false, reason: 'nonce_mismatch' }
  }
  if (now >= challenge.expiresAt) return { ok: false, reason: 'nonce_expired' }
  if (!isWalletAddress(walletAddress)) return { ok: false, reason: 'bad_wallet' }
  if (challenge.address !== walletAddress) return { ok: false, reason: 'wallet_mismatch' }
  const bytes = signatureBytes(signature)
  if (!bytes) return { ok: false, reason: 'bad_signature' }
  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode(challenge.message),
    bytes,
    new PublicKey(walletAddress).toBytes()
  )
  return { ok, reason: ok ? 'ok' : 'signature_invalid' }
}

export function createWalletSession() {
  return {
    generation: 0,
    verified: null,
    challenge: null,
    lastChallengeAt: 0,
    challengeCooldownReplied: false,
    balanceBucket: { tokens: 3, at: Date.now() },
    pendingBalance: null,
    builderRecheckAt: 0,
  }
}

// Only token-granted builders enter this map, which keys session upload limits.
// Wallet verification for other ranks stays on the socket, never in player data.
const wallets = new Map()
export const recordWallet = (socketId, walletAddress) => {
  wallets.set(socketId, walletAddress)
}
export const walletOf = socketId => wallets.get(socketId) || null
export const clearWallet = socketId => {
  wallets.delete(socketId)
}
export const clearSocket = socketId => {
  wallets.delete(socketId)
}
