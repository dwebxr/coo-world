import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { privateKeyToAccount } from 'viem/accounts'
import { parseSiweMessage } from 'viem/siwe'
import { encodeAbiParameters, hashMessage } from 'viem/utils'
import * as evm from '../src/server/evm-gating.js'
import { readConnectionLimitsEnv } from '../src/server/connectionLimits.js'
import { erc6492CallData } from '../src/server/erc6492.js'
import { RpcError } from '../src/server/evmRpc.js'
import {
  EVM_STATUS_REASONS,
  isEvmAddress,
  isEvmSignature,
  parseEvmChainIds,
  sameEvmAddress,
} from '../src/core/extras/evmChains.js'

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
  for (const signature of ['nope', '0x', '0x123', `0x${'ab'.repeat(4097)}`, 1234, null]) {
    assert.deepEqual(await check({ signature }), { ok: false, reason: 'bad_signature' }, String(signature))
  }
  // not an EOA signature, and no way to check a contract account here
  assert.deepEqual(await check({ signature: '0x1234' }), { ok: false, reason: 'contract_unsupported' })
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
  assert.equal(evm.publicReason('contract_unsupported'), 'contract_unsupported')
  for (const reason of ['unavailable', 'rpc_busy', 'rpc_timeout', 'rpc_error', 'rpc_unexpected']) {
    assert.equal(evm.publicReason(reason), 'unavailable', reason)
  }
  for (const reason of [
    ...new Set(['ok', 'nonce_expired', 'signature_invalid', 'contract_unsupported', 'unavailable']),
  ]) {
    assert.ok(EVM_STATUS_REASONS.includes(evm.publicReason(reason)), reason)
  }
  for (const reason of ['no_nonce', 'nonce_mismatch', 'bad_wallet', 'wallet_mismatch', 'anything']) {
    assert.equal(evm.publicReason(reason), 'bad_request')
  }
})

test('evm session: independent of the Solana wallet session shape', () => {
  assert.deepEqual(evm.createEvmWalletSession(5), {
    generation: 0,
    verified: null,
    verifiedContract: false,
    challenge: null,
    lastChallengeAt: 0,
    challengeCooldownReplied: false,
    receiveTips: false,
    receiveChangedAt: 0,
    intentBucket: { tokens: evm.TIP_INTENT_BURST, at: 5 },
    tickets: new Map(),
  })
})

test('evm tip watch table: two jobs for every connection WS_MAX_SOCKETS and WS_RESERVED_SOCKETS admit', () => {
  const sockets = env => readConnectionLimitsEnv(env).maxSockets + readConnectionLimitsEnv(env).reserved
  assert.equal(evm.TIP_WATCH_PER_SOCKET, 2)
  assert.equal(evm.resolveTipWatchMax({}), 2 * sockets({}))
  assert.equal(evm.resolveTipWatchMax({}), 136, '64 connections and the 4 places kept for ranked users')
  assert.equal(evm.TIP_WATCH_MAX, 136, 'the test process sets no WS_MAX_SOCKETS nor WS_RESERVED_SOCKETS')
  assert.equal(evm.resolveTipWatchMax({ WS_MAX_SOCKETS: '200' }), 408)
  assert.equal(evm.resolveTipWatchMax({ WS_MAX_SOCKETS: '1' }), 10)
  // without kept places, as before there were any
  assert.equal(evm.resolveTipWatchMax({ WS_RESERVED_SOCKETS: '0' }), 128)
  assert.equal(evm.resolveTipWatchMax({ WS_MAX_SOCKETS: '1', WS_RESERVED_SOCKETS: '0' }), 2)
  assert.equal(evm.resolveTipWatchMax({ WS_RESERVED_SOCKETS: '8' }), 144)
  // 2.5 admits three connections: room for the two watches of each
  assert.equal(evm.resolveTipWatchMax({ WS_MAX_SOCKETS: '2.5', WS_RESERVED_SOCKETS: '0' }), 6)
  assert.equal(evm.resolveTipWatchMax({ WS_MAX_SOCKETS: '2.5', WS_RESERVED_SOCKETS: '2' }), 10)
  // 0.2 admits one connection
  assert.equal(evm.resolveTipWatchMax({ WS_MAX_SOCKETS: '0.2', WS_RESERVED_SOCKETS: '0' }), 2)
  // no limit on connections: nothing to derive the table from, so it is 2 x the default WS_MAX_SOCKETS, kept places
  // or not
  assert.equal(evm.resolveTipWatchMax({ WS_MAX_SOCKETS: '0' }), 128)
  assert.equal(evm.resolveTipWatchMax({ WS_MAX_SOCKETS: '0', WS_RESERVED_SOCKETS: '0' }), 128)
  // a value the server refuses at start-up is refused here too, not replaced by a default
  assert.throws(() => evm.resolveTipWatchMax({ WS_MAX_SOCKETS: '-1' }), /\[envs\] WS_MAX_SOCKETS/)
  assert.throws(() => evm.resolveTipWatchMax({ WS_RESERVED_SOCKETS: '9' }), /\[envs\] WS_RESERVED_SOCKETS/)
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

// --- contract accounts (EIP-1271 / EIP-6492), Phase 6 ---

const CONTRACT_SIGNATURE = `0x${'ab'.repeat(300)}`
// a JSON-RPC client stand-in: answer(method, params) gives the result, or throws
function fakeRpc(answer = () => '0x01') {
  const calls = []
  return {
    calls,
    call: async (method, params, signal) => {
      calls.push({ method, params, signal })
      return answer(method, params)
    },
  }
}
const verifierFor = (rpc, opts = {}) => {
  const logs = []
  const verify = evm.createEvmSignatureVerifier({
    rpc,
    timeoutSignal: ms => ({ timeoutMs: ms }),
    log: line => logs.push(line),
    ...opts,
  })
  return { verify, logs }
}
const checkContract = (challenge, verifyContract, signature = CONTRACT_SIGNATURE) =>
  evm.checkEvmChallenge(challenge, { address: account.address, signature, nonce: challenge.nonce }, options.now, {
    verifyContract,
  })

test('evm contract signature: one deployless eth_call of the ERC-6492 validator at latest, bounded in gas and time', async () => {
  const challenge = challengeFor()
  const rpc = fakeRpc()
  const { verify } = verifierFor(rpc)
  assert.deepEqual(await checkContract(challenge, verify), { ok: true, reason: 'ok', contract: true })
  assert.equal(rpc.calls.length, 1)
  const [{ method, params, signal }] = rpc.calls
  assert.equal(method, 'eth_call')
  assert.deepEqual(params, [
    {
      data: erc6492CallData(challenge.address, hashMessage(challenge.message), CONTRACT_SIGNATURE),
      gas: '0x989680',
    },
    'latest',
  ])
  assert.equal(Object.hasOwn(params[0], 'to'), false, 'deployless: no target')
  assert.equal(Object.hasOwn(params[0], 'from'), false)
  assert.deepEqual(signal, { timeoutMs: 8000 })
  assert.equal(evm.createEvmSignatureVerifier({}), null, 'no RPC, no verifier')
})

test('evm contract signature: only 0x01 passes; reverts are a wrong signature; other failures are "unavailable"', async () => {
  const revert = code => () => {
    throw new RpcError(code, { reverted: true })
  }
  const nodeError = code => () => {
    throw new RpcError(code)
  }
  const cases = [
    [() => '0x01', true, 'ok'],
    [() => '0X01', true, 'ok'],
    [() => '0x00', false, 'signature_invalid'],
    [revert(3), false, 'signature_invalid'],
    [revert(-32000), false, 'signature_invalid'],
    [revert(-32015), false, 'signature_invalid'],
    // -32000 without a revert is another failure (a node that cannot read the state, for one)
    [nodeError(-32000), false, 'rpc_error'],
    [nodeError(-32005), false, 'rpc_error'],
    [nodeError(-32602), false, 'rpc_error'],
    [nodeError(-32601), false, 'rpc_error'],
    [() => '0x', false, 'rpc_unexpected'],
    [() => `0x${'0'.repeat(63)}1`, false, 'rpc_unexpected'],
    [() => null, false, 'rpc_unexpected'],
    [
      () => {
        throw new Error('fetch failed https://rpc.example/secret-key')
      },
      false,
      'rpc_error',
    ],
    [
      () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      },
      false,
      'rpc_timeout',
    ],
  ]
  for (const [answer, ok, reason] of cases) {
    const { verify, logs } = verifierFor(fakeRpc(answer))
    const result = await checkContract(challengeFor(), verify)
    assert.deepEqual(result, ok ? { ok, reason, contract: true } : { ok, reason }, String(answer))
    // nothing that could identify the player, the signature or the RPC URL reaches the log
    for (const line of logs) {
      assert.doesNotMatch(line, /0x[0-9a-fA-F]{8,}|secret-key|rpc\.example/i, line)
    }
    if (reason.startsWith('rpc_')) assert.equal(logs.length, 1, `${reason} is logged once`)
  }
  // the same kind is logged once per verifier, a new kind again
  const { verify, logs } = verifierFor(fakeRpc(nodeError(-32005)))
  await checkContract(challengeFor(), verify)
  await checkContract(challengeFor(), verify)
  assert.equal(logs.length, 1)
})

test('evm contract signature: an EOA signature never reaches the RPC; a 65-byte one that does not recover is checked as a contract', async () => {
  const challenge = challengeFor()
  const rpc = fakeRpc(() => '0x01')
  const { verify } = verifierFor(rpc)
  const own = await sign(challenge)
  assert.deepEqual(await checkContract(challenge, verify, own), { ok: true, reason: 'ok' })
  assert.equal(rpc.calls.length, 0, 'the EOA path needs no RPC')
  // a Safe 1-of-1 signs with its owner's key: 65 bytes that recover to the owner, not to the Safe
  const owners = await sign(challenge, other)
  assert.deepEqual(await checkContract(challenge, verify, owners), { ok: true, reason: 'ok', contract: true })
  assert.equal(rpc.calls.length, 1)
  const refusing = verifierFor(fakeRpc(() => '0x00')).verify
  assert.deepEqual(await checkContract(challenge, refusing, owners), { ok: false, reason: 'signature_invalid' })
  // without an RPC: a 65-byte failure is a wrong signature, anything else a contract account we cannot check
  assert.deepEqual(await checkContract(challenge, undefined, owners), { ok: false, reason: 'signature_invalid' })
  assert.deepEqual(await checkContract(challenge, undefined), { ok: false, reason: 'contract_unsupported' })
})

test('evm contract signature: nobody signs in as the zero address, whatever the chain says', async () => {
  const zero = `0x${'0'.repeat(40)}`
  const challenge = evm.buildEvmChallenge(zero, options)
  const rpc = fakeRpc(() => '0x01')
  const { verify } = verifierFor(rpc)
  // the validator's ecrecover yields the zero address for an unrecoverable signature
  const result = await evm.checkEvmChallenge(
    challenge,
    { address: zero, signature: `0x${'00'.repeat(64)}1b`, nonce: challenge.nonce },
    options.now,
    { verifyContract: verify }
  )
  assert.deepEqual(result, { ok: false, reason: 'bad_wallet' })
  assert.equal(rpc.calls.length, 0)
  assert.equal(evm.isZeroAddress(zero), true)
  assert.equal(evm.isZeroAddress(account.address), false)
})

test('evm contract signature: a signature under 32 bytes asks the deployed account directly (EIP-1271)', async () => {
  const challenge = challengeFor()
  const hash = hashMessage(challenge.message)
  const short = '0xabcdef'
  const magic = `0x1626ba7e${'0'.repeat(56)}`
  const cases = [
    [() => magic, { ok: true, reason: 'ok', contract: true }],
    [() => magic.toUpperCase().replace('0X', '0x'), { ok: true, reason: 'ok', contract: true }],
    [() => `0x${'0'.repeat(64)}`, { ok: false, reason: 'signature_invalid' }],
    // no code at the address: an EOA cannot sign with 3 bytes
    [() => '0x', { ok: false, reason: 'signature_invalid' }],
    [
      () => {
        throw new RpcError(3, { reverted: true })
      },
      { ok: false, reason: 'signature_invalid' },
    ],
    [() => '0x01', { ok: false, reason: 'rpc_unexpected' }],
  ]
  for (const [answer, expected] of cases) {
    const rpc = fakeRpc(answer)
    const { verify } = verifierFor(rpc)
    assert.deepEqual(await checkContract(challenge, verify, short), expected, String(answer))
    const [{ params }] = rpc.calls
    assert.deepEqual(params, [
      {
        to: challenge.address,
        data: `0x1626ba7e${encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }], [hash, short]).slice(2)}`,
        gas: '0x989680',
      },
      'latest',
    ])
  }
  // 32 bytes and longer go through the ERC-6492 validator
  const rpc = fakeRpc(() => '0x01')
  await checkContract(challenge, verifierFor(rpc).verify, `0x${'ab'.repeat(32)}`)
  assert.equal(Object.hasOwn(rpc.calls[0].params[0], 'to'), false)
})

test('evm contract signature: the budget refuses at once when 4 checks run or the rate is used up', async () => {
  let clock = 0
  const pending = []
  const rpc = fakeRpc(() => new Promise(resolve => pending.push(resolve)))
  const { verify, logs } = verifierFor(rpc, { now: () => clock })
  const args = { address: account.address, hash: `0x${'11'.repeat(32)}`, signature: CONTRACT_SIGNATURE }
  const running = [1, 2, 3, 4].map(() => verify(args))
  assert.deepEqual(await verify(args), { ok: false, reason: 'rpc_busy' }, 'a fifth at once is refused')
  assert.equal(rpc.calls.length, 4)
  assert.equal(logs.length, 1)
  for (const resolve of pending.splice(0)) resolve('0x01')
  assert.deepEqual(
    await Promise.all(running),
    [1, 2, 3, 4].map(() => ({ ok: true, reason: 'ok' }))
  )
  // slots are back; the bucket (burst 10) has 6 left, then refills at 1 per 2 s
  const answered = fakeRpc(() => '0x01')
  const rated = verifierFor(answered, { now: () => clock })
  for (let i = 0; i < 10; i++) assert.equal((await rated.verify(args)).ok, true, `call ${i + 1}`)
  assert.deepEqual(await rated.verify(args), { ok: false, reason: 'rpc_busy' })
  clock += 2000
  assert.equal((await rated.verify(args)).ok, true, 'one more after 2 s')
  assert.deepEqual(await rated.verify(args), { ok: false, reason: 'rpc_busy' })
  // a failed call gives its slot back too
  const failing = verifierFor(
    fakeRpc(() => {
      throw new Error('down')
    }),
    { maxConcurrent: 1 }
  )
  assert.equal((await failing.verify(args)).reason, 'rpc_error')
  assert.equal((await failing.verify(args)).reason, 'rpc_error', 'not rpc_busy: the slot was released')
})

test('evm contract signature: checkEvmChallenge never rejects, whatever the verifier does', async () => {
  const throwing = async () => {
    throw new Error('boom')
  }
  assert.deepEqual(await checkContract(challengeFor(), throwing), { ok: false, reason: 'rpc_error' })
  assert.deepEqual(await checkContract(challengeFor(), async () => undefined), { ok: false, reason: 'rpc_unexpected' })
  assert.deepEqual(await checkContract(challengeFor(), async () => ({ ok: 'yes' })), {
    ok: false,
    reason: 'rpc_unexpected',
  })
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
    // a contract account's signature, checked through a stand-in RPC
    const verifyContract = evm.createEvmSignatureVerifier({ rpc: { call: async (method, params) => (method === 'eth_call' && params[0].data.length > 3000 ? '0x01' : '0x00') } })
    const contract = await evm.checkEvmChallenge(challenge, { address: account.address, signature: '0x' + 'ab'.repeat(300), nonce: challenge.nonce }, Date.now(), { verifyContract })
    console.log(JSON.stringify(contract))
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, PUBLIC_EVM_CHAIN_IDS: '' },
  })
  assert.equal(run.status, 0, run.stderr)
  const lines = run.stdout.trim().split('\n')
  assert.deepEqual(JSON.parse(lines.at(-2)), { ok: true, reason: 'ok' })
  assert.deepEqual(
    JSON.parse(lines.at(-1)),
    { ok: true, reason: 'ok', contract: true },
    'the contract path runs under lockdown too'
  )
})
