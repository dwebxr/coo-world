// e2e extras: the paths a lockdown change could break that the full-stack run does not touch:
// player movement and jumping, a VRM session avatar, builder uploads (.glb/.vrm/.png), an AI create call
// through a mock Anthropic Messages API, and the node-client agent for 60 s.
//
// usage: node test/e2e/gate-extras.mjs --engine=chromium|webkit|firefox [--world=<dir>] [--port=3123] [--agent-seconds=60]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { BUILD_ROOT, TIMEOUT_SCALE, arg, createResults, ensureOut, eq, ok, sleep, waitUntil } from './lib/common.mjs'
import { startServer, worldAssetsDir } from './lib/server.mjs'
import { becomeAdmin, launchBrowser, openWorld, saveArtifacts } from './lib/browser.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3123))
const WORLD_SOURCE = arg('world', null)
const AGENT_SECONDS = Number(arg('agent-seconds', 60))
const OUT = ensureOut()
const { record, step, finish } = createResults(`gate-extras/${ENGINE}`)

// mock Anthropic Messages API: every call returns a tiny valid app script. Like current models, the reply
// starts with a thinking block (empty text by default), so the server must read the text block by type.
let aiCalls = 0
const aiRequests = []
const mock = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => (body += chunk))
  req.on('end', () => {
    aiCalls++
    try {
      aiRequests.push({ url: req.url, beta: req.headers['anthropic-beta'], body: JSON.parse(body) })
    } catch {
      aiRequests.push({ url: req.url, beta: req.headers['anthropic-beta'], body: null })
    }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'mock',
        content: [
          { type: 'thinking', thinking: '', signature: 'mock' },
          { type: 'text', text: 'app.on("update", () => {})' },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    )
  })
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))

let server
let browser
let agent
let handles = {}
try {
  server = await startServer({
    port: PORT,
    worldSource: WORLD_SOURCE,
    logPath: path.join(OUT, `extras-${ENGINE}-server.log`),
    env: {
      AI_API_KEY: 'mock-key',
      AI_MODEL: 'claude-opus-5-5',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
    },
  })
  browser = await launchBrowser(ENGINE)
  const { page, consoleLines, pageErrors, errorLines } = await openWorld(browser, server.url, {
    viewport: { width: 800, height: 600 },
    onPage: h => (handles = h),
  })
  await becomeAdmin(page)
  record(true, `${ENGINE}: server up, browser player is admin`)

  const pos = () => page.evaluate(() => window.world.entities.player.base.position.toArray())
  // movement advances by the (clamped) per-frame delta, not by the clock: a slow headless renderer simulates
  // far less than a wall second per second. Hold keys for simulated seconds, summed from the update deltas.
  await page.evaluate(() => {
    if (window.__e2eSim) return
    const w = window.world
    const update = w.update
    window.__e2eSim = { time: 0 }
    w.update = function (delta, ...rest) {
      window.__e2eSim.time += delta
      return update.call(this, delta, ...rest)
    }
  })
  const simulate = async seconds => {
    const t0 = await page.evaluate(() => window.__e2eSim.time)
    await waitUntil(() => page.evaluate(({ t0, seconds }) => window.__e2eSim.time - t0 >= seconds, { t0, seconds }), {
      timeout: 60000,
      interval: 100,
      message: `${seconds} s of simulated time`,
    })
  }
  await step('walk: hold W for 1.5 simulated seconds', async () => {
    const p0 = await pos()
    await page.keyboard.down('KeyW')
    await simulate(1.5)
    await page.keyboard.up('KeyW')
    await simulate(0.3)
    const p1 = await pos()
    const walked = Math.hypot(p1[0] - p0[0], p1[2] - p0[2])
    ok(walked > 0.5, `moved ${walked.toFixed(2)} m`)
    return `moved ${walked.toFixed(2)} m`
  })
  await step('jump: hold Space for a frame', async () => {
    const y0 = (await pos())[1]
    await page.keyboard.down('Space')
    await simulate(0.2)
    await page.keyboard.up('Space')
    let maxY = y0
    const deadline = Date.now() + 20000
    const t0 = await page.evaluate(() => window.world.time)
    while (Date.now() < deadline) {
      await sleep(50)
      maxY = Math.max(maxY, (await pos())[1])
      if ((await page.evaluate(() => window.world.time)) - t0 >= 1.5) break
    }
    ok(maxY - y0 > 0.3, `rise ${(maxY - y0).toFixed(2)} m`)
    return `rise ${(maxY - y0).toFixed(2)} m`
  })

  const assets = worldAssetsDir(server)
  const smallest = ext =>
    fs
      .readdirSync(assets)
      .filter(f => f.endsWith(ext))
      .sort((a, b) => fs.statSync(path.join(assets, a)).size - fs.statSync(path.join(assets, b)).size)[0]
  // builder uploads: an existing glb and vrm with one extra byte (a new hash), and a 1x1 PNG drawn in-page
  const uploaded = {}
  for (const ext of ['.glb', '.vrm', '.png']) {
    await step(`builder upload ${ext} round trip`, async () => {
      const name = ext === '.png' ? null : smallest(ext)
      ok(ext === '.png' || name, `a ${ext} asset exists`)
      const r = await page.evaluate(
        async ({ name, ext }) => {
          let bytes
          if (ext === '.png') {
            const canvas = document.createElement('canvas')
            canvas.width = 1
            canvas.height = 1
            canvas.getContext('2d').fillRect(0, 0, 1, 1)
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
            bytes = new Uint8Array(await blob.arrayBuffer())
          } else {
            const src = await (await fetch(`/assets/${name}`)).arrayBuffer()
            bytes = new Uint8Array(src.byteLength + 1)
            bytes.set(new Uint8Array(src))
            bytes[src.byteLength] = Math.floor(Math.random() * 256)
          }
          const file = new File([bytes], `e2e${ext}`)
          await window.world.network.upload(file)
          const digest = await crypto.subtle.digest('SHA-256', bytes)
          const hash = Array.from(new Uint8Array(digest))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
          const back = await fetch(`/assets/${hash}${ext}`)
          const got = await back.arrayBuffer()
          return {
            status: back.status,
            sizeOk: got.byteLength === bytes.length,
            size: bytes.length,
            nosniff: back.headers.get('x-content-type-options'),
            hash,
          }
        },
        { name, ext }
      )
      uploaded[ext] = r.hash
      eq(r.status, 200, 'status')
      eq(r.sizeOk, true, 'size')
      eq(r.nosniff, 'nosniff', 'nosniff header')
      return `${(r.size / 1024).toFixed(1)} KB`
    })
  }

  // the uploaded VRM differs from the player's current avatar (the default world only ships avatar.vrm,
  // which the player already wears, and applyAvatar() ignores an unchanged URL)
  await step('session avatar: switch to the uploaded VRM', async () => {
    ok(uploaded['.vrm'], 'a .vrm was uploaded')
    const url = `asset://${uploaded['.vrm']}.vrm`
    const result = await page.evaluate(async url => {
      const p = window.world.entities.player
      const before = p.avatar?.instance || null
      p.setSessionAvatar(url)
      const t0 = Date.now()
      while (Date.now() - t0 < 30000) {
        if (p.data.sessionAvatar === url && p.avatarUrl === url && p.avatar?.instance && p.avatar.instance !== before)
          return { ok: true, ms: Date.now() - t0 }
        await new Promise(r => setTimeout(r, 200))
      }
      return { ok: false, sessionAvatar: p.data.sessionAvatar, avatarUrl: p.avatarUrl, hasAvatar: !!p.avatar?.instance }
    }, url)
    ok(result.ok, JSON.stringify(result))
    return `${url.slice(8, 20)}… in ${result.ms} ms`
  })

  await step('AI create through the mock base URL', async () => {
    const ai = await page.evaluate(async () => {
      const w = window.world
      const bp = {
        id: 'ai-bp',
        version: 0,
        name: 'AI App',
        image: null,
        author: null,
        url: null,
        desc: null,
        model: 'asset://crash-block.glb',
        script: null,
        props: {},
        preload: false,
        public: false,
        locked: false,
        frozen: false,
        unique: false,
        scene: false,
        disabled: false,
      }
      w.blueprints.add(bp, true)
      w.entities.add(
        {
          id: 'ai-app',
          type: 'app',
          blueprint: bp.id,
          position: [0, 0, -3],
          quaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
          mover: null,
          uploader: null,
          pinned: false,
          state: {},
        },
        true
      )
      await new Promise(r => setTimeout(r, 300))
      w.network.send('ai', { name: 'create', blueprintId: 'ai-bp', appId: 'ai-app', prompt: 'a spinning cube' })
      const t0 = Date.now()
      while (Date.now() - t0 < 30000) {
        const b = w.blueprints.get('ai-bp')
        const e = w.entities.get('ai-app')
        if (b?.script && e?.script && !e.scriptError) return { ok: true, script: b.script, ms: Date.now() - t0 }
        await new Promise(r => setTimeout(r, 300))
      }
      const e = w.entities.get('ai-app')
      return { ok: false, script: w.blueprints.get('ai-bp')?.script, error: e?.scriptError?.message }
    })
    ok(ai.ok, JSON.stringify(ai))
    ok(aiCalls >= 1, 'mock called')
    // the generation request asks for the default refusal fallback and sets the effort explicitly
    const generate = aiRequests.find(
      r => r.body?.messages?.[0]?.content?.includes('a spinning cube') && r.body.max_tokens === 16000
    )
    ok(generate, 'generation request seen')
    ok(String(generate.beta).includes('server-side-fallback-2026-07-01'), 'fallback beta header')
    ok(generate.body.fallbacks === 'default', 'default fallbacks')
    ok(generate.body.model === 'claude-opus-5-5', 'model')
    ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(generate.body.output_config?.effort), 'effort')
    return `${aiCalls} mock calls, script ${ai.script}`
  })

  await step(`node-client agent.mjs connected for ${AGENT_SECONDS} s`, async () => {
    const agentScript = path.join(BUILD_ROOT, 'agent.mjs')
    ok(fs.existsSync(path.join(BUILD_ROOT, 'build/world-node-client.js')), 'node-client build present')
    const out = []
    agent = spawn(process.execPath, [agentScript], {
      cwd: BUILD_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        WS_URL: `ws://localhost:${PORT}/ws`,
        AGENT_ID: 'e2e',
        AGENT_NAME: 'e2e-agent',
        AGENT_TICK_MS: '300',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    agent.stdout.on('data', d => out.push(String(d)))
    agent.stderr.on('data', d => out.push(String(d)))
    await waitUntil(() => /ready/.test(out.join('')), { timeout: 30000, message: 'agent ready' })
    await sleep(AGENT_SECONDS * 1000)
    const text = out.join('')
    const errors = text
      .split('\n')
      .filter(l => /scriptError|crashed|TypeError|ReferenceError|SES_UNCAUGHT|Error:/.test(l) && !/punycode/.test(l))
    const players = await page.evaluate(
      () => [...window.world.entities.items.values()].filter(e => e.data?.type === 'player').length
    )
    eq(errors.length, 0, errors.slice(0, 2).join(' | '))
    ok(players >= 2, `${players} players visible`)
    return `${players} players, agent exit ${agent.exitCode}`
  })

  await step('boot watchdog: a world that cannot start says why instead of staying black', async () => {
    // waits for the app to draw are scaled: a software-rendered CI runner can take tens of seconds to draw
    // the main page came up minutes ago: without the app's real ready() call its 60 s notice would be showing,
    // so no message here proves the ready path end to end; a later error does not bring one either (8 s wait)
    ok(await page.evaluate(() => !document.querySelector('.boot-error')), 'no message on a page that started')
    const linesBefore = consoleLines.length
    await page.evaluate(() =>
      setTimeout(() => {
        throw new Error('late error after ready')
      })
    )
    await sleep(9000)
    ok(await page.evaluate(() => !document.querySelector('.boot-error')), 'no message for an error after ready')
    // the deliberate error is not a failure of this run: drop its page error and its console report (SES
    // prints it with its stack), keep anything else logged meanwhile
    pageErrors.splice(0, pageErrors.length, ...pageErrors.filter(line => !line.includes('late error after ready')))
    const probeLine = line =>
      /late error after ready|SES_UNCAUGHT_EXCEPTION: \(Error#\d+\)/.test(line) || /^\[error\]\s+(at |@)/.test(line)
    const kept = consoleLines.slice(linesBefore).filter(line => !probeLine(line))
    consoleLines.splice(linesBefore, consoleLines.length - linesBefore, ...kept)

    // Safari moves Tab between form fields only; Option+Tab reaches buttons
    const TAB = ENGINE === 'webkit' ? 'Alt+Tab' : 'Tab'
    const fresh = async (timings, prepare) => {
      const context = await browser.newContext()
      const probe = await context.newPage()
      await probe.addInitScript(t => {
        window.__worldBootTimings = t
      }, timings)
      await prepare?.(probe)
      await probe.goto(server.url, { waitUntil: 'domcontentloaded' })
      return { context, probe }
    }
    const closeStaysClosed = async probe => {
      const box = probe.locator('.boot-error')
      await box.getByRole('button', { name: 'Close' }).click()
      await sleep(2500)
      ok(await probe.evaluate(() => !document.querySelector('.boot-error')), 'closed for good')
    }

    // 1. SES lockdown fails (an undeletable property on an intrinsic, as a script added by the browser could
    //    leave): nothing is drawn, so the message comes in the middle with the cause, and Reload has focus
    {
      const { context, probe } = await fresh({ error: 500, slow: 4000 }, p =>
        p.addInitScript(() => {
          Object.defineProperty(Array.prototype, '__bootProbe', { value: 1, configurable: false })
        })
      )
      try {
        const box = probe.locator('.boot-error.blocking')
        await box.waitFor({ state: 'visible', timeout: 30000 * TIMEOUT_SCALE })
        eq(await box.locator('.boot-error-title').textContent(), 'This browser could not start the world.', 'title')
        const detail = await box.locator('.boot-error-detail').textContent()
        await probe.screenshot({ path: path.join(OUT, `extras-${ENGINE}-boot-error.png`) })
        // Chromium names the property, WebKit says "Unable to delete property."; SES's last removal names it too
        ok(/delete property/i.test(detail), `cause shown: ${detail}`)
        ok(detail.includes('__bootProbe'), `culprit named: ${detail}`)
        ok((await box.textContent()).includes('Brave Shields'), 'content blocker hint')
        eq(await probe.evaluate(() => document.activeElement?.textContent), 'Reload', 'Reload has focus')
        // keyboard only: Tab to Close, Enter; it stays closed past both deadlines (error 0.5 s, slow 4 s)
        await probe.keyboard.press(TAB)
        eq(await probe.evaluate(() => document.activeElement?.textContent), 'Close', 'Tab reaches Close')
        await probe.keyboard.press('Enter')
        await sleep(5000)
        ok(await probe.evaluate(() => !document.querySelector('.boot-error')), 'closed by keyboard, for good')
      } finally {
        await context.close()
      }
    }

    // 2. the app script is blocked (no error at all) and an error comes from another origin ("Script error."):
    //    that error alone is not a failure; at the slow mark the page says the world did not start
    {
      const { context, probe } = await fresh({ error: 300, slow: 3000 }, async p => {
        await p.route(/\.js(\?|$)/, route =>
          route.request().url().includes('/env.js') ? route.continue() : route.abort()
        )
        await p.addInitScript(() => {
          window.addEventListener('DOMContentLoaded', () =>
            window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
          )
        })
      })
      try {
        await sleep(1500)
        ok(await probe.evaluate(() => !document.querySelector('.boot-error')), 'no failure from Script error. alone')
        const box = probe.locator('.boot-error.blocking')
        await box.waitFor({ state: 'visible', timeout: 15000 * TIMEOUT_SCALE })
        eq(await box.locator('.boot-error-title').textContent(), 'The world did not start.', 'blocked title')
        ok((await box.locator('.boot-error-detail').textContent()).includes('another origin'), 'opaque detail')
        await closeStaysClosed(probe)
      } finally {
        await context.close()
      }
    }

    // 4. nothing is drawn at the slow mark (the app script arrives late), then the app draws: the message in the
    //    middle moves to the bottom notice, with no error from the watchdog itself
    {
      const probeErrors = []
      const { context, probe } = await fresh({ slow: 1000 }, async p => {
        p.on('pageerror', error => probeErrors.push(String(error)))
        await p.routeWebSocket(/\/ws/, () => {})
        let delayed = false
        await p.route(/\/index-[^/]*\.js(\?|$)/, async route => {
          if (!delayed) {
            delayed = true
            await sleep(3000)
          }
          await route.continue()
        })
      })
      try {
        await probe.locator('.boot-error.blocking').waitFor({ state: 'visible', timeout: 15000 * TIMEOUT_SCALE })
        await probe.locator('.boot-error.notice').waitFor({ state: 'visible', timeout: 30000 * TIMEOUT_SCALE })
        ok(await probe.evaluate(() => !document.querySelector('.boot-error.blocking')), 'moved out of the middle')
        eq(probeErrors.length, 0, probeErrors.join(' | '))
      } finally {
        await context.close()
      }
    }

    // 3. the app runs but has not finished at the slow mark (its socket never answers): a notice at the bottom,
    //    out of the way, removed when the world is ready
    {
      const { context, probe } = await fresh({ slow: 5000 }, p => p.routeWebSocket(/\/ws/, () => {}))
      try {
        const notice = probe.locator('.boot-error.notice')
        await notice.waitFor({ state: 'visible', timeout: 30000 * TIMEOUT_SCALE })
        eq(await notice.locator('.boot-error-title').textContent(), 'The world is taking long to start.', 'notice')
        // the game's controls are up and take Tab on window; inside the notice the keys still work
        eq(await probe.evaluate(() => document.activeElement?.textContent), 'Reload', 'notice Reload has focus')
        await probe.keyboard.press(TAB)
        eq(await probe.evaluate(() => document.activeElement?.textContent), 'Close', 'Tab reaches Close in the notice')
        await probe.evaluate(() => window.__worldBoot.ready())
        ok(await probe.evaluate(() => !document.querySelector('.boot-error')), 'removed when ready')
      } finally {
        await context.close()
      }
    }
  })

  record(
    errorLines().length === 0 && pageErrors.length === 0,
    'browser: no console or page errors',
    [...errorLines(), ...pageErrors].slice(0, 3).join(' | ')
  )
  record(
    server.lines(/script crashed|SES_UNCAUGHT|SES_UNHANDLED|Cannot assign to read only/).length === 0,
    'server log: no crashes or override errors',
    server
      .lines(/script crashed|SES_/)
      .slice(0, 2)
      .join(' | ')
  )
} catch (err) {
  record(false, 'aborted', err?.stack || String(err))
} finally {
  try {
    agent?.kill('SIGTERM')
  } catch {
    // already gone
  }
  await saveArtifacts({ ...handles, prefix: path.join(OUT, `extras-${ENGINE}`) })
  await browser?.close().catch(() => {})
  await server?.stop()
  mock.close()
  fs.rmSync(path.join(BUILD_ROOT, '.agent-token-e2e.json'), { force: true })
  process.exit(finish() ? 1 : 0)
}
