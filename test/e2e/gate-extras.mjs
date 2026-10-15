// e2e extras: the paths a lockdown change could break that the full-stack run does not touch:
// player movement and jumping, a VRM session avatar, builder uploads (.glb/.vrm/.png), an AI create call
// through a mock Anthropic Messages API, and the node-client agent for 60 s.
//
// usage: node test/e2e/gate-extras.mjs --engine=chromium|webkit|firefox [--world=<dir>] [--port=3123] [--agent-seconds=60]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { BUILD_ROOT, arg, createResults, ensureOut, eq, ok, sleep, waitUntil } from './lib/common.mjs'
import { startServer, worldAssetsDir } from './lib/server.mjs'
import { becomeAdmin, launchBrowser, openWorld } from './lib/browser.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3123))
const WORLD_SOURCE = arg('world', null)
const AGENT_SECONDS = Number(arg('agent-seconds', 60))
const OUT = ensureOut()
const { record, step, finish } = createResults(`gate-extras/${ENGINE}`)

// mock Anthropic Messages API: every call returns a tiny valid app script
let aiCalls = 0
const mock = http.createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    aiCalls++
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'mock',
        content: [{ type: 'text', text: 'app.on("update", () => {})' }],
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
try {
  server = await startServer({
    port: PORT,
    worldSource: WORLD_SOURCE,
    logPath: path.join(OUT, `extras-${ENGINE}-server.log`),
    env: { AI_API_KEY: 'mock-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}` },
  })
  browser = await launchBrowser(ENGINE)
  const { page, pageErrors, errorLines } = await openWorld(browser, server.url, {
    viewport: { width: 800, height: 600 },
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
  await browser?.close().catch(() => {})
  await server?.stop()
  mock.close()
  fs.rmSync(path.join(BUILD_ROOT, '.agent-token-e2e.json'), { force: true })
  process.exit(finish() ? 1 : 0)
}
