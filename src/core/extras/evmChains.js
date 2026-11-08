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

export const sameEvmAddress = (a, b) => isEvmAddress(a) && isEvmAddress(b) && a.toLowerCase() === b.toLowerCase()

// evmWalletStatus.reason として送る値
export const EVM_STATUS_REASONS = Object.freeze(['ok', 'nonce_expired', 'signature_invalid', 'bad_request'])
