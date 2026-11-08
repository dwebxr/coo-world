// NFT 保有判定 (ERC-721 / ERC-1155)。キャッシュ・同時数・全体の予算は tokenBalance.js のサービスを
// decimals 0 で流用する (同じキーへの同時要求は 1 本にまとまり、予算を超えたら待たずに unknown)
import {
  decodeAddressWord,
  decodeUint256,
  encodeBalanceOf,
  encodeBalanceOf1155,
  encodeOwnerOf,
  parseTokenId,
} from '../core/extras/evmAbi.js'
import { isEvmAddress } from '../core/extras/evmChains.js'
import { createTokenBalanceService } from './tokenBalance.js'

const STANDARDS = ['erc721', 'erc1155']

// スクリプトから来た spec を、キャッシュのキーに使える正規形にする。不正なら null。
// contract とアドレスは小文字、tokenId は 10 進 (0x01 と 1 が同じ項目になる)
export function normalizeHoldingSpec(spec, chainIds) {
  if (!spec || typeof spec !== 'object') return null
  const { chainId, contract, standard, tokenId } = spec
  if (!Number.isSafeInteger(chainId) || !chainIds.has(chainId)) return null
  if (!isEvmAddress(contract)) return null
  if (!STANDARDS.includes(standard)) return null
  let id = ''
  if (tokenId !== undefined && tokenId !== null && tokenId !== '') {
    try {
      id = parseTokenId(tokenId).toString()
    } catch {
      return null
    }
  }
  if (standard === 'erc1155' && id === '') return null
  return { chainId, contract: contract.toLowerCase(), standard, tokenId: id }
}

export const holdingKey = (spec, owner) =>
  [spec.chainId, spec.contract, spec.standard, spec.tokenId, owner.toLowerCase()].join('|')

export function createEvmHoldingService({ rpcs, ttlMs = 30_000, ...budget }) {
  async function readRaw(key, signal) {
    const [chainText, contract, standard, tokenId, owner] = key.split('|')
    const rpc = rpcs.get(Number(chainText))
    if (!rpc) throw new Error('no RPC for chain')
    let data
    if (standard === 'erc1155') data = encodeBalanceOf1155(owner, BigInt(tokenId))
    else if (tokenId) data = encodeOwnerOf(BigInt(tokenId))
    else data = encodeBalanceOf(owner)
    const result = await rpc.call('eth_call', [{ to: contract, data }, 'latest'], signal)
    // ERC-721 の ownerOf は所有者のアドレス。一致すれば 1、違えば 0 (存在しない tokenId の revert は unknown)
    if (standard === 'erc721' && tokenId) return { exists: true, amount: decodeAddressWord(result) === owner ? 1n : 0n }
    return { exists: true, amount: decodeUint256(result) }
  }
  const service = createTokenBalanceService({ readRaw, decimals: 0, ttlMs, ...budget })
  return {
    enabled: rpcs.size > 0,
    // 戻り値は { known, balance } (失敗・予算超過・不正な spec は known: false)
    get(owner, spec) {
      const normalized = normalizeHoldingSpec(spec, rpcs)
      if (!normalized || !isEvmAddress(owner)) return Promise.resolve({ known: false })
      return service.get(holdingKey(normalized, owner))
    },
  }
}
