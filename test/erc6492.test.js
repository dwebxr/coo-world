import { test } from 'node:test'
import assert from 'node:assert/strict'
// this test runs without SES lockdown, so it may load viem's root entry and its actions
import {
  createPublicClient,
  custom,
  erc6492SignatureValidatorByteCode,
  hashMessage,
  keccak256,
  serializeErc6492Signature,
} from 'viem'
import { verifyHash } from 'viem/actions'
import { ERC6492_VALIDATOR_BYTECODE, erc6492CallData } from '../src/server/erc6492.js'

const SIGNER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const HASH = hashMessage('example sign-in message')
// a plain 65-byte signature, and one wrapped by EIP-6492: abi.encode(factory, factory calldata, inner signature)
// followed by the magic suffix
const PLAIN = `0x${'ab'.repeat(64)}1b`
const WRAPPED = serializeErc6492Signature({
  address: '0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a',
  data: `0x5fbfb9cf${'00'.repeat(64)}`,
  signature: `0x${'cd'.repeat(300)}`,
})

test('erc6492: the copied validator bytecode is viem 2.57.8 erc6492SignatureValidatorByteCode', () => {
  assert.equal(ERC6492_VALIDATOR_BYTECODE, erc6492SignatureValidatorByteCode)
  // pinned on its own too, so a changed viem cannot move both sides of the comparison at once
  assert.equal(
    keccak256(ERC6492_VALIDATOR_BYTECODE),
    '0x00f03afb646c45f698b5a1f540c482aebc9f5215003e4707d362a02526753936'
  )
})

test('erc6492: the call data is what viem verifyHash sends for the same signer, hash and signature', async () => {
  assert.ok(WRAPPED.endsWith('6492'.repeat(16)), 'a real EIP-6492 wrapper')
  for (const signature of [PLAIN, WRAPPED]) {
    const calls = []
    const client = createPublicClient({
      transport: custom({
        async request({ method, params }) {
          calls.push({ method, params })
          if (method === 'eth_call') return '0x01'
          throw new Error(`unexpected ${method}`)
        },
      }),
    })
    assert.equal(await verifyHash(client, { address: SIGNER, hash: HASH, signature }), true)
    const call = calls.find(c => c.method === 'eth_call')
    assert.ok(call, 'viem made an eth_call')
    assert.equal(call.params[0].to, undefined, 'deployless: no target')
    assert.equal(call.params[0].data, erc6492CallData(SIGNER, HASH, signature))
  }
})
