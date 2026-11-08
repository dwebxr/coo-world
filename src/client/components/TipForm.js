import { css } from '@firebolt-dev/css'
import { useEffect, useRef, useState } from 'react'

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

// 入力中の文字列が送れる金額かどうか (確定の判定はサーバーの tip intent と evm-integration が行う)
const looksLikeAmount = amount => /^\d{1,18}(\.\d{1,18})?$/.test(amount)

export function TipForm({ world, player, onClose }) {
  const tokens = world.evm?.getTipTokens() ?? []
  const [symbol, setSymbol] = useState(tokens[0]?.symbol ?? '')
  const [amount, setAmount] = useState('')
  // idle → confirm → sending → sent / error
  const [step, setStep] = useState('idle')
  const [result, setResult] = useState(null)
  const mounted = useRef(true)
  useEffect(() => () => (mounted.current = false), [])
  const token = tokens.find(entry => entry.symbol === symbol)
  const name = player.data.name

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
            Send {amount} {symbol} to {name}? It goes straight from your wallet and cannot be undone.
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
      {step === 'sending' && <div className='tip-status'>Confirm the transfer in your wallet…</div>}
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
          <div className='tip-note'>This world does not confirm or announce tips yet.</div>
          <div className='tip-row'>
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
