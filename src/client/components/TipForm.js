import { css } from '@firebolt-dev/css'
import { useEffect, useRef, useState } from 'react'
import { evmChainName } from './walletPanelText'
import { WalletConnectRequestNotice } from './WalletConnectSheet'

// 投げゼニのフォーム (Players 一覧の行の下に開く)。送金はウォレットから相手へ直接で、この世界は資金を預からない
const REASONS = {
  not_verified: 'Verify your EVM wallet first.',
  busy: 'Another tip is in progress.',
  bad_token: 'Choose a token.',
  bad_amount: 'Enter a valid amount.',
  rate_limited: 'Too many tip requests. Try again in a few seconds.',
  recipient_unavailable: 'This player no longer receives tips.',
  same_wallet: 'That player uses your own wallet.',
  wrong_account: 'Switch your wallet back to the verified account.',
  rejected: 'Request rejected in the wallet.',
  chain_changed: 'The wallet changed network. Try again.',
}

export const tipReasonText = (reason, token) => {
  if (reason === 'below_minimum') return `The minimum tip is ${token?.min} ${token?.symbol}.`
  return REASONS[reason] ?? 'Could not send the tip. Try again.'
}

// 送金後の確定確認 (P2b)。サーバーがチェーンで確かめ、チケットごとに evmTipStatus を返す
const CONFIRM_WAIT_MS = 6 * 60_000
const NOT_COUNTED = {
  reverted: 'the transfer failed on chain.',
  no_transfer: 'this transaction does not contain the tip.',
  too_old: 'this transaction is older than the tip request.',
  duplicate: 'this transaction was already counted.',
  unknown_ticket: 'the tip request expired.',
  bad_tx: 'the wallet returned an invalid transaction.',
}
const NOT_CONFIRMED = {
  no_rpc: 'this world does not confirm tips.',
  timeout: 'it was not confirmed in time.',
  not_found: 'the network has not seen this transaction yet.',
  no_finality: 'this world cannot confirm tips right now.',
  busy: 'many tips are being confirmed.',
  left: 'the world lost track of it.',
  unavailable: 'the world could not be told about it.',
}
// 「もう一度確かめる」を出す理由 (サーバーも 1 回だけ受ける)
const RECHECKABLE = new Set(['timeout', 'not_found', 'no_finality', 'busy'])

export const tipConfirmText = (confirmation, chainName = 'chain') => {
  if (!confirmation) return ''
  const { state, reason } = confirmation
  if (state === 'watching') return `Confirming on ${chainName}…`
  if (state === 'confirmed') return 'Confirmed on chain.'
  if (state === 'failed') return `Not counted: ${NOT_COUNTED[reason] ?? 'it could not be confirmed.'}`
  return `Sent, but not confirmed: ${NOT_CONFIRMED[reason] ?? 'it could not be confirmed.'}`
}

// 入力中の文字列が送れる金額かどうか (確定の判定はサーバーの tip intent と evm-integration が行う)
const looksLikeAmount = amount => /^\d{1,18}(\.\d{1,18})?$/.test(amount)

export function TipForm({ world, player, onClose }) {
  const tokens = world.evm?.getTipTokens() ?? []
  const [symbol, setSymbol] = useState(tokens[0]?.symbol ?? '')
  const [amount, setAmount] = useState('')
  // idle → confirm → sending → sent / error
  const [step, setStep] = useState('idle')
  const [result, setResult] = useState(null)
  // 送金後の確定確認: { state: watching | confirmed | failed | unverified, reason? }
  const [confirmation, setConfirmation] = useState(null)
  const [rechecked, setRechecked] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => (mounted.current = false), [])
  const token = tokens.find(entry => entry.symbol === symbol)
  const name = player.data.name
  const chainName = evmChainName(world.evm?.getConfig().chainIds[0])
  const ticket = result?.ticket ?? null

  // この送金のチケットの状態だけを受ける
  useEffect(() => {
    if (!ticket) return
    const onStatus = data => {
      if (data?.ticket !== ticket || typeof data.state !== 'string') return
      setConfirmation({ state: data.state, reason: typeof data.reason === 'string' ? data.reason : undefined })
    }
    // 購読の前に届いていた状態 (確定が速い場合) も拾う
    const latest = world.evm?.getTipStatus(ticket)
    if (latest) onStatus(latest)
    world.on('evm:tipStatus', onStatus)
    return () => world.off('evm:tipStatus', onStatus)
  }, [world, ticket])

  // 確認中のまま返事が来なければ、ここで未確認にする
  const watching = confirmation?.state === 'watching'
  useEffect(() => {
    if (!watching) return
    const timer = setTimeout(() => setConfirmation({ state: 'unverified', reason: 'timeout' }), CONFIRM_WAIT_MS)
    return () => clearTimeout(timer)
  }, [watching])

  const recheck = () => {
    setRechecked(true)
    const sent = world.evm.recheckTip(ticket, result.txHash)
    setConfirmation(sent ? { state: 'watching' } : { state: 'unverified', reason: 'unavailable' })
  }

  const send = async () => {
    setStep('sending')
    let outcome
    try {
      outcome = await world.evm.tip({ playerId: player.data.id, token: symbol, amount })
    } catch {
      outcome = { ok: false, reason: 'failed' }
    }
    if (!mounted.current) return
    setResult(outcome)
    setStep(outcome?.ok ? 'sent' : 'error')
    if (outcome?.ok) {
      // チケットが無いのは確認しない (古い) サーバー。報告できなければ未確認
      if (!outcome.ticket) setConfirmation({ state: 'unverified', reason: 'no_rpc' })
      else if (!outcome.reported) setConfirmation({ state: 'unverified', reason: 'unavailable' })
      else setConfirmation(current => current ?? world.evm.getTipStatus(outcome.ticket) ?? { state: 'watching' })
    }
  }

  return (
    <div
      className='tip-form'
      // 入力中のキーをワールドの操作 (移動・チャット) に渡さない
      onKeyDown={e => e.stopPropagation()}
      onKeyUp={e => e.stopPropagation()}
      css={css`
        margin: 0.25rem 0.5rem 0.5rem 1rem;
        padding: 0.6rem 0.75rem;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 0.75rem;
        background: rgba(255, 255, 255, 0.03);
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        font-size: 0.875rem;
        .tip-row {
          display: flex;
          gap: 0.5rem;
          align-items: center;
        }
        select,
        input {
          background: rgba(0, 0, 0, 0.3);
          color: white;
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 0.5rem;
          padding: 0.3rem 0.5rem;
          font-size: 0.875rem;
        }
        input {
          flex: 1;
          min-width: 0;
        }
        button {
          background: rgba(255, 255, 255, 0.08);
          color: white;
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 0.5rem;
          padding: 0.3rem 0.75rem;
          font-size: 0.875rem;
          cursor: pointer;
          &:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          &.primary {
            background: #2563eb;
            border-color: #2563eb;
          }
        }
        .tip-note {
          color: rgba(255, 255, 255, 0.6);
          font-size: 0.75rem;
        }
        .tip-confirmation {
          color: rgba(255, 255, 255, 0.85);
          &.confirmed {
            color: #86efac;
          }
          &.failed,
          &.unverified {
            color: #fca5a5;
          }
        }
        a {
          color: #93c5fd;
        }
      `}
    >
      <div className='tip-title'>Tip {name}</div>
      {(step === 'idle' || step === 'error') && (
        <>
          <div className='tip-row'>
            <select aria-label='Token' value={symbol} onChange={e => setSymbol(e.target.value)}>
              {tokens.map(entry => (
                <option key={entry.symbol} value={entry.symbol}>
                  {entry.symbol}
                </option>
              ))}
            </select>
            <input
              aria-label='Amount'
              inputMode='decimal'
              placeholder={token ? `min ${token.min}` : ''}
              value={amount}
              onChange={e => setAmount(e.target.value.trim())}
            />
          </div>
          {step === 'error' && (
            <div className='tip-error' role='alert'>
              {tipReasonText(result?.reason, token)}
            </div>
          )}
          <div className='tip-row'>
            <button
              type='button'
              className='primary'
              disabled={!token || !looksLikeAmount(amount)}
              onClick={() => setStep('confirm')}
            >
              Next
            </button>
            <button type='button' onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      {step === 'confirm' && (
        <>
          <div className='tip-confirm'>
            Send {amount} {symbol} to {name}? It goes straight from your wallet and cannot be undone. This world is not
            a party to it and takes no fee.{' '}
            <a className='tip-terms' href='/terms.html' target='_blank' rel='noopener noreferrer'>
              Terms
            </a>
          </div>
          <div className='tip-row'>
            <button type='button' className='primary' onClick={send}>
              Send tip
            </button>
            <button type='button' onClick={() => setStep('idle')}>
              Back
            </button>
          </div>
        </>
      )}
      {step === 'sending' && (
        <>
          <div className='tip-status'>Confirm the transfer in your wallet…</div>
          <WalletConnectRequestNotice world={world} />
        </>
      )}
      {step === 'sent' && (
        <>
          <div className='tip-status' role='status'>
            Sent {amount} {symbol} to {name}.{' '}
            {result?.explorerUrl && (
              <a href={result.explorerUrl} target='_blank' rel='noopener noreferrer'>
                View transaction
              </a>
            )}
          </div>
          {result?.warning === 'chain_changed' && (
            <div className='tip-error' role='alert'>
              The wallet changed network while sending. Check this transaction in your wallet.
            </div>
          )}
          {confirmation && (
            <div className={`tip-confirmation ${confirmation.state}`} aria-live='polite'>
              {tipConfirmText(confirmation, chainName)}
            </div>
          )}
          {confirmation?.state === 'confirmed' && <div className='tip-note'>Confirmed tips are announced in chat.</div>}
          <div className='tip-row'>
            {confirmation?.state === 'unverified' && RECHECKABLE.has(confirmation.reason) && !rechecked && (
              <button type='button' onClick={recheck}>
                Check again
              </button>
            )}
            <button type='button' onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
      <div className='tip-note'>Tips go directly between wallets. This world never holds funds or takes a fee.</div>
    </div>
  )
}
