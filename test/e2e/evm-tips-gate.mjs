// EVM tips (P2a) and the NFT gate (P3) end to end against the built server, with a mock EVM JSON-RPC.
// - NFT gate over the wire: the docs example app decides with player.getEvmHolding() on the server and
//   answers only the asking player (holder, non-holder, unverified, and a re-check after a revoke).
// - Tips: the sender is a browser with a fake EIP-6963 wallet signing in Node; the recipient is a wire client
//   (a second rendering page loses its socket on slow CI runners). The recipient opts in, the sender sees a Tip
//   button, and the wallet is asked for exactly one ERC-20 transfer to the recipient's verified address. The
//   recipient's panel (the Receive tips switch) is covered in evm-wallet.mjs.
// - Confirmation (P2b): the fake wallet's transaction gets a receipt and a finalized block from the mock RPC;
//   the server confirms it, announces it in chat and fires the server-script `tip` event.
// - What the payer is told (P12): the sending step names the address inside the transfer the wallet is asked for;
//   a wallet that takes the request and then fails without a rejection gives "may have been sent" with no send
//   on offer; a page reloaded while the wallet holds the request says so again from its note in localStorage;
//   when the RPC stops answering the `finalized` tag after the sender signed in, her next send stops on a step
//   that says the world is not confirming tips, with nothing asked of the wallet until she presses Send anyway.
// - NFT door: the OpenPay door example (docs/scripting/examples/nft-door.js) on the token-door fixture's frame
//   and panels, read from the sender's page: the status on load, Open, the store link for a token id she does
//   not hold, and the update after her wallet disconnects.
// - EVM_HOLDING_CONTRACTS: the server is started with the test's NFT contract listed (in another case than the
//   apps write it). A door for a contract that is not listed stays shut for a holder, and the mock RPC is never
//   asked about that contract.
// usage: node test/e2e/evm-tips-gate.mjs [--engine=chromium] [--port=3133]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { getAddress, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  APPS_DIR,
  REPO_ROOT,
  TIMEOUT_SCALE,
  arg,
  createResults,
  ensureOut,
  eq,
  ok,
  sleep,
  waitUntil,
} from './lib/common.mjs'
import { REPORTED_INLINE, launchBrowser, runInlineScript, saveArtifacts } from './lib/browser.mjs'
import { installAsset, startServer, worldAssetsDir } from './lib/server.mjs'
import { WireClient } from './lib/ws.mjs'

const { encodeTransfer, encodeAddressWord, SELECTORS, TRANSFER_TOPIC, encodeUintWord } = await import(
  path.join(REPO_ROOT, 'src/core/extras/evmAbi.js')
)
const { ERC6492_VALIDATOR_BYTECODE } = await import(path.join(REPO_ROOT, 'src/server/erc6492.js'))
// contract account signatures the mock chain answers for: valid, reverted, and an RPC that is rate limited
const SMART_ACCOUNT = '0x5a11000000000000000000000000000000000005'
const SMART_SIGNATURES = { valid: 'ab'.repeat(300), reverts: 'cd'.repeat(300), limited: 'ef'.repeat(300) }

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3133))
const RPC_PORT = PORT + 1
const PREFIX = path.join(ensureOut(), `evm-tips-gate-${ENGINE}`)
const JPYC = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29'
const NFT = '0x00000000000000000000000000000000000c0ffe'
// a contract the operator did not list. The mock chain answers for it exactly as for NFT (Alice holds the token),
// so a server that asked would open the door
const UNLISTED_NFT = '0x0000000000000000000000000000000000decaf0'
const TOKEN_ID = keccak256(toHex('openpay:license:h_e2e'))
const alice = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const bob = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const carol = privateKeyToAccount(`0x${'33'.repeat(32)}`)
const dave = privateKeyToAccount(`0x${'44'.repeat(32)}`)
const holders = new Map([[alice.address.toLowerCase(), 2n]])
// Bob's address as the tip form shows it (first six and last four characters of the EIP-55 form)
const SHORT_BOB = `${bob.address.slice(0, 6)}…${bob.address.slice(-4)}`
// transactions the fake wallets sent: hash → { receipt, block }. Each lands in its own block, finalized at once.
const chainTxs = new Map()
let nextTx = 0
function mine(tx) {
  nextTx++
  const hash = `0x${'ab'.repeat(30)}${nextTx.toString(16).padStart(4, '0')}`
  const number = `0x${(100 + nextTx).toString(16)}`
  const blockHash = `0x${'cd'.repeat(30)}${nextTx.toString(16).padStart(4, '0')}`
  const words = tx.data.slice(10)
  chainTxs.set(hash, {
    receipt: {
      transactionHash: hash,
      status: '0x1',
      blockNumber: number,
      blockHash,
      from: tx.from.toLowerCase(),
      to: tx.to.toLowerCase(),
      logs: [
        {
          address: tx.to.toLowerCase(),
          topics: [TRANSFER_TOPIC, `0x${encodeAddressWord(tx.from)}`, `0x${words.slice(0, 64)}`],
          data: `0x${words.slice(64, 128)}`,
          logIndex: '0x0',
          transactionHash: hash,
          blockHash,
          removed: false,
        },
      ],
    },
    block: { number, hash: blockHash, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` },
  })
  return hash
}

const { step, finish } = createResults(`evm-tips-gate (${ENGINE})`)
const rpcCalls = []
// false: the mock RPC refuses the `finalized` block tag (the watcher then says tips end `no_finality`)
let finalityAnswered = true
let rpc
let server
let browser
let observer
let recipient
const pages = []

// Mock Polygon RPC: chain id, ERC-1155 balanceOf(owner, id) for NFT from the holders table, and receipts,
// blocks and the finalized block for the transactions the fake wallets sent.
function startRpc() {
  rpc = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const request = JSON.parse(body)
      rpcCalls.push(request)
      const reply = result => res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      if (request.method === 'eth_chainId') return reply('0x89')
      if (request.method === 'eth_getTransactionReceipt') return reply(chainTxs.get(request.params[0])?.receipt ?? null)
      if (request.method === 'eth_getTransactionByHash') {
        return reply(chainTxs.has(request.params[0]) ? { hash: request.params[0] } : null)
      }
      if (request.method === 'eth_getBlockByNumber') {
        if (request.params[0] === 'finalized') {
          if (!finalityAnswered) {
            return res.end(
              JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'invalid block tag' } })
            )
          }
          return reply({ number: `0x${(100 + nextTx).toString(16)}` })
        }
        const found = [...chainTxs.values()].find(entry => entry.block.number === request.params[0])
        return reply(found?.block ?? null)
      }
      if (request.method === 'eth_call') {
        const [{ to, data }] = request.params
        // the ERC-6492 validator, run without a target (deployless)
        if (!to && data.startsWith(ERC6492_VALIDATOR_BYTECODE)) {
          const error = (code, message) =>
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message } }))
          if (data.includes(SMART_SIGNATURES.valid)) return reply('0x01')
          if (data.includes(SMART_SIGNATURES.limited)) return error(-32005, 'rate limited')
          return error(-32000, 'execution reverted')
        }
        if ((to === NFT || to === UNLISTED_NFT) && data.startsWith(SELECTORS.balanceOf1155)) {
          const owner = `0x${data.slice(34, 74)}`
          const id = BigInt(`0x${data.slice(74)}`)
          const balance = id === BigInt(TOKEN_ID) ? (holders.get(owner) ?? 0n) : 0n
          return reply(`0x${encodeUintWord(balance)}`)
        }
      }
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'execution reverted' } })
      )
    })
  })
  return new Promise(resolve => rpc.listen(RPC_PORT, '127.0.0.1', resolve))
}

async function wireVerify(wire, account, attempt = 1) {
  wire.send('requestEvmNonce', { address: account.address, attempt })
  const { data } = await wire.waitFor(m => m.method === 'onEvmNonce' && m.data?.attempt === attempt)
  const from = wire.mark()
  wire.send('requestEvmVerify', {
    address: account.address,
    signature: await account.signMessage({ message: data.message }),
    nonce: data.nonce,
    attempt,
  })
  const status = await wire.waitFor(m => m.method === 'onEvmWalletStatus' && m.data?.attempt === attempt, { from })
  eq(status.data.verified, true, 'wire verification')
}

async function gateResult(wire, timeout = 10000) {
  const from = wire.mark()
  wire.send('entityEvent', ['nft-gate', 0, 'nft-gate:check', {}])
  const m = await wire.waitFor(m => m.method === 'onEntityEvent' && m.data?.[2] === 'nft-gate:result', {
    from,
    timeout,
  })
  return m.data[3]
}

const isConnected = page => page.evaluate(() => window.world?.network?.ws?.readyState === 1).catch(() => false)
// the notes of tip requests in a page's localStorage (one key each, src/core/extras/tipOutcome.js)
const storedNotes = page =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter(key => key.startsWith('evmTipRequest:'))
      .map(key => JSON.parse(localStorage.getItem(key)))
  )

// A page that loads while another one renders can lose its socket on a slow runner: the busy page stops
// answering pings and the server drops it (token-gate.mjs retries its admin page for the same reason). A
// dropped page is closed and opened again, up to three times; any other failure is reported as it is.
async function openWallet(account, name) {
  for (let attempt = 1; ; attempt++) {
    const entry = await openPage(account, name)
    try {
      if (await isConnected(entry.page)) {
        await connectWallet(entry)
        if (await isConnected(entry.page)) return entry
      }
    } catch (err) {
      if (await isConnected(entry.page)) throw err
    }
    pages.splice(pages.indexOf(entry), 1)
    await saveArtifacts({ ...entry, prefix: `${PREFIX}-${name}-dropped-${attempt}` }).catch(() => {})
    await entry.context.close().catch(() => {})
    if (attempt === 3) throw new Error(`${name}'s page lost its socket while loading three times`)
    console.log(`note  ${name}'s page lost its socket while loading (attempt ${attempt}); opening it again`)
  }
}

async function connectWallet({ page }) {
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.evm-wallet-status')?.textContent === 'Verified', null, {
    timeout: 30000 * TIMEOUT_SCALE,
  })
}

async function openPage(account, name) {
  // A small viewport keeps the software renderer's share of each frame low, as in token-gate.mjs.
  const context = await browser.newContext({ viewport: { width: 480, height: 320 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(30000 * TIMEOUT_SCALE)
  // pageErrorAt: when each page error arrived (the reload step allows one, in a time window)
  const entry = { page, context, account, consoleLines: [], pageErrors: [], pageErrorAt: [], sent: [] }
  pages.push(entry)
  page.on('console', m => entry.consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => {
    entry.pageErrors.push(String(e))
    entry.pageErrorAt.push(Date.now())
  })
  await page.exposeFunction('__evmSign', hex =>
    account.signMessage({ message: Buffer.from(hex.slice(2), 'hex').toString() })
  )
  // entry.onSend decides what the wallet does with a request it has taken: nothing set, it mines the transfer
  // and answers with the hash; { error } is thrown in the page as the wallet's error; a promise holds the request
  await page.exposeFunction('__evmSend', tx => {
    entry.sent.push(tx)
    return entry.onSend ? entry.onSend(tx) : mine(tx)
  })
  await page.addInitScript({
    content: `(() => {
      const address = ${JSON.stringify(account.address.toLowerCase())}
      // every method this page asked the wallet for, in order
      const asked = (window.__walletAsked = [])
      const provider = {
        async request({ method, params }) {
          asked.push(method)
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address]
          if (method === 'eth_chainId') return '0x89'
          if (method === 'personal_sign') return window.__evmSign(params[0])
          if (method === 'eth_sendTransaction') {
            const answer = await window.__evmSend(params[0])
            if (answer && answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code })
            return answer
          }
          if (method === 'wallet_revokePermissions') return null
          throw Object.assign(new Error('unsupported ' + method), { code: 4200 })
        },
        on() {},
        removeListener() {},
      }
      const info = { uuid: 'e2e-${name}', name: 'E2E Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.e2e' }
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    })()`,
  })
  await page.goto(server.url, { waitUntil: 'domcontentloaded' })
  // unscaled like the other suites: a page that has not drawn its UI by then will not
  await page.waitForSelector('.sidebar', { timeout: 180000 })
  await page.waitForFunction(() => window.world?.ui?.state?.active === true && !!window.world.evm, null, {
    timeout: 60000 * TIMEOUT_SCALE,
  })
  await page.evaluate(name => window.world.entities.player.setName(name), name)
  await page.locator('#solana-wallet-panel').waitFor({ state: 'visible' })
  return entry
}

try {
  await startRpc()
  server = await startServer({
    port: PORT,
    logPath: `${PREFIX}-server.log`,
    env: {
      PUBLIC_EVM_CHAIN_IDS: '137',
      PUBLIC_EVM_TIP_TOKENS: 'JPYC,USDC',
      EVM_RPC_URL_137: `http://127.0.0.1:${RPC_PORT}/`,
      // the contracts player.getEvmHolding may ask about: the test's NFT, written in upper case
      EVM_HOLDING_CONTRACTS: `137:0x${NFT.slice(2).toUpperCase()}`,
    },
  })
  const script = installAsset(server, path.join(REPO_ROOT, 'docs/scripting/examples/nft-gate.js'))

  await step('wire: a smart-contract account signs in through the chain (EIP-1271 / 6492)', async () => {
    const wire = await new WireClient(PORT, 'evm-smart-account').connect()
    try {
      const attempt = async (n, signature) => {
        wire.send('requestEvmNonce', { address: SMART_ACCOUNT, attempt: n })
        const { data } = await wire.waitFor(m => m.method === 'onEvmNonce' && m.data?.attempt === n)
        const from = wire.mark()
        const calls = rpcCalls.length
        wire.send('requestEvmVerify', {
          address: SMART_ACCOUNT,
          signature: `0x${signature}`,
          nonce: data.nonce,
          attempt: n,
        })
        const status = await wire.waitFor(m => m.method === 'onEvmWalletStatus' && m.data?.attempt === n, { from })
        const call = rpcCalls.slice(calls).find(r => r.method === 'eth_call')
        ok(call && !call.params[0].to && call.params[1] === 'latest', 'one deployless eth_call at latest')
        return status.data
      }
      eq(
        JSON.stringify(await attempt(1, SMART_SIGNATURES.reverts)),
        JSON.stringify({ verified: false, attempt: 1, reason: 'signature_invalid' }),
        'a reverting validator is a wrong signature'
      )
      // the nonce cooldown between attempts
      await sleep(5200)
      eq(
        JSON.stringify(await attempt(2, SMART_SIGNATURES.limited)),
        JSON.stringify({ verified: false, attempt: 2, reason: 'unavailable' }),
        'a rate-limited RPC is "unavailable", not a wrong signature'
      )
      await sleep(5200)
      eq(
        JSON.stringify(await attempt(3, SMART_SIGNATURES.valid)),
        // tips are on and the world has a chain RPC: it says that it confirms them
        JSON.stringify({
          verified: true,
          wallet: getAddress(SMART_ACCOUNT),
          attempt: 3,
          reason: 'ok',
          confirmsTips: true,
        }),
        'verified as the contract account'
      )
      ok(!/0x5a11|abababab/i.test(server.out), 'neither the account nor the signature is logged')
    } finally {
      wire.close()
    }
  })

  await step('gate: the docs example decides on the server and answers only the asker', async () => {
    const admin = await new WireClient(PORT, 'gate-admin').connect()
    const holder = await new WireClient(PORT, 'gate-holder').connect()
    const visitor = await new WireClient(PORT, 'gate-visitor').connect()
    const anon = await new WireClient(PORT, 'gate-anon').connect()
    try {
      await admin.becomeAdmin()
      admin.installApp({
        id: 'nft-gate',
        script,
        model: 'asset://ai.glb',
        props: {
          chainId: 137,
          contract: NFT,
          standard: 'erc1155',
          tokenId: TOKEN_ID,
          minBalance: 1,
          welcome: 'welcome, holder',
        },
      })
      await wireVerify(holder, alice)
      await wireVerify(visitor, carol)
      // the app script loads asynchronously on the server; ask until it answers
      const first = await waitUntil(() => gateResult(holder, 1500).catch(() => null), {
        timeout: 30000,
        message: 'gate script answers',
      })
      eq(
        JSON.stringify(first),
        JSON.stringify({ verified: true, known: true, holds: true, message: 'welcome, holder' })
      )
      eq(
        JSON.stringify(await gateResult(visitor)),
        JSON.stringify({ verified: true, known: true, holds: false, message: '' }),
        'non-holder'
      )
      eq(
        JSON.stringify(await gateResult(anon)),
        JSON.stringify({ verified: false, known: false, holds: false, message: '' }),
        'unverified'
      )
      // the welcome text is public (props), but the gate's answer only goes to the player who asked
      ok(
        !visitor.inbox.some(m => m.method === 'onEntityEvent' && m.data?.[3]?.holds === true),
        'the holder answer only reached the holder'
      )
      const call = rpcCalls.find(request => request.method === 'eth_call' && request.params[0].to)
      eq(call.params[0].to, NFT.toLowerCase(), 'contract')
      eq(call.params[1], 'latest', 'block tag')
      ok(call.params[0].data.endsWith(BigInt(TOKEN_ID).toString(16).padStart(64, '0')), 'OpenPay-style token id')
      // A revoke fires the evmWallet event; the example re-checks players who asked.
      const from = holder.mark()
      holder.send('revokeEvmWallet', {})
      const recheck = await holder.waitFor(m => m.method === 'onEntityEvent' && m.data?.[2] === 'nft-gate:result', {
        from,
      })
      eq(recheck.data[3].verified, false, 're-check after revoke')
    } finally {
      for (const wire of [admin, holder, visitor, anon]) wire.close()
    }
  })

  // A third player who only watches: gets the chat announcement and, through a probe app, the `tip` event.
  observer = await new WireClient(PORT, 'tip-observer').connect()
  await observer.becomeAdmin()
  observer.installApp({
    id: 'tip-listener',
    script: installAsset(server, path.join(APPS_DIR, 'tip-listener.js')),
    model: 'asset://ai.glb',
  })

  // The recipient: a verified wire client named Bob.
  recipient = await new WireClient(PORT, 'Bob').connect()
  await wireVerify(recipient, bob)
  const receiving = async enabled => {
    const from = recipient.mark()
    recipient.send('setEvmTipReceive', { enabled })
    await recipient.waitFor(
      m => m.method === 'onEntityModified' && m.data?.id === recipient.id && m.data.evmTips === enabled,
      { from, timeout: 10000 * TIMEOUT_SCALE }
    )
  }

  browser = await launchBrowser(ENGINE)
  const sender = await openWallet(alice, 'Alice')

  await step('tips: opting in shows a Tip button to verified players, without publishing the address', async () => {
    await receiving(true)
    await sender.page.evaluate(() => window.world.ui.togglePane('players'))
    await sender.page
      .getByRole('button', { name: 'Tip Bob' })
      .waitFor({ state: 'visible', timeout: 30000 * TIMEOUT_SCALE })
    const data = await sender.page.evaluate(() =>
      JSON.stringify([...window.world.entities.players.values()].map(player => player.data))
    )
    ok(data.includes('"evmTips":true'), 'boolean published')
    ok(!data.toLowerCase().includes(bob.address.slice(2).toLowerCase()), 'address not in player data')
  })

  await step('tips: the sender wallet is asked for one transfer of exactly 100 JPYC to the recipient', async () => {
    const page = sender.page
    // keyboard: the Tip control is a real button, and Enter opens the form without reaching world controls
    await page.getByRole('button', { name: 'Tip Bob' }).focus()
    await page.keyboard.press('Enter')
    await page.getByLabel('Amount').waitFor({ state: 'visible' })
    ok(await page.evaluate(() => !document.querySelector('.mainchat.active')), 'chat not opened by Enter')
    // beta: the form says so, shows the range, and stops an amount above the maximum before the confirmation
    ok((await page.locator('.tip-beta').innerText()).includes('start with small tips'), 'beta notice')
    eq(await page.getByLabel('Amount').getAttribute('placeholder'), 'min 1 · max 1,000', 'range')
    await page.getByLabel('Amount').fill('1001')
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page
      .getByRole('alert')
      .filter({ hasText: 'The maximum tip is 1,000 JPYC during the beta.' })
      .waitFor({ timeout: 10000 * TIMEOUT_SCALE })
    eq(await page.locator('.tip-confirm').count(), 0, 'no confirmation for 1001 JPYC')
    await page.getByLabel('Amount').fill('100')
    // the message about 1001 goes away with the edit
    await page.locator('.tip-error').waitFor({ state: 'detached', timeout: 10000 * TIMEOUT_SCALE })
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    // the confirmation says the world takes no part and no fee, and links the terms
    const confirm = page.locator('.tip-confirm')
    ok((await confirm.innerText()).includes('not a party to it and takes no fee'), 'no-fee wording')
    eq(await confirm.locator('a.tip-terms').getAttribute('href'), '/terms.html#en', 'terms link')
    // this world has a chain RPC: nothing says that tips are not confirmed; Bob is the only Bob
    eq(await page.locator('.tip-unconfirmed').count(), 0, 'no "not confirming" notice')
    eq(await page.locator('.tip-twin').count(), 0, 'no same-name warning')
    await page.getByRole('button', { name: 'Send tip', exact: true }).click()
    await page
      .getByRole('status')
      .filter({ hasText: `Sent 100 JPYC to Bob (${SHORT_BOB}).` })
      .waitFor({ timeout: 30000 * TIMEOUT_SCALE })
    eq(await page.locator('.tip-marker').count(), 0, 'no notice after a tip whose hash reached the server')
    eq(JSON.stringify(await storedNotes(page)), '[]', 'no note left')
    await page.screenshot({ path: `${PREFIX}-tip-sent.png` })
    const href = await page.getByRole('link', { name: 'View transaction' }).getAttribute('href')
    ok(href.startsWith('https://polygonscan.com/tx/0x'), 'explorer link')
    eq(sender.sent.length, 1, 'one transaction')
    eq(
      JSON.stringify(sender.sent[0]),
      JSON.stringify({
        from: alice.address,
        to: JPYC,
        data: encodeTransfer(bob.address, 100n * 10n ** 18n),
        value: '0x0',
        chainId: '0x89',
      })
    )
  })

  await step('tips: the server confirms the transfer on chain, announces it and tells server scripts', async () => {
    const page = sender.page
    await page
      .locator('.tip-confirmation.confirmed')
      .filter({ hasText: 'Confirmed on chain.' })
      .waitFor({ timeout: 30000 * TIMEOUT_SCALE })
    await page.screenshot({ path: `${PREFIX}-tip-confirmed.png` })
    const [hash] = chainTxs.keys()
    ok(
      rpcCalls.some(r => r.method === 'eth_getTransactionReceipt' && r.params[0] === hash),
      'receipt read'
    )
    ok(
      rpcCalls.some(r => r.method === 'eth_getBlockByNumber' && r.params[0] === 'finalized'),
      'finality read'
    )
    // everyone hears it once, as a system message with names only
    const announced = await observer.waitFor(
      m => m.method === 'onChatAdded' && m.data?.body === 'Alice tipped Bob 100 JPYC',
      { timeout: 30000 * TIMEOUT_SCALE }
    )
    eq(announced.data.fromId ?? null, null, 'system message')
    eq(announced.data.kind, 'tip', 'a tip line, which no script can produce')
    await recipient.waitFor(m => m.method === 'onChatAdded' && m.data?.body === 'Alice tipped Bob 100 JPYC', {
      timeout: 30000 * TIMEOUT_SCALE,
    })
    // a browser takes the announcement as a system message (the sender's own page)
    await page.waitForFunction(
      () => window.world.chat.msgs.some(msg => msg.body === 'Alice tipped Bob 100 JPYC' && msg.fromId == null),
      null,
      { timeout: 30000 * TIMEOUT_SCALE }
    )
    // the server-script event has the amount and the players, not the addresses or the hash
    const seen = await observer.waitFor(m => m.method === 'onEntityEvent' && m.data?.[2] === 'tip-seen', {
      timeout: 30000 * TIMEOUT_SCALE,
    })
    const event = seen.data[3]
    eq(event.frozen, true, 'frozen')
    eq(event.token, 'JPYC')
    eq(event.amount, '100')
    eq(event.units, (100n * 10n ** 18n).toString())
    eq(event.decimals, 18)
    eq(event.chainId, 137)
    eq(event.toPlayerId, recipient.id, 'recipient id')
    eq(event.fromPlayerId, await page.evaluate(() => window.world.entities.player.data.id), 'sender id')
    const text = JSON.stringify(event).toLowerCase()
    ok(!text.includes(alice.address.slice(2).toLowerCase()), 'no sender address')
    ok(!text.includes(bob.address.slice(2).toLowerCase()), 'no recipient address')
    ok(!text.includes(hash.slice(2)), 'no transaction hash')
    await sleep(500)
    eq(
      observer.inbox.filter(m => m.method === 'onChatAdded' && m.data?.body === 'Alice tipped Bob 100 JPYC').length,
      1,
      'announced once'
    )
  })

  await step('tips: opting out removes the Tip button', async () => {
    await receiving(false)
    await sender.page
      .getByRole('button', { name: 'Tip Bob' })
      .waitFor({ state: 'detached', timeout: 30000 * TIMEOUT_SCALE })
    // the form the sender already opened keeps the result of the tip that was sent
    ok(
      await sender.page
        .getByRole('status')
        .filter({ hasText: `Sent 100 JPYC to Bob (${SHORT_BOB}).` })
        .isVisible(),
      'sent result kept'
    )
    ok(await sender.page.getByRole('link', { name: 'View transaction' }).isVisible(), 'link kept')
  })

  await step('tips: a new tip to a player who stopped receiving is refused by the server', async () => {
    const page = sender.page
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByLabel('Amount').waitFor({ state: 'detached' })
    const outcome = await page.evaluate(
      id => window.world.evm.tip({ playerId: id, token: 'JPYC', amount: '1' }),
      recipient.id
    )
    eq(JSON.stringify(outcome), JSON.stringify({ ok: false, reason: 'recipient_unavailable' }))
    eq(sender.sent.length, 1, 'no new transaction')
  })

  // --- what the payer is told about a send (P12) ---
  // Each send below asks the server for an intent: three at once, then one every ten seconds (per connection).
  let lastIntentAt = Date.now()
  const intentBudget = async () => {
    await sleep(Math.max(0, lastIntentAt + 10500 - Date.now()))
    lastIntentAt = Date.now()
  }
  // The mock wallet holding a request, as a person reading the prompt would: `held` answers it.
  let held = null
  const holdSend = () => {
    sender.onSend = () => new Promise(resolve => (held = resolve))
  }
  // Each of these steps starts from a closed form, a wallet that answers and no note, whatever the step before
  // it did: a step that failed half way must not be the reason the next one fails.
  const payerStep = (name, fn) =>
    step(name, async () => {
      try {
        await fn()
      } finally {
        sender.onSend = null
        held?.({ error: { code: 4001, message: 'User rejected the request.' } })
        held = null
        await sender.page
          .evaluate(() => {
            for (const note of window.world?.evm?.getTipMarkers() ?? []) window.world.evm.dismissTipMarker(note.id)
          })
          .catch(() => {})
      }
    })
  // open Bob's form, enter the amount and go to the confirmation step
  const toConfirm = async (page, amount) => {
    // the button toggles the form: one left open is closed first
    if (await page.locator('.tip-form').count()) await page.getByRole('button', { name: 'Tip Bob' }).click()
    await page.locator('.tip-form').waitFor({ state: 'detached', timeout: 10000 * TIMEOUT_SCALE })
    await page.getByRole('button', { name: 'Tip Bob' }).click()
    await page.getByLabel('Amount').fill(amount)
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.locator('.tip-confirm').waitFor({ timeout: 10000 * TIMEOUT_SCALE })
  }
  // the recipient inside an ERC-20 transfer's call data, in the form's short spelling (lower case)
  const shortRecipient = tx => `0x${tx.data.slice(34, 38)}…${tx.data.slice(70, 74)}`

  await payerStep('tips: the sending step shows the address the wallet is asked to pay', async () => {
    const page = sender.page
    // Bob receives again (the server takes a switch back on a second after the last change at the earliest)
    await sleep(1100)
    await receiving(true)
    await page.getByRole('button', { name: 'Tip Bob' }).waitFor({ state: 'visible', timeout: 30000 * TIMEOUT_SCALE })
    await intentBudget()
    holdSend()
    const before = sender.sent.length
    await toConfirm(page, '5')
    await page.getByRole('button', { name: 'Send tip', exact: true }).click()
    const shown = await page.locator('.tip-recipient').innerText({ timeout: 30000 * TIMEOUT_SCALE })
    eq(shown, `To Bob · ${SHORT_BOB}`, 'the name and the short address')
    await waitUntil(() => sender.sent.length === before + 1, { timeout: 30000, message: 'the wallet is asked' })
    const tx = sender.sent.at(-1)
    // what the form shows is what the request holds: the recipient is in the call data, and the request's own
    // "to" is the token contract (which is what a wallet shows as the destination: the form says so)
    eq(shown.split(' · ')[1].toLowerCase(), shortRecipient(tx), 'the address in the transfer')
    eq(tx.data, encodeTransfer(bob.address, 5n * 10n ** 18n), 'the transfer')
    eq(tx.to, JPYC, 'sent to the token contract')
    ok((await page.locator('.tip-wallet-view').innerText()).includes('may show the token contract'), 'the caveat')
    eq(await page.locator('.tip-form button').count(), 0, 'no button while the wallet is asked')
    // the note of the request is written before the wallet answers, and nothing is said while it is open
    const notes = await storedNotes(page)
    eq(notes.length, 1, 'one note')
    const note = notes[0]
    eq(
      JSON.stringify({ ...note, at: typeof note.at, id: /^[0-9a-f]{16}$/.test(note.id) }),
      JSON.stringify({ name: 'Bob', address: SHORT_BOB, amount: '5', token: 'JPYC', at: 'number', id: true }),
      'the note'
    )
    eq(await page.locator('.tip-marker').count(), 0, 'no notice while the request is open')
    held(mine(tx))
    held = null
    await page
      .getByRole('status')
      .filter({ hasText: `Sent 5 JPYC to Bob (${SHORT_BOB}).` })
      .waitFor({ timeout: 30000 * TIMEOUT_SCALE })
    eq(JSON.stringify(await storedNotes(page)), '[]', 'the note is gone with the result')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByLabel('Amount').waitFor({ state: 'detached' })
  })

  await payerStep(
    'tips: a wallet that fails after taking the request: "may have been sent", and no send on offer',
    async () => {
      const page = sender.page
      await intentBudget()
      // not a rejection (no code 4001): a wallet session that dropped after the request went out
      sender.onSend = () => ({ error: { code: -32603, message: 'WalletConnect request failed' } })
      const before = sender.sent.length
      await toConfirm(page, '7')
      await page.getByRole('button', { name: 'Send tip', exact: true }).click()
      const unknown = page.locator('.tip-unknown')
      await unknown.waitFor({ timeout: 30000 * TIMEOUT_SCALE })
      eq(sender.sent.length, before + 1, 'the wallet had taken the request')
      eq(
        await unknown.innerText(),
        `The wallet did not give a clear answer. Your tip of 7 JPYC to Bob (${SHORT_BOB}) may have been sent: check your wallet's activity before trying again.`,
        'the text'
      )
      // the same send is not one press away: no amount, no Next, no Send tip, nothing that says "try again"
      eq(JSON.stringify(await page.locator('.tip-form button').allInnerTexts()), JSON.stringify(['Close']), 'buttons')
      eq(await page.getByLabel('Amount').count(), 0, 'no amount field')
      ok(!/Try again|not sent|Could not send/.test(await page.locator('.tip-form').innerText()), 'not a failure text')
      await page.screenshot({ path: `${PREFIX}-tip-unknown.png` })
      // the notice under the wallet button says the same, and stays when the form is closed
      const marker = page.locator('.tip-marker')
      await marker.waitFor({ timeout: 10000 * TIMEOUT_SCALE })
      ok(
        (await marker.locator('.tip-marker-text').innerText()).startsWith(
          `A tip may have been sent: 7 JPYC to Bob (${SHORT_BOB}).`
        ),
        'the notice'
      )
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByLabel('Amount').waitFor({ state: 'detached' })
      ok(await marker.isVisible(), 'the notice outlives the form')
      // going back through the form is a new tip from its first step
      await page.getByRole('button', { name: 'Tip Bob' }).click()
      eq(await page.getByLabel('Amount').inputValue(), '', 'an empty form')
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await marker.getByRole('button', { name: 'Dismiss', exact: true }).click()
      await marker.waitFor({ state: 'detached', timeout: 10000 * TIMEOUT_SCALE })
      eq(JSON.stringify(await storedNotes(page)), '[]', 'dismissed: the note is removed')
      eq(sender.sent.length, before + 1, 'nothing was sent again')
    }
  )

  // WebKit hides the page it is leaving, and the client starts its background-tick worker (Client.js, from a
  // blob: URL) the first time its page is hidden: the document is gone before the worker loads, which WebKit
  // reports as a page error of the page that was left. Any reload of the world page does this, with or without a
  // tip. Allowed: on WebKit only, that one message for a blob: URL of this world's host, arriving between the
  // start of the reload and the new document's load event, once. Every other page error still fails the last
  // "no page errors" step.
  const allowLeftPageError = (entry, from, to) => {
    if (ENGINE !== 'webkit') return
    // WebKit writes the URL in this message as "blob: ttp://localhost:…/<uuid>"
    const host = new URL(server.url).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const left = new RegExp(`^Cannot load blob: ?h?ttp://${host}/[0-9a-f-]{36} due to access control checks\\.$`)
    const index = entry.pageErrors.findIndex(
      (line, i) => left.test(line) && entry.pageErrorAt[i] >= from && entry.pageErrorAt[i] <= to
    )
    if (index === -1) return
    entry.pageErrors.splice(index, 1)
    entry.pageErrorAt.splice(index, 1)
  }

  // what the page that comes back shows, before any wallet is connected again
  const afterReload = async page => {
    await page.waitForSelector('.sidebar', { timeout: 180000 })
    const marker = page.locator('.tip-marker')
    await marker.waitFor({ timeout: 60000 * TIMEOUT_SCALE })
    eq(
      await marker.locator('.tip-marker-text').innerText(),
      `A tip may have been sent: 3 JPYC to Bob (${SHORT_BOB}). This browser asked your wallet for it and this world did not get the result. Check your wallet's activity before sending it again.`,
      'the notice'
    )
    eq(await page.evaluate(() => window.world.evm.isVerified()), false, 'shown without a sign-in')
    await page.screenshot({ path: `${PREFIX}-tip-marker.png` })
    await marker.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await marker.waitFor({ state: 'detached', timeout: 10000 * TIMEOUT_SCALE })
    eq(JSON.stringify(await storedNotes(page)), '[]', 'the note is removed')
  }

  await payerStep(
    'tips: a page reloaded while the wallet holds the request says that a tip may have been sent',
    async () => {
      const page = sender.page
      await intentBudget()
      // the wallet does not answer this page (the player is in the wallet app when the page is reloaded)
      holdSend()
      const before = sender.sent.length
      await toConfirm(page, '3')
      await page.getByRole('button', { name: 'Send tip', exact: true }).click()
      await page.locator('.tip-recipient').waitFor({ timeout: 30000 * TIMEOUT_SCALE })
      await waitUntil(() => sender.sent.length === before + 1, { timeout: 30000, message: 'the wallet is asked' })
      eq(await page.locator('.tip-marker').count(), 0, 'nothing is said while the request is open')
      const reloadAt = Date.now()
      // when the new document's load event came (the old document's came long ago)
      const loadedAt = page.waitForEvent('load', { timeout: 180000 }).then(
        () => Date.now(),
        () => -Infinity
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
      // the page that asked is gone: its request is never answered
      held = null
      try {
        await afterReload(page)
        allowLeftPageError(sender, reloadAt, await loadedAt)
      } finally {
        // the rest of the suite uses this page as Alice with her wallet verified, whatever this step found
        await page.waitForFunction(() => window.world?.ui?.state?.active === true && !!window.world.evm, null, {
          timeout: 60000 * TIMEOUT_SCALE,
        })
        await page.evaluate(() => window.world.entities.player.setName('Alice'))
        await page.locator('#solana-wallet-panel').waitFor({ state: 'visible' })
        await connectWallet(sender)
      }
      eq(sender.sent.length, before + 1, 'one request, never repeated')
    }
  )

  // The mock RPC stops answering the `finalized` tag after Alice signed in, so her page last heard that the world
  // confirms tips. Another sender's tip (Dave, a wire client) then ends `no_finality`, and the next intent says that
  // the world is not confirming them: Alice's send stops on a step that says so, with nothing asked of her wallet
  // until she presses Send anyway.
  await payerStep(
    'tips: the intent is the first to say the world is not confirming: nothing is asked of the wallet until Send anyway',
    async () => {
      const page = sender.page
      const wire = await new WireClient(PORT, 'Dave').connect()
      try {
        finalityAnswered = false
        await wireVerify(wire, dave)
        const from = wire.mark()
        wire.send('requestEvmTipIntent', { id: 1, to: recipient.id, token: 'JPYC', amount: '1' })
        const { data: intent } = await wire.waitFor(m => m.method === 'onEvmTipIntent' && m.data?.id === 1, { from })
        eq(intent.ok, true, "Dave's intent")
        eq(intent.confirms, true, 'the world still says that it confirms tips')
        // his wallet sends the transfer (mined here) and his client reports it: the watcher finds no finality
        const hash = mine({
          from: dave.address,
          to: JPYC,
          data: encodeTransfer(intent.recipient, BigInt(intent.units)),
        })
        wire.send('evmTip', { ticket: intent.ticket, txHash: hash })
        const status = await wire.waitFor(
          m => m.method === 'onEvmTipStatus' && m.data?.ticket === intent.ticket && m.data.state !== 'watching',
          { from, timeout: 60000 * TIMEOUT_SCALE }
        )
        eq(`${status.data.state}/${status.data.reason}`, 'unverified/no_finality', "Dave's tip")

        eq(await page.evaluate(() => window.world.evm.getTipsConfirmed()), true, 'what Alice last heard')
        await intentBudget()
        // the Players list, which the reload in the step before may have left closed
        const tipBob = page.getByRole('button', { name: 'Tip Bob' })
        if (!(await tipBob.isVisible())) await page.evaluate(() => window.world.ui.togglePane('players'))
        await tipBob.waitFor({ state: 'visible', timeout: 30000 * TIMEOUT_SCALE })
        await toConfirm(page, '2')
        eq(await page.locator('.tip-unconfirmed').count(), 0, 'the confirmation step does not say it')
        const askedBefore = await page.evaluate(() => window.__walletAsked.length)
        const asked = () => page.evaluate(n => JSON.stringify(window.__walletAsked.slice(n)), askedBefore)
        const before = sender.sent.length
        await page.getByRole('button', { name: 'Send tip', exact: true }).click()
        const notice = page.locator('.tip-unconfirmed')
        await notice.waitFor({ timeout: 30000 * TIMEOUT_SCALE })
        eq(
          await notice.innerText(),
          'This world is not confirming tips right now. The transfer still goes through your wallet and may not be confirmed or announced here.',
          'the notice'
        )
        eq(await page.locator('.tip-recipient').innerText(), `To Bob · ${SHORT_BOB}`, 'whom the transfer would name')
        eq(
          JSON.stringify(await page.locator('.tip-form button').allInnerTexts()),
          JSON.stringify(['Send anyway', 'Cancel']),
          'the buttons'
        )
        // the step waits for her: a second later the wallet has been asked nothing
        await sleep(1000)
        eq(await asked(), '[]', 'nothing asked of the wallet')
        eq(sender.sent.length, before, 'no transfer')
        eq(JSON.stringify(await storedNotes(page)), '[]', 'no note')
        await page.screenshot({ path: `${PREFIX}-tip-not-confirming.png` })
        await page.getByRole('button', { name: 'Send anyway', exact: true }).click()
        await page
          .getByRole('status')
          .filter({ hasText: `Sent 2 JPYC to Bob (${SHORT_BOB}).` })
          .waitFor({ timeout: 30000 * TIMEOUT_SCALE })
        eq(await asked(), JSON.stringify(['eth_accounts', 'eth_chainId', 'eth_sendTransaction']), 'then the wallet')
        eq(sender.sent.length, before + 1, 'one transfer')
        eq(sender.sent.at(-1).data, encodeTransfer(bob.address, 2n * 10n ** 18n), 'the transfer')
        // and what became of it, as the world says
        await page
          .locator('.tip-confirmation.unverified')
          .filter({ hasText: 'this world cannot confirm tips right now.' })
          .waitFor({ timeout: 60000 * TIMEOUT_SCALE })
        await page.getByRole('button', { name: 'Close', exact: true }).click()
        await page.getByLabel('Amount').waitFor({ state: 'detached' })
      } finally {
        finalityAnswered = true
        wire.close()
      }
    }
  )

  // The OpenPay door example on the token-door fixture's frame and panels (the owner's model is not in the repo):
  // one door for the NFT Alice holds, one for a token id nobody holds.
  const tokenDoor = fs.readFileSync(path.join(APPS_DIR, 'token-door.js'), 'utf8')
  // written straight into the world's assets (not test/e2e/out, which eslint would read as a source file)
  fs.mkdirSync(worldAssetsDir(server), { recursive: true })
  fs.writeFileSync(
    path.join(worldAssetsDir(server), 'nft-door-e2e.js'),
    tokenDoor.slice(0, tokenDoor.indexOf('app.configure(')) +
      fs.readFileSync(path.join(REPO_ROOT, 'docs/scripting/examples/nft-door.js'), 'utf8')
  )
  const doorScript = 'asset://nft-door-e2e.js'
  const STORE = `http://127.0.0.1:${RPC_PORT}/store?product=h_e2e`
  const doorProps = (tokenId, contract = NFT) => ({
    chainId: 137,
    contract,
    tokenId,
    minBalance: 1,
    passName: 'E2E Pass',
    storeUrl: STORE,
  })
  const doorState = id =>
    sender.page.evaluate(id => {
      const root = window.world.entities.get(id)?.root
      if (!root?.get('nft-door-open')?.mounted) return null
      return {
        sign: root.get('nft-door-status').value,
        hint: root.get('nft-door-hint').value,
        pass: root.get('nft-door-pass').value,
        left: root.get('LeftDoor').position.x,
      }
    }, id)
  const waitDoor = async (id, predicate, message) => {
    let last
    try {
      await waitUntil(
        async () => {
          last = await doorState(id)
          return last && predicate(last)
        },
        { timeout: 30000, message }
      )
    } catch (err) {
      throw new Error(`${err.message} (last: ${JSON.stringify(last)})`)
    }
    return last
  }

  // the holder door's closed position, read on load
  let doorClosedX

  await step('door: a holder sees the pass on load, and the door opens only on Open', async () => {
    observer.installApp({
      id: 'nft-door',
      script: doorScript,
      model: 'asset://ai.glb',
      props: doorProps(TOKEN_ID),
      position: [0, 0, -40],
    })
    observer.installApp({
      id: 'nft-door-none',
      script: doorScript,
      model: 'asset://ai.glb',
      props: doorProps(keccak256(toHex('openpay:license:h_none'))),
      position: [40, 0, -40],
    })
    const loaded = await waitDoor('nft-door', d => d.sign === 'PASS VERIFIED', 'the answer on load')
    eq(loaded.pass, 'Pass: held')
    doorClosedX = loaded.left
    await sleep(1000)
    eq((await doorState('nft-door')).left, loaded.left, 'closed until Open')
    await sender.page.evaluate(() => window.world.entities.get('nft-door').root.get('nft-door-open').onTrigger())
    await waitDoor('nft-door', d => d.sign === 'ACCESS GRANTED' && d.left !== loaded.left, 'the door opening')
    const call = rpcCalls.findLast(r => r.method === 'eth_call' && r.params[0].to === NFT.toLowerCase())
    ok(call.params[0].data.startsWith(SELECTORS.balanceOf1155), 'ERC-1155 balanceOf')
    ok(call.params[0].data.includes(alice.address.slice(2).toLowerCase()), "of Alice's verified address")
  })

  await step('door: a wallet without the pass is offered the store page in a new tab', async () => {
    const none = await waitDoor(
      'nft-door-none',
      d => d.sign === 'NFT PASS REQUIRED' && d.pass === 'No pass · Get it here',
      'the non-holder answer'
    )
    eq(none.hint, `Get the pass: 127.0.0.1:${RPC_PORT}/store`)
    // The store is another origin, so the visitor is asked first (ClientUI.askOpen). window.open is replaced so
    // that no real tab opens: nothing may call it before Open is pressed, and Open works after a second on screen
    await sender.page.evaluate(() => {
      window.__opened = []
      window.__open = window.open
      window.open = (...args) => {
        window.__opened.push(args)
        return null
      }
      window.world.entities.get('nft-door-none').root.get('nft-door-pass-panel').onPointerDown()
    })
    const dialog = sender.page.locator('.link-confirm-dialog')
    let opened
    try {
      await dialog.waitFor({ timeout: 15000 })
      eq(
        await dialog.locator('.link-confirm-host').innerText(),
        `127.0.0.1:${RPC_PORT}`,
        'the host that is asked about'
      )
      eq(await dialog.locator('.link-confirm-address').innerText(), STORE, 'the address that is asked about')
      eq(JSON.stringify(await sender.page.evaluate(() => window.__opened)), '[]', 'nothing opened before the answer')
      await sender.page.waitForSelector('.link-confirm-action.open:not(.waiting)', { timeout: 10000 })
      await dialog.getByRole('button', { name: 'Open' }).click()
      await dialog.waitFor({ state: 'detached', timeout: 5000 })
      opened = await sender.page.evaluate(() => window.__opened)
    } finally {
      await sender.page.evaluate(() => {
        window.open = window.__open
        delete window.__open
        delete window.__opened
      })
    }
    eq(JSON.stringify(opened), JSON.stringify([[STORE, '_blank', 'noopener,noreferrer']]), 'store page in a new tab')
  })

  await step('door: an unlisted contract stays shut for a holder, and the chain is not asked', async () => {
    // the start-up line says what is listed
    eq(
      server.lines(/^\[envs\] player\.getEvmHolding\(\) asks only about /).join('\n'),
      `[envs] player.getEvmHolding() asks only about 137:${NFT} (EVM_HOLDING_CONTRACTS)`,
      'the start-up line'
    )
    const toUnlisted = () => rpcCalls.filter(r => r.method === 'eth_call' && r.params[0].to === UNLISTED_NFT)
    // the same door and the same token id Alice holds, on the unlisted contract
    observer.installApp({
      id: 'nft-door-unlisted',
      script: doorScript,
      model: 'asset://ai.glb',
      props: doorProps(TOKEN_ID, UNLISTED_NFT),
      position: [-40, 0, -40],
    })
    const loaded = await waitDoor(
      'nft-door-unlisted',
      d => d.sign === 'TRY AGAIN' && d.pass === 'Pass: unknown',
      'the "unknown" answer on load'
    )
    // the press shows CHECKING… at once (read in the same turn: the answer needs no chain and comes fast); the
    // sign after it is the answer to the press
    const pressed = await sender.page.evaluate(() => {
      const root = window.world.entities.get('nft-door-unlisted').root
      root.get('nft-door-open').onTrigger()
      return root.get('nft-door-status').value
    })
    eq(pressed, 'CHECKING…', 'the press was taken')
    await waitDoor('nft-door-unlisted', d => d.sign === 'TRY AGAIN', 'the answer to Open')
    // an opening door starts to move with its answer (the holder's door above): this one does not
    await sleep(1000)
    const after = await doorState('nft-door-unlisted')
    eq(after.left, loaded.left, 'the door did not move')
    eq(after.sign, 'TRY AGAIN', 'the sign')
    eq(toUnlisted().length, 0, 'the mock RPC was never asked about the unlisted contract')
    // the operator is told once which contract, and not whose wallet
    const lines = server.lines(/getEvmHolding: a script asked about /)
    eq(lines.length, 1, `one log line (${lines.join(' | ')})`)
    ok(lines[0].includes(`137:${UNLISTED_NFT}, which is not in EVM_HOLDING_CONTRACTS`), 'it names the contract')
    ok(!server.out.toLowerCase().includes(alice.address.slice(2).toLowerCase()), "Alice's address is not in the log")
    // and the mock chain would have said "holds": asked directly, it answers 2 for Alice on that contract
    const answer = await fetch(`http://127.0.0.1:${RPC_PORT}/`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: UNLISTED_NFT,
            data: `${SELECTORS.balanceOf1155}${encodeAddressWord(alice.address)}${encodeUintWord(BigInt(TOKEN_ID))}`,
          },
          'latest',
        ],
      }),
    }).then(response => response.json())
    eq(BigInt(answer.result), 2n, 'the mock chain answers "holds" for the unlisted contract')
  })

  await step('door: disconnecting while the door is open updates both doors, and closing keeps it', async () => {
    // the first step's opening may still be running: a press while the door moves is ignored
    await waitDoor('nft-door', d => d.left === doorClosedX, 'the door closed after the first opening')
    await sender.page.evaluate(() => window.world.entities.get('nft-door').root.get('nft-door-open').onTrigger())
    await waitDoor('nft-door', d => d.sign === 'ACCESS GRANTED', 'the door opening again')
    await sender.page.evaluate(() => window.world.evm.disconnect())
    for (const id of ['nft-door', 'nft-door-none']) {
      const state = await waitDoor(id, d => d.sign === 'CONNECT EVM WALLET', `${id} after the disconnect`)
      eq(state.pass, 'EVM wallet not connected')
    }
    // the door closes on its own; the sign still asks for a wallet
    const after = await waitDoor('nft-door', d => d.left === doorClosedX, 'the door closing')
    eq(after.sign, 'CONNECT EVM WALLET', 'sign after closing')
  })

  await step('browser: no page errors', async () => {
    for (const entry of pages) eq(entry.pageErrors.length, 0, entry.pageErrors.join('\n'))
  })

  // tips and the gate above are inside the policy the page is tried against: no browser posted a report (they are
  // posted a moment after the event)
  await step('the report-only policy: nothing the tips and the gate did is outside it', async () => {
    await sleep(3000)
    eq(server.lines(/\[csp\]/).join('\n'), '')
    // and a report would have come: a script outside the policy runs, and the server writes the report of it
    eq(await runInlineScript(pages[0].page), 1, 'the inline script ran')
    await waitUntil(() => server.lines(REPORTED_INLINE).length === 1, { timeout: 15000, message: 'the report' })
    eq(server.lines(/\[csp\]/).length, 1, 'that report and no other')
  })
} catch (err) {
  console.log(`FAIL  setup -- ${err?.stack || err}`)
  process.exitCode = 1
} finally {
  for (const [index, entry] of pages.entries()) {
    await saveArtifacts({ ...entry, prefix: `${PREFIX}-${index}` }).catch(() => {})
  }
  observer?.close()
  recipient?.close()
  await browser?.close().catch(() => {})
  await server?.stop().catch(() => {})
  rpc?.close()
}
if (finish()) process.exitCode = 1
