import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256, toHex } from 'viem'
import fs from 'node:fs'
import {
  DEFAULT_HOLDING_CONTRACTS,
  createEvmHoldingService,
  describeHoldingContracts,
  holdingKey,
  normalizeHoldingSpec,
  readHoldingContractsEnv,
} from '../src/server/evmHoldings.js'
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
// the operator's list in these tests: `contract` on chain 137, written in another case than the specs use
const listed = [{ chainId: 137, contract: contract.toUpperCase().replace('0X', '0x') }]
const service = (answers, { contracts = listed, chains = [137] } = {}) => {
  const { rpc, calls } = fakeRpc(answers)
  const lines = []
  const holdings = createEvmHoldingService({
    rpcs: new Map(chains.map(chainId => [chainId, rpc])),
    contracts,
    ratePerSecond: 100,
    burst: 100,
    log: { warn: line => lines.push(line) },
  })
  return { calls, lines, holdings }
}
// N1: a contract whose balanceOf(owner, id) answers 40 bits of the owner's address, the bits 40·id and up
const addressBits = ({ data }) => {
  const owner = BigInt(`0x${data.slice(34, 74)}`)
  const id = BigInt(`0x${data.slice(74)}`)
  return `0x${encodeUintWord((owner >> (40n * id)) & ((1n << 40n) - 1n))}`
}
const fromBits = balances =>
  `0x${balances
    .reduce((sum, balance, id) => sum + (BigInt(balance) << (40n * BigInt(id))), 0n)
    .toString(16)
    .padStart(40, '0')}`

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
  const holdings = createEvmHoldingService({
    rpcs: new Map([[137, rpc]]),
    contracts: listed,
    ratePerSecond: 0,
    burst: 2,
  })
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

// --- EVM_HOLDING_CONTRACTS: the contracts a read may be made against ---

const OPENPAY = '0x1c652241cc820ce897f0d8d9351df9ad8a0916cc'
const A = `0x${'aB'.repeat(20)}`
const B = `0x${'Cd'.repeat(20)}`
const read = value => readHoldingContractsEnv({ EVM_HOLDING_CONTRACTS: value })

test('holding contracts: not set, the list is the OpenPay license contract on Polygon, as the shipped door names it', () => {
  assert.deepEqual(readHoldingContractsEnv({}), [{ chainId: 137, contract: OPENPAY }])
  assert.equal(readHoldingContractsEnv({}), DEFAULT_HOLDING_CONTRACTS)
  assert.equal(describeHoldingContracts(DEFAULT_HOLDING_CONTRACTS), `137:${OPENPAY}`)
  // the address is the one in the repository: the door example's preset, and the docs
  const door = fs.readFileSync(new URL('../docs/scripting/examples/nft-door.js', import.meta.url), 'utf8')
  const preset = door.match(/^const OPENPAY_LICENSE_CONTRACT = '(0x[0-9a-fA-F]{40})'$/m)[1]
  assert.equal(preset.toLowerCase(), OPENPAY)
  assert.match(door, /\{ key: 'chainId', type: 'number', label: 'Chain ID', initial: 137 \}/)
  for (const file of ['../docs/scripting/world/Player.md', '../README.md', '../.env.example']) {
    assert.ok(fs.readFileSync(new URL(file, import.meta.url), 'utf8').includes(`137:${preset}`), file)
  }
  // nobody can add to the default by reaching the array
  assert.ok(Object.isFrozen(DEFAULT_HOLDING_CONTRACTS) && Object.isFrozen(DEFAULT_HOLDING_CONTRACTS[0]))
})

test('holding contracts: a list is read whole; case, spaces and repeats do not matter; set replaces the default', () => {
  assert.deepEqual(read(`137:${A}`), [{ chainId: 137, contract: A.toLowerCase() }])
  assert.deepEqual(read(` 137:${A} , 1:${B},8453:${A}\n`), [
    { chainId: 137, contract: A.toLowerCase() },
    { chainId: 1, contract: B.toLowerCase() },
    { chainId: 8453, contract: A.toLowerCase() },
  ])
  // the same contract written twice, also in another case, is one entry; the same address on another chain is not
  assert.deepEqual(read(`137:${A},137:${A.toLowerCase()},137:${A.toUpperCase().replace('0X', '0x')},1:${A}`), [
    { chainId: 137, contract: A.toLowerCase() },
    { chainId: 1, contract: A.toLowerCase() },
  ])
  // set: the default is not added
  assert.ok(!read(`137:${A}`).some(entry => entry.contract === OPENPAY))
  // set and empty: no contract (not the default)
  for (const empty of ['', ' ', '\t\n']) assert.deepEqual(read(empty), [], JSON.stringify(empty))
  assert.ok(Object.isFrozen(read(`137:${A}`)) && Object.isFrozen(read(`137:${A}`)[0]))
  assert.equal(describeHoldingContracts(read(`137:${A},1:${B}`)), `137:${A.toLowerCase()}, 1:${B.toLowerCase()}`)
})

test('holding contracts: one entry that is not chainId:0xaddress refuses the whole value', () => {
  const good = `137:${A}`
  for (const bad of [
    A, // no chain
    `:${A}`,
    '137',
    '137:',
    `0:${A}`,
    `-137:${A}`,
    `+137:${A}`,
    `0137:${A}`,
    `1.5:${A}`,
    `0x89:${A}`,
    `1e3:${A}`,
    `polygon:${A}`,
    `99999999999999999:${A}`, // 17 digits
    `9007199254740993:${A}`, // 16 digits, not a safe integer
    `137:${A.slice(2)}`, // no 0x
    `137:${A.slice(0, -1)}`, // 39 hex digits
    `137:${A}0`, // 41
    `137:0x${'g'.repeat(40)}`,
    `137:0X${A.slice(2)}`,
    `137:${A}:erc1155`,
    `137:${A}:1`,
    `137 :${A}`,
    `137: ${A}`,
    `137=${A}`,
    `137:${A};1:${B}`,
    `137:${A} 1:${B}`,
    `${good},`, // an empty entry
    `,${good}`,
    `${good},,1:${B}`,
    ',',
    '*',
    '137:*',
    'all',
    'true',
    `${good},1:${B},137:nope`, // the good entries before it are not kept
  ]) {
    assert.throws(() => read(bad), /^Error: \[envs\] EVM_HOLDING_CONTRACTS/, JSON.stringify(bad))
  }
  assert.throws(() => read(137), /^Error: \[envs\] EVM_HOLDING_CONTRACTS must be a comma-separated list/)
  assert.throws(() => read(null), /^Error: \[envs\] EVM_HOLDING_CONTRACTS must be/)
  // the message names the entry and not what was written (a value pasted into the wrong variable is not printed)
  try {
    read(`${good},https://rpc.example/secret-key`)
    assert.fail('not refused')
  } catch (err) {
    assert.match(err.message, /^\[envs\] EVM_HOLDING_CONTRACTS: entry 2 is not chainId:0xaddress\. /)
    assert.ok(!err.message.includes('secret-key') && !err.message.includes(A.toLowerCase()))
  }
})

test('holding contracts: the server reads the variable at start-up, before it creates or loads the world', () => {
  const source = fs.readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8')
  const at = source.indexOf('\nconst holdingContracts = readHoldingContractsEnv(process.env)\n')
  assert.ok(at > 0, 'read at the top level, not inside a condition')
  const folder = source.indexOf('fs.ensureDir(worldDir)')
  assert.ok(folder > 0 && at < folder, 'before the world folder')
  assert.ok(at < source.indexOf('installShutdown()'), 'with the other [envs] checks')
})

test('holdings: a contract that is not listed is answered unknown and the node is not asked', async () => {
  const answers = {
    [SELECTORS.balanceOf1155]: `0x${encodeUintWord(3n)}`,
    [SELECTORS.balanceOf]: `0x${encodeUintWord(2n)}`,
    [SELECTORS.ownerOf]: `0x${encodeAddressWord(owner)}`,
  }
  // chains 137 and 1 both have an RPC; only `contract` on 137 is listed
  const { holdings, calls, lines } = service(answers, { chains: [137, 1] })
  const unlisted = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF'
  for (const spec of [
    { chainId: 137, contract: unlisted, standard: 'erc1155', tokenId: '1' },
    { chainId: 137, contract: unlisted, standard: 'erc721' },
    { chainId: 137, contract: unlisted, standard: 'erc721', tokenId: 7 },
    { chainId: 137, contract: unlisted.toLowerCase(), standard: 'erc721' },
    // the listed address on a chain it is not listed for
    { chainId: 1, contract, standard: 'erc721' },
  ]) {
    assert.deepEqual(await holdings.get(owner, spec), { known: false }, JSON.stringify(spec))
  }
  assert.equal(calls.length, 0, 'no RPC call for an unlisted contract')
  // one line per contract for the operator: which contract, how to list it, and nothing about the player
  assert.equal(lines.length, 2)
  assert.match(
    lines[0],
    /^\[evm\] getEvmHolding: a script asked about 137:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef, /
  )
  assert.match(lines[0], /add 137:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef to EVM_HOLDING_CONTRACTS/)
  assert.match(lines[1], new RegExp(`a script asked about 1:${contract.toLowerCase()}, `))
  assert.ok(!lines.join('\n').toLowerCase().includes(owner.slice(2).toLowerCase()), 'no player address in the log')
  // the listed contract, in any case, is read as before
  for (const written of [contract, contract.toLowerCase(), contract.toUpperCase().replace('0X', '0x')]) {
    assert.deepEqual(await holdings.get(owner, { chainId: 137, contract: written, standard: 'erc721' }), {
      known: true,
      balance: 2,
    })
  }
  assert.equal(calls.length, 1, 'one read (the three spellings share a cache entry)')
  assert.equal(calls[0][1][0].to, contract.toLowerCase())
  assert.equal(lines.length, 2, 'nothing logged for a listed contract')
})

test('holdings: no list, an empty list and a list of other contracts allow nothing', async () => {
  const answers = { [SELECTORS.balanceOf]: `0x${encodeUintWord(2n)}` }
  const spec = { chainId: 137, contract, standard: 'erc721' }
  for (const contracts of [undefined, [], readHoldingContractsEnv({}), read(''), read(`1:${contract}`)]) {
    const { rpc, calls } = fakeRpc(answers)
    const holdings = createEvmHoldingService({ rpcs: new Map([[137, rpc]]), contracts, log: { warn() {} } })
    assert.deepEqual(await holdings.get(owner, spec), { known: false })
    assert.equal(calls.length, 0)
  }
  // a service made without a list does not fall back to the default list either (only the variable's reader does)
  const bare = fakeRpc(answers)
  const unlisted = createEvmHoldingService({ rpcs: new Map([[137, bare.rpc]]), log: { warn() {} } })
  assert.deepEqual(await unlisted.get(owner, { ...spec, contract: OPENPAY }), { known: false })
  assert.equal(bare.calls.length, 0)
  // and the parsed variable is what allows it
  const { rpc, calls } = fakeRpc(answers)
  const holdings = createEvmHoldingService({ rpcs: new Map([[137, rpc]]), contracts: read(`137:${contract}`) })
  assert.deepEqual(await holdings.get(owner, spec), { known: true, balance: 2 })
  assert.equal(calls.length, 1)
})

test('holdings: the log names at most 16 unlisted contracts, each once, then says once that there are more', async () => {
  const { holdings, calls, lines } = service({})
  const nth = n => `0x${n.toString(16).padStart(40, '0')}`
  for (let round = 0; round < 3; round++) {
    for (let n = 1; n <= 40; n++) {
      assert.deepEqual(await holdings.get(owner, { chainId: 137, contract: nth(n), standard: 'erc721' }), {
        known: false,
      })
    }
  }
  assert.equal(calls.length, 0)
  assert.equal(lines.length, 17)
  assert.deepEqual(
    lines.slice(0, 16).map(line => line.match(/asked about (137:0x[0-9a-f]{40}), /)[1]),
    Array.from({ length: 16 }, (_, index) => `137:${nth(index + 1)}`)
  )
  assert.match(
    lines[16],
    /^\[evm\] getEvmHolding: more contracts that are not in EVM_HOLDING_CONTRACTS were asked about/
  )
})

test('holdings (N1): a contract that answers bits of the owner address gives nothing unless the operator listed it', async () => {
  const hostile = '0xbad0000000000000000000000000000000000bad'
  const ids = [0, 1, 2, 3]
  const ask = holdings =>
    Promise.all(
      ids.map(id => holdings.get(owner, { chainId: 137, contract: hostile, standard: 'erc1155', tokenId: id }))
    )
  // not listed (the operator's list has another contract): four questions, four "unknown", no call
  const closed = service({ [SELECTORS.balanceOf1155]: addressBits })
  assert.deepEqual(await ask(closed.holdings), [{ known: false }, { known: false }, { known: false }, { known: false }])
  assert.equal(closed.calls.length, 0)
  assert.equal(closed.lines.length, 1, 'one line for the four questions')
  // what the list does not bound: the same contract, once an operator lists it, gives the whole address in four
  // balances. Listing a contract trusts what it answers
  const open = service(
    { [SELECTORS.balanceOf1155]: addressBits },
    { contracts: [...listed, { chainId: 137, contract: hostile }] }
  )
  const answers = await ask(open.holdings)
  assert.ok(answers.every(answer => answer.known === true))
  assert.equal(fromBits(answers.map(answer => answer.balance)), owner.toLowerCase())
  assert.equal(open.calls.length, 4)
})
