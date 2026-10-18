// Local throwaway-world suite; the parent watchdog also bounds frozen renderers and cleanup.
// usage: node test/e2e/token-gate.mjs --engine=chromium|webkit|firefox [--port=3127]
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nacl from 'tweetnacl'
import { PublicKey } from '@solana/web3.js'
import { ACCOUNT_SIZE, AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'

import {
  APPS_DIR,
  BUILD_ROOT,
  TIMEOUT_SCALE,
  arg,
  createResults,
  ensureOut,
  eq,
  ok,
  sleep,
  waitUntil,
} from './lib/common.mjs'
import { becomeAdmin, launchBrowser } from './lib/browser.mjs'
import { installAsset, startServer, worldAssetsDir } from './lib/server.mjs'
import { WireClient } from './lib/ws.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3127))
const PREFIX = path.join(ensureOut(), `token-gate-${ENGINE}`)
const SUITE_SECONDS = 480
const SENTINEL = 'E2E_SENTINEL'
const RPC_SENTINEL = `https://sentinel.invalid/?api-key=${SENTINEL}`
const MINT = new PublicKey(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71)).publicKey)
const MINIMUM = 10000
const LOW = 100
const HIGH = 20000
// Server TTL 1s + client TTL 5s, with margin; also outlasts the server's 5s negative cache.
const CACHE_WAIT_MS = 6500
const DOOR = 'token-door'
const NOISE = /WebGL|GPU|swiftshader|favicon|livekit|ERR_|Failed to load resource/i
const require = createRequire(import.meta.url)
const naclSource = fs.readFileSync(require.resolve('tweetnacl/nacl-fast.js'), 'utf8')

if (arg('watchdog-child', false) === true) {
  if (!process.send) throw new Error('run through the parent watchdog')
  await runSuite()
} else {
  runWatchdog()
}

function runWatchdog() {
  const child = fork(fileURLToPath(import.meta.url), [...process.argv.slice(2), '--watchdog-child'], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  let worldDir
  let stopped = false
  let descendants = []
  // Playwright can give browsers their own process groups. Track the complete descendant tree,
  // including renderer/utility processes, before killing anything that would orphan them.
  const scan = () => {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 })
      .trim()
      .split('\n')
      .map(line => line.trim().split(/\s+/).map(Number))
    const found = new Set([child.pid])
    for (let changed = true; changed; ) {
      changed = false
      for (const [pid, ppid] of rows) {
        if (found.has(ppid) && !found.has(pid)) {
          found.add(pid)
          changed = true
        }
      }
    }
    descendants = [...new Set([...descendants, ...found])].filter(pid => rows.some(row => row[0] === pid))
  }
  const stop = (code, reason) => {
    if (stopped) return
    stopped = true
    clearTimeout(deadline)
    clearInterval(monitor)
    if (reason) {
      console.error(`FAIL  parent watchdog: ${reason}`)
      fs.writeFileSync(`${PREFIX}-watchdog.log`, `${reason}\n`)
    }
    try {
      scan()
    } catch (err) {
      console.error(`process scan failed: ${err.message}`)
      code = 1
    }
    for (const pid of descendants.reverse()) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL')
        } catch {
          // Already exited, or this PID is not a process-group leader.
        }
      }
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The worker may already have exited.
    }
    if (worldDir) fs.rmSync(worldDir, { recursive: true, force: true })
    process.exit(code)
  }
  const deadline = setTimeout(
    () => stop(1, `suite exceeded its ${SUITE_SECONDS}s deadline (scaled)`),
    SUITE_SECONDS * 1000 * TIMEOUT_SCALE
  )
  const monitor = setInterval(() => {
    try {
      scan()
    } catch (err) {
      stop(1, `cannot monitor child processes: ${err.message}`)
    }
  }, 1000)
  child.on('message', message => {
    if (message.type === 'world') worldDir = message.worldDir
    if (message.type === 'deadline') stop(1, message.label)
    if (message.type === 'complete') stop(message.code)
  })
  child.on('error', err => stop(1, err.message))
  child.on('exit', (code, signal) => stop(1, `worker exited without completion (${code ?? signal})`))
  process.on('SIGINT', () => stop(1, 'interrupted'))
  process.on('SIGTERM', () => stop(1, 'terminated'))
}

async function startRpc() {
  const accounts = new Map()
  const calls = []
  const errors = []
  const mock = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    try {
      eq(req.method, 'POST', 'RPC/control uses POST')
      ok(req.headers['content-type']?.startsWith('application/json'), 'JSON content type')
      let body = ''
      for await (const chunk of req) {
        body += chunk
        ok(body.length < 16384, 'bounded mock request')
      }
      const data = JSON.parse(body)
      if (req.url === '/control') {
        const owner = new PublicKey(data.wallet)
        const ata = getAssociatedTokenAddressSync(MINT, owner).toBase58()
        const previous = accounts.get(ata) || { owner, amount: null, outage: false }
        if ('balance' in data) previous.amount = data.balance === null ? null : BigInt(data.balance) * 1000000n
        if ('outage' in data) previous.outage = data.outage === true
        accounts.set(ata, previous)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      eq(req.url, '/', 'RPC path')
      eq(data.jsonrpc, '2.0', 'JSON-RPC version')
      eq(data.method, 'getAccountInfo', 'only the specified RPC method')
      ok(Number.isSafeInteger(data.id), 'integer RPC id')
      eq(data.params?.length, 2, 'RPC params')
      eq(new PublicKey(data.params[0]).toBase58(), data.params[0], 'canonical ATA')
      assert.deepEqual(data.params[1], { encoding: 'base64', commitment: 'confirmed' })
      const account = accounts.get(data.params[0])
      calls.push({ ata: data.params[0], wallet: account?.owner.toBase58(), outage: !!account?.outage, at: Date.now() })
      if (account?.outage) {
        res.writeHead(503)
        res.end(JSON.stringify({ jsonrpc: '2.0', id: data.id, error: { code: -32000, message: 'mock outage' } }))
        return
      }
      let value = null
      if (account && account.amount !== null) {
        const bytes = Buffer.alloc(ACCOUNT_SIZE)
        AccountLayout.encode(
          {
            mint: MINT,
            owner: account.owner,
            amount: account.amount,
            delegateOption: 0,
            delegate: PublicKey.default,
            state: 1,
            isNativeOption: 0,
            isNative: 0n,
            delegatedAmount: 0n,
            closeAuthorityOption: 0,
            closeAuthority: PublicKey.default,
          },
          bytes
        )
        value = {
          executable: false,
          owner: TOKEN_PROGRAM_ID.toBase58(),
          lamports: 2039280,
          rentEpoch: 0,
          data: [bytes.toString('base64'), 'base64'],
        }
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: data.id, result: { context: { slot: 123 }, value } }))
    } catch (err) {
      errors.push(err.message)
      res.writeHead(400)
      res.end(JSON.stringify({ error: err.message }))
    }
  })
  await new Promise((resolve, reject) => {
    mock.once('error', reject)
    mock.listen(0, '127.0.0.1', resolve)
  })
  const port = mock.address().port
  const url = `http://127.0.0.1:${port}/`
  return {
    mock,
    url,
    port,
    calls,
    errors,
    async set(wallet, changes) {
      const response = await fetch(`${url}control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet, ...changes }),
        signal: AbortSignal.timeout(5000 * TIMEOUT_SCALE),
      })
      eq(response.status, 200, 'mock control')
      eq((await response.json()).ok, true, 'mock control applied')
    },
  }
}

function checkSource(text, label) {
  ok(!text.includes(SENTINEL), `RPC credential in ${label}`)
  // Inline maps can hide a sentinel inside base64 even when the JS text itself is clean.
  for (const match of text.matchAll(/sourceMappingURL=(data:[^\s*]+)/g)) {
    const comma = match[1].indexOf(',')
    const meta = match[1].slice(0, comma)
    const body = match[1].slice(comma + 1)
    const decoded = meta.includes(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body)
    ok(!decoded.includes(SENTINEL), `RPC credential in inline map of ${label}`)
  }
}

function servedScripts(dir, prefix = '') {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`
    if (entry.isDirectory()) files.push(...servedScripts(path.join(dir, entry.name), `${relative}/`))
    else if (/\.(?:[cm]?js|map)$/.test(entry.name)) files.push(relative)
  }
  return files
}

async function runSuite() {
  const { record, results, finish } = createResults(`token-gate/${ENGINE}`)
  const evidence = []
  const clients = []
  const requests = []
  const sourceErrors = []
  const sourceChecks = new Set()
  let scannedResponses = 0
  let server
  let browser
  let wire
  let rpc
  const writeLogs = () => {
    for (const client of clients) {
      fs.writeFileSync(`${PREFIX}-${client.label}-console.log`, client.consoleLines.join('\n'))
      fs.writeFileSync(`${PREFIX}-${client.label}-page-errors.log`, client.pageErrors.join('\n'))
    }
    fs.writeFileSync(
      `${PREFIX}-results.json`,
      JSON.stringify({ results, evidence, requests, rpc: rpc?.calls }, null, 2)
    )
  }
  const bounded = async (promise, label, ms = 5000) => {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            writeLogs()
            process.send({ type: 'deadline', label: `${label} exceeded ${ms * TIMEOUT_SCALE}ms` })
            reject(new Error(`${label} timed out`))
          }, ms * TIMEOUT_SCALE)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const evaluate = (client, fn, data) => bounded(client.page.evaluate(fn, data), `${client.label}: evaluate`)
  const wait = (client, fn, message, data, timeout = 20000) =>
    waitUntil(() => evaluate(client, fn, data), { message: `${client.label}: ${message}`, timeout, interval: 100 })
  const key = (client, action, name) =>
    bounded(client.page.keyboard[action](name), `${client.label}: ${action} ${name}`)
  const button = (client, name) =>
    bounded(client.page.getByRole('button', { name, exact: true }).click(), `${client.label}: ${name}`, 15000)
  const check = async (name, fn) => {
    const value = await fn()
    evidence.push({ scenario: name, value: value ?? null })
    record(true, name)
  }
  const serverTime = async () => {
    const response = await fetch(`${server.url}status`, { signal: AbortSignal.timeout(5000 * TIMEOUT_SCALE) })
    eq(response.status, 200, 'server health')
    return (await response.json()).uptime
  }
  const panel = (client, wallet, build) =>
    wait(
      client,
      ({ wallet, build }) =>
        document.querySelector('.solana-wallet-status')?.textContent === wallet &&
        document.querySelector('.solana-build-status')?.textContent === build,
      `panel: ${wallet} / ${build}`,
      { wallet, build }
    )
  const state = client =>
    evaluate(
      client,
      id => {
        const w = window.world
        const entity = w.entities.get(id)
        if (entity?.scriptError) throw new Error(entity.scriptError.message)
        const root = entity.root
        return {
          status: root.get('token-door-status').value,
          hint: root.get('token-door-hint').value,
          balance: root.get('token-door-balance').value,
          left: root.get('LeftDoor').position.toArray(),
          right: root.get('RightDoor').position.toArray(),
          leftRotation: root.get('LeftDoor').rotation.toArray(),
          rightRotation: root.get('RightDoor').rotation.toArray(),
          position: w.entities.player.base.position.toArray(),
          rank: w.entities.player.data.rank,
          verified: w.solana.isVerified(),
          signatures: window.__tokenWallet.signatures,
          frame: w.frame,
          elapsed: window.__tokenTime,
        }
      },
      DOOR
    )
  const simulate = async (client, seconds) => {
    const start = await evaluate(client, () => window.__tokenTime)
    await wait(
      client,
      start => window.__tokenTime >= start,
      `${seconds}s simulated`,
      start + seconds,
      30000 + seconds * 30000
    )
  }
  const prepareWalk = async client => {
    await evaluate(client, () => {
      document.activeElement?.blur?.()
      window.world.entities.player.teleport({ position: [30, 2.05, 2], rotationY: 0 })
    })
    await simulate(client, 0.4)
    const before = await state(client)
    ok(before.position[2] > 1.8 && before.position[2] < 2.2, 'start on approach side')
    return before
  }
  const trigger = async (client, expected) => {
    const checking = await evaluate(
      client,
      id => {
        const root = window.world.entities.get(id).root
        // Call the actual script action; no host-side balance or door-state substitution.
        root.get('token-door-open').onTrigger()
        return root.get('token-door-status').value
      },
      DOOR
    )
    eq(checking, 'CHECKING…', 'action checks asynchronously')
    await wait(
      client,
      ({ id, expected }) => window.world.entities.get(id).root.get('token-door-status').value === expected,
      `door: ${expected}`,
      { id: DOOR, expected }
    )
    return state(client)
  }
  const walk = async (client, crosses) => {
    await evaluate(client, () => {
      document.activeElement?.blur?.()
      window.__tokenTrace = {
        samples: 0,
        minZ: Infinity,
        maxZ: -Infinity,
        maxXError: 0,
        minY: Infinity,
        maxY: -Infinity,
        minPanelX: Infinity,
        maxPanelX: -Infinity,
        crossedOpen: false,
        start: Date.now(),
      }
    })
    await key(client, 'down', 'KeyW')
    try {
      await simulate(client, 1.5)
    } finally {
      await key(client, 'up', 'KeyW')
    }
    const trace = await evaluate(client, () => {
      const trace = window.__tokenTrace
      window.__tokenTrace = null
      return { ...trace, end: Date.now(), position: window.world.entities.player.base.position.toArray() }
    })
    ok(trace.samples >= 10, `movement sampled every update (${trace.samples})`)
    ok(trace.maxXError < 0.25, `walk stays inside the doorway: ${trace.maxXError}`)
    ok(trace.minY > 1.9 && trace.maxY < 2.3, `walk stays on the floor: ${trace.minY}..${trace.maxY}`)
    if (crosses) {
      ok(trace.minZ < -0.4 && trace.crossedOpen, `crossed plane while locally open: ${JSON.stringify(trace)}`)
    } else {
      ok(trace.minZ >= 0, `never crossed door plane z=0: ${JSON.stringify(trace)}`)
      ok(trace.minZ < 0.65 && trace.maxZ - trace.minZ > 1, `actually walked into panel: ${JSON.stringify(trace)}`)
      ok(Math.abs(trace.minPanelX - 0.01) < 1e-6 && Math.abs(trace.maxPanelX - 0.01) < 1e-6, 'panel stayed closed')
    }
    return trace
  }
  const openClient = async (label, seedByte) => {
    const seed = Array(32).fill(seedByte)
    const address = new PublicKey(nacl.sign.keyPair.fromSeed(Uint8Array.from(seed)).publicKey).toBase58()
    const context = await bounded(
      browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' }),
      'context'
    )
    const client = { label, context, address, consoleLines: [], pageErrors: [] }
    clients.push(client)
    context.on('request', request => requests.push({ client: label, url: request.url(), type: request.resourceType() }))
    context.on('response', response => {
      const url = response.url()
      if (response.request().resourceType() !== 'script' && !/\.(?:[cm]?js|map)(?:[?#]|$)/.test(url)) return
      const check = bounded(response.body(), `response body: ${url}`, 30000)
        .then(bytes => {
          checkSource(bytes.toString('utf8'), url)
          scannedResponses++
        })
        .catch(err => sourceErrors.push(`${url}: ${err.message}`))
        .finally(() => sourceChecks.delete(check))
      sourceChecks.add(check)
    })
    const page = await bounded(context.newPage(), 'page')
    client.page = page
    page.setDefaultTimeout(15000 * TIMEOUT_SCALE)
    page.on('console', m => client.consoleLines.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', e => client.pageErrors.push(String(e)))
    page.on('websocket', socket => requests.push({ client: label, url: socket.url(), type: 'websocket' }))
    // One init script gives tweetnacl and the provider deterministic ordering before SES/nav.
    await page.addInitScript({
      content: `(() => {
      const module = { exports: {} }
      const loadNacl = () => {
        ${naclSource}
      }
      loadNacl()
      const nacl = module.exports
      const pair = nacl.sign.keyPair.fromSeed(Uint8Array.from(${JSON.stringify(seed)}))
      const publicKey = { toString: () => ${JSON.stringify(address)} }
      window.__tokenWallet = { signatures: 0 }
      window.solana = {
        publicKey,
        async connect() {
          this.publicKey = publicKey
          return { publicKey }
        },
        async signMessage(message) {
          window.__tokenWallet.signatures++
          return { signature: nacl.sign.detached(message, pair.secretKey) }
        },
        async disconnect() { this.publicKey = null }
      }
    })()`,
    })
    await bounded(page.goto(server.url, { waitUntil: 'domcontentloaded' }), 'navigation', 60000)
    await bounded(page.waitForSelector('.sidebar', { timeout: 180000 }), 'sidebar', 185000)
    await wait(
      client,
      () => window.world?.ui?.state?.active && !!window.world.entities.player?.capsule,
      'world ready',
      null,
      60000
    )
    await wait(
      client,
      id => {
        const entity = window.world.entities.get(id)
        if (entity?.scriptError) throw new Error(entity.scriptError.message)
        return !entity?.building && !!entity?.root?.get('token-door-open')?.mounted
      },
      'door installed and mounted',
      DOOR,
      30000
    )
    await evaluate(
      client,
      id => {
        const w = window.world
        window.__tokenTime = 0
        window.__tokenTrace = null
        const update = w.update
        w.update = function (delta, ...rest) {
          const result = update.call(this, delta, ...rest)
          window.__tokenTime += delta
          const trace = window.__tokenTrace
          if (trace) {
            const p = this.entities.player.base.position
            const x = this.entities.get(id).root.get('LeftDoor').position.x
            trace.samples++
            trace.minZ = Math.min(trace.minZ, p.z)
            trace.maxZ = Math.max(trace.maxZ, p.z)
            trace.maxXError = Math.max(trace.maxXError, Math.abs(p.x - 30))
            trace.minY = Math.min(trace.minY, p.y)
            trace.maxY = Math.max(trace.maxY, p.y)
            trace.minPanelX = Math.min(trace.minPanelX, x)
            trace.maxPanelX = Math.max(trace.maxPanelX, x)
            if (p.z < -0.4 && x > 1) trace.crossedOpen = true
          }
          return result
        }
      },
      DOOR
    )
    await bounded(page.locator('#solana-wallet-panel').waitFor({ state: 'visible' }), 'wallet panel')
    return client
  }

  try {
    rpc = await startRpc()
    server = await bounded(
      startServer({
        port: PORT,
        logPath: `${PREFIX}-server.log`,
        env: {
          SOLANA_RPC_URL: rpc.url,
          PUBLIC_TOKEN_MINT: MINT.toBase58(),
          PUBLIC_REQUIRED_TOKEN_AMOUNT: String(MINIMUM),
          TOKEN_BALANCE_TTL_SECONDS: '1',
          PUBLIC_RPC_URL: RPC_SENTINEL,
        },
      }),
      'server startup',
      125000
    )
    process.send({ type: 'world', worldDir: server.worldDir })
    wire = await bounded(new WireClient(PORT, 'token-admin').connect(), 'wire connect', 25000)
    await bounded(wire.becomeAdmin('e2e'), 'wire admin', 15000)
    const script = installAsset(server, path.join(APPS_DIR, 'token-door.js'))
    wire.installApp({
      id: DOOR,
      script,
      model: 'asset://ai.glb',
      position: [30, 2, 0],
      props: {
        type: '1',
        direction: '1',
        slideDistance: '1',
        maxRotation: '45',
        minimumAmount: MINIMUM,
        tokenSymbol: 'COO',
      },
    })
    browser = await bounded(launchBrowser(ENGINE), 'browser launch', 60000)
    const holder = await openClient('holder', 72)
    const visitor = await openClient('visitor', 73)
    const initial = await state(holder)
    await check('(a) unverified: CONNECT WALLET and blocked', async () => {
      await panel(holder, 'ウォレット未接続', 'ビルド権限なし')
      await prepareWalk(holder)
      const result = await trigger(holder, 'CONNECT WALLET')
      eq(result.hint, '右上のウォレットボタンで接続して署名してください', 'wallet hint')
      eq(result.balance, 'Wallet not connected', 'balance label')
      const trace = await walk(holder, false)
      eq(rpc.calls.length, 0, 'unverified visitors never read RPC')
      return trace
    })
    await check('(b) signed below threshold: INSUFFICIENT and blocked', async () => {
      await rpc.set(holder.address, { balance: LOW })
      await button(holder, 'Connect Wallet')
      await panel(holder, `確認済み・残高 ${LOW} COO`, 'ビルド権限なし')
      eq((await state(holder)).signatures, 1, 'real signature once')
      await prepareWalk(holder)
      const result = await trigger(holder, 'INSUFFICIENT COO')
      eq(result.balance, `Your Balance: ${LOW} COO`, 'script balance label')
      return walk(holder, false)
    })
    await rpc.set(holder.address, { balance: HIGH })
    await sleep(CACHE_WAIT_MS)
    await Promise.all([prepareWalk(holder), prepareWalk(visitor)])
    await trigger(holder, 'ACCESS GRANTED')
    await wait(holder, id => window.world.entities.get(id).root.get('LeftDoor').position.x > 1, 'fully open', DOOR)
    // Run both walks together, while only the holder has opened its local colliders.
    const [crossed, blocked] = await Promise.all([walk(holder, true), walk(visitor, false)])
    await check('(c) raised balance after both caches: ACCESS GRANTED and crosses', async () => {
      eq((await state(holder)).rank, 0, 'door balance read alone does not grant builder')
      return crossed
    })
    await check('(d) concurrent second context: closed and blocked', async () => {
      ok(Math.max(crossed.start, blocked.start) < Math.min(crossed.end, blocked.end), 'walks overlapped in real time')
      eq((await state(visitor)).verified, false, 'other wallet remains unverified')
      return blocked
    })
    await waitUntil(
      async () => {
        const value = await state(holder)
        return value.left[0] === initial.left[0] && value.right[0] === initial.right[0]
      },
      { timeout: 120000, message: '3 simulated seconds open, then closes to authored positions' }
    )
    const closed = await state(holder)
    assert.deepEqual(closed.left, initial.left, 'authored left position restored')
    assert.deepEqual(closed.right, initial.right, 'authored right position restored')
    assert.deepEqual(closed.leftRotation, initial.leftRotation, 'authored left rotation preserved')
    assert.deepEqual(closed.rightRotation, initial.rightRotation, 'authored right rotation preserved')

    await check('(f) outage after both caches: TRY AGAIN, blocked, world ticks', async () => {
      await rpc.set(holder.address, { outage: true })
      await sleep(CACHE_WAIT_MS)
      await prepareWalk(holder)
      const before = await state(holder)
      const serverBefore = await serverTime()
      await trigger(holder, 'TRY AGAIN')
      await panel(holder, '確認済み・残高を取得できません', 'ビルド権限なし')
      const trace = await walk(holder, false)
      const after = await state(holder)
      ok(after.frame > before.frame + 10 && after.elapsed > before.elapsed + 1, 'world kept updating during outage')
      await waitUntil(async () => (await serverTime()) > serverBefore, { message: 'server world ticks during outage' })
      ok(
        rpc.calls.some(call => call.wallet === holder.address && call.outage),
        'outage reached RPC'
      )
      return trace
    })
    await rpc.set(holder.address, { outage: false, balance: HIGH })
    await sleep(CACHE_WAIT_MS)
    await check('(g) admin code: wallet verifies and script receives balance', async () => {
      await bounded(becomeAdmin(visitor.page, 'e2e'), 'admin command', 30000)
      await rpc.set(visitor.address, { balance: LOW })
      await button(visitor, 'Connect Wallet')
      await panel(visitor, `確認済み・残高 ${LOW} COO`, 'ビルド権限あり')
      const value = await trigger(visitor, 'INSUFFICIENT COO')
      eq(value.rank, 2, 'raw admin rank')
      eq(value.verified, true, 'admin verified')
      eq(value.balance, `Your Balance: ${LOW} COO`, 'admin script balance')
      eq(value.signatures, 1, 'admin signs once')
      return value
    })
    await check('(h) fresh grant; revoke/recheck refuses; refresh grants without signing', async () => {
      await button(holder, 'Disconnect')
      await panel(holder, 'ウォレット未接続', 'ビルド権限なし')
      await button(holder, 'Connect Wallet')
      await panel(holder, `確認済み・残高 ${HIGH} COO`, 'ビルド権限あり')
      eq((await state(holder)).rank, 1, 'verified rich visitor granted')
      await button(holder, 'Disconnect')
      await panel(holder, 'ウォレット未接続', 'ビルド権限なし')
      await wait(holder, () => window.world.entities.player.data.rank === 0, 'revoke demotion')
      const rpcBefore = rpc.calls.length
      // The UI disables refresh when unverified. Exercise the actual refused packet explicitly.
      eq(await evaluate(holder, () => window.world.network.send('requestBuilderRecheck', {})), true, 'recheck sent')
      // The normal unverified balance API resolves locally. Send a probe id and observe its
      // real reply as an ordering barrier; the ordinary handler still receives every packet.
      const unverified = await bounded(
        holder.page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const network = window.world.network
              const original = network.onTokenBalance
              const id = 0x7fffffff
              const cleanup = () => {
                clearTimeout(timer)
                network.onTokenBalance = original
              }
              const timer = setTimeout(() => {
                cleanup()
                reject(new Error('balance barrier timed out'))
              }, 10000)
              network.onTokenBalance = function (data) {
                original.call(this, data)
                if (data.id === id) {
                  cleanup()
                  resolve(data)
                }
              }
              if (!network.send('tokenBalanceRequest', { id })) {
                cleanup()
                reject(new Error('balance barrier refused'))
              }
            })
        ),
        'unverified balance barrier',
        12000
      )
      assert.deepEqual(unverified, { id: 0x7fffffff, verified: false, known: false, balance: 0 })
      await simulate(holder, 0.3)
      eq((await state(holder)).rank, 0, 'recheck after revoke cannot grant')
      eq(rpc.calls.length, rpcBefore, 'unverified recheck never reads RPC')
      await rpc.set(holder.address, { balance: LOW })
      await sleep(CACHE_WAIT_MS)
      await button(holder, 'Connect Wallet')
      await panel(holder, `確認済み・残高 ${LOW} COO`, 'ビルド権限なし')
      const signatures = (await state(holder)).signatures
      eq(signatures, 3, 'one signature per connection')
      await rpc.set(holder.address, { balance: HIGH })
      await sleep(CACHE_WAIT_MS)
      await button(holder, 'Refresh builder access')
      await panel(holder, `確認済み・残高 ${HIGH} COO`, 'ビルド権限あり')
      const refreshed = await state(holder)
      eq(refreshed.rank, 1, 'signature-free recheck grants')
      eq(refreshed.signatures, signatures, 'refresh did not sign')
      return refreshed
    })
    // Run privacy last so it covers every scenario, context, script and response above.
    await check('(e) no browser RPC requests or credentials in any served JS/map', async () => {
      const urls = new Set(['env.js'])
      for (const file of servedScripts(path.join(BUILD_ROOT, 'build/public'))) urls.add(file)
      for (const file of servedScripts(worldAssetsDir(server))) urls.add(`assets/${file}`)
      for (const relative of urls) {
        const url = new URL(relative.split('/').map(encodeURIComponent).join('/'), server.url).href
        const response = await fetch(url, { signal: AbortSignal.timeout(15000 * TIMEOUT_SCALE) })
        eq(response.status, 200, `served source: ${relative}`)
        checkSource(await response.text(), url)
      }
      await bounded(Promise.all([...sourceChecks]), 'browser source checks', 35000)
      assert.deepEqual(sourceErrors, [], 'all browser JS response bodies scanned')
      ok(scannedResponses > 0, 'browser actually loaded JS')
      const leaked = requests.filter(request => {
        const url = new URL(request.url)
        return url.hostname === 'sentinel.invalid' || url.port === String(rpc.port)
      })
      assert.deepEqual(leaked, [], 'no page/worker request to sentinel or mock RPC port')
      assert.deepEqual(rpc.errors, [], 'exact mock RPC contract')
      return { requests: requests.length, servedFiles: urls.size, scannedResponses, rpcCalls: rpc.calls.length }
    })
    await check('no script, physics or uncaught browser failures', async () => {
      for (const client of clients) {
        assert.deepEqual(client.pageErrors, [], `${client.label}: page errors`)
        assert.deepEqual(
          client.consoleLines.filter(
            line =>
              !NOISE.test(line) &&
              (/^\[error\]/.test(line) || /RuntimeError|script .*crashed|SES_UNCAUGHT|SES_UNHANDLED/.test(line))
          ),
          [],
          `${client.label}: console`
        )
        eq(await evaluate(client, () => !!window.world.fatalError), false, 'world not fatal')
      }
      assert.deepEqual(
        server.lines(/script .*crashed|RuntimeError|SES_UNCAUGHT|SES_UNHANDLED|UnhandledPromiseRejection/),
        [],
        'server errors'
      )
    })
  } catch (err) {
    record(false, 'aborted', err.stack || String(err))
  } finally {
    writeLogs()
    if (results.some(result => !result.ok)) {
      for (const client of clients) {
        if (!client.page || client.page.isClosed()) continue
        await bounded(
          client.page.screenshot({ path: `${PREFIX}-${client.label}-final.png`, timeout: 5000 * TIMEOUT_SCALE }),
          'failure screenshot'
        ).catch(err => client.consoleLines.push(`[screenshot] ${err.message}`))
      }
    }
    wire?.close()
    try {
      if (browser) await bounded(browser.close(), 'browser close', 10000)
      if (server) await bounded(server.stop(), 'server stop', 10000)
      if (rpc) {
        rpc.mock.closeAllConnections()
        await bounded(new Promise(resolve => rpc.mock.close(resolve)), 'RPC close', 10000)
      }
    } catch (err) {
      record(false, 'cleanup', err.message)
    }
    writeLogs()
    process.send({ type: 'complete', code: finish() ? 1 : 0 })
    await new Promise(() => {})
  }
}
