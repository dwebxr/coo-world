import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { transformSync } from 'esbuild'

// Render the actual WalletButton JSX with persistent hook state and stand-in panels, without a DOM.
function shell(world, stored = null) {
  const source = fs.readFileSync(new URL('../src/client/components/WalletButton.js', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import .*\n/gm, '').replace(/^export /gm, ''), {
    loader: 'jsx',
    jsxFactory: 'element',
  }).code
  const slots = []
  let cursor = 0
  const writes = []
  const SolanaWalletPanel = () => null
  const EvmWalletPanel = () => null
  const TipMarkerNotice = () => null
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
    storage: { get: () => stored, set: (key, value) => writes.push([key, value]) },
    ControlPriorities: { CORE_UI: 0 },
    cls: (...args) =>
      args.flatMap(arg => (typeof arg === 'string' ? [arg] : Object.keys(arg).filter(key => arg[key]))).join(' '),
    css() {},
    blurIfPointer() {},
    SolanaWalletPanel,
    EvmWalletPanel,
    TipMarkerNotice,
    element: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    console,
    ...Object.fromEntries(['WalletIcon', 'XIcon', 'LoaderIcon'].map(name => [name, name])),
  }
  const Component = new Function(...Object.keys(context), `${code}\nreturn WalletButton`)(...Object.values(context))
  const render = () => {
    cursor = 0
    // the collapsed/tab refs are synced in an effect; mirror that here
    const tree = Component({ world })
    return tree
  }
  const all = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (pred(node)) out.push(node)
    for (const child of node.children ?? []) all(child, pred, out)
    return out
  }
  const view = () => {
    const tree = render()
    const panel = all(tree, n => n.props?.id === 'solana-wallet-panel')[0]
    const wrappers = all(tree, n => n.props?.className === 'wallet-tab-panel')
    const wrapperOf = type => wrappers.find(w => w.children.some(child => child?.type === type))
    return {
      tree,
      panel,
      toggle: all(
        tree,
        n => typeof n.props?.className === 'string' && n.props.className.includes('solana-wallet-toggle')
      )[0],
      tabs: all(tree, n => n.props?.role === 'tab'),
      solana: wrapperOf(SolanaWalletPanel),
      evm: wrapperOf(EvmWalletPanel),
      notice: all(tree, n => n.type === TipMarkerNotice)[0],
      noticeInPanel: all(panel, n => n.type === TipMarkerNotice).length > 0,
      dot: all(tree, n => typeof n.props?.className === 'string' && n.props.className.includes('solana-wallet-dot'))[0],
    }
  }
  return { view, writes }
}

const makeWorld = ({ solana = true, evm = true, solanaState, evmState } = {}) => ({
  solana: solana ? { getState: () => solanaState ?? { status: 'disconnected' } } : undefined,
  evm: evm ? { getState: () => evmState ?? { status: 'disconnected' } } : undefined,
  entities: { player: { data: { rank: 0 } } },
  ui: { state: { active: true } },
  controls: { bind: () => ({ escape: {}, release() {} }) },
  on() {},
  off() {},
})

test('wallet shell: panels stay mounted while collapsed and on the other tab', () => {
  const { view, writes } = shell(makeWorld(), { collapsed: true, tab: 'evm' })
  let v = view()
  assert.equal(v.panel.props.hidden, true, 'collapsed panel is hidden, not removed')
  assert.ok(v.solana && v.evm, 'both chain panels are mounted')
  assert.equal(v.solana.props.hidden, true)
  assert.equal(v.evm.props.hidden, false, 'remembered tab selected')
  assert.deepEqual(
    v.tabs.map(tab => [tab.children[0], tab.props['aria-selected']]),
    [
      ['Solana', false],
      ['EVM', true],
    ]
  )
  v.tabs[0].props.onClick({ detail: 0 })
  v = view()
  assert.equal(v.solana.props.hidden, false)
  assert.equal(v.evm.props.hidden, true)
  assert.deepEqual(writes.at(-1), ['solanaWalletUI', { collapsed: true, tab: 'solana' }])
  v.toggle.props.onClick({ detail: 0 })
  v = view()
  assert.equal(v.panel.props.hidden, false)
  assert.ok(v.solana && v.evm, 'expanding does not remount')
  assert.deepEqual(writes.at(-1), ['solanaWalletUI', { collapsed: false, tab: 'solana' }])
})

test('wallet shell: a single chain shows no tabs and no tabpanel roles', () => {
  for (const [world, key] of [
    [makeWorld({ solana: false }), 'evm'],
    [makeWorld({ evm: false }), 'solana'],
  ]) {
    const v = shell(world, { collapsed: false, tab: key === 'evm' ? 'solana' : 'evm' }).view()
    assert.equal(v.tabs.length, 0)
    assert.equal(v[key].props.hidden, false, 'a stored tab for a disabled chain falls back')
    assert.equal(v[key].props.role, undefined)
    assert.equal(v[key === 'evm' ? 'solana' : 'evm'], undefined)
  }
})

test('wallet shell: toggle status aggregates both chains; the green/orange dot stays Solana-only', () => {
  const cases = [
    [{}, {}, 'disconnected', false],
    [{ status: 'signing' }, {}, 'connecting', false],
    [{}, { status: 'connecting' }, 'connecting', false],
    [{}, { status: 'verified', verified: true, address: '0xabc' }, 'evm', true],
    [{ status: 'verified', address: 'sol' }, { status: 'verified', verified: true }, 'nobuild', true],
  ]
  for (const [solanaState, evmState, status, dot] of cases) {
    const world = makeWorld({
      solanaState: { status: 'disconnected', ...solanaState },
      evmState: { status: 'disconnected', ...evmState },
    })
    const v = shell(world, { collapsed: true }).view()
    assert.ok(v.toggle.props.className.split(' ').includes(status), `${status}: ${v.toggle.props.className}`)
    assert.equal(!!v.dot, dot, status)
  }
})

test('wallet shell: the tip notice sits outside the panel, so a folded panel does not hide it; EVM worlds only', () => {
  for (const collapsed of [true, false]) {
    const v = shell(makeWorld(), { collapsed }).view()
    assert.ok(v.notice, `mounted (collapsed: ${collapsed})`)
    assert.equal(v.noticeInPanel, false)
  }
  assert.equal(shell(makeWorld({ evm: false }), { collapsed: false }).view().notice, undefined)
})
