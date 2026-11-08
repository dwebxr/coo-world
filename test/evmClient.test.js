import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Ranks } from '../src/core/extras/ranks.js'
import { clientWorld, loadClient } from './lib/clientHarness.mjs'
import { strictDecode } from '../src/core/extras/strictDecode.js'
import { packetMethodById } from '../src/core/packets.js'
import { isEvmAddress, isEvmSigninSignature, parseEvmChainIds, sameEvmAddress } from '../src/core/extras/evmChains.js'
import { encodeTransfer, isTxHash } from '../src/core/extras/evmAbi.js'
import { KNOWN_CHAINS, explorerTxUrl, parseTipAmount, parseTipTokens } from '../src/core/extras/evmTokens.js'
import { WALLET_LINKS } from '../src/core/extras/walletLinks.js'

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
  WALLET_LINKS,
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

function tipSetup(t, { chain = '0x89' } = {}) {
  const h = setup(t, { env: tipEnv })
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
    { symbol: 'JPYC', decimals: 18, min: '1' },
    { symbol: 'USDC', decimals: 6, min: '0.01' },
  ])
  const pending = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '100' })
  await flush()
  assert.deepEqual(requests(h.world, 'RequestEvmTipIntent')[0][1], { id: 1, to: 'p2', token: 'JPYC', amount: '100' })
  h.intent()
  assert.deepEqual(await pending, {
    ok: true,
    txHash,
    explorerUrl: `https://polygonscan.com/tx/${txHash}`,
    ticket,
    reported: true,
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
  h.provider.reject = null
  h.provider.handlers.eth_sendTransaction = () => 'not-a-hash'
  const bad = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.intent()
  assert.deepEqual(await bad, { ok: false, reason: 'bad_tx' })
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
  assert.deepEqual(await same, {
    ok: true,
    txHash,
    explorerUrl: `https://polygonscan.com/tx/${txHash}`,
    ticket,
    reported: true,
  })
  h.provider.handlers.eth_sendTransaction = () => {
    h.provider.emit('chainChanged', '0x1')
    return txHash
  }
  const moved = h.evm.tip({ playerId: 'p2', token: 'JPYC', amount: '1' })
  await flush()
  h.intent()
  assert.deepEqual(await moved, {
    ok: true,
    txHash,
    explorerUrl: null,
    warning: 'chain_changed',
    ticket,
    reported: true,
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

test('walletconnect: "Open wallet" uses the wallet link, else the wallet the player tapped', async t => {
  const h = wcSetup(t)
  assert.equal(h.evm.getWalletConnectRedirect(), null)
  const run = await h.start('walletconnect')
  h.challenge(run.attempt)
  await flush()
  h.status(run.attempt)
  await run.promise
  h.evm.setWalletConnectChoice('hashport')
  assert.equal(h.evm.getWalletConnectRedirect(), 'https://link.wallet.hashport.com')
  h.evm.setWalletConnectChoice('evil')
  assert.equal(h.evm.getWalletConnectRedirect(), null)
  h.adapter.redirect = 'metamask://'
  assert.equal(h.evm.getWalletConnectRedirect(), 'metamask://')
  // the session ending on the phone disconnects here
  h.adapter.emit('accountsChanged', [])
  assert.equal(h.evm.isVerified(), false)
})

test('walletconnect: a new pairing link forgets the wallet tapped for an earlier one', async t => {
  const h = wcSetup(t)
  const run = await h.start('walletconnect')
  h.evm.setWalletConnectChoice('hashport')
  assert.equal(h.evm.getWalletConnectRedirect(), 'https://link.wallet.hashport.com')
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
