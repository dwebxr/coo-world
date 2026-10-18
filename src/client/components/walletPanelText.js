import { Ranks } from '../../core/extras/ranks.js'

export function walletPanelText(walletState, { effectiveBuilder, rawRank, threshold }) {
  const { status, known, balance } = walletState
  let wallet
  switch (status) {
    case 'connecting':
      wallet = '接続中…'
      break
    case 'signing':
      wallet = '署名を確認中…'
      break
    case 'unverified':
      wallet = '未確認 (署名する)'
      break
    case 'verified':
      wallet = known ? `確認済み・残高 ${balance} COO` : '確認済み・残高を取得できません'
      break
    default:
      wallet = 'ウォレット未接続'
  }
  let build = effectiveBuilder ? 'ビルド権限あり' : 'ビルド権限なし'
  if (status === 'verified' && known && balance >= threshold && rawRank < Ranks.BUILDER) {
    build += '・更新ボタンで権限を確認できます'
  }
  return { wallet, build }
}
