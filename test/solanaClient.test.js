import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientWorld, loadClient } from './lib/clientHarness.mjs'
import { strictDecode } from '../src/core/extras/strictDecode.js'
import { packetMethodById } from '../src/core/packets.js'

function setup(env = {}) {
  const world = clientWorld()
  const rpcCalls = { connection: 0, ata: 0, account: 0 }
  const provider = {
    publicKey: { toString: () => '1'.repeat(32) },
    async connect() {},
    async disconnect() {},
    async signMessage() {
      return { signature: new Uint8Array(64).fill(42) }
    },
  }
  const create = loadClient('client/solana-integration.js', 'createSolanaIntegration', {
    process: { env: { PUBLIC_TOKEN_MINT: '1'.repeat(32), ...env } },
    window: { solana: provider },
    Connection: class {
      constructor() {
        rpcCalls.connection++
        throw Error('client must not construct an RPC connection')
      }
    },
    getAssociatedTokenAddress: async () => {
      rpcCalls.ata++
      throw Error('client must not derive a balance account')
    },
    getAccount: async () => {
      rpcCalls.account++
      throw Error('client must not fetch a balance')
    },
    console: { log() {}, error() {} },
  })
  return {
    world,
    provider,
    rpcCalls,
    solana: create(world),
    nonce: value => world.listeners('solana:builderNonce')[0](value),
  }
}

const lastPacket = world => strictDecode(world.packets.at(-1), { maxNodes: 4096, build: true }).value[1]

test('Solana client: connect, bare-nonce signing, refresh and revoke work without any RPC reads', async () => {
  for (const env of [{}, { PUBLIC_RPC_URL: 'https://sentinel.invalid/?api-key=T1_SENTINEL' }]) {
    const { world, provider, solana, nonce, rpcCalls } = setup(env)
    const address = provider.publicKey.toString()
    const events = []
    const signed = []
    let connects = 0
    let disconnects = 0
    provider.connect = async () => connects++
    provider.disconnect = async () => disconnects++
    provider.signMessage = async (message, encoding) => {
      signed.push([new TextDecoder().decode(message), encoding])
      return { signature: new Uint8Array(64).fill(42) }
    }
    world.on('solana:connected', wallet => events.push(['connected', wallet]))
    world.on('solana:disconnected', () => events.push(['disconnected']))

    assert.equal(solana.getTokenBalance(), null)
    assert.equal('rpcUrl' in solana.getConfig(), false)
    assert.equal(await solana.connect(), address)
    assert.equal(solana.isConnected(), true)
    assert.equal(solana.getAddress(), address)
    await nonce('bare-nonce')
    assert.equal(solana.getTokenBalance(), null)
    await solana.refreshBalance()
    await nonce('refresh-nonce')
    assert.equal(solana.getTokenBalance(), null)
    assert.equal(await solana.disconnect(), true)
    assert.equal(solana.isConnected(), false)
    assert.equal(solana.getAddress(), null)
    assert.equal(solana.getTokenBalance(), null)
    await solana.refreshBalance()

    const signature = Buffer.alloc(64, 42).toString('base64')
    const packets = world.packets.map(packet => {
      const [id, data] = strictDecode(packet, { maxNodes: 4096, build: true }).value
      return [packetMethodById(id), data]
    })
    assert.deepEqual(packets, [
      ['onRequestBuilderNonce', { walletAddress: address }],
      ['onRequestBuilderByToken', { walletAddress: address, signature, nonce: 'bare-nonce' }],
      ['onRequestBuilderNonce', { walletAddress: address }],
      ['onRequestBuilderByToken', { walletAddress: address, signature, nonce: 'refresh-nonce' }],
      ['onRevokeBuilderByToken', {}],
    ])
    assert.deepEqual(signed, [
      ['bare-nonce', 'utf8'],
      ['refresh-nonce', 'utf8'],
    ])
    assert.deepEqual(events, [['connected', address], ['disconnected']])
    assert.equal(connects, 1)
    assert.equal(disconnects, 1)
    assert.deepEqual(world.toasts, [])
    assert.deepEqual(rpcCalls, { connection: 0, ata: 0, account: 0 })
  }
})

test('Solana client: validates bounded base58 addresses before connected events or sends', async () => {
  for (const address of ['0bad', '', '1'.repeat(65), {}, 'abc\n']) {
    const { world, provider, solana } = setup()
    provider.publicKey.toString = () => address
    let connected = 0
    world.on('solana:connected', () => connected++)
    assert.equal(await solana.connect(), null)
    assert.equal(connected, 0)
    assert.equal(solana.isConnected(), false)
    assert.equal(world.packets.length, 0)
    assert.equal(world.toasts.length, 1)
  }
})

test('Solana client: nonce and signature bounds precede signing/encoding; refusals reset pending', async () => {
  for (const invalid of [null, {}, '', 'x'.repeat(129)]) {
    const { world, provider, solana, nonce } = setup()
    let signed = 0
    provider.signMessage = async () => {
      signed++
      return new Uint8Array(64)
    }
    await solana.connect()
    await nonce(invalid)
    assert.equal(signed, 0)
    assert.equal(world.packets.length, 1)
    assert.equal(world.toasts.length, 1)
    await solana.refreshBalance()
    assert.equal(world.packets.length, 2, 'noncePending reset so a new request can be made')
  }
  for (const signature of [new Uint8Array(129), [], [256], [NaN], { length: 64 }, 'x'.repeat(64)]) {
    const { world, provider, solana, nonce } = setup()
    provider.signMessage = async () => ({ signature })
    await solana.connect()
    await nonce('nonce')
    assert.equal(world.packets.length, 1)
    assert.equal(world.toasts.length, 1)
    await solana.refreshBalance()
    assert.equal(world.packets.length, 2)
  }
})

test('Solana client: sends a bounded base64 signature; every send refusal and signing failure resets pending', async () => {
  const { world, provider, solana, nonce } = setup()
  await solana.connect()
  await nonce('n'.repeat(128))
  const data = lastPacket(world)
  assert.equal(data.walletAddress, solana.getAddress())
  assert.equal(data.nonce.length, 128)
  assert.equal(data.signature, Buffer.alloc(64, 42).toString('base64'))
  for (const refusedName of ['requestBuilderNonce', 'requestBuilderByToken']) {
    const send = world.network.send.bind(world.network)
    world.network.send = (name, value) => (name === refusedName ? false : send(name, value))
    const before = world.toasts.length
    await solana.refreshBalance()
    await nonce('nonce')
    assert.equal(world.toasts.length, before + 1)
    world.network.send = send
    const count = world.packets.length
    await solana.refreshBalance()
    assert.equal(world.packets.length, count + 1)
    await nonce('nonce')
  }
  provider.signMessage = async () => {
    throw Error('cancelled')
  }
  await solana.refreshBalance()
  const before = world.toasts.length
  await nonce('nonce')
  assert.equal(world.toasts.length, before + 1)
  const count = world.packets.length
  await solana.refreshBalance()
  assert.equal(world.packets.length, count + 1)
})

test('Solana client: an unanswered nonce request stops blocking refresh after the wait limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { world, solana, nonce } = setup()
  const nonceRequests = () =>
    world.packets.filter(
      packet =>
        packetMethodById(strictDecode(packet, { maxNodes: 4096, build: true }).value[0]) === 'onRequestBuilderNonce'
    ).length
  await solana.connect()
  assert.equal(nonceRequests(), 1)
  // the server's cooldown drops this request without a reply
  await solana.refreshBalance()
  assert.equal(nonceRequests(), 1)
  t.mock.timers.tick(14999)
  await solana.refreshBalance()
  assert.equal(nonceRequests(), 1)
  t.mock.timers.tick(1)
  await solana.refreshBalance()
  assert.equal(nonceRequests(), 2)
  // an answered request clears the wait, so a late timer cannot reopen a second request mid-signature
  await nonce('late-nonce')
  t.mock.timers.tick(15000)
  assert.equal(nonceRequests(), 2)
})
