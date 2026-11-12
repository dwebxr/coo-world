import { randomBytes } from 'node:crypto'
// サーバーは SES lockdown 下で動く。viem のルート ('viem') は読み込み時に凍結済みの Function.prototype.call へ
// 代入して落ちるので、lockdown 下で読み込めるサブパスだけを使う (test/evmGating.test.js で確認)
import { concatHex, encodeAbiParameters, getAddress, hashMessage, verifyMessage } from 'viem/utils'
import { createSiweMessage } from 'viem/siwe'
import {
  isEvmAddress,
  isEvmSignature,
  isEvmSigninSignature,
  parseEvmChainIds,
  sameEvmAddress,
} from '../core/extras/evmChains.js'
import { createLogOnce } from '../core/extras/logOnce.js'
import { readConnectionLimitsEnv } from './connectionLimits.js'
import { erc6492CallData } from './erc6492.js'
import { RpcError } from './evmRpc.js'
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
export { isEvmAddress, isEvmSignature, isEvmSigninSignature, sameEvmAddress }

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

// 署名の確認 (Phase 6、goals/phase6-smart-wallet-siwe-design.md):
// 1. 65 バイトなら EOA として復元して比べる (RPC は使わない)。
// 2. 合わなければ、コントラクトのアカウント (EIP-1271、未デプロイなら EIP-6492) としてチェーンで確かめる。
//    verifyContract はサインインチェーンの RPC があるときだけ渡される (createEvmSignatureVerifier)。
//    Safe の 1-of-1 のように、65 バイトでも持ち主の鍵に復元されるコントラクト署名があるので、2 も試す。
// 例外は投げない: 返事が出ないと、クライアントは ack を最後まで待つことになる
export async function checkEvmChallenge(challenge, { address, signature, nonce }, now, { verifyContract } = {}) {
  if (!challenge) return { ok: false, reason: 'no_nonce' }
  if (!isWalletNonce(nonce) || challenge.nonce !== nonce) return { ok: false, reason: 'nonce_mismatch' }
  if (now >= challenge.expiresAt) return { ok: false, reason: 'nonce_expired' }
  if (!isEvmAddress(address)) return { ok: false, reason: 'bad_wallet' }
  if (!sameEvmAddress(address, challenge.address)) return { ok: false, reason: 'wallet_mismatch' }
  // the validator's ecrecover gives the zero address for any unrecoverable signature, so nobody may sign in as it
  if (isZeroAddress(challenge.address)) return { ok: false, reason: 'bad_wallet' }
  if (!isEvmSigninSignature(signature)) return { ok: false, reason: 'bad_signature' }
  const eoaLength = isEvmSignature(signature)
  if (eoaLength) {
    try {
      if (await verifyMessage({ address: challenge.address, message: challenge.message, signature })) {
        return { ok: true, reason: 'ok' }
      }
    } catch {
      // 復元できない署名 (v が範囲外など): コントラクトとして確かめる
    }
  }
  // チェーンを読めない world では、65 バイトの失敗は署名の誤り、それ以外はコントラクトの署名とみなす
  if (typeof verifyContract !== 'function') {
    return { ok: false, reason: eoaLength ? 'signature_invalid' : 'contract_unsupported' }
  }
  try {
    const result = await verifyContract({
      address: challenge.address,
      hash: hashMessage(challenge.message),
      signature,
    })
    // a contract account is verified on the sign-in chain only (its owners may differ on other chains)
    if (result?.ok === true) return { ok: true, reason: 'ok', contract: true }
    return { ok: false, reason: typeof result?.reason === 'string' ? result.reason : 'rpc_unexpected' }
  } catch {
    return { ok: false, reason: 'rpc_error' }
  }
}

// クライアントへ返す理由は固定の語彙に丸める
const UNAVAILABLE_REASONS = new Set(['unavailable', 'rpc_busy', 'rpc_timeout', 'rpc_error', 'rpc_unexpected'])
export function publicReason(reason) {
  if (reason === 'ok' || reason === 'nonce_expired' || reason === 'contract_unsupported') return reason
  if (reason === 'signature_invalid' || reason === 'bad_signature') return 'signature_invalid'
  if (UNAVAILABLE_REASONS.has(reason)) return 'unavailable'
  return 'bad_request'
}

export const isZeroAddress = address => isEvmAddress(address) && /^0x0{40}$/.test(address)

// EIP-1271 の isValidSignature(bytes32,bytes) と、成功時の戻り値 (bytes4 の magic を 32 バイトに詰めたもの)
const ERC1271_SELECTOR = '0x1626ba7e'
const ERC1271_MAGIC_WORD = /^0x1626ba7e0{56}$/i
// ERC-6492 の検証器は署名の末尾 32 バイトを読むので、それより短い署名はコントラクトへ直接聞く
const SHORT_SIGNATURE_BYTES = 32

// コントラクトのアカウントの署名を、ERC-6492 の汎用検証器を deployless の eth_call で動かして確かめる
// (32 バイト未満の署名は、デプロイ済みのアカウントの isValidSignature を直接呼ぶ)。
// ノードの答えのうち revert (RpcError.reverted) だけが「署名が通らない」で、ほかの誤り (レート制限、
// to のない eth_call を受け付けない、状態が読めない、等) は確認できなかったものとして扱う。
// 予算はサーバー全体で 1 つ: 同時に maxConcurrent 件まで、毎秒 ratePerSecond 件 (最大 burst 件まで貯まる)。
// 超えたら待たずに rpc_busy。factory の呼び出しも含め、ノードの中で動くだけで状態は変わらない。
// gas で 1 回あたりの仕事を抑える (パスキーの検証とアカウントのデプロイには十分な量)
export function createEvmSignatureVerifier({
  rpc,
  maxConcurrent = 4,
  ratePerSecond = 0.5,
  burst = 10,
  timeoutMs = 8000,
  gas = 10_000_000,
  now = Date.now,
  timeoutSignal = ms => AbortSignal.timeout(ms),
  log = console.warn,
} = {}) {
  if (!rpc || typeof rpc.call !== 'function') return null
  const logOnce = createLogOnce(log)
  const subject = {}
  let active = 0
  let tokens = burst
  let bucketAt = now()
  const fail = (reason, key, message) => {
    // アドレス・署名・呼び出しデータ・ノードのメッセージ (URL を含み得る) は出さない
    logOnce(subject, key, `[evm] contract signature check: ${message}`)
    return { ok: false, reason }
  }
  return async function verifyContract({ address, hash, signature }) {
    const at = now()
    tokens = Math.min(burst, tokens + (Math.max(0, at - bucketAt) * ratePerSecond) / 1000)
    bucketAt = at
    if (active >= maxConcurrent || tokens < 1) return fail('rpc_busy', 'busy', 'over budget, refused')
    tokens--
    active++
    const short = (signature.length - 2) / 2 < SHORT_SIGNATURE_BYTES
    let result
    try {
      const call = short
        ? {
            to: address,
            data: concatHex([
              ERC1271_SELECTOR,
              encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }], [hash, signature]),
            ]),
          }
        : { data: erc6492CallData(address, hash, signature) }
      result = await rpc.call(
        'eth_call',
        [{ ...call, gas: `0x${gas.toString(16)}` }, 'latest'],
        timeoutSignal(timeoutMs)
      )
    } catch (err) {
      if (err instanceof RpcError) {
        if (err.reverted) return { ok: false, reason: 'signature_invalid' }
        return fail('rpc_error', `rpc:${err.code}`, `the node answered with error code ${err.code}`)
      }
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        return fail('rpc_timeout', 'timeout', `no answer within ${timeoutMs} ms`)
      }
      return fail('rpc_error', 'transport', 'the RPC request failed')
    } finally {
      active--
    }
    if (short && typeof result === 'string') {
      if (ERC1271_MAGIC_WORD.test(result)) return { ok: true, reason: 'ok' }
      // any other 32-byte answer, or none at all (no code at the address: an EOA cannot sign this short)
      if (/^0x(?:[0-9a-fA-F]{64})?$/.test(result)) return { ok: false, reason: 'signature_invalid' }
    }
    if (!short && typeof result === 'string' && /^0x01$/i.test(result)) return { ok: true, reason: 'ok' }
    if (!short && typeof result === 'string' && /^0x00$/i.test(result))
      return { ok: false, reason: 'signature_invalid' }
    // the node did not run the validator as an init call (another shape of answer)
    return fail('rpc_unexpected', 'shape', 'unexpected eth_call result shape')
  }
}

export function createEvmWalletSession(now = Date.now()) {
  return {
    generation: 0,
    verified: null,
    // the verified address is a contract account (proven on the sign-in chain only)
    verifiedContract: false,
    challenge: null,
    lastChallengeAt: 0,
    challengeCooldownReplied: false,
    receiveTips: false,
    receiveChangedAt: 0,
    intentBucket: { tokens: TIP_INTENT_BURST, at: now },
    // 発行した tip intent の控え (チケット)。ticket → 控え。上限は TIP_TICKETS_PER_SOCKET
    tickets: new Map(),
  }
}

// tip intent のチケット (サーバーが作る 16 バイトの 16 進)
export const createTipTicket = () => randomBytes(16).toString('hex')
export const isTipTicket = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)

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

// 投げ銭のトークン (チェーンは SIWE と同じ先頭チェーン)。不正な設定は全体を無効にしてログを出す
export function resolveTipTokens(env = process.env, chainId, { log = console } = {}) {
  if (chainId === null) return []
  const tokens = parseTipTokens(env.PUBLIC_EVM_TIP_TOKENS, chainId)
  if (!tokens.length && env.PUBLIC_EVM_TIP_TOKENS?.trim()) {
    log.error(
      '[evm] PUBLIC_EVM_TIP_TOKENS is invalid for the sign-in chain (built-in symbols or SYMBOL:0xaddress:decimals[:min[:max]]); tips disabled'
    )
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
// 確定確認 (P2b): チケットは 10 分、ソケットあたり 3 件。監視はソケットあたり 2 件。
// 数えた送金 (txHash と送り手) は 30 分 (上限 4096 件) 覚える。メモリの中だけ。
// 確定したブロックの時刻はチケット発行の 30 秒前まで認める (時計のずれ)。ただしサーバーの起動時刻より前は認めない
// (ServerNetwork.js の tipFloorSec)
export const TIP_TICKET_TTL_MS = 600_000
export const TIP_TICKETS_PER_SOCKET = 3
export const TIP_WATCH_PER_SOCKET = 2
// The watch table of the whole world: 2 jobs for each connection the server admits (WS_MAX_SOCKETS, 64 unless set:
// 128 jobs). It was 16, which 8 connections filled, and one address may hold 8. With WS_MAX_SOCKETS=0 (no limit on
// connections) there is no number to derive it from: the table is then 2 x the default, and can be full while a
// connection has reported nothing. A job is about 1.1 KB of heap with its hash and ticket (measured), so 128 jobs are
// about 0.14 MB and the table grows by about 2.2 KB per admitted connection.
// What this is: room in the table. It is not a share of the chain calls: those stay one budget for all jobs
// (evmTipWatcher.js), so reports from many connections still delay every confirmation.
// A bad WS_* value throws here as it does in index.js, which reads the same variables at start-up.
export function resolveTipWatchMax(env = process.env) {
  const { maxSockets } = readConnectionLimitsEnv(env)
  // the connection limit admits ceil(maxSockets) connections (connectionLimits.js): the table has room for each
  return TIP_WATCH_PER_SOCKET * Math.ceil(maxSockets > 0 ? maxSockets : readConnectionLimitsEnv({}).maxSockets)
}
export const TIP_WATCH_MAX = resolveTipWatchMax()
export const TIP_SEEN_TTL_MS = 1_800_000
export const TIP_SEEN_MAX = 4096
export const TIP_TIME_SKEW_SEC = 30
// 告知: 全体で 3 秒に 1 件 (バースト 3)、待ちは 20 件まで、同じ送り手は 30 秒に 1 回
export const TIP_ANNOUNCE_INTERVAL_MS = 3_000
export const TIP_ANNOUNCE_BURST = 3
export const TIP_ANNOUNCE_QUEUE = 20
export const TIP_ANNOUNCE_COOLDOWN_MS = 30_000
