import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RpcError, createEvmRpc, createEvmRpcs } from '../src/server/evmRpc.js'

// A fetch that answers JSON-RPC requests from a handler and records them.
function fakeFetch(handler) {
  const calls = []
  const fetch = async (url, init) => {
    const request = JSON.parse(init.body)
    calls.push({ url, request })
    const reply = await handler(request, calls.length)
    if (reply instanceof Response) return reply
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply }), { status: 200 })
  }
  return { fetch, calls }
}
const silent = () => {
  const lines = []
  return { lines, log: { error: line => lines.push(line), warn: line => lines.push(line) } }
}

test('evm rpc: checks eth_chainId once, then serves calls', async () => {
  const { fetch, calls } = fakeFetch(request =>
    request.method === 'eth_chainId' ? { result: '0x89' } : { result: `${request.method}:${request.params[0]}` }
  )
  const rpc = createEvmRpc({ url: 'https://rpc.example/key', chainId: 137, fetch })
  assert.equal(rpc.enabled, true)
  assert.equal(await rpc.call('eth_blockNumber', ['a']), 'eth_blockNumber:a')
  assert.equal(await rpc.call('eth_blockNumber', ['b']), 'eth_blockNumber:b')
  assert.deepEqual(
    calls.map(c => c.request.method),
    ['eth_chainId', 'eth_blockNumber', 'eth_blockNumber']
  )
  assert.equal(calls[0].url, 'https://rpc.example/key')
  assert.deepEqual(calls[1].request.params, ['a'])
  assert.equal(calls[1].request.jsonrpc, '2.0')
})

test('evm rpc: a chain mismatch disables the endpoint for good', async () => {
  const { log, lines } = silent()
  const { fetch, calls } = fakeFetch(() => ({ result: '0x1' }))
  const rpc = createEvmRpc({ url: 'https://rpc.example/secret-key', chainId: 137, fetch, log })
  await assert.rejects(rpc.call('eth_call', []), /chain mismatch/)
  await assert.rejects(rpc.call('eth_call', []), /chain mismatch/)
  assert.equal(calls.length, 1, 'no further requests')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].includes('secret-key'), false, 'URL never logged')
})

test('evm rpc: a failed chain check is retried after a minute, not on every call', async () => {
  let t = 0
  let fail = true
  const { fetch, calls } = fakeFetch(request => {
    if (request.method === 'eth_chainId' && fail) return new Response('busy', { status: 503 })
    return { result: request.method === 'eth_chainId' ? '0x89' : 'ok' }
  })
  const rpc = createEvmRpc({ url: 'http://127.0.0.1:1/', chainId: 137, fetch, now: () => t })
  await assert.rejects(rpc.call('eth_call', []), /HTTP failure/)
  await assert.rejects(rpc.call('eth_call', []), /chain unknown/)
  assert.equal(calls.length, 1)
  fail = false
  t = 60_000
  assert.equal(await rpc.call('eth_call', []), 'ok')
})

test('evm rpc: malformed, oversized, erroring or mismatched responses are failures', async () => {
  const cases = [
    () => new Response('nope', { status: 500 }),
    () => new Response('not json', { status: 200 }),
    () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: 'x' }), { status: 200 }),
    request => new Response(JSON.stringify({ jsonrpc: '1.0', id: request.id, result: 'x' }), { status: 200 }),
    request => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id }), { status: 200 }),
    () => ({ error: { code: -32000, message: 'execution reverted' } }),
    () => new Response('x'.repeat(300_000), { status: 200 }),
    () => new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
  ]
  for (const [index, make] of cases.entries()) {
    const { fetch } = fakeFetch((request, n) => (n === 1 ? { result: '0x89' } : make(request)))
    const rpc = createEvmRpc({ url: 'https://rpc.example', chainId: 137, fetch })
    await assert.rejects(rpc.call('eth_call', []), undefined, `case ${index}`)
  }
})

test('evm rpc: a JSON-RPC error answer is an RpcError with the code only; transport failures are not', async () => {
  const { fetch } = fakeFetch((request, n) =>
    n === 1 ? { result: '0x89' } : { error: { code: -32601, message: 'the method finalized secret-host' } }
  )
  const rpc = createEvmRpc({ url: 'https://rpc.example', chainId: 137, fetch })
  const error = await rpc.call('eth_getBlockByNumber', ['finalized', false]).catch(err => err)
  assert.ok(error instanceof RpcError)
  assert.equal(error.code, -32601)
  assert.equal(error.message.includes('secret-host'), false, 'node text is not kept')
  // an error next to a result, a non-object error and an HTTP failure are plain failures
  for (const reply of [
    request => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 1, error: {} }), { status: 200 }),
    () => ({ error: 'nope' }),
    () => new Response('busy', { status: 503 }),
  ]) {
    const { fetch } = fakeFetch((request, n) => (n === 1 ? { result: '0x89' } : reply(request)))
    const rpc = createEvmRpc({ url: 'https://rpc.example', chainId: 137, fetch })
    const err = await rpc.call('eth_call', []).catch(err => err)
    assert.ok(err instanceof Error)
    assert.equal(err instanceof RpcError, false)
  }
})

test('evm rpc: an aborted signal stops the request', async () => {
  const { fetch } = fakeFetch(() => ({ result: '0x89' }))
  const rpc = createEvmRpc({ url: 'https://rpc.example', chainId: 137, fetch })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(rpc.call('eth_call', [], controller.signal))
})

test('evm rpc: invalid URLs disable the endpoint without logging them', () => {
  for (const url of ['not a url', 'ftp://rpc.example/key', 'file:///etc/passwd', undefined]) {
    const { log, lines } = silent()
    const rpc = createEvmRpc({ url, chainId: 137, log })
    assert.equal(rpc.enabled, false)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].includes('rpc.example'), false)
  }
})

test('evm rpc: EVM_RPC_URL_<chainId> is read only for configured chains', () => {
  const { log } = silent()
  const rpcs = createEvmRpcs(
    {
      PUBLIC_EVM_CHAIN_IDS: '137,1',
      EVM_RPC_URL_137: 'https://polygon.example',
      EVM_RPC_URL_1: 'bad url',
      EVM_RPC_URL_8453: 'https://base.example',
    },
    { log }
  )
  assert.deepEqual([...rpcs.keys()], [137])
  assert.equal(rpcs.get(137).chainId, 137)
  assert.equal(createEvmRpcs({ EVM_RPC_URL_137: 'https://polygon.example' }, { log }).size, 0)
})
