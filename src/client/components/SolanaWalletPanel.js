import { css } from '@firebolt-dev/css'
import { useRef, useState } from 'react'
import { RefreshCwIcon, CheckCircleIcon, AlertCircleIcon } from 'lucide-react'
import { walletPanelText } from './walletPanelText'

// ポインタ由来の click の後はフォーカスを外す (e.detail はマウス/タッチで 1 以上、キーボード由来の click では 0)。
// <button> にフォーカスが残ると ClientControls (window の keydown) と二重発火し、
// Space でジャンプ + 切替、Enter でチャット + 切替になる。await の前に同期で呼ぶこと
export const blurIfPointer = e => {
  if (e.detail > 0) e.currentTarget.blur()
}

// Solana ウォレットパネルの中身。外枠 (トグル・Esc・開閉) は WalletButton が持ち、状態は props で受け取る
export function SolanaWalletPanel({ world, walletState, isBuilder }) {
  const connected = !!walletState.address
  const address = walletState.address || ''
  const connecting = walletState.status === 'connecting' || walletState.status === 'signing'
  const [refreshing, setRefreshing] = useState(false)
  const refreshLocked = useRef(false)

  // ポインタロック中 (A-3) の操作は無視する。inert が描画されるまでの 1 フレームや
  // visibility のフェード中 (計算値はまだ visible) に、フォーカス済みボタンへ Space/Enter が届く経路を塞ぐ
  const isInactive = () => !world.ui.state.active

  const connectWallet = async e => {
    blurIfPointer(e)
    if (isInactive() || connecting) return

    try {
      if (world.solana) {
        await world.solana.connect()
      }
    } catch (error) {
      console.error('ウォレット接続エラー:', error)
    }
  }

  const disconnectWallet = async e => {
    blurIfPointer(e)
    if (isInactive() || !connected) return

    try {
      if (world.solana) {
        await world.solana.disconnect()
      }
    } catch (error) {
      console.error('ウォレット切断エラー:', error)
    }
  }

  const refreshBuilderAccess = async e => {
    blurIfPointer(e)
    if (isInactive() || !connected || !walletState.verified || refreshLocked.current) return

    refreshLocked.current = true
    const pressedAt = Date.now()
    setRefreshing(true)
    try {
      if (world.solana) {
        await world.solana.refreshBalance()
      }
    } catch (error) {
      console.error('ビルダー権限更新エラー:', error)
    } finally {
      // Keep the button locked through both the request and two seconds since the press.
      const remaining = 2000 - (Date.now() - pressedAt)
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
      refreshLocked.current = false
      setRefreshing(false)
    }
  }

  const requiredAmount = world.solana?.getRequiredTokenAmount() ?? 10000
  const text = walletPanelText(walletState, {
    effectiveBuilder: isBuilder,
    rawRank: world.entities.player.data.rank,
    threshold: requiredAmount,
  })

  return (
    <div
      className='solana-wallet-body'
      css={css`
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 0.4rem;
      `}
    >
      <div className='solana-wallet-status' aria-live='polite'>
        {text.wallet}
      </div>
      <div className='solana-build-status'>{text.build}</div>
      <div className='solana-wallet-exposure'>Scripts in this world can see your COO balance once you verify.</div>
      {(!connected || walletState.status === 'unverified') && (
        <button
          type='button'
          className='solana-wallet-button connect'
          onClick={connectWallet}
          disabled={connecting}
          css={css`
            background: rgba(11, 10, 21, 0.85);
            color: white;
            border: 0.0625rem solid #2a2b39;
            border-radius: 1rem;
            padding: 0.5rem 1rem;
            font-size: 0.875rem;
            cursor: pointer;
            transition: all 0.2s;
            pointer-events: auto;
            backdrop-filter: blur(5px);

            &:hover {
              background: rgba(30, 30, 50, 0.9);
              border-color: #3a3b49;
            }

            &:disabled {
              opacity: 0.6;
              cursor: not-allowed;
            }
          `}
        >
          {connecting ? 'Connecting...' : walletState.status === 'unverified' ? 'Sign' : 'Connect Wallet'}
        </button>
      )}
      {connected && (
        // 接続されている場合はアドレスとトークン情報を表示
        <div
          className='solana-wallet-info'
          css={css`
            display: flex;
            flex-direction: column;
            gap: 0.4rem;
            background: rgba(11, 10, 21, 0.85);
            border: 0.0625rem solid ${isBuilder ? '#4caf50' : '#2a2b39'};
            padding: 0.6rem 0.8rem;
            border-radius: 1rem;
            pointer-events: auto;
            backdrop-filter: blur(5px);
            min-width: 10rem;
          `}
        >
          {/* アドレス行 */}
          <div
            className='solana-wallet-header'
            css={css`
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 0.5rem;
            `}
          >
            <div
              className='solana-wallet-address'
              css={css`
                font-size: 0.8rem;
                color: rgba(255, 255, 255, 0.8);
              `}
            >
              {`${address.substring(0, 4)}...${address.substring(address.length - 4)}`}
            </div>
            <button
              type='button'
              className='solana-wallet-button disconnect'
              onClick={disconnectWallet}
              css={css`
                background: rgba(244, 67, 54, 0.8);
                color: white;
                border: none;
                border-radius: 0.5rem;
                padding: 0.2rem 0.4rem;
                font-size: 0.7rem;
                cursor: pointer;
                transition: background-color 0.2s;

                &:hover {
                  background: rgba(211, 47, 47, 0.9);
                }
              `}
            >
              Disconnect
            </button>
          </div>

          {/* 必要トークン量の案内 (アイコンは現在のビルド権限) */}
          <div
            className='solana-token-info'
            css={css`
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 0.5rem;
              padding-top: 0.3rem;
              border-top: 1px solid rgba(255, 255, 255, 0.1);
            `}
          >
            <div
              className='solana-token-requirement'
              css={css`
                display: flex;
                align-items: center;
                gap: 0.3rem;
                font-size: 0.75rem;
                color: rgba(255, 255, 255, 0.6);
              `}
            >
              {isBuilder ? (
                <CheckCircleIcon size='0.9rem' color='#4caf50' />
              ) : (
                <AlertCircleIcon size='0.9rem' color='#ff9800' />
              )}
              <span>Builder access requires {requiredAmount.toLocaleString()} tokens</span>
            </div>
            <button
              type='button'
              onClick={refreshBuilderAccess}
              disabled={refreshing || !walletState.verified}
              aria-label='Refresh builder access'
              title='Refresh builder access'
              css={css`
                background: transparent;
                border: none;
                color: rgba(255, 255, 255, 0.6);
                cursor: pointer;
                padding: 0.2rem;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: color 0.2s;

                &:hover {
                  color: white;
                }

                &:disabled {
                  cursor: not-allowed;
                }

                svg {
                  animation: ${refreshing ? 'spin 1s linear infinite' : 'none'};
                }
              `}
            >
              <RefreshCwIcon size='0.85rem' />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
