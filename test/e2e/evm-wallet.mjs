// EVM wallet (SIWE) end to end against the built server: the wire protocol round trip, and the browser panel
// with a fake EIP-6963 wallet whose signatures are made in Node.
// usage: node test/e2e/evm-wallet.mjs [--engine=chromium] [--port=3131]
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// the ws package can stop answering pings (Node's own WebSocket always answers), like a suspended phone tab
import WebSocket from 'ws'
import { privateKeyToAccount } from 'viem/accounts'
import { parseSiweMessage } from 'viem/siwe'

import { REPO_ROOT, TIMEOUT_SCALE, arg, createResults, ensureOut, eq, ok, sleep, waitUntil } from './lib/common.mjs'
import { REPORTED_INLINE, launchBrowser, runInlineScript, saveArtifacts } from './lib/browser.mjs'
import { startServer } from './lib/server.mjs'
import { WireClient } from './lib/ws.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3131))
const PREFIX = path.join(ensureOut(), `evm-wallet-${ENGINE}`)
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const short = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`
const WC_PROJECT_ID = 'e2e0'.repeat(8)
const WC_URI = `wc:${'ab'.repeat(32)}@2?relay-protocol=irn&symKey=${'cd'.repeat(32)}`

const { PROTOCOL_VERSION, readPacket } = await import(pathToFileURL(path.join(REPO_ROOT, 'src/core/packets.js')))

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
      // a made-up project id: the relay is blocked below, so nothing ever reaches Reown
      PUBLIC_WALLETCONNECT_PROJECT_ID: WC_PROJECT_ID,
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
        // tips are on and this world has no chain RPC: it says at sign-in that it does not confirm them
        JSON.stringify({ verified: true, wallet: account.address, attempt: 1, reason: 'ok', confirmsTips: false })
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
        // past the 8704-byte cap (contract account signatures go up to 4096 bytes)
        signature: `0x${'cd'.repeat(4400)}`,
        nonce: data.nonce,
        attempt: 1,
      })
      await waitUntil(() => server.count('requestEvmVerify from client') > 0, { message: 'drop log' })
      ok(/requestEvmVerify from client \S+ dropped: \d+ bytes over the 8704 byte limit/.test(server.out), 'size drop')
      await sleep(300)
      ok(!wire.since(from).some(m => m.method === 'onEvmWalletStatus'), 'no reply for a dropped packet')
    } finally {
      wire.close()
    }
  })

  // A phone that opens its wallet app often comes back as a reload while its old connection still looks open
  // to the server: iOS suspends or drops the tab without closing the socket.
  await step(
    'wire: a connection that went silent (no pongs) gives way to the same player; a live one does not',
    async () => {
      const first = await new WireClient(PORT, 'evm-phone').connect()
      const token = first.authToken
      let silent
      try {
        // a live window: the newcomer is refused and the first one stays
        const second = await new WireClient(PORT, 'evm-phone-2').open('evm-phone-2', { authToken: token })
        const kick = await second.waitFor(m => m.method === 'onKick', { timeout: 15000 * TIMEOUT_SCALE })
        eq(kick.data, 'duplicate_user', 'live window keeps the player')
        ok(first.isOpen, 'first connection still open')
        second.close()
        first.close()
        const firstClosed = await Promise.race([first.closed, sleep(10000 * TIMEOUT_SCALE).then(() => 'still open')])
        ok(firstClosed !== 'still open', 'the first connection closed')
        // the server lets the player go once the close arrives
        await sleep(500)
        // a suspended tab: connected, but it never answers a ping
        const url = `ws://localhost:${PORT}/ws?authToken=${encodeURIComponent(token)}&name=evm-phone&v=${PROTOCOL_VERSION}`
        silent = new WebSocket(url, { autoPong: false })
        const silentClosed = new Promise(resolve => silent.once('close', code => resolve(code)))
        // bounded: a refused or dropped connection fails the step instead of hanging it
        const snapshot = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no snapshot for the silent client')), 20000 * TIMEOUT_SCALE)
          silent.on('message', data => {
            if (readPacket(new Uint8Array(data))[0] !== 'onSnapshot') return
            clearTimeout(timer)
            resolve()
          })
          silent.once('close', () => reject(new Error('the silent client was closed before its snapshot')))
        })
        await snapshot
        const before = server.count('a silent connection gave way')
        // the reload: the same player joins after one unanswered ping, and the silent connection is closed
        const reload = await new WireClient(PORT, 'evm-phone-3').connect('evm-phone', { authToken: token })
        eq(reload.id, first.id, 'same player')
        // replaced by the takeover (the regular heartbeat check does not log this line)
        eq(server.count('a silent connection gave way'), before + 1, 'replaced by the takeover')
        const closed = await Promise.race([silentClosed, sleep(10000 * TIMEOUT_SCALE).then(() => 'still open')])
        ok(closed !== 'still open', 'the silent connection was closed')
        reload.close()
      } finally {
        first.close()
        silent?.terminate()
      }
    }
  )

  browser = await launchBrowser(ENGINE)
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  // WalletConnect's relay and APIs stay out of reach for every page: CI must not talk to Reown, and the
  // sheet's QR step is driven by hand below
  const blockWalletConnect = async ctx => {
    await ctx.route(/walletconnect\.(org|com)|reown\.com/, route => route.abort())
    await ctx.routeWebSocket(/walletconnect\.(org|com)|reown\.com/, ws => ws.close())
  }
  await blockWalletConnect(context)
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
  // the URLs the current page asked for (the WalletConnect chunk must wait for the player's click)
  let requests = []
  const newPage = async () => {
    page = await context.newPage()
    requests = []
    page.setDefaultTimeout(30000 * TIMEOUT_SCALE)
    page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', e => pageErrors.push(String(e)))
    page.on('request', r => requests.push(r.url()))
  }
  const loadedWalletConnect = () => requests.some(url => /\/chunks\/walletconnect-[A-Z0-9]+\.js$/.test(url))
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
    // the announced wallet and WalletConnect, each by name
    const buttons = await page.locator('.evm-wallet-button.connect').allTextContents()
    eq(JSON.stringify(buttons), JSON.stringify(['E2E Wallet', 'WalletConnect']), 'connect buttons')
    await page.getByRole('button', { name: 'E2E Wallet', exact: true }).click()
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
    // the terms open from the switch, and the server serves them
    const terms = page.locator('.evm-wallet-tips-note a.evm-wallet-terms')
    eq(await terms.getAttribute('href'), '/terms.html#en', 'terms link (the English translation, like the UI)')
    eq(await terms.getAttribute('target'), '_blank', 'terms in a new tab')
    const served = await page.evaluate(async () => {
      const resp = await fetch('/terms.html')
      return { status: resp.status, type: resp.headers.get('content-type'), body: await resp.text() }
    })
    eq(served.status, 200, 'terms served')
    ok(/^text\/html/.test(served.type ?? ''), `terms are html (${served.type})`)
    ok(
      served.body.includes('coo-world 利用規約') &&
        served.body.includes('第3条（投げ銭）') &&
        !served.body.includes('投げゼニ'),
      'terms content (Japanese)'
    )
    ok(served.body.includes('id="en"') && served.body.includes('Article 3 (Tips)'), 'terms content (English)')
    // from the keyboard: Tab reaches the link past the world's controls (WebKit, like Safari, does not tab to
    // links by default, so there the link is focused directly), and Enter opens it without the chat
    if (ENGINE === 'webkit') {
      await terms.focus()
    } else {
      await box.focus()
      await page.keyboard.press('Tab')
      ok(await page.evaluate(() => document.activeElement?.classList.contains('evm-wallet-terms')), 'Tab to Terms')
    }
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press('Enter')])
    await popup.waitForLoadState('domcontentloaded')
    const opened = new URL(popup.url())
    ok(opened.pathname === '/terms.html' && opened.hash === '#en', `Enter opens the terms (${popup.url()})`)
    await popup.close()
    ok(await page.evaluate(() => !document.querySelector('.mainchat.active')), 'chat not opened by Enter')
    // Escape still reaches the panel's own shortcut and folds it; the toggle opens it again
    await terms.focus()
    await page.keyboard.press('Escape')
    await page.locator('.solana-wallet-toggle').waitFor({ state: 'visible', timeout: 5000 * TIMEOUT_SCALE })
    await page.locator('.solana-wallet-toggle').click()
    await page.locator('.evm-wallet-tips').waitFor({ state: 'visible', timeout: 5000 * TIMEOUT_SCALE })
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
    await page.getByRole('button', { name: 'E2E Wallet', exact: true }).click()
    await waitText('.evm-wallet-status', 'Verified')
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await waitText('.evm-wallet-status', 'EVM wallet not connected')
    eq(await page.evaluate(() => window.__evmRevoked), 1, 'wallet_revokePermissions called')
    eq(await page.evaluate(() => window.world.evm.isVerified()), false)
  })

  // Only the start runs for real: the pairing link comes from Reown's relay, which CI never reaches. The
  // sheet's link step is shown with a made-up link, and the wallet side is covered by test/walletConnect.test.js.
  await step('browser: WalletConnect loads only when picked, shows its sheet and cancels quietly', async () => {
    requireWorld()
    await page.evaluate(() => {
      window.__toasts = []
      window.world.on('toast', text => window.__toasts.push(String(text)))
    })
    ok(!loadedWalletConnect(), 'no WalletConnect code before the click')
    await page.getByRole('button', { name: 'WalletConnect', exact: true }).click()
    await page.locator('.wc-sheet').getByText('Connecting to WalletConnect…').waitFor()
    await waitUntil(loadedWalletConnect, { message: 'the WalletConnect chunk' })
    // the chunk ran under lockdown and asked the relay for a pairing
    await page.waitForFunction(() => window.world.evm.getWalletConnectStatus()?.state === 'connecting', null, {
      timeout: 30000 * TIMEOUT_SCALE,
    })
    await page.evaluate(
      uri =>
        window.world.emit('evm:walletconnect', {
          state: 'uri',
          uri,
          qr: 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E',
        }),
      WC_URI
    )
    const sheet = page.locator('.wc-sheet')
    await sheet.getByText('Scan with your wallet app').waitFor()
    ok(await sheet.getByRole('img', { name: 'WalletConnect QR code' }).isVisible(), 'QR shown on a desktop')
    ok(await sheet.getByRole('button', { name: 'Copy link' }).isVisible(), 'copy link')
    eq(await sheet.locator('.wc-wallet').count(), 0, 'no phone wallet links on a desktop')
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await sheet.waitFor({ state: 'detached' })
    await waitText('.evm-wallet-status', 'EVM wallet not connected')
    eq(await page.evaluate(() => window.world.evm.getWalletConnectStatus()?.state), 'idle', 'status idle')
    eq(JSON.stringify(await page.evaluate(() => window.__toasts)), '[]', 'cancel shows no toast')
    ok(await page.getByRole('button', { name: 'E2E Wallet', exact: true }).isEnabled(), 'buttons back')
  })

  await step('browser: an unreachable relay ends the WalletConnect wait with a message', async () => {
    requireWorld()
    await page.getByRole('button', { name: 'WalletConnect', exact: true }).click()
    await page.locator('.wc-sheet').getByText('Connecting to WalletConnect…').waitFor()
    // the adapter gives the relay 20 s to hand out a pairing link
    await page.waitForFunction(() => window.__toasts.length > 0, null, { timeout: 45000 * TIMEOUT_SCALE })
    eq(
      JSON.stringify(await page.evaluate(() => window.__toasts)),
      JSON.stringify(['Could not reach WalletConnect. Check your connection and try again.']),
      'relay toast'
    )
    await page.locator('.wc-sheet').waitFor({ state: 'detached' })
    eq(await text('.evm-wallet-status'), 'EVM wallet not connected', 'idle again')
  })

  await step('browser: no page errors', async () => {
    eq(pageErrors.length, 0, pageErrors.join('\n'))
  })

  // the wallet flows above (an injected provider, the WalletConnect sheet) are inside the policy the page is tried
  // against: no browser posted a report (they are posted a moment after the event)
  await step('the report-only policy: nothing the wallet flows did is outside it', async () => {
    await sleep(3000)
    eq(server.lines(/\[csp\]/).join('\n'), '')
    // and a report would have come: a script outside the policy runs, and the server writes the report of it
    eq(await runInlineScript(page), 1, 'the inline script ran')
    await waitUntil(() => server.lines(REPORTED_INLINE).length === 1, { timeout: 15000, message: 'the report' })
    eq(server.lines(/\[csp\]/).length, 1, 'that report and no other')
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
