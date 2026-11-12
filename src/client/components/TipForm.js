import { css } from '@firebolt-dev/css'
import { useEffect, useRef, useState } from 'react'
import { parseTipAmount, tipAmountReason } from '../../core/extras/evmTokens'
import {
  TIP_NAME_TWIN_TEXT,
  TIP_MARKERS_SHOWN,
  TIP_UNCONFIRMED_TEXT,
  TIP_WALLET_VIEW_TEXT,
  hasNameTwin,
  tipMarkerMoreText,
  tipMarkerParts,
  tipMarkerRemainingMs,
  tipRecipientParts,
  tipSentParts,
  tipUnknownParts,
} from '../../core/extras/tipOutcome'
import { evmChainName } from './walletPanelText'
import { WalletConnectRequestNotice } from './WalletConnectSheet'

// 投げ銭のフォーム (Players 一覧の行の下に開く)。送金はウォレットから相手へ直接で、この世界は資金を預からない
//
// What the form says about a send is information for the payer, not a control: the texts, the note of a request
// and the name check are in src/core/extras/tipOutcome.js, with what they do not cover.
// Reasons that end here were all decided before the wallet was asked to send, except `rejected` (the wallet's
// explicit rejection, whenever it came). A send whose result is not known is its own step (`unknown`), not one
// of these.
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
  // "Send anyway" came too long after the intent (evm-integration.js, UNCONFIRMED_ANSWER_MS): the wallet was not
  // asked. Back at the amount: Next opens the confirmation, and Send tip there asks the server for a new intent
  intent_expired: 'This request expired before you answered. Nothing was sent. Start again.',
}

// A tip text in parts (tipOutcome.js): the recipient's name isolated in a <bdi>, the short address in an element
// of its own that runs left to right, so that neither can reorder the other or the words around them. The name
// in the form's title and confirmation sentence is not built this way (nor anywhere else in the interface).
function TipText({ parts }) {
  return parts.map((part, index) =>
    typeof part === 'string' ? (
      part
    ) : 'name' in part ? (
      <bdi key={index} className='tip-name'>
        {part.name}
      </bdi>
    ) : (
      <span key={index} className='tip-address' dir='ltr'>
        {part.address}
      </span>
    )
  )
}

// 1000 → 1,000 (整数部だけ区切る。小数部はそのまま)
export const groupedAmount = value =>
  String(value ?? '').replace(/^\d+/, digits => digits.replace(/\B(?=(\d{3})+$)/g, ','))

export const tipReasonText = (reason, token) => {
  if (reason === 'below_minimum') return `The minimum tip is ${groupedAmount(token?.min)} ${token?.symbol}.`
  if (reason === 'above_maximum') {
    return token?.max
      ? `The maximum tip is ${groupedAmount(token.max)} ${token.symbol} during the beta.`
      : 'This amount is above the maximum tip.'
  }
  return REASONS[reason] ?? 'The tip was not sent. Try again.'
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
  // idle → confirm → (unconfirmed →) sending → sent / error / unknown
  const [step, setStep] = useState('idle')
  const [result, setResult] = useState(null)
  // the send under way, once the server's intent has arrived: { request: { name, address, amount, token, at } }
  const [intent, setIntent] = useState(null)
  // 送金後の確定確認: { state: watching | confirmed | failed | unverified, reason? }
  const [confirmation, setConfirmation] = useState(null)
  const [rechecked, setRechecked] = useState(false)
  const mounted = useRef(true)
  // the payer's choice on the "not confirming" step, which world.evm.tip() waits for: resolve(true) sends
  const decision = useRef(null)
  const decide = go => {
    const resolve = decision.current
    decision.current = null
    resolve?.(go)
  }
  useEffect(
    () => () => {
      mounted.current = false
      // a form that goes away while the send waits for the payer's choice: nothing is asked of the wallet
      decision.current?.(false)
      decision.current = null
    },
    []
  )
  const token = tokens.find(entry => entry.symbol === symbol)
  const name = player.data.name
  const chainName = evmChainName(world.evm?.getConfig().chainIds[0])
  const ticket = result?.ticket ?? null
  // read on each render (the Players list renders again when a player comes, goes or is renamed)
  const twin = hasNameTwin(world.entities.players.values(), player.data.id, world.entities.player?.data.id)
  // whether the world confirms tips, as it last said: at sign-in, with the intent of the send under way (which
  // sets `intent`, so this is read again), or with the result of an earlier tip. null: it has not said
  const confirms = world.evm?.getTipsConfirmed() ?? null

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

  // 最小額と上限は、確認の画面へ進む前に知らせる (送る前に tip() とサーバーも同じ関数で確かめる)
  const next = () => {
    try {
      parseTipAmount(amount, token)
    } catch (err) {
      setResult({ ok: false, reason: tipAmountReason(err) })
      setStep('error')
      return
    }
    setResult(null)
    setStep('confirm')
  }

  // a message about the previous token or amount goes away as soon as either changes
  const edited = () => {
    if (step !== 'error') return
    setResult(null)
    setStep('idle')
  }

  const send = async () => {
    // whether this step said, before Send was pressed, that the world is not confirming tips
    const unconfirmedShown = confirms === false
    setIntent(null)
    setStep('sending')
    let outcome
    try {
      outcome = await world.evm.tip({
        playerId: player.data.id,
        token: symbol,
        amount,
        unconfirmedShown,
        onIntent: info => mounted.current && setIntent(info),
        // the intent is the first to say that the world is not confirming tips: the send waits, with nothing asked
        // of the wallet, on a step that says so, until the payer presses Send anyway or Cancel
        onUnconfirmed: () =>
          new Promise(resolve => {
            if (!mounted.current) return resolve(false)
            decision.current = resolve
            setStep('unconfirmed')
          }),
      })
    } catch {
      outcome = { ok: false, reason: 'failed' }
    }
    if (!mounted.current) return
    // Cancel on the "not confirming" step: back to the amount, nothing was asked of the wallet
    if (outcome?.reason === 'declined') {
      setResult(null)
      setStep('idle')
      return
    }
    setResult(outcome)
    // a send whose result is not known is not an error to try again from: the form does not keep the same send
    // one press away. The payer closes it and, after looking at the wallet, starts again from the Players list
    setStep(outcome?.ok ? 'sent' : outcome?.reason === 'outcome_unknown' ? 'unknown' : 'error')
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
        .tip-warning,
        .tip-unknown {
          color: #fcd34d;
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
      {twin && step !== 'sent' && step !== 'unknown' && (
        <div className='tip-warning tip-twin' role='alert'>
          {TIP_NAME_TWIN_TEXT}
        </div>
      )}
      {(step === 'idle' || step === 'error') && (
        <>
          <div className='tip-row'>
            <select
              aria-label='Token'
              value={symbol}
              onChange={e => {
                setSymbol(e.target.value)
                edited()
              }}
            >
              {tokens.map(entry => (
                <option key={entry.symbol} value={entry.symbol}>
                  {entry.symbol}
                </option>
              ))}
            </select>
            <input
              aria-label='Amount'
              inputMode='decimal'
              placeholder={
                token ? `min ${groupedAmount(token.min)}${token.max ? ` · max ${groupedAmount(token.max)}` : ''}` : ''
              }
              value={amount}
              onChange={e => {
                setAmount(e.target.value.trim())
                edited()
              }}
            />
          </div>
          {step === 'error' && (
            <div className='tip-error' role='alert'>
              {tipReasonText(result?.reason, token)}
            </div>
          )}
          <div className='tip-row'>
            <button type='button' className='primary' disabled={!token || !looksLikeAmount(amount)} onClick={next}>
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
            <a className='tip-terms' href='/terms.html#en' target='_blank' rel='noopener noreferrer'>
              Terms
            </a>
          </div>
          {confirms === false && <div className='tip-warning tip-unconfirmed'>{TIP_UNCONFIRMED_TEXT}</div>}
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
      {step === 'unconfirmed' && (
        <>
          {intent?.request && (
            <div className='tip-recipient'>
              <TipText parts={tipRecipientParts(intent.request)} />
            </div>
          )}
          <div className='tip-warning tip-unconfirmed' role='alert'>
            {TIP_UNCONFIRMED_TEXT}
          </div>
          <div className='tip-row'>
            <button
              type='button'
              className='primary'
              onClick={() => {
                setStep('sending')
                decide(true)
              }}
            >
              Send anyway
            </button>
            <button type='button' onClick={() => decide(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {step === 'sending' && (
        <>
          <div className='tip-status'>Confirm the transfer in your wallet…</div>
          {intent?.request && (
            <>
              <div className='tip-recipient'>
                <TipText parts={tipRecipientParts(intent.request)} />
              </div>
              <div className='tip-note tip-wallet-view'>{TIP_WALLET_VIEW_TEXT}</div>
            </>
          )}
          {confirms === false && <div className='tip-warning tip-unconfirmed'>{TIP_UNCONFIRMED_TEXT}</div>}
          <WalletConnectRequestNotice world={world} />
        </>
      )}
      {step === 'sent' && (
        <>
          <div className='tip-status' role='status'>
            <TipText parts={tipSentParts(result?.request ?? { name, amount, token: symbol })} />{' '}
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
      {step === 'unknown' && (
        <>
          <div className='tip-unknown' role='alert'>
            <TipText parts={tipUnknownParts(result?.request ?? { name, amount, token: symbol })} />
          </div>
          <div className='tip-row'>
            <button type='button' onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
      <div className='tip-note'>Tips go directly between wallets. This world never holds funds or takes a fee.</div>
      <div className='tip-note tip-beta'>
        Beta: tips may still have bugs. Connect a wallet holding only a small amount and start with small tips.
      </div>
    </div>
  )
}

// "A tip may have been sent": the notes of requests to the wallet whose result this world did not get
// (tipOutcome.js), newest first, shown under the wallet button after a reload, after a send that ended without a
// clear answer, and each until it is dismissed or ten minutes old. The first TIP_MARKERS_SHOWN are shown, and a
// line says how many more there are; dismissing one brings the next into view. Each Dismiss removes the key of
// the note it is shown beside (by its id); the read that follows removes only notes that are expired or are not
// notes (tipOutcome.js), never another live one. A note is this browser's memory of a request, not a record of a
// payment. The storage is read at the page's load, at the end of a send of its own, on a Dismiss, when a note is
// ten minutes old, and again a moment after the browser tells this page that another tab changed this site's
// storage (a `storage` event, for any key: a read lists every key, so any change can cut one short). That is a
// retry, not a promise: the read it makes can be cut short in turn, and is retried the same way. The line counts
// the notes that could be read, and says "at least" when a value could not be.
// how long after another tab's change the notes are read again (one read for a burst of changes)
const STORAGE_REREAD_MS = 100

export function TipMarkerNotice({ world }) {
  const [markers, setMarkers] = useState(() => world.evm?.getTipMarkers() ?? [])
  useEffect(() => {
    const onMarkers = value => setMarkers(Array.isArray(value) ? value : [])
    world.on('evm:tipMarkers', onMarkers)
    return () => world.off('evm:tipMarkers', onMarkers)
  }, [world])
  // Another tab changed this site's storage: read again, once for a burst of events (a clean-up in the other tab
  // removes many keys at once). And once right after subscribing, for a change that came between the first read
  // above and this.
  useEffect(() => {
    let timer = null
    const read = () => {
      timer = null
      setMarkers(world.evm?.getTipMarkers() ?? [])
    }
    const onStorage = () => {
      if (timer === null) timer = setTimeout(read, STORAGE_REREAD_MS)
    }
    window.addEventListener('storage', onStorage)
    read()
    return () => {
      window.removeEventListener('storage', onStorage)
      if (timer !== null) clearTimeout(timer)
    }
  }, [world])
  // the first note to be ten minutes old: then the storage is read again (which removes it)
  useEffect(() => {
    if (!markers.length) return
    const now = Date.now()
    const timer = setTimeout(
      () => setMarkers(world.evm?.getTipMarkers() ?? []),
      Math.min(...markers.map(marker => tipMarkerRemainingMs(marker, now))) + 1
    )
    return () => clearTimeout(timer)
  }, [world, markers])
  // nothing to show, unless a value could not be read: then the line below says that there may be notes
  if (!markers.length && markers.incomplete !== true) return null
  return (
    <div
      className='tip-marker'
      role='status'
      onKeyDown={e => e.stopPropagation()}
      onKeyUp={e => e.stopPropagation()}
      css={css`
        max-width: min(24rem, calc(100vw - 2rem));
        padding: 0.6rem 0.8rem;
        background: rgba(11, 10, 21, 0.85);
        border: 1px solid #fcd34d;
        border-radius: 1rem;
        color: white;
        font-size: 0.75rem;
        pointer-events: auto;
        backdrop-filter: blur(5px);
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        .tip-marker-note {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .tip-marker-note + .tip-marker-note {
          padding-top: 0.6rem;
          border-top: 1px solid rgba(255, 255, 255, 0.15);
        }
        button {
          align-self: flex-end;
          background: rgba(255, 255, 255, 0.08);
          color: white;
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 0.5rem;
          padding: 0.2rem 0.6rem;
          font-size: 0.75rem;
          cursor: pointer;
        }
      `}
    >
      {markers.slice(0, TIP_MARKERS_SHOWN).map(marker => (
        <div key={marker.id} className='tip-marker-note'>
          <div className='tip-marker-text'>
            <TipText parts={tipMarkerParts(marker)} />
          </div>
          <button type='button' onClick={() => world.evm?.dismissTipMarker(marker.id)}>
            Dismiss
          </button>
        </div>
      ))}
      {(markers.length > TIP_MARKERS_SHOWN || markers.incomplete === true) && (
        <div className='tip-marker-more'>
          {tipMarkerMoreText(Math.max(0, markers.length - TIP_MARKERS_SHOWN), markers.incomplete === true)}
        </div>
      )}
    </div>
  )
}
