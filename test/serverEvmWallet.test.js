import { test } from 'node:test'
import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import { PublicKey } from '@solana/web3.js'
import moment from 'moment'
import { privateKeyToAccount } from 'viem/accounts'
import { connectionMethod, fakeWs, makeNetwork } from './lib/networkHarness.mjs'
import { readPacket } from '../src/core/packets.js'
import { Ranks } from '../src/core/extras/ranks.js'
import { sanitizeName, isAvatarUrl } from '../src/core/extras/entityModifyPolicy.js'
import * as solana from '../src/server/solana-gating.js'
import * as evm from '../src/server/evm-gating.js'
import { parseTipTokens } from '../src/core/extras/evmTokens.js'
import { TRANSFER_TOPIC, encodeAddressWord, encodeUintWord } from '../src/core/extras/evmAbi.js'
import { RpcError } from '../src/server/evmRpc.js'
import { createTipWatcher } from '../src/server/evmTipWatcher.js'

const host = { WALLET_HOST: 'test.example', WALLET_URI: 'https://test.example' }
const solanaEnabled = { ...solana, ...host, TOKEN_GATING_ENABLED: true, REQUIRED_TOKEN_AMOUNT: 10000 }
const evmEnabled = { ...evm, ...host, EVM_ENABLED: true, EVM_CHAIN_IDS: [137], EVM_CHAIN_ID: 137, EVM_TIP_TOKENS: [] }
const tipsEnabled = { ...evmEnabled, EVM_TIP_TOKENS: parseTipTokens('JPYC,USDC', 137) }
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const solanaKey = nacl.sign.keyPair()
const solanaAddress = new PublicKey(solanaKey.publicKey).toBase58()

const replies = (socket, method) =>
  socket.ws.packets
    .map(readPacket)
    .filter(([name]) => name === method)
    .map(([, data]) => data)
const clear = socket => {
  socket.ws.drain()
  socket.ws.packets.length = 0
}

function fixture(t, { evmGating = evmEnabled, balance = 0, evmHoldings, tipWatcher, timers, context } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const users = new Map()
  const entities = new Map()
  const calls = []
  const events = []
  const service = {
    get: wallet => {
      calls.push(wallet)
      return { known: true, balance }
    },
  }
  const chat = []
  const network = makeNetwork(() => {}, {
    tokenBalanceService: service,
    evmHoldings,
    tipWatcher,
    context: { solanaGating: solanaEnabled, evmGating, process: { env: {} }, ...timers, ...context },
  })
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  network.db = () => ({
    where: (column, id) => ({
      first: async () => users.get(id),
      update: async patch => Object.assign(users.get(id), patch),
    }),
  })
  Object.assign(network.world, {
    settings: { serialize: () => ({}), effectiveRank: 0 },
    livekit: { serialize: async () => ({}), clearModifiers() {} },
    collections: { serialize: () => [] },
    chat: { serialize: () => [], add: (msg, broadcast) => chat.push({ msg, broadcast }) },
    ai: { serialize: () => ({}) },
    blueprints: { serialize: () => [] },
    events: { emit: (name, data) => events.push([name, data]) },
    entities: {
      items: entities,
      add(data) {
        const player = {
          data,
          isPlayer: true,
          modify: patch => Object.assign(data, patch),
          isAdmin: () => data.rank >= Ranks.ADMIN,
          isBuilder: () => data.rank >= Ranks.BUILDER,
          destroy: () => entities.delete(data.id),
        }
        entities.set(data.id, player)
        return player
      },
      get: id => entities.get(id),
      serialize: () => [...entities.values()].map(player => ({ ...player.data })),
    },
  })
  network.onConnection = connectionMethod({
    solanaGating: solanaEnabled,
    evmGating,
    moment,
    sanitizeName,
    isAvatarUrl,
    isNumber: value => typeof value === 'number',
    readJWT: async userId => ({ userId }),
    HEALTH_MAX: 100,
    process: { env: {} },
    performance,
  })
  const f = { network, calls, events, chat }
  f.connect = async (id = 'visitor', rank = Ranks.VISITOR) => {
    if (!users.has(id)) users.set(id, { id, name: id, rank })
    const ws = fakeWs()
    await network.onConnection(ws, { authToken: id })
    assert.equal(ws.terminations, 0, 'connection succeeded')
    const socket = network.sockets.get(id)
    clear(socket)
    return socket
  }
  f.advance = ms => t.mock.timers.tick(ms)
  // Ask for a nonce and return the signed verify request for it.
  f.challenge = async (socket, { attempt = 1, signer = account, address = signer.address } = {}) => {
    network.onRequestEvmNonce(socket, { address, attempt })
    const reply = replies(socket, 'onEvmNonce').pop()
    assert.ok(reply?.nonce, 'nonce issued')
    assert.equal(reply.attempt, attempt)
    return {
      address,
      attempt,
      nonce: reply.nonce,
      message: reply.message,
      signature: await signer.signMessage({ message: reply.message }),
    }
  }
  f.verify = async (socket, options) => {
    const request = await f.challenge(socket, options)
    delete request.message
    await network.onRequestEvmVerify(socket, request)
    return request
  }
  t.after(() => {
    for (const socket of network.sockets.values()) socket.disconnect()
  })
  return f
}

test('evm wallet: nonce, SIWE signature and verify round trip leaves rank and Solana state untouched', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  const { message } = await f.challenge(socket)
  assert.match(message, /^test\.example wants you to sign in with your Ethereum account:\n0x/)
  assert.match(message, /\nChain ID: 137\n/)
  assert.match(message, /\nURI: https:\/\/test\.example\n/)
  clear(socket)
  socket.evmWallet.lastChallengeAt = 0
  await f.verify(socket, { attempt: 2 })
  assert.deepEqual(replies(socket, 'onEvmWalletStatus'), [
    { verified: true, wallet: account.address, attempt: 2, reason: 'ok' },
  ])
  assert.equal(socket.evmWallet.verified, account.address)
  assert.equal(socket.evmWallet.challenge, null)
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.equal(socket.wallet.generation, 0)
  assert.equal(socket.wallet.verified, null)
  assert.equal(replies(socket, 'onEntityModified').length, 0)
  assert.equal(replies(socket, 'onChatAdded').length, 0)
  assert.equal(f.calls.length, 0, 'no balance reads')
})

test('evm wallet: a lowercase wallet address verifies and is answered in EIP-55 form', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  await f.verify(socket, { address: account.address.toLowerCase() })
  assert.deepEqual(replies(socket, 'onEvmWalletStatus'), [
    { verified: true, wallet: account.address, attempt: 1, reason: 'ok' },
  ])
})

test('evm wallet: cooldown replies once, then issues a fresh nonce after five seconds', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  await f.challenge(socket)
  const first = socket.evmWallet.challenge
  f.advance(1000)
  f.network.onRequestEvmNonce(socket, { address: account.address, attempt: 2 })
  f.network.onRequestEvmNonce(socket, { address: account.address, attempt: 3 })
  assert.deepEqual(replies(socket, 'onEvmNonce').slice(1), [{ attempt: 2, retryAfterMs: 4000 }])
  assert.equal(socket.evmWallet.challenge, first, 'cooldown does not replace the challenge')
  f.advance(4000)
  await f.challenge(socket, { attempt: 4 })
  assert.notEqual(socket.evmWallet.challenge.nonce, first.nonce)
  assert.equal(socket.evmWallet.challenge.attempt, 4)
})

test('evm wallet: stale or foreign packets neither consume the challenge nor reply', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  const request = await f.challenge(socket, { attempt: 5 })
  delete request.message
  clear(socket)
  for (const data of [
    { ...request, attempt: 4 },
    { ...request, nonce: 'a'.repeat(64) },
    { ...request, nonce: 'bad' },
    { ...request, attempt: 0 },
    [request],
    null,
    'text',
  ]) {
    await f.network.onRequestEvmVerify(socket, data)
  }
  assert.equal(socket.ws.packets.length, 0)
  assert.ok(socket.evmWallet.challenge, 'challenge still usable')
  await f.network.onRequestEvmVerify(socket, request)
  assert.equal(replies(socket, 'onEvmWalletStatus')[0].verified, true)
})

test('evm wallet: malformed nonce requests are dropped without state changes', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  for (const data of [
    { address: 'nope', attempt: 1 },
    { address: account.address.slice(0, 41), attempt: 1 },
    { address: account.address, attempt: 0 },
    { address: account.address, attempt: 0x80000000 },
    { address: account.address },
    [account.address, 1],
    null,
  ]) {
    f.network.onRequestEvmNonce(socket, data)
  }
  assert.equal(socket.ws.packets.length, 0)
  assert.equal(socket.evmWallet.lastChallengeAt, 0, 'no cooldown consumed')
  assert.equal(socket.evmWallet.generation, 0)
})

test('evm wallet: failures reply with a reason and burn the challenge', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  // Signed by another key.
  const forged = await f.challenge(socket, { attempt: 1 })
  delete forged.message
  forged.signature = await other.signMessage({ message: socket.evmWallet.challenge.message })
  await f.network.onRequestEvmVerify(socket, forged)
  // Malformed signature with a live nonce still answers, so the client does not wait out its timer.
  f.advance(5000)
  const malformed = await f.challenge(socket, { attempt: 2 })
  delete malformed.message
  // (a 2-byte signature is well formed now: a contract account's, which a world without an RPC cannot check)
  await f.network.onRequestEvmVerify(socket, { ...malformed, signature: '0x123' })
  // Expired.
  f.advance(5000)
  const late = await f.challenge(socket, { attempt: 3 })
  delete late.message
  f.advance(evm.CHALLENGE_TTL_MS)
  await f.network.onRequestEvmVerify(socket, late)
  assert.deepEqual(replies(socket, 'onEvmWalletStatus'), [
    { verified: false, attempt: 1, reason: 'signature_invalid' },
    { verified: false, attempt: 2, reason: 'signature_invalid' },
    { verified: false, attempt: 3, reason: 'nonce_expired' },
  ])
  assert.equal(socket.evmWallet.verified, null)
  // Replaying a valid-looking request after its failure is ignored silently.
  clear(socket)
  await f.network.onRequestEvmVerify(socket, late)
  assert.equal(socket.ws.packets.length, 0)
})

test('evm wallet: a revoke during an in-flight verify suppresses the stale success', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  const request = await f.challenge(socket)
  delete request.message
  clear(socket)
  const pending = f.network.onRequestEvmVerify(socket, request)
  assert.equal(socket.evmWallet.challenge, null, 'consumed before the await')
  f.network.onRevokeEvmWallet(socket, {})
  await pending
  assert.equal(socket.evmWallet.verified, null)
  assert.equal(
    replies(socket, 'onEvmWalletStatus').some(reply => reply.verified),
    false
  )
})

test('evm wallet: revoke clears verification once; empty revokes and extra keys are ignored', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  f.network.onRevokeEvmWallet(socket, {})
  assert.equal(socket.ws.packets.length, 0, 'nothing to revoke')
  await f.verify(socket)
  clear(socket)
  f.network.onRevokeEvmWallet(socket, { extra: true })
  assert.equal(socket.evmWallet.verified, account.address)
  f.network.onRevokeEvmWallet(socket, {})
  assert.deepEqual(replies(socket, 'onEvmWalletStatus'), [{ verified: false }])
  assert.equal(socket.evmWallet.verified, null)
  f.network.onRevokeEvmWallet(socket, {})
  assert.equal(replies(socket, 'onEvmWalletStatus').length, 1)
})

test('evm wallet: a new nonce after verification first withdraws the old verification', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  await f.verify(socket)
  clear(socket)
  f.advance(5000)
  f.network.onRequestEvmNonce(socket, { address: other.address, attempt: 2 })
  const [name] = readPacket(socket.ws.packets[0])
  assert.equal(name, 'onEvmWalletStatus')
  assert.deepEqual(replies(socket, 'onEvmWalletStatus'), [{ verified: false }])
  assert.equal(socket.evmWallet.verified, null)
  assert.equal(replies(socket, 'onEvmNonce')[0].attempt, 2)
})

test('evm wallet: Solana and EVM verifications never cancel each other', async t => {
  const f = fixture(t, { balance: 0 })
  const socket = await f.connect()
  // Solana nonce, then an EVM nonce in the same instant: both are issued (independent cooldowns).
  f.network.onRequestBuilderNonce(socket, { walletAddress: solanaAddress, attempt: 1 })
  const solanaChallenge = socket.wallet.challenge
  const solanaGeneration = socket.wallet.generation
  assert.ok(solanaChallenge)
  const evmRequest = await f.challenge(socket, { attempt: 1 })
  delete evmRequest.message
  assert.equal(socket.wallet.challenge, solanaChallenge, 'EVM nonce left the Solana challenge alone')
  assert.equal(socket.wallet.generation, solanaGeneration)
  assert.equal(replies(socket, 'onBuilderNonce').filter(reply => 'retryAfterMs' in reply).length, 0)
  // Solana verifies while the EVM challenge is pending.
  const signature = Buffer.from(
    nacl.sign.detached(new TextEncoder().encode(solanaChallenge.message), solanaKey.secretKey)
  ).toString('base64')
  await f.network.onRequestBuilderByToken(socket, {
    walletAddress: solanaAddress,
    signature,
    nonce: solanaChallenge.nonce,
    attempt: 1,
  })
  assert.equal(socket.wallet.verified, solanaAddress)
  assert.ok(socket.evmWallet.challenge, 'Solana verify left the EVM challenge alone')
  await f.network.onRequestEvmVerify(socket, evmRequest)
  assert.equal(socket.evmWallet.verified, account.address)
  // Each revoke only touches its own chain.
  f.network.onRevokeEvmWallet(socket, {})
  assert.equal(socket.wallet.verified, solanaAddress)
  f.advance(5000)
  await f.verify(socket, { attempt: 2 })
  assert.equal(socket.evmWallet.verified, account.address)
  f.network.onRevokeBuilderByToken(socket, {})
  assert.equal(socket.wallet.verified, null)
  assert.equal(socket.evmWallet.verified, account.address)
})

test('evm wallet: disabled EVM ignores every packet without touching the socket', async t => {
  const f = fixture(t, { evmGating: { ...evmEnabled, EVM_ENABLED: false } })
  const socket = new Proxy({}, { get: () => assert.fail('disabled handler touched socket') })
  f.network.onRequestEvmNonce(socket, { address: account.address, attempt: 1 })
  await f.network.onRequestEvmVerify(socket, {
    address: account.address,
    signature: `0x${'ab'.repeat(65)}`,
    nonce: 'a'.repeat(64),
    attempt: 1,
  })
  f.network.onRevokeEvmWallet(socket, {})
})

test('evm wallet: a socket that disconnected mid-verify gets no reply', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  const request = await f.challenge(socket)
  delete request.message
  clear(socket)
  const pending = f.network.onRequestEvmVerify(socket, request)
  socket.disconnected = true
  await pending
  assert.equal(socket.ws.packets.length, 0)
  assert.equal(socket.evmWallet.verified, null)
})

// --- P2a: receiving tips and tip intents ---

const third = privateKeyToAccount(`0x${'33'.repeat(32)}`)
const modified = socket => replies(socket, 'onEntityModified')
// ServerNetwork runs in its own vm realm: copy its objects before a strict deep comparison
const plain = value => JSON.parse(JSON.stringify(value))

test('evm tips: receiving needs a verified wallet, broadcasts only a boolean and is rate limited', async t => {
  const f = fixture(t, { evmGating: tipsEnabled })
  const a = await f.connect('a')
  const b = await f.connect('b')
  f.network.onSetEvmTipReceive(a, { enabled: true })
  assert.equal(a.evmWallet.receiveTips, false, 'unverified cannot opt in')
  assert.equal(modified(b).length, 0)
  await f.verify(a)
  clear(a)
  clear(b)
  for (const data of [{ enabled: 'yes' }, { enabled: true, extra: 1 }, [true], null, {}]) {
    f.network.onSetEvmTipReceive(a, data)
  }
  assert.equal(modified(b).length, 0, 'malformed requests ignored')
  f.network.onSetEvmTipReceive(a, { enabled: true })
  assert.deepEqual(modified(b), [{ id: 'a', evmTips: true }])
  assert.deepEqual(modified(a), [{ id: 'a', evmTips: true }])
  assert.equal(a.player.data.evmTips, true)
  assert.equal(JSON.stringify(modified(b)).includes(account.address.slice(2, 10)), false, 'no address broadcast')
  // opting out is never delayed; opting back in is limited to once a second
  f.network.onSetEvmTipReceive(a, { enabled: false })
  assert.equal(a.evmWallet.receiveTips, false, 'opt-out applies at once')
  assert.deepEqual(modified(b).at(-1), { id: 'a', evmTips: false })
  f.network.onSetEvmTipReceive(a, { enabled: true })
  assert.equal(a.evmWallet.receiveTips, false, 're-enabling waits a second')
  f.advance(1000)
  f.network.onSetEvmTipReceive(a, { enabled: true })
  assert.deepEqual(modified(b).at(-1), { id: 'a', evmTips: true })
})

test('evm tips: disabled tip tokens ignore receive and intent requests', async t => {
  const f = fixture(t)
  const a = await f.connect('a')
  await f.verify(a)
  clear(a)
  f.network.onSetEvmTipReceive(a, { enabled: true })
  f.network.onRequestEvmTipIntent(a, { id: 1, to: 'b', token: 'JPYC', amount: '1' })
  assert.equal(a.ws.packets.length, 0)
  assert.equal(a.evmWallet.receiveTips, false)
})

test('evm tips: an intent gives only the verified sender the opted-in recipient address and exact units', async t => {
  const f = fixture(t, { evmGating: tipsEnabled })
  const a = await f.connect('a')
  const b = await f.connect('b')
  const c = await f.connect('c')
  await f.verify(b, { signer: other })
  f.network.onSetEvmTipReceive(b, { enabled: true })
  const intent = (socket, data) => {
    clear(socket)
    f.network.onRequestEvmTipIntent(socket, { id: 1, to: 'b', token: 'JPYC', amount: '100', ...data })
    return replies(socket, 'onEvmTipIntent')
  }
  assert.deepEqual(intent(a), [{ id: 1, ok: false, reason: 'not_verified' }])
  clear(a)
  await f.verify(a)
  // tips are on, so the sign-in result says whether this world confirms them: not without a chain RPC
  assert.deepEqual(replies(a, 'onEvmWalletStatus'), [
    { verified: true, wallet: account.address, attempt: 1, reason: 'ok', confirmsTips: false },
  ])
  f.advance(10_000)
  const [granted] = intent(a)
  // the ticket names the server's copy of this intent (P2b); the reply is otherwise the intent itself
  assert.match(granted.ticket, /^[0-9a-f]{32}$/)
  delete granted.ticket
  assert.deepEqual(granted, {
    id: 1,
    ok: true,
    to: 'b',
    recipient: other.address,
    chainId: 137,
    token: { symbol: 'JPYC', address: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29', decimals: 18 },
    amount: '100',
    units: (100n * 10n ** 18n).toString(),
    // this fixture has no chain RPC (no watcher)
    confirms: false,
  })
  assert.equal(replies(b, 'onEvmTipIntent').length, 0, 'nobody else gets the address')
  assert.equal(replies(c, 'onEvmTipIntent').length, 0)
  f.advance(30_000)
  assert.deepEqual(intent(a, { token: 'USDC', amount: '0.5' })[0].units, '500000')
  assert.deepEqual(intent(a, { token: 'DOGE' }), [{ id: 1, ok: false, reason: 'bad_token' }])
  assert.deepEqual(intent(a, { amount: '0.5' }), [{ id: 1, ok: false, reason: 'below_minimum' }])
  f.advance(30_000)
  assert.deepEqual(intent(a, { amount: '1000.000000000000000001' }), [{ id: 1, ok: false, reason: 'above_maximum' }])
  f.advance(30_000)
  assert.deepEqual(intent(a, { amount: '1e3' }), [{ id: 1, ok: false, reason: 'bad_amount' }])
  assert.deepEqual(intent(a, { to: 'c' }), [{ id: 1, ok: false, reason: 'recipient_unavailable' }])
  assert.deepEqual(intent(a, { to: 'a' }), [{ id: 1, ok: false, reason: 'recipient_unavailable' }])
  f.advance(30_000)
  assert.deepEqual(intent(a, { to: 'nobody' }), [{ id: 1, ok: false, reason: 'recipient_unavailable' }])
  // malformed requests get no reply and use no budget
  clear(a)
  for (const data of [
    { id: 0, to: 'b', token: 'JPYC', amount: '1' },
    { id: 1, to: '', token: 'JPYC', amount: '1' },
    { id: 1, to: 'x'.repeat(65), token: 'JPYC', amount: '1' },
    { id: 1, to: 'b', token: 1, amount: '1' },
    { id: 1, to: 'b', token: 'JPYC', amount: 1 },
    { id: 1, to: 'b', token: 'JPYC', amount: '1'.repeat(41) },
    [1],
    null,
  ]) {
    f.network.onRequestEvmTipIntent(a, data)
  }
  assert.equal(a.ws.packets.length, 0)
})

test('evm tips: the same wallet on two connections cannot tip itself', async t => {
  const f = fixture(t, { evmGating: tipsEnabled })
  const a = await f.connect('a')
  const b = await f.connect('b')
  await f.verify(a)
  await f.verify(b)
  f.network.onSetEvmTipReceive(b, { enabled: true })
  clear(a)
  f.network.onRequestEvmTipIntent(a, { id: 3, to: 'b', token: 'JPYC', amount: '1' })
  assert.deepEqual(replies(a, 'onEvmTipIntent'), [{ id: 3, ok: false, reason: 'same_wallet' }])
})

test('evm tips: intents are rate limited per socket whatever the outcome', async t => {
  const f = fixture(t, { evmGating: tipsEnabled })
  const a = await f.connect('a')
  const b = await f.connect('b')
  await f.verify(a)
  await f.verify(b, { signer: third })
  f.network.onSetEvmTipReceive(b, { enabled: true })
  clear(a)
  for (let id = 1; id <= 4; id++) f.network.onRequestEvmTipIntent(a, { id, to: 'b', token: 'JPYC', amount: '1' })
  assert.deepEqual(
    replies(a, 'onEvmTipIntent').map(reply => reply.ok || reply.reason),
    [true, true, true, 'rate_limited']
  )
  f.advance(10_000)
  clear(a)
  f.network.onRequestEvmTipIntent(a, { id: 5, to: 'b', token: 'JPYC', amount: '1' })
  assert.equal(replies(a, 'onEvmTipIntent')[0].ok, true, 'one refills every ten seconds')
})

test('evm tips: losing verification stops receiving, tells everyone and fires evmWallet for scripts', async t => {
  const f = fixture(t, { evmGating: tipsEnabled })
  const a = await f.connect('a')
  const b = await f.connect('b')
  await f.verify(b, { signer: other })
  f.network.onSetEvmTipReceive(b, { enabled: true })
  assert.deepEqual(plain(f.events.filter(([name]) => name === 'evmWallet')), [
    ['evmWallet', { playerId: 'b', verified: true }],
  ])
  assert.ok(Object.isFrozen(f.events.find(([name]) => name === 'evmWallet')[1]))
  clear(a)
  f.network.onRevokeEvmWallet(b, {})
  assert.equal(b.evmWallet.receiveTips, false)
  assert.equal(b.player.data.evmTips, false)
  assert.deepEqual(modified(a), [{ id: 'b', evmTips: false }])
  assert.deepEqual(plain(f.events.filter(([name]) => name === 'evmWallet').at(-1)), [
    'evmWallet',
    { playerId: 'b', verified: false },
  ])
  // A new sign-in on b withdraws the old verification the same way.
  f.advance(5000)
  await f.verify(b, { signer: other })
  f.advance(1000)
  f.network.onSetEvmTipReceive(b, { enabled: true })
  clear(a)
  f.advance(5000)
  f.network.onRequestEvmNonce(b, { address: other.address, attempt: 9 })
  assert.deepEqual(modified(a), [{ id: 'b', evmTips: false }])
  // Revoking an unverified wallet fires nothing.
  const count = f.events.length
  f.network.onRevokeEvmWallet(a, {})
  assert.equal(f.events.length, count)
})

// --- P3: server-side holdings for scripts ---

test('evm holdings: a contract account verified on the sign-in chain is not verified on another chain', async t => {
  const asked = []
  const evmHoldings = {
    get: async (address, spec) => {
      asked.push(spec.chainId)
      return { known: true, balance: 1 }
    },
  }
  const f = fixture(t, { evmHoldings })
  const a = await f.connect('a')
  // the chain (a stand-in verifier) accepts a contract signature for this address
  f.network.evmSignatureVerifier = async () => ({ ok: true, reason: 'ok' })
  const request = await f.challenge(a, { signer: other, address: account.address })
  delete request.message
  await f.network.onRequestEvmVerify(a, request)
  assert.deepEqual(replies(a, 'onEvmWalletStatus').pop(), {
    verified: true,
    wallet: account.address,
    attempt: 1,
    reason: 'ok',
  })
  assert.equal(a.evmWallet.verifiedContract, true)
  const spec = chainId => ({ chainId, contract: `0x${'ab'.repeat(20)}`, standard: 'erc721' })
  assert.deepEqual(plain(await f.network.evmHolding('a', spec(137))), { verified: true, known: true, balance: 1 })
  assert.deepEqual(plain(await f.network.evmHolding('a', spec(1))), { verified: false, known: false, balance: 0 })
  assert.deepEqual(asked, [137], 'never asked about another chain')
  // an EOA proves its key on every chain
  f.network.onRevokeEvmWallet(a, {})
  assert.equal(a.evmWallet.verifiedContract, false)
  f.advance(5000)
  await f.verify(a, { attempt: 2 })
  assert.equal(a.evmWallet.verifiedContract, false)
  assert.deepEqual(plain(await f.network.evmHolding('a', spec(1))), { verified: true, known: true, balance: 1 })
})

test('evm holdings: a read still pending when the same address signs in again as a contract is dropped', async t => {
  let release
  const evmHoldings = { get: () => new Promise(resolve => (release = resolve)) }
  const f = fixture(t, { evmHoldings })
  const a = await f.connect('a')
  // signed in with the EOA key (an EIP-7702 address, say): verified on every chain
  await f.verify(a)
  const spec = { chainId: 1, contract: `0x${'ab'.repeat(20)}`, standard: 'erc721' }
  const pending = f.network.evmHolding('a', spec)
  // the same address signs in again, now proven through EIP-1271 on the sign-in chain only
  f.advance(5000)
  f.network.evmSignatureVerifier = async () => ({ ok: true, reason: 'ok' })
  const request = await f.challenge(a, { signer: other, address: account.address, attempt: 2 })
  delete request.message
  await f.network.onRequestEvmVerify(a, request)
  assert.equal(a.evmWallet.verified, account.address)
  assert.equal(a.evmWallet.verifiedContract, true)
  release({ known: true, balance: 1 })
  assert.deepEqual(plain(await pending), { verified: false, known: false, balance: 0 })
})

test('evm wallet: the zero address gets no sign-in challenge', async t => {
  const f = fixture(t)
  const a = await f.connect('a')
  f.network.onRequestEvmNonce(a, { address: `0x${'0'.repeat(40)}`, attempt: 1 })
  assert.deepEqual(replies(a, 'onEvmNonce'), [])
  assert.equal(a.evmWallet.challenge, null)
})

test('evm holdings: resolves the verified address server-side and never for stale verifications', async t => {
  const asked = []
  let release
  const evmHoldings = {
    get: (address, spec) => {
      asked.push([address, spec])
      return new Promise(resolve => (release = resolve))
    },
  }
  const f = fixture(t, { evmHoldings })
  const a = await f.connect('a')
  assert.deepEqual(plain(await f.network.evmHolding('a', { chainId: 137 })), {
    verified: false,
    known: false,
    balance: 0,
  })
  assert.deepEqual(plain(await f.network.evmHolding('nobody', {})), { verified: false, known: false, balance: 0 })
  assert.equal(asked.length, 0)
  await f.verify(a)
  const spec = { chainId: 137, contract: `0x${'ab'.repeat(20)}`, standard: 'erc721' }
  const pending = f.network.evmHolding('a', spec)
  assert.deepEqual(asked, [[account.address, spec]])
  release({ known: true, balance: 2 })
  assert.deepEqual(plain(await pending), { verified: true, known: true, balance: 2 })
  // The wallet is revoked while the read is in flight: the old result is not used.
  const stale = f.network.evmHolding('a', spec)
  f.network.onRevokeEvmWallet(a, {})
  release({ known: true, balance: 5 })
  assert.deepEqual(plain(await stale), { verified: false, known: false, balance: 0 })
  // Odd service answers are unknown.
  f.advance(5000)
  await f.verify(a, { attempt: 3 })
  for (const answer of [
    { known: true, balance: -1 },
    { known: true, balance: NaN },
    { known: 'yes', balance: 1 },
    null,
  ]) {
    const read = f.network.evmHolding('a', spec)
    release(answer)
    assert.deepEqual(plain(await read), { verified: true, known: false, balance: 0 }, JSON.stringify(answer))
  }
})

test('evm holdings: without an RPC the answer is verified but unknown', async t => {
  const f = fixture(t, { evmHoldings: null })
  f.network.evmHoldings = null
  const a = await f.connect('a')
  await f.verify(a)
  assert.deepEqual(plain(await f.network.evmHolding('a', {})), { verified: true, known: false, balance: 0 })
})

// The holdings service the server builds itself at init(), from EVM_HOLDING_CONTRACTS, over a mock RPC whose
// contracts all answer like the N1 contract: balanceOf(owner, id) is 40 bits of the owner's address.
const OPENPAY = '0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc'
const HOSTILE = '0xBAD0000000000000000000000000000000000bad'
function holdingsFromEnv(t, env) {
  const calls = []
  const rpc = {
    chainId: 137,
    async call(method, [{ to, data }]) {
      calls.push({ method, to })
      const id = data.length > 74 ? BigInt(`0x${data.slice(74)}`) : 0n
      const bits = (BigInt(`0x${data.slice(34, 74)}`) >> (40n * id)) & ((1n << 40n) - 1n)
      return `0x${bits.toString(16).padStart(64, '0')}`
    },
  }
  const lines = []
  t.mock.method(console, 'warn', line => lines.push(line))
  const f = fixture(t, { context: { process: { env }, createEvmRpcs: () => new Map([[137, rpc]]) } })
  const spec = (contract, tokenId) => ({ chainId: 137, contract, standard: 'erc1155', tokenId })
  return { f, calls, lines, spec }
}
const UNKNOWN_HOLDING = { verified: true, known: false, balance: 0 }

test('evm holdings: EVM_HOLDING_CONTRACTS not set, the server asks about the OpenPay contract and no other', async t => {
  const { f, calls, lines, spec } = holdingsFromEnv(t, {})
  const a = await f.connect('a')
  await f.verify(a)
  // N1: four questions to a contract of the script author's own
  for (const id of [0, 1, 2, 3]) {
    assert.deepEqual(plain(await f.network.evmHolding('a', spec(HOSTILE, id))), UNKNOWN_HOLDING)
  }
  assert.equal(calls.length, 0, 'no RPC call')
  // the answer is the one a chain without an RPC gets, and an unverified player still reads as unverified
  assert.deepEqual(plain(await f.network.evmHolding('a', { ...spec(HOSTILE, 0), chainId: 1 })), UNKNOWN_HOLDING)
  await f.connect('b')
  assert.deepEqual(plain(await f.network.evmHolding('b', spec(HOSTILE, 0))), {
    verified: false,
    known: false,
    balance: 0,
  })
  assert.equal(lines.length, 1, 'one line for the contract')
  assert.ok(
    lines[0].startsWith(
      `[evm] getEvmHolding: a script asked about 137:${HOSTILE.toLowerCase()}, which is not in EVM_HOLDING_CONTRACTS`
    ),
    lines[0]
  )
  assert.ok(!lines[0].toLowerCase().includes(account.address.slice(2).toLowerCase()), 'no player address logged')
  // the default: the door's contract, in any case
  const held = plain(await f.network.evmHolding('a', spec(OPENPAY.toLowerCase(), 0)))
  assert.equal(held.verified && held.known, true)
  assert.equal(held.balance, Number(BigInt(account.address) & ((1n << 40n) - 1n)))
  assert.deepEqual(calls, [{ method: 'eth_call', to: OPENPAY.toLowerCase() }])
})

test('evm holdings: EVM_HOLDING_CONTRACTS set, its contracts replace the default', async t => {
  const { f, calls, spec } = holdingsFromEnv(t, { EVM_HOLDING_CONTRACTS: ` 137:${HOSTILE.toLowerCase()} ` })
  const a = await f.connect('a')
  await f.verify(a)
  assert.deepEqual(plain(await f.network.evmHolding('a', spec(OPENPAY, 0))), UNKNOWN_HOLDING)
  assert.equal(calls.length, 0, 'the default contract is not asked once the variable is set')
  // what the list does not bound: the operator listed the N1 contract, and four balances are the address
  let address = 0n
  for (const id of [0, 1, 2, 3]) {
    const result = plain(await f.network.evmHolding('a', spec(HOSTILE, id)))
    assert.equal(result.known, true)
    address += BigInt(result.balance) << (40n * BigInt(id))
  }
  assert.equal(address, BigInt(account.address))
  assert.equal(calls.length, 4)
})

test('evm holdings: EVM_HOLDING_CONTRACTS set to nothing allows no contract', async t => {
  const { f, calls, spec } = holdingsFromEnv(t, { EVM_HOLDING_CONTRACTS: '' })
  const a = await f.connect('a')
  await f.verify(a)
  for (const contract of [OPENPAY, HOSTILE]) {
    assert.deepEqual(plain(await f.network.evmHolding('a', spec(contract, 0))), UNKNOWN_HOLDING)
  }
  assert.equal(calls.length, 0)
})

test('evm holdings: a malformed EVM_HOLDING_CONTRACTS stops init, it does not run with another list', t => {
  assert.throws(
    () => holdingsFromEnv(t, { EVM_HOLDING_CONTRACTS: `137:${OPENPAY},137:0x1234` }),
    /\[envs\] EVM_HOLDING_CONTRACTS: entry 2 is not chainId:0xaddress/
  )
})

// P2b: tx reports, the watcher's results, announcements and the script `tip` event.
function fakeWatcher() {
  const watcher = {
    jobs: [],
    stopped: 0,
    accept: true,
    watch: job => {
      if (!watcher.accept) return false
      watcher.jobs.push(job)
      return true
    },
    cancel: predicate => {
      watcher.jobs = watcher.jobs.filter(job => !predicate(job))
    },
    size: () => watcher.jobs.length,
    confirms: true,
    canConfirm: () => watcher.confirms,
    stop: () => watcher.stopped++,
  }
  return watcher
}
function fakeTimers() {
  const pending = new Set()
  return {
    pending,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms }
      pending.add(timer)
      return timer
    },
    clearTimeout: timer => pending.delete(timer),
    runAll() {
      for (const timer of [...pending]) {
        pending.delete(timer)
        timer.fn()
      }
    },
  }
}
const hashOf = n => `0x${n.toString(16).padStart(64, '0')}`

async function tipFixture(t, { watcher = fakeWatcher(), timers = fakeTimers() } = {}) {
  const f = fixture(t, { evmGating: tipsEnabled, tipWatcher: watcher, timers })
  f.watcher = watcher
  f.timers = timers
  f.a = await f.connect('a')
  f.b = await f.connect('b')
  await f.verify(f.a)
  await f.verify(f.b, { signer: other })
  f.network.onSetEvmTipReceive(f.b, { enabled: true })
  f.ticket = (socket = f.a, { to = 'b', amount = '100', token = 'JPYC' } = {}) => {
    // keep the intent bucket full: the bucket itself is covered above
    socket.evmWallet.intentBucket.tokens = evm.TIP_INTENT_BURST
    clear(socket)
    f.network.onRequestEvmTipIntent(socket, { id: 1, to, token, amount })
    const reply = replies(socket, 'onEvmTipIntent')[0]
    assert.equal(reply.ok, true, reply.reason)
    return reply.ticket
  }
  f.report = (socket, data) => {
    clear(socket)
    f.network.onEvmTip(socket, data)
    return replies(socket, 'onEvmTipStatus')
  }
  return f
}

test('evm tip report: a ticket is the server copy of the intent, for its sender only, at most three', async t => {
  const f = await tipFixture(t)
  const first = f.ticket()
  const copy = f.a.evmWallet.tickets.get(first)
  assert.equal(copy.from, account.address)
  assert.equal(copy.recipient, other.address)
  assert.equal(copy.toPlayerId, 'b')
  assert.equal(copy.units, 100n * 10n ** 18n)
  assert.equal(copy.state, 'issued')
  assert.equal(f.b.evmWallet.tickets.size, 0)
  // a fourth ticket drops the oldest unused one
  const second = f.ticket()
  const third = f.ticket()
  const fourth = f.ticket()
  assert.deepEqual([...f.a.evmWallet.tickets.keys()], [second, third, fourth])
  // watched tickets are never dropped: the oldest unused one goes instead
  assert.deepEqual(f.report(f.a, { ticket: second, txHash: hashOf(1) }), [
    { ticket: second, txHash: hashOf(1), state: 'watching' },
  ])
  f.ticket()
  assert.equal(f.a.evmWallet.tickets.has(second), true)
  assert.equal(f.a.evmWallet.tickets.has(third), false)
  // tickets expire after ten minutes
  const late = f.ticket()
  f.advance(evm.TIP_TICKET_TTL_MS)
  assert.deepEqual(f.report(f.a, { ticket: late, txHash: hashOf(2) }), [
    { ticket: late, txHash: hashOf(2), state: 'failed', reason: 'unknown_ticket' },
  ])
})

test('evm tip report: checks the ticket and the hash; malformed reports get no reply', async t => {
  const f = await tipFixture(t)
  const ticket = f.ticket()
  assert.deepEqual(f.report(f.a, { ticket, txHash: '0x12' }), [
    { ticket, txHash: '0x12', state: 'failed', reason: 'bad_tx' },
  ])
  assert.deepEqual(f.report(f.a, { ticket: 'f'.repeat(32), txHash: hashOf(1) }), [
    { ticket: 'f'.repeat(32), txHash: hashOf(1), state: 'failed', reason: 'unknown_ticket' },
  ])
  // another socket cannot use this socket's ticket
  assert.deepEqual(f.report(f.b, { ticket, txHash: hashOf(1) })[0].reason, 'unknown_ticket')
  for (const data of [
    null,
    [],
    {},
    { ticket },
    { ticket: 'F'.repeat(32), txHash: hashOf(1) },
    { ticket, txHash: 1 },
    { ticket, txHash: hashOf(1), extra: 1 },
  ]) {
    assert.deepEqual(f.report(f.a, data), [], JSON.stringify(data))
  }
  assert.equal(f.watcher.jobs.length, 0)
  // the job is bound to the ticket, never to the report
  const hash = `0x${'AB'.repeat(32)}`
  assert.deepEqual(f.report(f.a, { ticket, txHash: hash }), [{ ticket, txHash: hash, state: 'watching' }])
  const [job] = f.watcher.jobs
  assert.equal(job.txHash, hash.toLowerCase())
  assert.equal(job.from, account.address)
  assert.equal(job.recipient, other.address)
  assert.equal(job.token, '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29')
  assert.equal(job.units, 100n * 10n ** 18n)
  assert.equal(job.notBeforeSec, f.a.evmWallet.tickets.get(ticket).issuedAt / 1000 - 30)
  assert.equal(job.isLive(), true)
  // a ticket is used once
  assert.equal(f.report(f.a, { ticket, txHash: hashOf(9) })[0].reason, 'unknown_ticket')
})

test('evm tip report: without an RPC the tip is sent but unconfirmed', async t => {
  const f = fixture(t, { evmGating: tipsEnabled })
  assert.equal(f.network.tipWatcher, null)
  const a = await f.connect('a')
  const b = await f.connect('b')
  await f.verify(a)
  await f.verify(b, { signer: other })
  f.network.onSetEvmTipReceive(b, { enabled: true })
  clear(a)
  f.network.onRequestEvmTipIntent(a, { id: 1, to: 'b', token: 'JPYC', amount: '1' })
  // said with the intent, before the wallet is asked: this world will not confirm the tip
  const { ticket, confirms } = replies(a, 'onEvmTipIntent')[0]
  assert.equal(confirms, false)
  clear(a)
  f.network.onEvmTip(a, { ticket, txHash: hashOf(1) })
  assert.deepEqual(replies(a, 'onEvmTipStatus'), [{ ticket, txHash: hashOf(1), state: 'unverified', reason: 'no_rpc' }])
})

test('evm tips: the world says whether it confirms tips, at sign-in and with each intent', async t => {
  const f = await tipFixture(t)
  const intent = () => {
    f.a.evmWallet.intentBucket.tokens = evm.TIP_INTENT_BURST
    clear(f.a)
    f.network.onRequestEvmTipIntent(f.a, { id: 1, to: 'b', token: 'JPYC', amount: '1' })
    return replies(f.a, 'onEvmTipIntent')[0]
  }
  const signIn = async attempt => {
    f.a.evmWallet.lastChallengeAt = 0
    clear(f.a)
    await f.verify(f.a, { attempt })
    return replies(f.a, 'onEvmWalletStatus').at(-1)
  }
  // a watcher whose RPC answers
  assert.equal(f.network.confirmsTips(), true)
  assert.equal(intent().confirms, true)
  assert.deepEqual(await signIn(2), {
    verified: true,
    wallet: account.address,
    attempt: 2,
    reason: 'ok',
    confirmsTips: true,
  })
  // the watcher found the `finalized` tag unanswered: the next intent and the next sign-in say so
  f.watcher.confirms = false
  assert.equal(f.network.confirmsTips(), false)
  assert.equal(intent().confirms, false)
  assert.equal((await signIn(3)).confirmsTips, false)
  // and it is still an intent: the transfer does not depend on the confirmation
  const granted = intent()
  assert.equal(granted.ok, true)
  assert.equal(granted.recipient, other.address)
  f.watcher.confirms = true
  assert.equal(intent().confirms, true)
})

test('evm tips: after a tip ended no_finality the next intent says the world does not confirm', async t => {
  // the real watcher on a chain whose RPC refuses the `finalized` tag, with a manual clock
  let clock = 0
  const pending = new Set()
  const receipt = {
    transactionHash: hashOf(1),
    status: '0x1',
    blockNumber: '0x10',
    blockHash: hashOf(2),
    logs: [
      {
        address: '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29',
        topics: [TRANSFER_TOPIC, `0x${encodeAddressWord(account.address)}`, `0x${encodeAddressWord(other.address)}`],
        data: `0x${encodeUintWord(10n ** 18n)}`,
        logIndex: '0x0',
      },
    ],
  }
  let finality = new RpcError(-32602)
  const watcher = createTipWatcher({
    rpc: {
      async call(method, params) {
        if (method === 'eth_getTransactionReceipt') return receipt
        if (params[0] === 'finalized') {
          if (finality instanceof Error) throw finality
          return finality
        }
        return { number: '0x10', hash: hashOf(2), timestamp: `0x${(2_000).toString(16)}` }
      },
    },
    now: () => clock,
    setTimeout: (fn, ms) => {
      const timer = { fn, at: clock + ms }
      pending.add(timer)
      return timer
    },
    clearTimeout: timer => pending.delete(timer),
    log: { error() {} },
  })
  const advance = async ms => {
    for (const end = clock + ms; clock < end; ) {
      clock += 1000
      for (const timer of [...pending]) {
        if (timer.at > clock) continue
        pending.delete(timer)
        timer.fn()
      }
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
  }
  const f = await tipFixture(t, { watcher })
  const intent = () => {
    f.a.evmWallet.intentBucket.tokens = evm.TIP_INTENT_BURST
    clear(f.a)
    f.network.onRequestEvmTipIntent(f.a, { id: 1, to: 'b', token: 'JPYC', amount: '1' })
    return replies(f.a, 'onEvmTipIntent')[0]
  }
  const first = intent()
  assert.equal(first.confirms, true, 'nothing is known against the RPC yet')
  f.network.onEvmTip(f.a, { ticket: first.ticket, txHash: hashOf(1) })
  await advance(3000)
  assert.deepEqual(replies(f.a, 'onEvmTipStatus').at(-1), {
    ticket: first.ticket,
    txHash: hashOf(1),
    state: 'unverified',
    reason: 'no_finality',
  })
  assert.equal(intent().confirms, false)
  // the RPC answers the tag later: the tip reported again is confirmed, and the world says it confirms again
  finality = { number: '0x10' }
  await advance(61_000)
  f.network.onEvmTip(f.a, { ticket: first.ticket, txHash: hashOf(1) })
  await advance(3000)
  assert.equal(replies(f.a, 'onEvmTipStatus').at(-1).state, 'confirmed')
  assert.equal(intent().confirms, true)
  watcher.stop()
})

test('evm tip result: confirmed tips reply, fire a frozen tip event without addresses and are announced', async t => {
  const f = await tipFixture(t)
  f.a.player.data.name = 'Al\nice‮'
  const ticket = f.ticket()
  f.report(f.a, { ticket, txHash: hashOf(1) })
  clear(f.a)
  f.events.length = 0
  f.advance(4000)
  f.watcher.jobs[0].onDone({ state: 'confirmed' })
  assert.deepEqual(replies(f.a, 'onEvmTipStatus'), [{ ticket, txHash: hashOf(1), state: 'confirmed' }])
  const tips = f.events.filter(([name]) => name === 'tip')
  assert.equal(tips.length, 1)
  const [, event] = tips[0]
  assert.ok(Object.isFrozen(event))
  assert.deepEqual(
    { ...event },
    {
      tipId: ticket,
      fromPlayerId: 'a',
      toPlayerId: 'b',
      token: 'JPYC',
      amount: '100',
      units: (100n * 10n ** 18n).toString(),
      decimals: 18,
      chainId: 137,
      at: 1_004_000,
    }
  )
  const text = JSON.stringify(event).toLowerCase()
  assert.equal(text.includes(account.address.slice(2).toLowerCase()), false, 'no sender address')
  assert.equal(text.includes(other.address.slice(2).toLowerCase()), false, 'no recipient address')
  assert.equal(text.includes(hashOf(1).slice(2)), false, 'no tx hash')
  // one world-wide system message; names lose line breaks and control characters
  assert.equal(f.chat.length, 1)
  assert.equal(f.chat[0].broadcast, true)
  assert.equal(f.chat[0].msg.fromId, null)
  assert.equal(f.chat[0].msg.from, null)
  assert.equal(f.chat[0].msg.kind, 'tip', 'the confirmation is a tip line, which no script can produce')
  assert.equal(f.chat[0].msg.body, 'Al ice tipped b 100 JPYC')
  assert.equal(f.a.evmWallet.tickets.has(ticket), false, 'the ticket is used up')
})

test('evm tip result: a confirmed transaction is counted once, and only once confirmed', async t => {
  const f = await tipFixture(t)
  const c = await f.connect('c')
  await f.verify(c, { signer: privateKeyToAccount(`0x${'33'.repeat(32)}`) })
  // someone else reports Alice's transaction first, with two tickets: both are watched, neither blocks Alice's
  // own report (there is no per-hash cap to fill), and neither can confirm (their sender is not in the log)
  for (let i = 0; i < 2; i++) {
    assert.equal(f.report(c, { ticket: f.ticket(c), txHash: hashOf(7) })[0].state, 'watching')
  }
  const mine = f.ticket()
  assert.equal(f.report(f.a, { ticket: mine, txHash: hashOf(7) })[0].state, 'watching')
  const extra = f.ticket()
  const [foreignJob, otherForeignJob, mineJob] = f.watcher.jobs
  assert.equal(foreignJob.from, c.evmWallet.verified, 'bound to the reporter')
  assert.equal(mineJob.from, account.address)
  foreignJob.onDone({ state: 'failed', reason: 'no_transfer' })
  otherForeignJob.onDone({ state: 'failed', reason: 'no_transfer' })
  mineJob.onDone({ state: 'confirmed' })
  assert.equal(f.events.filter(([name]) => name === 'tip').length, 1)
  // once confirmed, the hash is refused for thirty minutes
  assert.deepEqual(f.report(f.a, { ticket: extra, txHash: hashOf(7) }), [
    { ticket: extra, txHash: hashOf(7), state: 'failed', reason: 'duplicate' },
  ])
  f.advance(evm.TIP_SEEN_TTL_MS)
  const again = f.ticket()
  assert.equal(f.report(f.a, { ticket: again, txHash: hashOf(7) })[0].state, 'watching')
})

test('evm tip result: two tickets confirming the same transaction fire one event', async t => {
  const f = await tipFixture(t)
  const first = f.ticket()
  const second = f.ticket()
  f.report(f.a, { ticket: first, txHash: hashOf(3) })
  f.report(f.a, { ticket: second, txHash: hashOf(3) })
  clear(f.a)
  for (const job of [...f.watcher.jobs]) job.onDone({ state: 'confirmed' })
  assert.deepEqual(
    replies(f.a, 'onEvmTipStatus').map(r => r.state + (r.reason ? `:${r.reason}` : '')),
    ['confirmed', 'failed:duplicate']
  )
  assert.equal(f.events.filter(([name]) => name === 'tip').length, 1)
  assert.equal(f.chat.length, 1)
})

test('evm tip result: unconfirmed tips can be reported again once with the same hash', async t => {
  const f = await tipFixture(t)
  const ticket = f.ticket()
  f.report(f.a, { ticket, txHash: hashOf(4) })
  clear(f.a)
  f.watcher.jobs.pop().onDone({ state: 'unverified', reason: 'timeout' })
  assert.deepEqual(replies(f.a, 'onEvmTipStatus'), [
    { ticket, txHash: hashOf(4), state: 'unverified', reason: 'timeout' },
  ])
  assert.equal(f.a.evmWallet.tickets.get(ticket).state, 'retryable')
  assert.equal(f.report(f.a, { ticket, txHash: hashOf(5) })[0].reason, 'unknown_ticket', 'another hash')
  assert.equal(f.report(f.a, { ticket, txHash: hashOf(4) })[0].state, 'watching')
  f.watcher.jobs.pop().onDone({ state: 'unverified', reason: 'not_found' })
  assert.equal(f.a.evmWallet.tickets.has(ticket), false, 'no second retry')
  // failures and a departed sender end the ticket at once
  for (const result of [
    { state: 'failed', reason: 'reverted' },
    { state: 'unverified', reason: 'left' },
  ]) {
    const next = f.ticket()
    f.report(f.a, { ticket: next, txHash: hashOf(6) })
    f.watcher.jobs.pop().onDone(result)
    assert.equal(f.a.evmWallet.tickets.has(next), false, result.reason)
  }
  assert.equal(f.events.filter(([name]) => name === 'tip').length, 0)
  assert.equal(f.chat.length, 0)
})

test('evm tip report: two watched tips per socket, and a table of two for every connection the server admits', async t => {
  const f = await tipFixture(t)
  f.report(f.a, { ticket: f.ticket(), txHash: hashOf(10) })
  f.report(f.a, { ticket: f.ticket(), txHash: hashOf(11) })
  const third = f.ticket()
  assert.equal(f.report(f.a, { ticket: third, txHash: hashOf(12) })[0].reason, 'busy')
  f.watcher.jobs.pop().onDone({ state: 'failed', reason: 'no_transfer' })
  assert.equal(f.report(f.a, { ticket: third, txHash: hashOf(12) })[0].state, 'watching', 'a slot came back')
  // the table is full at TIP_WATCH_MAX, whoever filled it, and has room again one below it
  f.watcher.jobs.length = 0
  for (let i = 0; i < evm.TIP_WATCH_MAX; i++) f.watcher.jobs.push({ socket: null })
  f.network.onSetEvmTipReceive(f.a, { enabled: true })
  const fourth = f.ticket(f.b, { to: 'a' })
  assert.equal(f.report(f.b, { ticket: fourth, txHash: hashOf(13) })[0].reason, 'busy')
  f.watcher.jobs.pop()
  assert.equal(f.report(f.b, { ticket: fourth, txHash: hashOf(13) })[0].state, 'watching', 'busy leaves the ticket')
})

test('evm tip report: eight connections with two junk reports each leave a ninth its two slots', async t => {
  // eight is what one address may have open (WS_CONNECT_CONCURRENT_PER_IP); the table used to hold 16 jobs
  const f = await tipFixture(t)
  const junk = privateKeyToAccount(`0x${'44'.repeat(32)}`)
  let hash = 100
  for (let i = 0; i < 8; i++) {
    const socket = await f.connect(`junk${i}`)
    await f.verify(socket, { signer: junk })
    for (let slot = 0; slot < 2; slot++) {
      assert.equal(f.report(socket, { ticket: f.ticket(socket), txHash: hashOf(hash++) })[0].state, 'watching')
    }
    assert.equal(f.report(socket, { ticket: f.ticket(socket), txHash: hashOf(hash++) })[0].reason, 'busy')
  }
  assert.equal(f.watcher.jobs.length, 16)
  for (let slot = 0; slot < 2; slot++) {
    assert.equal(f.report(f.a, { ticket: f.ticket(), txHash: hashOf(hash++) })[0].state, 'watching')
  }
  assert.equal(f.watcher.jobs.length, 18)
})

test('evm tip announcements: three at once then one every three seconds; a sender is announced once per 30 s', async t => {
  const f = await tipFixture(t)
  const senders = []
  for (const id of ['c', 'd', 'e', 'g']) {
    const socket = await f.connect(id)
    await f.verify(socket, { signer: privateKeyToAccount(`0x${String(senders.length + 4).repeat(64)}`) })
    senders.push(socket)
  }
  let next = 100
  const confirm = socket => {
    const ticket = f.ticket(socket)
    f.report(socket, { ticket, txHash: hashOf(next++) })
    f.watcher.jobs.pop().onDone({ state: 'confirmed' })
  }
  for (const socket of senders) confirm(socket)
  assert.deepEqual(
    f.chat.map(entry => entry.msg.body),
    ['c tipped b 100 JPYC', 'd tipped b 100 JPYC', 'e tipped b 100 JPYC']
  )
  assert.equal(f.timers.pending.size, 1, 'the fourth waits')
  f.advance(3000)
  f.timers.runAll()
  assert.equal(f.chat.at(-1).msg.body, 'g tipped b 100 JPYC')
  assert.equal(f.timers.pending.size, 0)
  // the same sender again within 30 s: only the recipient hears about it, worded as private
  clear(f.b)
  confirm(senders[0])
  assert.equal(f.chat.length, 4)
  const privateNotes = replies(f.b, 'onChatAdded')
  assert.equal(privateNotes.length, 1)
  assert.equal(privateNotes[0].body, '(only you) c tipped you 100 JPYC')
  assert.equal(privateNotes[0].fromId, null)
  assert.equal(privateNotes[0].kind, 'tip')
  assert.equal(f.events.filter(([name]) => name === 'tip').length, 5, 'every confirmed tip fires the event')
  f.advance(30_000)
  confirm(senders[0])
  assert.equal(f.chat.length, 5)
})

test('evm tips: a disconnect drops the tickets and cancels the jobs; invalidation keeps watched tickets', async t => {
  const f = await tipFixture(t)
  const watched = f.ticket()
  const idle = f.ticket()
  f.report(f.a, { ticket: watched, txHash: hashOf(20) })
  // a new nonce withdraws the verification; the tickets stay (their sender is fixed at issue time)
  f.advance(evm.CHALLENGE_COOLDOWN_MS)
  f.network.onRequestEvmNonce(f.a, { address: account.address, attempt: 9 })
  assert.deepEqual([...f.a.evmWallet.tickets.keys()], [watched, idle])
  assert.equal(f.watcher.jobs.length, 1)
  // the result still arrives on the same connection
  f.watcher.jobs[0].onDone({ state: 'failed', reason: 'no_transfer' })
  assert.deepEqual([...f.a.evmWallet.tickets.keys()], [idle])
  // a wallet switch during the send reaches the server before the report: the payment is still watched,
  // for the address the ticket was issued to
  assert.equal(f.report(f.a, { ticket: idle, txHash: hashOf(22) })[0].state, 'watching')
  assert.equal(f.watcher.jobs[0].from, account.address)
  f.watcher.jobs.pop().onDone({ state: 'failed', reason: 'no_transfer' })

  f.advance(evm.CHALLENGE_COOLDOWN_MS)
  await f.verify(f.a, { attempt: 10 })
  const next = f.ticket()
  f.report(f.a, { ticket: next, txHash: hashOf(21) })
  const job = f.watcher.jobs[0]
  f.a.disconnect()
  assert.equal(f.watcher.jobs.length, 0, 'cancelled')
  assert.equal(job.isLive(), false)
  assert.equal(f.a.evmWallet.tickets.size, 0)
  // a late result after the disconnect does nothing
  job.onDone({ state: 'confirmed' })
  assert.equal(f.events.filter(([name]) => name === 'tip').length, 0)
})

test('evm tips: a recipient who left still gets the tip counted, under the name kept at intent time', async t => {
  const f = await tipFixture(t)
  const ticket = f.ticket()
  f.report(f.a, { ticket, txHash: hashOf(30) })
  f.b.disconnect()
  f.watcher.jobs[0].onDone({ state: 'confirmed' })
  assert.equal(f.events.filter(([name]) => name === 'tip').length, 1)
  assert.equal(f.chat[0].msg.body, 'a tipped b 100 JPYC')
})

test('evm tips: stopping for a fatal error stops the watcher and the announcement timer', async t => {
  const f = await tipFixture(t)
  for (const [index, id] of ['c', 'd', 'e', 'g'].entries()) {
    const socket = await f.connect(id)
    await f.verify(socket, { signer: privateKeyToAccount(`0x${String(index + 4).repeat(64)}`) })
    const ticket = f.ticket(socket)
    f.report(socket, { ticket, txHash: hashOf(id.charCodeAt(0)) })
    f.watcher.jobs.pop().onDone({ state: 'confirmed' })
  }
  assert.equal(f.timers.pending.size, 1)
  f.network.stopForFatal()
  assert.equal(f.watcher.stopped, 1)
  assert.equal(f.timers.pending.size, 0)
  // results after the stop do nothing
  const before = f.events.length
  f.network.onTipResult(f.a, 'x', hashOf(1), { state: 'confirmed' })
  assert.equal(f.events.length, before)
})

test('evm tips: a revoke that reaches the server before the report keeps the payment watched', async t => {
  const f = await tipFixture(t)
  const ticket = f.ticket()
  // the wallet switched account while sending: the client revokes first, then reports the hash it got
  f.network.onRevokeEvmWallet(f.a, {})
  assert.equal(f.a.evmWallet.verified, null)
  assert.deepEqual(f.report(f.a, { ticket, txHash: hashOf(40) }), [{ ticket, txHash: hashOf(40), state: 'watching' }])
  assert.equal(f.watcher.jobs[0].from, account.address)
  f.watcher.jobs[0].onDone({ state: 'confirmed' })
  assert.equal(f.events.filter(([name]) => name === 'tip').length, 1)
})
