import { test } from 'node:test'
import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import { PublicKey } from '@solana/web3.js'
import * as gating from '../src/server/solana-gating.js'

const key = nacl.sign.keyPair()
const address = new PublicKey(key.publicKey).toBase58()
const sign = message =>
  Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), key.secretKey)).toString('base64')

test('challenge: accepts only the stored host message and canonical address', () => {
  const challenge = gating.buildChallenge(address, 'world.example:443', 1000)
  assert.equal(challenge.expiresAt, 61000)
  assert.equal(Buffer.from(challenge.nonce, 'base64').length, 32)
  assert.equal(
    challenge.message,
    `world.example:443 wants you to verify your Solana wallet.\nWallet: ${address}\nNonce: ${challenge.nonce}`
  )
  assert.ok(Buffer.byteLength(challenge.message) <= 512)
  const data = { walletAddress: address, nonce: challenge.nonce, signature: sign(challenge.message) }
  assert.deepEqual(gating.checkChallenge(challenge, data, 1000), { ok: true, reason: 'ok' })
  for (const message of [challenge.nonce, challenge.message.replace('world.example', 'other.example')]) {
    assert.equal(gating.checkChallenge(challenge, { ...data, signature: sign(message) }, 1000).ok, false)
  }
  for (const patch of [
    { walletAddress: new PublicKey(nacl.sign.keyPair().publicKey).toBase58() },
    { walletAddress: '1' + address },
    { nonce: 'x'.repeat(44) },
    { signature: Buffer.alloc(63).toString('base64') },
    { signature: Buffer.alloc(65).toString('base64') },
  ])
    assert.equal(gating.checkChallenge(challenge, { ...data, ...patch }, 1000).ok, false)
  assert.equal(gating.checkChallenge(challenge, data, 61000).ok, false)
  assert.equal(gating.checkChallenge(null, data, 1000).ok, false)
  const longestHost = 'a'.repeat(253) + ':65535'
  assert.ok(Buffer.byteLength(gating.buildChallenge(address, longestHost, 0).message) <= 512)
})

test('challenge: host parsing falls back from invalid API to WS to coo-world', () => {
  assert.equal(
    gating.challengeHost({ PUBLIC_API_URL: 'https://api.example:8443/path', PUBLIC_WS_URL: 'wss://ws.example' }),
    'api.example:8443'
  )
  for (const invalid of ['not a URL', 'https://[::1]:8080', 'https://bad_host.example', 'https://' + 'x'.repeat(254)]) {
    assert.equal(
      gating.challengeHost({ PUBLIC_API_URL: invalid, PUBLIC_WS_URL: 'wss://ws.example:1234/path' }),
      'ws.example:1234'
    )
    assert.equal(gating.challengeHost({ PUBLIC_API_URL: invalid, PUBLIC_WS_URL: invalid }), 'coo-world')
  }
  assert.equal(gating.challengeHost({}), 'coo-world')
})

test('challenge: address, signature and request-id validators bound every representation', () => {
  assert.equal(gating.isWalletAddress(address), true)
  // Alternate spellings and invalid base58 encodings must not pass.
  for (const value of [null, {}, [], 1, '1'.repeat(31), '1'.repeat(33), '0'.repeat(32), 'a'.repeat(45)]) {
    assert.equal(gating.isWalletAddress(value), false)
  }
  const signature = sign('message')
  const bytes = Buffer.from(signature, 'base64')
  for (const value of [signature, bytes, new Uint8Array(bytes), [...bytes]]) {
    assert.deepEqual([...gating.signatureBytes(value)], [...bytes])
  }
  const sparse = Array(64)
  for (const value of [
    null,
    {},
    { ...bytes },
    sparse,
    new Uint8Array(63),
    new Uint8Array(65),
    Array(64).fill(-1),
    Array(64).fill(256),
    Array(64).fill(0.5),
    Array(64).fill('0'),
    signature.slice(0, 86),
    signature + '\n',
    'x'.repeat(10000),
  ]) {
    assert.equal(gating.signatureBytes(value), null)
  }
  for (const value of [1, 0x7fffffff]) assert.equal(gating.isWalletRequestId(value), true)
  for (const value of [0, -1, 0x80000000, 1.5, NaN, Infinity, '1', null, {}])
    assert.equal(gating.isWalletRequestId(value), false)
})

test('wallet bookkeeping: only the builder map is shared, and cleanup is per socket', () => {
  const a = gating.createWalletSession()
  const b = gating.createWalletSession()
  a.verified = address
  a.generation++
  assert.equal(b.verified, null)
  assert.equal(b.generation, 0)
  assert.notEqual(a.balanceBucket, b.balanceBucket)
  assert.equal(gating.walletOf('s1'), null)
  gating.recordWallet('s1', address)
  gating.recordWallet('s2', address)
  gating.clearWallet('s1')
  assert.equal(gating.walletOf('s1'), null)
  assert.equal(gating.walletOf('s2'), address)
  gating.clearSocket('s2')
  assert.equal(gating.walletOf('s2'), null)
})
