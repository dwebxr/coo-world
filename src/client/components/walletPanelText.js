import { Ranks } from '../../core/extras/ranks.js'

const balanceFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const formatBalance = balance => {
  const formatted = balance.toLocaleString('en-US', { maximumFractionDigits: 2 })
  // SES replaces toLocaleString with toString; Intl is still available in the host UI.
  return formatted === String(balance) ? balanceFormat.format(balance) : formatted
}

export function walletPanelText(walletState, { effectiveBuilder, rawRank, threshold }) {
  const { status, known, balance } = walletState
  let wallet
  switch (status) {
    case 'connecting':
      wallet = 'Connecting…'
      break
    case 'signing':
      wallet = 'Waiting for signature…'
      break
    case 'unverified':
      wallet = 'Not verified (sign to verify)'
      break
    case 'verified':
      wallet = known ? `Verified · ${formatBalance(balance)} COO` : 'Verified · balance unavailable'
      break
    default:
      wallet = 'Wallet not connected'
  }
  let build = effectiveBuilder ? 'Builder access' : 'No builder access'
  // threshold is null in a world that grants nothing by token: null >= compares as 0, so it is asked for first
  if (status === 'verified' && known && threshold > 0 && balance >= threshold && rawRank < Ranks.BUILDER) {
    build += ' · press refresh to check builder access'
  }
  return { wallet, build }
}

const EVM_CHAIN_NAMES = {
  1: 'Ethereum',
  10: 'OP Mainnet',
  137: 'Polygon',
  8217: 'Kaia',
  8453: 'Base',
  42161: 'Arbitrum One',
  43114: 'Avalanche',
  80002: 'Polygon Amoy',
  11155111: 'Sepolia',
}

export const evmChainName = chainId => EVM_CHAIN_NAMES[chainId] ?? `Chain ${chainId}`

export const shortEvmAddress = address =>
  typeof address === 'string' && address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address || ''

// EVM パネルの文言。ビルド権限には触れない (EVM の検証はランクを変えない)
export function evmWalletPanelText(walletState, { providerCount }) {
  switch (walletState.status) {
    case 'connecting':
      return 'Connecting…'
    case 'signing':
      return 'Waiting for signature…'
    case 'unverified':
      return 'Not verified (sign to verify)'
    case 'verified':
      return 'Verified'
    default:
      return providerCount ? 'EVM wallet not connected' : 'No EVM wallet found in this browser'
  }
}
