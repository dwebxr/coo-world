// サーバー専用の EVM JSON-RPC クライアント。作法は solanaRpc.js と同じ:
// URL (資格情報を含み得る) をログに出さない、http/https のみ、本文は上限付きで逐次読む、
// グローバル fetch を使う (fetch guard の Brotli 拒否を通す)
import { parseEvmChainIds } from '../core/extras/evmChains.js'

// 起動後に一度 eth_chainId を確かめる。食い違えばその URL は使わない (別チェーンの結果を信じない)
const CHAIN_RECHECK_MS = 60_000

export function createEvmRpc({
  url,
  chainId,
  fetch = globalThis.fetch,
  log = console,
  maxBodyBytes = 262_144,
  now = Date.now,
} = {}) {
  let endpoint
  try {
    endpoint = new URL(url)
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') throw new Error('invalid protocol')
  } catch {
    endpoint = null
    // URL もパーサーのエラーも出さない (どちらも資格情報を含み得る)
    log.error(`[evmRpc] invalid RPC URL for chain ${chainId}; EVM reads disabled for it`)
  }
  let nextId = 0
  // null: 未確認、true: 一致、false: 不一致 (恒久)、{ at }: 確認に失敗 (少し後に再試行)
  let chainState = null

  async function raw(method, params, signal) {
    if (!endpoint) throw new Error('invalid RPC URL')
    signal?.throwIfAborted()
    const id = ++nextId
    const response = await fetch(endpoint.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal,
    })
    let reader
    let body
    try {
      signal?.throwIfAborted()
      if (response.status !== 200) throw new Error('RPC HTTP failure')
      const length = response.headers.get('content-length')
      if (length !== null && Number(length) > maxBodyBytes) throw new Error('RPC body too large')
      reader = response.body.getReader()
      const chunks = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        signal?.throwIfAborted()
        if (done) break
        size += value.byteLength
        if (size > maxBodyBytes) throw new Error('RPC body too large')
        chunks.push(value)
      }
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
    } catch (err) {
      if (reader) await reader.cancel().catch(() => {})
      else await response.body?.cancel().catch(() => {})
      throw err
    } finally {
      reader?.releaseLock()
    }
    if (
      !body ||
      body.jsonrpc !== '2.0' ||
      body.id !== id ||
      Object.hasOwn(body, 'error') ||
      !Object.hasOwn(body, 'result')
    ) {
      throw new Error('invalid RPC response')
    }
    return body.result
  }

  async function ensureChain(signal) {
    if (chainState === true) return
    if (chainState === false) throw new Error('RPC chain mismatch')
    if (chainState && now() - chainState.at < CHAIN_RECHECK_MS) throw new Error('RPC chain unknown')
    let result
    try {
      result = await raw('eth_chainId', [], signal)
    } catch (err) {
      chainState = { at: now() }
      throw err
    }
    if (typeof result === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(result) && Number(BigInt(result)) === chainId) {
      chainState = true
      return
    }
    chainState = false
    log.error(`[evmRpc] RPC for chain ${chainId} reports a different chain; EVM reads disabled for it`)
    throw new Error('RPC chain mismatch')
  }

  async function call(method, params, signal) {
    await ensureChain(signal)
    return raw(method, params, signal)
  }

  return { chainId, call, enabled: !!endpoint }
}

// EVM_RPC_URL_<chainId> を、PUBLIC_EVM_CHAIN_IDS に含まれるチェーンについてだけ読む
export function createEvmRpcs(env = process.env, { fetch, log = console } = {}) {
  const rpcs = new Map()
  for (const chainId of parseEvmChainIds(env.PUBLIC_EVM_CHAIN_IDS)) {
    const url = env[`EVM_RPC_URL_${chainId}`]
    if (!url) continue
    const rpc = createEvmRpc({ url, chainId, fetch, log })
    if (rpc.enabled) rpcs.set(chainId, rpc)
  }
  return rpcs
}
