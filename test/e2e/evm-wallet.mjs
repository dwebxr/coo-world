// EVM wallet (SIWE) end to end against the built server: the wire protocol round trip, and the browser panel
// with a fake EIP-6963 wallet whose signatures are made in Node.
// usage: node test/e2e/evm-wallet.mjs [--engine=chromium] [--port=3131]
import path from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { parseSiweMessage } from 'viem/siwe'

import { TIMEOUT_SCALE, arg, createResults, ensureOut, eq, ok, sleep, waitUntil } from './lib/common.mjs'
import { launchBrowser, saveArtifacts } from './lib/browser.mjs'
import { startServer } from './lib/server.mjs'
import { WireClient } from './lib/ws.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3131))
const PREFIX = path.join(ensureOut(), `evm-wallet-${ENGINE}`)
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const short = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`

const { step, finish } = createResults(`evm-wallet (${ENGINE})`)
let server
let browser
let page
const consoleLines = []
const pageErrors = []

const hexToText = hex => Buffer.from(hex.slice(2), 'hex').toString('utf8')

try {
  server = await startServer({
    port: PORT,
    logPath: `${PREFIX}-server.log`,
    env: {
      PUBLIC_EVM_CHAIN_IDS: '137',
      PUBLIC_EVM_TIP_TOKENS: 'JPYC,USDC',
      // Solana gating on too, so the panel shows both tabs. Nothing here verifies a Solana wallet, so the
      // unreachable RPC is never called.
      PUBLIC_TOKEN_MINT: '8MXWPUCmxtmaxNSmAve3YvQNAKmAbZJ1XxSnrqN9pump',
      SOLANA_RPC_URL: 'http://127.0.0.1:9/',
    },
  })

  await step('wire: lowercase address gets a SIWE nonce bound to this host and chain', async () => {
    const wire = await new WireClient(PORT, 'evm-wire').connect()
    try {
      wire.send('requestEvmNonce', { address: account.address.toLowerCase(), attempt: 1 })
      const { data } = await wire.waitFor(m => m.method === 'onEvmNonce')
      const parsed = parseSiweMessage(data.message)
      eq(parsed.domain, `localhost:${PORT}`, 'domain is the page host')
      eq(parsed.uri, `http://localhost:${PORT}`, 'uri')
      eq(parsed.chainId, 137, 'chain')
      eq(parsed.address, account.address, 'EIP-55 address')
      eq(parsed.nonce, data.nonce, 'nonce')
      const from = wire.mark()
      wire.send('requestEvmVerify', {
        address: account.address.toLowerCase(),
        signature: await account.signMessage({ message: data.message }),
        nonce: data.nonce,
        attempt: 1,
      })
      const status = await wire.waitFor(m => m.method === 'onEvmWalletStatus', { from })
      eq(
        JSON.stringify(status.data),
        JSON.stringify({ verified: true, wallet: account.address, attempt: 1, reason: 'ok' })
      )
      await sleep(300)
      ok(
        !wire.since(from).some(m => m.method === 'onEntityModified' && m.data?.id === wire.id),
        'verification does not change rank'
      )
    } finally {
      wire.close()
    }
  })

  await step('wire: a signature from another key is refused with a reason', async () => {
    const wire = await new WireClient(PORT, 'evm-forged').connect()
    try {
      wire.send('requestEvmNonce', { address: account.address, attempt: 7 })
      const { data } = await wire.waitFor(m => m.method === 'onEvmNonce')
      wire.send('requestEvmVerify', {
        address: account.address,
        signature: await other.signMessage({ message: data.message }),
        nonce: data.nonce,
        attempt: 7,
      })
      const status = await wire.waitFor(m => m.method === 'onEvmWalletStatus')
      eq(JSON.stringify(status.data), JSON.stringify({ verified: false, attempt: 7, reason: 'signature_invalid' }))
    } finally {
      wire.close()
    }
  })

  await step('wire: an oversized verify packet is dropped by the inbound gate', async () => {
    const wire = await new WireClient(PORT, 'evm-oversized').connect()
    try {
      wire.send('requestEvmNonce', { address: account.address, attempt: 1 })
      const { data } = await wire.waitFor(m => m.method === 'onEvmNonce')
      const from = wire.mark()
      wire.send('requestEvmVerify', {
        address: account.address,
        signature: `0x${'cd'.repeat(600)}`,
        nonce: data.nonce,
        attempt: 1,
      })
      await waitUntil(() => server.count('requestEvmVerify from client') > 0, { message: 'drop log' })
      ok(/requestEvmVerify from client \S+ dropped: \d+ bytes over the 512 byte limit/.test(server.out), 'size drop')
      await sleep(300)
      ok(!wire.since(from).some(m => m.method === 'onEvmWalletStatus'), 'no reply for a dropped packet')
    } finally {
      wire.close()
    }
  })

  browser = await launchBrowser(ENGINE)
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const signed = []
  // The wallet's key stays in Node; the page only sees the signature. Both are on the context, so a later
  // page in it gets the same wallet.
  await context.exposeFunction('__evmSign', async hex => {
    const message = hexToText(hex)
    signed.push(message)
    return account.signMessage({ message })
  })
  await context.addInitScript({
    content: `(() => {
      const listeners = new Map()
      const provider = {
        async request({ method, params }) {
          if (method === 'eth_requestAccounts') return [${JSON.stringify(account.address.toLowerCase())}]
          if (method === 'personal_sign') return window.__evmSign(params[0])
          if (method === 'wallet_revokePermissions') { window.__evmRevoked = (window.__evmRevoked || 0) + 1; return null }
          throw Object.assign(new Error('unsupported ' + method), { code: 4200 })
        },
        on(name, fn) { listeners.set(fn, name) },
        removeListener(name, fn) { listeners.delete(fn) },
      }
      const info = { uuid: 'e2e-wallet', name: 'E2E Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.e2e' }
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    })()`,
  })
  const newPage = async () => {
    page = await context.newPage()
    page.setDefaultTimeout(30000 * TIMEOUT_SCALE)
    page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', e => pageErrors.push(String(e)))
  }
  await newPage()
  // Set once the first page has loaded the world. Without it (Firefox on CI has no WebGL), the later steps
  // fail at once instead of each waiting out its timeouts.
  let worldLoaded = false
  const requireWorld = () => {
    if (!worldLoaded) throw new Error('the world did not load in this browser')
  }
  const openWorld = async () => {
    await page.goto(server.url, { waitUntil: 'domcontentloaded' })
    // unscaled like the other suites: a page that has not drawn its UI by then will not
    await page.waitForSelector('.sidebar', { timeout: 180000 })
    await page.waitForFunction(() => window.world?.ui?.state?.active === true && !!window.world.evm, null, {
      timeout: 60000 * TIMEOUT_SCALE,
    })
    await page.locator('#solana-wallet-panel').waitFor({ state: 'visible' })
  }
  const text = selector => page.locator(selector).textContent({ timeout: 15000 * TIMEOUT_SCALE })
  const waitText = (selector, value) =>
    page.waitForFunction(
      ({ selector, value }) => document.querySelector(selector)?.textContent === value,
      { selector, value },
      { timeout: 30000 * TIMEOUT_SCALE }
    )

  await step('browser: both chains show as tabs and Solana is the default', async () => {
    await openWorld()
    worldLoaded = true
    const tabs = await page.getByRole('tab').allTextContents()
    eq(JSON.stringify(tabs), JSON.stringify(['Solana', 'EVM']), 'tabs')
    eq(await page.getByRole('tab', { name: 'Solana' }).getAttribute('aria-selected'), 'true', 'default tab')
    ok(await page.locator('.solana-wallet-status').isVisible(), 'Solana panel shown')
  })

  await step('browser: EVM tab connects the announced wallet and verifies with SIWE', async () => {
    requireWorld()
    await page.getByRole('tab', { name: 'EVM' }).click()
    eq(await text('.evm-wallet-status'), 'EVM wallet not connected', 'idle status')
    eq(await text('.evm-wallet-network'), 'Sign-in network: Polygon', 'network line')
    await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click()
    await waitText('.evm-wallet-status', 'Verified')
    eq(await text('.evm-wallet-address'), short, 'checksummed short address')
    eq(signed.length, 1, 'one signature')
    eq(parseSiweMessage(signed[0]).domain, `localhost:${PORT}`, 'wallet saw the page host')
    const state = await page.evaluate(() => window.world.evm.getState())
    eq(JSON.stringify(state), JSON.stringify({ status: 'verified', address: account.address, verified: true }))
  })

  await step('browser: Receive tips explains who gets the address and follows the server', async () => {
    requireWorld()
    const box = page.getByLabel(/Receive tips/)
    eq(await box.isChecked(), false, 'off by default')
    ok(
      (await text('.evm-wallet-tips-note')).includes('Anyone in this world who verifies an EVM wallet can get this'),
      'consent text'
    )
    // the switch shows the server's answer (evmTips on the local player), so wait for it instead of check()
    await box.click()
    await page.waitForFunction(() => document.querySelector('.evm-wallet-tips input')?.checked === true)
    eq(await page.evaluate(() => window.world.entities.player.data.evmTips), true, 'server set the flag')
    await box.click()
    await page.waitForFunction(() => document.querySelector('.evm-wallet-tips input')?.checked === false)
    eq(await page.evaluate(() => window.world.entities.player.data.evmTips), false, 'opted out at once')
  })

  await step('browser: the collapsed toggle shows the EVM dot; the tab choice survives a reload', async () => {
    requireWorld()
    await page.getByRole('button', { name: 'Hide wallet panel' }).click()
    const toggle = page.locator('.solana-wallet-toggle')
    ok((await toggle.getAttribute('class')).includes('evm'), 'evm status class')
    ok(await page.locator('.solana-wallet-dot.evm').isVisible(), 'blue dot')
    await toggle.click()
    // A new page in the same context stands in for the reload: same storage, new session. Navigating the
    // running world away makes WebKit report its aborted blob loads as page errors.
    await page.close()
    await newPage()
    await openWorld()
    eq(await page.getByRole('tab', { name: 'EVM' }).getAttribute('aria-selected'), 'true', 'remembered tab')
    // A reload is a new session: verification is per connection and is not restored.
    eq(await text('.evm-wallet-status'), 'EVM wallet not connected', 'fresh session')
  })

  await step('browser: disconnect clears the session and the site permission', async () => {
    requireWorld()
    await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click()
    await waitText('.evm-wallet-status', 'Verified')
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await waitText('.evm-wallet-status', 'EVM wallet not connected')
    eq(await page.evaluate(() => window.__evmRevoked), 1, 'wallet_revokePermissions called')
    eq(await page.evaluate(() => window.world.evm.isVerified()), false)
  })

  await step('browser: no page errors', async () => {
    eq(pageErrors.length, 0, pageErrors.join('\n'))
  })
} catch (err) {
  console.log(`FAIL  setup -- ${err?.stack || err}`)
  process.exitCode = 1
} finally {
  if (page) await saveArtifacts({ page, consoleLines, pageErrors, prefix: PREFIX }).catch(() => {})
  await browser?.close().catch(() => {})
  await server?.stop().catch(() => {})
}
if (finish()) process.exitCode = 1
