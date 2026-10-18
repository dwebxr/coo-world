import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { transformSync } from 'esbuild'
import { walletPanelText } from '../src/client/components/walletPanelText.js'

// Exercise the actual JSX handler and disabled prop with persistent hook state, without a DOM.
function panel(refreshBalance) {
  const source = fs.readFileSync(new URL('../src/client/components/SolanaWalletButton.js', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import .*\n/gm, '').replace('export function', 'function'), {
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
    useEffect() {},
    useCallback: fn => fn,
    useRank: () => ({ isBuilder: false }),
    walletPanelText,
    storage: { get: () => null },
    cls: value => value,
    css() {},
    element: (type, props, ...children) => ({ type, props, children }),
    console: { error() {} },
    ...Object.fromEntries(
      ['RefreshCwIcon', 'CheckCircleIcon', 'AlertCircleIcon', 'WalletIcon', 'XIcon', 'LoaderIcon'].map(name => [
        name,
        name,
      ])
    ),
  }
  const Component = new Function(...Object.keys(context), `${code}\nreturn SolanaWalletButton`)(
    ...Object.values(context)
  )
  const world = {
    solana: {
      getState: () => ({ address: 'wallet', status: 'verified', verified: true, known: false }),
      getRequiredTokenAmount: () => 10000,
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
  return () => {
    cursor = 0
    return find(Component({ world }))
  }
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
