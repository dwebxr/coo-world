import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256, toHex } from 'viem'
import { createEvmHoldingService, holdingKey, normalizeHoldingSpec } from '../src/server/evmHoldings.js'
import { SELECTORS, encodeAddressWord, encodeUintWord } from '../src/core/extras/evmAbi.js'

const owner = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const other = '0x1563915e194D8CfBA1943570603F7606A3115508'
const contract = '0xAbCdEf0000000000000000000000000000001155'
const chains = new Map([[137, {}]])
const openpayId = keccak256(toHex('openpay:license:h_example'))

// An RPC whose eth_call answers from a table keyed by the 4-byte selector.
function fakeRpc(answers) {
  const calls = []
  return {
    calls,
    rpc: {
      chainId: 137,
      async call(method, params) {
        calls.push([method, params])
        assert.equal(method, 'eth_call')
        assert.equal(params[1], 'latest')
        const answer = answers[params[0].data.slice(0, 10)]
        if (answer instanceof Error) throw answer
        return typeof answer === 'function' ? answer(params[0]) : answer
      },
    },
  }
}
const service = answers => {
  const { rpc, calls } = fakeRpc(answers)
  return { calls, holdings: createEvmHoldingService({ rpcs: new Map([[137, rpc]]), ratePerSecond: 100, burst: 100 }) }
}

test('holding spec: normalised so equal specs share a cache entry', () => {
  const a = normalizeHoldingSpec({ chainId: 137, contract, standard: 'erc1155', tokenId: '0x01' }, chains)
  const b = normalizeHoldingSpec(
    { chainId: 137, contract: contract.toLowerCase(), standard: 'erc1155', tokenId: 1 },
    chains
  )
  assert.deepEqual(a, { chainId: 137, contract: contract.toLowerCase(), standard: 'erc1155', tokenId: '1' })
  assert.deepEqual(a, b)
  assert.equal(holdingKey(a, owner), holdingKey(b, owner.toLowerCase()))
  assert.equal(
    normalizeHoldingSpec({ chainId: 137, contract, standard: 'erc1155', tokenId: openpayId }, chains).tokenId,
    BigInt(openpayId).toString()
  )
  assert.equal(normalizeHoldingSpec({ chainId: 137, contract, standard: 'erc721' }, chains).tokenId, '')
  for (const bad of [
    null,
    'spec',
    { chainId: 1, contract, standard: 'erc721' },
    { chainId: '137', contract, standard: 'erc721' },
    { chainId: 137, contract: '0x1234', standard: 'erc721' },
    { chainId: 137, contract, standard: 'ERC721' },
    { chainId: 137, contract, standard: 'erc20' },
    { chainId: 137, contract, standard: 'erc1155' },
    { chainId: 137, contract, standard: 'erc1155', tokenId: '-1' },
    { chainId: 137, contract, standard: 'erc721', tokenId: 1.5 },
  ]) {
    assert.equal(normalizeHoldingSpec(bad, chains), null, JSON.stringify(bad))
  }
})

test('holdings: ERC-1155 balanceOf(owner, id), ERC-721 balanceOf(owner) and ownerOf(id)', async () => {
  const { holdings, calls } = service({
    [SELECTORS.balanceOf1155]: `0x${encodeUintWord(3n)}`,
    [SELECTORS.balanceOf]: `0x${encodeUintWord(2n)}`,
    [SELECTORS.ownerOf]: ({ data }) => `0x${encodeAddressWord(BigInt(`0x${data.slice(10)}`) === 7n ? owner : other)}`,
  })
  assert.deepEqual(await holdings.get(owner, { chainId: 137, contract, standard: 'erc1155', tokenId: openpayId }), {
    known: true,
    balance: 3,
  })
  assert.equal(
    calls[0][1][0].data,
    `${SELECTORS.balanceOf1155}${encodeAddressWord(owner)}${encodeUintWord(BigInt(openpayId))}`
  )
  assert.equal(calls[0][1][0].to, contract.toLowerCase())
  assert.deepEqual(await holdings.get(owner, { chainId: 137, contract, standard: 'erc721' }), {
    known: true,
    balance: 2,
  })
  assert.deepEqual(await holdings.get(owner, { chainId: 137, contract, standard: 'erc721', tokenId: 7 }), {
    known: true,
    balance: 1,
  })
  assert.deepEqual(await holdings.get(owner, { chainId: 137, contract, standard: 'erc721', tokenId: 8 }), {
    known: true,
    balance: 0,
  })
})

test('holdings: results are cached per normalised key and shared by concurrent callers', async () => {
  let reads = 0
  const { holdings } = service({
    [SELECTORS.balanceOf1155]: () => {
      reads++
      return `0x${encodeUintWord(1n)}`
    },
  })
  const spec = { chainId: 137, contract, standard: 'erc1155', tokenId: '1' }
  const [a, b] = await Promise.all([
    holdings.get(owner, spec),
    holdings.get(owner.toLowerCase(), { ...spec, tokenId: '0x1', contract: contract.toLowerCase() }),
  ])
  assert.deepEqual(a, { known: true, balance: 1 })
  assert.deepEqual(b, a)
  await holdings.get(owner, spec)
  assert.equal(reads, 1)
  await holdings.get(other, spec)
  assert.equal(reads, 2, 'another owner is another entry')
})

test('holdings: reverts, malformed words, unknown chains and bad specs fail closed as unknown', async () => {
  const { holdings, calls } = service({
    [SELECTORS.balanceOf1155]: new Error('execution reverted'),
    [SELECTORS.balanceOf]: '0x',
    [SELECTORS.ownerOf]: `0x${'1'.repeat(64)}`,
  })
  for (const spec of [
    { chainId: 137, contract, standard: 'erc1155', tokenId: '1' },
    { chainId: 137, contract, standard: 'erc721' },
    { chainId: 137, contract, standard: 'erc721', tokenId: '1' },
  ]) {
    assert.deepEqual(await holdings.get(owner, spec), { known: false }, JSON.stringify(spec))
  }
  const before = calls.length
  assert.deepEqual(await holdings.get(owner, { chainId: 1, contract, standard: 'erc721' }), { known: false })
  assert.deepEqual(await holdings.get(owner, null), { known: false })
  assert.deepEqual(await holdings.get('not-an-address', { chainId: 137, contract, standard: 'erc721' }), {
    known: false,
  })
  assert.equal(calls.length, before, 'no RPC for refused inputs')
})

test('holdings: the shared budget answers unknown instead of queueing', async () => {
  let reads = 0
  const { rpc } = fakeRpc({
    [SELECTORS.balanceOf]: () => {
      reads++
      return `0x${encodeUintWord(1n)}`
    },
  })
  const holdings = createEvmHoldingService({ rpcs: new Map([[137, rpc]]), ratePerSecond: 0, burst: 2 })
  const results = []
  for (let i = 0; i < 4; i++) {
    const owner = `0x${String(i).repeat(40)}`
    results.push(await holdings.get(owner, { chainId: 137, contract, standard: 'erc721' }))
  }
  assert.equal(reads, 2)
  assert.deepEqual(
    results.map(result => result.known),
    [true, true, false, false]
  )
  assert.equal(holdings.enabled, true)
  assert.equal(createEvmHoldingService({ rpcs: new Map() }).enabled, false)
})
