import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { transformSync } from 'esbuild'

import { parseTipAmount, tipAmountReason } from '../src/core/extras/evmTokens.js'
import * as tipOutcome from '../src/core/extras/tipOutcome.js'

const TOKENS = [
  { symbol: 'JPYC', decimals: 18, min: '1', max: '1000' },
  { symbol: 'USDC', decimals: 6, min: '0.01', max: '10' },
]
const REQUEST = Object.freeze({ name: 'Bob', address: '0x1563…5508', amount: '100', token: 'JPYC', at: 1_000_000 })
// a note's id (16 hex digits)
const ID = '0123456789abcdef'
const NOTE = Object.freeze({ ...REQUEST, id: ID })

// Render the actual TipForm.js JSX without a DOM (as walletConnectSheet.test.js does): hooks keep their slots
// across renders, effects run when their dependencies change, and the tree is plain objects.
function mount(name, { evm = {}, players = ['Bob', 'Alice'], now = 1_000_000 } = {}) {
  const source = fs.readFileSync(new URL('../src/client/components/TipForm.js', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '').replace(/^export /gm, ''), {
    loader: 'jsx',
    jsxFactory: 'element',
    jsxFragment: 'Fragment',
  }).code
  const world = new EventEmitter()
  const list = new Map(players.map((player, index) => [`p${index}`, { data: { id: `p${index}`, name: player } }]))
  // p0 is the recipient the form is open for; the last player is the payer
  world.entities = { players: list, player: [...list.values()].at(-1) }
  const calls = { tips: [], closed: 0, dismissed: [] }
  let settle
  world.evm = {
    getTipTokens: () => TOKENS,
    getConfig: () => ({ chainIds: [137] }),
    getTipStatus: () => null,
    getTipsConfirmed: () => null,
    getTipMarkers: () => [],
    dismissTipMarker: id => calls.dismissed.push(id),
    recheckTip: () => true,
    tip: options => {
      calls.tips.push(options)
      return new Promise(resolve => (settle = resolve))
    },
    ...evm,
  }
  const slots = []
  const effects = []
  const timers = new Set()
  const clock = { now }
  let cursor = 0
  const Fragment = Symbol('Fragment')
  const element = (type, props, ...children) => {
    if (typeof type === 'function') return type({ ...props, children })
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  }
  // the page's window, as far as the notice uses it: who listens for what
  const page = {
    listeners: new Map(),
    addEventListener(name, fn) {
      if (!page.listeners.has(name)) page.listeners.set(name, new Set())
      page.listeners.get(name).add(fn)
    },
    removeEventListener(name, fn) {
      page.listeners.get(name)?.delete(fn)
    },
    dispatch(name, event) {
      for (const fn of [...(page.listeners.get(name) ?? [])]) fn(event)
    },
  }
  const context = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
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
    useEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous && deps && deps.length === previous.deps.length && deps.every((dep, i) => dep === previous.deps[i]))
        return
      slots[index] = { deps: deps ?? [], cleanup: previous?.cleanup }
      effects.push(() => {
        slots[index].cleanup?.()
        slots[index].cleanup = effect()
      })
    },
    css() {},
    parseTipAmount,
    tipAmountReason,
    ...tipOutcome,
    evmChainName: () => 'Polygon',
    WalletConnectRequestNotice: () => null,
    setTimeout: (fn, ms) => {
      const timer = { fn, at: clock.now + ms }
      timers.add(timer)
      return timer
    },
    clearTimeout: timer => timers.delete(timer),
    Date: { now: () => clock.now },
    window: page,
    element,
    Fragment,
  }
  const components = new Function(...Object.keys(context), `${code}\nreturn { TipForm, TipMarkerNotice }`)(
    ...Object.values(context)
  )
  const props = { world, player: list.get('p0'), onClose: () => calls.closed++ }
  const render = () => {
    cursor = 0
    let tree = components[name](props)
    // effects after the render, then once more if they changed anything
    while (effects.length) {
      for (const effect of effects.splice(0)) effect()
      cursor = 0
      tree = components[name](props)
    }
    return tree
  }
  const advance = ms => {
    clock.now += ms
    for (const timer of [...timers]) {
      if (timer.at > clock.now) continue
      timers.delete(timer)
      timer.fn()
    }
  }
  // the form goes away: each effect's cleanup runs
  const unmount = () => {
    for (const slot of slots) if (typeof slot?.cleanup === 'function') slot.cleanup()
  }
  return {
    render,
    world,
    calls,
    list,
    advance,
    timers,
    unmount,
    now: () => clock.now,
    settle: outcome => settle(outcome),
    page,
  }
}

const all = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const child of node.children ?? []) all(child, pred, out)
  return out
}
const text = node =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : node && typeof node === 'object'
      ? (node.children ?? []).map(text).join('')
      : ''
const byClass = (tree, name) =>
  all(tree, n => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(name))
const labels = tree => all(tree, n => n.type === 'button').map(text)
const button = (tree, label) => all(tree, n => n.type === 'button').find(b => text(b) === label)
const input = tree => all(tree, n => n.type === 'input')[0]
// how a tip text was rendered: its name and address elements, in order
const parts = node =>
  all(node, n => n.type === 'bdi' || n.props?.dir === 'ltr').map(n => ({
    type: n.type,
    className: n.props.className,
    dir: n.props.dir,
    text: text(n),
  }))
const NAME = { type: 'bdi', className: 'tip-name', dir: undefined, text: 'Bob' }
const ADDRESS = { type: 'span', className: 'tip-address', dir: 'ltr', text: '0x1563…5508' }
const settled = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

// type an amount and go to the confirmation step
function toConfirm(form, amount = '100') {
  input(form.render()).props.onChange({ target: { value: amount } })
  button(form.render(), 'Next').props.onClick()
  return form.render()
}
// press Send tip; the form is then waiting for world.evm.tip()
function toSending(form, amount) {
  button(toConfirm(form, amount), 'Send tip').props.onClick()
  return form.render()
}

test('tip form: the confirmation says before the wallet is asked that this world will not confirm the tip', () => {
  for (const [said, shown] of [
    [false, true],
    [true, false],
    [null, false],
  ]) {
    const form = mount('TipForm', { evm: { getTipsConfirmed: () => said } })
    const tree = toConfirm(form)
    assert.equal(byClass(tree, 'tip-unconfirmed').length, shown ? 1 : 0, String(said))
    if (shown) assert.equal(text(byClass(tree, 'tip-unconfirmed')[0]), tipOutcome.TIP_UNCONFIRMED_TEXT)
    assert.equal(form.calls.tips.length, 0, 'nothing was asked of the wallet yet')
    assert.ok(button(tree, 'Send tip'), 'and the tip can still be sent')
  }
})

test('tip form: another player with the recipient’s name is pointed out until the tip is sent', async () => {
  const plain = mount('TipForm')
  assert.equal(byClass(plain.render(), 'tip-twin').length, 0)
  assert.equal(byClass(toConfirm(plain), 'tip-twin').length, 0)

  // the payer's own name is not a twin (the last player is the payer)
  assert.equal(byClass(mount('TipForm', { players: ['Bob', 'Carol', 'bob'] }).render(), 'tip-twin').length, 0)

  const form = mount('TipForm', { players: ['Bob', 'Ｂｏｂ', 'Alice'] })
  const tree = form.render()
  assert.equal(text(byClass(tree, 'tip-twin')[0]), tipOutcome.TIP_NAME_TWIN_TEXT)
  assert.equal(byClass(tree, 'tip-twin')[0].props.role, 'alert')
  assert.equal(byClass(toConfirm(form), 'tip-twin').length, 1, 'on the confirmation too')
  // the twin leaves: the next render of the list no longer warns
  form.list.delete('p1')
  assert.equal(byClass(form.render(), 'tip-twin').length, 0)
  // and one arrives while the wallet is asked
  button(form.render(), 'Send tip').props.onClick()
  form.list.set('p9', { data: { id: 'p9', name: 'bob' } })
  assert.equal(byClass(form.render(), 'tip-twin').length, 1)
  form.settle({ ok: true, txHash: '0x1', explorerUrl: null, ticket: null, reported: false, request: REQUEST })
  await settled()
  assert.equal(byClass(form.render(), 'tip-twin').length, 0, 'not on a tip that is already sent')
})

test('tip form: the sending step shows whom the transfer names once the intent has arrived', () => {
  const form = mount('TipForm')
  let tree = toSending(form)
  assert.equal(text(byClass(tree, 'tip-status')[0]), 'Confirm the transfer in your wallet…')
  assert.equal(byClass(tree, 'tip-recipient').length, 0, 'the address is not known before the intent')
  assert.deepEqual(
    {
      ...form.calls.tips[0],
      onIntent: typeof form.calls.tips[0].onIntent,
      onUnconfirmed: typeof form.calls.tips[0].onUnconfirmed,
    },
    {
      playerId: 'p0',
      token: 'JPYC',
      amount: '100',
      unconfirmedShown: false,
      onIntent: 'function',
      onUnconfirmed: 'function',
    }
  )
  form.calls.tips[0].onIntent({ request: REQUEST, confirms: true })
  tree = form.render()
  assert.equal(text(byClass(tree, 'tip-recipient')[0]), 'To Bob · 0x1563…5508')
  assert.deepEqual(parts(byClass(tree, 'tip-recipient')[0]), [NAME, ADDRESS])
  // what a wallet shows is not promised: the token contract is its "to"
  assert.equal(text(byClass(tree, 'tip-wallet-view')[0]), tipOutcome.TIP_WALLET_VIEW_TEXT)
  assert.equal(byClass(tree, 'tip-unconfirmed').length, 0)
  assert.deepEqual(labels(tree), [], 'no button while the wallet is asked')
})

test('tip form: what the intent says about confirmation shows on the sending step', () => {
  // the world had not said (or said yes) when Send was pressed; the intent says no
  let said = null
  const form = mount('TipForm', { evm: { getTipsConfirmed: () => said } })
  let tree = toSending(form)
  assert.equal(byClass(tree, 'tip-unconfirmed').length, 0)
  said = false
  form.calls.tips[0].onIntent({ request: REQUEST, confirms: false })
  tree = form.render()
  assert.equal(text(byClass(tree, 'tip-unconfirmed')[0]), tipOutcome.TIP_UNCONFIRMED_TEXT)
})

test('tip form: an intent that is the first to say the world is not confirming stops on a step that says so', async () => {
  let said = true
  const form = mount('TipForm', { evm: { getTipsConfirmed: () => said } })
  let tree = toConfirm(form)
  assert.equal(byClass(tree, 'tip-unconfirmed').length, 0, 'the world had said it confirms tips')
  button(tree, 'Send tip').props.onClick()
  const options = form.calls.tips[0]
  assert.equal(options.unconfirmedShown, false, 'the form had not said it')
  // the intent says no (world.evm.tip then waits for the payer, with nothing asked of the wallet)
  said = false
  options.onIntent({ request: REQUEST, confirms: false })
  let chosen
  options.onUnconfirmed({ request: REQUEST }).then(value => (chosen = value))
  tree = form.render()
  const notice = byClass(tree, 'tip-unconfirmed')
  assert.equal(notice.length, 1)
  assert.equal(text(notice[0]), tipOutcome.TIP_UNCONFIRMED_TEXT)
  assert.equal(notice[0].props.role, 'alert')
  assert.equal(text(byClass(tree, 'tip-recipient')[0]), 'To Bob · 0x1563…5508')
  assert.deepEqual(parts(byClass(tree, 'tip-recipient')[0]), [NAME, ADDRESS])
  assert.deepEqual(labels(tree), ['Send anyway', 'Cancel'])
  assert.equal(byClass(tree, 'tip-status').length, 0, 'not "confirm in your wallet": the wallet was not asked')
  await settled()
  assert.equal(chosen, undefined, 'no choice until a button is pressed')
  // Send anyway: the sending step, and the send goes on
  button(tree, 'Send anyway').props.onClick()
  tree = form.render()
  assert.equal(text(byClass(tree, 'tip-status')[0]), 'Confirm the transfer in your wallet…')
  assert.equal(byClass(tree, 'tip-unconfirmed').length, 1, 'still said while the wallet is asked')
  assert.deepEqual(labels(tree), [])
  await settled()
  assert.equal(chosen, true)
  form.settle({ ok: true, txHash: '0x1', explorerUrl: null, ticket: null, reported: false, request: REQUEST })
  await settled()
  assert.match(text(form.render()), /Sent 100 JPYC to Bob/)
  assert.equal(form.calls.tips.length, 1)
})

test('tip form: Cancel on the "not confirming" step goes back to the amount, and a form that goes away sends nothing', async () => {
  let said = null
  const form = mount('TipForm', { evm: { getTipsConfirmed: () => said } })
  button(toConfirm(form), 'Send tip').props.onClick()
  said = false
  form.calls.tips[0].onIntent({ request: REQUEST, confirms: false })
  let chosen
  form.calls.tips[0].onUnconfirmed({ request: REQUEST }).then(value => (chosen = value))
  button(form.render(), 'Cancel').props.onClick()
  await settled()
  assert.equal(chosen, false)
  form.settle({ ok: false, reason: 'declined' })
  await settled()
  let tree = form.render()
  assert.equal(input(tree).props.value, '100', 'the amount is kept')
  assert.equal(byClass(tree, 'tip-error').length, 0, 'not an error: the payer chose')
  assert.deepEqual(labels(tree), ['Next', 'Cancel'])
  // the next confirmation says it before Send, and the send is told so
  button(tree, 'Next').props.onClick()
  tree = form.render()
  assert.equal(text(byClass(tree, 'tip-unconfirmed')[0]), tipOutcome.TIP_UNCONFIRMED_TEXT)
  button(tree, 'Send tip').props.onClick()
  assert.equal(form.calls.tips[1].unconfirmedShown, true)
  assert.equal(form.calls.closed, 0)

  // the form is closed while the send waits for the choice: the answer is no
  const gone = mount('TipForm', { evm: { getTipsConfirmed: () => true } })
  button(toConfirm(gone), 'Send tip').props.onClick()
  let answer
  gone.calls.tips[0].onUnconfirmed({ request: REQUEST }).then(value => (answer = value))
  gone.render()
  gone.unmount()
  await settled()
  assert.equal(answer, false)
  // and a send that asks only after the form went away gets no at once
  let late
  gone.calls.tips[0].onUnconfirmed({ request: REQUEST }).then(value => (late = value))
  await settled()
  assert.equal(late, false)
})

test('tip form: the name and the address are rendered apart, the name isolated and without bidirectional controls', async () => {
  const rlo = { ...REQUEST, name: 'Bob\u202e' }
  const sending = mount('TipForm')
  toSending(sending)
  sending.calls.tips[0].onIntent({ request: rlo, confirms: true })
  assert.deepEqual(parts(byClass(sending.render(), 'tip-recipient')[0]), [NAME, ADDRESS])
  sending.settle({ ok: true, txHash: '0x1', explorerUrl: null, ticket: null, reported: false, request: rlo })
  await settled()
  const status = byClass(sending.render(), 'tip-status')[0]
  assert.deepEqual(parts(status), [NAME, ADDRESS])
  assert.ok(text(status).startsWith('Sent 100 JPYC to Bob (0x1563…5508).'))

  const unknown = mount('TipForm')
  toSending(unknown)
  unknown.settle({ ok: false, reason: 'outcome_unknown', request: rlo })
  await settled()
  const said = byClass(unknown.render(), 'tip-unknown')[0]
  assert.deepEqual(parts(said), [NAME, ADDRESS])
  assert.equal(text(said), tipOutcome.tipUnknownText(REQUEST))

  const notice = mount('TipMarkerNotice', { evm: { getTipMarkers: () => [{ ...rlo, id: ID }] } })
  const note = byClass(notice.render(), 'tip-marker-text')[0]
  assert.deepEqual(parts(note), [NAME, ADDRESS])
  assert.equal(text(note), tipOutcome.tipMarkerText(REQUEST))
  assert.doesNotMatch(text(notice.render()), /\u202e/)
})

test('tip form: an unknown outcome says so with the recipient and the amount, and offers no send', async () => {
  const form = mount('TipForm')
  toSending(form)
  form.calls.tips[0].onIntent({ request: REQUEST, confirms: true })
  form.settle({ ok: false, reason: 'outcome_unknown', request: REQUEST })
  await settled()
  const tree = form.render()
  const unknown = byClass(tree, 'tip-unknown')
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].props.role, 'alert')
  assert.equal(text(unknown[0]), tipOutcome.tipUnknownText(REQUEST))
  assert.match(text(unknown[0]), /100 JPYC to Bob \(0x1563…5508\) may have been sent/)
  // the same send is not one press away: no amount field, no Next, no Send tip, no error to "try again" from
  assert.deepEqual(labels(tree), ['Close'])
  assert.equal(input(tree), undefined)
  assert.equal(byClass(tree, 'tip-error').length, 0)
  assert.doesNotMatch(text(tree), /Try again|not sent|Could not send/)
  button(tree, 'Close').props.onClick()
  assert.equal(form.calls.closed, 1)
  assert.equal(form.calls.tips.length, 1)
})

test('tip form: a rejection and a failure before the request return to the form with what happened', async () => {
  for (const [reason, said] of [
    ['rejected', 'Request rejected in the wallet.'],
    ['failed', 'The tip was not sent. Try again.'],
    ['timeout', 'The tip was not sent. Try again.'],
    ['recipient_unavailable', 'This player no longer receives tips.'],
    // "Send anyway" too long after the intent (the wallet was not asked)
    ['intent_expired', 'This request expired before you answered. Nothing was sent. Start again.'],
  ]) {
    const form = mount('TipForm')
    toSending(form)
    form.settle({ ok: false, reason })
    await settled()
    const tree = form.render()
    assert.equal(text(byClass(tree, 'tip-error')[0]), said, reason)
    assert.deepEqual(labels(tree), ['Next', 'Cancel'], reason)
    assert.equal(byClass(tree, 'tip-unknown').length, 0, reason)
    // the amount is kept, and Next and Send tip make a new request
    assert.equal(input(tree).props.value, '100', reason)
    button(tree, 'Next').props.onClick()
    button(form.render(), 'Send tip').props.onClick()
    assert.equal(form.calls.tips.length, 2, reason)
  }
  // tip() itself throwing happens before any wallet request
  const form = mount('TipForm', { evm: { tip: async () => assert.fail('broken') } })
  toSending(form)
  await settled()
  assert.equal(text(byClass(form.render(), 'tip-error')[0]), 'The tip was not sent. Try again.')
})

test('tip form: a sent tip names the recipient with the short address', async () => {
  const form = mount('TipForm')
  toSending(form)
  form.settle({
    ok: true,
    txHash: `0x${'cd'.repeat(32)}`,
    explorerUrl: 'https://polygonscan.com/tx/0xcd',
    ticket: 'a1'.repeat(16),
    reported: true,
    request: REQUEST,
  })
  await settled()
  const tree = form.render()
  const status = byClass(tree, 'tip-status')[0]
  assert.equal(status.props.role, 'status')
  assert.ok(text(status).startsWith('Sent 100 JPYC to Bob (0x1563…5508). '), text(status))
  assert.equal(all(status, n => n.type === 'a')[0].props.href, 'https://polygonscan.com/tx/0xcd')
  assert.equal(text(byClass(tree, 'tip-confirmation')[0]), 'Confirming on Polygon…')
  assert.deepEqual(labels(tree), ['Close'])
})

test('tip notice: a note left by an earlier page shows until it is dismissed', () => {
  assert.equal(mount('TipMarkerNotice').render(), null, 'no note, no notice')
  let stored = [NOTE]
  const notice = mount('TipMarkerNotice', {
    evm: {
      getTipMarkers: () => stored,
      dismissTipMarker: id => {
        notice.calls.dismissed.push(id)
        stored = stored.filter(note => note.id !== id)
        notice.world.emit('evm:tipMarkers', stored)
      },
    },
  })
  const tree = notice.render()
  assert.equal(tree.props.role, 'status')
  assert.equal(text(byClass(tree, 'tip-marker-text')[0]), tipOutcome.tipMarkerText(REQUEST))
  assert.match(text(tree), /A tip may have been sent: 100 JPYC to Bob \(0x1563…5508\)/)
  assert.deepEqual(labels(tree), ['Dismiss'])
  button(tree, 'Dismiss').props.onClick()
  assert.deepEqual(notice.calls.dismissed, [ID], 'by the id of the note it is shown beside')
  assert.equal(notice.render(), null)
})

test('tip notice: several notes, newest first, each with its own Dismiss', () => {
  // what the storage gives (tipOutcome.js sorts it): the newest first
  let stored = [
    { ...REQUEST, amount: '3', at: 1_000_003, id: 'c'.repeat(16) },
    { ...REQUEST, amount: '2', at: 1_000_002, id: 'b'.repeat(16) },
    { ...REQUEST, amount: '1', at: 1_000_001, id: 'a'.repeat(16) },
  ]
  const notice = mount('TipMarkerNotice', {
    evm: {
      getTipMarkers: () => stored,
      dismissTipMarker: id => {
        notice.calls.dismissed.push(id)
        stored = stored.filter(note => note.id !== id)
        notice.world.emit('evm:tipMarkers', stored)
      },
    },
  })
  let tree = notice.render()
  const notes = byClass(tree, 'tip-marker-note')
  assert.deepEqual(
    notes.map(note => text(byClass(note, 'tip-marker-text')[0]).match(/sent: (\d+) JPYC/)[1]),
    ['3', '2', '1']
  )
  assert.deepEqual(labels(tree), ['Dismiss', 'Dismiss', 'Dismiss'])
  // the Dismiss of the middle note removes that note, and no other
  all(notes[1], n => n.type === 'button')[0].props.onClick()
  assert.deepEqual(notice.calls.dismissed, ['b'.repeat(16)])
  tree = notice.render()
  assert.deepEqual(
    byClass(tree, 'tip-marker-note').map(note => text(note).match(/sent: (\d+) JPYC/)[1]),
    ['3', '1']
  )
  for (const note of byClass(tree, 'tip-marker-note')) all(note, n => n.type === 'button')[0].props.onClick()
  assert.deepEqual(notice.calls.dismissed, ['b'.repeat(16), 'c'.repeat(16), 'a'.repeat(16)])
  assert.equal(notice.render(), null)
})

test('tip notice: four notes are shown, and a line says how many more there are', () => {
  const notes = count =>
    Array.from({ length: count }, (_, n) => ({
      ...REQUEST,
      amount: String(count - n),
      at: 1_000_000 - n,
      id: n.toString(16).padStart(16, '0'),
    }))
  const amounts = tree => byClass(tree, 'tip-marker-note').map(note => text(note).match(/sent: (\d+) JPYC/)[1])
  for (const [count, more] of [
    [4, null],
    [5, tipOutcome.tipMarkerMoreText(1)],
    [9, tipOutcome.tipMarkerMoreText(5)],
  ]) {
    let stored = notes(count)
    const notice = mount('TipMarkerNotice', {
      evm: {
        getTipMarkers: () => stored,
        dismissTipMarker: id => {
          stored = stored.filter(note => note.id !== id)
          notice.world.emit('evm:tipMarkers', stored)
        },
      },
    })
    let tree = notice.render()
    assert.deepEqual(amounts(tree), [count, count - 1, count - 2, count - 3].map(String), String(count))
    assert.equal(labels(tree).length, 4, String(count))
    const line = byClass(tree, 'tip-marker-more')
    assert.deepEqual(line.map(text), more ? [more] : [], String(count))
    if (count === 4) continue
    // a Dismiss brings the next one into view
    button(tree, 'Dismiss').props.onClick()
    tree = notice.render()
    assert.deepEqual(amounts(tree), [count - 1, count - 2, count - 3, count - 4].map(String), String(count))
    assert.deepEqual(
      byClass(tree, 'tip-marker-more').map(text),
      count - 5 ? [tipOutcome.tipMarkerMoreText(count - 5)] : [],
      String(count)
    )
  }
})

test('tip notice: follows the sends of this page, and each note goes when it is ten minutes old', () => {
  let stored = []
  const notice = mount('TipMarkerNotice', { evm: { getTipMarkers: () => stored } })
  assert.equal(notice.render(), null)
  // a send that ended without a clear answer
  stored = [NOTE]
  notice.world.emit('evm:tipMarkers', stored)
  assert.match(text(notice.render()), /A tip may have been sent/)
  // a later one that ended with a known result, and the note was dismissed meanwhile
  notice.world.emit('evm:tipMarkers', [])
  assert.equal(notice.render(), null)
  assert.equal(notice.timers.size, 0, 'no timer left behind')
  // anything else that is told is no note
  notice.world.emit('evm:tipMarkers', null)
  assert.equal(notice.render(), null)
  // and one that is left alone: shown for what remains of the ten minutes
  notice.world.emit('evm:tipMarkers', stored)
  notice.render()
  notice.advance(599_000)
  assert.match(text(notice.render()), /A tip may have been sent/)
  // the storage answers for itself when the time is up (it removes an old note)
  stored = []
  notice.advance(1_001)
  assert.equal(notice.render(), null)
  // two notes: the storage is read again when the first of them is ten minutes old
  stored = [
    { ...NOTE, amount: '2', at: notice.now() - 100_000, id: 'b'.repeat(16) },
    { ...NOTE, amount: '1', at: notice.now() - 400_000, id: 'a'.repeat(16) },
  ]
  notice.world.emit('evm:tipMarkers', stored)
  notice.render()
  notice.advance(199_999)
  assert.equal(byClass(notice.render(), 'tip-marker-note').length, 2)
  stored = stored.slice(0, 1)
  notice.advance(2)
  assert.deepEqual(
    byClass(notice.render(), 'tip-marker-note').map(note => text(note).match(/sent: (\d+) JPYC/)[1]),
    ['2']
  )
  stored = []
  notice.advance(300_000)
  assert.equal(notice.render(), null)
})

test('tip notice: a note found at page load counts its ten minutes from the request, not from the load', () => {
  // asked nine minutes before this page loaded
  let stored = [{ ...NOTE, at: 1_000_000 - 540_000 }]
  const notice = mount('TipMarkerNotice', { evm: { getTipMarkers: () => stored } })
  assert.match(text(notice.render()), /A tip may have been sent/)
  notice.advance(59_000)
  assert.match(text(notice.render()), /A tip may have been sent/)
  stored = []
  notice.advance(1_001)
  assert.equal(notice.render(), null)
})

test('tip notice: reads the notes again a moment after another tab changes the storage, once for a burst', () => {
  let stored = []
  let reads = 0
  const notice = mount('TipMarkerNotice', { evm: { getTipMarkers: () => (reads++, stored) } })
  assert.equal(notice.render(), null)
  assert.equal(notice.page.listeners.get('storage').size, 1)
  // one read for the first render and one right after subscribing
  assert.equal(reads, 2)
  // another tab wrote a note: nothing is read at once, and one read follows for the whole burst of events
  stored = [NOTE]
  for (let n = 0; n < 50; n++) notice.page.dispatch('storage', { key: `evmTipRequest:${n}` })
  assert.equal(reads, 2)
  notice.advance(99)
  assert.equal(reads, 2)
  notice.advance(1)
  assert.equal(reads, 3)
  assert.match(text(notice.render()), /A tip may have been sent/)
  // a change of any other key of this site can cut a read short too: it is followed by a read as well
  notice.page.dispatch('storage', { key: 'hyperfy-settings' })
  notice.advance(100)
  assert.equal(reads, 4)
  // the storage was cleared (no key), and an event without one
  stored = []
  notice.page.dispatch('storage', { key: null })
  notice.page.dispatch('storage', undefined)
  notice.advance(100)
  assert.equal(reads, 5)
  assert.equal(notice.render(), null)
  // gone: no listener, and a read that was waiting is not made
  notice.page.dispatch('storage', { key: null })
  notice.unmount()
  assert.equal(notice.page.listeners.get('storage').size, 0)
  notice.advance(1000)
  assert.equal(reads, 5)
  assert.equal(notice.timers.size, 0)
})

test('tip notice: after a read in which a value could not be read, the line says the count is a lower bound', () => {
  const some = Object.assign(
    Array.from({ length: 6 }, (_, n) => ({ ...NOTE, id: n.toString(16).padStart(16, '0'), at: NOTE.at - n })),
    { incomplete: true }
  )
  const notice = mount('TipMarkerNotice', { evm: { getTipMarkers: () => some } })
  assert.match(
    text(notice.render()),
    /At least 2 more notes like these are kept in this browser\..* Some could not be read\./
  )
  // fewer than are shown, and some unreadable: the line still says there may be others
  const few = Object.assign([{ ...NOTE }], { incomplete: true })
  const other = mount('TipMarkerNotice', { evm: { getTipMarkers: () => few } })
  assert.match(text(other.render()), /Other notes like these may be kept in this browser: some could not be read\./)
  // no note could be read at all: the notice still shows, with that line alone
  const none = Object.assign([], { incomplete: true })
  const empty = mount('TipMarkerNotice', { evm: { getTipMarkers: () => none } })
  const shown = text(empty.render())
  assert.match(shown, /Other notes like these may be kept in this browser: some could not be read\./)
  assert.doesNotMatch(shown, /A tip may have been sent/)
  // and with nothing kept and nothing unreadable there is no notice
  assert.equal(mount('TipMarkerNotice', { evm: { getTipMarkers: () => [] } }).render(), null)
})
