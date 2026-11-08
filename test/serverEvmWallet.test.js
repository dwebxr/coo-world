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

function fixture(t, { evmGating = evmEnabled, balance = 0, evmHoldings } = {}) {
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
  const network = makeNetwork(() => {}, {
    tokenBalanceService: service,
    evmHoldings,
    context: { solanaGating: solanaEnabled, evmGating, process: { env: {} } },
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
    chat: { serialize: () => [] },
    ai: { serialize: () => ({}) },
    blueprints: { serialize: () => [] },
    events: { emit: (name, data) => events.push([name, data]) },
    entities: {
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
  const f = { network, calls, events }
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
  await f.network.onRequestEvmVerify(socket, { ...malformed, signature: '0x1234' })
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
  await f.verify(a)
  f.advance(10_000)
  assert.deepEqual(intent(a), [
    {
      id: 1,
      ok: true,
      to: 'b',
      recipient: other.address,
      chainId: 137,
      token: { symbol: 'JPYC', address: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29', decimals: 18 },
      amount: '100',
      units: (100n * 10n ** 18n).toString(),
    },
  ])
  assert.equal(replies(b, 'onEvmTipIntent').length, 0, 'nobody else gets the address')
  assert.equal(replies(c, 'onEvmTipIntent').length, 0)
  f.advance(30_000)
  assert.deepEqual(intent(a, { token: 'USDC', amount: '0.5' })[0].units, '500000')
  assert.deepEqual(intent(a, { token: 'DOGE' }), [{ id: 1, ok: false, reason: 'bad_token' }])
  assert.deepEqual(intent(a, { amount: '0.5' }), [{ id: 1, ok: false, reason: 'below_minimum' }])
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
