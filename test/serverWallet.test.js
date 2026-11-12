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

function fixture(t, options = {}) {
  const { result = { known: true, balance: 0 } } = options
  // REQUIRED_TOKEN_AMOUNT as the network sees it; `required: undefined` is passed on as undefined
  const required = 'required' in options ? options.required : 10000
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const calls = []
  const users = new Map()
  const entities = new Map()
  const writes = []
  const f = { calls, users, entities, writes, result, write: async () => {}, logs: [] }
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
      // (a write of a user's row that fails is a plain line of the server's log)
      console: { ...console, error: line => f.logs.push(line) },
    },
  })
  f.network = network
  // the users' rows as the server means them to be (userRows.js)
  f.rows = () => network.userRows()
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

// A rank an admin or the admin code decides is the user's rank for this server from that moment, written or not
// (userRows.js): the token gate then decides on the balance alone, as for any visitor, whatever the write is doing
for (const via of ['modifyRank', 'admin']) {
  test(`decided rank: a demotion by ${via} whose write is under way does not keep a token from granting`, async t => {
    const f = fixture(t)
    const socket = await f.connect('subject', via === 'admin' ? Ranks.ADMIN : Ranks.BUILDER)
    const admin = await f.connect('moderator', Ranks.ADMIN)
    await f.verify(socket)
    assert.equal(f.calls.length, 0, 'a stored rank: the chain was not asked')
    const held = holdWrites(f)
    // the handler does not wait for the write
    await (via === 'admin'
      ? f.network.onCommand(socket, { args: ['admin', 'code'] })
      : f.rank(admin, socket, Ranks.VISITOR))
    assert.equal(held.length, 1)
    assert.equal(socket.player.data.rank, Ranks.VISITOR)
    assert.equal(socket.player.rankRevision, 1)
    assert.equal(socket.wallet.verified, address)
    clear(socket)
    f.result = { known: true, balance: 10000 }
    await f.network.onRequestBuilderRecheck(socket, {})
    assert.equal(f.calls.length, 1, 'the chain is asked')
    assert.equal(socket.player.data.rank, Ranks.BUILDER)
    assert.equal(socket.player.rankRevision, 2)
    assert.equal(socket.player.data.tokenGrantedRank, true)
    assert.equal(gating.walletOf(socket.id), address)
    assert.match(replies(socket, 'onChatAdded')[0].body, /Token verified/)
    // the write lands: nothing in the session changes
    held[0].resolve()
    await f.rows().idle()
    assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
    assert.equal(socket.player.data.rank, Ranks.BUILDER)
    assert.equal(socket.player.data.tokenGrantedRank, true)
    assert.equal(gating.walletOf(socket.id), address)
    // and the wallet's disconnect takes the grant
    f.network.onRevokeBuilderByToken(socket, {})
    assert.equal(socket.player.data.rank, Ranks.VISITOR)
    assert.equal(gating.walletOf(socket.id), null)
  })
}

test('decided rank: the admin code ends a token grant at once, and taking admin away leaves a visitor the token can grant', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('subject')
  await f.verify(socket)
  assert.equal(socket.player.data.tokenGrantedRank, true)
  const held = holdWrites(f)
  await f.network.onCommand(socket, { args: ['admin', 'code'] })
  assert.equal(socket.player.data.rank, Ranks.ADMIN)
  assert.equal(socket.player.data.tokenGrantedRank, false, 'before any write has landed')
  assert.equal(gating.walletOf(socket.id), null)
  assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
  f.network.onRevokeBuilderByToken(socket, {})
  assert.equal(socket.player.data.rank, Ranks.ADMIN, 'a wallet disconnect takes nothing')
  await f.network.onCommand(socket, { args: ['admin', 'code'] })
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  // (the first decision's statement, then the one that carries the second)
  held[0].resolve()
  await turn()
  held[1].resolve()
  await f.rows().idle()
  assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
  f.advance(5000)
  await f.verify(socket, 2)
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(socket.player.data.tokenGrantedRank, true)
})

test('decided rank: a reconnect while the old demotion is written is a visitor from memory, and its token grants at once', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const old = await f.connect()
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(old)
  const held = holdWrites(f)
  await f.rank(admin, old, Ranks.VISITOR)
  assert.equal(old.player.data.tokenGrantedRank, false)
  assert.equal(gating.walletOf(old.id), null)
  old.disconnect()
  assert.equal(old.closed, true)
  assert.equal(old.disconnected, true)
  const next = await f.connect(old.id)
  assert.equal(next.wallet.verified, null)
  assert.equal(next.wallet.challenge, null)
  assert.equal(next.wallet.generation, 0)
  assert.equal(next.player.data.rank, Ranks.VISITOR)
  // the old session's write is still under way: the new session is granted on its balance all the same
  const calls = f.calls.length
  await f.verify(next, 1, keyB)
  assert.equal(f.calls.length, calls + 1)
  assert.equal(next.player.data.rank, Ranks.BUILDER)
  assert.equal(next.player.data.tokenGrantedRank, true)
  assert.equal(gating.walletOf(next.id), addressOf(keyB))
  // it lands: nothing of the new session is touched
  held[0].resolve()
  await f.rows().idle()
  assert.equal(f.users.get(next.id).rank, Ranks.VISITOR)
  assert.equal(next.player.data.rank, Ranks.BUILDER)
  assert.equal(next.player.data.tokenGrantedRank, true)
  assert.equal(gating.walletOf(next.id), addressOf(keyB))
})

test('decided rank: a promotion of a token-granted builder whose write fails is a builder without a grant, from memory', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('subject')
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  assert.equal(gating.walletOf(socket.id), address)
  f.write = async () => {
    throw busy()
  }
  await f.rank(admin, socket, Ranks.BUILDER)
  await f.rows().idle()
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(socket.player.data.tokenGrantedRank, false)
  assert.equal(gating.walletOf(socket.id), null)
  assert.equal(f.users.get('subject').rank, Ranks.VISITOR, 'the database did not take it')
  assert.equal(f.rows().unstored(), 1)
  assert.equal(f.logs.filter(line => line.includes('rank of user "subject" not stored')).length, 1)
  // not a grant: neither a wallet disconnect nor a new sign-in takes it
  f.network.onRevokeBuilderByToken(socket, {})
  f.advance(5000)
  f.challenge(socket, 2)
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  // a reload is a builder too, from memory, for as long as this server runs
  socket.disconnect()
  const next = await f.connect('subject')
  assert.equal(next.player.data.rank, Ranks.BUILDER)
  assert.ok(!next.player.data.tokenGrantedRank)
  next.disconnect()
  // another process (a restart without a final save that landed) has what the database holds
  const restarted = makeNetwork(() => {}, {
    tokenBalanceService: f.network.tokenBalanceService,
    context: { solanaGating: enabled },
  })
  restarted.db = f.network.db
  restarted.spawn = f.network.spawn
  restarted.world = f.network.world
  restarted.onConnection = f.network.onConnection
  const ws = fakeWs()
  await restarted.onConnection(ws, { authToken: 'subject' })
  assert.equal(restarted.sockets.get('subject').player.data.rank, Ranks.VISITOR)
  restarted.sockets.get('subject').disconnect()
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

test('wallet grant: a rank an admin gave is not taken by a new sign-in, from the moment it is given', async t => {
  const f = fixture(t, { result: { known: true, balance: 10000 } })
  const socket = await f.connect('subject')
  const admin = await f.connect('admin', Ranks.ADMIN)
  await f.verify(socket)
  assert.equal(socket.player.data.tokenGrantedRank, true)
  const held = holdWrites(f)
  await f.rank(admin, socket, Ranks.BUILDER)
  // decided; the database has taken nothing yet
  assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
  assert.equal(socket.player.data.tokenGrantedRank, false)
  assert.equal(gating.walletOf(socket.id), null)
  f.advance(5000)
  clear(socket)
  f.challenge(socket, 2)
  assert.equal(socket.wallet.verified, null)
  assert.equal(socket.player.data.rank, Ranks.BUILDER, 'the rank stays')
  assert.deepEqual(replies(socket, 'onEntityModified'), [])
  // a second write of the same rank, overlapping the first
  await f.rank(admin, socket, Ranks.BUILDER)
  held[0].resolve()
  await turn()
  held[1].resolve()
  await f.rows().idle()
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
  assert.equal(f.users.get('subject').rank, Ranks.BUILDER)
})

// C9-R1 (the ledger): a token-granted builder and an admin's changes of its rank that overlap: A, then B (the other
// rank), then A again, and the last write fails. The grant used to end when a write landed while the session had
// the rank it wrote: A's landing cleared the mark under the third decision's rank, B stored the other rank, and
// the third write failed. Now each decision ends the grant when it is made, and the writes change nothing in the
// session
for (const [label, A, B] of [
  ['builder, visitor, builder', Ranks.BUILDER, Ranks.VISITOR],
  ['visitor, builder, visitor', Ranks.VISITOR, Ranks.BUILDER],
]) {
  test(`decided ranks that overlap (${label}), the last write failing: no grant from the first decision on`, async t => {
    const f = fixture(t, { result: { known: true, balance: 10000 } })
    const socket = await f.connect('subject')
    const admin = await f.connect('admin', Ranks.ADMIN)
    await f.verify(socket)
    assert.equal(socket.player.data.tokenGrantedRank, true)
    assert.equal(gating.walletOf(socket.id), address)
    const held = holdWrites(f)
    for (const rank of [A, B, A]) {
      await f.rank(admin, socket, rank)
      assert.equal(socket.player.data.rank, rank)
      assert.equal(socket.player.data.tokenGrantedRank, false)
      assert.equal(gating.walletOf(socket.id), null)
      // a wallet disconnect takes nothing
      f.network.onRevokeBuilderByToken(socket, {})
      assert.equal(socket.player.data.rank, rank)
    }
    assert.equal(held.length, 1, 'one statement under way: the first decision')
    held[0].resolve()
    await turn()
    assert.equal(f.users.get('subject').rank, A)
    // the next statement carries the last decision; the one in between is never written
    assert.deepEqual(
      held.map(statement => statement.patch),
      [{ rank: A }, { rank: A }]
    )
    held[1].reject(busy())
    await f.rows().idle()
    assert.equal(socket.player.data.rank, A)
    assert.equal(socket.player.data.tokenGrantedRank, false)
    // neither a wallet disconnect nor a new sign-in takes anything
    f.network.onRevokeBuilderByToken(socket, {})
    f.advance(5000)
    f.challenge(socket, 2)
    assert.equal(socket.player.data.rank, A)
    // and a reload gets the decided rank
    socket.disconnect()
    const next = await f.connect('subject')
    assert.equal(next.player.data.rank, A)
    assert.ok(!next.player.data.tokenGrantedRank)
  })
}

// C9-R2 (the ledger): a token-granted builder, builder and then visitor decided; builder lands, and the visitor's
// write is still under way or fails. The session is a visitor without a grant from the second decision on; a token
// then grants builder again, marked, and a wallet disconnect takes that grant and nothing else
for (const fate of ['under way', 'failed']) {
  test(`a promotion that lands and a demotion whose write is ${fate}: a visitor, whom a token grants and a disconnect ungrants`, async t => {
    const f = fixture(t, { result: { known: true, balance: 10000 } })
    const socket = await f.connect('subject')
    const admin = await f.connect('admin', Ranks.ADMIN)
    await f.verify(socket)
    const held = holdWrites(f)
    await f.rank(admin, socket, Ranks.BUILDER)
    await f.rank(admin, socket, Ranks.VISITOR)
    assert.equal(socket.player.data.rank, Ranks.VISITOR)
    assert.equal(socket.player.data.tokenGrantedRank, false)
    assert.equal(gating.walletOf(socket.id), null)
    held[0].resolve()
    await turn()
    assert.equal(f.users.get('subject').rank, Ranks.BUILDER, 'the promotion landed')
    assert.deepEqual(held[1].patch, { rank: Ranks.VISITOR })
    if (fate === 'failed') {
      held[1].reject(busy())
      await f.rows().idle()
    }
    assert.equal(socket.player.data.rank, Ranks.VISITOR)
    assert.equal(socket.player.data.tokenGrantedRank, false)
    // a new verification with enough balance: a builder by token, marked so
    f.advance(5000)
    const calls = f.calls.length
    await f.verify(socket, 2)
    assert.equal(f.calls.length, calls + 1)
    assert.equal(socket.player.data.rank, Ranks.BUILDER)
    assert.equal(socket.player.data.tokenGrantedRank, true)
    assert.equal(gating.walletOf(socket.id), address)
    // the wallet disconnects: the grant goes, and the session is the visitor the admin decided
    f.network.onRevokeBuilderByToken(socket, {})
    assert.equal(socket.player.data.rank, Ranks.VISITOR)
    assert.equal(socket.player.data.tokenGrantedRank, false)
    assert.equal(gating.walletOf(socket.id), null)
    // a reload is a visitor too, though the database still holds builder
    assert.equal(f.users.get('subject').rank, Ranks.BUILDER)
    socket.disconnect()
    const next = await f.connect('subject')
    assert.equal(next.player.data.rank, Ranks.VISITOR)
    // and the demotion reaches the database: when its statement lands, or with the user's next change
    if (fate === 'under way') held[1].resolve()
    f.write = async () => {}
    await f.network.onCommand(next, { args: ['name', 'Ada'] })
    await f.rows().idle()
    assert.equal(f.users.get('subject').rank, Ranks.VISITOR)
    assert.equal(next.player.data.rank, Ranks.VISITOR)
  })
}
