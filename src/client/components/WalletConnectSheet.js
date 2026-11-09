import { css } from '@firebolt-dev/css'
import { useEffect, useState } from 'react'
import { isTouch } from '../utils'
import { WALLET_LINKS, isAppScheme, isWalletConnectUri, walletConnectLink } from '../../core/extras/walletLinks'

// WalletConnect steps in the EVM panel: waiting for the relay, then a QR (desktop) or wallet links (phones),
// then "approve in your wallet" while a signature or transfer waits. The status comes from world.evm.
const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '')

const sheetStyle = css`
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(11, 10, 21, 0.85);
  pointer-events: auto;
  font-size: 0.8rem;
  .wc-title {
    font-weight: 500;
  }
  .wc-note {
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.75rem;
  }
  .wc-qr {
    align-self: center;
    width: 11rem;
    height: 11rem;
    background: white;
    border-radius: 0.5rem;
    padding: 0.4rem;
  }
  a,
  button {
    display: block;
    text-align: center;
    background: rgba(255, 255, 255, 0.08);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.6rem;
    padding: 0.4rem 0.6rem;
    font-size: 0.8rem;
    text-decoration: none;
    cursor: pointer;
  }
  .wc-row {
    display: flex;
    gap: 0.4rem;
    > * {
      flex: 1;
    }
  }
`

// "Open wallet" while a request waits: the connected wallet's app (see getWalletConnectRedirect). Phones only
// (on a desktop the request shows up in the phone's wallet anyway). An app scheme opens in place: in a new tab
// iOS would leave an empty tab behind.
export function OpenWalletLink({ world }) {
  const redirect = world.evm?.getWalletConnectRedirect?.()
  if (!isTouch || !redirect) return null
  return (
    <a
      className='wc-open-wallet'
      href={redirect}
      target={isAppScheme(redirect) ? undefined : '_blank'}
      rel='noopener noreferrer'
    >
      Open wallet
    </a>
  )
}

export function useWalletConnectStatus(world) {
  const [status, setStatus] = useState(() => world.evm?.getWalletConnectStatus?.() ?? null)
  useEffect(() => {
    const update = value => setStatus(value ?? null)
    world.on('evm:walletconnect', update)
    // pick up a status that arrived between render and subscription
    setStatus(world.evm?.getWalletConnectStatus?.() ?? null)
    return () => world.off('evm:walletconnect', update)
  }, [world])
  return status
}

export function WalletConnectSheet({ world }) {
  const status = useWalletConnectStatus(world)
  const [showQr, setShowQr] = useState(!isTouch)
  const [copied, setCopied] = useState(false)
  const state = status?.state
  if (!state || state === 'idle' || state === 'connected') return null

  const cancel = () => world.evm?.cancelConnect?.()
  const uri = state === 'uri' && isWalletConnectUri(status.uri) ? status.uri : null
  // a link that does not look like a pairing link is never shown; the player can still cancel
  const waiting = state === 'loading' || state === 'connecting' || (state === 'uri' && !uri)
  // a copied link or the QR can go to any wallet: the one tapped earlier no longer says which
  const forgetChoice = () => world.evm?.setWalletConnectChoice?.(null)
  const copy = async () => {
    forgetChoice()
    try {
      await navigator.clipboard.writeText(uri)
      setCopied(true)
    } catch {
      world.emit('toast', 'Could not copy the link.')
    }
  }

  return (
    <div
      className='wc-sheet'
      css={sheetStyle}
      // keys stay here: the game's controls listen on window
      onKeyDown={e => e.stopPropagation()}
      onKeyUp={e => e.stopPropagation()}
    >
      {waiting && (
        <>
          <div className='wc-title' role='status'>
            Connecting to WalletConnect…
          </div>
          <button type='button' onClick={cancel}>
            Cancel
          </button>
        </>
      )}
      {uri && (
        <>
          <div className='wc-title'>{isTouch ? 'Open your wallet app' : 'Scan with your wallet app'}</div>
          {isTouch && (
            <>
              {WALLET_LINKS.map(wallet => (
                <a
                  key={wallet.id}
                  className={`wc-wallet wc-wallet-${wallet.id}`}
                  href={walletConnectLink(wallet, uri)}
                  rel='noopener noreferrer'
                  onClick={() => world.evm?.setWalletConnectChoice?.(wallet.id)}
                >
                  Open {wallet.name}
                </a>
              ))}
              {/* Android asks which app opens wc: links; iOS has no such chooser, so copy the link there */}
              {isAndroid() && (
                <a
                  className='wc-wallet wc-wallet-other'
                  href={uri}
                  rel='noopener noreferrer'
                  onClick={() => world.evm?.setWalletConnectChoice?.(null)}
                >
                  Other wallet
                </a>
              )}
              <div className='wc-note'>Install the wallet app first if you do not have it.</div>
            </>
          )}
          {showQr && status.qr && <img className='wc-qr' src={status.qr} alt='WalletConnect QR code' />}
          <div className='wc-row'>
            {isTouch && (
              <button
                type='button'
                onClick={() => {
                  if (!showQr) forgetChoice()
                  setShowQr(!showQr)
                }}
              >
                {showQr ? 'Hide QR' : 'Show QR'}
              </button>
            )}
            <button type='button' className='wc-copy' onClick={copy}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          <div className='wc-note'>The link pairs your wallet with this page. Do not share it.</div>
          <button type='button' onClick={cancel}>
            Cancel
          </button>
        </>
      )}
      {state === 'request' && (
        <>
          <div className='wc-title' role='status'>
            Approve in your wallet app.
          </div>
          <OpenWalletLink world={world} />
          {/* the sign-in can be given up here (a wallet app closed on the phone would keep it waiting for
              minutes); a transfer cannot: the wallet may still send it */}
          {status.method === 'personal_sign' && (
            <button type='button' onClick={cancel}>
              Cancel
            </button>
          )}
        </>
      )}
    </div>
  )
}

// the same "approve in your wallet" step where a request starts elsewhere (the tip form)
export function WalletConnectRequestNotice({ world }) {
  const status = useWalletConnectStatus(world)
  if (status?.state !== 'request') return null
  return (
    <div className='wc-request' css={sheetStyle} role='status'>
      <div className='wc-title'>Approve in your wallet app.</div>
      <OpenWalletLink world={world} />
    </div>
  )
}
