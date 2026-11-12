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
      // one AI action an hour per builder: the AI step's second create is refused, whenever the first ends
      AI_MAX_PER_USER_PER_HOUR: '1',
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

  // The page's own headers, in a real engine: what the browser does with them, not only that they are sent.
  // The probes run in a page of their own (/terms.html, in a new context of the same browser): the refusals they ask
  // for are reported in that page's console, which this step reads, and the world page's record stays whole.
  await step('page headers: the world is not framed, and a store script is text to the browser', async () => {
    // A store script whose running cannot be missed: it counts itself on the global it runs in and, in a worker, says
    // so at once; it cannot throw. Uploaded through the world by its builder, as any store script is.
    const SENTINEL =
      "self.__storeScriptRan = (self.__storeScriptRan || 0) + 1\nif (typeof importScripts === 'function') postMessage('ran')\n"
    const script = await page.evaluate(async text => {
      const bytes = new TextEncoder().encode(text)
      await window.world.network.upload(new File([bytes], 'e2e-probe.js'))
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const hash = Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
      return `${hash}.js`
    }, SENTINEL)
    const wait = 15000 * TIMEOUT_SCALE
    const context = await browser.newContext()
    const lines = []
    const errors = []
    try {
      const probe = await context.newPage()
      probe.on('console', m => lines.push(`[${m.type()}] ${m.text()}`))
      probe.on('pageerror', e => errors.push(String(e)))
      const retyped = []
      // what the route fulfils is decoded: its old encoding and length must not be claimed for it
      const refit = (headers, changes) => {
        const out = { ...headers, ...changes }
        delete out['content-encoding']
        delete out['content-length']
        return out
      }
      await probe.route('**/*', async route => {
        const request = route.request()
        const url = new URL(request.url())
        // the control of the frame probe: the world page with its two framing headers taken out
        if (url.searchParams.get('framed') === 'control') {
          const response = await route.fetch()
          const headers = refit(response.headers())
          delete headers['content-security-policy']
          delete headers['x-frame-options']
          return route.fulfill({ response, headers })
        }
        // the controls of the script probes: the same response, its type alone changed back to JavaScript
        if (url.searchParams.get('typed') === '1') {
          retyped.push(url.searchParams.get('as'))
          const response = await route.fetch()
          return route.fulfill({ response, headers: refit(response.headers(), { 'content-type': 'text/javascript' }) })
        }
        // what a framed document loads (the control world's scripts) is held back: the world does not start again
        let frame = null
        try {
          frame = request.frame()
        } catch {
          // a request that belongs to no frame
        }
        if (frame && frame !== probe.mainFrame() && !request.isNavigationRequest()) return route.abort()
        return route.continue()
      })
      await probe.goto(`${server.url}terms.html`, { waitUntil: 'load' })

      const got = await probe.evaluate(async script => {
        const head = async url => {
          const res = await fetch(url)
          const text = await res.text()
          return {
            status: res.status,
            csp: res.headers.get('content-security-policy'),
            xfo: res.headers.get('x-frame-options'),
            permissions: res.headers.get('permissions-policy'),
            nosniff: res.headers.get('x-content-type-options'),
            type: res.headers.get('content-type'),
            placeholders: /\{title\}|\{url\}|\{image\}|\{desc\}/.test(text),
            length: text.length,
          }
        }
        return {
          pages: { root: await head('/'), index: await head('/index.html'), terms: await head('/terms.html') },
          asset: await head(`/assets/${script}`),
        }
      }, script)
      const CSP = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
      for (const [name, res] of Object.entries(got.pages)) {
        eq(res.status, 200, `${name}: status`)
        eq(res.csp, CSP, `${name}: Content-Security-Policy`)
        eq(res.xfo, 'DENY', `${name}: X-Frame-Options`)
        eq(res.permissions, 'camera=(), geolocation=(), payment=(), usb=()', `${name}: Permissions-Policy`)
        eq(res.nosniff, 'nosniff', `${name}: nosniff`)
        eq(res.placeholders, false, `${name}: no placeholder left`)
      }
      eq(got.pages.index.length, got.pages.root.length, '/index.html is the page')
      eq(got.asset.type, 'text/plain; charset=utf-8', 'a store script is served as text')
      eq(got.asset.nosniff, 'nosniff', 'asset nosniff')

      // The world in a frame of its own origin. The page's inline watchdog script defines window.__worldBoot at once,
      // so a frame that got the page has it. The control (the same page without its framing headers) must load and
      // be seen. Framing the world itself must end with the frame's load (a stalled frame fails here) on a document
      // with nothing in it (the engine's error page, or a blank one: not the page, and not an answer of the server),
      // and the engine must say in the console that frame-ancestors refused it (Chromium and WebKit say so; Firefox
      // was not tried).
      const framed = async (id, src) => {
        const loaded = await probe.evaluate(
          ({ id, src, wait }) =>
            new Promise(resolve => {
              const frame = document.createElement('iframe')
              frame.id = id
              frame.onload = () => resolve(true)
              setTimeout(() => resolve(false), wait)
              frame.src = src
              document.body.appendChild(frame)
            }),
          { id, src, wait }
        )
        ok(loaded, `${id}: the frame's load within ${wait} ms`)
        const frame = await (await probe.$(`#${id}`)).contentFrame()
        ok(frame, `${id}: a frame`)
        return frame.evaluate(() => ({
          world: typeof window.__worldBoot === 'object' && window.__worldBoot !== null,
          text: (document.body?.innerText ?? '').trim().slice(0, 200),
        }))
      }
      const control = await framed('control', '/?framed=control')
      eq(control.world, true, 'control: the world page without its framing headers loads in the frame')
      const refused = await framed('framed', '/?framed=1')
      eq(refused.world, false, 'the world in a frame: not the page')
      eq(refused.text, '', 'the world in a frame: an empty or error document, not an answer of the server')
      ok(
        lines.some(line => /frame-ancestors/.test(line)),
        `the engine says frame-ancestors refused the frame: ${lines.join(' | ')}`
      )

      // The store script as a classic script, a module and a worker: each must be refused by the browser (its error
      // event, the script not having run), and its control must run. The control of the two script tags is the same
      // response with its type alone changed back to JavaScript, so what refuses them is the type with nosniff. A
      // worker is also refused by the `sandbox` policy the asset is served with, in an engine that applies it to
      // workers: its control is the same text from a blob: URL, and the retyped response says which refused it here.
      const scripts = await probe.evaluate(
        async ({ script, wait }) => {
          const asset = (as, typed) => `/assets/${script}?as=${as}${typed ? '&typed=1' : ''}`
          const tag = (src, type) =>
            new Promise(resolve => {
              delete window.__storeScriptRan
              const el = document.createElement('script')
              if (type) el.type = type
              const end = state => {
                clearTimeout(timer)
                resolve(state)
              }
              const timer = setTimeout(() => end('no answer'), wait)
              el.onload = () => end(window.__storeScriptRan === 1 ? 'ran' : 'loaded without running')
              el.onerror = () => end(window.__storeScriptRan === undefined ? 'refused' : 'ran, and an error')
              el.src = src
              document.head.appendChild(el)
            })
          const worker = src =>
            new Promise(resolve => {
              let w
              try {
                w = new Worker(src)
              } catch (error) {
                return resolve(`threw ${error.name}`)
              }
              const end = state => {
                clearTimeout(timer)
                w.terminate()
                resolve(state)
              }
              const timer = setTimeout(() => end('no answer'), wait)
              w.onmessage = event => end(event.data === 'ran' ? 'ran' : `said ${event.data}`)
              // the script cannot throw, and says it ran first: an error with no word from it is a refusal
              w.onerror = event => {
                event.preventDefault()
                end('refused')
              }
            })
          const text = await (await fetch(asset('text'))).text()
          const blob = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
          return {
            classicControl: await tag(asset('classic', true)),
            classic: await tag(asset('classic')),
            moduleControl: await tag(asset('module', true), 'module'),
            module: await tag(asset('module'), 'module'),
            workerControl: await worker(blob),
            worker: await worker(asset('worker')),
            workerTyped: await worker(asset('worker', true)),
          }
        },
        { script, wait }
      )
      eq(scripts.classicControl, 'ran', 'control: the same response typed as JavaScript, as a classic script')
      eq(scripts.classic, 'refused', 'a store script as a classic script')
      eq(scripts.moduleControl, 'ran', 'control: the same response typed as JavaScript, as a module')
      eq(scripts.module, 'refused', 'a store script as a module')
      eq(scripts.workerControl, 'ran', 'control: the same text from a blob: URL, as a worker')
      eq(scripts.worker, 'refused', 'a store script as a worker')
      eq(retyped.join(','), 'classic,module,worker', 'the controls went through the route that retypes them')
      // The retyped worker says what refused the plain one: run as JavaScript, it was the type; refused as
      // JavaScript too, the engine applies the sandbox policy to workers and either would do. No answer in time
      // says nothing, and fails the step.
      ok(
        scripts.workerTyped === 'ran' || scripts.workerTyped === 'refused',
        `the store script typed as JavaScript, as a worker: ${scripts.workerTyped}`
      )
      const workerBy = scripts.workerTyped === 'ran' ? 'its type' : 'its sandbox or its type'
      // only the probe page's own refusals may show as page errors (WebKit reports a refused module so)
      const unexpected = errors.filter(error => !/MIME type/i.test(error))
      eq(unexpected.length, 0, `page errors of the probe page: ${unexpected.join(' | ')}`)
      return `framed: refused; script, module: refused by their type; worker: refused by ${workerBy}`
    } finally {
      // the probe page's own record, kept beside the run's
      fs.writeFileSync(
        path.join(OUT, `extras-${ENGINE}-page-headers.log`),
        [...lines, ...errors.map(error => `[pageerror] ${error}`)].join('\n')
      )
      await context.close()
    }
  })

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
    // A refused create leaves no placeholder: ClientAI.create places a blueprint running asset://ai.js and an app
    // before asking; the server, refusing (the builder's one action this hour is spent), removes the app for
    // everyone and keeps the blueprint (ServerAI.dropPlaceholder)
    const callsBefore = aiCalls
    const refused = await page.evaluate(async () => {
      const w = window.world
      w.blueprints.add(
        {
          id: 'ai-ph',
          version: 0,
          name: 'Model',
          image: null,
          author: null,
          url: null,
          desc: null,
          model: 'asset://ai.glb',
          script: 'asset://ai.js',
          props: { prompt: 'a refused cube', createdAt: w.network.getTime() },
          preload: false,
          public: false,
          locked: false,
          frozen: false,
          unique: false,
          scene: false,
          disabled: false,
        },
        true
      )
      w.entities.add(
        {
          id: 'ai-ph-app',
          type: 'app',
          blueprint: 'ai-ph',
          position: [2, 0, -3],
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
      const placed = !!w.entities.get('ai-ph-app')
      w.network.send('ai', { name: 'create', blueprintId: 'ai-ph', appId: 'ai-ph-app', prompt: 'a refused cube' })
      // busy while the first create's naming request may still run, then over the hour's limit
      const said = () =>
        w.chat.msgs.some(m =>
          [
            'Your previous AI request is still running.',
            'You have reached the hourly limit for AI requests. Try again later.',
          ].includes(m.body)
        )
      // the removal and the line of chat are two packets: wait for both (the chat was read as soon as the
      // placeholder was gone, and in CI it had not always arrived)
      const t0 = Date.now()
      while (Date.now() - t0 < 15000) {
        if (!w.entities.get('ai-ph-app') && said()) break
        await new Promise(r => setTimeout(r, 200))
      }
      return {
        placed,
        removed: !w.entities.get('ai-ph-app'),
        blueprint: !!w.blueprints.get('ai-ph'),
        said: said(),
      }
    })
    ok(refused.placed && refused.removed, `placeholder removed: ${JSON.stringify(refused)}`)
    ok(refused.said, 'the refusal is said in chat')
    ok(refused.blueprint, 'the blueprint stays')
    ok(/\[ai\] placeholder app "ai-ph-app" removed/.test(server.out), 'server log')
    eq(aiCalls, callsBefore, 'no provider call for the refused create')
    return `${aiCalls} mock calls, script ${ai.script}; refused create's placeholder removed`
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
    const fresh = async (timings, prepare, { url = server.url, waitUntil = 'domcontentloaded' } = {}) => {
      const context = await browser.newContext()
      const probe = await context.newPage()
      const errors = []
      probe.on('pageerror', error => errors.push(String(error)))
      await probe.addInitScript(t => {
        window.__worldBootTimings = t
      }, timings)
      await prepare?.(probe)
      await probe.goto(url, { waitUntil })
      return { context, probe, errors }
    }
    // waits for a message box; when it does not come, the failure says what the page looked like, since a bare
    // timeout cannot tell "the timings were not applied" from "the message could not be shown" from "the app drew"
    const shown = async (probe, selector, timeout, errors) => {
      try {
        await probe.locator(selector).waitFor({ state: 'visible', timeout })
      } catch (cause) {
        // the dump has its own deadline: a page that is stuck must not turn a bounded wait into an endless one
        const state = await Promise.race([
          probe.evaluate(() => ({
            timings: window.__worldBootTimings ?? null,
            readyState: document.readyState,
            body: !!document.body,
            boxes: [...document.querySelectorAll('.boot-error')].map(box => box.className),
            rootChildren: document.getElementById('root')?.childNodes.length ?? null,
            boot: typeof window.__worldBoot,
          })),
          sleep(5000).then(() => ({ evaluate: 'no answer from the page in 5 s' })),
        ]).catch(error => ({ evaluate: String(error) }))
        throw new Error(
          `${cause.message.split('\n')[0]} (${selector}); page: ${JSON.stringify(state)}; errors: ${JSON.stringify(errors)}`,
          { cause }
        )
      }
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
      const { context, probe, errors } = await fresh({ error: 500, slow: 4000 }, p =>
        p.addInitScript(() => {
          Object.defineProperty(Array.prototype, '__bootProbe', { value: 1, configurable: false })
        })
      )
      try {
        const box = probe.locator('.boot-error.blocking')
        await shown(probe, '.boot-error.blocking', 30000 * TIMEOUT_SCALE, errors)
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
      const { context, probe, errors } = await fresh({ error: 300, slow: 3000 }, async p => {
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
        await shown(probe, '.boot-error.blocking', 15000 * TIMEOUT_SCALE, errors)
        eq(await box.locator('.boot-error-title').textContent(), 'The world did not start.', 'blocked title')
        ok((await box.locator('.boot-error-detail').textContent()).includes('another origin'), 'opaque detail')
        await closeStaysClosed(probe)
      } finally {
        await context.close()
      }
    }

    // 5. iPhone Brave's injected script adds its own call / apply to Function.prototype.call, .apply and .bind and
    //    freezes them (this fixture also adds bind and toString). The cleanup before lockdown swaps in clean ones, so lockdown
    //    completes and the app starts (its socket is held: drawing and clean, frozen intrinsics are enough)
    {
      const consoleLines = []
      const { context, probe } = await fresh({ error: 500, slow: 60000 }, async p => {
        p.on('console', m => consoleLines.push(m.text()))
        await p.routeWebSocket(/\/ws/, () => {})
        await p.addInitScript(() => {
          const { call, apply, bind, toString } = Function.prototype
          for (const fn of [call, apply, bind]) {
            for (const [name, value] of [
              ['call', call],
              ['apply', apply],
              ['bind', bind],
            ]) {
              Object.defineProperty(fn, name, { value, configurable: false, writable: false, enumerable: false })
            }
            Object.defineProperty(fn, 'toString', { value: toString, configurable: true, writable: true })
            Object.freeze(fn)
          }
        })
      })
      try {
        await probe.waitForFunction(() => !!document.getElementById('root')?.firstChild, null, {
          timeout: 30000 * TIMEOUT_SCALE,
        })
        await sleep(2000)
        ok(await probe.evaluate(() => !document.querySelector('.boot-error')), 'no failure message')
        const state = await probe.evaluate(() => ({
          frozen: Object.isFrozen(Function.prototype),
          keys: ['apply', 'call', 'bind'].map(name => Reflect.ownKeys(Function.prototype[name]).join(',')),
          max: Math.max.apply(null, [1, 5, 3]),
          bound: function (a, b) {
            return a + b
          }.bind(
            null,
            2
          )(3),
        }))
        eq(
          JSON.stringify(state),
          JSON.stringify({ frozen: true, keys: ['length,name', 'length,name', 'length,name'], max: 5, bound: 5 }),
          'locked down and clean'
        )
        ok(
          consoleLines.some(line => line.includes('[lockdown] replaced Function.prototype methods')),
          'replacement reported'
        )
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
        // The page itself notes each message as it is added: which one, whether it has a size on the page, and
        // whether the app had drawn by then. Looking from here cannot be relied on: goto() returns at
        // DOMContentLoaded, which waits for the delayed app script, and the middle message is moved within a second
        // of the app drawing, so on a slow runner it has come and gone before this script looks.
        await p.addInitScript(() => {
          window.__bootBoxes = []
          new MutationObserver(records => {
            for (const record of records) {
              for (const node of record.addedNodes) {
                if (node.nodeType !== 1 || !node.classList.contains('boot-error')) continue
                const rect = node.getBoundingClientRect()
                window.__bootBoxes.push({
                  box: node.className,
                  // as Playwright's own "visible": a box with a size that is not hidden
                  visible:
                    node.isConnected &&
                    rect.width > 0 &&
                    rect.height > 0 &&
                    getComputedStyle(node).visibility === 'visible',
                  drawn: !!document.getElementById('root')?.firstChild,
                })
              }
            }
          }).observe(document, { childList: true, subtree: true })
        })
      })
      try {
        await shown(probe, '.boot-error.notice', 45000 * TIMEOUT_SCALE, probeErrors)
        // in the middle while nothing was drawn; at the bottom only once the app had drawn
        eq(
          JSON.stringify(await probe.evaluate(() => window.__bootBoxes)),
          JSON.stringify([
            { box: 'boot-error blocking', visible: true, drawn: false },
            { box: 'boot-error notice', visible: true, drawn: true },
          ]),
          'the message in the middle first, then the notice'
        )
        ok(await probe.evaluate(() => !document.querySelector('.boot-error.blocking')), 'moved out of the middle')
        eq(probeErrors.length, 0, probeErrors.join(' | '))
      } finally {
        await context.close()
      }
    }

    // 6. the timer fires while the document has no <body> yet (the head has arrived, the rest is slow or stalled).
    //    The message must still come as soon as the body is there, also while a slow script in the body still holds
    //    DOMContentLoaded back (it used to throw on the missing body and then never show anything: a black page
    //    for good). Nothing here depends on how fast the machine is: a small server in front of the world puts a
    //    script at the end of the head, after the watchdog, and answers it only when the test says so (the parser
    //    stops there in every engine); the page reports when its slow callback has run and whether a body existed;
    //    the body's first script is held the same way until the assertions are done.
    {
      const gate = () => {
        let open
        const opened = new Promise(resolve => (open = resolve))
        return { open, opened }
      }
      const head = gate()
      const env = gate()
      let front = null
      let context = null
      try {
        front = http.createServer(async (req, res) => {
          try {
            if (req.url === '/__e2e_hold') {
              await head.opened
              res.writeHead(200, { 'content-type': 'text/javascript' })
              return res.end('')
            }
            const upstream = await fetch(`http://127.0.0.1:${PORT}${req.url}`, {
              headers: { 'accept-encoding': 'identity' },
            })
            let body = Buffer.from(await upstream.arrayBuffer())
            const headers = {}
            upstream.headers.forEach((value, name) => {
              if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) {
                headers[name] = value
              }
            })
            if (req.url === '/') {
              const html = body.toString()
              if (!html.includes('__worldBootTimings') || !html.includes('</head>')) {
                throw new Error('the document has no watchdog or no head to hold')
              }
              body = Buffer.from(html.replace('</head>', '<script src="/__e2e_hold"></script></head>'))
            }
            res.writeHead(upstream.status, headers)
            res.end(body)
          } catch (error) {
            res.destroy(error)
          }
        })
        await new Promise((resolve, reject) => front.once('error', reject).listen(0, '127.0.0.1', resolve))
        const SLOW = 1000
        const fresh6 = await fresh(
          { error: 300, slow: SLOW },
          async p => {
            // the watchdog's slow timer is the only one of this length: note when its callback runs and whether
            // the document had a body then (before the callback itself, which threw in the old code)
            await p.addInitScript(slow => {
              const setTimer = window.setTimeout
              window.setTimeout = function (run, ms, ...rest) {
                if (ms !== slow || typeof run !== 'function') return setTimer.call(window, run, ms, ...rest)
                return setTimer.call(
                  window,
                  function () {
                    window.__e2eSlowCallback = { body: !!document.body }
                    return run.apply(this, arguments)
                  },
                  ms,
                  ...rest
                )
              }
            }, SLOW)
            // the app's script never arrives, and the first script of the body is held: once the head is released
            // the body is there, but DOMContentLoaded cannot come
            await p.route(/\.js(\?|$)/, async route => {
              if (!route.request().url().includes('/env.js')) return route.abort()
              await env.opened
              await route.continue().catch(() => {})
            })
          },
          { url: `http://127.0.0.1:${front.address().port}/`, waitUntil: 'commit' }
        )
        context = fresh6.context
        const { probe, errors } = fresh6
        // polled on a timer: a document without a body draws no frames, so the default (per frame) never runs
        await probe.waitForFunction(() => window.__e2eSlowCallback, null, {
          timeout: 15000 * TIMEOUT_SCALE,
          polling: 100,
        })
        eq(
          await probe.evaluate(() => window.__e2eSlowCallback.body),
          false,
          'the slow callback ran while the document had no body'
        )
        eq(await probe.evaluate(() => !!document.body), false, 'and the parser is still held in the head')
        head.open()
        await shown(probe, '.boot-error.blocking', 15000 * TIMEOUT_SCALE, errors)
        eq(
          await probe.locator('.boot-error.blocking .boot-error-title').textContent(),
          'The world did not start.',
          'the message comes once the body is there'
        )
        eq(await probe.evaluate(() => document.readyState), 'loading', 'without waiting for DOMContentLoaded')
        eq(errors.length, 0, `no error from the watchdog itself: ${errors.join(' | ')}`)
        // the rest of the document may come now (WebKit does not deliver a click while the parser is held)
        env.open()
        await closeStaysClosed(probe)
      } finally {
        head.open()
        env.open()
        await context?.close().catch(() => {})
        if (front) {
          const closed = new Promise(resolve => front.close(resolve))
          front.closeAllConnections?.()
          await closed
        }
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
