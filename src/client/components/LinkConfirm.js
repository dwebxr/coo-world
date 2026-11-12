import { css } from '@firebolt-dev/css'
import { useEffect, useRef, useState } from 'react'
import { createOpenGuard } from '../../core/extras/worldOpenPolicy'

// The question put before a script's link leaves this world's origin (ClientUI.askOpen). It names the host on a
// line of its own, shows the address, and opens only from a press on Open that comes after the question has been
// on screen untouched for a moment (createOpenGuard): time the page spent hidden does not count. Escape cancels
// (ClientUI). The dialog focuses nothing and a pointer press does not focus a button either, so a key the visitor
// uses in the world (Space, Enter) answers nothing unless they moved the focus to a button themselves, with Tab.

// no focus from a pointer press, and a focus the browser gave anyway is let go
const keepFocus = e => e.preventDefault()
const blurIfPointer = e => {
  if (e.detail > 0) e.currentTarget.blur()
}

export function LinkConfirm({ link }) {
  const guard = useRef(null)
  if (!guard.current) guard.current = createOpenGuard(performance.now())
  const [armed, setArmed] = useState(false)
  // counts the presses that came too soon: each one starts the wait again
  const [early, setEarly] = useState(0)
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), guard.current.remaining(performance.now()))
    return () => clearTimeout(timer)
  }, [early])
  useEffect(() => {
    // a tab that was in the background: the wait starts when the question can be seen
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      guard.current.restart(performance.now())
      setArmed(false)
      setEarly(n => n + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  const onOpen = e => {
    blurIfPointer(e)
    if (guard.current.press(performance.now())) return link.open()
    // too soon: Open is still shown as waiting, and the timer that makes it ready starts again
    setEarly(n => n + 1)
  }
  return (
    <div
      className='link-confirm'
      css={css`
        position: absolute;
        inset: 0;
        padding: 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        .link-confirm-dialog {
          pointer-events: auto;
          background: rgba(11, 10, 21, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 1.375rem;
          backdrop-filter: blur(5px);
          width: 22rem;
          max-width: 100%;
          /* whatever the address is, the buttons stay on screen: the text scrolls, they do not */
          max-height: 100%;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .link-confirm-content {
          padding: 1.4rem;
          min-height: 0;
          overflow: auto;
        }
        .link-confirm-title {
          text-align: center;
          font-size: 1.1rem;
          font-weight: 500;
          margin: 0 0 0.7rem;
        }
        .link-confirm-message {
          text-align: center;
          color: rgba(255, 255, 255, 0.6);
          font-size: 0.9375rem;
          line-height: 1.4;
        }
        .link-confirm-host {
          margin: 0.6rem 0;
          text-align: center;
          color: white;
          font-size: 1.05rem;
          font-weight: 600;
          overflow-wrap: anywhere;
          user-select: text;
        }
        .link-confirm-address {
          margin: 0 0 0.6rem;
          max-height: 6rem;
          overflow: auto;
          color: rgba(255, 255, 255, 0.5);
          font-family: monospace;
          font-size: 0.75rem;
          line-height: 1.3;
          overflow-wrap: anywhere;
          user-select: text;
        }
        .link-confirm-actions {
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          display: flex;
          align-items: stretch;
          flex-shrink: 0;
        }
        .link-confirm-action {
          flex: 1;
          min-height: 2.7rem;
          background: none;
          border: 0;
          font: inherit;
          font-size: 0.9375rem;
          color: rgba(255, 255, 255, 0.8);
          cursor: pointer;
          &.left {
            border-right: 1px solid rgba(255, 255, 255, 0.05);
          }
          &:hover {
            color: white;
          }
          &.waiting {
            color: rgba(255, 255, 255, 0.3);
            cursor: default;
          }
        }
      `}
    >
      <div className='link-confirm-dialog' role='dialog' aria-label='Open another site?'>
        <div className='link-confirm-content'>
          <div className='link-confirm-title'>Open another site?</div>
          <div className='link-confirm-message'>A script in this world wants to open a page on</div>
          <div className='link-confirm-host' dir='ltr'>
            {link.host}
          </div>
          <div className='link-confirm-address' dir='ltr'>
            {link.shown}
          </div>
          <div className='link-confirm-message'>
            That site is not part of this world. {link.newTab ? 'It opens in a new tab.' : 'You will leave this world.'}
          </div>
        </div>
        <div className='link-confirm-actions'>
          <button
            type='button'
            className='link-confirm-action left'
            onMouseDown={keepFocus}
            onClick={() => link.cancel()}
          >
            Cancel
          </button>
          {/* not `disabled`: a press that comes too soon has to be seen, since it starts the wait again */}
          <button
            type='button'
            className={armed ? 'link-confirm-action open' : 'link-confirm-action open waiting'}
            aria-disabled={!armed}
            onMouseDown={keepFocus}
            onClick={onOpen}
          >
            Open
          </button>
        </div>
      </div>
    </div>
  )
}
