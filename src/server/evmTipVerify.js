// 投げゼニのレシート照合 (純関数)。クライアントの申告は使わず、チケットに控えた値だけと突き合わせる。
// receipt.from / receipt.to は見ない: EIP-7702 の一括実行・スポンサー付き tx・ERC-4337 では論理的な送り手と
// 一致しない。送り手はトークンのコントラクトが出した Transfer ログの topics[1] で確かめる
import { TRANSFER_TOPIC, decodeAddressWord, decodeUint256 } from '../core/extras/evmAbi.js'

const MAX_LOGS = 1024
const lower = value => (typeof value === 'string' ? value.toLowerCase() : value)
const quantity = value => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return null
  return BigInt(value)
}
const hash32 = value => (typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null)
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value)

// 戻り値: { state: 'pending' } (まだ無い) / { state: 'failed', reason } /
// { state: 'matched', blockNumber (BigInt), blockHash, logIndex (BigInt または null) }
export function matchTipReceipt(receipt, { txHash, from, recipient, token, units }) {
  if (receipt === null) return { state: 'pending' }
  if (!isPlainObject(receipt)) return { state: 'failed', reason: 'bad_receipt' }
  const hash = hash32(txHash)
  // 別の tx のレシートを返す (壊れた・中継の) RPC を信じない
  if (!hash || hash32(receipt.transactionHash) !== hash) return { state: 'failed', reason: 'bad_receipt' }
  const blockNumber = quantity(receipt.blockNumber)
  const blockHash = hash32(receipt.blockHash)
  if (blockNumber === null || blockHash === null) return { state: 'failed', reason: 'bad_receipt' }
  if (receipt.status !== '0x1') return { state: 'failed', reason: 'reverted' }
  if (!Array.isArray(receipt.logs) || receipt.logs.length > MAX_LOGS) return { state: 'failed', reason: 'bad_receipt' }
  for (const log of receipt.logs) {
    if (!isPlainObject(log) || lower(log.address) !== lower(token) || log.removed === true) continue
    // ログ側にあれば、同じ tx・同じブロックのものであること
    if (log.transactionHash !== undefined && hash32(log.transactionHash) !== hash) continue
    if (log.blockHash !== undefined && hash32(log.blockHash) !== blockHash) continue
    const topics = log.topics
    if (!Array.isArray(topics) || topics.length !== 3 || lower(topics[0]) !== TRANSFER_TOPIC) continue
    try {
      if (decodeAddressWord(topics[1]) !== lower(from)) continue
      if (decodeAddressWord(topics[2]) !== lower(recipient)) continue
      // 金額は完全一致 (手数料を引くトークンは一致しない)
      if (decodeUint256(log.data) !== units) continue
    } catch {
      continue
    }
    return { state: 'matched', blockNumber, blockHash, logIndex: quantity(log.logIndex) }
  }
  return { state: 'failed', reason: 'no_transfer' }
}

// eth_getBlockByNumber('finalized', false) の結果からブロック番号を取る (形が違えば null)
export function finalizedNumber(block) {
  if (!isPlainObject(block)) return null
  return quantity(block.number)
}

// 確定済みの高さにある tx のブロックを確かめる。
// ok / reorged (同じ高さに別のブロック) / too_old (チケット発行より前) / missing / bad_block
export function checkTipBlock(block, { blockNumber, blockHash, notBeforeSec }) {
  if (block === null) return 'missing'
  if (!isPlainObject(block) || quantity(block.number) !== blockNumber) return 'bad_block'
  const hash = hash32(block.hash)
  const timestamp = quantity(block.timestamp)
  if (hash === null || timestamp === null) return 'bad_block'
  if (hash !== lower(blockHash)) return 'reorged'
  if (timestamp < BigInt(Math.floor(notBeforeSec))) return 'too_old'
  return 'ok'
}
