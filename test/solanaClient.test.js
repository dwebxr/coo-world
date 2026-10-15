import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientWorld, loadClient } from './lib/clientHarness.mjs'
import { strictDecode } from '../src/core/extras/strictDecode.js'

function setup() {
  const world = clientWorld()
  const provider = {
    publicKey: { toString: () => '1'.repeat(32) },
    async connect() {},
    async disconnect() {},
    async signMessage() {
      return { signature: new Uint8Array(64).fill(42) }
    },
  }
  const create = loadClient('client/solana-integration.js', 'createSolanaIntegration', {
    process: { env: { PUBLIC_TOKEN_MINT: '1'.repeat(32) } },
    window: { solana: provider },
    Connection: class {},
    PublicKey: class {},
    getAssociatedTokenAddress: async () => 'ata',
    getAccount: async () => ({ amount: 0n }),
    console: { log() {}, error() {} },
  })
  return { world, provider, solana: create(world), nonce: value => world.listeners('solana:builderNonce')[0](value) }
}

const lastPacket = world => strictDecode(world.packets.at(-1), { maxNodes: 4096, build: true }).value[1]

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
