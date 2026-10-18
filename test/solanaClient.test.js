import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PublicKey } from '@solana/web3.js'
import { Ranks } from '../src/core/extras/ranks.js'
import { clientWorld, loadClient } from './lib/clientHarness.mjs'
import { strictDecode } from '../src/core/extras/strictDecode.js'
import { packetMethodById } from '../src/core/packets.js'

const address = '1'.repeat(32)
const nonce = Buffer.alloc(32, 42).toString('hex')
const message = `world.example wants you to sign in with your Solana account:\n${address}\n\nVerify wallet ownership for this world. This does not authorize any transaction.\n\nURI: https://world.example\nVersion: 1\nNonce: ${nonce}\nIssued At: 2026-10-18T00:00:00.000Z\nExpiration Time: 2026-10-18T00:01:00.000Z`
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
const deferred = () => {
  let resolve
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}
const packets = world =>
  world.packets.map(packet => {
    const [id, data] = strictDecode(packet, { maxNodes: 4096, build: true }).value
    return [packetMethodById(id), data]
  })
const requests = (world, name) => packets(world).filter(([method]) => method === `on${name}`)

function setup(t, env = {}) {
  const world = clientWorld()
  world.events = new EventEmitter()
  world.entities.player = { data: { id: 'player', rank: Ranks.VISITOR }, isBuilder: () => true }
  world.chat = { add() {} }
  const provider = new EventEmitter()
  provider.publicKey = { toString: () => address }
  provider.connect = async () => {}
  provider.disconnect = async () => {}
  const signed = []
  provider.signMessage = async (bytes, encoding) => {
    signed.push([new TextDecoder().decode(bytes), encoding])
    return { signature: new Uint8Array(64).fill(42) }
  }
  const rpcCalls = []
  const create = loadClient('client/solana-integration.js', 'createSolanaIntegration', {
    process: { env: { PUBLIC_TOKEN_MINT: address, ...env } },
    window: { solana: provider },
    PublicKey,
    Ranks,
    Connection: class {
      constructor() {
        rpcCalls.push('connection')
      }
    },
    getAssociatedTokenAddress: () => rpcCalls.push('ata'),
    getAccount: () => rpcCalls.push('account'),
  })
  const solana = create(world)
  t.after(() => {
    world.network.ws = null
    world.network.destroy()
  })
  const events = []
  world.events.on('wallet', value => events.push(value))
  const start = async () => {
    const promise = solana.connect()
    await flush()
    return { promise, attempt: requests(world, 'RequestBuilderNonce').at(-1)?.[1].attempt }
  }
  const challenge = (attempt, data = {}) => world.network.onBuilderNonce({ attempt, nonce, message, ...data })
  const status = (attempt, verified = true) => world.network.onWalletStatus({ attempt, verified, wallet: address })
  const verify = async () => {
    const run = await start()
    challenge(run.attempt)
    await flush()
    status(run.attempt)
    assert.equal(await run.promise, address)
    return run
  }
  return { world, provider, solana, events, start, challenge, status, verify, signed, rpcCalls }
}

test('client: no RPC; exact message; signature-free refresh', async t => {
  const h = setup(t, { PUBLIC_RPC_URL: 'https://sentinel.invalid/?api-key=unused' })
  const { world, solana, signed } = h
  await h.verify()
  assert.deepEqual(signed, [[message, 'utf8']])
  assert.deepEqual(requests(world, 'RequestBuilderByToken')[0][1], {
    walletAddress: address,
    signature: Buffer.alloc(64, 42).toString('base64'),
    nonce,
    attempt: 1,
  })
  assert.equal('rpcUrl' in solana.getConfig(), false)
  assert.deepEqual(h.rpcCalls, [])
  const source = fs.readFileSync(new URL('../src/client/solana-integration.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /import\s+[^\n]*(Connection|getAccount|getAssociatedTokenAddress)|new Connection|rpcUrl/)
  const id = requests(world, 'TokenBalanceRequest')[0][1].id
  world.network.onTokenBalance({ id, verified: true, known: true, balance: 12000 })
  assert.equal(solana.getState().balance, 12000)
  const refresh = solana.refreshBalance()
  assert.equal(requests(world, 'RequestBuilderRecheck').length, 1, 'open-build raw visitor still rechecks')
  world.network.onTokenBalance({ id: id + 1, verified: true, known: true, balance: 12000 })
  await refresh
  world.entities.player.data.rank = Ranks.BUILDER
  const builderRefresh = solana.refreshBalance()
  assert.equal(requests(world, 'RequestBuilderRecheck').length, 1)
  solana.disconnect()
  await builderRefresh
  await solana.refreshBalance()
  assert.equal(requests(world, 'RequestBuilderNonce').length, 1)
  assert.equal(signed.length, 1)
})

test('client: status gate and ack deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = setup(t)
  const run = await h.start()
  h.challenge(run.attempt)
  await flush()
  h.status(run.attempt + 1)
  h.world.network.onWalletStatus({ verified: true, wallet: address })
  assert.equal(h.solana.isVerified(), false)
  assert.equal(h.events.length, 0)
  t.mock.timers.tick(14999)
  assert.equal(h.solana.getState().status, 'signing')
  t.mock.timers.tick(1)
  assert.equal(await run.promise, null)
  assert.equal(h.solana.getState().status, 'unverified')
  h.status(run.attempt)
  assert.equal(h.events.length, 0)
  const accepted = await h.verify()
  const id = requests(h.world, 'TokenBalanceRequest').at(-1)[1].id
  h.world.network.onTokenBalance({ id, verified: true, known: true, balance: 99 })
  h.status(accepted.attempt - 1, false)
  assert.equal(h.solana.getState().balance, 99, 'discarded status leaves cache intact')
  h.world.network.onWalletStatus({ verified: false })
  assert.deepEqual(h.events, [
    { playerId: 'player', verified: true },
    { playerId: 'player', verified: false },
  ])
  assert.ok(h.events.every(Object.isFrozen))
  assert.equal(h.solana.getState().known, false)
  const failed = await h.start()
  h.challenge(failed.attempt)
  await flush()
  h.status(failed.attempt, false)
  assert.equal(await failed.promise, null)
  assert.equal(h.solana.getState().status, 'unverified')
})

test('client: obsolete replies across same-address reconnect', async t => {
  const h = setup(t)
  const a = await h.start()
  h.solana.disconnect()
  assert.equal(await a.promise, null)
  const b = await h.start()
  assert.notEqual(a.attempt, b.attempt)
  const before = h.solana.getState()
  h.challenge(a.attempt, { nonce: Buffer.alloc(32, 1).toString('hex') })
  h.status(a.attempt)
  await flush()
  assert.deepEqual(h.solana.getState(), before)
  assert.equal(h.events.length, 0)
  assert.equal(h.signed.length, 0)
  h.challenge(b.attempt)
  await flush()
  h.status(b.attempt)
  assert.equal(await b.promise, address)
  assert.deepEqual(h.signed, [[message, 'utf8']])
})

test('client: refused or throwing sends fail attempts', async t => {
  for (const name of ['requestBuilderNonce', 'requestBuilderByToken']) {
    for (const throwing of [false, true]) {
      const h = setup(t)
      const send = h.world.network.send.bind(h.world.network)
      h.world.network.send = (method, data) => {
        if (method === name) {
          if (throwing) throw Error('refused')
          return false
        }
        return send(method, data)
      }
      const run = await h.start()
      if (name === 'requestBuilderByToken') h.challenge(run.attempt)
      assert.equal(await run.promise, null)
      assert.equal(h.solana.getState().status, 'unverified')
      assert.equal(h.world.listenerCount('solana:builderNonce'), 0)
      assert.equal(h.world.toasts.length, 1)
    }
  }
})

test('client: late connect and signature are cancelled by generation', async t => {
  const h = setup(t)
  const connection = deferred()
  h.provider.connect = () => connection.promise
  const pending = h.solana.connect()
  h.solana.disconnect()
  connection.resolve()
  assert.equal(await pending, null)
  assert.equal(requests(h.world, 'RequestBuilderNonce').length, 0)
  h.provider.connect = async () => {}
  const signature = deferred()
  h.provider.signMessage = () => signature.promise
  const run = await h.start()
  h.challenge(run.attempt)
  await flush()
  h.solana.disconnect()
  signature.resolve(new Uint8Array(64))
  assert.equal(await run.promise, null)
  assert.equal(requests(h.world, 'RequestBuilderByToken').length, 0)
  assert.equal(h.solana.getState().status, 'disconnected')
})

for (const mode of ['throws', 'never settles']) {
  test(`client: provider disconnect ${mode}`, async t => {
    const h = setup(t)
    await h.verify()
    const pending = h.solana.getTokenBalance()
    h.provider.disconnect = () => {
      if (mode === 'throws') throw Error('wallet')
      return new Promise(() => {})
    }
    assert.equal(h.solana.disconnect(), true)
    assert.equal(h.solana.isVerified(), false)
    assert.equal(h.solana.isConnected(), false)
    assert.equal(requests(h.world, 'RevokeBuilderByToken').length, 1)
    assert.deepEqual(await pending, { verified: false, known: false, balance: 0 })
    assert.equal(h.provider.listenerCount('accountChanged'), 0)
  })
}

test('client: nonce deadline, one cooldown retry, no prompt timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = setup(t)
  const a = await h.start()
  h.challenge(a.attempt, { retryAfterMs: 5000 })
  t.mock.timers.tick(4999)
  assert.equal(requests(h.world, 'RequestBuilderNonce').length, 1)
  t.mock.timers.tick(1)
  assert.deepEqual(requests(h.world, 'RequestBuilderNonce')[0], requests(h.world, 'RequestBuilderNonce')[1])
  t.mock.timers.tick(10000)
  assert.equal(await a.promise, null)
  assert.equal(h.world.listenerCount('solana:builderNonce'), 0)
  const b = await h.start()
  h.challenge(b.attempt, { retryAfterMs: 1 })
  t.mock.timers.tick(1)
  h.challenge(b.attempt, { retryAfterMs: 1 })
  assert.equal(await b.promise, null)
  const signature = deferred()
  h.provider.signMessage = () => signature.promise
  const c = await h.start()
  h.challenge(c.attempt)
  await flush()
  t.mock.timers.tick(300000)
  assert.equal(h.solana.getState().status, 'signing')
  signature.resolve(new Uint8Array(64))
  await flush()
  h.status(c.attempt)
  assert.equal(await c.promise, address)
})

test('client: accountChanged revokes without signing', async t => {
  const h = setup(t)
  await h.verify()
  h.provider.emit('accountChanged', { toString: () => address })
  assert.equal(h.solana.getState().status, 'disconnected')
  assert.equal(requests(h.world, 'RevokeBuilderByToken').length, 1)
  assert.equal(h.signed.length, 1)
  assert.match(h.world.toasts.at(-1), /再接続/)
})

for (const mode of ['close', 'destroy', 'fatal', 'fatal close']) {
  test(`client: ${mode} disposal`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    for (const phase of ['balance', 'nonce', 'ack']) {
      const h = setup(t)
      let run
      let pending
      if (phase === 'balance') {
        await h.verify()
        pending = h.solana.getTokenBalance()
      } else {
        run = await h.start()
        if (phase === 'ack') {
          h.challenge(run.attempt)
          await flush()
        }
      }
      if (mode.startsWith('fatal')) h.world.fatalError = 'fatal'
      if (mode === 'fatal') h.world.emit('fatal')
      else if (mode === 'destroy') {
        h.world.network.ws = null
        h.world.network.destroy()
      } else h.world.network.onClose(1006)
      if (pending) assert.deepEqual(await pending, { verified: false, known: false, balance: 0 })
      if (run) assert.equal(await run.promise, null)
      assert.equal(h.solana.isVerified(), false)
      assert.equal(h.provider.listenerCount('accountChanged'), 0)
      assert.equal(h.world.listenerCount('solana:builderNonce'), 0)
      assert.equal(h.world.listenerCount('solana:walletStatus'), 0)
      const count = h.world.packets.length
      h.status(run?.attempt ?? 1)
      h.challenge(run?.attempt ?? 1)
      t.mock.timers.tick(30000)
      assert.equal(h.world.packets.length, count)
      assert.equal(await h.solana.connect(), null)
      assert.equal(h.events.length, phase === 'balance' ? 1 : 0)
    }
  })
}

test('client: server invalidation preserves the new attempt', async t => {
  const h = setup(t)
  await h.verify()
  const run = await h.start()
  h.world.network.onWalletStatus({ verified: false })
  assert.equal(h.solana.isVerified(), false)
  assert.equal(h.solana.getState().status, 'signing')
  h.challenge(run.attempt)
  await flush()
  h.status(run.attempt)
  assert.equal(await run.promise, address)
  assert.deepEqual(
    h.events.map(event => event.verified),
    [true, false, true]
  )
  const next = await h.start()
  h.challenge(next.attempt)
  await flush()
  h.status(next.attempt)
  h.world.network.onWalletStatus({ verified: false })
  assert.equal(await next.promise, null)
  assert.equal(h.solana.getState().status, 'unverified')
})

test('client: hex nonce and 1024-byte bounds; signing rejection', async t => {
  for (const badAddress of ['', '0bad', '1'.repeat(33), '1'.repeat(45)]) {
    const h = setup(t)
    h.provider.publicKey.toString = () => badAddress
    assert.equal(await h.solana.connect(), null)
    assert.equal(h.solana.isConnected(), false)
    assert.equal(h.world.packets.length, 0)
  }
  for (const bad of [
    ...[
      null,
      [],
      42,
      'short',
      'a'.repeat(63),
      'a'.repeat(65),
      'a'.repeat(64) + '\n',
      'a'.repeat(64) + '\r',
      'g'.repeat(64),
      'A'.repeat(64),
      Buffer.alloc(32).toString('base64'),
    ].map(nonce => ({ nonce })),
    { message: 'あ'.repeat(342) },
    { message: 'a'.repeat(1025) },
    { message: '' },
  ]) {
    const h = setup(t)
    const run = await h.start()
    h.challenge(run.attempt, bad)
    assert.equal(await run.promise, null)
    assert.equal(h.signed.length, 0)
  }
  for (const message of ['a'.repeat(1024), 'あ'.repeat(341) + 'a']) {
    const h = setup(t)
    const run = await h.start()
    h.challenge(run.attempt, { message })
    await flush()
    assert.deepEqual(h.signed, [[message, 'utf8']])
    h.status(run.attempt)
    assert.equal(await run.promise, address)
  }
  for (const signature of [new Uint8Array(63), new Uint8Array(65), new Array(64), Array(64).fill(256), 'bad', null]) {
    const h = setup(t)
    h.provider.signMessage = async () => {
      if (signature === null) throw Error('cancelled')
      return signature
    }
    const run = await h.start()
    h.challenge(run.attempt)
    assert.equal(await run.promise, null)
    assert.equal(requests(h.world, 'RequestBuilderByToken').length, 0)
  }
})
