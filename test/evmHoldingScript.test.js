import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'ses'
await import('../src/core/lockdown.js')
import { callForScript } from '../src/core/extras/scriptValues.js'
import { loadClient } from './lib/clientHarness.mjs'
import { createEvmHoldingService, readHoldingContractsEnv } from '../src/server/evmHoldings.js'
import { SELECTORS, encodeUintWord } from '../src/core/extras/evmAbi.js'

const warnings = []
const createProxy = loadClient('core/extras/createPlayerProxy.js', 'createPlayerProxy', {
  callForScript,
  console: { warn: message => warnings.push(message) },
})
const contract = `0x${'ab'.repeat(20)}`
const UNKNOWN = { verified: false, known: false, balance: 0, holds: false }

function setup({ answer = { verified: true, known: true, balance: 2 } } = {}) {
  const asked = []
  const world = {
    network: {
      isServer: true,
      isClient: false,
      evmHolding: (playerId, spec) => {
        asked.push([playerId, spec])
        return typeof answer === 'function' ? answer() : Promise.resolve(answer)
      },
    },
  }
  const entity = {
    world,
    hook: { dead: false },
    getDeadHook() {
      return this.hook
    },
  }
  const player = { world, data: { id: 'p1' } }
  const compartment = new Compartment({ player: createProxy(entity, player) })
  return { world, entity, player, asked, compartment }
}

test('getEvmHolding: frozen intrinsic result; holds compares with minBalance; the spec is copied as primitives', async () => {
  const { compartment, asked } = setup()
  assert.equal(compartment.evaluate(`player.getEvmHolding({}) instanceof Promise`), true)
  const result = await compartment.evaluate(
    `player.getEvmHolding({ chainId: 137, contract: '${contract}', standard: 'erc1155', tokenId: '0x1', minBalance: 2 })`
  )
  assert.equal(Object.getPrototypeOf(result), compartment.evaluate('Object.prototype'))
  assert.ok(Object.isFrozen(result))
  assert.deepEqual(Reflect.ownKeys(result), ['verified', 'known', 'balance', 'holds'])
  assert.deepEqual({ ...result }, { verified: true, known: true, balance: 2, holds: true })
  assert.deepEqual(asked.at(-1), ['p1', { chainId: 137, contract, standard: 'erc1155', tokenId: '0x1', minBalance: 2 }])
  const higher = await compartment.evaluate(
    `player.getEvmHolding({ chainId: 137, contract: '${contract}', standard: 'erc721', minBalance: 3 })`
  )
  assert.equal(higher.holds, false)
  assert.equal(higher.known, true)
  // A getter on the spec runs once and only primitives cross.
  const reads = compartment.evaluate(`
    let reads = 0
    const spec = { get chainId() { reads++; return 137 }, contract: '${contract}', standard: 'erc721' }
    player.getEvmHolding(spec)
    reads
  `)
  assert.equal(reads, 1)
  assert.equal(Object.getPrototypeOf(asked.at(-1)[1]), Object.prototype, 'host-made spec')
})

test('getEvmHolding: odd answers become unknown, huge balances are capped, rejections resolve unknown', async () => {
  for (const [answer, expected] of [
    [
      { verified: true, known: true, balance: -1 },
      { verified: true, known: false, balance: 0, holds: false },
    ],
    [
      { verified: true, known: true, balance: '3' },
      { verified: true, known: false, balance: 0, holds: false },
    ],
    [{ verified: false, known: true, balance: 3 }, UNKNOWN],
    [
      { verified: true, known: true, balance: 1e300 },
      { verified: true, known: true, balance: Number.MAX_SAFE_INTEGER, holds: true },
    ],
    [null, UNKNOWN],
    [() => Promise.reject(new Error('boom')), UNKNOWN],
    [
      () => {
        throw new Error('sync boom')
      },
      UNKNOWN,
    ],
  ]) {
    const { compartment } = setup({ answer })
    const result = await compartment.evaluate(
      `player.getEvmHolding({ chainId: 137, contract: '${contract}', standard: 'erc721' })`
    )
    assert.deepEqual({ ...result }, expected, JSON.stringify(answer))
  }
})

test('getEvmHolding: invalid specs warn once per app and still report verification', async () => {
  const { compartment, asked } = setup({ answer: { verified: true, known: false, balance: 0 } })
  const before = warnings.length
  for (const spec of [
    'null',
    '"spec"',
    `{ chainId: '137', contract: '${contract}', standard: 'erc721' }`,
    `{ chainId: 137, contract: 1, standard: 'erc721' }`,
    `{ chainId: 137, contract: '${contract}', standard: 'erc721', tokenId: {} }`,
    `{ chainId: 137, contract: '${contract}', standard: 'erc721', minBalance: 0 }`,
    `{ chainId: 137, contract: '${contract}', standard: 'erc721', minBalance: 1.5 }`,
  ]) {
    const result = await compartment.evaluate(`player.getEvmHolding(${spec})`)
    assert.deepEqual({ ...result }, { verified: true, known: false, balance: 0, holds: false }, spec)
    assert.equal(asked.at(-1)[1], null, 'the server is asked with no spec')
  }
  assert.equal(warnings.length - before, 1)
})

test('getEvmHolding: client scripts get unknown without a request and one warning', async () => {
  const { world, compartment, asked } = setup()
  world.network.isServer = false
  world.network.isClient = true
  const before = warnings.length
  for (let i = 0; i < 3; i++) {
    const result = await compartment.evaluate(
      `player.getEvmHolding({ chainId: 137, contract: '${contract}', standard: 'erc721' })`
    )
    assert.deepEqual({ ...result }, UNKNOWN)
  }
  assert.equal(asked.length, 0)
  assert.equal(warnings.length - before, 1)
  assert.match(warnings.at(-1), /only in server scripts/)
})

test('getEvmHolding: crash, rebuild, destroy and fatal suppress settlement', async () => {
  for (const mode of ['crash', 'rebuild', 'destroy', 'fatal']) {
    let finish
    const { world, entity, compartment } = setup({ answer: () => new Promise(resolve => (finish = resolve)) })
    const pending = compartment.evaluate(
      `player.getEvmHolding({ chainId: 137, contract: '${contract}', standard: 'erc721' })`
    )
    let settled = false
    pending.then(() => (settled = true))
    if (mode === 'crash') entity.crashed = true
    if (mode === 'rebuild') entity.hook.dead = true
    if (mode === 'destroy') entity.destroyed = true
    if (mode === 'fatal') world.fatalError = new Error('fatal')
    finish({ verified: true, known: true, balance: 1 })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    assert.equal(settled, false, mode)
  }
})

// N1. The script below is the whole attack: a contract of the author's own whose balanceOf(owner, id) answers 40
// bits of the owner's address, asked for ids 0..3. The network's evmHolding here does what the server's does with
// the answer of the real holdings service (test/serverEvmWallet.test.js runs the server's own).
test('getEvmHolding (N1): a script reads no address bits through a contract the operator did not list', async () => {
  const owner = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
  const hostile = '0xbad0000000000000000000000000000000000bad'
  const extract = `(async () => {
    let address = 0n
    const answers = []
    for (let id = 0; id < 4; id++) {
      const result = await player.getEvmHolding({ chainId: 137, contract: '${hostile}', standard: 'erc1155', tokenId: id })
      answers.push({ ...result })
      address += BigInt(result.balance) << (40n * BigInt(id))
    }
    return { answers, address: '0x' + address.toString(16).padStart(40, '0') }
  })()`
  const run = async env => {
    const calls = []
    const lines = []
    const rpc = {
      chainId: 137,
      async call(method, [{ to, data }]) {
        calls.push(to)
        assert.equal(data.slice(0, 10), SELECTORS.balanceOf1155)
        const bits = (BigInt(`0x${data.slice(34, 74)}`) >> (40n * BigInt(`0x${data.slice(74)}`))) & ((1n << 40n) - 1n)
        return `0x${encodeUintWord(bits)}`
      },
    }
    const holdings = createEvmHoldingService({
      rpcs: new Map([[137, rpc]]),
      contracts: readHoldingContractsEnv(env),
      log: { warn: line => lines.push(line) },
    })
    const { compartment, world } = setup()
    world.network.evmHolding = async (playerId, spec) => {
      const result = await holdings.get(owner, spec)
      return { verified: true, known: result.known === true, balance: result.known === true ? result.balance : 0 }
    }
    return { ...(await compartment.evaluate(extract)), calls, lines }
  }
  // the default list (the variable is not set) and a list of other contracts: nothing, and the node is not asked
  for (const env of [{}, { EVM_HOLDING_CONTRACTS: `137:0x${'ab'.repeat(20)}` }, { EVM_HOLDING_CONTRACTS: '' }]) {
    const closed = await run(env)
    assert.deepEqual(
      closed.answers,
      Array.from({ length: 4 }, () => ({ verified: true, known: false, balance: 0, holds: false })),
      JSON.stringify(env)
    )
    assert.equal(closed.address, `0x${'0'.repeat(40)}`)
    assert.equal(closed.calls.length, 0, 'no RPC call')
    assert.equal(closed.lines.length, 1, 'one log line for the four questions')
    assert.ok(!closed.lines[0].toLowerCase().includes(owner.slice(2).toLowerCase()))
  }
  // not bounded by the list: an operator who lists that contract gives every script the address
  const open = await run({ EVM_HOLDING_CONTRACTS: `137:${hostile}` })
  assert.equal(open.address, owner.toLowerCase())
  assert.equal(open.calls.length, 4)
})
