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
  if (status === 'verified' && known && balance >= threshold && rawRank < Ranks.BUILDER) {
    build += ' · press refresh to check builder access'
  }
  return { wallet, build }
}
