import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Ranks } from '../src/core/extras/ranks.js'
import { clientWorld, loadClient } from './lib/clientHarness.mjs'
import { strictDecode } from '../src/core/extras/strictDecode.js'
import { packetMethodById } from '../src/core/packets.js'
import { isEvmAddress, isEvmSigninSignature, parseEvmChainIds, sameEvmAddress } from '../src/core/extras/evmChains.js'
import { encodeTransfer, isTxHash } from '../src/core/extras/evmAbi.js'
import {
  KNOWN_CHAINS,
  explorerTxUrl,
  parseTipAmount,
  parseTipTokens,
  tipAmountReason,
} from '../src/core/extras/evmTokens.js'
import { WALLET_LINKS, isAppScheme, sameHost } from '../src/core/extras/walletLinks.js'
import * as tipOutcome from '../src/core/extras/tipOutcome.js'

const deps = {
  isEvmAddress,
  isEvmSigninSignature,
  parseEvmChainIds,
  sameEvmAddress,
  encodeTransfer,
  isTxHash,
  KNOWN_CHAINS,
  explorerTxUrl,
  parseTipAmount,
  parseTipTokens,
  tipAmountReason,
  WALLET_LINKS,
  isAppScheme,
  sameHost,
  ...tipOutcome,
}

const checksummed = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const lower = checksummed.toLowerCase()
const otherAddress = '0x1563915e194D8CfBA1943570603F7606A3115508'
const nonce = Buffer.alloc(32, 7).toString('hex')
const message = `world.example wants you to sign in with your Ethereum account:\n${checksummed}\n\nVerify wallet ownership for this world. This does not authorize any transaction.\n\nURI: https://world.example\nVersion: 1\nChain ID: 137\nNonce: ${nonce}\nIssued At: 2026-11-08T00:00:00.000Z\nExpiration Time: 2026-11-08T00:01:00.000Z`
const signature = `0x${'ab'.repeat(65)}`

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
const packets = world =>
  world.packets.map(packet => {
    const [id, data] = strictDecode(packet, { maxNodes: 4096, build: true }).value
    return [packetMethodById(id), data]
  })
const requests = (world, name) => packets(world).filter(([method]) => method === `on${name}`)

function makeProvider(accounts = [lower]) {
  const provider = new EventEmitter()
  provider.accounts = accounts
  provider.calls = []
  provider.reject = null
  provider.signature = signature
  provider.request = async ({ method, params }) => {
    provider.calls.push([method, params])
    if (provider.reject === method) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
    if (method === 'eth_requestAccounts') return provider.accounts
    if (method === 'personal_sign') return provider.signature
    if (method === 'wallet_revokePermissions') return null
    if (provider.handlers?.[method]) return provider.handlers[method](params)
    throw new Error(`unsupported ${method}`)
  }
  return provider
}

// A window that announces the given EIP-6963 providers when asked, plus an optional legacy window.ethereum.
function makeWindow({ announced = [], ethereum } = {}) {
  const win = new EventTarget()
  if (ethereum) win.ethereum = ethereum
  win.addEventListener('eip6963:requestProvider', () => {
    for (const detail of announced) win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
  })
  return win
}

function setup(t, { env = { PUBLIC_EVM_CHAIN_IDS: '137' }, provider = makeProvider(), win, options } = {}) {
  const world = clientWorld()
  world.entities.player = { data: { id: 'player', rank: Ranks.VISITOR } }
  world.chat = { add() {} }
  const states = []
  world.on('evm:state', state => states.push(state))
  const create = loadClient('client/evm-integration.js', 'createEvmIntegration', {
    process: { env },
    window: win ?? makeWindow({ ethereum: provider }),
    ...deps,
  })
  const evm = create(world, options)
  t.after(() => {
    world.network.ws = null
    world.network.destroy()
  })
  const start = async id => {
    const promise = evm.connect(id)
    await flush()
    return { promise, attempt: requests(world, 'RequestEvmNonce').at(-1)?.[1].attempt }
  }
  const challenge = (attempt, data = {}) => world.network.onEvmNonce({ attempt, nonce, message, ...data })
  const status = (attempt, data = {}) =>
    world.network.onEvmWalletStatus({ attempt, verified: true, wallet: checksummed, reason: 'ok', ...data })
  const verify = async id => {
    const run = await start(id)
    challenge(run.attempt)
    await flush()
    status(run.attempt)
    assert.equal(await run.promise, checksummed)
    return run
  }
  return { world, evm, provider, states, start, challenge, status, verify }
}

test('evm client: disabled without PUBLIC_EVM_CHAIN_IDS and never touches the window', () => {
  for (const env of [{}, { PUBLIC_EVM_CHAIN_IDS: '' }, { PUBLIC_EVM_CHAIN_IDS: 'polygon' }]) {
    const win = new Proxy({}, { get: () => assert.fail('disabled integration touched window') })
    const world = clientWorld()
    const create = loadClient('client/evm-integration.js', 'createEvmIntegration', {
      process: { env },
      window: win,
      ...deps,
    })
    assert.equal(create(world), null)
    assert.equal(world.evm, undefined)
    world.network.ws = null
    world.network.destroy()
  }
})

test('evm client: lowercase wallet address, exact hex message and checksummed acceptance', async t => {
  const h = setup(t)
  await h.verify()
  assert.deepEqual(requests(h.world, 'RequestEvmNonce'), [['onRequestEvmNonce', { address: lower, attempt: 1 }]])
  assert.deepEqual(h.provider.calls, [
    ['eth_requestAccounts', undefined],
    ['personal_sign', [`0x${Buffer.from(message, 'utf8').toString('hex')}`, lower]],
  ])
  assert.deepEqual(requests(h.world, 'RequestEvmVerify')[0][1], { address: lower, signature, nonce, attempt: 1 })
  assert.deepEqual(h.evm.getState(), { status: 'verified', address: checksummed, verified: true })
  assert.equal(h.evm.isVerified(), true)
  assert.equal(h.evm.getAddress(), checksummed)
  assert.deepEqual(
    h.states.map(state => state.status),
    ['connecting', 'signing', 'verified']
  )
  assert.deepEqual(h.evm.getConfig(), { chainIds: [137] })
  assert.equal(h.world.toasts.length, 0)
})

test('evm client: status gate ignores foreign attempts, other wallets and unsolicited success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = setup(t)
  const run = await h.start()
  h.challenge(run.attempt)
  await flush()
  h.status(run.attempt + 1)
  h.status(run.attempt, { wallet: otherAddress })
  h.status(run.attempt, { wallet: 'garbage' })
  h.world.network.onEvmWalletStatus({ verified: true, wallet: checksummed })
  h.world.network.onEvmWalletStatus({ attempt: 0, verified: true, wallet: checksummed })
  h.world.network.onEvmWalletStatus({ attempt: run.attempt, verified: 'yes' })
  assert.equal(h.evm.isVerified(), false)
  assert.equal(h.evm.getState().status, 'signing')
  t.mock.timers.tick(14999)
  assert.equal(h.evm.getState().status, 'signing')
  t.mock.timers.tick(1)
  assert.equal(await run.promise, null)
  assert.equal(h.evm.getState().status, 'unverified')
  assert.deepEqual(h.world.toasts, ['Could not verify your EVM wallet. Please sign again.'])
  // A success that arrives after the deadline must not leave the server verified behind an unverified UI.
  assert.equal(requests(h.world, 'RevokeEvmWallet').length, 1, 'timed-out attempt withdrawn on the server')
  h.status(run.attempt)
  assert.equal(h.evm.isVerified(), false)
})

test('evm client: wallet rejections and server reasons produce specific toasts', async t => {
  const h = setup(t)
  h.provider.reject = 'eth_requestAccounts'
  assert.equal(await h.evm.connect(), null)
  assert.equal(h.evm.getState().status, 'disconnected')
  assert.equal(requests(h.world, 'RequestEvmNonce').length, 0)
  assert.equal(requests(h.world, 'RevokeEvmWallet').length, 0, 'nothing started on the server')
  h.provider.reject = 'personal_sign'
  const rejected = await h.start()
  h.challenge(rejected.attempt)
  assert.equal(await rejected.promise, null)
  assert.equal(h.evm.getState().status, 'unverified')
  assert.equal(requests(h.world, 'RequestEvmVerify').length, 0)
  assert.equal(requests(h.world, 'RevokeEvmWallet').length, 1, 'pending challenge withdrawn')
  h.provider.reject = null
  const expired = await h.start()
  h.challenge(expired.attempt)
  await flush()
  h.world.network.onEvmWalletStatus({ attempt: expired.attempt, verified: false, reason: 'nonce_expired' })
  assert.equal(await expired.promise, null)
  assert.deepEqual(h.world.toasts, [
    'Request rejected in the wallet.',
    'Request rejected in the wallet.',
    'Signature expired. Please sign again.',
  ])
  assert.equal(requests(h.world, 'RevokeEvmWallet').length, 2)
  // the server's other reasons, each with its own message; an unknown one gets the general message
  for (const [reason, toast] of [
    ['signature_invalid', 'Signature not accepted. Please sign again.'],
    ['contract_unsupported', 'Signature not accepted. Smart-contract wallets are not supported in this world.'],
    ['unavailable', "Could not check the wallet's signature right now. Please try again."],
    ['something_new', 'Could not verify your EVM wallet. Please sign again.'],
  ]) {
    const run = await h.start()
    h.challenge(run.attempt)
    await flush()
    h.world.network.onEvmWalletStatus({ attempt: run.attempt, verified: false, reason })
    assert.equal(await run.promise, null)
    assert.equal(h.world.toasts.at(-1), toast, reason)
  }
  // A later success after the failures still works.
  await h.verify()
})

test('evm client: a contract account signature (longer than 65 bytes) is sent; an oversized one is not', async t => {
  for (const [bytes, sent] of [
    [1024, true],
    [4096, true],
    [4097, false],
  ]) {
    const h = setup(t)
    h.provider.signature = `0x${'ab'.repeat(bytes)}`
    const run = await h.start()
    h.challenge(run.attempt)
    await flush()
    const verify = requests(h.world, 'RequestEvmVerify')
    assert.equal(verify.length, sent ? 1 : 0, `${bytes} bytes`)
    if (sent) {
      assert.equal(verify[0][1].signature, h.provider.signature)
      h.status(run.attempt)
      assert.equal(await run.promise, checksummed)
    } else {
      assert.equal(await run.promise, null)
    }
  }
})

test('evm client: nonce cooldown retries once; malformed or late nonces fail closed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = setup(t)
  const run = await h.start()
  h.challenge(run.attempt, { nonce: undefined, message: undefined, retryAfterMs: 3000 })
  t.mock.timers.tick(2999)
  assert.equal(requests(h.world, 'RequestEvmNonce').length, 1)
  t.mock.timers.tick(1)
  assert.equal(requests(h.world, 'RequestEvmNonce').length, 2)
  h.world.network.onEvmNonce({ attempt: run.attempt, retryAfterMs: 3000 })
  assert.equal(await run.promise, null, 'a second cooldown gives up')
  for (const data of [
    { nonce: 'A'.repeat(64) },
    { nonce: 'a'.repeat(63) },
    { message: 42 },
    { message: '' },
    { message: 'x'.repeat(1025) },
    { retryAfterMs: 0 },
    { retryAfterMs: 6000 },
  ]) {
    const next = await h.start()
    h.world.network.onEvmNonce({ attempt: next.attempt, nonce, message, ...data })
    assert.equal(await next.promise, null, JSON.stringify(data))
  }
  const late = await h.start()
  t.mock.timers.tick(15000)
  assert.equal(await late.promise, null)
  assert.equal(requests(h.world, 'RequestEvmVerify').length, 0)
})

test('evm client: a malformed wallet signature is never sent', async t => {
  const h = setup(t)
  for (const bad of ['0x123', 'abcd', '0x', 42]) {
    h.provider.signature = bad
    const run = await h.start()
    h.challenge(run.attempt)
    assert.equal(await run.promise, null, String(bad))
  }
  assert.equal(requests(h.world, 'RequestEvmVerify').length, 0)
  h.provider.accounts = ['not-an-address']
  assert.equal(await h.evm.connect(), null)
  assert.equal(requests(h.world, 'RequestEvmNonce').length, 4)
})

test('evm client: accountsChanged keeps the same account, disconnects on a switch or revoke', async t => {
  const h = setup(t)
  // A wallet that reports the same account while eth_requestAccounts is still pending proceeds.
  const pending = h.evm.connect()
  h.provider.emit('accountsChanged', [lower])
  await flush()
  const attempt = requests(h.world, 'RequestEvmNonce').at(-1)[1].attempt
  h.challenge(attempt)
  await flush()
  h.status(attempt)
  assert.equal(await pending, checksummed)
  h.provider.emit('accountsChanged', [checksummed])
  h.provider.emit('accountsChanged', [lower])
  assert.equal(h.evm.isVerified(), true)
  h.provider.emit('accountsChanged', [otherAddress])
  assert.deepEqual(h.evm.getState(), { status: 'disconnected', address: null, verified: false })
  assert.equal(requests(h.world, 'RevokeEvmWallet').length, 1)
  assert.deepEqual(h.world.toasts, ['Wallet account changed. Reconnect and sign again.'])
  assert.equal(h.provider.listenerCount('accountsChanged'), 0)
  // A switch is not a site disconnect: no wallet_revokePermissions.
  assert.equal(h.provider.calls.filter(([method]) => method === 'wallet_revokePermissions').length, 0)
  await h.verify()
  h.provider.emit('accountsChanged', [])
  assert.equal(h.evm.getState().status, 'disconnected')
  assert.equal(requests(h.world, 'RevokeEvmWallet').length, 2)
})

for (const [name, event] of [
  ['an empty account list (site revoked)', []],
  ['a different account', [otherAddress]],
]) {
  test(`evm client: ${name} while eth_requestAccounts is pending cancels the attempt`, async t => {
    const h = setup(t)
    let resolveAccounts
    const request = h.provider.request
    h.provider.request = args =>
      args.method === 'eth_requestAccounts' ? new Promise(resolve => (resolveAccounts = resolve)) : request(args)
    const pending = h.evm.connect()
    await flush()
    h.provider.emit('accountsChanged', event)
    resolveAccounts([lower])
    assert.equal(await pending, null)
    assert.equal(requests(h.world, 'RequestEvmNonce').length, 0, 'no nonce, no signature prompt')
    assert.equal(h.evm.isVerified(), false)
    // The next attempt is not affected by the old event.
    h.provider.request = request
    await h.verify()
  })
}

test('evm client: an account switch while signing cancels the attempt', async t => {
  const h = setup(t)
  const run = await h.start()
  h.provider.emit('accountsChanged', [otherAddress])
  h.challenge(run.attempt)
  assert.equal(await run.promise, null)
  assert.equal(requests(h.world, 'RequestEvmVerify').length, 0)
  assert.equal(h.evm.getState().status, 'disconnected')
})

test('evm client: disconnect revokes the session and the site permission best effort', async t => {
  const h = setup(t)
  await h.verify()
  h.provider.request = async ({ method }) => {
    h.provider.calls.push([method])
    throw new Error('unsupported')
  }
  assert.equal(h.evm.disconnect(), true)
  await flush()
  assert.deepEqual(h.evm.getState(), { status: 'disconnected', address: null, verified: false })
  assert.equal(requests(h.world, 'RevokeEvmWallet').length, 1)
  assert.deepEqual(h.provider.calls.at(-1), ['wallet_revokePermissions'])
  assert.equal(h.provider.listenerCount('accountsChanged'), 0)
  // The server's unsolicited withdrawal afterwards is harmless.
  h.world.network.onEvmWalletStatus({ verified: false })
  assert.equal(h.evm.getState().status, 'disconnected')
})

test('evm client: EIP-6963 discovery lists announced wallets and connects the chosen one', async t => {
  const rabby = makeProvider([lower])
  const metamask = makeProvider([lower])
  const win = makeWindow({
    ethereum: makeProvider(),
    announced: [
      {
        info: { uuid: 'mm', name: 'MetaMask', icon: 'data:image/svg+xml;base64,AAAA', rdns: 'io.metamask' },
        provider: metamask,
      },
      { info: { uuid: 'rb', name: '  Rabby  ', icon: 'https://evil.example/icon.png' }, provider: rabby },
      { info: { uuid: 'bad', name: 'No request' }, provider: {} },
      { info: { name: 'No uuid' }, provider: makeProvider() },
    ],
  })
  const h = setup(t, { win })
  assert.deepEqual(h.evm.getProviders(), [
    { id: 'mm', name: 'MetaMask', icon: 'data:image/svg+xml;base64,AAAA' },
    { id: 'rb', name: 'Rabby', icon: null },
  ])
  assert.equal(await h.evm.connect(), null, 'two wallets and no choice is refused')
  // A later announcement cannot take over an existing uuid (and its name and icon) with another provider.
  const hostile = makeProvider([otherAddress])
  win.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: 'rb', name: 'Rabby', icon: 'data:image/png;base64,AA' }, provider: hostile },
    })
  )
  assert.equal(h.evm.getProviders()[1].icon, null)
  await h.verify('rb')
  assert.equal(rabby.calls[0][0], 'eth_requestAccounts')
  assert.equal(hostile.calls.length, 0)
  assert.equal(metamask.calls.length, 0)
  assert.equal(win.ethereum.calls.length, 0, 'legacy injection is not used when wallets announce')
  // The chosen wallet is remembered, so a "Sign" retry without an id (after the panel remounts) uses it.
  rabby.reject = 'personal_sign'
  const rejected = await h.start('rb')
  h.challenge(rejected.attempt)
  assert.equal(await rejected.promise, null)
  rabby.reject = null
  const calls = rabby.calls.length
  await h.verify()
  assert.ok(rabby.calls.length > calls, 'retry went to the remembered wallet')
  assert.equal(metamask.calls.length, 0)
})

test('evm client: falls back to window.ethereum only when nothing announces', async t => {
  const h = setup(t)
  assert.deepEqual(h.evm.getProviders(), [{ id: 'injected', name: 'Browser wallet', icon: null }])
  await h.verify('injected')
  const none = setup(t, { win: makeWindow() })
  assert.deepEqual(none.evm.getProviders(), [])
  assert.equal(await none.evm.connect(), null)
  assert.equal(none.world.toasts.length, 1)
})

test('evm client: dispose on close drops listeners, timers and late packets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const late = makeProvider()
  const win = makeWindow({ ethereum: makeProvider() })
  const h = setup(t, { win })
  const run = await h.start()
  h.world.network.disposeWallet('close')
  assert.equal(await run.promise, null)
  assert.equal(h.provider.listenerCount('accountsChanged'), 0)
  assert.equal(h.world.listenerCount('evm:nonce'), 0)
  assert.equal(h.world.listenerCount('evm:walletStatus'), 0)
  assert.deepEqual(h.states.at(-1), { status: 'disconnected', address: null, verified: false }, 'UI told')
  h.challenge(run.attempt)
  h.status(run.attempt)
  win.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'x', name: 'X' }, provider: late } })
  )
  assert.equal(h.evm.isVerified(), false)
  assert.equal(await h.evm.connect(), null)
  assert.equal(h.world.toasts.length, 0, 'disposed integration stays silent')
  t.mock.timers.tick(30000)
})

// --- P2a: tips ---

const JPYC = { symbol: 'JPYC', address: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29', decimals: 18 }
const recipient = otherAddress
const txHash = `0x${'cd'.repeat(32)}`
const ticket = 'a1'.repeat(16)
const tipEnv = { PUBLIC_EVM_CHAIN_IDS: '137', PUBLIC_EVM_TIP_TOKENS: 'JPYC,USDC' }

// a Storage that keeps what was written and in which order it was used; `broken` makes every access throw,
// `unreadable` only reading, `unremovable` only removing
function fakeStorage({ broken = false, unreadable = false, unremovable = false } = {}) {
  const items = new Map()
  const log = []
  const use = (name, fn) => {
    log.push(name)
    if (broken || (unreadable && name === 'getItem') || (unremovable && name === 'removeItem')) {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    return fn()
  }
  return {
    items,
    log,
    get length() {
      return items.size
    },
    key: index => use('key', () => [...items.keys()][index] ?? null),
    getItem: key => use('getItem', () => (items.has(key) ? items.get(key) : null)),
    setItem: (key, value) => use('setItem', () => void items.set(key, String(value))),
    removeItem: key => use('removeItem', () => void items.delete(key)),
  }
}
// what tip() says it asked the wallet for (the time aside)
const asked = (amount, patch = {}) => ({ name: 'Bob', address: '0x1563…5508', amount, token: 'JPYC', ...patch })
const withoutTime = request => {
  assert.equal(typeof request.at, 'number')
  const copy = { ...request }
  delete copy.at
  return copy
}
const timeless = outcome => (outcome.request ? { ...outcome, request: withoutTime(outcome.request) } : outcome)
// a note as the storage keeps it, its id aside (16 hex digits, a new one for each request)
const withoutId = marker => {
  assert.match(marker.id, /^[0-9a-f]{16}$/)
  const copy = { ...marker }
  delete copy.id
  return copy
}

// `windowStorage`: no storage is passed to the integration, which then uses its window's localStorage: the
// given `storage`, or none at all for 'missing'
// `pageClock`: the integration's clock of this page's time (performance.now when none is given)
function tipSetup(
  t,
  { chain = '0x89', storage = fakeStorage(), tipStorage = () => storage, windowStorage = false, pageClock } = {}
) {
  const provider = makeProvider()
  const win = makeWindow({ ethereum: provider })
  if (windowStorage === true) win.localStorage = storage
  const options = { ...(windowStorage ? {} : { tipStorage }), ...(pageClock ? { pageClock } : {}) }
  const h = setup(t, { env: tipEnv, provider, win, options })
  h.storage = storage
  // the notes in the storage, each under its own key, in the order they were written
  h.notes = () =>
    [...storage.items].filter(([key]) => key.startsWith('evmTipRequest:')).map(([, text]) => JSON.parse(text))
  // the one note, where at most one is expected
  h.marker = () => {
    const notes = h.notes()
    assert.ok(notes.length <= 1, `one note at most: ${notes.length}`)
    return notes[0] ?? null
  }
  // what the notice was told, each time: the notes, newest first
  h.markers = []
  h.world.on('evm:tipMarkers', value => h.markers.push(value))
  // the recipient as the Players list has it
  h.world.entities.players = new Map([['p2', { data: { id: 'p2', name: 'Bob' } }]])
  h.chain = chain
  h.provider.handlers = {
    eth_accounts: () => [lower],
    eth_chainId: () => h.chain,
    eth_sendTransaction: () => txHash,
  }
  // The server's tip intent for the last request, as onRequestEvmTipIntent would build it.
  h.intent = (patch = {}) => {
    const request = requests(h.world, 'RequestEvmTipIntent').at(-1)[1]
    h.world.network.onEvmTipIntent({
      id: request.id,
      ok: true,
      to: request.to,
      recipient,
      chainId: 137,
      token: { symbol: 'JPYC', address: JPYC.address, decimals: 18 },
      amount: request.amount,
      units: (BigInt(request.amount) * 10n ** 18n).toString(),
      ticket,
      ...patch,
    })
  }
  h.sent = () => h.provider.calls.filter(([method]) => method === 'eth_sendTransaction')
  return h
}

test('evm tips: the transfer goes from the verified wallet to the intent recipient with the exact amount', async t => {
  const h = tipSetup(t)
  await h.verify()
  assert.deepEqual(h.evm.getTipTokens(), [
    { symbol: 'JPYC', decimals: 18, min: '1', max: '1000' },
    { symbol: 'USDC', decimals: 6, min: '0.01', max: '10' },
  ])
  const pending = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '100' })
  await flush()
  assert.deepEqual(requests(h.world, 'RequestEvmTipIntent')[0][1], { id: 1, to: 'p2', token: 'JPYC', amount: '100' })
  h.intent()
  assert.deepEqual(timeless(await pending), {
    ok: true,
    txHash,
    explorerUrl: `https://polygonscan.com/tx/${txHash}`,
    ticket,
    reported: true,
    request: asked('100'),
  })
  // the hash is reported against the server's ticket, after the wallet returned it
  assert.deepEqual(requests(h.world, 'EvmTip'), [['onEvmTip', { ticket, txHash }]])
  assert.deepEqual(h.sent(), [
    [
      'eth_sendTransaction',
      [
        {
          from: checksummed,
          to: JPYC.address,
          data: encodeTransfer(recipient, 100n * 10n ** 18n),
          value: '0x0',
          chainId: '0x89',
        },
      ],
    ],
  ])
  assert.equal(h.provider.calls.filter(([method]) => method === 'wallet_switchEthereumChain').length, 0)
})

test('evm tips: an intent that disagrees with the local request is never sent', async t => {
  for (const patch of [
    { units: '1' },
    { to: 'p3' },
    { chainId: 1 },
    { recipient: checksummed },
    { recipient: 'nope' },
    { token: { symbol: 'JPYC', address: `0x${'ee'.repeat(20)}`, decimals: 18 } },
    { token: { symbol: 'JPYC', address: JPYC.address, decimals: 6 } },
  ]) {
    const h = tipSetup(t)
    await h.verify()
    const pending = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '5' })
    await flush()
    h.intent(patch)
    assert.deepEqual(await pending, { ok: false, reason: 'mismatch' }, JSON.stringify(patch))
    assert.equal(h.sent().length, 0)
  }
})

test('evm tips: local checks, server refusals, timeouts and a busy wallet', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = tipSetup(t)
  assert.deepEqual(await h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' }), {
    ok: false,
    reason: 'not_verified',
  })
  await h.verify()
  assert.deepEqual(await h.evm.tip({ playerId: 'p2', token: 'DOGE', amount: '1' }), { ok: false, reason: 'bad_token' })
  assert.deepEqual(await h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '0.5' }), {
    ok: false,
    reason: 'below_minimum',
  })
  assert.deepEqual(await h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1e3' }), {
    ok: false,
    reason: 'bad_amount',
  })
  assert.deepEqual(await h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1001' }), {
    ok: false,
    reason: 'above_maximum',
  })
  assert.equal(requests(h.world, 'RequestEvmTipIntent').length, 0, 'nothing asked for invalid input')
  const refused = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  const busy = await h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  assert.deepEqual(busy, { ok: false, reason: 'busy' })
  const { id } = requests(h.world, 'RequestEvmTipIntent').at(-1)[1]
  h.world.network.onEvmTipIntent({ id: id + 1, ok: true })
  h.world.network.onEvmTipIntent({ id, ok: false, reason: 'recipient_unavailable' })
  assert.deepEqual(await refused, { ok: false, reason: 'recipient_unavailable' })
  const late = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  t.mock.timers.tick(10000)
  assert.deepEqual(await late, { ok: false, reason: 'timeout' })
  assert.equal(h.sent().length, 0)
})

test('evm tips: a different wallet account or a rejection in the wallet stops the transfer', async t => {
  const h = tipSetup(t)
  await h.verify()
  h.provider.handlers.eth_accounts = () => [otherAddress]
  const wrong = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.intent()
  assert.deepEqual(await wrong, { ok: false, reason: 'wrong_account' })
  h.provider.handlers.eth_accounts = () => [lower]
  h.provider.reject = 'eth_sendTransaction'
  const rejected = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.intent()
  assert.deepEqual(await rejected, { ok: false, reason: 'rejected' })
})

test('evm tips: switches to the tip chain, adding Polygon when the wallet does not know it', async t => {
  const h = tipSetup(t, { chain: '0x1' })
  await h.verify()
  let known = false
  h.provider.handlers.wallet_switchEthereumChain = ([{ chainId }]) => {
    if (!known) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 })
    h.chain = chainId
    return null
  }
  h.provider.handlers.wallet_addEthereumChain = ([params]) => {
    assert.equal(params.chainId, '0x89')
    assert.deepEqual(params.nativeCurrency, { name: 'POL', symbol: 'POL', decimals: 18 })
    known = true
    return null
  }
  const pending = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.intent()
  assert.equal((await pending).ok, true)
  assert.deepEqual(
    h.provider.calls
      .map(([method]) => method)
      .filter(method => method.startsWith('wallet_') || method === 'eth_chainId'),
    [
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
      'eth_chainId',
    ]
  )
  // A wallet that claims to switch but stays on another chain sends nothing.
  h.chain = '0x1'
  h.provider.handlers.wallet_switchEthereumChain = () => null
  const stuck = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.intent()
  assert.deepEqual(await stuck, { ok: false, reason: 'failed' })
  assert.equal(h.sent().length, 1)
})

test('evm tips: an account switch while waiting for the intent cancels it', async t => {
  const h = tipSetup(t)
  await h.verify()
  const pending = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.provider.emit('accountsChanged', [otherAddress])
  h.intent()
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' })
  assert.equal(h.sent().length, 0)
})

test('evm tips: receiving can be switched only while verified and when tips are configured', async t => {
  const h = tipSetup(t)
  assert.equal(h.evm.setReceiveTips(true), false)
  await h.verify()
  assert.equal(h.evm.setReceiveTips('yes'), false)
  assert.equal(h.evm.setReceiveTips(true), true)
  assert.deepEqual(requests(h.world, 'SetEvmTipReceive'), [['onSetEvmTipReceive', { enabled: true }]])
  const plain = setup(t)
  await plain.verify()
  assert.deepEqual(plain.evm.getTipTokens(), [])
  assert.equal(plain.evm.setReceiveTips(true), false)
  assert.equal(requests(plain.world, 'SetEvmTipReceive').length, 0)
})

test('evm tips: a network change in the wallet while sending is reported, not linked to Polygon', async t => {
  const h = tipSetup(t)
  await h.verify()
  // the wallet's late notice of our own switch (same chain) changes nothing
  h.provider.handlers.eth_sendTransaction = () => {
    h.provider.emit('chainChanged', '0x89')
    return txHash
  }
  const same = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.intent()
  assert.deepEqual(timeless(await same), {
    ok: true,
    txHash,
    explorerUrl: `https://polygonscan.com/tx/${txHash}`,
    ticket,
    reported: true,
    request: asked('1'),
  })
  h.provider.handlers.eth_sendTransaction = () => {
    h.provider.emit('chainChanged', '0x1')
    return txHash
  }
  const moved = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.intent()
  assert.deepEqual(timeless(await moved), {
    ok: true,
    txHash,
    explorerUrl: null,
    warning: 'chain_changed',
    ticket,
    reported: true,
    request: asked('1'),
  })
  assert.equal(h.provider.listenerCount('chainChanged'), 0, 'listener removed after each tip')
})

test('evm tips: without a valid ticket nothing is reported; a recheck is sent once per ticket', async t => {
  for (const bad of [undefined, 'A1'.repeat(16), 'a1'.repeat(15), 1]) {
    const h = tipSetup(t)
    await h.verify()
    const pending = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
    await flush()
    h.intent({ ticket: bad })
    const result = await pending
    assert.equal(result.ok, true)
    assert.equal(result.ticket, null)
    assert.equal(result.reported, false)
    assert.equal(requests(h.world, 'EvmTip').length, 0, String(bad))
  }
  const h = tipSetup(t)
  await h.verify()
  assert.equal(h.evm.recheckTip('nope', txHash), false)
  assert.equal(h.evm.recheckTip(ticket, '0x12'), false)
  assert.equal(h.evm.recheckTip(ticket, txHash), true)
  assert.equal(h.evm.recheckTip(ticket, txHash), false, 'once per ticket')
  assert.deepEqual(requests(h.world, 'EvmTip'), [['onEvmTip', { ticket, txHash }]])
  h.evm.dispose('test')
  assert.equal(h.evm.recheckTip('b2'.repeat(16), txHash), false, 'not after dispose')
})

test('evm tips: tip statuses from the server are relayed by ticket', async t => {
  const h = tipSetup(t)
  const seen = []
  h.world.on('evm:tipStatus', data => seen.push(data))
  assert.equal(h.evm.getTipStatus(ticket), null)
  h.world.network.onEvmTipStatus({ ticket, txHash, state: 'watching' })
  h.world.network.onEvmTipStatus({ ticket, txHash, state: 'confirmed' })
  assert.deepEqual(seen.at(-1), { ticket, txHash, state: 'confirmed' })
  // the latest status is kept for a form that subscribes late, for 32 tickets at most
  assert.deepEqual({ ...h.evm.getTipStatus(ticket) }, { ticket, txHash, state: 'confirmed' })
  for (let i = 0; i < 40; i++)
    h.world.network.onEvmTipStatus({ ticket: i.toString(16).padStart(32, '0'), state: 'watching' })
  assert.equal(h.evm.getTipStatus(ticket), null, 'oldest dropped')
  h.world.network.onEvmTipStatus({ ticket: 'bad', state: 'confirmed' })
  assert.equal(h.evm.getTipStatus('bad'), null)
  h.evm.dispose('test')
  assert.equal(h.evm.getTipStatus((39).toString(16).padStart(32, '0')), null, 'cleared on dispose')
})

test('evm tips: an account switch during the send still reports the transaction after the revoke', async t => {
  const h = tipSetup(t)
  await h.verify()
  h.provider.handlers.eth_sendTransaction = () => {
    h.provider.emit('accountsChanged', [otherAddress])
    return txHash
  }
  const pending = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.intent()
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.reported, true)
  const order = packets(h.world)
    .map(([method]) => method)
    .filter(method => method === 'onRevokeEvmWallet' || method === 'onEvmTip')
  assert.deepEqual(order, ['onRevokeEvmWallet', 'onEvmTip'])
})

// --- what the payer is told: how a send ended, and the note of a request (src/core/extras/tipOutcome.js) ---

// one tip of 1 JPYC to p2 through the wallet's eth_sendTransaction handler
async function sendTip(h, options = {}) {
  const pending = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1', ...options })
  await flush()
  h.intent(options.intent)
  return timeless(await pending)
}

test('evm tips: after the wallet was asked to send, anything but a hash or a rejection is an unknown outcome', async t => {
  const h = tipSetup(t)
  await h.verify()
  const unknown = { ok: false, reason: 'outcome_unknown', request: asked('1') }
  // the wallet took the request and then failed without saying no: a session that dropped, a relay timeout,
  // an internal error. The transfer may have been sent
  for (const error of [
    new Error('WalletConnect request failed'),
    Object.assign(new Error('The WalletConnect session ended.'), { code: 4100 }),
    Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 }),
    'a thrown string',
    null,
  ]) {
    h.provider.handlers.eth_sendTransaction = () => {
      throw error
    }
    assert.deepEqual(await sendTip(h), unknown, String(error?.message ?? error))
  }
  // an answer that is not a transaction hash (it had no text of its own before, and read as "try again")
  for (const answer of ['not-a-hash', `0x${'cd'.repeat(31)}`, null, undefined, { hash: txHash }]) {
    h.provider.handlers.eth_sendTransaction = () => answer
    assert.deepEqual(await sendTip(h), unknown, String(answer))
  }
  assert.equal(requests(h.world, 'EvmTip').length, 0, 'nothing to report to the server')
  // an explicit rejection is still "rejected", and the next tip is an ordinary one
  h.provider.reject = 'eth_sendTransaction'
  assert.deepEqual(await sendTip(h), { ok: false, reason: 'rejected' })
  h.provider.reject = null
  h.provider.handlers.eth_sendTransaction = () => txHash
  assert.equal((await sendTip(h)).ok, true)
})

test('evm tips: an error before the wallet was asked to send is "not sent", whatever it is', async t => {
  const h = tipSetup(t)
  await h.verify()
  // the same errors that mean "unknown" after the request mean "nothing was sent" before it
  for (const method of ['eth_accounts', 'eth_chainId']) {
    const original = h.provider.handlers[method]
    h.provider.handlers[method] = () => {
      throw Object.assign(new Error('The WalletConnect session ended.'), { code: 4100 })
    }
    assert.deepEqual(await sendTip(h), { ok: false, reason: 'failed' }, method)
    h.provider.handlers[method] = original
  }
  // a refused network switch is a rejection
  h.chain = '0x1'
  h.provider.handlers.wallet_switchEthereumChain = () => {
    throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
  }
  assert.deepEqual(await sendTip(h), { ok: false, reason: 'rejected' })
  assert.equal(h.sent().length, 0)
  assert.equal(h.marker(), null, 'no note of a request that was never made')
  assert.deepEqual(h.storage.log, [], 'the storage was not touched')
  assert.deepEqual(h.markers, [], 'and the notice was told nothing')
})

test('evm tips: the note of a request is written before the wallet is asked and removed on a known result', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const h = tipSetup(t)
  await h.verify()
  // written before eth_sendTransaction: a page that is gone when the wallet answers has left it behind
  let during
  h.provider.handlers.eth_sendTransaction = () => {
    during = { marker: h.marker(), log: [...h.storage.log], reported: requests(h.world, 'EvmTip').length }
    return txHash
  }
  assert.equal((await sendTip(h)).ok, true)
  const note = { name: 'Bob', address: '0x1563…5508', amount: '1', token: 'JPYC', at: 1_700_000_000_000 }
  assert.deepEqual({ ...during, marker: withoutId(during.marker) }, { marker: note, log: ['setItem'], reported: 0 })
  assert.ok(!JSON.stringify(during.marker).toLowerCase().includes(recipient.slice(6, -4).toLowerCase()), 'short form')
  // the hash was handed to the server: nothing is left, and the notice is told so
  assert.equal(h.marker(), null)
  assert.deepEqual(h.markers, [[]])
  assert.deepEqual(h.evm.getTipMarkers(), [])

  // an explicit rejection: removed
  h.provider.reject = 'eth_sendTransaction'
  assert.equal((await sendTip(h)).reason, 'rejected')
  assert.equal(h.marker(), null)
  assert.deepEqual(h.markers, [[], []])
  h.provider.reject = null

  // an unknown outcome: it stays, the notice gets it, and a reload (a new page on the same storage) reads it
  h.provider.handlers.eth_sendTransaction = () => {
    throw new Error('relay timeout')
  }
  assert.equal((await sendTip(h)).reason, 'outcome_unknown')
  const left = h.marker()
  assert.deepEqual(withoutId(left), note)
  assert.deepEqual(h.markers.at(-1), [left])
  const reloaded = tipSetup(t, { storage: h.storage })
  assert.deepEqual(reloaded.evm.getTipMarkers(), [left], 'before any sign-in')
  // for ten minutes
  t.mock.timers.tick(599_999)
  assert.deepEqual(reloaded.evm.getTipMarkers(), [left])
  t.mock.timers.tick(1)
  assert.deepEqual(reloaded.evm.getTipMarkers(), [])
  assert.equal(h.marker(), null, 'and it is removed from the storage')

  // dismissed by the player
  assert.equal((await sendTip(h)).reason, 'outcome_unknown')
  assert.notEqual(h.marker(), null)
  h.evm.dismissTipMarker(h.marker().id)
  assert.equal(h.marker(), null)
  assert.deepEqual(h.markers.at(-1), [])

  // a hash that could not be handed to the server (no ticket to report it against): the note stays for the
  // page that comes after this one
  h.provider.handlers.eth_sendTransaction = () => txHash
  const unreported = await sendTip(h, { intent: { ticket: undefined } })
  assert.equal(unreported.ok, true)
  assert.equal(unreported.reported, false)
  assert.notEqual(h.marker(), null)
  assert.deepEqual(h.markers.at(-1), [h.marker()])
})

test('evm tips: a reload while the wallet holds the request leaves the note for the next page', async t => {
  const h = tipSetup(t)
  await h.verify()
  // the wallet never answers this page
  h.provider.handlers.eth_sendTransaction = () => new Promise(() => {})
  h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '5' })
  await flush()
  h.intent()
  await flush()
  assert.equal(h.sent().length, 1)
  assert.deepEqual(h.markers, [], 'this page says nothing while the request is open')
  h.evm.dispose('test')
  const next = tipSetup(t, { storage: h.storage })
  const [only, ...more] = next.evm.getTipMarkers()
  assert.deepEqual(more, [])
  const { at, ...note } = withoutId(only)
  assert.deepEqual(note, asked('5'))
  assert.equal(typeof at, 'number')
})

test('evm tips: storage that throws or is missing changes nothing about the send', async t => {
  const broken = fakeStorage({ broken: true })
  const cases = [
    ['every access throws', { storage: broken }],
    [
      'reading the storage itself throws',
      {
        tipStorage: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError')
        },
      },
    ],
    ['no storage', { tipStorage: () => undefined }],
    // the note is written, but reading it back (to remove it, or to show it) throws
    ['reading throws', { storage: fakeStorage({ unreadable: true }) }],
    // the default: the window's localStorage, which this test window does not have
    ['the window has none', { windowStorage: 'missing' }],
  ]
  for (const [name, options] of cases) {
    const h = tipSetup(t, options)
    await h.verify()
    // (a storage whose reads throw gives no notes and marks that as incomplete: the notes are what is compared)
    assert.deepEqual([...h.evm.getTipMarkers()], [], name)
    assert.equal((await sendTip(h)).ok, true, name)
    assert.equal(h.sent().length, 1, name)
    assert.deepEqual(requests(h.world, 'EvmTip'), [['onEvmTip', { ticket, txHash }]], name)
    h.provider.handlers.eth_sendTransaction = () => {
      throw new Error('relay timeout')
    }
    assert.deepEqual(await sendTip(h), { ok: false, reason: 'outcome_unknown', request: asked('1') }, name)
    assert.deepEqual(
      h.markers.map(notes => [...notes]),
      [[], []],
      `${name}: nothing could be kept`
    )
    // a Dismiss (of a note an earlier read showed) does not throw either
    h.evm.dismissTipMarker('0123456789abcdef')
  }
  assert.ok(broken.log.includes('setItem') && broken.log.includes('removeItem'), 'the storage was tried')
  // a value under the prefix that is not a note, in a storage that refuses to remove it: not shown, and the
  // read does not throw
  const stuck = fakeStorage({ unremovable: true })
  stuck.items.set('evmTipRequest:0123456789abcdef', 'junk')
  const kept = tipSetup(t, { storage: stuck })
  assert.deepEqual(kept.evm.getTipMarkers(), [])
  assert.ok(stuck.log.includes('removeItem'))
  await kept.verify()
  assert.equal((await sendTip(kept)).ok, true)
  // and where the window has one, that is the storage used when none is passed
  const h = tipSetup(t, { windowStorage: true })
  await h.verify()
  h.provider.handlers.eth_sendTransaction = () => {
    throw new Error('relay timeout')
  }
  assert.equal((await sendTip(h)).reason, 'outcome_unknown')
  assert.deepEqual({ ...withoutId(h.marker()), at: 0 }, { ...asked('1'), at: 0 })
})

test('evm tips: the note counts its ten minutes from the request to the wallet, not from the intent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const h = tipSetup(t, { chain: '0x1' })
  await h.verify()
  // the wallet's network prompt is answered eight minutes after the intent came, and the request then fails
  // without an answer
  h.provider.handlers.wallet_switchEthereumChain = ([{ chainId }]) => {
    t.mock.timers.tick(480_000)
    h.chain = chainId
    return null
  }
  h.provider.handlers.eth_sendTransaction = () => {
    throw new Error('relay timeout')
  }
  const pending = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.intent()
  const outcome = await pending
  assert.equal(outcome.reason, 'outcome_unknown')
  assert.equal(outcome.request.at, 1_700_000_000_000, 'the request: when the intent came')
  assert.equal(h.marker().at, 1_700_000_480_000, 'the note: when the wallet was asked to send')
  // the page comes back two minutes after the request: the note is shown for the eight minutes left
  t.mock.timers.tick(120_000)
  const reloaded = tipSetup(t, { storage: h.storage })
  assert.deepEqual(reloaded.evm.getTipMarkers(), [h.marker()])
  t.mock.timers.tick(479_999)
  assert.equal(reloaded.evm.getTipMarkers().length, 1)
  t.mock.timers.tick(1)
  assert.deepEqual(reloaded.evm.getTipMarkers(), [])
})

test('evm tips: with five notes kept, a completion or a Dismiss removes exactly one key', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const h = tipSetup(t)
  await h.verify()
  h.provider.handlers.eth_sendTransaction = () => {
    throw new Error('relay timeout')
  }
  for (const amount of ['1', '2', '3', '4', '5']) {
    t.mock.timers.tick(1_000)
    assert.equal((await sendTip(h, { amount })).reason, 'outcome_unknown')
  }
  // all five are kept and given to the notice, newest first
  assert.deepEqual(
    h.markers.at(-1).map(note => note.amount),
    ['5', '4', '3', '2', '1']
  )
  assert.deepEqual(
    h.notes().map(note => note.amount),
    ['1', '2', '3', '4', '5']
  )
  assert.deepEqual(h.evm.getTipMarkers(), h.markers.at(-1))
  const removals = () => h.storage.log.filter(name => name === 'removeItem').length
  // a sixth send whose hash reaches the world: its own key is written and removed, and no other
  h.provider.handlers.eth_sendTransaction = () => txHash
  let before = removals()
  assert.equal((await sendTip(h, { amount: '6' })).reported, true)
  assert.equal(removals() - before, 1)
  assert.deepEqual(
    h.notes().map(note => note.amount),
    ['1', '2', '3', '4', '5']
  )
  // a Dismiss of the oldest: that key, and no other
  before = removals()
  h.evm.dismissTipMarker(h.notes()[0].id)
  assert.equal(removals() - before, 1)
  assert.deepEqual(
    h.markers.at(-1).map(note => note.amount),
    ['5', '4', '3', '2']
  )
})

test('evm tips: a request that ends removes its own note, not the note of a request another tab made since', async t => {
  // two tabs of the site: two pages, one storage
  const storage = fakeStorage()
  const a = tipSetup(t, { storage })
  const b = tipSetup(t, { storage })
  await a.verify()
  await b.verify()
  const hold = h => {
    const wallet = {}
    h.provider.handlers.eth_sendTransaction = () =>
      new Promise((resolve, reject) => Object.assign(wallet, { resolve, reject }))
    return wallet
  }
  const start = async (h, amount) => {
    const wallet = hold(h)
    const pending = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount })
    await flush()
    h.intent()
    await flush()
    return { wallet, pending }
  }
  const rejection = () => Object.assign(new Error('User rejected the request.'), { code: 4001 })
  const amounts = () => a.notes().map(note => note.amount)
  // A asks its wallet, then B asks its own: a note each
  const tipA = await start(a, '1')
  const tipB = await start(b, '2')
  const [noteA, noteB] = a.notes()
  assert.deepEqual(amounts(), ['1', '2'])
  assert.notEqual(noteA.id, noteB.id)
  // A's hash reaches the world: A's note goes, B's stays (and A's page is told the notes that are kept)
  tipA.wallet.resolve(txHash)
  assert.equal((await tipA.pending).reported, true)
  assert.deepEqual(a.notes(), [noteB])
  assert.deepEqual(a.markers.at(-1), [noteB])
  // B's wallet rejects: its own note goes
  tipB.wallet.reject(rejection())
  assert.equal((await tipB.pending).reason, 'rejected')
  assert.deepEqual(a.notes(), [])
  assert.deepEqual(b.markers.at(-1), [])
  // the other way round: A's rejection leaves B's note, B's hash removes it
  const again = await start(a, '3')
  const later = await start(b, '4')
  again.wallet.reject(rejection())
  assert.equal((await again.pending).reason, 'rejected')
  assert.deepEqual(amounts(), ['4'])
  later.wallet.resolve(txHash)
  assert.equal((await later.pending).reported, true)
  assert.deepEqual(a.notes(), [])

  // A's send ends without a clear answer, and its notice shows that note; B then asks its wallet. Dismissing
  // the note A shows removes that note only, and A's notice now shows B's
  a.provider.handlers.eth_sendTransaction = () => {
    throw new Error('relay timeout')
  }
  assert.equal((await sendTip(a)).reason, 'outcome_unknown')
  const [shown] = a.markers.at(-1)
  assert.equal(a.markers.at(-1).length, 1)
  const held = await start(b, '5')
  assert.equal(a.notes().length, 2)
  a.evm.dismissTipMarker(shown.id)
  assert.deepEqual(amounts(), ['5'])
  assert.deepEqual(
    a.markers.at(-1).map(note => note.amount),
    ['5']
  )
  // and both pages read every note that is kept, newest first
  a.provider.handlers.eth_sendTransaction = () => {
    throw new Error('relay timeout')
  }
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1_000 })
  assert.equal((await sendTip(a)).reason, 'outcome_unknown')
  assert.deepEqual(
    b.evm.getTipMarkers().map(note => note.amount),
    ['1', '5']
  )
  held.wallet.resolve(txHash)
  assert.equal((await held.pending).reported, true)
  assert.deepEqual(
    b.evm.getTipMarkers().map(note => note.amount),
    ['1']
  )
})

test('evm tips: a listener of the notice that throws does not turn a sent tip into a failure', async t => {
  const h = tipSetup(t)
  await h.verify()
  h.world.on('evm:tipMarkers', () => {
    throw new Error('a broken panel')
  })
  assert.equal((await sendTip(h)).ok, true)
})

test('evm tips: the form is told whom the transfer will name before the wallet is asked anything', async t => {
  const h = tipSetup(t)
  await h.verify()
  const seen = []
  const outcome = await sendTip(h, {
    onIntent: info => seen.push({ ...info, calls: h.provider.calls.map(([method]) => method).slice(2) }),
  })
  assert.equal(seen.length, 1)
  const request = withoutTime(seen[0].request)
  assert.deepEqual(request, asked('1'))
  assert.deepEqual(seen[0].calls, [], 'no wallet request yet')
  assert.equal(seen[0].confirms, null, 'this intent did not say')
  assert.deepEqual(outcome.request, request, 'the same in the result')
  // the address shown is the one inside the transfer the wallet is asked for
  const [, [tx]] = h.sent()[0]
  assert.equal(tx.data, encodeTransfer(recipient, 10n ** 18n))
  assert.ok(tx.data.includes(request.address.slice(2, 6).toLowerCase()))
  assert.ok(
    tx.data.endsWith(`${request.address.slice(-4).toLowerCase()}${(10n ** 18n).toString(16).padStart(64, '0')}`)
  )
  // a name that is not text, or a player the list does not have, is shown as no name
  h.world.entities.players.get('p2').data.name = { toString: () => 'Mallory' }
  assert.equal((await sendTip(h)).request.name, '')
  h.world.entities.players.clear()
  assert.equal((await sendTip(h)).request.name, '')
  // a form that throws does not stop the send; a refused intent calls nobody
  assert.equal(
    (
      await sendTip(h, {
        onIntent: () => {
          throw new Error('unmounted')
        },
      })
    ).ok,
    true
  )
  let called = 0
  const refused = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1', onIntent: () => called++ })
  await flush()
  h.world.network.onEvmTipIntent({ id: requests(h.world, 'RequestEvmTipIntent').at(-1)[1].id, ok: false, reason: 'x' })
  assert.deepEqual(await refused, { ok: false, reason: 'x' })
  assert.equal(called, 0)
})

test('evm tips: when the intent is the first to say the world is not confirming, the wallet is asked nothing until the payer chose', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const h = tipSetup(t)
  // signed in where the world said that it confirms tips
  const run = await h.start()
  h.challenge(run.attempt)
  await flush()
  h.status(run.attempt, { confirmsTips: true })
  await run.promise
  assert.equal(h.evm.getTipsConfirmed(), true)
  const signIn = h.provider.calls.length
  const walletCalls = () => h.provider.calls.slice(signIn).map(([method]) => method)
  // what happened, in order: the form told, the form asked to choose, each wallet request (every one answered
  // at once, as WalletConnect's account and chain queries can be)
  const order = []
  h.provider.handlers.eth_accounts = () => (order.push('eth_accounts'), [lower])
  h.provider.handlers.eth_chainId = () => (order.push('eth_chainId'), h.chain)
  let during
  h.provider.handlers.eth_sendTransaction = () => {
    order.push('eth_sendTransaction')
    during = h.marker()
    return txHash
  }
  let choose
  const options = {
    playerId: 'p2',
    token: 'JPYC',
    amount: '1',
    onIntent: info => order.push(`intent:${info.confirms}`),
    onUnconfirmed: ({ request }) => {
      order.push('choose')
      assert.deepEqual(withoutTime(request), asked('1'))
      return new Promise(resolve => (choose = resolve))
    },
  }
  const pending = h.evm.tip(options)
  await flush()
  h.intent({ confirms: false })
  await flush()
  await flush()
  assert.deepEqual(order, ['intent:false', 'choose'])
  assert.deepEqual(walletCalls(), [], 'nothing asked of the wallet while the payer reads')
  assert.deepEqual(h.storage.log, [], 'no note of a request that was not made')
  assert.deepEqual(await h.evm.tip(options), { ok: false, reason: 'busy' }, 'one send at a time')
  // four minutes later the payer presses Send anyway
  t.mock.timers.tick(240_000)
  choose(true)
  assert.equal((await pending).ok, true)
  assert.deepEqual(order, ['intent:false', 'choose', 'eth_accounts', 'eth_chainId', 'eth_sendTransaction'])
  assert.equal(during.at, 1_700_000_240_000, 'the note is timed when the wallet is asked')
  assert.equal(h.sent().length, 1)

  // Cancel: nothing was asked of the wallet, nothing was noted, nothing is told
  const send = async (patch = {}, intent = { confirms: false }) => {
    order.length = 0
    const result = h.evm.tip({ ...options, ...patch })
    await flush()
    h.intent(intent)
    await flush()
    await flush()
    // in an object: an async function would wait for the send itself
    return { result }
  }
  const callsBefore = h.provider.calls.length
  const markersBefore = h.markers.length
  const storageBefore = h.storage.log.length
  for (const [name, answer] of [
    ['Cancel', () => false],
    ['an answer that is not true', () => 'yes'],
    ['a choice that fails', () => Promise.reject(new Error('unmounted'))],
  ]) {
    const { result } = await send()
    assert.deepEqual(order, ['intent:false', 'choose'], name)
    choose(answer())
    assert.deepEqual(await result, { ok: false, reason: 'declined' }, name)
  }
  for (const [name, patch] of [
    ['no callback', { onUnconfirmed: undefined }],
    [
      'a callback that throws',
      {
        onUnconfirmed: () => {
          throw new Error('broken')
        },
      },
    ],
    ['"shown" that is not true', { unconfirmedShown: 'yes', onUnconfirmed: () => false }],
  ]) {
    assert.deepEqual(await (await send(patch)).result, { ok: false, reason: 'declined' }, name)
  }
  assert.equal(h.provider.calls.length, callsBefore, 'the wallet was asked nothing')
  assert.equal(h.markers.length, markersBefore, 'the notice was told nothing')
  assert.equal(h.storage.log.length, storageBefore, 'the storage was not touched')
  assert.equal(requests(h.world, 'EvmTip').length, 1, 'nothing reported')

  // a wallet change while the payer reads: Send anyway sends nothing
  const switched = await send()
  h.provider.emit('accountsChanged', [otherAddress])
  choose(true)
  assert.deepEqual(await switched.result, { ok: false, reason: 'cancelled' })
  assert.equal(h.provider.calls.length, callsBefore, 'the wallet was asked nothing')
  assert.equal(h.sent().length, 1)
})

// one send that stops on the "not confirming" step; `wait` is what the clocks do before Send anyway
async function answerLate(h, wait) {
  const calls = h.provider.calls.length
  let choose
  const pending = h.evm.tip({
    playerId: 'p2',
    token: 'JPYC',
    amount: '1',
    onUnconfirmed: () => new Promise(resolve => (choose = resolve)),
  })
  await flush()
  h.intent({ confirms: false })
  await flush()
  await flush()
  assert.equal(h.provider.calls.length, calls, 'nothing asked while the payer reads')
  wait()
  choose(true)
  return { outcome: timeless(await pending), asked: h.provider.calls.slice(calls).map(([method]) => method) }
}

test('evm tips: "Send anyway" acts on the intent for five minutes of this page\'s time, whatever the wall clock does', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const page = { now: 5_000 }
  const h = tipSetup(t, { pageClock: () => page.now })
  const run = await h.start()
  h.challenge(run.attempt)
  await flush()
  h.status(run.attempt, { confirmsTips: true })
  await run.promise
  const sent = ['eth_accounts', 'eth_chainId', 'eth_sendTransaction']
  // a millisecond before the five minutes: sent
  const inTime = await answerLate(h, () => (page.now += 299_999))
  assert.equal(inTime.outcome.ok, true)
  assert.deepEqual(inTime.asked, sent)
  // the wall clock jumps an hour either way while the payer reads for a second: sent
  for (const [name, jump] of [
    ['forward', 3_600_000],
    ['back', -3_600_000],
  ]) {
    const jumped = await answerLate(h, () => {
      page.now += 1_000
      t.mock.timers.setTime(Date.now() + jump)
    })
    assert.equal(jumped.outcome.ok, true, name)
    assert.deepEqual(jumped.asked, sent, name)
  }
  const storageBefore = h.storage.log.length
  const markersBefore = h.markers.length
  // five minutes of this page's time, or more: not sent, and the wallet is asked nothing
  for (const [name, wait] of [
    ['five minutes', () => (page.now += 300_000)],
    ['an hour', () => (page.now += 3_600_000)],
    // eleven minutes, then the wall clock set back nine: two minutes by the wall clock
    [
      'a wall clock set back after the wait',
      () => {
        page.now += 660_000
        t.mock.timers.setTime(Date.now() + 660_000 - 540_000)
      },
    ],
  ]) {
    const late = await answerLate(h, wait)
    assert.deepEqual(late.outcome, { ok: false, reason: 'intent_expired' }, name)
    assert.deepEqual(late.asked, [], name)
  }
  assert.equal(h.storage.log.length, storageBefore, 'no note of a request that was not made')
  assert.equal(h.markers.length, markersBefore, 'the notice was told nothing')
  assert.equal(h.sent().length, 3)
  assert.equal(requests(h.world, 'EvmTip').length, 3)
  // a send without the step is not timed: the wallet's own prompts take as long as they take
  h.provider.handlers.eth_accounts = () => {
    page.now += 3_600_000
    return [lower]
  }
  assert.equal((await sendTip(h, { intent: { confirms: true } })).ok, true)
  assert.equal(h.sent().length, 4)
})

test('evm tips: the time of the "not confirming" step is the page\'s own clock (performance.now)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const page = { now: 5_000 }
  t.mock.method(performance, 'now', () => page.now)
  const h = tipSetup(t)
  const run = await h.start()
  h.challenge(run.attempt)
  await flush()
  h.status(run.attempt, { confirmsTips: true })
  await run.promise
  // the wall clock alone moves on by an hour: sent
  assert.equal((await answerLate(h, () => t.mock.timers.tick(3_600_000))).outcome.ok, true)
  // the page's clock moves on by five minutes: not sent
  const late = await answerLate(h, () => (page.now += 300_000))
  assert.deepEqual(late, { outcome: { ok: false, reason: 'intent_expired' }, asked: [] })
})

test('evm tips: no stop when the form had said it already, or when the intent does not say "not confirming"', async t => {
  const h = tipSetup(t)
  await h.verify()
  let stops = 0
  const onUnconfirmed = () => (stops++, true)
  for (const [name, patch, intent] of [
    ['the form said it before Send', { unconfirmedShown: true }, { confirms: false }],
    ['the world confirms', {}, { confirms: true }],
    ['an older server that does not say', {}, {}],
  ]) {
    const before = h.sent().length
    assert.equal((await sendTip(h, { ...patch, onUnconfirmed, intent })).ok, true, name)
    assert.equal(h.sent().length, before + 1, name)
  }
  assert.equal(stops, 0)
  // and where the intent says it, the payer is asked once per send
  assert.equal((await sendTip(h, { onUnconfirmed, intent: { confirms: false } })).ok, true)
  assert.equal(stops, 1)
})

test('evm tips: whether the world confirms tips is what it last said (sign-in, an intent, a tip status)', async t => {
  const h = tipSetup(t)
  assert.equal(h.evm.getTipsConfirmed(), null, 'not said')
  await h.verify()
  assert.equal(h.evm.getTipsConfirmed(), null, 'a server that does not say')
  // the sign-in result says it
  const run = await h.start()
  h.challenge(run.attempt)
  await flush()
  h.status(run.attempt, { confirmsTips: false })
  await run.promise
  assert.equal(h.evm.getTipsConfirmed(), false)
  // each intent says it afresh, and the form gets it before the wallet is asked
  const seen = []
  await sendTip(h, { intent: { confirms: true }, onIntent: info => seen.push(info.confirms) })
  assert.deepEqual(seen, [true])
  assert.equal(h.evm.getTipsConfirmed(), true)
  await sendTip(h, { intent: { confirms: false }, onIntent: info => seen.push(info.confirms) })
  assert.deepEqual(seen, [true, false])
  await sendTip(h, { intent: { confirms: 'yes' }, onIntent: info => seen.push(info.confirms) })
  assert.deepEqual(seen, [true, false, false], 'only a boolean changes it')
  await sendTip(h, { intent: { confirms: true } })
  // a tip of this player's that came back unconfirmed for want of an RPC or of finality
  for (const reason of ['no_rpc', 'no_finality']) {
    h.world.network.onEvmTipStatus({ ticket, txHash, state: 'unverified', reason })
    assert.equal(h.evm.getTipsConfirmed(), false, reason)
    await sendTip(h, { intent: { confirms: true } })
    assert.equal(h.evm.getTipsConfirmed(), true)
  }
  // other reasons say nothing about the world
  for (const data of [
    { state: 'unverified', reason: 'timeout' },
    { state: 'failed', reason: 'no_rpc' },
    { state: 'watching' },
  ]) {
    h.world.network.onEvmTipStatus({ ticket, txHash, ...data })
    assert.equal(h.evm.getTipsConfirmed(), true, JSON.stringify(data))
  }
  // a sign-in result that is not accepted (another attempt) changes nothing
  h.status(999, { confirmsTips: false })
  assert.equal(h.evm.getTipsConfirmed(), true)
})

// --- WalletConnect (loaded on demand; a fake adapter stands in for src/client/walletconnect.js) ---

const PROJECT_ID = 'a'.repeat(32)
const wcEnv = { PUBLIC_EVM_CHAIN_IDS: '137', PUBLIC_WALLETCONNECT_PROJECT_ID: PROJECT_ID }

function fakeWalletConnect() {
  const adapter = new EventEmitter()
  adapter.isWalletConnect = true
  adapter.cancelled = 0
  adapter.calls = []
  adapter.redirect = null
  adapter.handlers = {
    eth_requestAccounts: () => [lower],
    personal_sign: () => signature,
  }
  adapter.request = async ({ method, params }) => {
    adapter.calls.push(method)
    if (adapter.handlers[method]) return adapter.handlers[method](params)
    throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 })
  }
  adapter.cancel = () => {
    adapter.cancelled++
    adapter.onCancel?.()
  }
  adapter.walletRedirect = () => adapter.redirect
  const loader = {
    loads: 0,
    fail: false,
    load: async () => {
      loader.loads++
      if (loader.fail) throw new Error('chunk 404')
      return {
        createWalletConnectProvider: async opts => {
          adapter.options = opts
          return adapter
        },
      }
    },
  }
  return { adapter, loader }
}

function wcSetup(t, env = wcEnv) {
  const { adapter, loader } = fakeWalletConnect()
  // no injected wallet: WalletConnect is the only way in (a phone browser)
  const h = setup(t, { env, win: makeWindow(), options: { loadWalletConnect: loader.load } })
  h.adapter = adapter
  h.loader = loader
  h.toasts = []
  h.world.on('toast', text => h.toasts.push(text))
  h.wcStatuses = []
  h.world.on('evm:walletconnect', status => h.wcStatuses.push(status))
  return h
}

test('walletconnect: listed last with its icon only when a valid project id is configured', async t => {
  const h = wcSetup(t)
  assert.deepEqual(
    h.evm.getProviders().map(p => p.id),
    ['walletconnect']
  )
  assert.match(h.evm.getProviders()[0].icon, /^data:image\/svg\+xml,/)
  for (const bad of ['', 'not-an-id', 'a'.repeat(31), 'g'.repeat(32)]) {
    const other = wcSetup(t, { PUBLIC_EVM_CHAIN_IDS: '137', PUBLIC_WALLETCONNECT_PROJECT_ID: bad })
    assert.deepEqual(other.evm.getProviders(), [], JSON.stringify(bad))
  }
  assert.equal(h.loader.loads, 0, 'nothing loads until it is picked')
})

test('walletconnect: picking it loads the adapter once and verifies through SIWE like any wallet', async t => {
  const h = wcSetup(t)
  const run = await h.start('walletconnect')
  assert.equal(h.loader.loads, 1)
  assert.equal(h.adapter.options.projectId, PROJECT_ID)
  assert.equal(h.adapter.options.chainId, 137)
  assert.equal(h.wcStatuses[0].state, 'loading')
  h.challenge(run.attempt)
  await flush()
  h.status(run.attempt)
  assert.equal(await run.promise, checksummed)
  assert.deepEqual(h.adapter.calls, ['eth_requestAccounts', 'personal_sign'])
  assert.equal(h.evm.isVerified(), true)
  // the Sign button re-signs with the same wallet, without loading again
  const again = await h.start()
  assert.equal(h.loader.loads, 1)
  h.challenge(again.attempt)
  await flush()
  h.status(again.attempt)
  assert.equal(await again.promise, checksummed)
})

test('walletconnect: a failed load, an unreachable relay and a wrong chain each say what happened', async t => {
  const h = wcSetup(t)
  h.loader.fail = true
  await h.evm.connect('walletconnect')
  assert.equal(h.toasts.at(-1), 'WalletConnect could not load. Reload the page and try again.')
  assert.equal(h.wcStatuses.at(-1).state, 'idle')
  h.loader.fail = false
  h.adapter.handlers.eth_requestAccounts = () => {
    throw Object.assign(new Error('relay_unreachable'), { code: -32000 })
  }
  await h.evm.connect('walletconnect')
  assert.equal(h.toasts.at(-1), 'Could not reach WalletConnect. Check your connection and try again.')
  h.adapter.handlers.eth_requestAccounts = () => {
    throw Object.assign(new Error('wrong chain'), { code: 4901 })
  }
  await h.evm.connect('walletconnect')
  assert.match(h.toasts.at(-1), /did not connect on the sign-in network/)
})

test('walletconnect: a smart-contract wallet in a world that cannot check it is told so', async t => {
  const h = wcSetup(t)
  const run = await h.start('walletconnect')
  h.challenge(run.attempt)
  await flush()
  h.world.network.onEvmWalletStatus({ attempt: run.attempt, verified: false, reason: 'contract_unsupported' })
  assert.equal(await run.promise, null)
  assert.equal(h.toasts.at(-1), 'Signature not accepted. Smart-contract wallets are not supported in this world.')
})

test('walletconnect: Cancel and dispose stop a connection still waiting for the wallet, without a toast', async t => {
  const h = wcSetup(t)
  let rejectWait
  h.adapter.handlers.eth_requestAccounts = () =>
    new Promise((resolve, reject) => {
      rejectWait = reject
    })
  h.adapter.onCancel = () => rejectWait?.(Object.assign(new Error('Connection cancelled.'), { code: 4001 }))
  const pending = h.evm.connect('walletconnect')
  await flush()
  assert.equal(h.evm.cancelConnect(), true)
  assert.equal(await pending, null)
  assert.equal(h.adapter.cancelled, 1)
  assert.deepEqual(h.toasts, [])
  assert.equal(h.evm.getState().status, 'disconnected')
  assert.equal(h.wcStatuses.at(-1).state, 'idle')
  assert.equal(h.evm.cancelConnect(), false, 'nothing to cancel')

  const second = h.evm.connect('walletconnect')
  await flush()
  h.evm.dispose('test')
  assert.equal(await second, null)
  assert.equal(h.adapter.cancelled, 2)
  assert.deepEqual(h.toasts, [])
})

test('walletconnect: "Open wallet" uses the wallet\'s app scheme, else the tapped wallet\'s, else its universal link', async t => {
  const h = wcSetup(t)
  assert.equal(h.evm.getWalletConnectRedirect(), null)
  const run = await h.start('walletconnect')
  h.challenge(run.attempt)
  await flush()
  h.status(run.attempt)
  await run.promise
  // no link from the wallet: the scheme of the listed wallet the player tapped
  h.evm.setWalletConnectChoice('hashport')
  assert.equal(h.evm.getWalletConnectRedirect(), 'expo2025-wallet://')
  h.evm.setWalletConnectChoice('evil')
  assert.equal(h.evm.getWalletConnectRedirect(), null)
  // the wallet's own universal link gives way to the tapped wallet's scheme (a universal link can end on the
  // App Store), and is used when no listed wallet was tapped (a stored session, the QR, a copied link)
  h.adapter.redirect = 'https://prd-api.mynawallet.jp/deeplink'
  h.evm.setWalletConnectChoice('myna')
  assert.equal(h.evm.getWalletConnectRedirect(), 'mynawallet://')
  h.evm.setWalletConnectChoice(null)
  assert.equal(h.evm.getWalletConnectRedirect(), 'https://prd-api.mynawallet.jp/deeplink')
  // a link from another wallet's host: that wallet took the pairing link, not the one tapped
  h.adapter.redirect = 'https://wallet.example/'
  h.evm.setWalletConnectChoice('hashport')
  assert.equal(h.evm.getWalletConnectRedirect(), 'https://wallet.example/')
  h.adapter.redirect = 'https://link.wallet.hashport.com/'
  assert.equal(h.evm.getWalletConnectRedirect(), 'expo2025-wallet://', "the tapped wallet's own host")
  // the wallet's own scheme wins over a tapped one: it names the app that holds the session
  h.adapter.redirect = 'metamask://'
  h.evm.setWalletConnectChoice('hashport')
  assert.equal(h.evm.getWalletConnectRedirect(), 'metamask://')
  h.evm.setWalletConnectChoice(null)
  assert.equal(h.evm.getWalletConnectRedirect(), 'metamask://')
  // the session ending on the phone disconnects here
  h.adapter.emit('accountsChanged', [])
  assert.equal(h.evm.isVerified(), false)
})

test('walletconnect: a new pairing link forgets the wallet tapped for an earlier one', async t => {
  const h = wcSetup(t)
  const run = await h.start('walletconnect')
  h.evm.setWalletConnectChoice('hashport')
  assert.equal(h.evm.getWalletConnectRedirect(), 'expo2025-wallet://')
  h.adapter.options.onStatus({ state: 'uri', uri: `wc:${'ab'.repeat(32)}@2?x` })
  assert.equal(h.evm.getWalletConnectRedirect(), null, 'another wallet may take this link')
  h.evm.setWalletConnectChoice('myna')
  h.evm.setWalletConnectChoice(null)
  assert.equal(h.evm.getWalletConnectRedirect(), null, '"Other wallet" clears it')
  h.evm.cancelConnect()
  await run.promise
})

test('walletconnect: switching to another wallet mid-pairing takes the WalletConnect steps off the panel', async t => {
  const { adapter, loader } = fakeWalletConnect()
  // a desktop with an extension and WalletConnect
  const h = setup(t, { env: wcEnv, options: { loadWalletConnect: loader.load } })
  const statuses = []
  h.world.on('evm:walletconnect', status => statuses.push(status))
  adapter.handlers.eth_requestAccounts = () => new Promise(() => {})
  const pairing = h.evm.connect('walletconnect')
  await flush()
  adapter.options.onStatus({ state: 'uri', uri: `wc:${'ab'.repeat(32)}@2?x` })
  assert.equal(h.evm.getWalletConnectStatus().state, 'uri')
  const injected = await h.start('injected')
  assert.equal(adapter.cancelled, 1, 'the pairing is given up')
  assert.equal(h.evm.getWalletConnectStatus().state, 'idle', 'its QR leaves the panel')
  assert.equal(statuses.at(-1).state, 'idle')
  h.challenge(injected.attempt)
  await flush()
  h.status(injected.attempt)
  assert.equal(await injected.promise, checksummed)
  assert.equal(await Promise.race([pairing, flush().then(() => 'pending')]), 'pending', 'the old run stays silent')
})

test('walletconnect: Cancel while the sign-in waits in the wallet withdraws the server attempt', async t => {
  const h = wcSetup(t)
  h.adapter.handlers.personal_sign = () => new Promise(() => {})
  let revoked = 0
  h.adapter.handlers.wallet_revokePermissions = () => {
    revoked++
    return null
  }
  const run = await h.start('walletconnect')
  h.challenge(run.attempt)
  await flush()
  assert.equal(h.evm.getState().status, 'signing')
  assert.equal(h.evm.cancelConnect(), true)
  assert.equal(requests(h.world, 'RevokeEvmWallet').length, 1)
  assert.equal(h.evm.getState().status, 'unverified', 'Sign is offered again with the same wallet')
  assert.equal(h.wcStatuses.at(-1).state, 'idle')
  assert.deepEqual(h.toasts, [])
  // Disconnect still reaches the WalletConnect session
  h.evm.disconnect()
  await flush()
  assert.equal(revoked, 1, 'the WalletConnect session is ended too')
  assert.equal(h.evm.getState().status, 'disconnected')
})
