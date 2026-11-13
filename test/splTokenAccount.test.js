// src/server/splTokenAccount.js against the real @solana/spl-token (a dev dependency, kept for this): the same
// associated token addresses, the same refusal of an owner off the curve, the same mint, owner and amount read from
// data the real AccountLayout wrote. The inputs are random; a failure names them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import * as spl from '@solana/spl-token'
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  readTokenAccount,
} from '../src/server/splTokenAccount.js'

const randomKey = () => new PublicKey(crypto.randomBytes(32))
const randomU64 = () => crypto.randomBytes(8).readBigUInt64LE(0)
const randomU32 = () => crypto.randomBytes(4).readUInt32LE(0)
const offCurveKey = label => PublicKey.findProgramAddressSync([Buffer.from(label)], spl.TOKEN_PROGRAM_ID)[0]
// what either function does with the inputs: the address in base58, or that it threw
const outcome = fn => {
  try {
    return fn().toBase58()
  } catch {
    return 'threw'
  }
}

test('the program ids and the account size are the ones of spl-token', () => {
  assert.ok(TOKEN_PROGRAM_ID.equals(spl.TOKEN_PROGRAM_ID))
  assert.ok(ASSOCIATED_TOKEN_PROGRAM_ID.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID))
  assert.equal(ACCOUNT_SIZE, spl.ACCOUNT_SIZE)
  assert.equal(ACCOUNT_SIZE, spl.AccountLayout.span)
})

test('the associated token address of 200 keypair owners and random mints is the one of spl-token', () => {
  for (let i = 0; i < 200; i++) {
    const owner = Keypair.generate().publicKey
    const mint = i % 2 ? Keypair.generate().publicKey : randomKey()
    const expected = spl.getAssociatedTokenAddressSync(mint, owner)
    const actual = associatedTokenAddress(mint, owner)
    assert.ok(actual instanceof PublicKey)
    assert.equal(actual.toBase58(), expected.toBase58(), `mint ${mint.toBase58()}, owner ${owner.toBase58()}`)
  }
})

test('an owner off the curve throws in both', () => {
  const mint = Keypair.generate().publicKey
  for (const label of ['a program address', 'another one', 'a third']) {
    const owner = offCurveKey(label)
    assert.equal(PublicKey.isOnCurve(owner.toBuffer()), false)
    assert.throws(() => spl.getAssociatedTokenAddressSync(mint, owner), { name: 'TokenOwnerOffCurveError' })
    assert.throws(() => associatedTokenAddress(mint, owner), /off the ed25519 curve/)
  }
})

test('random 32-byte owners, on the curve or not: both throw or both give the same address', () => {
  let threw = 0
  for (let i = 0; i < 200; i++) {
    const owner = randomKey()
    const mint = randomKey()
    const expected = outcome(() => spl.getAssociatedTokenAddressSync(mint, owner))
    assert.equal(
      outcome(() => associatedTokenAddress(mint, owner)),
      expected,
      `mint ${mint.toBase58()}, owner ${owner.toBase58()}`
    )
    if (expected === 'threw') threw++
  }
  // (about half of random 32-byte values are off the curve: both branches were taken)
  assert.ok(threw > 0 && threw < 200, `${threw} of 200 off the curve`)
})

const AMOUNTS = [0n, 1n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 63n, 2n ** 64n - 1n]

function encoded(fields) {
  const data = Buffer.alloc(spl.ACCOUNT_SIZE)
  spl.AccountLayout.encode(fields, data)
  return data
}

function randomFields(amount) {
  return {
    mint: randomKey(),
    owner: randomKey(),
    amount,
    delegateOption: randomU32(),
    delegate: randomKey(),
    state: crypto.randomInt(256),
    isNativeOption: randomU32(),
    isNative: randomU64(),
    delegatedAmount: randomU64(),
    closeAuthorityOption: randomU32(),
    closeAuthority: randomKey(),
  }
}

function assertSameRead(data, why) {
  const expected = spl.AccountLayout.decode(data)
  const actual = readTokenAccount(data)
  assert.deepEqual(Object.keys(actual).sort(), ['amount', 'mint', 'owner'])
  assert.ok(actual.mint instanceof PublicKey && actual.owner instanceof PublicKey, why)
  assert.equal(actual.mint.toBase58(), expected.mint.toBase58(), why)
  assert.equal(actual.owner.toBase58(), expected.owner.toBase58(), why)
  assert.equal(typeof actual.amount, 'bigint', why)
  assert.equal(actual.amount, expected.amount, why)
}

test('mint, owner and amount of accounts written by the real AccountLayout, at the edges of a u64', () => {
  for (const amount of AMOUNTS) {
    for (let i = 0; i < 20; i++) {
      const data = encoded(randomFields(amount))
      assertSameRead(data, `amount ${amount}, data ${data.toString('hex')}`)
    }
  }
})

test('mint, owner and amount of accounts written by the real AccountLayout, random amounts', () => {
  for (let i = 0; i < 300; i++) {
    const data = encoded(randomFields(randomU64()))
    assertSameRead(data, `data ${data.toString('hex')}`)
  }
})

test('mint, owner and amount of 165 random bytes read as spl-token reads them', () => {
  for (let i = 0; i < 300; i++) {
    const data = crypto.randomBytes(ACCOUNT_SIZE)
    assertSameRead(data, `data ${data.toString('hex')}`)
  }
})

test('anything but a Buffer of 165 bytes throws', () => {
  const account = encoded(randomFields(5n))
  for (const length of [164, 166, 0, 72, 330]) {
    const data = Buffer.alloc(length)
    account.copy(data, 0, 0, Math.min(length, ACCOUNT_SIZE))
    assert.throws(() => readTokenAccount(data), /not the data of a token account/, `length ${length}`)
  }
  for (const value of [new Uint8Array(account), account.toString('latin1'), account.toString('base64'), null]) {
    assert.throws(() => readTokenAccount(value), /not the data of a token account/, typeof value)
  }
  assert.throws(() => readTokenAccount(), /not the data of a token account/)
})
