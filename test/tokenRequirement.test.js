import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_REQUIRED_TOKEN_AMOUNT, parseRequiredTokenAmount } from '../src/core/extras/tokenRequirement.js'
import { readRequiredTokenAmount } from '../src/server/solana-gating.js'

test('token requirement: not set is 10,000; set must be a number above 0', () => {
  assert.equal(DEFAULT_REQUIRED_TOKEN_AMOUNT, 10000)
  assert.equal(parseRequiredTokenAmount(undefined), 10000)
  assert.equal(parseRequiredTokenAmount(null), 10000)
  for (const [value, amount] of [
    ['100000', 100000],
    [' 100000 ', 100000],
    ['0.5', 0.5],
    ['1e5', 100000],
    ['1', 1],
    [250, 250],
  ]) {
    assert.equal(parseRequiredTokenAmount(value), amount, JSON.stringify(value))
  }
  // each of these used to read as 0 (every verified wallet reaches it) or to fall back to 10,000 without a word
  for (const value of [
    '',
    ' ',
    '\t',
    '0',
    '0.0',
    '-0',
    '-1',
    '-100000',
    '100,000',
    '100 000',
    '10k',
    'abc',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e999',
    0,
    -1,
    NaN,
    Infinity,
    true,
    false,
    [],
    [5],
    {},
    10n,
  ]) {
    assert.equal(parseRequiredTokenAmount(value), null, typeof value === 'bigint' ? 'bigint' : JSON.stringify(value))
  }
})

test('token requirement: the server says once why nothing is granted, and only where gating is on', () => {
  const read = env => {
    const errors = []
    const amount = readRequiredTokenAmount(env, { error: message => errors.push(message) })
    return { amount, errors }
  }
  const mint = { PUBLIC_TOKEN_MINT: 'So11111111111111111111111111111111111111112' }
  assert.deepEqual(read({ ...mint }), { amount: 10000, errors: [] })
  assert.deepEqual(read({ ...mint, PUBLIC_REQUIRED_TOKEN_AMOUNT: '100000' }), { amount: 100000, errors: [] })
  for (const value of ['', '0', '-5', '100,000', 'abc']) {
    const { amount, errors } = read({ ...mint, PUBLIC_REQUIRED_TOKEN_AMOUNT: value })
    assert.equal(amount, null, value)
    assert.deepEqual(errors, [
      '[solana] PUBLIC_REQUIRED_TOKEN_AMOUNT is not a number above 0: no wallet is granted builder access by token',
    ])
    if (value.length > 1) assert.ok(!errors[0].includes(value), 'the value is not printed')
  }
  // no mint: there is no gate to talk about
  assert.deepEqual(read({ PUBLIC_REQUIRED_TOKEN_AMOUNT: '' }), { amount: null, errors: [] })
  assert.deepEqual(read({}), { amount: 10000, errors: [] })
})
