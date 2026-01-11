import { css } from '@firebolt-dev/css'
import { useEffect, useState } from 'react'
import { RefreshCwIcon, CheckCircleIcon, AlertCircleIcon } from 'lucide-react'

export function SolanaWalletButton({ world }) {
  const [connected, setConnected] = useState(false)
  const [address, setAddress] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [tokenBalance, setTokenBalance] = useState(0)
  const [hasBuilderAccess, setHasBuilderAccess] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    // 初期状態をチェック
    if (world.solana) {
      setConnected(world.solana.isConnected())
      setAddress(world.solana.getAddress() || '')
      setTokenBalance(world.solana.getTokenBalance())
      setHasBuilderAccess(world.solana.hasBuilderAccess())
    }

    // Solana接続イベントをリッスン
    const onConnected = addr => {
      setConnected(true)
      setAddress(addr)
    }

    const onDisconnected = () => {
      setConnected(false)
      setAddress('')
      setTokenBalance(0)
      setHasBuilderAccess(false)
    }

    const onBuilderAccessChanged = (hasAccess, balance) => {
      setHasBuilderAccess(hasAccess)
      setTokenBalance(balance)
    }

    world.on('solana:connected', onConnected)
    world.on('solana:disconnected', onDisconnected)
    world.on('solana:builderAccessChanged', onBuilderAccessChanged)

    return () => {
      world.off('solana:connected', onConnected)
      world.off('solana:disconnected', onDisconnected)
      world.off('solana:builderAccessChanged', onBuilderAccessChanged)
    }
  }, [world])

  const connectWallet = async () => {
    if (connected || connecting) return

    setConnecting(true)
    try {
      if (world.solana) {
        await world.solana.connect()
      }
    } catch (error) {
      console.error('ウォレット接続エラー:', error)
    } finally {
      setConnecting(false)
    }
  }

  const disconnectWallet = async () => {
    if (!connected) return

    try {
      if (world.solana) {
        await world.solana.disconnect()
      }
    } catch (error) {
      console.error('ウォレット切断エラー:', error)
    }
  }

  const refreshBalance = async () => {
    if (!connected || refreshing) return

    setRefreshing(true)
    try {
      if (world.solana) {
        await world.solana.refreshBalance()
      }
    } catch (error) {
      console.error('残高更新エラー:', error)
    } finally {
      setRefreshing(false)
    }
  }

  // 接続されていない場合は接続ボタンを表示
  if (!connected) {
    return (
      <button
        className='solana-wallet-button connect'
        onClick={connectWallet}
        disabled={connecting}
        css={css`
          position: absolute;
          top: calc(1rem + env(safe-area-inset-top));
          right: calc(1rem + env(safe-area-inset-right));
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
        {connecting ? 'Connecting...' : 'Connect Wallet'}
      </button>
    )
  }

  const requiredAmount = world.solana?.getRequiredTokenAmount() || 10000

  // 接続されている場合はアドレスとトークン情報を表示
  return (
    <div
      className='solana-wallet-info'
      css={css`
        position: absolute;
        top: calc(1rem + env(safe-area-inset-top));
        right: calc(1rem + env(safe-area-inset-right));
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        background: rgba(11, 10, 21, 0.85);
        border: 0.0625rem solid ${hasBuilderAccess ? '#4caf50' : '#2a2b39'};
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

      {/* トークン残高行 */}
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
          className='solana-token-balance'
          css={css`
            display: flex;
            align-items: center;
            gap: 0.3rem;
            font-size: 0.75rem;
            color: ${hasBuilderAccess ? '#4caf50' : 'rgba(255, 255, 255, 0.6)'};
          `}
        >
          {hasBuilderAccess ? <CheckCircleIcon size='0.9rem' /> : <AlertCircleIcon size='0.9rem' />}
          <span>
            {tokenBalance.toLocaleString()} / {requiredAmount.toLocaleString()}
          </span>
        </div>
        <button
          onClick={refreshBalance}
          disabled={refreshing}
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

            @keyframes spin {
              from {
                transform: rotate(0deg);
              }
              to {
                transform: rotate(360deg);
              }
            }

            svg {
              animation: ${refreshing ? 'spin 1s linear infinite' : 'none'};
            }
          `}
        >
          <RefreshCwIcon size='0.85rem' />
        </button>
      </div>

      {/* ステータス表示 */}
      <div
        className='solana-status'
        css={css`
          font-size: 0.7rem;
          text-align: center;
          color: ${hasBuilderAccess ? '#4caf50' : '#ff9800'};
        `}
      >
        {hasBuilderAccess ? 'Builder Access Granted' : 'Need more tokens for builder'}
      </div>
    </div>
  )
}
