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

// Which contracts player.getEvmHolding() may ask about.
//
// Why there is a list: the answer to a holdings read is a number the contract itself computes from the owner's
// address. With any contract allowed, a script author deployed one whose balanceOf(owner, id) returned 40 bits of
// the owner's address per token id, and four calls gave a script the verified address of every player it asked
// about. Now a read is made only against a contract the operator named; for any other the answer is "unknown" and
// the node is not asked.
//
// What the list does not do: it says nothing about what a listed contract returns. Listing a contract trusts its
// balanceOf / ownerOf not to encode the owner; an upgradeable contract, or one its operator controls, can start
// doing so later. A listed ERC-721 answers ownerOf(id) for every id, so a script that asks id by id learns which
// token a player holds, and the chain says which address owns that token.
//
// The default when EVM_HOLDING_CONTRACTS is not set: OpenPay's license contract on Polygon, the one the shipped
// door (docs/scripting/examples/nft-door.js, OPENPAY_LICENSE_CONTRACT) asks about. Setting the variable replaces
// the default, it does not add to it.
export const DEFAULT_HOLDING_CONTRACTS = Object.freeze([
  Object.freeze({ chainId: 137, contract: '0x1c652241cc820ce897f0d8d9351df9ad8a0916cc' }),
])

const HOLDING_CONTRACTS_FORM =
  'a comma-separated list of chainId:0xaddress (for example 137:0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc), ' +
  'or empty to allow no contract'

export const holdingContractKey = (chainId, contract) => `${chainId}:${contract.toLowerCase()}`

// EVM_HOLDING_CONTRACTS: "137:0xaddress,1:0xaddress". Not set: the default above. Set and empty (or only spaces):
// no contract. Addresses are compared without regard to case; an entry written twice counts once. One entry that
// is not chainId:0xaddress throws at start-up: a list that is partly read would allow other contracts than the
// ones written. The value is not printed (only the number of the entry that is wrong).
export function readHoldingContractsEnv(env) {
  const raw = env.EVM_HOLDING_CONTRACTS
  if (raw === undefined) return DEFAULT_HOLDING_CONTRACTS
  if (typeof raw !== 'string') throw new Error(`[envs] EVM_HOLDING_CONTRACTS must be ${HOLDING_CONTRACTS_FORM}`)
  if (!raw.trim()) return Object.freeze([])
  const contracts = []
  const seen = new Set()
  for (const [index, part] of raw.split(',').entries()) {
    const match = /^([1-9]\d{0,15}):(0x[0-9a-fA-F]{40})$/.exec(part.trim())
    const chainId = match ? Number(match[1]) : NaN
    if (!Number.isSafeInteger(chainId)) {
      throw new Error(
        `[envs] EVM_HOLDING_CONTRACTS: entry ${index + 1} is not chainId:0xaddress. It must be ${HOLDING_CONTRACTS_FORM}`
      )
    }
    const contract = match[2].toLowerCase()
    const key = holdingContractKey(chainId, contract)
    if (seen.has(key)) continue
    seen.add(key)
    contracts.push(Object.freeze({ chainId, contract }))
  }
  return Object.freeze(contracts)
}

// "137:0x…, 1:0x…" for the start-up line and the docs
export const describeHoldingContracts = contracts =>
  contracts.map(({ chainId, contract }) => holdingContractKey(chainId, contract)).join(', ')

// At most this many unlisted contracts are named in the log (one line each); after them one line says that the
// rest are not named. A script chooses the contract, so without the bound it could write lines without end.
const UNLISTED_LOG_MAX = 16

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

// contracts: the list from readHoldingContractsEnv. Left out, no contract is allowed
export function createEvmHoldingService({ rpcs, contracts = [], ttlMs = 30_000, log = console, ...budget }) {
  const listed = new Set(contracts.map(({ chainId, contract }) => holdingContractKey(chainId, contract)))
  const unlistedLogged = new Set()
  let unlistedFull = false
  // one line per unlisted contract per process. The contract and the chain come from the script; the player's
  // address is not in the line
  function noteUnlisted(key) {
    if (unlistedFull || unlistedLogged.has(key)) return
    if (unlistedLogged.size === UNLISTED_LOG_MAX) {
      unlistedFull = true
      log.warn('[evm] getEvmHolding: more contracts that are not in EVM_HOLDING_CONTRACTS were asked about (not named)')
      return
    }
    unlistedLogged.add(key)
    log.warn(
      `[evm] getEvmHolding: a script asked about ${key}, which is not in EVM_HOLDING_CONTRACTS. The answer was ` +
        `"unknown" (known: false) and the chain was not asked. To allow it, add ${key} to EVM_HOLDING_CONTRACTS ` +
        `(a listed contract is trusted not to encode the owner's address in what it returns: see README)`
    )
  }
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
  const service = createTokenBalanceService({ readRaw, decimals: 0, ttlMs, log, ...budget })
  return {
    enabled: rpcs.size > 0,
    // 戻り値は { known, balance } (失敗・予算超過・不正な spec・リストにないコントラクトは known: false)
    get(owner, spec) {
      const normalized = normalizeHoldingSpec(spec, rpcs)
      if (!normalized || !isEvmAddress(owner)) return Promise.resolve({ known: false })
      // not listed: no cache entry, no budget, no call to the node
      const contractKey = holdingContractKey(normalized.chainId, normalized.contract)
      if (!listed.has(contractKey)) {
        noteUnlisted(contractKey)
        return Promise.resolve({ known: false })
      }
      return service.get(holdingKey(normalized, owner))
    },
  }
}
