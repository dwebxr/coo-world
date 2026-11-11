// src/client/components/ErrorBoundary.js: a part of the interface that throws while it renders takes down only
// itself.
//
// What this covers: the class itself, driven through its lifecycle in the order React uses for a class component
// (`mount` below): queued state updates, getDerivedStateFromProps and render; a child whose render throws gets
// getDerivedStateFromError and a second render in the same pass; the commit calls componentDidMount or
// componentDidUpdate and then componentDidCatch; a setState made during the commit is applied after it, in a render of
// its own; StrictMode's simulated unmount and mount (development) are componentWillUnmount then componentDidMount.
// Timers and the clock are the test's.
//
// What it does not cover: React itself (its reconciler, concurrent rendering, errors from effects, the DOM). The e2e
// suite test/e2e/interface-faults.mjs mounts the real interface in a browser: a pane that throws and its Retry, and
// the whole interface failing once and coming back.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

import { bundleClient } from './lib/renderHarness.mjs'

let ui
before(async () => {
  ui = await bundleClient(`
    export { ErrorBoundary, retryDue, RETRY_DELAY_MS, RETRY_LIMIT, RETRY_FORGET_MS } from './src/client/components/ErrorBoundary'
  `)
})

// A boundary mounted as React mounts a class component, around a child that throws while it renders when
// `child.broken` is set. `strict`: React's StrictMode, which unmounts and mounts a new component once more right after
// its first commit.
function mount(props, { broken = false, strict = false } = {}) {
  const child = { broken }
  const b = new ui.ErrorBoundary({ children: 'CHILD', ...props })
  b.props = { children: 'CHILD', ...props }
  let queue = []
  let committing = false
  let shown
  const patch = update => {
    const next = typeof update === 'function' ? update(b.state, b.props) : update
    if (next) b.state = { ...b.state, ...next }
  }
  const render = () => {
    for (const update of queue) patch(update)
    queue = []
    patch(ui.ErrorBoundary.getDerivedStateFromProps(b.props, b.state))
    let out = b.render()
    let error = null
    if (out === b.props.children && child.broken) {
      error = new Error('bad value')
      patch(ui.ErrorBoundary.getDerivedStateFromError(error))
      out = b.render()
    }
    return { out, error }
  }
  const commit = (first, { out, error }) => {
    shown = out
    committing = true
    try {
      if (first) b.componentDidMount()
      else b.componentDidUpdate()
      if (error) b.componentDidCatch(error)
    } finally {
      committing = false
    }
    if (queue.length) commit(false, render())
  }
  b.setState = update => {
    queue.push(update)
    if (!committing) commit(false, render())
  }
  commit(true, render())
  if (strict) {
    b.componentWillUnmount()
    b.componentDidMount()
  }
  return {
    b,
    child,
    get shown() {
      return shown
    },
    // the parent renders again (with new props)
    update(next = {}) {
      b.props = { ...b.props, ...next }
      commit(false, render())
    },
    unmount() {
      b.componentWillUnmount()
    },
  }
}

// timers of the boundary, run by hand; `now` is Date.now
function fakeTimers(t) {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    error: console.error,
    now: Date.now,
  }
  const timers = new Map()
  let ids = 0
  const clock = { timers, errors: [], now: 1_000_000 }
  globalThis.setTimeout = (fn, ms) => {
    timers.set(++ids, { fn, ms, due: clock.now + ms })
    return ids
  }
  globalThis.clearTimeout = id => timers.delete(id)
  Date.now = () => clock.now
  console.error = (...line) => clock.errors.push(line)
  t.after(() => {
    globalThis.setTimeout = real.setTimeout
    globalThis.clearTimeout = real.clearTimeout
    Date.now = real.now
    console.error = real.error
  })
  // the pending timers with this delay
  clock.pending = ms => [...timers.values()].filter(timer => timer.ms === ms).length
  // when the pending timers with this delay are due
  clock.due = ms => [...timers.values()].filter(timer => timer.ms === ms).map(timer => timer.due)
  // runs the first pending timer with this delay; `late`: it runs that much after it was due, as in a background tab
  clock.run = (ms, late = 0) => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms)
    assert.ok(entry, `a timer of ${ms} ms is pending`)
    timers.delete(entry[0])
    clock.now += ms + late
    entry[1].fn()
  }
  return clock
}

const text = element => element?.props?.text ?? null

test('a part that renders is shown as it is', t => {
  const clock = fakeTimers(t)
  const part = mount({ mode: 'quiet' })
  assert.equal(part.shown, 'CHILD')
  assert.equal(clock.timers.size, 0, 'nothing to try or to forget')
})

test('quiet: nothing is shown, the failure is logged, and the part is tried again, three times in a row at most', t => {
  const clock = fakeTimers(t)
  const part = mount({ mode: 'quiet', name: 'chat' })
  part.child.broken = true
  part.update() // its next render throws
  for (let attempt = 0; attempt < ui.RETRY_LIMIT; attempt++) {
    assert.equal(part.shown, null, 'nothing in its place')
    assert.equal(clock.pending(ui.RETRY_DELAY_MS), 1, `try ${attempt + 1} is scheduled`)
    part.update() // the parent renders again meanwhile: no second timer
    assert.equal(clock.timers.size, 1)
    clock.run(ui.RETRY_DELAY_MS) // the try renders the child, which throws again
  }
  assert.equal(part.shown, null)
  assert.equal(clock.timers.size, 0, 'no fourth try')
  assert.equal(clock.errors.length, ui.RETRY_LIMIT + 1, 'each failure is logged')
  assert.match(String(clock.errors[0][0]), /chat failed to render/)
  part.child.broken = false
  part.update()
  assert.equal(part.shown, null, 'a part that kept failing stays away')
})

test('quiet: a part that comes back is shown; its tries are forgotten only once it has stayed rendered for a while', t => {
  const clock = fakeTimers(t)
  const part = mount({ mode: 'quiet' })
  part.child.broken = true
  part.update()
  part.child.broken = false
  clock.run(ui.RETRY_DELAY_MS)
  assert.equal(part.shown, 'CHILD', 'tried again, and shown')
  assert.equal(part.b.state.tries, 1)
  assert.equal(clock.pending(ui.RETRY_FORGET_MS), 1, 'forgetting starts')

  // failing again before then: the count goes on, and the forgetting stops
  part.child.broken = true
  part.update()
  assert.equal(clock.pending(ui.RETRY_FORGET_MS), 0)
  assert.equal(clock.pending(ui.RETRY_DELAY_MS), 1)
  part.child.broken = false
  clock.run(ui.RETRY_DELAY_MS)
  assert.equal(part.b.state.tries, 2)

  // rendered for RETRY_FORGET_MS: the next failure counts from zero
  clock.run(ui.RETRY_FORGET_MS)
  assert.equal(part.b.state.tries, 0)
  assert.equal(part.shown, 'CHILD')
  assert.equal(clock.timers.size, 0)
})

test('root: a message with a Reload button once the tries are used up, even when each try runs late', t => {
  const clock = fakeTimers(t)
  const part = mount({ mode: 'root' })
  part.child.broken = true
  part.update()
  for (let i = 0; i < ui.RETRY_LIMIT; i++) {
    assert.equal(part.shown, null, 'no message while tries are left')
    // a background tab: each try runs long after the last failure, never after a render that held
    clock.run(ui.RETRY_DELAY_MS, ui.RETRY_FORGET_MS * 2)
  }
  assert.equal(text(part.shown), 'The interface hit an error.')
  assert.equal(part.shown.props.button, 'Reload')
  assert.equal(clock.timers.size, 0)
})

test('StrictMode: a boundary unmounted and mounted again right after it failed still tries again', t => {
  const clock = fakeTimers(t)
  const part = mount({ mode: 'quiet' }, { broken: true, strict: true })
  assert.equal(part.shown, null)
  assert.equal(clock.pending(ui.RETRY_DELAY_MS), 1, 'the try is scheduled again on the second mount')
  part.child.broken = false
  clock.run(ui.RETRY_DELAY_MS)
  assert.equal(part.shown, 'CHILD')
  part.unmount()
  // the same for the forgetting, on a part that is rendered
  const again = mount({ mode: 'root' })
  again.child.broken = true
  again.update()
  again.child.broken = false
  clock.run(ui.RETRY_DELAY_MS)
  again.unmount()
  assert.equal(clock.timers.size, 0)
  again.b.componentDidMount()
  assert.equal(clock.pending(ui.RETRY_FORGET_MS), 1)
})

test('a new resetKey is a new start: the part is shown again and its tries are forgotten', t => {
  const clock = fakeTimers(t)
  const part = mount({ mode: 'panel', resetKey: 'app:1' }, { broken: true })
  assert.equal(text(part.shown), 'This panel hit an error.')
  part.update({ resetKey: 'app:1' })
  assert.equal(text(part.shown), 'This panel hit an error.', 'the same key changes nothing')
  part.child.broken = false
  part.update({ resetKey: 'app:2' })
  assert.equal(part.shown, 'CHILD')
  assert.equal(clock.timers.size, 0, 'a panel is never retried by itself')

  const quiet = mount({ mode: 'quiet', resetKey: 1 }, { broken: true })
  assert.equal(clock.pending(ui.RETRY_DELAY_MS), 1)
  quiet.child.broken = false
  quiet.update({ resetKey: 2 })
  assert.equal(quiet.shown, 'CHILD')
  assert.equal(quiet.b.state.tries, 0)
  assert.equal(clock.timers.size, 0, 'the pending try goes with the old key')
})

test("a new resetKey that fails too gets its own full delay, not what was left of the old key's", t => {
  const clock = fakeTimers(t)
  const part = mount({ mode: 'quiet', resetKey: 'A' }, { broken: true })
  assert.deepEqual(clock.due(ui.RETRY_DELAY_MS), [clock.now + ui.RETRY_DELAY_MS])
  // 2900 ms later the part is shown something else, which fails as well
  clock.now += 2900
  part.update({ resetKey: 'B' })
  assert.equal(part.shown, null)
  assert.deepEqual(clock.due(ui.RETRY_DELAY_MS), [clock.now + ui.RETRY_DELAY_MS], "B's try, a full delay from now")
  assert.equal(clock.timers.size, 1)
  part.child.broken = false
  clock.run(ui.RETRY_DELAY_MS)
  assert.equal(part.shown, 'CHILD')
  assert.equal(part.b.state.tries, 1, 'the try counts for B, from B')
  assert.equal(clock.pending(ui.RETRY_FORGET_MS), 1)

  // a part rendered after tries, forgetting them, that is shown something else: the forgetting goes with the old key
  const shown = mount({ mode: 'quiet', resetKey: 'A' })
  shown.child.broken = true
  shown.update()
  shown.child.broken = false
  clock.run(ui.RETRY_DELAY_MS)
  assert.equal(clock.due(ui.RETRY_FORGET_MS).length, 2)
  shown.update({ resetKey: 'B' })
  assert.equal(clock.due(ui.RETRY_FORGET_MS).length, 1, "only the first part's forgetting is left")
})

test('panel: a message with a Retry button; Retry shows the part again', t => {
  fakeTimers(t)
  const part = mount({ mode: 'panel' }, { broken: true })
  assert.equal(part.shown.props.button, 'Retry')
  part.shown.props.onClick()
  assert.equal(text(part.shown), 'This panel hit an error.', 'still failing')
  part.child.broken = false
  part.shown.props.onClick()
  assert.equal(part.shown, 'CHILD')
})

test('once: nothing is shown, nothing is retried, and onError is told (a throw in it is contained)', t => {
  const clock = fakeTimers(t)
  let told = 0
  const part = mount({ mode: 'once', onError: () => told++ }, { broken: true })
  assert.equal(part.shown, null)
  assert.equal(told, 1)
  assert.equal(clock.timers.size, 0)
  const loud = mount(
    {
      mode: 'once',
      onError: () => {
        throw new Error('cancel failed')
      },
    },
    { broken: true }
  )
  assert.equal(loud.shown, null)
})

test('a boundary that is removed leaves no timer behind', t => {
  const clock = fakeTimers(t)
  const part = mount({ mode: 'quiet' }, { broken: true })
  assert.equal(clock.timers.size, 1)
  part.unmount()
  assert.equal(clock.timers.size, 0)
})

test('retryDue: which parts are tried again by themselves', () => {
  const { retryDue, RETRY_LIMIT } = ui
  assert.equal(retryDue('quiet', 0), true)
  assert.equal(retryDue('root', 0), true)
  assert.equal(retryDue('panel', 0), false)
  assert.equal(retryDue('once', 0), false)
  assert.equal(retryDue(undefined, 0), false)
  assert.equal(retryDue('quiet', RETRY_LIMIT), false)
  assert.equal(retryDue('quiet', RETRY_LIMIT - 1), true)
})
