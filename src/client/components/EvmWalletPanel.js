import { css } from '@firebolt-dev/css'
import { useEffect, useState } from 'react'
import { blurIfPointer } from './SolanaWalletPanel'
import { evmChainName, evmWalletPanelText, shortEvmAddress } from './walletPanelText'
import { WalletConnectSheet } from './WalletConnectSheet'

const buttonStyle = css`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
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

  img {
    width: 1rem;
    height: 1rem;
  }
`

// EVM ウォレットパネルの中身。外枠は WalletButton。ビルド権限の文言は出さない
export function EvmWalletPanel({ world, walletState }) {
  const [providers, setProviders] = useState(() => world.evm?.getProviders() ?? [])
  const connected = !!walletState.address
  const connecting = walletState.status === 'connecting' || walletState.status === 'signing'
  const chainId = world.evm?.getConfig().chainIds[0]
  const tipTokens = world.evm?.getTipTokens() ?? []
  // 受け取りの状態はサーバーが自分のプレイヤーに載せる真偽値 (evmTips) が正
  const [receiving, setReceiving] = useState(() => world.entities.player?.data.evmTips === true)

  useEffect(() => {
    const onTips = ({ playerId, evmTips }) => {
      if (playerId === world.entities.player?.data.id) setReceiving(evmTips === true)
    }
    world.on('evmTips', onTips)
    // 描画してから購読するまでの間に届いた変更を拾い直す
    setReceiving(world.entities.player?.data.evmTips === true)
    return () => world.off('evmTips', onTips)
  }, [world])

  useEffect(() => {
    const update = () => setProviders(world.evm?.getProviders() ?? [])
    update()
    world.on('evm:providers', update)
    return () => world.off('evm:providers', update)
  }, [world])

  const isInactive = () => !world.ui.state.active

  const connectWallet = async (e, providerId) => {
    blurIfPointer(e)
    if (isInactive() || connecting) return
    try {
      await world.evm?.connect(providerId)
    } catch (error) {
      console.error('EVM wallet connect error:', error)
    }
  }

  const disconnectWallet = e => {
    blurIfPointer(e)
    if (isInactive() || !connected) return
    try {
      world.evm?.disconnect()
    } catch (error) {
      console.error('EVM wallet disconnect error:', error)
    }
  }

  const toggleReceive = e => {
    blurIfPointer(e)
    if (isInactive() || !walletState.verified) return
    world.evm?.setReceiveTips(!receiving)
  }

  const status = evmWalletPanelText(walletState, { providerCount: providers.length })
  const showConnect = !connected || walletState.status === 'unverified'

  return (
    <div
      className='evm-wallet-body'
      css={css`
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 0.4rem;
      `}
    >
      <div className='evm-wallet-status' aria-live='polite'>
        {status}
      </div>
      {chainId && <div className='evm-wallet-network'>Sign-in network: {evmChainName(chainId)}</div>}
      <div className='evm-wallet-exposure'>
        Signing proves you own this address. It does not move funds or give build access.
      </div>
      {showConnect &&
        (walletState.status === 'unverified' ? (
          <button
            type='button'
            className='evm-wallet-button connect'
            // 未検証からの再署名は、前回選んだウォレットで行う (選択は world.evm が覚えている)
            onClick={e => connectWallet(e)}
            disabled={connecting}
            css={buttonStyle}
          >
            Sign
          </button>
        ) : (
          providers.map(provider => (
            <button
              key={provider.id}
              type='button'
              className='evm-wallet-button connect'
              onClick={e => connectWallet(e, provider.id)}
              disabled={connecting}
              css={buttonStyle}
            >
              {provider.icon && <img src={provider.icon} alt='' />}
              {connecting
                ? 'Connecting...'
                : providers.length > 1 || provider.id === 'walletconnect'
                  ? provider.name
                  : 'Connect Wallet'}
            </button>
          ))
        ))}
      <WalletConnectSheet world={world} />
      {connected && (
        <div
          className='evm-wallet-info'
          css={css`
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.5rem;
            background: rgba(11, 10, 21, 0.85);
            border: 0.0625rem solid ${walletState.verified ? '#2196f3' : '#2a2b39'};
            padding: 0.6rem 0.8rem;
            border-radius: 1rem;
            pointer-events: auto;
            min-width: 10rem;
          `}
        >
          <div
            className='evm-wallet-address'
            title={walletState.address}
            css={css`
              font-size: 0.8rem;
              color: rgba(255, 255, 255, 0.8);
            `}
          >
            {shortEvmAddress(walletState.address)}
          </div>
          <button
            type='button'
            className='evm-wallet-button disconnect'
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
      )}
      {walletState.verified && tipTokens.length > 0 && (
        <div
          className='evm-wallet-tips'
          css={css`
            display: flex;
            flex-direction: column;
            gap: 0.3rem;
            padding-top: 0.3rem;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            label {
              display: flex;
              align-items: center;
              gap: 0.4rem;
              cursor: pointer;
              input {
                flex: none;
                width: auto;
                margin: 0;
              }
              span {
                flex: 1;
                text-align: left;
              }
            }
            .evm-wallet-tips-note {
              color: rgba(255, 255, 255, 0.6);
            }
          `}
        >
          <label>
            <input type='checkbox' checked={receiving} onChange={toggleReceive} />
            <span>Receive tips ({tipTokens.map(token => token.symbol).join(' / ')})</span>
          </label>
          <div className='evm-wallet-tips-note'>
            Anyone in this world who verifies an EVM wallet can get this address to send you a tip. Tips go straight to
            your wallet; this world never holds funds. Tips you receive may be taxable.
          </div>
        </div>
      )}
    </div>
  )
}
