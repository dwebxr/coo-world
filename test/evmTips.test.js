import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KNOWN_TOKENS, explorerTxUrl, parseTipAmount, parseTipTokens } from '../src/core/extras/evmTokens.js'
import { TRANSFER_TOPIC, encodeAddressWord, encodeUintWord } from '../src/core/extras/evmAbi.js'
import { checkTipBlock, finalizedNumber, matchTipReceipt } from '../src/server/evmTipVerify.js'

const JPYC = KNOWN_TOKENS[137].JPYC
const from = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a'
const recipient = '0x1563915e194D8CfBA1943570603F7606A3115508'
const units = 100n * 10n ** 18n
const txHash = `0x${'ab'.repeat(32)}`
const blockHash = `0x${'cd'.repeat(32)}`
const quote = { txHash, from, recipient, token: JPYC.address, units }
const transferLog = (patch = {}) => ({
  address: JPYC.address.toLowerCase(),
  transactionHash: txHash,
  blockHash,
  logIndex: '0x3',
  topics: [TRANSFER_TOPIC, `0x${encodeAddressWord(from)}`, `0x${encodeAddressWord(recipient)}`],
  data: `0x${encodeUintWord(units)}`,
  removed: false,
  ...patch,
})
const receipt = (patch = {}) => ({
  transactionHash: txHash.toUpperCase().replace('0X', '0x'),
  status: '0x1',
  blockNumber: '0x10',
  blockHash,
  from: from.toUpperCase().replace('0X', '0x'),
  to: JPYC.address,
  logs: [transferLog()],
  ...patch,
})

test('tip tokens: built-in symbols, explicit entries, and all-or-nothing parsing', () => {
  assert.deepEqual(parseTipTokens('JPYC,USDC', 137), [KNOWN_TOKENS[137].JPYC, KNOWN_TOKENS[137].USDC])
  assert.deepEqual(parseTipTokens(' JPYC ', 137), [JPYC])
  const address = `0x${'ab'.repeat(20)}`
  assert.deepEqual(parseTipTokens(`TEST:${address}:6`, 80002), [
    { symbol: 'TEST', address, decimals: 6, min: '0.000001' },
  ])
  assert.deepEqual(parseTipTokens(`TEST:${address}:0`, 80002), [{ symbol: 'TEST', address, decimals: 0, min: '1' }])
  assert.deepEqual(parseTipTokens(`TEST:${address}:18:0.5`, 80002), [
    { symbol: 'TEST', address, decimals: 18, min: '0.5' },
  ])
  for (const raw of [
    '',
    'JPYC,DOGE',
    'JPYC,JPYC',
    `JPYC,X:${JPYC.address}:18`,
    'TEST:0x1234:6',
    `TEST:${address}:19`,
    `TEST:${address}`,
    `TEST:${address}:6:0.0000001`,
    `TEST:${address}:6:0`,
    `test:${address}:6`,
    'jpyc',
    'JP YC',
    'TOOLONGSYMBOL',
  ]) {
    assert.deepEqual(parseTipTokens(raw, 137), [], raw)
  }
  assert.deepEqual(parseTipTokens('JPYC', 1), [], 'no built-in JPYC entry for chain 1')
  assert.ok(Object.isFrozen(parseTipTokens('JPYC', 137)[0]))
})

test('tip amounts: strict grammar and the per-token minimum', () => {
  const USDC = KNOWN_TOKENS[137].USDC
  assert.equal(parseTipAmount('100', JPYC), 100n * 10n ** 18n)
  assert.equal(parseTipAmount('1', JPYC), 10n ** 18n)
  assert.equal(parseTipAmount('0.01', USDC), 10000n)
  assert.equal(parseTipAmount('123.456789', USDC), 123456789n)
  assert.throws(() => parseTipAmount('0.5', JPYC), /below minimum/)
  assert.throws(() => parseTipAmount('0.009', USDC), /below minimum/)
  for (const bad of ['', '1.', '.5', '-1', '1e3', ' 1', '1 ', '1,5', '0x10', '1'.repeat(19), '1.0000001']) {
    assert.throws(() => parseTipAmount(bad, USDC), /invalid amount|too many decimals/, bad)
  }
  assert.throws(() => parseTipAmount(5, USDC), /invalid amount/)
})

test('tip tokens: explorer links only for known chains', () => {
  assert.equal(explorerTxUrl(137, `0x${'a'.repeat(64)}`), `https://polygonscan.com/tx/0x${'a'.repeat(64)}`)
  assert.equal(explorerTxUrl(80002, `0x${'a'.repeat(64)}`), null)
})

test('tip receipt: a matching Transfer from the quoted sender to the quoted recipient matches', () => {
  assert.deepEqual(matchTipReceipt(receipt(), quote), { state: 'matched', blockNumber: 16n, blockHash, logIndex: 3n })
  // One matching log among others (for example an approval or another transfer) is enough.
  const noise = transferLog({ data: `0x${encodeUintWord(1n)}` })
  assert.equal(matchTipReceipt(receipt({ logs: [noise, transferLog()] }), quote).state, 'matched')
  assert.deepEqual(matchTipReceipt(null, quote), { state: 'pending' })
  // EIP-7702, sponsored and ERC-4337 transactions: the signer and the called contract are not the sender or the
  // token, and the token's Transfer log alone decides.
  const relayer = `0x${'ef'.repeat(20)}`
  assert.equal(matchTipReceipt(receipt({ from: relayer, to: from }), quote).state, 'matched')
  assert.equal(matchTipReceipt(receipt({ from: relayer, to: relayer }), quote).state, 'matched')
  // logs without the optional fields still match
  const bare = transferLog()
  delete bare.transactionHash
  delete bare.blockHash
  delete bare.logIndex
  assert.deepEqual(matchTipReceipt(receipt({ logs: [bare] }), quote), {
    state: 'matched',
    blockNumber: 16n,
    blockHash,
    logIndex: null,
  })
  // up to 1024 logs (batched transactions)
  const many = [...Array.from({ length: 1023 }, () => transferLog({ data: `0x${encodeUintWord(1n)}` })), transferLog()]
  assert.equal(matchTipReceipt(receipt({ logs: many }), quote).state, 'matched')
})

test('tip receipt: every mismatch fails with a reason', () => {
  const other = `0x${'cd'.repeat(20)}`
  const cases = [
    [receipt({ status: '0x0' }), 'reverted'],
    [receipt({ transactionHash: `0x${'00'.repeat(32)}` }), 'bad_receipt'],
    [receipt({ transactionHash: undefined }), 'bad_receipt'],
    [receipt({ blockHash: '0x12' }), 'bad_receipt'],
    [receipt({ logs: [transferLog({ transactionHash: `0x${'00'.repeat(32)}` })] }), 'no_transfer'],
    [receipt({ logs: [transferLog({ blockHash: `0x${'00'.repeat(32)}` })] }), 'no_transfer'],
    [receipt({ logs: [] }), 'no_transfer'],
    [receipt({ logs: [transferLog({ address: other })] }), 'no_transfer'],
    [receipt({ logs: [transferLog({ data: `0x${encodeUintWord(units - 1n)}` })] }), 'no_transfer'],
    [
      receipt({
        logs: [
          transferLog({
            topics: [TRANSFER_TOPIC, `0x${encodeAddressWord(other)}`, `0x${encodeAddressWord(recipient)}`],
          }),
        ],
      }),
      'no_transfer',
    ],
    [
      receipt({
        logs: [
          transferLog({ topics: [TRANSFER_TOPIC, `0x${encodeAddressWord(from)}`, `0x${encodeAddressWord(other)}`] }),
        ],
      }),
      'no_transfer',
    ],
    [
      receipt({ logs: [transferLog({ topics: [`0x${'0'.repeat(64)}`, ...transferLog().topics.slice(1)] })] }),
      'no_transfer',
    ],
    [receipt({ logs: [transferLog({ removed: true })] }), 'no_transfer'],
    [receipt({ logs: [transferLog({ data: '0x01' })] }), 'no_transfer'],
    [receipt({ logs: [transferLog({ topics: transferLog().topics.slice(0, 2) })] }), 'no_transfer'],
    [receipt({ logs: 'x' }), 'bad_receipt'],
    [receipt({ logs: Array.from({ length: 1025 }, () => transferLog()) }), 'bad_receipt'],
    [receipt({ blockNumber: null }), 'bad_receipt'],
    ['receipt', 'bad_receipt'],
    [[], 'bad_receipt'],
  ]
  for (const [value, reason] of cases) {
    assert.deepEqual(matchTipReceipt(value, quote), { state: 'failed', reason }, reason)
  }
})

test('tip receipt: finalized block numbers parse strictly', () => {
  assert.equal(finalizedNumber({ number: '0x20' }), 32n)
  for (const bad of [null, {}, { number: 32 }, { number: '0x' }, { number: 'latest' }]) {
    assert.equal(finalizedNumber(bad), null)
  }
})

test('tip block: the finalized block at the receipt height must be the receipt block and not older than the ticket', () => {
  const at = { blockNumber: 16n, blockHash, notBeforeSec: 1_000 }
  const block = (patch = {}) => ({
    number: '0x10',
    hash: blockHash.toUpperCase().replace('0X', '0x'),
    timestamp: '0x3e8',
    ...patch,
  })
  assert.equal(checkTipBlock(block(), at), 'ok')
  assert.equal(checkTipBlock(block({ timestamp: '0x3e7' }), at), 'too_old')
  assert.equal(checkTipBlock(block({ hash: `0x${'00'.repeat(32)}` }), at), 'reorged')
  assert.equal(checkTipBlock(null, at), 'missing')
  for (const bad of [
    'block',
    [],
    block({ number: '0x11' }),
    block({ number: 16 }),
    block({ hash: '0x12' }),
    block({ timestamp: 1000 }),
    block({ timestamp: undefined }),
  ]) {
    assert.equal(checkTipBlock(bad, at), 'bad_block')
  }
})
