import { PublicKey } from '@solana/web3.js'
import { ACCOUNT_SIZE, AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'

export function createSolanaRpc({
  env = process.env,
  url,
  mint = env.PUBLIC_TOKEN_MINT,
  fetch = globalThis.fetch,
  log = console,
  maxBodyBytes = 16_384,
} = {}) {
  if (url === undefined) {
    url = env.SOLANA_RPC_URL || env.PUBLIC_RPC_URL || 'https://api.devnet.solana.com'
    if (!env.SOLANA_RPC_URL && env.PUBLIC_RPC_URL) {
      log.warn('using PUBLIC_RPC_URL on the server; set SOLANA_RPC_URL')
    }
  }
  let endpoint
  try {
    endpoint = new URL(url)
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') throw new Error('invalid protocol')
  } catch {
    endpoint = null
    // Never include the URL or parser error: either may contain an RPC credential.
    log.error('[solanaRpc] invalid RPC URL; balance reads disabled')
  }
  let nextId = 0

  async function readRaw(wallet, signal) {
    if (!endpoint) throw new Error('invalid RPC URL')
    signal?.throwIfAborted()
    const tokenMint = new PublicKey(mint)
    const owner = new PublicKey(wallet)
    const ata = getAssociatedTokenAddressSync(tokenMint, owner)
    const id = ++nextId
    const response = await fetch(endpoint.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'getAccountInfo',
        params: [ata.toBase58(), { encoding: 'base64', commitment: 'confirmed' }],
      }),
      signal,
    })

    let reader
    let body
    try {
      signal?.throwIfAborted()
      if (response.status !== 200) throw new Error('RPC HTTP failure')
      const length = response.headers.get('content-length')
      if (length !== null && Number(length) > maxBodyBytes) throw new Error('RPC body too large')
      reader = response.body.getReader()
      const chunks = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        signal?.throwIfAborted()
        if (done) break
        size += value.byteLength
        if (size > maxBodyBytes) throw new Error('RPC body too large')
        chunks.push(value)
      }
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
    } catch (err) {
      // Cancel the fetch body on overflow, including a content-length rejection before reading.
      if (reader) await reader.cancel().catch(() => {})
      else await response.body?.cancel().catch(() => {})
      throw err
    } finally {
      reader?.releaseLock()
    }

    if (!body || body.jsonrpc !== '2.0' || body.id !== id || Object.hasOwn(body, 'error')) {
      throw new Error('invalid RPC response')
    }
    const value = body.result?.value
    if (value === null) return { exists: false }
    if (
      !value ||
      value.owner !== TOKEN_PROGRAM_ID.toBase58() ||
      !Array.isArray(value.data) ||
      value.data.length !== 2 ||
      typeof value.data[0] !== 'string' ||
      value.data[1] !== 'base64'
    ) {
      throw new Error('invalid token account')
    }
    const data = Buffer.from(value.data[0], 'base64')
    if (data.length !== ACCOUNT_SIZE || data.toString('base64') !== value.data[0]) {
      throw new Error('invalid token account data')
    }
    const account = AccountLayout.decode(data)
    if (!account.mint.equals(tokenMint) || !account.owner.equals(owner) || typeof account.amount !== 'bigint') {
      throw new Error('invalid token account fields')
    }
    return { exists: true, amount: account.amount }
  }

  return { readRaw }
}
