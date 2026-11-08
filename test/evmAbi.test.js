import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeFunctionData,
  formatUnits as viemFormat,
  keccak256,
  parseAbi,
  parseUnits as viemParse,
  toHex,
} from 'viem'
import {
  SELECTORS,
  TRANSFER_TOPIC,
  UINT256_MAX,
  decodeAddressWord,
  decodeUint256,
  encodeBalanceOf,
  encodeBalanceOf1155,
  encodeOwnerOf,
  encodeTransfer,
  formatUnits,
  isTxHash,
  parseTokenId,
  parseUnits,
} from '../src/core/extras/evmAbi.js'

const to = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const abi = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 id) view returns (address)',
])
const abi1155 = parseAbi(['function balanceOf(address owner, uint256 id) view returns (uint256)'])
const selector = signature => keccak256(toHex(signature)).slice(0, 10)

test('evm abi: selectors and the Transfer topic match keccak256 of their signatures', () => {
  assert.equal(SELECTORS.transfer, selector('transfer(address,uint256)'))
  assert.equal(SELECTORS.balanceOf, selector('balanceOf(address)'))
  assert.equal(SELECTORS.ownerOf, selector('ownerOf(uint256)'))
  assert.equal(SELECTORS.balanceOf1155, selector('balanceOf(address,uint256)'))
  assert.equal(TRANSFER_TOPIC, keccak256(toHex('Transfer(address,address,uint256)')))
})

test('evm abi: calldata matches viem encodeFunctionData', () => {
  for (const units of [0n, 1n, 10n ** 18n * 100n, UINT256_MAX]) {
    assert.equal(encodeTransfer(to, units), encodeFunctionData({ abi, functionName: 'transfer', args: [to, units] }))
  }
  assert.equal(encodeTransfer(to.toLowerCase(), 5n), encodeTransfer(to, 5n), 'case does not change calldata')
  assert.equal(encodeBalanceOf(to), encodeFunctionData({ abi, functionName: 'balanceOf', args: [to] }))
  const id = BigInt(keccak256(toHex('openpay:license:h_example')))
  assert.equal(encodeOwnerOf(id), encodeFunctionData({ abi, functionName: 'ownerOf', args: [id] }))
  assert.equal(
    encodeBalanceOf1155(to, id),
    encodeFunctionData({ abi: abi1155, functionName: 'balanceOf', args: [to, id] })
  )
  for (const bad of [-1n, UINT256_MAX + 1n, 1]) assert.throws(() => encodeTransfer(to, bad), /invalid uint256/)
  assert.throws(() => encodeTransfer('0x1234', 1n), /invalid address/)
})

test('evm abi: return words decode strictly', () => {
  assert.equal(decodeUint256(`0x${'0'.repeat(63)}7`), 7n)
  assert.equal(decodeUint256(`0x${'f'.repeat(64)}`), UINT256_MAX)
  for (const bad of ['0x', '0x07', `0x${'0'.repeat(65)}`, `0x${'g'.repeat(64)}`, null, 7]) {
    assert.throws(() => decodeUint256(bad), /invalid uint256 word/, String(bad))
  }
  assert.equal(decodeAddressWord(`0x${'0'.repeat(24)}${to.slice(2)}`), to.toLowerCase())
  assert.throws(() => decodeAddressWord(`0x${'1'.repeat(24)}${to.slice(2)}`), /invalid address word/)
  assert.throws(() => decodeAddressWord(to), /invalid address word/)
})

test('evm abi: amounts parse and format exactly like viem, and refuse anything ambiguous', () => {
  for (const [amount, decimals] of [
    ['100', 18],
    ['0.5', 6],
    ['1.000001', 6],
    ['123456789.123456789123456789', 18],
    ['007', 0],
    ['0', 18],
  ]) {
    const units = parseUnits(amount, decimals)
    assert.equal(units, viemParse(amount, decimals), amount)
    assert.equal(formatUnits(units, decimals), viemFormat(units, decimals), amount)
  }
  for (const bad of ['', ' ', '-1', '+1', '1e3', '1.', '.5', '1,000', '0x10', '1.0000001', 'NaN', 'Infinity', '1 2']) {
    assert.throws(() => parseUnits(bad, 6), /invalid amount|too many decimals/, bad)
  }
  assert.throws(() => parseUnits(10, 6), /invalid amount/)
  assert.throws(() => parseUnits('1', 37), /invalid decimals/)
  assert.throws(() => parseUnits('9'.repeat(80), 0), /invalid amount/)
})

test('evm abi: token ids accept decimal, 0x hex and safe integers within uint256', () => {
  const openpay = keccak256(toHex('openpay:license:h_example'))
  assert.equal(parseTokenId(openpay), BigInt(openpay))
  assert.equal(parseTokenId('42'), 42n)
  assert.equal(parseTokenId(42), 42n)
  assert.equal(parseTokenId('0x2a'), 42n)
  for (const bad of [-1, 1.5, 2 ** 53, '', '-1', '0x', `0x${'f'.repeat(65)}`, '1'.repeat(79), null, 1n]) {
    assert.throws(() => parseTokenId(bad), /invalid tokenId/, String(bad))
  }
  assert.throws(() => parseTokenId((UINT256_MAX + 1n).toString()), /invalid tokenId/)
})

test('evm abi: tx hashes are 32-byte hex', () => {
  assert.equal(isTxHash(`0x${'aB'.repeat(32)}`), true)
  for (const bad of [`0x${'a'.repeat(63)}`, `0x${'a'.repeat(65)}`, 'a'.repeat(64), null])
    assert.equal(isTxHash(bad), false)
})
