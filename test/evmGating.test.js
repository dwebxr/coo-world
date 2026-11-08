import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { privateKeyToAccount } from 'viem/accounts'
import { parseSiweMessage } from 'viem/siwe'
import * as evm from '../src/server/evm-gating.js'
import { isEvmAddress, isEvmSignature, parseEvmChainIds, sameEvmAddress } from '../src/core/extras/evmChains.js'

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const options = { host: 'world.example', uri: 'https://world.example', chainId: 137, now: 1_000_000 }
const challengeFor = (address = account.address.toLowerCase()) => evm.buildEvmChallenge(address, options)
const sign = (challenge, signer = account) => signer.signMessage({ message: challenge.message })

test('evm config: chain ids parse strictly and any bad entry disables EVM', () => {
  assert.deepEqual(parseEvmChainIds('137'), [137])
  assert.deepEqual(parseEvmChainIds(' 137 , 1,137 '), [137, 1])
  for (const raw of [
    undefined,
    null,
    '',
    '  ',
    '0',
    '-1',
    '1.5',
    '137,',
    '137,abc',
    '0x89',
    '1e3',
    '99999999999999999',
  ]) {
    assert.deepEqual(parseEvmChainIds(raw), [], String(raw))
  }
})

test('evm config: unset, invalid or unbuildable settings disable EVM with a log', () => {
  const logs = []
  const log = { error: message => logs.push(message), warn: message => logs.push(message) }
  const url = { host: 'world.example', uri: 'https://world.example', log }
  assert.deepEqual(evm.resolveEvmConfig({}, url), { enabled: false, chainIds: [], chainId: null })
  assert.equal(logs.length, 0, 'unset is silent')
  assert.equal(evm.resolveEvmConfig({ PUBLIC_EVM_CHAIN_IDS: 'polygon' }, url).enabled, false)
  assert.match(logs.pop(), /PUBLIC_EVM_CHAIN_IDS is invalid/)
  // The literal fallback host is not an RFC 3986 authority, so the sign-in message cannot be built.
  const fallback = evm.resolveEvmConfig({ PUBLIC_EVM_CHAIN_IDS: '137' }, { host: 'coo-world', uri: url.uri, log })
  assert.equal(fallback.enabled, false)
  assert.match(logs.pop(), /cannot build a sign-in message for "coo-world".*set PUBLIC_API_URL/)
  assert.deepEqual(evm.resolveEvmConfig({ PUBLIC_EVM_CHAIN_IDS: '137,1' }, url), {
    enabled: true,
    chainIds: [137, 1],
    chainId: 137,
  })
  assert.equal(logs.length, 0)
  // The test process has no PUBLIC_EVM_CHAIN_IDS, so the module default is off.
  assert.equal(evm.EVM_ENABLED, false)
})

test('evm validators: addresses, signatures and case-insensitive comparison', () => {
  assert.equal(isEvmAddress(account.address), true)
  assert.equal(isEvmAddress(account.address.toLowerCase()), true)
  for (const bad of [
    '',
    '0x',
    account.address.slice(0, 41),
    `${account.address}0`,
    account.address.slice(2),
    42,
    null,
  ]) {
    assert.equal(isEvmAddress(bad), false, String(bad))
  }
  assert.equal(isEvmSignature(`0x${'ab'.repeat(65)}`), true)
  for (const bad of [`0x${'ab'.repeat(64)}`, `0x${'ab'.repeat(66)}`, `0x${'zz'.repeat(65)}`, 'ab'.repeat(65), null]) {
    assert.equal(isEvmSignature(bad), false, String(bad))
  }
  assert.equal(sameEvmAddress(account.address, account.address.toLowerCase()), true)
  assert.equal(sameEvmAddress(account.address, other.address), false)
  assert.equal(sameEvmAddress(undefined, account.address), false)
})

test('evm challenge: server-built SIWE message binds domain, uri, chain, nonce, expiry and checksummed address', () => {
  const challenge = challengeFor()
  assert.equal(challenge.address, account.address, 'stored as EIP-55')
  assert.match(challenge.nonce, /^[a-f0-9]{64}$/)
  assert.equal(challenge.expiresAt, options.now + evm.CHALLENGE_TTL_MS)
  assert.ok(Buffer.byteLength(challenge.message) <= 1024)
  const parsed = parseSiweMessage(challenge.message)
  assert.equal(parsed.domain, 'world.example')
  assert.equal(parsed.address, account.address)
  assert.equal(parsed.uri, 'https://world.example')
  assert.equal(parsed.version, '1')
  assert.equal(parsed.chainId, 137)
  assert.equal(parsed.nonce, challenge.nonce)
  assert.equal(parsed.statement, evm.EVM_STATEMENT)
  assert.equal(parsed.issuedAt.getTime(), options.now)
  assert.equal(parsed.expirationTime.getTime(), challenge.expiresAt)
  assert.notEqual(challengeFor().nonce, challenge.nonce, 'fresh nonce each time')
  assert.throws(() => evm.buildEvmChallenge('0x1234', options), /invalid challenge/)
})

test('evm challenge: a valid EOA signature verifies, including a lowercase request address', async () => {
  const challenge = challengeFor()
  const signature = await sign(challenge)
  for (const address of [
    account.address,
    account.address.toLowerCase(),
    account.address.toUpperCase().replace('0X', '0x'),
  ]) {
    assert.deepEqual(
      await evm.checkEvmChallenge(challenge, { address, signature, nonce: challenge.nonce }, options.now),
      {
        ok: true,
        reason: 'ok',
      }
    )
  }
})

test('evm challenge: every mismatch fails closed with a reason', async () => {
  const challenge = challengeFor()
  const signature = await sign(challenge)
  const good = { address: account.address, signature, nonce: challenge.nonce }
  const check = (patch, now = options.now, c = challenge) => evm.checkEvmChallenge(c, { ...good, ...patch }, now)
  assert.deepEqual(await check({}, options.now, null), { ok: false, reason: 'no_nonce' })
  assert.deepEqual(await check({ nonce: 'f'.repeat(64) }), { ok: false, reason: 'nonce_mismatch' })
  assert.deepEqual(await check({ nonce: 'short' }), { ok: false, reason: 'nonce_mismatch' })
  assert.deepEqual(await check({}, challenge.expiresAt), { ok: false, reason: 'nonce_expired' })
  assert.deepEqual(await check({ address: 'nope' }), { ok: false, reason: 'bad_wallet' })
  assert.deepEqual(await check({ address: other.address }), { ok: false, reason: 'wallet_mismatch' })
  assert.deepEqual(await check({ signature: '0x1234' }), { ok: false, reason: 'bad_signature' })
  // Signed by someone else, signed over a different message, or an unrecoverable v byte.
  assert.deepEqual(await check({ signature: await sign(challenge, other) }), { ok: false, reason: 'signature_invalid' })
  const altered = { ...challenge, message: challenge.message.replace('world.example', 'evil.example') }
  assert.deepEqual(await check({}, options.now, altered), { ok: false, reason: 'signature_invalid' })
  assert.deepEqual(await check({ signature: `${signature.slice(0, -2)}05` }), {
    ok: false,
    reason: 'signature_invalid',
  })
})

test('evm challenge: public reasons are a fixed vocabulary', () => {
  assert.equal(evm.publicReason('ok'), 'ok')
  assert.equal(evm.publicReason('nonce_expired'), 'nonce_expired')
  assert.equal(evm.publicReason('signature_invalid'), 'signature_invalid')
  assert.equal(evm.publicReason('bad_signature'), 'signature_invalid')
  for (const reason of ['no_nonce', 'nonce_mismatch', 'bad_wallet', 'wallet_mismatch', 'anything']) {
    assert.equal(evm.publicReason(reason), 'bad_request')
  }
})

test('evm session: independent of the Solana wallet session shape', () => {
  assert.deepEqual(evm.createEvmWalletSession(5), {
    generation: 0,
    verified: null,
    challenge: null,
    lastChallengeAt: 0,
    challengeCooldownReplied: false,
    receiveTips: false,
    receiveChangedAt: 0,
    intentBucket: { tokens: evm.TIP_INTENT_BURST, at: 5 },
    tickets: new Map(),
  })
})

test('evm tip tokens: resolved for the sign-in chain only, invalid lists disable tips with a log', () => {
  const logs = []
  const log = { error: line => logs.push(line) }
  assert.deepEqual(
    evm.resolveTipTokens({ PUBLIC_EVM_TIP_TOKENS: 'JPYC' }, 137, { log }).map(token => token.symbol),
    ['JPYC']
  )
  assert.deepEqual(evm.resolveTipTokens({ PUBLIC_EVM_TIP_TOKENS: 'JPYC' }, null, { log }), [])
  assert.deepEqual(evm.resolveTipTokens({}, 137, { log }), [])
  assert.equal(logs.length, 0)
  assert.deepEqual(evm.resolveTipTokens({ PUBLIC_EVM_TIP_TOKENS: 'JPYC,DOGE' }, 137, { log }), [])
  assert.match(logs.pop(), /PUBLIC_EVM_TIP_TOKENS is invalid/)
  assert.deepEqual(evm.EVM_TIP_TOKENS, [], 'off in the test process')
})

// The server runs under SES lockdown. viem's root entry throws there, so evm-gating must only load subpaths.
test('evm gating loads and verifies under SES lockdown', () => {
  const script = `
    import 'ses'
    await import(${JSON.stringify(new URL('../src/core/lockdown.js', import.meta.url).href)})
    const evm = await import(${JSON.stringify(new URL('../src/server/evm-gating.js', import.meta.url).href)})
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount('0x' + '33'.repeat(32))
    const challenge = evm.buildEvmChallenge(account.address, { host: 'world.example', uri: 'https://world.example', chainId: 137, now: Date.now() })
    const signature = await account.signMessage({ message: challenge.message })
    const result = await evm.checkEvmChallenge(challenge, { address: account.address, signature, nonce: challenge.nonce }, Date.now())
    console.log(JSON.stringify(result))
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, PUBLIC_EVM_CHAIN_IDS: '' },
  })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').pop()), { ok: true, reason: 'ok' })
})
