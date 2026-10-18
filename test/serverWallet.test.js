import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import nacl from 'tweetnacl'
import { PublicKey } from '@solana/web3.js'
import moment from 'moment'
import Fastify from 'fastify'
import { uploadRoutes } from '../src/server/uploadRoutes.js'
import { connectionMethod, fakeWs, makeNetwork } from './lib/networkHarness.mjs'
import { readPacket, writeClientPacket } from '../src/core/packets.js'
import { Ranks } from '../src/core/extras/ranks.js'
import { sanitizeName, isAvatarUrl } from '../src/core/extras/entityModifyPolicy.js'
import * as gating from '../src/server/solana-gating.js'

const enabled = { ...gating, TOKEN_GATING_ENABLED: true, REQUIRED_TOKEN_AMOUNT: 10000, WALLET_HOST: 'test.example' }
const keyA = nacl.sign.keyPair()
const keyB = nacl.sign.keyPair()
const addressOf = key => new PublicKey(key.publicKey).toBase58()
const address = addressOf(keyA)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const packets = socket => socket.ws.packets.map(readPacket)
const replies = (socket, method) =>
  packets(socket)
    .filter(([name]) => name === method)
    .map(([, data]) => data)
const clear = socket => {
  socket.ws.drain()
  socket.ws.packets.length = 0
}

function fixture(t, { result = { known: true, balance: 0 } } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const calls = []
  const users = new Map()
  const entities = new Map()
  const writes = []
  const f = { calls, users, entities, writes, result, write: async () => {} }
  const service = {
    get: (wallet, options) => {
      calls.push({ wallet, options })
      return f.result
    },
  }
  const network = makeNetwork(() => {}, {
    tokenBalanceService: service,
    context: { solanaGating: enabled, process: { env: { ADMIN_CODE: 'code' } } },
  })
  f.network = network
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  network.db = table => ({
    where: (column, id) => ({
      first: async () => users.get(id),
      update: async patch => {
        writes.push({ table, column, id, patch })
        await f.write()
        Object.assign(users.get(id), patch)
      },
    }),
  })
  Object.assign(network.world, {
    settings: { serialize: () => ({}), effectiveRank: 0 },
    livekit: { serialize: async () => ({}), clearModifiers() {} },
    collections: { serialize: () => [] },
    chat: { serialize: () => [] },
    ai: { serialize: () => ({}) },
    blueprints: { serialize: () => [] },
    events: { emit() {} },
    entities: {
      add(data) {
        const player = {
          data,
          isPlayer: true,
          modify: patch => Object.assign(data, patch),
          isAdmin: () => data.rank >= Ranks.ADMIN,
          isBuilder: () => Math.max(data.rank, network.world.settings.effectiveRank) >= Ranks.BUILDER,
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
    solanaGating: enabled,
    moment,
    sanitizeName,
    isAvatarUrl,
    isNumber: value => typeof value === 'number',
    readJWT: async userId => ({ userId }),
    HEALTH_MAX: 100,
    process: { env: {} },
    performance,
  })
  f.connect = async (id = 'visitor', rank = Ranks.VISITOR) => {
    if (!users.has(id)) users.set(id, { id, name: id, rank })
    const ws = fakeWs()
    await network.onConnection(ws, { authToken: id })
    assert.equal(ws.terminations, 0, 'connection succeeded')
    return network.sockets.get(id)
  }
  f.advance = ms => t.mock.timers.tick(ms)
  f.challenge = (socket, attempt = 1, key = keyA) => {
    network.onRequestBuilderNonce(socket, { walletAddress: addressOf(key), attempt })
    const challenge = socket.wallet.challenge
    assert.ok(challenge)
    return {
      walletAddress: addressOf(key),
      attempt,
      nonce: challenge.nonce,
      signature: Buffer.from(nacl.sign.detached(new TextEncoder().encode(challenge.message), key.secretKey)).toString(
        'base64'
      ),
    }
  }
  f.verify = (socket, attempt = 1, key = keyA) =>
    network.onRequestBuilderByToken(socket, f.challenge(socket, attempt, key))
  t.after(() => {
    for (const socket of network.sockets.values()) socket.disconnect()
  })
  return f
}

test('wallet service: one injected or production instance; disabled gating constructs neither service nor RPC', () => {
  for (const on of [false, true]) {
    let rpc = 0,
      services = 0
    const service = { get() {} }
    const readRaw = () => {}
    const context = {
      solanaGating: { ...enabled, TOKEN_GATING_ENABLED: on },
      createSolanaRpc: () => {
        rpc++
        return { readRaw }
      },
      createTokenBalanceService: options => {
        services++
        assert.equal(options.readRaw, readRaw)
        return service
      },
    }
    const production = makeNetwork(() => {}, { context })
    assert.equal(production.tokenBalanceService, on ? service : null)
    assert.equal(rpc, on ? 1 : 0)
    assert.equal(services, on ? 1 : 0)
    const injected = makeNetwork(() => {}, { context, tokenBalanceService: service })
    assert.equal(injected.tokenBalanceService, on ? service : null)
    assert.equal(rpc, on ? 1 : 0)
    assert.equal(services, on ? 1 : 0)
  }
})

for (const rank of [Ranks.BUILDER, Ranks.ADMIN]) {
  test(`wallet ranks: stored rank ${rank} verifies without balance reads or chat`, async t => {
    const f = fixture(t)
    const socket = await f.connect('stored', rank)
    clear(socket)
    await f.verify(socket)
    assert.equal(socket.wallet.verified, address)
    assert.deepEqual(replies(socket, 'onWalletStatus'), [{ verified: true, wallet: address, attempt: 1 }])
    assert.equal(f.calls.length, 0)
    assert.equal(replies(socket, 'onChatAdded').length, 0)
    assert.equal(gating.walletOf(socket.id), null)
    f.network.onRevokeBuilderByToken(socket, {})
    assert.equal(socket.player.data.rank, rank)
    assert.equal(socket.wallet.verified, null)
  })
}

for (const [name, result, granted] of [
  ['below', { known: true, balance: 9999 }, false],
  ['above', { known: true, balance: 10000 }, true],
  ['unknown', { known: false }, false],
]) {
  test(`wallet ranks: visitor ${name} stays verified; only a fresh rich result grants`, async t => {
    const f = fixture(t, { result })
    f.network.world.settings.effectiveRank = Ranks.BUILDER
    const socket = await f.connect()
    clear(socket)
    await f.verify(socket)
    assert.equal(socket.wallet.verified, address)
    assert.equal(socket.player.data.rank, granted ? Ranks.BUILDER : Ranks.VISITOR)
    assert.equal(socket.player.rankRevision, granted ? 1 : 0)
    assert.equal(gating.walletOf(socket.id), granted ? address : null)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].wallet, address)
    assert.equal(f.calls[0].options.fresh, true)
    const chats = replies(socket, 'onChatAdded')
    assert.equal(chats.length, 1)
    assert.match(
      chats[0].body,
      granted ? /トークン認証成功/ : name === 'below' ? /トークンが必要/ : /残高を確認できませんでした/
    )
  })
}

test('wallet replies: cooldown replies once per window and never invalidates verification', async t => {
  const f = fixture(t)
  const socket = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  clear(socket)
  const generation = socket.wallet.generation
  for (let attempt = 2; attempt < 102; attempt++)
    f.network.onRequestBuilderNonce(socket, { walletAddress: address, attempt })
  assert.deepEqual(packets(socket), [['onBuilderNonce', { attempt: 2, retryAfterMs: 5000 }]])
  assert.equal(socket.wallet.generation, generation)
  assert.equal(socket.wallet.verified, address)
  f.advance(5000)
  f.challenge(socket, 102)
  assert.deepEqual(replies(socket, 'onWalletStatus'), [{ verified: false }])
  assert.equal(socket.wallet.verified, null)
  assert.equal(socket.wallet.generation, generation + 1)
  f.network.onRequestBuilderNonce(socket, { walletAddress: address, attempt: 103 })
  assert.deepEqual(replies(socket, 'onBuilderNonce').at(-1), { attempt: 103, retryAfterMs: 5000 })
})

test('wallet replies: no challenge, reused verification and revoke floods are silent', async t => {
  const f = fixture(t)
  const socket = await f.connect('admin', Ranks.ADMIN)
  clear(socket)
  for (let i = 0; i < 100; i++) {
    await f.network.onRequestBuilderByToken(socket, {
      walletAddress: address,
      signature: 'invalid',
      nonce: 'x'.repeat(44),
      attempt: 1,
    })
    f.network.onRevokeBuilderByToken(socket, {})
  }
  assert.deepEqual(packets(socket), [])
  const proof = f.challenge(socket)
  await f.network.onRequestBuilderByToken(socket, proof)
  clear(socket)
  await f.network.onRequestBuilderByToken(socket, proof)
  assert.deepEqual(packets(socket), [])
  for (let i = 0; i < 100; i++) f.network.onRevokeBuilderByToken(socket, {})
  assert.deepEqual(packets(socket), [['onWalletStatus', { verified: false }]])
  assert.equal(socket.wallet.lastChallengeAt, 1_000_000)
})

test('wallet attempts: obsolete nonce or attempt leaves the current challenge usable', async t => {
  const f = fixture(t)
  const socket = await f.connect('admin', Ranks.ADMIN)
  const old = f.challenge(socket, 1)
  f.advance(5000)
  const proof = f.challenge(socket, 2)
  const challenge = socket.wallet.challenge
  clear(socket)
  for (const obsolete of [old, { ...proof, attempt: 1 }, { ...proof, nonce: old.nonce }]) {
    await f.network.onRequestBuilderByToken(socket, obsolete)
    assert.equal(socket.wallet.challenge, challenge)
  }
  assert.deepEqual(packets(socket), [])
  await f.network.onRequestBuilderByToken(socket, proof)
  assert.equal(socket.wallet.verified, address)
  assert.equal(socket.wallet.challenge, null)
})

test('wallet cross-socket: another socket cannot use or sign the first socket challenge', async t => {
  const f = fixture(t)
  const a = await f.connect('a', Ranks.ADMIN)
  const b = await f.connect('b', Ranks.ADMIN)
  const proofA = f.challenge(a)
  const proofB = f.challenge(b, 1, keyB)
  const challengeB = b.wallet.challenge
  clear(a)
  clear(b)
  await f.network.onRequestBuilderByToken(b, proofA)
  assert.equal(b.wallet.challenge, challengeB)
  assert.deepEqual(packets(b), [])
  const wrong = {
    ...proofA,
    signature: Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(a.wallet.challenge.message), keyB.secretKey)
    ).toString('base64'),
  }
  await f.network.onRequestBuilderByToken(a, wrong)
  assert.equal(a.wallet.verified, null)
  assert.equal(a.wallet.challenge, null)
  assert.deepEqual(replies(a, 'onWalletStatus'), [{ verified: false, attempt: 1 }])
  await f.network.onRequestBuilderByToken(b, proofB)
  assert.equal(b.wallet.verified, addressOf(keyB))
})

for (const change of ['revoke', 'admin', 'nonce', 'close', 'stopping', 'fatal', 'player']) {
  test(`wallet liveness: ${change} during a pending grant drops all completion effects`, async t => {
    const pending = deferred()
    const f = fixture(t, { result: pending.promise })
    const socket = await f.connect()
    const admin = await f.connect('admin', Ranks.ADMIN)
    const verifying = f.verify(socket)
    assert.equal(f.calls.length, 1)
    if (change === 'revoke') f.network.onRevokeBuilderByToken(socket, {})
    if (change === 'admin') await f.network.onModifyRank(admin, { playerId: socket.id, rank: Ranks.VISITOR })
    if (change === 'nonce') {
      f.advance(5000)
      f.challenge(socket, 2)
    }
    if (change === 'close') socket.disconnect()
    if (change === 'stopping') f.network.stopping = true
    if (change === 'fatal') f.network.world.fatalError = new Error('fatal')
    if (change === 'player') socket.player = { ...socket.player }
    clear(socket)
    pending.resolve({ known: true, balance: 10000 })
    await verifying
    assert.deepEqual(packets(socket), [])
    assert.equal(socket.player.data.rank, Ranks.VISITOR)
    assert.equal(gating.walletOf(socket.id), null)
    if (change === 'admin') assert.equal(socket.wallet.verified, address)
  })
}

test('wallet invalidation: failure after success, consumed failure, and revoke during signing', async t => {
  const f = fixture(t)
  const socket = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  f.advance(5000)
  const proof = f.challenge(socket, 2)
  assert.equal(socket.wallet.verified, null)
  const bad = { ...proof, signature: Buffer.alloc(64).toString('base64') }
  clear(socket)
  await f.network.onRequestBuilderByToken(socket, bad)
  await f.network.onRequestBuilderByToken(socket, bad)
  assert.equal(socket.wallet.verified, null)
  assert.deepEqual(replies(socket, 'onWalletStatus'), [{ verified: false, attempt: 2 }])
  assert.equal(replies(socket, 'onChatAdded').length, 1)
  f.advance(5000)
  const late = f.challenge(socket, 3)
  clear(socket)
  f.network.onRevokeBuilderByToken(socket, {})
  await f.network.onRequestBuilderByToken(socket, late)
  assert.deepEqual(packets(socket), [['onWalletStatus', { verified: false }]])
})

for (const via of ['modifyRank', 'admin']) {
  test(`wallet persist race: ${via} pending demotion refuses verify and recheck; completion allows grant`, async t => {
    const f = fixture(t)
    const socket = await f.connect('subject', via === 'admin' ? Ranks.ADMIN : Ranks.BUILDER)
    const admin = await f.connect('moderator', Ranks.ADMIN)
    await f.verify(socket)
    const write = deferred()
    f.write = () => write.promise
    const saving =
      via === 'admin'
        ? f.network.onCommand(socket, { args: ['admin', 'code'] })
        : f.network.onModifyRank(admin, { playerId: socket.id, rank: Ranks.VISITOR })
    assert.equal(socket.player.rankWritesPending, 1)
    assert.equal(socket.player.rankRevision, 1)
    assert.equal(socket.wallet.verified, address)
    clear(socket)
    f.result = { known: true, balance: 10000 }
    await f.network.onRequestBuilderRecheck(socket, {})
    f.advance(5000)
    await f.verify(socket, 2)
    assert.equal(f.calls.length, 0)
    assert.equal(socket.player.data.rank, Ranks.VISITOR)
    assert.equal(replies(socket, 'onChatAdded').length, 2)
    write.resolve()
    await saving
    assert.equal(socket.player.rankWritesPending, 0)
    f.advance(5000)
    await f.network.onRequestBuilderRecheck(socket, {})
    assert.equal(socket.player.data.rank, Ranks.BUILDER)
    assert.equal(socket.player.rankRevision, 2)
    assert.equal(socket.player.data.tokenGrantedRank, true)
    assert.equal(gating.walletOf(socket.id), address)
  })
}

test('wallet persist race: rejected writes release the pending count without clearing the grant', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect()
  await f.verify(socket)
  const admin = await f.connect('admin', Ranks.ADMIN)
  f.write = async () => {
    throw Error('SQLITE_BUSY')
  }
  await f.network.onModifyRank(admin, { playerId: socket.id, rank: Ranks.VISITOR })
  assert.equal(socket.player.rankWritesPending, 0)
  assert.equal(socket.player.data.tokenGrantedRank, true)
  assert.equal(gating.walletOf(socket.id), address)
  await f.network.onCommand(admin, { args: ['admin', 'code'] })
  assert.equal(admin.player.rankWritesPending, 0)
})

test('wallet persist race: disconnect and same-user reconnect preserve the new builder map entry', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const old = await f.connect()
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(old)
  const write = deferred()
  f.write = () => write.promise
  const saving = f.network.onModifyRank(admin, { playerId: old.id, rank: Ranks.VISITOR })
  old.disconnect()
  assert.equal(old.closed, true)
  assert.equal(old.disconnected, true)
  assert.equal(gating.walletOf(old.id), null)
  const next = await f.connect(old.id)
  assert.equal(next.wallet.verified, null)
  assert.equal(next.wallet.challenge, null)
  assert.equal(next.wallet.generation, 0)
  assert.equal(next.player.rankWritesPending, 0)
  await f.verify(next, 1, keyB)
  write.resolve()
  await saving
  assert.equal(next.player.data.tokenGrantedRank, true)
  assert.equal(gating.walletOf(next.id), addressOf(keyB))
})

test('wallet liveness: duplicate_user refuses a second live connection without clearing the first', async t => {
  const f = fixture(t)
  const socket = await f.connect('same', Ranks.ADMIN)
  await f.verify(socket)
  const ws = fakeWs()
  await f.network.onConnection(ws, { authToken: 'same' })
  assert.deepEqual(ws.packets.map(readPacket), [['onKick', 'duplicate_user']])
  assert.equal(ws.readyState, 3)
  assert.equal(f.network.sockets.get('same'), socket)
  assert.equal(socket.wallet.verified, address)
})

test('wallet liveness: reconnect drops an old pending grant and restart requires verification again', async t => {
  const pending = deferred()
  const f = fixture(t, { result: pending.promise })
  const old = await f.connect()
  const verifying = f.verify(old)
  old.disconnect()
  const next = await f.connect(old.id)
  clear(next)
  clear(old)
  pending.resolve({ known: true, balance: 10000 })
  await verifying
  assert.deepEqual(packets(old), [])
  assert.deepEqual(packets(next), [])
  assert.equal(next.wallet.verified, null)
  assert.equal(next.player.data.rank, Ranks.VISITOR)
  f.result = { known: false }
  await f.verify(next)
  next.disconnect()
  const restarted = makeNetwork(() => {}, {
    tokenBalanceService: f.network.tokenBalanceService,
    context: { solanaGating: enabled },
  })
  restarted.db = f.network.db
  restarted.spawn = f.network.spawn
  restarted.world = f.network.world
  restarted.onConnection = f.network.onConnection
  const ws = fakeWs()
  await restarted.onConnection(ws, { authToken: old.id })
  const socket = restarted.sockets.get(old.id)
  assert.equal(socket.wallet.verified, null)
  assert.equal(socket.wallet.challenge, null)
  assert.equal(gating.walletOf(socket.id), null)
  socket.disconnect()
})

test('wallet balances: immediate unverified answers consume admission and over-limit requests are silent', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  clear(socket)
  for (let id = 1; id <= 20; id++) await f.network.onTokenBalanceRequest(socket, { id })
  assert.deepEqual(
    replies(socket, 'onTokenBalance'),
    [1, 2, 3].map(id => ({ id, verified: false, known: false, balance: 0 }))
  )
  assert.equal(f.calls.length, 0)
  f.advance(1999)
  await f.network.onTokenBalanceRequest(socket, { id: 21 })
  assert.equal(replies(socket, 'onTokenBalance').length, 3)
  f.advance(1)
  await f.network.onTokenBalanceRequest(socket, { id: 22 })
  assert.equal(replies(socket, 'onTokenBalance').length, 4)
  assert.equal(replies(socket, 'onTokenBalance').at(-1).id, 22)
})

test('wallet balances: pending duplicates consume admission silently; known and unknown have exact shapes', async t => {
  const f = fixture(t)
  const socket = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  const pending = deferred()
  f.result = pending.promise
  clear(socket)
  const reading = f.network.onTokenBalanceRequest(socket, { id: 1 })
  for (let id = 2; id <= 4; id++) await f.network.onTokenBalanceRequest(socket, { id })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].options, undefined)
  assert.deepEqual(packets(socket), [])
  pending.resolve({ known: true, balance: 12345 })
  await reading
  assert.deepEqual(replies(socket, 'onTokenBalance'), [{ id: 1, verified: true, known: true, balance: 12345 }])
  assert.equal(socket.wallet.pendingBalance, null)
  await f.network.onTokenBalanceRequest(socket, { id: 5 })
  assert.equal(f.calls.length, 1)
  f.advance(2000)
  f.result = { known: false }
  await f.network.onTokenBalanceRequest(socket, { id: 6 })
  assert.deepEqual(replies(socket, 'onTokenBalance').at(-1), { id: 6, verified: true, known: false, balance: 0 })
})

for (const change of ['close', 'generation', 'wallet', 'stopping', 'fatal']) {
  test(`wallet balances: ${change} drops a pending answer`, async t => {
    const f = fixture(t)
    const socket = await f.connect('admin', Ranks.ADMIN)
    await f.verify(socket)
    const pending = deferred()
    f.result = pending.promise
    const reading = f.network.onTokenBalanceRequest(socket, { id: 1 })
    if (change === 'close') socket.disconnect()
    if (change === 'generation') f.network.invalidateWallet(socket, { clearVerified: false })
    if (change === 'wallet') socket.wallet.verified = addressOf(keyB)
    if (change === 'stopping') f.network.stopping = true
    if (change === 'fatal') f.network.world.fatalError = new Error('fatal')
    clear(socket)
    pending.resolve({ known: true, balance: 10000 })
    await reading
    assert.deepEqual(packets(socket), [])
    assert.equal(socket.wallet.pendingBalance, null)
  })
}

test('wallet balances: old finally cannot clear a newer pending request after invalidation', async t => {
  const f = fixture(t)
  const socket = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  const old = deferred(),
    next = deferred()
  f.result = old.promise
  const first = f.network.onTokenBalanceRequest(socket, { id: 1 })
  f.network.invalidateWallet(socket, { clearVerified: false })
  f.result = next.promise
  const second = f.network.onTokenBalanceRequest(socket, { id: 2 })
  const current = socket.wallet.pendingBalance
  clear(socket)
  old.resolve({ known: true, balance: 9 })
  await first
  assert.equal(socket.wallet.pendingBalance, current)
  assert.deepEqual(packets(socket), [])
  next.resolve({ known: true, balance: 10 })
  await second
  assert.equal(socket.wallet.pendingBalance, null)
  assert.deepEqual(replies(socket, 'onTokenBalance'), [{ id: 2, verified: true, known: true, balance: 10 }])
})

test('wallet recheck: verified-only cooldown, silent insufficiency, fresh grant and transition-only revoke', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(f.calls.length, 0)
  await f.verify(socket)
  clear(socket)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.deepEqual(packets(socket), [])
  assert.equal(f.calls.length, 2)
  f.result = { known: true, balance: 10000 }
  f.advance(9999)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(f.calls.length, 2)
  f.advance(1)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(f.calls.length, 3)
  assert.ok(f.calls.every(call => call.options.fresh))
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(f.calls.length, 3)
  clear(socket)
  for (let i = 0; i < 100; i++) f.network.onRevokeBuilderByToken(socket, {})
  assert.equal(replies(socket, 'onWalletStatus').length, 1)
  assert.equal(replies(socket, 'onChatAdded').length, 1)
  assert.equal(replies(socket, 'onEntityModified').length, 1)
  assert.equal(socket.player.rankRevision, 2)
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.equal(gating.walletOf(socket.id), null)
  f.advance(10000)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(f.calls.length, 3)
})

test('wallet bounds: malformed inbound fields do not issue challenges or start reads', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  clear(socket)
  const invalidIds = [undefined, null, 0, -1, 0x80000000, 1.5, '1', {}, [], NaN, Infinity]
  for (const attempt of invalidIds) f.network.onRequestBuilderNonce(socket, { walletAddress: address, attempt })
  for (const walletAddress of [null, {}, [], 123, '1'.repeat(31), '1'.repeat(45), '0'.repeat(32)]) {
    f.network.onRequestBuilderNonce(socket, { walletAddress, attempt: 1 })
  }
  for (const data of [null, false, 1, 'x', [], ...invalidIds.map(id => ({ id }))])
    await f.network.onTokenBalanceRequest(socket, data)
  for (const data of [null, false, 1, 'x', [], { unexpected: true }]) {
    await f.network.onRequestBuilderRecheck(socket, data)
    f.network.onRevokeBuilderByToken(socket, data)
  }
  assert.deepEqual(packets(socket), [])
  assert.equal(f.calls.length, 0)
  assert.equal(socket.wallet.generation, 0)
  const proof = f.challenge(socket, 0x7fffffff)
  clear(socket)
  for (const attempt of invalidIds) await f.network.onRequestBuilderByToken(socket, { ...proof, attempt })
  assert.ok(socket.wallet.challenge)
  assert.deepEqual(packets(socket), [])
  await f.network.onRequestBuilderByToken(socket, { ...proof, signature: Array(64).fill(256) })
  assert.equal(socket.wallet.challenge, null)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(replies(socket, 'onWalletStatus'), [{ verified: false, attempt: 0x7fffffff }])
})

test('wallet direction and byte limits: wrong-direction packets are no-ops and new inbound caps apply', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  clear(socket)
  for (const name of ['walletStatus', 'tokenBalance'])
    socket.onMessage(writeClientPacket(name, { verified: true, wallet: address, balance: 1e9 }))
  f.network.flush()
  assert.deepEqual(packets(socket), [])
  assert.equal(socket.wallet.verified, null)
  assert.equal(f.calls.length, 0)
  assert.equal(f.network.onWalletStatus, undefined)
  assert.equal(f.network.onTokenBalance, undefined)
  const client = fs.readFileSync(new URL('../src/core/systems/ClientNetwork.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /onTokenBalanceRequest\s*=|onRequestBuilderRecheck\s*=/)
  for (const [name, valid] of [
    ['tokenBalanceRequest', { id: 0x7fffffff }],
    ['requestBuilderRecheck', {}],
  ]) {
    assert.ok(f.network.admit(socket, writeClientPacket(name, valid)))
    assert.equal(f.network.admit(socket, writeClientPacket(name, { extra: 'x'.repeat(65) })), false)
  }
})

test('wallet privacy: player data, broadcasts and subsequent snapshots contain no verification or wallet', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const visitor = await f.connect()
  await f.verify(visitor)
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(admin, 1, keyB)
  const observer = await f.connect('observer')
  const snapshot = replies(observer, 'onSnapshot')[0]
  assert.equal(snapshot.entities.length, 3)
  const data = JSON.stringify({
    players: [...f.entities.values()].map(p => p.data),
    snapshot,
    broadcasts: replies(visitor, 'onEntityModified'),
  })
  for (const value of [
    address,
    addressOf(keyB),
    'verified',
    'wallet',
    'rankRevision',
    'rankWritesPending',
    'challenge',
  ])
    assert.equal(data.includes(value), false, value)
  assert.equal(gating.walletOf(visitor.id), address)
  assert.equal(gating.walletOf(admin.id), null)
})

test('wallet uploads: routes use only token-granted builder wallets, never socket verification', async t => {
  const f = fixture(t)
  const visitor = await f.connect('visitor')
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(visitor)
  await f.verify(admin)
  f.result = { known: true, balance: 10000 }
  const builder = await f.connect('token-builder')
  await f.verify(builder, 1, keyB)
  const identities = []
  const lookups = []
  const app = Fastify()
  t.after(() => app.close())
  app.register(uploadRoutes, {
    readJWT: async userId => ({ userId }),
    getSocket: id => f.network.sockets.get(id),
    getWallet: id => {
      lookups.push(id)
      return gating.walletOf(id)
    },
    getSettings: () => ({ customAvatars: true }),
    maxUploadSize: 1,
    assets: { exists: async () => false },
    limits: {
      checkRate: () => ({ ok: true }),
      previewUpload: identity => {
        identities.push(identity)
        return { ok: true }
      },
    },
  })
  await app.ready()
  for (const socket of [visitor, admin, builder]) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/upload-check?filename=${'a'.repeat(64)}.png`,
      headers: { authorization: `Bearer ${socket.id}` },
    })
    assert.equal(response.statusCode, 200, response.body)
  }
  assert.deepEqual(lookups, [builder.id, builder.id])
  assert.deepEqual(
    identities.map(({ userId, wallet, trusted }) => ({ userId, wallet, trusted })),
    [
      { userId: visitor.id, wallet: null, trusted: false },
      { userId: admin.id, wallet: null, trusted: true },
      { userId: builder.id, wallet: addressOf(keyB), trusted: true },
    ]
  )
})

test('wallet failures: rejecting services fail closed for verify, recheck and balance without clearing ownership', async t => {
  const f = fixture(t)
  const socket = await f.connect()
  f.network.tokenBalanceService.get = async () => {
    throw Error('RPC unavailable')
  }
  await f.verify(socket)
  assert.equal(socket.wallet.verified, address)
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  clear(socket)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(replies(socket, 'onChatAdded').length, 1)
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  await f.network.onTokenBalanceRequest(socket, { id: 0x7fffffff })
  assert.deepEqual(replies(socket, 'onTokenBalance'), [{ id: 0x7fffffff, verified: true, known: false, balance: 0 }])
  assert.equal(socket.wallet.pendingBalance, null)
  assert.equal(gating.walletOf(socket.id), null)
})

test('wallet balances: immediately resolved verified reads still obey the admission bucket', async t => {
  const f = fixture(t, { result: { known: true, balance: 5 } })
  const socket = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  clear(socket)
  for (let id = 1; id <= 20; id++) await f.network.onTokenBalanceRequest(socket, { id })
  assert.equal(f.calls.length, 3)
  assert.deepEqual(
    replies(socket, 'onTokenBalance'),
    [1, 2, 3].map(id => ({ id, verified: true, known: true, balance: 5 }))
  )
})

test('wallet persist race: overlapping administrative writes keep grants blocked until both settle', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('subject', Ranks.BUILDER)
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  const first = deferred(),
    second = deferred()
  f.write = () => first.promise
  const a = f.network.onModifyRank(admin, { playerId: socket.id, rank: Ranks.VISITOR })
  f.write = () => second.promise
  const b = f.network.onModifyRank(admin, { playerId: socket.id, rank: Ranks.VISITOR })
  assert.equal(socket.player.rankWritesPending, 2)
  second.resolve()
  await b
  assert.equal(socket.player.rankWritesPending, 1)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(f.calls.length, 0)
  first.resolve()
  await a
  assert.equal(socket.player.rankWritesPending, 0)
  f.advance(10000)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
})
