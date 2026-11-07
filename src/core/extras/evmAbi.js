// 最小限の EVM ABI エンコード / デコード (クライアント・サーバー共用、依存なし)。
// サーバーは SES lockdown 下で viem のルートを読めず、クライアントには viem を入れないため自前で持つ。
// セレクタは test/evmAbi.test.js で keccak256 から再計算して固定している

import { isEvmAddress } from './evmChains.js'

export const UINT256_MAX = (1n << 256n) - 1n

// keccak256('Transfer(address,address,uint256)')
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export const SELECTORS = Object.freeze({
  transfer: '0xa9059cbb', // transfer(address,uint256)
  balanceOf: '0x70a08231', // balanceOf(address)  (ERC-20 / ERC-721)
  ownerOf: '0x6352211e', // ownerOf(uint256)  (ERC-721)
  balanceOf1155: '0x00fdd58e', // balanceOf(address,uint256)  (ERC-1155)
})

const word = hex => hex.padStart(64, '0')

export function encodeAddressWord(address) {
  if (!isEvmAddress(address)) throw new Error('invalid address')
  return word(address.slice(2).toLowerCase())
}

export function encodeUintWord(value) {
  if (typeof value !== 'bigint' || value < 0n || value > UINT256_MAX) throw new Error('invalid uint256')
  return word(value.toString(16))
}

export const encodeTransfer = (to, units) => `${SELECTORS.transfer}${encodeAddressWord(to)}${encodeUintWord(units)}`
export const encodeBalanceOf = owner => `${SELECTORS.balanceOf}${encodeAddressWord(owner)}`
export const encodeOwnerOf = tokenId => `${SELECTORS.ownerOf}${encodeUintWord(tokenId)}`
export const encodeBalanceOf1155 = (owner, id) =>
  `${SELECTORS.balanceOf1155}${encodeAddressWord(owner)}${encodeUintWord(id)}`

// 32 バイトちょうどの戻り値だけを受ける (短い・長い・16 進でないものは不正)
export function decodeUint256(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('invalid uint256 word')
  return BigInt(hex)
}

// 上位 12 バイトが 0 のアドレス語だけを受け、小文字の 0x アドレスで返す
export function decodeAddressWord(hex) {
  if (typeof hex !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(hex)) throw new Error('invalid address word')
  return `0x${hex.slice(26).toLowerCase()}`
}

// "100", "0.5", "1.000001" を最小単位の BigInt にする。指数表記・符号・空・小数部が decimals を超えるものは不正
export function parseUnits(amount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('invalid decimals')
  if (typeof amount !== 'string' || amount.length > 100) throw new Error('invalid amount')
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim())
  if (!match) throw new Error('invalid amount')
  const [, whole, fraction = ''] = match
  if (fraction.length > decimals) throw new Error('too many decimals')
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  if (units > UINT256_MAX) throw new Error('invalid amount')
  return units
}

// 最小単位から 10 進の文字列 (末尾の 0 は落とす)
export function formatUnits(units, decimals) {
  if (typeof units !== 'bigint' || units < 0n) throw new Error('invalid units')
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('invalid decimals')
  const base = 10n ** BigInt(decimals)
  const whole = units / base
  const fraction = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : `${whole}`
}

// tokenId: 10 進文字列、0x の 16 進文字列、または安全整数。OpenPay の tokenId は 256 ビットなので 16 進文字列で渡す
export function parseTokenId(value) {
  let id
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid tokenId')
    id = BigInt(value)
  } else if (typeof value === 'string' && /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(value)) {
    id = BigInt(value)
  } else {
    throw new Error('invalid tokenId')
  }
  if (id > UINT256_MAX) throw new Error('invalid tokenId')
  return id
}

export const isTxHash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
