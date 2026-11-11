import { Component } from 'react'

// A part of the interface that throws while it renders takes down only itself.
//
// React removes the whole tree when a render throws and nothing catches it: one bad value in a chat line, a pane or
// the wallet button blanked every panel and the HUD for the rest of the visit. Each part of the interface is wrapped
// in one of these; the world's canvas is not inside React and keeps drawing either way.
//
// What it catches is what React catches: errors thrown while rendering, in effects and in their cleanups. Not event
// handlers, timers, or listeners on the world; those report themselves and remove nothing.
//
// Three ways to stand in for a part that failed (`mode`):
//   quiet  nothing is shown, and the part is tried again after RETRY_DELAY_MS, up to RETRY_LIMIT times in a row. For
//          the HUD: chat, toasts, the action prompt, buttons. A part that keeps failing stays away until `resetKey`
//          changes.
//   panel  a short message with a Retry button, in place of a pane. Nothing is retried by itself.
//   once   nothing is shown and nothing is retried (a dialog whose promise `onError` settles).
//   root   around the whole interface: tried again like `quiet`, and when that is used up, a message with a Reload
//          button (the world is still on screen behind it).
// `resetKey` names what the part is showing (the open pane, the app it belongs to): a new key is a new start.
export const RETRY_DELAY_MS = 3000
export const RETRY_LIMIT = 3
// a part that then renders for this long has recovered: its next failure counts from zero
export const RETRY_FORGET_MS = 60000

// The boundary's state after a failure at `now`: whether another try is due (pure, so it can be tested without React)
export function afterFailure(state, mode, now) {
  const tries = now - state.failedAt > RETRY_FORGET_MS ? 0 : state.tries
  return { failed: true, tries, failedAt: now, retry: (mode === 'quiet' || mode === 'root') && tries < RETRY_LIMIT }
}

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false, tries: 0, failedAt: 0, retry: false, resetKey: props.resetKey }
    this.timer = null
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(props, state) {
    if (props.resetKey === state.resetKey) return null
    return { failed: false, tries: 0, failedAt: 0, retry: false, resetKey: props.resetKey }
  }

  componentDidCatch(error) {
    console.error(`[ui] ${this.props.name || 'a part of the interface'} failed to render:`, error)
    try {
      this.props.onError?.(error)
    } catch (err) {
      console.error('[ui] onError failed:', err)
    }
    const next = afterFailure(this.state, this.props.mode, Date.now())
    this.setState(next)
    clearTimeout(this.timer)
    if (next.retry) {
      this.timer = setTimeout(() => {
        this.setState(state => (state.failed ? { failed: false, tries: state.tries + 1 } : null))
      }, RETRY_DELAY_MS)
    }
  }

  componentWillUnmount() {
    clearTimeout(this.timer)
  }

  retry = () => {
    clearTimeout(this.timer)
    this.setState({ failed: false, tries: 0, failedAt: 0, retry: false })
  }

  render() {
    if (!this.state.failed) return this.props.children
    const { mode } = this.props
    if (mode === 'panel') return <Notice text='This panel hit an error.' button='Retry' onClick={this.retry} />
    // (before componentDidCatch has decided, `retry` is still false for a first failure: `tries` tells them apart)
    if (mode === 'root' && !this.state.retry && this.state.tries >= RETRY_LIMIT) {
      return <Notice text='The interface hit an error.' button='Reload' onClick={() => globalThis.location.reload()} />
    }
    return null
  }
}

function Notice({ text, button, onClick }) {
  return (
    <div
      className='ui-error'
      style={{
        pointerEvents: 'auto',
        margin: '0.5rem',
        padding: '1rem',
        borderRadius: '1rem',
        background: 'rgba(11, 10, 21, 0.9)',
        border: '1px solid rgba(255, 255, 255, 0.05)',
        color: 'rgba(255, 255, 255, 0.8)',
        fontSize: '0.9rem',
      }}
    >
      <div className='ui-error-text'>{text}</div>
      <button
        type='button'
        className='ui-error-retry'
        onClick={onClick}
        style={{
          marginTop: '0.75rem',
          padding: '0.4rem 0.9rem',
          borderRadius: '0.5rem',
          background: 'rgba(255, 255, 255, 0.1)',
          color: 'white',
          cursor: 'pointer',
        }}
      >
        {button}
      </button>
    </div>
  )
}
