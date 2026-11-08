import { randomBytes } from 'node:crypto'
// サーバーは SES lockdown 下で動く。viem のルート ('viem') は読み込み時に凍結済みの Function.prototype.call へ
// 代入して落ちるので、lockdown 下で読み込めるサブパスだけを使う (test/evmGating.test.js で確認)
import { getAddress, verifyMessage } from 'viem/utils'
import { createSiweMessage } from 'viem/siwe'
import { isEvmAddress, isEvmSignature, parseEvmChainIds, sameEvmAddress } from '../core/extras/evmChains.js'
import { parseTipTokens } from '../core/extras/evmTokens.js'
import {
  CHALLENGE_COOLDOWN_MS,
  CHALLENGE_TTL_MS,
  WALLET_HOST,
  WALLET_URI,
  isWalletNonce,
  isWalletRequestId,
} from './solana-gating.js'

// EVM 経路は solanaGating を参照しない。必要な共通値はここから再輸出する
export { CHALLENGE_COOLDOWN_MS, CHALLENGE_TTL_MS, WALLET_HOST, WALLET_URI, isWalletNonce, isWalletRequestId }
export { isEvmAddress, isEvmSignature, sameEvmAddress }

export const EVM_STATEMENT = 'Verify wallet ownership for this world. This does not authorize any transaction.'

// EIP-4361 (SIWE)。メッセージはサーバーだけが作り、検証もサーバーが保存した文字列に対して行う
export function buildEvmChallenge(address, { host, uri, chainId, now }) {
  if (!isEvmAddress(address)) throw new Error('invalid challenge')
  const checksummed = getAddress(address)
  const nonce = randomBytes(32).toString('hex')
  const expiresAt = now + CHALLENGE_TTL_MS
  const message = createSiweMessage({
    domain: host,
    address: checksummed,
    statement: EVM_STATEMENT,
    uri,
    version: '1',
    chainId,
    nonce,
    issuedAt: new Date(now),
    expirationTime: new Date(expiresAt),
  })
  if (Buffer.byteLength(message) > 1024) throw new Error('invalid challenge')
  return { nonce, message, address: checksummed, expiresAt }
}

// P1 は EOA のみ (viem トップレベルの verifyMessage は recover + 比較で RPC を使わない)
export async function checkEvmChallenge(challenge, { address, signature, nonce }, now) {
  if (!challenge) return { ok: false, reason: 'no_nonce' }
  if (!isWalletNonce(nonce) || challenge.nonce !== nonce) return { ok: false, reason: 'nonce_mismatch' }
  if (now >= challenge.expiresAt) return { ok: false, reason: 'nonce_expired' }
  if (!isEvmAddress(address)) return { ok: false, reason: 'bad_wallet' }
  if (!sameEvmAddress(address, challenge.address)) return { ok: false, reason: 'wallet_mismatch' }
  if (!isEvmSignature(signature)) return { ok: false, reason: 'bad_signature' }
  let ok = false
  try {
    ok = await verifyMessage({ address: challenge.address, message: challenge.message, signature })
  } catch {
    // 復元できない署名 (v が範囲外など) は不正として扱う
  }
  return { ok, reason: ok ? 'ok' : 'signature_invalid' }
}

// クライアントへ返す理由は固定の語彙に丸める
export function publicReason(reason) {
  if (reason === 'ok' || reason === 'nonce_expired') return reason
  if (reason === 'signature_invalid' || reason === 'bad_signature') return 'signature_invalid'
  return 'bad_request'
}

export function createEvmWalletSession(now = Date.now()) {
  return {
    generation: 0,
    verified: null,
    challenge: null,
    lastChallengeAt: 0,
    challengeCooldownReplied: false,
    receiveTips: false,
    receiveChangedAt: 0,
    intentBucket: { tokens: TIP_INTENT_BURST, at: now },
  }
}

// 起動時に設定を確定する。メッセージが作れない設定 (domain / uri の不正) なら EVM を無効にする
export function resolveEvmConfig(env = process.env, { host = WALLET_HOST, uri = WALLET_URI, log = console } = {}) {
  const chainIds = parseEvmChainIds(env.PUBLIC_EVM_CHAIN_IDS)
  const disabled = { enabled: false, chainIds: [], chainId: null }
  if (!chainIds.length) {
    if (env.PUBLIC_EVM_CHAIN_IDS?.trim()) log.error('[evm] PUBLIC_EVM_CHAIN_IDS is invalid; EVM wallets disabled')
    return disabled
  }
  // PUBLIC_API_URL / PUBLIC_WS_URL が未設定だと host はフォールバックの 'coo-world' になり、
  // SIWE の domain として受け付けられない (ページの origin とも一致しない) のでここで無効になる
  try {
    buildEvmChallenge(`0x${'0'.repeat(40)}`, { host, uri, chainId: chainIds[0], now: Date.now() })
  } catch (err) {
    const detail = String(err?.shortMessage ?? err?.message ?? err).split('\n')[0]
    log.error(
      `[evm] cannot build a sign-in message for "${host}" (${detail}); set PUBLIC_API_URL. EVM wallets disabled`
    )
    return disabled
  }
  return { enabled: true, chainIds, chainId: chainIds[0] }
}

// 投げゼニのトークン (チェーンは SIWE と同じ先頭チェーン)。不正な設定は全体を無効にしてログを出す
export function resolveTipTokens(env = process.env, chainId, { log = console } = {}) {
  if (chainId === null) return []
  const tokens = parseTipTokens(env.PUBLIC_EVM_TIP_TOKENS, chainId)
  if (!tokens.length && env.PUBLIC_EVM_TIP_TOKENS?.trim()) {
    log.error('[evm] PUBLIC_EVM_TIP_TOKENS is invalid for the sign-in chain; tips disabled')
  }
  return tokens
}

const config = resolveEvmConfig()
export const EVM_ENABLED = config.enabled
export const EVM_CHAIN_IDS = Object.freeze(config.chainIds)
export const EVM_CHAIN_ID = config.chainId
export const EVM_TIP_TOKENS = Object.freeze(resolveTipTokens(process.env, config.chainId))
// 送金の意思表示 (tip intent) の上限: ソケットあたり 3 件、10 秒に 1 件回復。受け取り切替は 1 秒に 1 回
export const TIP_INTENT_BURST = 3
export const TIP_INTENT_REFILL_MS = 10_000
export const TIP_RECEIVE_COOLDOWN_MS = 1_000
