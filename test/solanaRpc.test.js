import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Keypair, PublicKey } from '@solana/web3.js'
import { ACCOUNT_SIZE, AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { createSolanaRpc } from '../src/server/solanaRpc.js'
import { createTokenBalanceService } from '../src/server/tokenBalance.js'

const mint = Keypair.fromSeed(Buffer.alloc(32, 1)).publicKey
const owner = Keypair.fromSeed(Buffer.alloc(32, 2)).publicKey
const other = Keypair.fromSeed(Buffer.alloc(32, 3)).publicKey
const wallet = owner.toBase58()
const url = 'https://rpc.invalid/?api-key=test-secret'
const flush = () => new Promise(resolve => setImmediate(resolve))

function accountValue(fields = {}) {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: 1_234_567n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
      ...fields,
    },
    data
  )
  return {
    executable: false,
    owner: TOKEN_PROGRAM_ID.toBase58(),
    lamports: 2_039_280,
    rentEpoch: 0,
    data: [data.toString('base64'), 'base64'],
  }
}

function payload(id, value = accountValue()) {
  return { jsonrpc: '2.0', id, result: { context: { slot: 123 }, value } }
}

function fixture(reply = request => new Response(JSON.stringify(payload(request.id))), options = {}) {
  const calls = []
  const rpc = createSolanaRpc({
    url,
    mint,
    fetch: async (endpoint, init) => {
      const request = JSON.parse(init.body)
      calls.push({ endpoint, init, request })
      return reply(request, init)
    },
    ...options,
  })
  return { ...rpc, calls }
}

test('RPC: real AccountLayout success and exact ATA request', async () => {
  const f = fixture()
  const controller = new AbortController()
  assert.deepEqual(await f.readRaw(wallet, controller.signal), { exists: true, amount: 1_234_567n })
  const { endpoint, init, request } = f.calls[0]
  assert.equal(endpoint, url)
  assert.equal(init.method, 'POST')
  assert.deepEqual(init.headers, { 'content-type': 'application/json' })
  assert.equal(init.signal, controller.signal)
  assert.deepEqual(request, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [getAssociatedTokenAddressSync(mint, owner).toBase58(), { encoding: 'base64', commitment: 'confirmed' }],
  })
  await f.readRaw(wallet, controller.signal)
  assert.equal(f.calls[1].request.id, 2)
})

test('RPC: null account becomes known zero', async () => {
  const f = fixture(request => new Response(JSON.stringify(payload(request.id, null))))
  assert.deepEqual(await f.readRaw(wallet), { exists: false })
  const service = createTokenBalanceService({ readRaw: f.readRaw, decimals: 6 })
  assert.deepEqual(await service.get(wallet), { known: true, balance: 0 })
})

const invalidPayloads = [
  ['null response', () => null],
  ['array response', () => []],
  ['wrong JSON-RPC version', body => ({ ...body, jsonrpc: '1.0' })],
  ['missing result', ({ id }) => ({ jsonrpc: '2.0', id })],
  ['null result', body => ({ ...body, result: null })],
  ['array result', body => ({ ...body, result: [] })],
  ['string result', body => ({ ...body, result: 'bad' })],
  ['missing value', body => ({ ...body, result: {} })],
  ['boolean value', body => ({ ...body, result: { value: false } })],
  ['number value', body => ({ ...body, result: { value: 0 } })],
  ['string value', body => ({ ...body, result: { value: 'bad' } })],
  ['array value', body => ({ ...body, result: { value: [] } })],
  ['empty value', body => ({ ...body, result: { value: {} } })],
  [
    'wrong program owner',
    body => {
      body.result.value.owner = other.toBase58()
      return body
    },
  ],
  [
    'missing data',
    body => {
      delete body.result.value.data
      return body
    },
  ],
  [
    'non-tuple data',
    body => {
      body.result.value.data = body.result.value.data[0]
      return body
    },
  ],
  [
    'wrong encoding',
    body => {
      body.result.value.data[1] = 'base58'
      return body
    },
  ],
  [
    'extra data element',
    body => {
      body.result.value.data.push('extra')
      return body
    },
  ],
  [
    'non-string base64',
    body => {
      body.result.value.data[0] = 123
      return body
    },
  ],
  [
    'invalid base64',
    body => {
      body.result.value.data[0] += '!'
      return body
    },
  ],
  [
    'truncated data',
    body => {
      body.result.value.data[0] = Buffer.alloc(ACCOUNT_SIZE - 1).toString('base64')
      return body
    },
  ],
  [
    'extended data',
    body => {
      body.result.value.data[0] = Buffer.alloc(ACCOUNT_SIZE + 1).toString('base64')
      return body
    },
  ],
  ['wrong mint', body => ({ ...body, result: { value: accountValue({ mint: other }) } })],
  ['wrong owner', body => ({ ...body, result: { value: accountValue({ owner: other }) } })],
  ['JSON-RPC error', body => ({ ...body, error: { code: -32000, message: 'unavailable' } })],
  ['null error field', body => ({ ...body, error: null })],
  ['id mismatch', body => ({ ...body, id: body.id + 1 })],
  ['string id', body => ({ ...body, id: String(body.id) })],
  [
    'missing id',
    body => {
      delete body.id
      return body
    },
  ],
]

for (const [name, change] of invalidPayloads) {
  test(`RPC: rejects ${name}`, async () => {
    const f = fixture(request => new Response(JSON.stringify(change(payload(request.id)))))
    await assert.rejects(f.readRaw(wallet))
    assert.equal(f.calls.length, 1)
  })
}

test('RPC: rejects malformed JSON and UTF-8', async () => {
  for (const body of ['{', Buffer.from([0xff, 0xfe])]) {
    const f = fixture(() => new Response(body))
    await assert.rejects(f.readRaw(wallet))
  }
})

for (const status of [429, 500, 201]) {
  test(`RPC: HTTP ${status} fails without retries`, async () => {
    let cancelled = 0
    const f = fixture(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++
            },
          }),
          { status }
        )
    )
    await assert.rejects(f.readRaw(wallet), /RPC HTTP failure/)
    assert.equal(f.calls.length, 1)
    assert.equal(cancelled, 1)
  })
}

for (const phase of ['headers', 'body']) {
  test(`RPC: stalled ${phase} aborts at the service deadline`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
    let aborts = 0
    const errors = []
    const f = fixture((_request, { signal }) => {
      if (phase === 'headers') {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborts++
              reject(signal.reason)
            },
            { once: true }
          )
        })
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'))
            signal.addEventListener(
              'abort',
              () => {
                aborts++
                controller.error(signal.reason)
              },
              { once: true }
            )
          },
        })
      )
    })
    const service = createTokenBalanceService({
      decimals: 6,
      maxConcurrent: 1,
      async readRaw(...args) {
        try {
          return await f.readRaw(...args)
        } catch (err) {
          errors.push(err)
          throw err
        }
      },
    })
    const pending = service.get(wallet)
    let settled = false
    pending.then(() => {
      settled = true
    })
    await flush()
    t.mock.timers.tick(4999)
    await flush()
    assert.equal(settled, false)
    assert.equal(aborts, 0)
    t.mock.timers.tick(1)
    assert.deepEqual(await pending, { known: false })
    await flush()
    assert.equal(aborts, 1)
    assert.equal(f.calls[0].init.signal.aborted, true)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].name, 'AbortError')
    const retry = service.get(wallet, { fresh: true })
    assert.equal(f.calls.length, 2, 'aborted fetch settled and released the slot')
    await flush()
    t.mock.timers.tick(5000)
    assert.deepEqual(await retry, { known: false })
    await flush()
  })
}

test('RPC: already-aborted signal never fetches', async () => {
  const f = fixture()
  await assert.rejects(f.readRaw(wallet, AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(f.calls.length, 0)
})

test('RPC: content-length limit cancels before reading', async () => {
  let pulls = 0
  let cancelled = 0
  const f = fixture(
    () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              pulls++
            },
            cancel() {
              cancelled++
            },
          },
          { highWaterMark: 0 }
        ),
        { headers: { 'content-length': '16385' } }
      )
  )
  await assert.rejects(f.readRaw(wallet), /RPC body too large/)
  assert.equal(pulls, 0)
  assert.equal(cancelled, 1)
})

for (const length of [null, '1']) {
  test(`RPC: streamed body limit with content-length=${length}`, async () => {
    let pulls = 0
    let cancelled = 0
    const f = fixture(
      () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                pulls++
                controller.enqueue(new Uint8Array(8192))
              },
              cancel() {
                cancelled++
              },
            },
            { highWaterMark: 0 }
          ),
          { headers: length === null ? {} : { 'content-length': length } }
        )
    )
    await assert.rejects(f.readRaw(wallet), /RPC body too large/)
    assert.equal(pulls, 3, 'running byte count permits the limit, then stops on the first excess chunk')
    assert.equal(cancelled, 1)
  })
}

test('RPC: body exactly at the configurable limit succeeds across chunks', async () => {
  const text = JSON.stringify(payload(1))
  const data = Buffer.from(text)
  const f = fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(data.subarray(0, 10))
            controller.enqueue(data.subarray(10))
            controller.close()
          },
        }),
        { headers: { 'content-length': String(data.length) } }
      ),
    { maxBodyBytes: data.length }
  )
  assert.deepEqual(await f.readRaw(wallet), { exists: true, amount: 1_234_567n })
})

test('RPC: URL precedence and one boot fallback warning', async () => {
  for (const [env, explicit, expected, warningCount] of [
    [{ SOLANA_RPC_URL: url, PUBLIC_RPC_URL: 'https://legacy.invalid/' }, undefined, url, 0],
    [{ PUBLIC_RPC_URL: url }, undefined, url, 1],
    [{}, undefined, 'https://api.devnet.solana.com/', 0],
    [{ SOLANA_RPC_URL: 'https://server.invalid/' }, url, url, 0],
  ]) {
    const warnings = []
    const f = fixture(undefined, {
      env,
      url: explicit,
      log: { warn: message => warnings.push(message), error: () => assert.fail('valid URL failed') },
    })
    assert.equal(warnings.length, warningCount, 'fallback warning is emitted at construction')
    await f.readRaw(wallet)
    await f.readRaw(wallet)
    assert.equal(f.calls[0].endpoint, expected)
    assert.equal(warnings.length, warningCount)
    if (warningCount) assert.equal(warnings[0], 'using PUBLIC_RPC_URL on the server; set SOLANA_RPC_URL')
  }
})

test('RPC: invalid URL fails closed with one redacted boot error', async () => {
  for (const invalid of ['bad-url?api-key=secret', 'file:///tmp/rpc']) {
    const errors = []
    const f = fixture(undefined, {
      url: undefined,
      env: { SOLANA_RPC_URL: invalid, PUBLIC_RPC_URL: url },
      log: { error: message => errors.push(message), warn: () => assert.fail('must not use fallback') },
    })
    assert.equal(errors.length, 1)
    await assert.rejects(f.readRaw(wallet), /invalid RPC URL/)
    await assert.rejects(f.readRaw(wallet), /invalid RPC URL/)
    const service = createTokenBalanceService({ readRaw: f.readRaw, decimals: 6 })
    assert.deepEqual(await service.get(wallet), { known: false })
    assert.equal(f.calls.length, 0)
    assert.equal(errors.length, 1)
    assert.ok(!errors[0].includes('secret'))
    assert.ok(!errors[0].includes(invalid))
  }
})
