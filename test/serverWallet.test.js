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

const enabled = {
  ...gating,
  TOKEN_GATING_ENABLED: true,
  REQUIRED_TOKEN_AMOUNT: 10000,
  WALLET_HOST: 'test.example',
  WALLET_URI: 'https://test.example',
}
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
// a turn of the event loop: what a statement that landed sets off (the next statement of that user) has started
const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, options = {}) {
  const { result = { known: true, balance: 0 } } = options
  // REQUIRED_TOKEN_AMOUNT as the network sees it; `required: undefined` is passed on as undefined
  const required = 'required' in options ? options.required : 10000
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
    context: {
      solanaGating: { ...enabled, REQUIRED_TOKEN_AMOUNT: required },
      process: { env: { ADMIN_CODE: 'code' } },
    },
  })
  f.network = network
  // the users' rows as the server means them to be (userRows.js), and whether a rank of that user is being written
  f.rows = () => network.userRows()
  f.unsettled = socket => network.userRows().unsettled(socket.id, 'rank')
  f.rank = (admin, socket, rank) => network.onModifyRank(admin, { playerId: socket.id, rank })
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  network.db = table => ({
    where: (column, id) => ({
      first: async () => users.get(id),
      update: async patch => {
        writes.push({ table, column, id, patch })
        await f.write(patch)
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
      items: entities,
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

test('wallet service: disabled gating ignores balance requests and constructs neither service nor RPC', async () => {
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
    if (!on) {
      // No socket access, admission mutation, reply or service call when gating is disabled.
      const socket = new Proxy({}, { get: () => assert.fail('disabled handler touched socket') })
      await production.onTokenBalanceRequest(socket, { id: 1 })
      await injected.onTokenBalanceRequest(socket, { id: 1 })
    }
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
      granted ? /Token verified/ : name === 'below' ? /requires .* tokens/ : /Could not check your balance/
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
      nonce: 'b'.repeat(64),
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
    // the handler does not wait for the write
    await (via === 'admin'
      ? f.network.onCommand(socket, { args: ['admin', 'code'] })
      : f.network.onModifyRank(admin, { playerId: socket.id, rank: Ranks.VISITOR }))
    assert.equal(f.unsettled(socket), 1)
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
    await f.rows().idle()
    assert.equal(f.unsettled(socket), 0)
    assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
    f.advance(5000)
    await f.network.onRequestBuilderRecheck(socket, {})
    assert.equal(socket.player.data.rank, Ranks.BUILDER)
    assert.equal(socket.player.rankRevision, 2)
    assert.equal(socket.player.data.tokenGrantedRank, true)
    assert.equal(gating.walletOf(socket.id), address)
  })
}

test('wallet persist race: a write that fails is no longer under way, and leaves the grant as it was', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect()
  await f.verify(socket)
  const admin = await f.connect('admin', Ranks.ADMIN)
  f.write = async () => {
    throw Error('SQLITE_BUSY')
  }
  f.rank(admin, socket, Ranks.VISITOR)
  assert.equal(f.unsettled(socket), 1, 'under way until it fails')
  await f.rows().idle()
  assert.equal(f.unsettled(socket), 0)
  assert.equal(socket.player.data.tokenGrantedRank, true)
  assert.equal(gating.walletOf(socket.id), address)
  assert.equal(f.rows().unstored(), 1, 'what the admin decided is kept')
  await f.network.onCommand(admin, { args: ['admin', 'code'] })
  await f.rows().idle()
  assert.equal(f.unsettled(admin), 0)
  // with nothing under way, the token gate grants again (the demotion of a token holder never held longer)
  f.advance(5000)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(socket.player.data.tokenGrantedRank, true)
  assert.equal(f.calls.length, 2)
})

test('wallet persist race: a reconnect while the old demotion is written waits for it like the session before', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const old = await f.connect()
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(old)
  const write = deferred()
  f.write = () => write.promise
  await f.rank(admin, old, Ranks.VISITOR)
  old.disconnect()
  assert.equal(old.closed, true)
  assert.equal(old.disconnected, true)
  assert.equal(gating.walletOf(old.id), null)
  const next = await f.connect(old.id)
  assert.equal(next.wallet.verified, null)
  assert.equal(next.wallet.challenge, null)
  assert.equal(next.wallet.generation, 0)
  assert.equal(next.player.data.rank, Ranks.VISITOR)
  // the write is the user's, not the old session's: the new session is not granted while it is under way
  assert.equal(f.unsettled(next), 1)
  const calls = f.calls.length
  await f.verify(next, 1, keyB)
  assert.equal(next.wallet.verified, addressOf(keyB))
  assert.equal(f.calls.length, calls, 'the chain is not asked')
  assert.equal(next.player.data.rank, Ranks.VISITOR)
  assert.equal(gating.walletOf(next.id), null)
  // it lands: the old session's completion is not this session's (nothing of the new one is touched), and the
  // refresh grants
  write.resolve()
  await f.rows().idle()
  assert.equal(f.unsettled(next), 0)
  f.advance(5000)
  await f.network.onRequestBuilderRecheck(next, {})
  assert.equal(next.player.data.rank, Ranks.BUILDER)
  assert.equal(next.player.data.tokenGrantedRank, true)
  assert.equal(gating.walletOf(next.id), addressOf(keyB))
})

test("wallet persist race: a write of the old session that lands after a reconnect leaves the new session's grant", async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const old = await f.connect()
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(old)
  // the demotion fails: nothing under way, the decision kept
  f.write = async () => {
    throw Error('SQLITE_BUSY')
  }
  await f.rank(admin, old, Ranks.VISITOR)
  await f.rows().idle()
  old.disconnect()
  const next = await f.connect(old.id)
  assert.equal(next.player.data.rank, Ranks.VISITOR)
  await f.verify(next, 1, keyB)
  assert.equal(next.player.data.rank, Ranks.BUILDER)
  assert.equal(gating.walletOf(next.id), addressOf(keyB))
  // the database is back, and the user's next change carries the rank that failed: visitor lands, for a player
  // that is gone. The new session is a builder by its token and stays marked so, with its wallet
  f.write = async () => {}
  await f.network.onCommand(next, { args: ['name', 'Ada'] })
  await f.rows().idle()
  assert.deepEqual(f.writes.at(-1).patch, { rank: Ranks.VISITOR, name: 'Ada' })
  assert.equal(f.users.get(next.id).rank, Ranks.VISITOR)
  assert.equal(next.player.data.rank, Ranks.BUILDER)
  assert.equal(next.player.data.tokenGrantedRank, true)
  assert.equal(gating.walletOf(next.id), addressOf(keyB))
})

test('wallet liveness: duplicate_user refuses a second live connection without clearing the first', async t => {
  const f = fixture(t)
  const socket = await f.connect('same', Ranks.ADMIN)
  await f.verify(socket)
  // a live browser answers the server's ping
  const ping = socket.ws.ping
  socket.ws.ping = (...args) => {
    ping(...args)
    queueMicrotask(() => socket.ws.emit('pong'))
  }
  const ws = fakeWs()
  await f.network.onConnection(ws, { authToken: 'same' })
  assert.deepEqual(ws.packets.map(readPacket), [['onKick', 'duplicate_user']])
  assert.equal(ws.readyState, 3)
  assert.equal(f.network.sockets.get('same'), socket)
  assert.equal(socket.wallet.verified, address)
})

test('wallet liveness: a silent old connection gives way, and the new one starts unverified', async t => {
  const f = fixture(t)
  f.network.takeoverPingMs = 20
  const socket = await f.connect('same', Ranks.ADMIN)
  await f.verify(socket)
  const ws = fakeWs()
  await f.network.onConnection(ws, { authToken: 'same' })
  assert.equal(readPacket(ws.packets[0])[0], 'onSnapshot')
  assert.equal(socket.disconnected, true)
  assert.equal(socket.ws.terminations, 1)
  const next = f.network.sockets.get('same')
  assert.ok(next && next !== socket)
  assert.equal(next.wallet.verified, null, 'a wallet is verified per connection')
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
  assert.match(socket.wallet.challenge.message, /\nURI: https:\/\/test.example\nVersion: 1\n/)
  clear(socket)
  for (const attempt of invalidIds) await f.network.onRequestBuilderByToken(socket, { ...proof, attempt })
  for (const nonce of [
    [],
    {},
    42,
    'a'.repeat(63),
    'a'.repeat(65),
    'a'.repeat(64) + '\n',
    'a'.repeat(64) + '\r',
    'g'.repeat(64),
    'A'.repeat(64),
    Buffer.alloc(32).toString('base64'),
  ]) {
    await f.network.onRequestBuilderByToken(socket, { ...proof, nonce })
  }
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
  for (const value of [address, addressOf(keyB), 'verified', 'wallet', 'rankRevision', 'challenge'])
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
  await f.rank(admin, socket, Ranks.VISITOR)
  f.write = () => second.promise
  await f.rank(admin, socket, Ranks.VISITOR)
  // one statement of a user at a time: the second decision goes out when the first has landed
  assert.equal(f.writes.length, 1)
  assert.equal(f.unsettled(socket), 1)
  first.resolve()
  await turn()
  assert.equal(f.writes.length, 2)
  assert.equal(f.unsettled(socket), 1)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(f.calls.length, 0)
  second.resolve()
  await f.rows().idle()
  assert.equal(f.unsettled(socket), 0)
  f.advance(10000)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
})

test('wallet compatibility: a pre-attempt client (protocol v2, release A) is ignored without replies', async t => {
  const f = fixture(t)
  const socket = await f.connect('visitor', Ranks.VISITOR)
  clear(socket)
  const generation = socket.wallet.generation
  // the release A client sends the nonce request and the bare-nonce proof without an attempt id
  f.network.onRequestBuilderNonce(socket, { walletAddress: address })
  await f.network.onRequestBuilderByToken(socket, {
    walletAddress: address,
    signature: Buffer.alloc(64, 42).toString('base64'),
    nonce: 'A'.repeat(44),
  })
  f.network.onRevokeBuilderByToken(socket, {})
  assert.deepEqual(packets(socket), [])
  assert.equal(socket.wallet.verified, null)
  assert.equal(socket.wallet.challenge, null)
  assert.equal(socket.wallet.generation, generation + 1)
  assert.equal(f.calls.length, 0)
})

for (const required of [null, 0, -1, NaN, Infinity, '10000', undefined]) {
  const label = `${String(required)} (${typeof required})`
  test(`wallet requirement: an amount of ${label} grants nothing and asks the chain nothing`, async t => {
    // a balance that any usable amount would accept; with an amount of 0 even a wallet without a token account
    // (a known balance of 0) used to be made a builder
    const f = fixture(t, { required, result: { known: true, balance: 1e12 } })
    const socket = await f.connect()
    clear(socket)
    await f.verify(socket)
    assert.equal(socket.wallet.verified, address, 'the wallet is still verified')
    assert.equal(socket.player.data.rank, Ranks.VISITOR)
    assert.ok(!socket.player.data.tokenGrantedRank)
    assert.equal(socket.player.rankRevision, 0)
    assert.equal(gating.walletOf(socket.id), null)
    assert.equal(f.calls.length, 0, 'no balance read')
    assert.deepEqual(replies(socket, 'onEntityModified'), [])
    assert.deepEqual(
      replies(socket, 'onChatAdded').map(chat => chat.body),
      ['Wallet verified. Builder access by token is not set up in this world.']
    )
    // the refresh button: silent, and still no read
    clear(socket)
    f.advance(10000)
    await f.network.onRequestBuilderRecheck(socket, {})
    assert.deepEqual(packets(socket), [])
    assert.equal(f.calls.length, 0)
    assert.equal(socket.player.data.rank, Ranks.VISITOR)
    // a script's balance question is not the grant and is still answered
    f.network.onTokenBalanceRequest(socket, { id: 1 })
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(replies(socket, 'onTokenBalance'), [{ id: 1, verified: true, known: true, balance: 1e12 }])
  })
}

test('wallet requirement: the smallest usable amounts still grant at exactly that balance', async t => {
  for (const [required, balance, granted] of [
    [0.5, 0.5, true],
    [0.5, 0.49, false],
    [1, 0, false],
    [Number.MIN_VALUE, 0, false],
  ]) {
    const f = fixture(t, { required, result: { known: true, balance } })
    const socket = await f.connect()
    await f.verify(socket)
    assert.equal(socket.player.data.rank, granted ? Ranks.BUILDER : Ranks.VISITOR, `${required} / ${balance}`)
    assert.equal(f.calls.length, 1)
    socket.disconnect()
    t.mock.timers.reset()
  }
})

test('wallet grant: a new sign-in ends it, a request the cooldown refuses does not', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect()
  const watcher = await f.connect('watcher')
  await f.verify(socket)
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(socket.player.data.tokenGrantedRank, true)
  assert.equal(gating.walletOf(socket.id), address)
  clear(socket)
  clear(watcher)
  // inside the cooldown: refused, and nothing is taken
  f.network.onRequestBuilderNonce(socket, { walletAddress: address, attempt: 2 })
  assert.deepEqual(packets(socket), [['onBuilderNonce', { attempt: 2, retryAfterMs: 5000 }]])
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(socket.wallet.verified, address)
  assert.equal(gating.walletOf(socket.id), address)
  // a malformed request: the same
  f.advance(5000)
  f.network.onRequestBuilderNonce(socket, { walletAddress: 'nope', attempt: 3 })
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(socket.wallet.verified, address)
  clear(socket)
  // an accepted one, here for another wallet: the verification is gone and the rank with it, before any signature
  f.network.onRequestBuilderNonce(socket, { walletAddress: addressOf(keyB), attempt: 4 })
  assert.equal(socket.wallet.verified, null)
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.equal(socket.player.data.tokenGrantedRank, false)
  assert.equal(socket.player.rankRevision, 2)
  assert.equal(gating.walletOf(socket.id), null)
  const sent = packets(socket)
  assert.deepEqual(
    sent.map(([name]) => name),
    ['onWalletStatus', 'onEntityModified', 'onChatAdded', 'onBuilderNonce']
  )
  assert.deepEqual(sent[0][1], { verified: false })
  assert.deepEqual(sent[1][1], { id: socket.player.data.id, rank: Ranks.VISITOR })
  assert.equal(sent[2][1].body, 'Signing in with a wallet again: builder access removed until the wallet is verified.')
  assert.deepEqual(replies(watcher, 'onEntityModified'), [{ id: socket.player.data.id, rank: Ranks.VISITOR }])
  assert.deepEqual(replies(watcher, 'onChatAdded'), [], 'only that player is told')
  // the signature for the new wallet is checked against the balance of the new wallet
  f.result = { known: true, balance: 0 }
  const calls = f.calls.length
  const challenge = socket.wallet.challenge
  await f.network.onRequestBuilderByToken(socket, {
    walletAddress: addressOf(keyB),
    attempt: 4,
    nonce: challenge.nonce,
    signature: Buffer.from(nacl.sign.detached(new TextEncoder().encode(challenge.message), keyB.secretKey)).toString(
      'base64'
    ),
  })
  assert.equal(socket.wallet.verified, addressOf(keyB))
  assert.equal(f.calls.length, calls + 1)
  assert.equal(f.calls.at(-1).wallet, addressOf(keyB))
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
})

test('wallet grant: a new sign-in leaves a stored rank alone', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('builder', Ranks.BUILDER)
  await f.verify(socket)
  clear(socket)
  f.advance(5000)
  f.challenge(socket, 2)
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(socket.player.rankRevision, 0)
  assert.deepEqual(replies(socket, 'onEntityModified'), [])
  assert.deepEqual(replies(socket, 'onChatAdded'), [])
})

test('wallet grant: a rank an admin stored is not taken by a new sign-in, also when two such writes overlap', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('subject')
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  assert.equal(socket.player.data.tokenGrantedRank, true)
  const first = deferred(),
    second = deferred()
  f.write = () => first.promise
  await f.rank(admin, socket, Ranks.BUILDER)
  f.write = () => second.promise
  await f.rank(admin, socket, Ranks.BUILDER)
  first.resolve()
  await turn()
  // the database holds builder now; the second write is under way
  assert.equal(f.users.get('subject').rank, Ranks.BUILDER)
  assert.equal(f.writes.length, 2)
  assert.equal(f.unsettled(socket), 1)
  assert.equal(socket.player.data.tokenGrantedRank, false)
  assert.equal(gating.walletOf(socket.id), null)
  f.advance(5000)
  clear(socket)
  f.challenge(socket, 2)
  assert.equal(socket.wallet.verified, null)
  assert.equal(socket.player.data.rank, Ranks.BUILDER, 'the stored rank stays')
  assert.deepEqual(replies(socket, 'onEntityModified'), [])
  second.resolve()
  await f.rows().idle()
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(f.users.get('subject').rank, Ranks.BUILDER)
  assert.equal(f.unsettled(socket), 0)
})

// The statements of a user's row, each held until the test says how it ends (the fixture's f.write)
const holdWrites = f => {
  const held = []
  f.write = patch => {
    const statement = { patch, ...deferred() }
    held.push(statement)
    return statement.promise
  }
  return held
}
const busy = () => Error('SQLITE_BUSY')

// C9-R1: a token-granted builder, and an admin's changes of its rank that overlap: A, then B (the other rank), then
// C (A's rank again), and the last write fails. Separate writes used to let A land while the session had C's rank
// (the grant mark and the wallet entry were cleared), B store the other rank and C fail: a session rank the database
// did not hold and that was no longer treated as a grant. Now one statement of a user is under way at a time
for (const [label, A, B] of [
  ['builder, visitor, builder', Ranks.BUILDER, Ranks.VISITOR],
  ['visitor, builder, visitor', Ranks.VISITOR, Ranks.BUILDER],
]) {
  test(`rank writes that overlap (${label}), the last one failing: the mark is cleared only for the rank the database holds`, async t => {
    const f = fixture(t, { result: { known: true, balance: 10000 } })
    const socket = await f.connect('subject')
    const admin = await f.connect('admin', Ranks.ADMIN)
    await f.verify(socket)
    assert.equal(socket.player.data.tokenGrantedRank, true)
    const held = holdWrites(f)
    await f.rank(admin, socket, A)
    await f.rank(admin, socket, B)
    await f.rank(admin, socket, A)
    assert.equal(held.length, 1, 'one statement under way: A')
    assert.equal(socket.player.data.rank, A)
    assert.equal(socket.player.data.tokenGrantedRank, true)
    assert.equal(gating.walletOf(socket.id), address)
    // A lands while the session has that rank again (C's): the database holds it, the grant is over
    held[0].resolve()
    await turn()
    assert.equal(f.users.get('subject').rank, A)
    assert.equal(socket.player.data.tokenGrantedRank, false)
    assert.equal(gating.walletOf(socket.id), null)
    // the next statement carries the last decision; B was never written, so the database never held the other rank
    assert.deepEqual(
      held.map(statement => statement.patch),
      [{ rank: A }, { rank: A }]
    )
    held[1].reject(busy())
    await f.rows().idle()
    assert.equal(held.length, 2)
    assert.equal(socket.player.data.rank, A)
    assert.equal(f.users.get('subject').rank, A, 'the session has the rank the database holds')
    assert.equal(socket.player.data.tokenGrantedRank, false)
    // a wallet disconnect and a new sign-in take nothing: it is a stored rank
    f.network.onRevokeBuilderByToken(socket, {})
    f.advance(5000)
    f.challenge(socket, 2)
    assert.equal(socket.player.data.rank, A)
    // and a reload gets it
    socket.disconnect()
    const next = await f.connect('subject')
    assert.equal(next.player.data.rank, A)
  })
}

test('rank writes that overlap, each with a statement of its own, the last one failing: a rank that is not stored stays marked', async t => {
  // The same three decisions, timed so that B is written by itself: A lands while the session has B's rank, B lands
  // while it has C's, C fails. No statement landed while the session had the rank it carried
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('subject')
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  const held = holdWrites(f)
  await f.rank(admin, socket, Ranks.BUILDER)
  await f.rank(admin, socket, Ranks.VISITOR)
  held[0].resolve()
  await turn()
  assert.equal(f.users.get('subject').rank, Ranks.BUILDER)
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.equal(socket.player.data.tokenGrantedRank, true, 'builder landed for a session that is a visitor: untouched')
  await f.rank(admin, socket, Ranks.BUILDER)
  held[1].resolve()
  await turn()
  assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
  assert.equal(socket.player.data.tokenGrantedRank, true, 'visitor landed for a session that is a builder: untouched')
  held[2].reject(busy())
  await f.rows().idle()
  assert.deepEqual(
    held.map(statement => statement.patch),
    [{ rank: Ranks.BUILDER }, { rank: Ranks.VISITOR }, { rank: Ranks.BUILDER }]
  )
  // the session is a builder (what the admin decided last), the database says visitor: not a stored rank, and still
  // marked and keyed to the wallet
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
  assert.equal(socket.player.data.tokenGrantedRank, true)
  assert.equal(gating.walletOf(socket.id), address)
  assert.equal(f.rows().unstored(), 1)
  // so a wallet disconnect takes it from the session
  f.network.onRevokeBuilderByToken(socket, {})
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.equal(gating.walletOf(socket.id), null)
  // What the admin decided is kept for as long as the server runs: a reload gets builder, and the user's next
  // change writes it
  socket.disconnect()
  const next = await f.connect('subject')
  assert.equal(next.player.data.rank, Ranks.BUILDER)
  assert.ok(!next.player.data.tokenGrantedRank)
  f.write = async () => {}
  await f.network.onCommand(next, { args: ['name', 'Ada'] })
  await f.rows().idle()
  assert.equal(f.users.get('subject').rank, Ranks.BUILDER)
  assert.equal(f.rows().unstored(), 0)
})

// C9-R2: a token-granted builder, A = builder and B = visitor overlap; A lands while the session is a visitor (the
// mark stays), B fails. The token gate then grants again, and the database holds builder: ending that grant used
// to take, until the next reload, a rank that a reload gave back
test('a promotion that lands and a demotion that fails: the session, a reload and the next write follow the demotion', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('subject')
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  const held = holdWrites(f)
  await f.rank(admin, socket, Ranks.BUILDER)
  await f.rank(admin, socket, Ranks.VISITOR)
  held[0].resolve()
  await turn()
  assert.equal(f.users.get('subject').rank, Ranks.BUILDER)
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.equal(socket.player.data.tokenGrantedRank, true)
  // not granted while the demotion is being written
  f.advance(5000)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  held[1].reject(busy())
  await f.rows().idle()
  assert.equal(f.unsettled(socket), 0)
  assert.deepEqual(f.rows().intended('subject'), { rank: Ranks.VISITOR }, 'the demotion is kept')
  // the token gate grants again: a builder by token, marked so
  f.advance(10000)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(socket.player.data.tokenGrantedRank, true)
  assert.equal(gating.walletOf(socket.id), address)
  // the wallet disconnects: a visitor, as the admin decided
  f.network.onRevokeBuilderByToken(socket, {})
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.equal(gating.walletOf(socket.id), null)
  // and a reload does not bring the builder rank back, though the database still holds it
  socket.disconnect()
  const next = await f.connect('subject')
  assert.equal(f.users.get('subject').rank, Ranks.BUILDER)
  assert.equal(next.player.data.rank, Ranks.VISITOR)
  // the user's next change writes the demotion
  f.write = async () => {}
  await f.network.onCommand(next, { args: ['name', 'Ada'] })
  await f.rows().idle()
  assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
  assert.equal(next.player.data.rank, Ranks.VISITOR)
})

test('a write that started before a rank was decided does not end the grant; the one that carries the rank does', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('subject')
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  const held = holdWrites(f)
  await f.network.onCommand(socket, { args: ['name', 'Ada'] })
  await f.rank(admin, socket, Ranks.BUILDER)
  assert.deepEqual(
    held.map(statement => statement.patch),
    [{ name: 'Ada' }]
  )
  held[0].resolve()
  await turn()
  assert.equal(f.users.get('subject').name, 'Ada')
  assert.equal(socket.player.data.tokenGrantedRank, true, 'the name landed; the rank is not stored yet')
  assert.equal(gating.walletOf(socket.id), address)
  assert.deepEqual(held[1].patch, { rank: Ranks.BUILDER })
  held[1].resolve()
  await f.rows().idle()
  assert.equal(socket.player.data.tokenGrantedRank, false)
  assert.equal(gating.walletOf(socket.id), null)
})

test('a column the database refuses does not keep a stored rank from ending the grant', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  f.network.world.settings.customAvatars = true
  const socket = await f.connect('subject')
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  // a column narrower than the avatar the server takes (as PostgreSQL's varchar(255) was for a 512-character url)
  f.write = async patch => {
    if (patch.avatar?.length > 16) throw Error('value too long for type character varying(16)')
  }
  await f.network.onEntityModified(socket, { id: socket.id, avatar: 'asset://' + 'a'.repeat(60) + '.vrm' })
  await f.rank(admin, socket, Ranks.BUILDER)
  await f.rows().idle()
  assert.equal(f.users.get('subject').rank, Ranks.BUILDER)
  assert.equal(f.users.get('subject').avatar, undefined)
  assert.equal(socket.player.data.tokenGrantedRank, false)
  assert.equal(gating.walletOf(socket.id), null)
  assert.equal(f.rows().unstored(), 1)
})

test('a decision that hears of a later statement is told the rank that statement stored, not its own', async t => {
  // builder and then visitor are decided while a name is being written; the next statement carries visitor, and
  // builder is decided again while it is under way. When it lands, the first decision (builder) hears of it: the
  // session has builder, and the database has just taken visitor
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('subject')
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  const held = holdWrites(f)
  await f.network.onCommand(socket, { args: ['name', 'Ada'] })
  await f.rank(admin, socket, Ranks.BUILDER)
  await f.rank(admin, socket, Ranks.VISITOR)
  held[0].resolve()
  await turn()
  assert.deepEqual(held[1].patch, { rank: Ranks.VISITOR })
  await f.rank(admin, socket, Ranks.BUILDER)
  held[1].resolve()
  await turn()
  assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(socket.player.data.tokenGrantedRank, true, 'the database does not hold builder: still a grant')
  assert.equal(gating.walletOf(socket.id), address)
  held[2].reject(busy())
  await f.rows().idle()
  f.network.onRevokeBuilderByToken(socket, {})
  assert.equal(socket.player.data.rank, Ranks.VISITOR, 'and a wallet disconnect takes it')
})

test('a rank write that starts while the chain is asked: no grant until it has ended', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('subject')
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  // a demotion that fails: nothing under way, the decision kept
  f.write = async () => {
    throw busy()
  }
  await f.rank(admin, socket, Ranks.VISITOR)
  await f.rows().idle()
  assert.equal(f.unsettled(socket), 0)
  // the refresh asks the chain; while it does, the player's change of name starts a statement that carries the rank
  const balance = deferred()
  f.result = balance.promise
  f.advance(10000)
  clear(socket)
  const refresh = f.network.onRequestBuilderRecheck(socket, {})
  const held = holdWrites(f)
  await f.network.onCommand(socket, { args: ['name', 'Ada'] })
  assert.deepEqual(held[0].patch, { rank: Ranks.VISITOR, name: 'Ada' })
  assert.equal(f.unsettled(socket), 1)
  balance.resolve({ known: true, balance: 10000 })
  await refresh
  assert.equal(socket.player.data.rank, Ranks.VISITOR, 'not granted while the rank is being written')
  assert.ok(replies(socket, 'onChatAdded').some(chat => /Could not check your balance/.test(chat.body)))
  held[0].resolve()
  await f.rows().idle()
  assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
  assert.equal(socket.player.data.tokenGrantedRank, false, 'visitor is stored: the old grant is over')
  f.result = { known: true, balance: 10000 }
  f.advance(10000)
  await f.network.onRequestBuilderRecheck(socket, {})
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(socket.player.data.tokenGrantedRank, true)
})
