// 投げゼニに使うトークンの設定 (クライアント・サーバー共用、依存なし)
import { parseUnits } from './evmAbi.js'
import { isEvmAddress } from './evmChains.js'

// 金額の文法 (送金の意思表示とクライアントで同じものを使う): 数字、任意で 1 つの小数点と decimals 桁以内の小数部。
// 整数部は 18 桁まで、符号・指数・区切り文字は不可。最小額以上
export function parseTipAmount(amount, token) {
  if (typeof amount !== 'string' || !/^\d{1,18}(\.\d+)?$/.test(amount)) throw new Error('invalid amount')
  const units = parseUnits(amount, token.decimals)
  if (units < parseUnits(token.min, token.decimals)) throw new Error('below minimum')
  return units
}

// 組み込み表: オンチェーンで decimals を確認したもの (goals/phase3-evm-tips-gates-design.md §2)
export const KNOWN_TOKENS = Object.freeze({
  137: Object.freeze({
    JPYC: Object.freeze({
      symbol: 'JPYC',
      address: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
      decimals: 18,
      min: '1',
    }),
    USDC: Object.freeze({
      symbol: 'USDC',
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      decimals: 6,
      min: '0.01',
    }),
  }),
})

// wallet_addEthereumChain に渡せる組み込みチェーン (それ以外のチェーンは追加を提案しない)
export const KNOWN_CHAINS = Object.freeze({
  137: Object.freeze({
    chainId: '0x89',
    chainName: 'Polygon Mainnet',
    nativeCurrency: Object.freeze({ name: 'POL', symbol: 'POL', decimals: 18 }),
    rpcUrls: Object.freeze(['https://polygon-rpc.com']),
    blockExplorerUrls: Object.freeze(['https://polygonscan.com']),
  }),
})

export const explorerTxUrl = (chainId, txHash) => {
  const base = KNOWN_CHAINS[chainId]?.blockExplorerUrls[0]
  return base ? `${base}/tx/${txHash}` : null
}

// PUBLIC_EVM_TIP_TOKENS: "JPYC,USDC" (組み込み表の記号) か "SYMBOL:0xaddress:decimals[:min]" の明示指定。
// 記号は英大文字と数字 1〜11 文字、decimals は 0〜18、min (最小額、10 進) の既定は最小単位 1。
// 1 つでも不正なら全体を無効 (空) にする。記号・アドレスは重複不可
export function parseTipTokens(raw, chainId) {
  if (typeof raw !== 'string' || !raw.trim() || !Number.isSafeInteger(chainId)) return []
  const tokens = []
  for (const part of raw.split(',')) {
    const entry = part.trim()
    let token
    const custom = /^([A-Z0-9]{1,11}):(0x[0-9a-fA-F]{40}):(\d{1,2})(?::(\d{1,18}(?:\.\d{1,18})?))?$/.exec(entry)
    if (custom) {
      const decimals = Number(custom[3])
      if (decimals > 18 || !isEvmAddress(custom[2])) return []
      const min = custom[4] ?? (decimals ? `0.${'0'.repeat(decimals - 1)}1` : '1')
      try {
        if (parseUnits(min, decimals) < 1n) return []
      } catch {
        return []
      }
      token = { symbol: custom[1], address: custom[2], decimals, min }
    } else if (/^[A-Z0-9]{1,11}$/.test(entry)) {
      token = KNOWN_TOKENS[chainId]?.[entry]
      if (!token) return []
    } else {
      return []
    }
    if (
      tokens.some(other => other.symbol === token.symbol || other.address.toLowerCase() === token.address.toLowerCase())
    ) {
      return []
    }
    tokens.push(Object.freeze({ ...token }))
  }
  return tokens
}
