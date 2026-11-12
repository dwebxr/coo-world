import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { transformSync } from 'esbuild'
import { walletPanelText } from '../src/client/components/walletPanelText.js'

// Exercise the actual JSX handler and disabled prop with persistent hook state, without a DOM.
function panel(refreshBalance, { required = 10000, walletState: state } = {}) {
  const source = fs.readFileSync(new URL('../src/client/components/SolanaWalletPanel.js', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import .*\n/gm, '').replace(/^export /gm, ''), {
    loader: 'jsx',
    jsxFactory: 'element',
  }).code
  const slots = []
  let cursor = 0
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
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    walletPanelText,
    css() {},
    element: (type, props, ...children) => ({ type, props, children }),
    console: { error() {} },
    ...Object.fromEntries(['RefreshCwIcon', 'CheckCircleIcon', 'AlertCircleIcon'].map(name => [name, name])),
  }
  const Component = new Function(...Object.keys(context), `${code}\nreturn SolanaWalletPanel`)(
    ...Object.values(context)
  )
  const walletState = state ?? { address: 'wallet', status: 'verified', verified: true, known: false }
  const world = {
    solana: {
      getRequiredTokenAmount: () => required,
      refreshBalance,
    },
    entities: { player: { data: { rank: 0 } } },
    ui: { state: { active: true } },
  }
  const find = node => {
    if (node?.props?.['aria-label'] === 'Refresh builder access') return node.props
    for (const child of node?.children ?? []) {
      const found = find(child)
      if (found) return found
    }
  }
  const render = () => {
    cursor = 0
    return find(Component({ world, walletState, isBuilder: false }))
  }
  // every string the panel would show, in order
  render.texts = () => {
    cursor = 0
    const out = []
    const walk = node => {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach(walk)
      else if (node?.children) node.children.forEach(walk)
    }
    walk(Component({ world, walletState, isBuilder: false }))
    return out
  }
  return render
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

for (const mode of ['fast', 'slow', 'reject', 'throw']) {
  test(`panel refresh: ${mode} request locks until settled and two seconds after press`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
    let resolve,
      reject,
      calls = 0
    const render = panel(() => {
      calls++
      if (mode === 'throw') throw Error('failed')
      return new Promise((yes, no) => {
        resolve = yes
        reject = no
      })
    })
    const click = { detail: 0 }
    const first = render()
    assert.equal(first.disabled, false)
    const pending = first.onClick(click)
    await first.onClick(click) // A second press before React renders must also be refused.
    assert.equal(calls, 1)
    assert.equal(render().disabled, true)
    if (mode === 'slow') {
      t.mock.timers.tick(2500)
      assert.equal(render().disabled, true)
      await first.onClick(click)
      assert.equal(calls, 1)
      resolve()
    } else {
      if (mode === 'reject') reject(Error('failed'))
      if (mode === 'fast') resolve()
      await flush()
      t.mock.timers.tick(1999)
      assert.equal(render().disabled, true)
      await first.onClick(click)
      assert.equal(calls, 1)
      t.mock.timers.tick(1)
    }
    await pending
    assert.equal(render().disabled, false)
    const next = render().onClick(click)
    assert.equal(calls, 2)
    if (mode !== 'throw') resolve()
    await flush()
    t.mock.timers.tick(2000)
    await next
    assert.equal(render().disabled, false)
  })
}

test('panel requirement: the amount is shown, and a world that grants nothing by token says so', () => {
  const rich = { address: 'wallet', status: 'verified', verified: true, known: true, balance: 50000 }
  const shown = panel(async () => {}, { required: 10000, walletState: rich }).texts()
  assert.ok(shown.includes(`Builder access requires ${(10000).toLocaleString()} tokens`))
  assert.ok(shown.includes('No builder access · press refresh to check builder access'))
  for (const required of [null, 0, -5, NaN]) {
    const texts = panel(async () => {}, { required, walletState: rich }).texts()
    assert.ok(texts.includes('Builder access by token is not set up in this world'), String(required))
    assert.ok(!texts.some(text => /requires/.test(text)), String(required))
    // no hint to press refresh for a rank this world does not give
    assert.ok(texts.includes('No builder access'), String(required))
  }
})
