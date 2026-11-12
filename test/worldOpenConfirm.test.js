// world.open() to a page outside the world's origin asks the visitor first (ClientUI.askOpen, LinkConfirm.js), and
// the page opens from their press on Open or not at all. test/e2e/fullstack.mjs asks and answers in a browser.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { transformSync } from 'esbuild'

import {
  OPEN_ARM_MS,
  OPEN_HOST_MAX,
  OPEN_SHOWN_MAX,
  createOpenGuard,
  describeOpenURL,
  resolveOpenURL,
} from '../src/core/extras/worldOpenPolicy.js'
import { bundleClient } from './lib/renderHarness.mjs'
import { loadClient } from './lib/clientHarness.mjs'

const PAGE = 'https://world.example/?x=1'

test('open policy: an address with a user name or password in it is refused', () => {
  const open = url => resolveOpenURL(url, { resolve: value => value, base: PAGE })
  // reads as this world, goes to the other host
  assert.equal(open('https://world.example@other.example/'), null)
  assert.equal(open('https://world.example:443@other.example/login'), null)
  assert.equal(open('https://user:pass@world.example/'), null)
  assert.equal(open('https://:pass@other.example/'), null)
  // an @ further on is part of the path or the query, and the host is still the host
  assert.equal(open('https://other.example/@world.example'), 'https://other.example/@world.example')
  assert.equal(open('https://other.example/?next=a@b'), 'https://other.example/?next=a@b')
})

test('open policy: a host name longer than any that resolves is refused', () => {
  const open = url => resolveOpenURL(url, { resolve: value => value, base: PAGE })
  assert.equal(OPEN_HOST_MAX, 253)
  const label = 'a'.repeat(63)
  const longest = `${label}.${label}.${label}.${'a'.repeat(61)}`
  assert.equal(longest.length, 253)
  assert.equal(open(`https://${longest}/`), `https://${longest}/`)
  // the dot of a fully qualified name is not part of the 253
  assert.equal(open(`https://${longest}./`), `https://${longest}./`)
  assert.equal(open(`https://a${longest}/`), null)
  assert.equal(open(`https://a${longest}./`), null)
  // thousands of characters of host would push the buttons of the question off the screen
  assert.equal(open(`https://${'a.'.repeat(4000)}example/`), null)
})

test('open policy: what is another site, and what the visitor is shown of it', () => {
  const at = href => describeOpenURL(href, PAGE)
  // this world's origin: scheme, host and port all the same
  for (const href of ['https://world.example/', 'https://world.example/terms.html#en', 'https://world.example:443/a']) {
    assert.equal(at(href).external, false, href)
  }
  for (const href of [
    'https://other.example/',
    'http://world.example/', // the scheme
    'https://world.example:8443/', // the port
    'https://www.world.example/', // a subdomain
    'https://world.example.evil.test/', // this world's name as a prefix
    'https://evil.test/world.example',
  ]) {
    assert.equal(at(href).external, true, href)
  }
  assert.deepEqual(at('https://Other.Example:8443/a b?q=1#frag'), {
    href: 'https://other.example:8443/a%20b?q=1#frag',
    host: 'other.example:8443',
    shown: 'https://other.example:8443/a%20b?q=1#frag',
    external: true,
  })
  // a name with letters from another script is shown as the name the browser will ask for, and nothing in the
  // address can reorder the text: every character shown is printable ASCII
  for (const href of [
    'https://wоrld.example/', // a Cyrillic "о"
    'https://例え.テスト/パス?問=答#片',
    'https://other.example/‮gnp.exe?‮#⁦',
    'https://other.example/\u0000\u0007?\t',
  ]) {
    const { host, shown, href: out, external } = at(href)
    assert.equal(external, true)
    for (const text of [host, shown, out]) assert.match(text, /^[\x21-\x7e]+$/, href)
  }
  assert.equal(at('https://wоrld.example/').host, 'xn--wrld-55d.example')
  // without a page to compare with, a link is another site
  assert.equal(describeOpenURL('https://world.example/', undefined).external, true)
  assert.equal(describeOpenURL('https://world.example/', 'about:blank').external, true)
  // only what resolveOpenURL lets through is described
  for (const href of ['javascript:1', 'data:text/html,x', 'not a url', '', null]) assert.equal(at(href), null)
})

test('open policy: a long address is cut in what is shown, never in what is opened', () => {
  const href = `https://other.example/${'a'.repeat(1000)}?end`
  const { shown, href: opened } = describeOpenURL(href, PAGE)
  assert.equal(opened, href)
  assert.equal(shown, `${href.slice(0, OPEN_SHOWN_MAX)}…`)
  assert.ok(shown.startsWith('https://other.example/'), 'the host is in the part that is shown')
  const exact = `https://other.example/${'a'.repeat(OPEN_SHOWN_MAX - 22)}`
  assert.equal(exact.length, OPEN_SHOWN_MAX)
  assert.equal(describeOpenURL(exact, PAGE).shown, exact)
})

test('open guard: a press counts only after a whole wait without one', () => {
  assert.equal(OPEN_ARM_MS, 1000)
  const guard = createOpenGuard(5000)
  assert.equal(guard.armed(5000), false)
  assert.equal(guard.remaining(5000), 1000)
  assert.equal(guard.armed(5999), false)
  assert.equal(guard.remaining(5999), 1)
  assert.equal(guard.armed(6000), true)
  assert.equal(guard.remaining(6000), 0)
  // fast clicks where the button appears: each one starts the wait again, so none of them is an answer
  const fast = createOpenGuard(0)
  for (let at = 100; at <= 10000; at += 900) assert.equal(fast.press(at), false, String(at))
  assert.equal(fast.remaining(10000), 1000)
  assert.equal(fast.press(10999), false)
  assert.equal(fast.press(11998), false)
  // a pause of the whole wait, then one press
  assert.equal(fast.press(12998), true)
  // time spent where the question could not be seen does not count
  const hidden = createOpenGuard(0)
  assert.equal(hidden.armed(60_000), true)
  hidden.restart(60_000)
  assert.equal(hidden.armed(60_000), false)
  assert.equal(hidden.remaining(60_500), 500)
  assert.equal(hidden.press(60_999), false)
  assert.equal(hidden.press(61_999), true)
  // a clock that goes back is not a reason to open
  const back = createOpenGuard(1000)
  assert.equal(back.press(0), false)
  assert.equal(back.press(999), false)
  assert.equal(back.press(1999), true)
})

let ui
before(async () => {
  ui = await bundleClient(`
    export { CoreUI } from './src/client/components/CoreUI'
    export { ClientUI } from './src/core/systems/ClientUI'
    export { default as EventEmitter } from 'eventemitter3'
  `)
})

function world() {
  const emitter = fields => Object.assign(new ui.EventEmitter(), fields)
  const w = new ui.EventEmitter()
  w.ui = new ui.ClientUI(w)
  w.entities = { player: { data: { id: 'me', name: 'Me' }, isAdmin: () => false, isBuilder: () => false } }
  w.settings = emitter({ title: 'A world', desc: '', image: null })
  w.prefs = emitter({ ui: 1, actions: true })
  w.livekit = emitter({ status: { available: false } })
  w.unlocks = 0
  w.controls = { pointer: { locked: false }, actions: [], unlockPointer: () => w.unlocks++ }
  w.builder = { enabled: false }
  w.chat = { subscribe: () => () => {} }
  w.network = { id: 'me' }
  w.xr = { supportsVR: false, session: null }
  w.resolveURL = url => url
  w.fatalError = null
  w.emit('ready', true)
  return w
}
const render = w => ui.renderToString(ui.createElement(ui.CoreUI, { world: w }))
const request = (fields = {}) => {
  const went = []
  return {
    went,
    href: 'https://other.example/shop?item=1',
    host: 'other.example',
    shown: 'https://other.example/shop?item=1',
    newTab: true,
    go: () => went.push('go'),
    ...fields,
  }
}

test('askOpen: the question names the host and the address, and nothing opens until Open', () => {
  const w = world()
  const r = request()
  assert.doesNotMatch(render(w), /link-confirm/)
  assert.equal(w.ui.askOpen(r), true)
  assert.equal(w.unlocks, 1, 'the pointer is let go so that the buttons can be reached')
  assert.deepEqual(r.went, [])
  const html = render(w)
  assert.match(html, /Open another site\?/)
  assert.match(html, /<div class="link-confirm-host" dir="ltr">other\.example<\/div>/)
  assert.match(html, /<div class="link-confirm-address" dir="ltr">https:\/\/other\.example\/shop\?item=1<\/div>/)
  assert.match(html, /That site is not part of this world\./)
  assert.match(html, /It opens in a new tab\./)
  // Open starts out not working, and is not focused: no key answers the question
  assert.match(html, /class="link-confirm-action open waiting" aria-disabled="true"/)
  assert.doesNotMatch(html, /autofocus/i)
  const link = w.ui.latest.link
  link.open()
  assert.deepEqual(r.went, ['go'])
  assert.equal(w.ui.latest.link, null)
  assert.doesNotMatch(render(w), /link-confirm/)
  // an answer is given once
  link.open()
  link.cancel()
  link.open()
  assert.deepEqual(r.went, ['go'])
})

test('askOpen: Cancel and Escape close the question and open nothing', () => {
  const w = world()
  const r = request({ newTab: false })
  w.ui.askOpen(r)
  assert.match(render(w), /You will leave this world\./)
  const link = w.ui.latest.link
  link.cancel()
  assert.equal(w.ui.latest.link, null)
  link.open()
  assert.deepEqual(r.went, [], 'a question that was cancelled cannot be answered afterwards')

  const second = request()
  w.ui.askOpen(second)
  const idle = { pressed: false, down: false }
  w.ui.control = {
    escape: { pressed: true },
    keyZ: idle,
    metaLeft: idle,
    controlLeft: idle,
    shiftLeft: idle,
    pointer: { locked: false },
  }
  w.ui.state.pane = 'prefs'
  w.ui.state.active = true
  w.ui.update()
  assert.equal(w.ui.latest.link, null)
  assert.deepEqual(second.went, [])
  assert.equal(w.ui.state.pane, 'prefs', 'that Escape answered the question and nothing else')
  w.ui.update()
  assert.equal(w.ui.state.pane, null, 'the next one closes the pane as before')
})

test('askOpen: one question at a time; a second request is dropped, not queued and not shown instead', () => {
  const w = world()
  const first = request()
  const second = request({ href: 'https://evil.test/', host: 'evil.test', shown: 'https://evil.test/' })
  assert.equal(w.ui.askOpen(first), true)
  const link = w.ui.latest.link
  for (let i = 0; i < 100; i++) {
    assert.equal(w.ui.askOpen(second), 'another link is waiting for the visitor')
  }
  assert.equal(w.ui.latest.link, link)
  assert.equal(w.unlocks, 1)
  const html = render(w)
  assert.match(html, /other\.example/)
  assert.doesNotMatch(html, /evil\.test/)
  link.open()
  assert.deepEqual(first.went, ['go'])
  assert.deepEqual(second.went, [])
  assert.equal(w.ui.latest.link, null, 'the dropped requests did not line up behind the first')
  // each question is a new one for the interface (the wait before Open starts again)
  assert.equal(w.ui.askOpen(second), true)
  assert.notEqual(w.ui.latest.link.id, link.id)
})

test('askOpen: nothing is asked in an immersive session, where the question could not be seen', () => {
  const w = world()
  w.xr.session = {}
  const r = request()
  assert.equal(w.ui.askOpen(r), 'links are not offered in an immersive session')
  assert.equal(w.ui.latest.link, null)
  assert.deepEqual(r.went, [])
})

test('askOpen: a question that waits when an immersive session starts is cancelled, and cannot open in it', () => {
  const w = world()
  const r = request()
  w.ui.askOpen(r)
  const link = w.ui.latest.link
  w.xr.session = {}
  w.emit('xrSession', w.xr.session)
  assert.equal(w.ui.latest.link, null)
  link.open()
  assert.deepEqual(r.went, [])
  // the end of a session cancels nothing
  w.xr.session = null
  const later = request()
  w.ui.askOpen(later)
  w.emit('xrSession', null)
  assert.notEqual(w.ui.latest.link, null)
  // a session the interface was not told about: an Open that reaches the question in it opens nothing
  w.xr.session = {}
  w.ui.latest.link.open()
  assert.deepEqual(later.went, [])
  assert.equal(w.ui.latest.link, null)
  // a destroyed interface no longer listens
  w.ui.destroy()
  assert.equal(w.listenerCount('xrSession'), 0)
})

test('askOpen: nothing is asked while the interface is hidden, and hiding it cancels the question', () => {
  const w = world()
  w.ui.toggleVisible(false)
  const seen = []
  w.on('ui', state => seen.push(state.visible))
  const hiddenRequest = request()
  // a script that asks on every frame does not bring back an interface the visitor hid
  for (let i = 0; i < 50; i++) assert.equal(w.ui.askOpen(hiddenRequest), 'the interface is hidden')
  assert.equal(w.ui.state.visible, false)
  assert.deepEqual(seen, [])
  assert.equal(w.ui.latest.link, null)
  assert.equal(w.unlocks, 0)
  assert.deepEqual(hiddenRequest.went, [])
  w.ui.toggleVisible(true)
  const r = request()
  assert.equal(w.ui.askOpen(r), true)
  // hidden with the menu or with Z: nobody can see the question, so it is not left waiting behind the world
  const link = w.ui.latest.link
  w.ui.toggleVisible(false)
  assert.equal(w.ui.latest.link, null)
  link.open()
  assert.deepEqual(r.went, [])
  w.ui.toggleVisible(true)
  const again = request()
  w.ui.askOpen(again)
  const idle = { pressed: false, down: false }
  w.ui.control = {
    escape: idle,
    keyZ: { pressed: true },
    metaLeft: idle,
    controlLeft: idle,
    shiftLeft: idle,
    pointer: { locked: false },
  }
  w.ui.state.active = true
  w.ui.update()
  assert.equal(w.ui.state.visible, false)
  assert.equal(w.ui.latest.link, null)
  assert.deepEqual(again.went, [])
  // showing the interface again is not hiding it
  const third = request()
  w.ui.update()
  assert.equal(w.ui.state.visible, true)
  w.ui.askOpen(third)
  w.ui.control.keyZ = idle
  w.ui.update()
  assert.notEqual(w.ui.latest.link, null)
})

// world.open as a script calls it, with a window that records what would have been opened
function apps({ uiSystem = true, location = 'https://world.example/?x=1' } = {}) {
  const opened = []
  const timers = []
  const asked = []
  const logs = []
  const window = {
    location: {
      get href() {
        return location
      },
      set href(value) {
        opened.push(['same tab', value])
      },
    },
    open: (...args) => opened.push(['new tab', ...args]),
  }
  const Apps = loadClient('core/systems/Apps.js', 'Apps', {
    describeOpenURL,
    resolveOpenURL,
    window,
    setTimeout: fn => timers.push(fn),
    console: { error: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
  })
  const w = {
    network: { isClient: true, isServer: false },
    assetsUrl: 'https://world.example/assets',
    // World.resolveURL, as far as these tests go
    resolveURL: url => {
      if (url.startsWith('asset://')) return url.replace('asset:/', 'https://world.example/assets')
      return /^https?:\/\//.test(url) || url.startsWith('/') ? url : `https://${url}`
    },
    events: { off() {} },
  }
  if (uiSystem) {
    w.ui = {
      answer: true,
      askOpen(link) {
        asked.push(link)
        return this.answer
      },
    }
  }
  const system = new Apps(w)
  const open = (url, newTab) => system.worldMethods.open({}, url, newTab)
  return { open, opened, timers, asked, logs, world: w }
}

test('world.open: a page of this world opens as before, another site only from the visitor’s answer', () => {
  const a = apps()
  a.open('/terms.html')
  a.open('https://world.example/other', true)
  assert.deepEqual(a.asked, [])
  assert.deepEqual(a.opened, [], 'on the next turn, as before')
  a.timers.splice(0).forEach(fn => fn())
  assert.deepEqual(a.opened, [
    ['same tab', 'https://world.example/terms.html'],
    ['new tab', 'https://world.example/other', '_blank', 'noopener,noreferrer'],
  ])
  a.opened.length = 0

  a.open('https://other.example/shop', true)
  a.open('other.example/shop')
  assert.equal(a.timers.length, 0, 'no timer opens another site')
  assert.deepEqual(a.opened, [])
  assert.equal(a.asked.length, 2)
  const { go: goTab, ...tab } = a.asked[0]
  const { go: goHere, ...here } = a.asked[1]
  assert.deepEqual(tab, {
    href: 'https://other.example/shop',
    host: 'other.example',
    shown: 'https://other.example/shop',
    newTab: true,
  })
  assert.deepEqual(here, { ...tab, newTab: false })
  assert.deepEqual(a.logs, [])
  goTab()
  assert.deepEqual(a.opened, [['new tab', 'https://other.example/shop', '_blank', 'noopener,noreferrer']])
  goHere()
  assert.deepEqual(a.opened[1], ['same tab', 'https://other.example/shop'])
})

test('world.open: when the visitor cannot be asked, another site is not opened', () => {
  const none = apps({ uiSystem: false })
  none.open('https://other.example/')
  assert.deepEqual(none.opened, [])
  assert.equal(none.timers.length, 0)
  assert.deepEqual(none.logs, ['[world.open] not opened: this client has no way to ask the visitor'])
  // a page of the world itself needs no question there either
  none.open('/terms.html')
  none.timers.splice(0).forEach(fn => fn())
  assert.deepEqual(none.opened, [['same tab', 'https://world.example/terms.html']])

  const busy = apps()
  busy.world.ui.answer = 'another link is waiting for the visitor'
  busy.open('https://other.example/')
  assert.deepEqual(busy.opened, [])
  assert.equal(busy.timers.length, 0)
  assert.deepEqual(busy.logs, ['[world.open] not opened: another link is waiting for the visitor'])

  // what was refused before the question is still refused, and never asked about
  const refused = apps()
  for (const url of ['javascript:1', 'https://world.example@other.example/', '/assets/x.html', 'asset://x.html']) {
    refused.open(url, true)
  }
  assert.deepEqual(refused.asked, [])
  assert.deepEqual(refused.opened, [])
  assert.equal(refused.timers.length, 0)
  assert.equal(refused.logs.length, 4)
})

// LinkConfirm's own press handling, with the hooks kept between renders and a clock the test moves
function dialog(link) {
  const source = fs.readFileSync(new URL('../src/client/components/LinkConfirm.js', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import .*\n/gm, '').replace(/^export /gm, ''), {
    loader: 'jsx',
    jsxFactory: 'element',
  }).code
  const slots = []
  const timers = []
  const listeners = []
  let cursor = 0
  let now = 50_000
  const context = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [
        slots[index],
        value => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(run, deps) {
      const index = cursor++
      const before = slots[index]
      if (before && deps && deps.every((dep, i) => dep === before.deps[i])) return
      before?.cleanup?.()
      slots[index] = { deps, cleanup: run() }
    },
    css() {},
    createOpenGuard,
    document: {
      visibilityState: 'visible',
      addEventListener: (name, fn) => listeners.push([name, fn]),
      removeEventListener() {},
    },
    performance: { now: () => now },
    setTimeout: (fn, ms) => timers.push({ fn, at: now + ms }) && timers.length,
    clearTimeout: id => {
      if (timers[id - 1]) timers[id - 1].fn = null
    },
    element: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  }
  const Component = new Function(...Object.keys(context), `${code}\nreturn LinkConfirm`)(...Object.values(context))
  const find = (node, test) => {
    if (!node || typeof node !== 'object') return null
    if (test(node)) return node
    for (const child of node.children.flat()) {
      const found = find(child, test)
      if (found) return found
    }
    return null
  }
  const render = () => {
    cursor = 0
    return Component({ link })
  }
  const button = label => find(render(), node => node.type === 'button' && node.children.includes(label)).props
  return {
    button,
    // a press with the pointer (detail 1) or with a key on a focused button (detail 0)
    press(label, detail = 1) {
      const event = { detail, blurred: 0, currentTarget: { blur: () => event.blurred++ } }
      button(label).onClick(event)
      return event
    },
    // the page went to the background for `ms` and came back
    background(ms) {
      context.document.visibilityState = 'hidden'
      for (const [name, fn] of listeners) if (name === 'visibilitychange') fn()
      this.advance(ms)
      context.document.visibilityState = 'visible'
      for (const [name, fn] of listeners) if (name === 'visibilitychange') fn()
    },
    advance(ms) {
      now += ms
      for (const timer of timers) {
        if (timer.fn && timer.at <= now) {
          const fn = timer.fn
          timer.fn = null
          fn()
        }
      }
    },
  }
}

test('the question: Open works after a second on screen, and presses before that start the second again', () => {
  const answers = []
  const d = dialog({
    host: 'other.example',
    shown: 'https://other.example/',
    newTab: true,
    open: () => answers.push('open'),
    cancel: () => answers.push('cancel'),
  })
  assert.equal(d.button('Open')['aria-disabled'], true)
  assert.equal(d.button('Open').disabled, undefined, 'it takes the press, to start the wait again')
  // a visitor clicking fast where the button appeared
  for (let i = 0; i < 20; i++) {
    d.advance(300)
    d.press('Open')
  }
  assert.deepEqual(answers, [])
  assert.equal(d.button('Open')['aria-disabled'], true)
  d.advance(999)
  assert.equal(d.button('Open')['aria-disabled'], true)
  d.press('Open')
  assert.deepEqual(answers, [], 'one millisecond early is early')
  d.advance(1000)
  assert.equal(d.button('Open')['aria-disabled'], false)
  assert.match(d.button('Open').className, /^link-confirm-action open$/)
  d.press('Open')
  assert.deepEqual(answers, ['open'])
})

test('the question: a pointer press leaves no button focused, so a key of the world does not answer', () => {
  const answers = []
  const d = dialog({
    host: 'other.example',
    shown: 'https://other.example/',
    newTab: true,
    open: () => answers.push('open'),
    cancel: () => answers.push('cancel'),
  })
  for (const label of ['Cancel', 'Open']) {
    // the press itself gives no focus
    let prevented = 0
    d.button(label).onMouseDown({ preventDefault: () => prevented++ })
    assert.equal(prevented, 1, label)
  }
  // and a focus the browser gave anyway is let go by the press that came too soon
  const early = d.press('Open')
  assert.equal(early.blurred, 1)
  assert.deepEqual(answers, [])
  // a key on a button the visitor focused with Tab is a press like any other: it waits for the second too
  const key = d.press('Open', 0)
  assert.equal(key.blurred, 0)
  assert.deepEqual(answers, [])
  d.advance(1000)
  d.press('Open', 0)
  assert.deepEqual(answers, ['open'])
})

test('the question: time in a background tab does not count towards the second', () => {
  const answers = []
  const d = dialog({
    host: 'other.example',
    shown: 'https://other.example/',
    newTab: true,
    open: () => answers.push('open'),
    cancel: () => answers.push('cancel'),
  })
  // on screen for a moment, then a minute in the background: the timer that makes Open ready has long fired
  d.advance(200)
  assert.equal(d.button('Open')['aria-disabled'], true)
  d.background(60_000)
  assert.equal(d.button('Open')['aria-disabled'], true, 'back in view: Open waits again')
  d.press('Open')
  assert.deepEqual(answers, [])
  d.advance(999)
  assert.equal(d.button('Open')['aria-disabled'], true)
  d.advance(1)
  assert.equal(d.button('Open')['aria-disabled'], false)
  d.press('Open')
  assert.deepEqual(answers, ['open'])
})

test('the question: Cancel works at once, and no button is the default', () => {
  const answers = []
  const d = dialog({
    host: 'other.example',
    shown: 'https://other.example/',
    newTab: false,
    open: () => answers.push('open'),
    cancel: () => answers.push('cancel'),
  })
  d.press('Cancel')
  assert.deepEqual(answers, ['cancel'])
  for (const label of ['Cancel', 'Open']) {
    const props = d.button(label)
    assert.equal(props.type, 'button')
    assert.equal(props.autoFocus, undefined)
  }
})
