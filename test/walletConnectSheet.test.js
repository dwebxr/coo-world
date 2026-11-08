import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { transformSync } from 'esbuild'

import { WALLET_LINKS, isWalletConnectUri, walletConnectLink } from '../src/core/extras/walletLinks.js'

const URI = `wc:${'ab'.repeat(32)}@2?relay-protocol=irn&symKey=${'cd'.repeat(32)}`
const QR = 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36'

// Render the actual WalletConnectSheet JSX without a DOM: hooks keep their slots across renders, function
// components are called in place, and the tree is plain objects.
function sheet({ status, touch = false, userAgent = 'Mozilla/5.0 (Macintosh)', redirect = null, clipboard } = {}) {
  const source = fs.readFileSync(new URL('../src/client/components/WalletConnectSheet.js', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import .*\n/gm, '').replace(/^export /gm, ''), {
    loader: 'jsx',
    jsxFactory: 'element',
    jsxFragment: 'Fragment',
  }).code
  const calls = { cancel: 0, choices: [], toasts: [], copied: [] }
  const world = {
    evm: {
      getWalletConnectStatus: () => status,
      cancelConnect: () => calls.cancel++,
      setWalletConnectChoice: id => calls.choices.push(id),
      getWalletConnectRedirect: () => redirect,
    },
    on() {},
    off() {},
    emit(name, value) {
      if (name === 'toast') calls.toasts.push(value)
    },
  }
  const slots = []
  let cursor = 0
  const Fragment = Symbol('Fragment')
  const element = (type, props, ...children) => {
    if (typeof type === 'function') return type({ ...props, children })
    return { type, props: props ?? {}, children: children.flat() }
  }
  const context = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        slots[index],
        value => {
          slots[index] = value
        },
      ]
    },
    useEffect() {},
    css() {},
    isTouch: touch,
    navigator: {
      userAgent,
      clipboard: clipboard ?? {
        writeText: async text => {
          calls.copied.push(text)
        },
      },
    },
    WALLET_LINKS,
    isWalletConnectUri,
    walletConnectLink,
    element,
    Fragment,
  }
  const components = new Function(
    ...Object.keys(context),
    `${code}\nreturn { WalletConnectSheet, WalletConnectRequestNotice }`
  )(...Object.values(context))
  const render = (name = 'WalletConnectSheet') => {
    cursor = 0
    return components[name]({ world })
  }
  return { render, calls, world }
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
const buttons = tree => all(tree, n => n.type === 'button')
const button = (tree, label) => buttons(tree).find(b => text(b) === label)

test('walletconnect sheet: nothing shows while idle or once connected', () => {
  for (const status of [null, { state: 'idle' }, { state: 'connected' }]) {
    assert.equal(sheet({ status }).render(), null, JSON.stringify(status))
    assert.equal(sheet({ status, touch: true }).render(), null, JSON.stringify(status))
  }
})

test('walletconnect sheet: loading and connecting wait with a Cancel', () => {
  for (const state of ['loading', 'connecting']) {
    const { render, calls } = sheet({ status: { state } })
    const tree = render()
    assert.equal(text(byClass(tree, 'wc-title')[0]), 'Connecting to WalletConnect…')
    assert.equal(byClass(tree, 'wc-title')[0].props.role, 'status')
    button(tree, 'Cancel').props.onClick()
    assert.equal(calls.cancel, 1)
  }
})

test('walletconnect sheet: a desktop shows the QR and the copy link, no phone wallet links', async () => {
  const { render, calls } = sheet({ status: { state: 'uri', uri: URI, qr: QR } })
  let tree = render()
  assert.equal(text(byClass(tree, 'wc-title')[0]), 'Scan with your wallet app')
  const img = all(tree, n => n.type === 'img')
  assert.equal(img.length, 1)
  assert.equal(img[0].props.src, QR)
  assert.equal(img[0].props.alt, 'WalletConnect QR code')
  assert.equal(byClass(tree, 'wc-wallet').length, 0, 'no wallet links')
  assert.equal(button(tree, 'Show QR') ?? button(tree, 'Hide QR'), undefined, 'no QR toggle on a desktop')
  assert.ok(text(tree).includes('Do not share it.'))
  await button(tree, 'Copy link').props.onClick()
  assert.deepEqual(calls.copied, [URI])
  tree = render()
  assert.ok(button(tree, 'Copied'), 'copy confirmed')
  button(tree, 'Cancel').props.onClick()
  assert.equal(calls.cancel, 1)
})

test('walletconnect sheet: an iPhone gets wallet links, QR behind a toggle, no wc: link', () => {
  const { render, calls } = sheet({ status: { state: 'uri', uri: URI, qr: QR }, touch: true, userAgent: IPHONE })
  let tree = render()
  assert.equal(text(byClass(tree, 'wc-title')[0]), 'Open your wallet app')
  const links = byClass(tree, 'wc-wallet')
  assert.deepEqual(
    links.map(a => [text(a), a.props.href]),
    WALLET_LINKS.map(w => [`Open ${w.name}`, `${w.universal}/wc?uri=${encodeURIComponent(URI)}`])
  )
  for (const a of links) assert.equal(a.props.rel, 'noopener noreferrer')
  assert.equal(byClass(tree, 'wc-wallet-other').length, 0, 'iOS has no app chooser for wc: links')
  assert.equal(all(tree, n => n.type === 'img').length, 0, 'QR hidden at first on a phone')
  links[1].props.onClick()
  assert.deepEqual(calls.choices, ['hashport'], 'the tapped wallet is remembered for "Open wallet"')
  links[0].props.onClick()
  assert.deepEqual(calls.choices, ['hashport', 'metamask'])
  button(tree, 'Show QR').props.onClick()
  tree = render()
  assert.equal(all(tree, n => n.type === 'img').length, 1, 'QR on request (another device scans it)')
  button(tree, 'Hide QR').props.onClick()
  assert.equal(all(render(), n => n.type === 'img').length, 0)
})

test('walletconnect sheet: Android also offers the wc: link for other wallets', () => {
  const { render, calls } = sheet({ status: { state: 'uri', uri: URI, qr: QR }, touch: true, userAgent: ANDROID })
  const other = byClass(render(), 'wc-wallet-other')
  assert.equal(other.length, 1)
  assert.equal(other[0].props.href, URI)
  assert.equal(text(other[0]), 'Other wallet')
  other[0].props.onClick()
  assert.deepEqual(calls.choices, [null], 'no named wallet to reopen later')
})

test('walletconnect sheet: a link that is not a pairing link is never put in an href', () => {
  for (const uri of ['javascript:alert(1)', `https://evil.example/${URI}`, `${URI}`.toUpperCase(), '', null]) {
    for (const touch of [false, true]) {
      const tree = sheet({ status: { state: 'uri', uri, qr: QR }, touch, userAgent: ANDROID }).render()
      assert.equal(all(tree, n => n.type === 'a').length, 0, String(uri))
      assert.equal(all(tree, n => n.type === 'img').length, 0, String(uri))
      assert.equal(text(byClass(tree, 'wc-title')[0]), 'Connecting to WalletConnect…', 'still cancellable')
      assert.ok(button(tree, 'Cancel'))
    }
  }
})

test('walletconnect sheet: a failed copy says so', async () => {
  const { render, calls } = sheet({
    status: { state: 'uri', uri: URI, qr: QR },
    clipboard: { writeText: async () => Promise.reject(new Error('denied')) },
  })
  await button(render(), 'Copy link').props.onClick()
  assert.deepEqual(calls.toasts, ['Could not copy the link.'])
  assert.ok(button(render(), 'Copy link'), 'not marked copied')
})

test('walletconnect sheet: a waiting request offers "Open wallet" on phones only', () => {
  const status = { state: 'request', method: 'personal_sign' }
  const { render, calls } = sheet({ status, touch: true, redirect: 'https://metamask.app.link' })
  const phone = render()
  assert.equal(text(byClass(phone, 'wc-title')[0]), 'Approve in your wallet app.')
  const open = byClass(phone, 'wc-open-wallet')
  assert.equal(open.length, 1)
  assert.equal(open[0].props.href, 'https://metamask.app.link')
  assert.equal(open[0].props.rel, 'noopener noreferrer')
  assert.equal(byClass(sheet({ status, touch: true }).render(), 'wc-open-wallet').length, 0, 'no link to offer')
  const desktop = sheet({ status, redirect: 'https://metamask.app.link' }).render()
  assert.equal(byClass(desktop, 'wc-open-wallet').length, 0, 'a desktop has no wallet app to open')
  // the sign-in can be given up; a transfer cannot (the wallet may still send it)
  button(phone, 'Cancel').props.onClick()
  assert.equal(calls.cancel, 1)
  assert.ok(button(desktop, 'Cancel'), 'on a desktop too')
  const transfer = sheet({ status: { state: 'request', method: 'eth_sendTransaction' }, touch: true }).render()
  assert.equal(buttons(transfer).length, 0)
})

test('walletconnect request notice: shows only while a request waits', () => {
  for (const state of ['idle', 'loading', 'connecting', 'uri', 'connected']) {
    assert.equal(sheet({ status: { state, uri: URI } }).render('WalletConnectRequestNotice'), null, state)
  }
  const tree = sheet({ status: { state: 'request' }, touch: true, redirect: 'rainbow://' }).render(
    'WalletConnectRequestNotice'
  )
  assert.equal(tree.props.role, 'status')
  assert.equal(text(tree), 'Approve in your wallet app.Open wallet')
  assert.equal(byClass(tree, 'wc-open-wallet')[0].props.href, 'rainbow://')
})
