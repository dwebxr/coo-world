// src/client/components/ErrorBoundary.js: a part of the interface that throws while it renders takes down only
// itself. The class is driven directly (its lifecycle methods with the state React would give it); what React does
// around a boundary is React's, and the e2e suite hostile-content.mjs checks the whole in a browser.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

import { bundleClient } from './lib/renderHarness.mjs'

let ui
before(async () => {
  ui = await bundleClient(`
    export { ErrorBoundary, afterFailure, RETRY_DELAY_MS, RETRY_LIMIT, RETRY_FORGET_MS } from './src/client/components/ErrorBoundary'
  `)
})

// a boundary as React holds one: setState applies at once, getDerivedStateFromProps runs for new props
function boundary(props) {
  const b = new ui.ErrorBoundary({ children: 'CHILD', ...props })
  b.props = { children: 'CHILD', ...props }
  b.setState = update => {
    const patch = typeof update === 'function' ? update(b.state) : update
    if (patch) b.state = { ...b.state, ...patch }
  }
  b.fail = error => {
    b.setState(ui.ErrorBoundary.getDerivedStateFromError(error))
    b.componentDidCatch(error)
  }
  b.receive = next => {
    b.props = { ...b.props, ...next }
    const patch = ui.ErrorBoundary.getDerivedStateFromProps(b.props, b.state)
    if (patch) b.state = { ...b.state, ...patch }
  }
  return b
}

// timers of the boundary, run by hand
function fakeTimers(t) {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, error: console.error }
  const timers = new Map()
  let ids = 0
  globalThis.setTimeout = (fn, ms) => {
    timers.set(++ids, { fn, ms })
    return ids
  }
  globalThis.clearTimeout = id => timers.delete(id)
  const errors = []
  console.error = (...line) => errors.push(line)
  t.after(() => {
    globalThis.setTimeout = real.setTimeout
    globalThis.clearTimeout = real.clearTimeout
    console.error = real.error
  })
  return {
    timers,
    errors,
    run() {
      const [[id, timer]] = timers
      timers.delete(id)
      timer.fn()
      return timer.ms
    },
  }
}

const text = element => element?.props?.text ?? null

test('a part that renders is shown as it is', () => {
  const b = boundary({ mode: 'quiet' })
  assert.equal(b.render(), 'CHILD')
})

test('quiet: nothing is shown, the failure is logged, and the part is tried again, three times in a row at most', t => {
  const clock = fakeTimers(t)
  const b = boundary({ mode: 'quiet', name: 'chat' })
  for (let attempt = 0; attempt < ui.RETRY_LIMIT; attempt++) {
    b.fail(new Error('bad value'))
    assert.equal(b.render(), null, 'nothing in its place')
    assert.equal(clock.timers.size, 1, `try ${attempt + 1} is scheduled`)
    assert.equal(clock.run(), ui.RETRY_DELAY_MS)
    assert.equal(b.render(), 'CHILD', 'tried again')
  }
  b.fail(new Error('bad value'))
  assert.equal(b.render(), null)
  assert.equal(clock.timers.size, 0, 'no fourth try')
  assert.equal(clock.errors.length, ui.RETRY_LIMIT + 1, 'each failure is logged')
  assert.match(String(clock.errors[0][0]), /chat failed to render/)
})

test('quiet: a part that has rendered for a while starts counting again', t => {
  const clock = fakeTimers(t)
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  t.after(() => (Date.now = realNow))
  const b = boundary({ mode: 'quiet' })
  for (let i = 0; i < ui.RETRY_LIMIT; i++) {
    b.fail(new Error('x'))
    clock.run()
  }
  now += ui.RETRY_FORGET_MS + 1
  b.fail(new Error('x'))
  assert.equal(clock.timers.size, 1, 'a failure long after the last one is tried again')
  assert.equal(b.state.tries, 0)
})

test('a new resetKey is a new start: the part is shown again and its tries are forgotten', t => {
  const clock = fakeTimers(t)
  const b = boundary({ mode: 'panel', resetKey: 'app:1' })
  b.fail(new Error('x'))
  assert.equal(text(b.render()), 'This panel hit an error.')
  b.receive({ resetKey: 'app:1' })
  assert.equal(text(b.render()), 'This panel hit an error.', 'the same key changes nothing')
  b.receive({ resetKey: 'app:2' })
  assert.equal(b.render(), 'CHILD')
  assert.equal(clock.timers.size, 0, 'a panel is never retried by itself')
})

test('panel: a message with a Retry button; Retry shows the part again', t => {
  fakeTimers(t)
  const b = boundary({ mode: 'panel' })
  b.fail(new Error('x'))
  const notice = b.render()
  assert.equal(notice.props.button, 'Retry')
  notice.props.onClick()
  assert.equal(b.render(), 'CHILD')
})

test('once: nothing is shown, nothing is retried, and onError is told (a throw in it is contained)', t => {
  const clock = fakeTimers(t)
  let told = 0
  const b = boundary({ mode: 'once', onError: () => told++ })
  b.fail(new Error('x'))
  assert.equal(b.render(), null)
  assert.equal(told, 1)
  assert.equal(clock.timers.size, 0)
  const loud = boundary({
    mode: 'once',
    onError: () => {
      throw new Error('cancel failed')
    },
  })
  loud.fail(new Error('x'))
  assert.equal(loud.render(), null)
})

test('root: tried again like quiet, then a message with a Reload button', t => {
  const clock = fakeTimers(t)
  const b = boundary({ mode: 'root' })
  for (let i = 0; i < ui.RETRY_LIMIT; i++) {
    b.fail(new Error('x'))
    assert.equal(b.render(), null, 'no message while tries are left')
    clock.run()
  }
  b.fail(new Error('x'))
  const notice = b.render()
  assert.equal(text(notice), 'The interface hit an error.')
  assert.equal(notice.props.button, 'Reload')
})

test('a boundary that is removed leaves no timer behind', t => {
  const clock = fakeTimers(t)
  const b = boundary({ mode: 'quiet' })
  b.fail(new Error('x'))
  assert.equal(clock.timers.size, 1)
  b.componentWillUnmount()
  assert.equal(clock.timers.size, 0)
})

test('afterFailure: when another try is due', () => {
  const { afterFailure, RETRY_LIMIT } = ui
  const fresh = { tries: 0, failedAt: 0 }
  assert.equal(afterFailure(fresh, 'quiet', 5).retry, true)
  assert.equal(afterFailure(fresh, 'root', 5).retry, true)
  assert.equal(afterFailure(fresh, 'panel', 5).retry, false)
  assert.equal(afterFailure(fresh, 'once', 5).retry, false)
  assert.equal(afterFailure(fresh, undefined, 5).retry, false)
  assert.equal(afterFailure({ tries: RETRY_LIMIT, failedAt: 1000 }, 'quiet', 2000).retry, false)
  assert.equal(afterFailure({ tries: RETRY_LIMIT - 1, failedAt: 1000 }, 'quiet', 2000).retry, true)
})
