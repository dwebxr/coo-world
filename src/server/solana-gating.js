import { Connection, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token'
import nacl from 'tweetnacl'

// フォーク専用: Solanaトークンによるビルダー権限ゲーティング (サーバー側検証)
//
// セキュリティ設計:
// - サーバーが nonce を発行し、クライアントにウォレット署名させて所有を証明させる
//   (クライアント自己申告のアドレス/残高は一切信用しない)
// - nonce は単回使用・socket バインド・TTL 失効
// - トークン残高はサーバー側で on-chain 取得する。RPC 失敗時は fail-CLOSE (付与しない)
// - リクエストは per-socket レート制限で RPC 枯渇 DoS を防ぐ

const numOr = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

// 実行時に process.env から解決 (ビルド時焼き込みではなくコンテナ起動時の値)
const TOKEN_MINT = process.env.PUBLIC_TOKEN_MINT || null
const TOKEN_DECIMALS = numOr(process.env.PUBLIC_TOKEN_DECIMALS, 6)
// サーバー専用 RPC があれば優先 (専用/有料エンドポイント推奨)。無ければ PUBLIC を流用
const RPC_URL = process.env.SOLANA_RPC_URL || process.env.PUBLIC_RPC_URL || 'https://api.devnet.solana.com'

export const TOKEN_GATING_ENABLED = !!TOKEN_MINT
export const REQUIRED_TOKEN_AMOUNT = numOr(process.env.PUBLIC_REQUIRED_TOKEN_AMOUNT, 10000)

const NONCE_TTL_MS = 60_000 // nonce 有効期限
const RATE_LIMIT_MS = 5_000 // per-socket クールダウン

let connection = null
const getConnection = () => {
  if (!connection && TOKEN_GATING_ENABLED) {
    connection = new Connection(RPC_URL, 'confirmed')
  }
  return connection
}

// socketId -> { nonce, walletAddress, expiresAt }
const nonces = new Map()
// socketId -> lastRequestMs
const lastRequest = new Map()

// per-socket レート制限。true=許可
export const checkRateLimit = socketId => {
  const now = Date.now()
  const last = lastRequest.get(socketId) || 0
  if (now - last < RATE_LIMIT_MS) return false
  lastRequest.set(socketId, now)
  return true
}

// nonce を発行して socket にバインド (base64)
export const issueNonce = (socketId, walletAddress) => {
  const nonce = Buffer.from(nacl.randomBytes(32)).toString('base64')
  nonces.set(socketId, { nonce, walletAddress, expiresAt: Date.now() + NONCE_TTL_MS })
  return nonce
}

// socketId -> the wallet that earned this session its builder rank. server-side only: it keys the upload
// limits of token-granted builders and is never written to player data, which is broadcast
const wallets = new Map()
export const recordWallet = (socketId, walletAddress) => {
  wallets.set(socketId, walletAddress)
}
export const walletOf = socketId => wallets.get(socketId) || null
export const clearWallet = socketId => {
  wallets.delete(socketId)
}

// 切断時のクリーンアップ
export const clearSocket = socketId => {
  nonces.delete(socketId)
  lastRequest.delete(socketId)
  wallets.delete(socketId)
}

const toBytes = sig => {
  if (sig instanceof Uint8Array) return sig // Buffer も該当
  if (Array.isArray(sig)) return Uint8Array.from(sig)
  if (typeof sig === 'string') return Uint8Array.from(Buffer.from(sig, 'base64'))
  if (sig && typeof sig === 'object') return Uint8Array.from(Object.values(sig))
  throw new Error('unknown signature format')
}

// nonce + 署名 + on-chain 残高を検証。{ ok, balance, reason } を返す。
// nonce は成否に関わらず単回使用 (即破棄)。RPC 失敗は fail-CLOSE。
export const verifyAndCheckBalance = async ({ socketId, walletAddress, signature, nonce }) => {
  // 1. nonce 検証 (単回使用・socket バインド・失効・アドレス一致)
  const record = nonces.get(socketId)
  nonces.delete(socketId)
  if (!record) return { ok: false, reason: 'no_nonce' }
  if (record.nonce !== nonce) return { ok: false, reason: 'nonce_mismatch' }
  if (record.walletAddress !== walletAddress) return { ok: false, reason: 'wallet_mismatch' }
  if (Date.now() > record.expiresAt) return { ok: false, reason: 'nonce_expired' }

  // 2. ウォレット所有証明 (署名検証)
  let pubkey
  try {
    pubkey = new PublicKey(walletAddress)
  } catch {
    return { ok: false, reason: 'bad_wallet' }
  }
  let sigBytes
  try {
    sigBytes = toBytes(signature)
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  const msgBytes = new TextEncoder().encode(nonce)
  let verified = false
  try {
    verified = nacl.sign.detached.verify(msgBytes, sigBytes, pubkey.toBytes())
  } catch {
    // 不正な長さの署名等で nacl が throw しても fail-CLOSE
    return { ok: false, reason: 'signature_invalid' }
  }
  if (!verified) {
    return { ok: false, reason: 'signature_invalid' }
  }

  // 3. on-chain 残高取得 (RPC 失敗は fail-CLOSE)
  const conn = getConnection()
  if (!conn || !TOKEN_MINT) return { ok: false, reason: 'not_configured' }
  let balance = 0
  try {
    const mint = new PublicKey(TOKEN_MINT)
    const ata = await getAssociatedTokenAddress(mint, pubkey)
    const account = await getAccount(conn, ata)
    balance = Number(account.amount) / Math.pow(10, TOKEN_DECIMALS)
  } catch (err) {
    // トークンアカウント未作成 = 本当に残高0 (これは検証成功として拒否理由に回す)
    if (err?.name === 'TokenAccountNotFoundError') {
      balance = 0
    } else {
      // タイムアウト/レート制限等の一時障害は付与しない (fail-close)
      console.error('[solana-gating] RPC balance check failed:', err?.message || err)
      return { ok: false, reason: 'rpc_error' }
    }
  }
  const ok = balance >= REQUIRED_TOKEN_AMOUNT
  return { ok, balance, reason: ok ? 'ok' : 'insufficient' }
}
