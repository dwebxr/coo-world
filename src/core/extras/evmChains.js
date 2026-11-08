// EVM ウォレット接続の共通ヘルパー (クライアント・サーバー共用、依存なし)

// PUBLIC_EVM_CHAIN_IDS (例 "137" や "137,1") を解析する。
// 1 つでも不正な値があれば全体を無効 (空配列) にして、半端な設定で動かさない
export function parseEvmChainIds(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return []
  const ids = []
  for (const part of raw.split(',')) {
    const value = part.trim()
    if (!/^[1-9]\d{0,15}$/.test(value)) return []
    const id = Number(value)
    if (!Number.isSafeInteger(id)) return []
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

// 20 バイトの 16 進アドレス。大文字小文字は問わない (チェックサムはサーバーが付け直す)
export const isEvmAddress = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)

// EOA の personal_sign 署名 (r, s, v の 65 バイト)
export const isEvmSignature = value => typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value)

// A sign-in signature: an EOA's 65 bytes, or a contract account's (EIP-1271, EIP-6492 wrapped) up to 4096 bytes.
// WebAuthn signatures wrapped for an undeployed account come to 1-2 KB.
export const MAX_EVM_SIGNATURE_BYTES = 4096
export const isEvmSigninSignature = value =>
  typeof value === 'string' &&
  value.length >= 4 &&
  value.length <= 2 + MAX_EVM_SIGNATURE_BYTES * 2 &&
  /^0x(?:[0-9a-fA-F]{2})+$/.test(value)

export const sameEvmAddress = (a, b) => isEvmAddress(a) && isEvmAddress(b) && a.toLowerCase() === b.toLowerCase()

// evmWalletStatus.reason として送る値
// contract_unsupported: not an EOA signature, and this world cannot check contract accounts (no RPC for the chain).
// unavailable: the contract check could not run just now (busy, timeout, RPC failure)
export const EVM_STATUS_REASONS = Object.freeze([
  'ok',
  'nonce_expired',
  'signature_invalid',
  'contract_unsupported',
  'unavailable',
  'bad_request',
])
