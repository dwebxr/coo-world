// 投げゼニのレシート照合 (純関数)。クライアントの申告は使わず、quote に控えた値だけと突き合わせる
import { TRANSFER_TOPIC, decodeAddressWord, decodeUint256 } from '../core/extras/evmAbi.js'

const lower = value => (typeof value === 'string' ? value.toLowerCase() : value)
const quantity = value => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return null
  return BigInt(value)
}

// 戻り値: { state: 'pending' } (まだ無い) / { state: 'failed', reason } / { state: 'matched', blockNumber }
export function matchTipReceipt(receipt, { from, recipient, token, units }) {
  if (receipt === null) return { state: 'pending' }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    return { state: 'failed', reason: 'bad_receipt' }
  const blockNumber = quantity(receipt.blockNumber)
  if (blockNumber === null) return { state: 'failed', reason: 'bad_receipt' }
  if (receipt.status !== '0x1') return { state: 'failed', reason: 'reverted' }
  if (lower(receipt.from) !== lower(from)) return { state: 'failed', reason: 'wrong_sender' }
  if (lower(receipt.to) !== lower(token)) return { state: 'failed', reason: 'wrong_contract' }
  if (!Array.isArray(receipt.logs) || receipt.logs.length > 256) return { state: 'failed', reason: 'bad_receipt' }
  for (const log of receipt.logs) {
    if (!log || lower(log.address) !== lower(token) || log.removed === true) continue
    const topics = log.topics
    if (!Array.isArray(topics) || topics.length !== 3 || lower(topics[0]) !== TRANSFER_TOPIC) continue
    try {
      if (decodeAddressWord(topics[1]) !== lower(from)) continue
      if (decodeAddressWord(topics[2]) !== lower(recipient)) continue
      if (decodeUint256(log.data) !== units) continue
    } catch {
      continue
    }
    return { state: 'matched', blockNumber }
  }
  return { state: 'failed', reason: 'no_transfer' }
}

// eth_getBlockByNumber('finalized', false) の結果からブロック番号を取る (形が違えば null)
export function finalizedNumber(block) {
  if (!block || typeof block !== 'object') return null
  return quantity(block.number)
}
