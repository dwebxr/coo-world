// Full-stack e2e: boots the built server against a throwaway world, runs the sandbox probes over the wire
// protocol (server side) and then in a real browser engine, and exercises the script editor end to end.
//
// usage: node test/e2e/fullstack.mjs --engine=chromium|webkit|firefox [--world=<dir>] [--port=3121]
//   --world: an existing world directory to copy (eg the local 5-app world); without it the server
//            bootstraps the default world from src/world
// Requires the four builds (see .github/workflows/e2e.yml). Logs and screenshots go to test/e2e/out/.
import fs from 'node:fs'
import path from 'node:path'

import { APPS_DIR, arg, createResults, ensureOut, eq, ok, sleep, waitUntil } from './lib/common.mjs'
import { installAsset, startServer } from './lib/server.mjs'
import { WireClient, snapshot } from './lib/ws.mjs'
import { appState, becomeAdmin, installApp, launchBrowser } from './lib/browser.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3121))
const WORLD_SOURCE = arg('world', null)
const OUT = ensureOut()
const { record, step, finish } = createResults(`fullstack/${ENGINE}`)

// a 1x1 transparent PNG as a data URL (the image/png fixture for createObjectURL)
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// console errors the probes produce on purpose
const EXPECTED_ERROR =
  /\[world\.open\]|\[stage\]|\[physics\]|script crashed|script destroy\(\) crashed|P1_|crasher|not extensible|readonly property|Cannot add property|does-not-exist|GLTFLoader|createObjectURL expects|Body is unusable|body used already|json/i

let server
let browser
let context
try {
  server = await startServer({
    port: PORT,
    worldSource: WORLD_SOURCE,
    logPath: path.join(OUT, `fullstack-${ENGINE}-server.log`),
  })
  const base = `http://localhost:${PORT}`
  record(
    true,
    `server booted against ${server.world}${WORLD_SOURCE ? ` (copy of ${WORLD_SOURCE})` : ' (default world)'}`
  )
  for (const name of [
    'sandbox-probe',
    'crasher',
    'observer',
    'stage-crash',
    'physics-crash',
    'retry-probe',
    'open-probe',
    'throwing',
    'console-probe',
  ]) {
    installAsset(server, path.join(APPS_DIR, `${name}.js`))
  }
  const probeProps = { base, png: PNG }

  // ---------- phase A: probes over the wire protocol (server-side compartments) ----------
  const admin = await new WireClient(PORT, 'admin').connect()
  const watcher = await new WireClient(PORT, 'watcher').connect()
  await admin.becomeAdmin()
  record(true, 'wire clients connected, admin granted')

  await step('A1 observer app starts clean', async () => {
    const from = watcher.mark()
    admin.installApp({ id: 's-observer', script: 'asset://observer.js', model: 'asset://ai.glb' })
    const look = await watcher.waitForReport('P1_OBSERVER', { from })
    eq(look.stash, 'undefined', 'stash')
    eq(look.arrayProbe, 'undefined', 'Array.prototype.probe')
    eq(look.floor, 1, 'Math.floor')
    eq(look.vectorType, 'function', 'Vector3')
  })

  let sandbox
  await step('A2 intrinsic, endowment and stash writes are contained (server)', async () => {
    const from = watcher.mark()
    admin.installApp({
      id: 's-sandbox',
      script: 'asset://sandbox-probe.js',
      model: 'asset://ai.glb',
      props: probeProps,
    })
    // the probe reports once on start and again when its async part is done
    sandbox = await waitUntil(
      () =>
        watcher
          .since(from)
          .filter(m => m.method === 'onChatAdded' && m.data?.body?.startsWith('P1_SANDBOX '))
          .map(m => JSON.parse(m.data.body.slice('P1_SANDBOX '.length)))
          .find(r => r.done || r.failed),
      { timeout: 30000, message: 'sandbox probe report' }
    )
    ok(!sandbox.failed, `probe failed: ${sandbox.failed}`)
    for (const key of [
      'arrayProto',
      'objectProto',
      'mathWrite',
      'endowmentWrite',
      'endowmentDefine',
      'consoleStash',
      'helperStash',
    ]) {
      eq(sandbox[key], 'TypeError', key)
    }
    eq(sandbox.ownGlobal, 'ok', 'own globalThis write')
    eq(sandbox.stash, true, 'own stash visible to itself')
    eq(sandbox.arrayProbeLeak, undefined, 'no leak')
    eq(sandbox.floor, 1, 'Math intact')
    eq(sandbox.mathRandom, 'function', 'Math.random available')
    eq(sandbox.evalType, 'undefined', 'eval')
    eq(sandbox.hardenType, 'undefined', 'harden')
    return `probe: ${JSON.stringify(sandbox).slice(0, 80)}...`
  })

  await step('A3 escape probes: blob facade, object URL type, errors (server)', async () => {
    eq(sandbox.blob.protoIsObject, true, 'facade prototype')
    eq(sandbox.blob.frozen, true, 'facade frozen')
    eq(sandbox.blob.stream, 'undefined', 'no stream()')
    eq(
      JSON.stringify(sandbox.blob.keys),
      JSON.stringify(['arrayBuffer', 'size', 'slice', 'text', 'type']),
      'facade keys'
    )
    ok(sandbox.blob.type.startsWith('text/html'), `host type seen: ${sandbox.blob.type}`)
    ok(sandbox.blob.sliceType.startsWith('text/html'), 'slice keeps the host type')
    eq(sandbox.blobProtoWrite, 'TypeError', 'Object.prototype write through the facade')
    eq(sandbox.objectUrlNonFacade, 'TypeError', 'createObjectURL rejects non-facades')
    eq(sandbox.objectUrlType, 'application/octet-stream', 'html bytes are served opaque')
    eq(sandbox.objectUrlPngType, 'image/png', 'png keeps its type')
    for (const key of ['syncError', 'loadError', 'readerError']) {
      const e = sandbox[key]
      eq(e.isError, true, `${key} instanceof Error`)
      eq(e.chainFrozen, true, `${key} frozen chain`)
      eq(e.hasCause, false, `${key} has no cause`)
      eq(e.objectProps.length, 0, `${key} has no object-valued own props`)
    }
    return `load error: ${sandbox.loadError.name}, reader error: ${sandbox.readerError.name}`
  })

  await step('A3b console arguments never hand a host function to a script (server)', async () => {
    const from = watcher.mark()
    admin.installApp({
      id: 's-console-a',
      script: 'asset://console-probe.js',
      model: 'asset://ai.glb',
      props: { tag: 'P1_CONSOLE_A' },
    })
    const a = await watcher.waitForReport('P1_CONSOLE_A', { from, timeout: 15000 })
    eq(a.called, false, 'custom inspect hook not invoked')
    eq(a.gotFunction, false, 'no host function received')
    admin.installApp({
      id: 's-console-b',
      script: 'asset://console-probe.js',
      model: 'asset://ai.glb',
      props: { tag: 'P1_CONSOLE_B' },
    })
    const b = await watcher.waitForReport('P1_CONSOLE_B', { from: watcher.mark(), timeout: 15000 })
    eq(b.called, false, 'second app: hook not invoked either')
    eq(b.stash, 'unset', 'no cross-app stash through inspect')
    ok(server.out.includes('console probe'), 'the log line still appears')
    ok(
      server.lines(/console probe/).some(l => /marker/.test(l)),
      'the object is rendered readably'
    )
    ok(!server.out.includes('custom output'), 'custom hooks are disabled')
  })

  await step('A4 an uncaught intrinsic write crashes only its own app (server)', async () => {
    const before = server.count('script crashed')
    const from = watcher.mark()
    admin.installApp({ id: 's-crasher', script: 'asset://crasher.js', model: 'asset://ai.glb' })
    await waitUntil(() => server.count('script crashed') === before + 1, { message: 'crasher crash log' })
    const beat = await watcher.waitForReport('P1_OBSERVER_BEAT', { from, timeout: 10000 })
    eq(beat.crasher, 'undefined', 'observer sees no crasher write')
    ok(/TypeError/.test(server.out), 'TypeError logged')
  })

  await step('A5 a throwing valueOf in a transform crashes only its app on the Stage path (server)', async () => {
    const from = watcher.mark()
    admin.installApp({ id: 's-stage', script: 'asset://stage-crash.js', model: 'asset://ai.glb' })
    await waitUntil(() => server.lines(/\[stage\] node update failed .*entity s-stage\)/).length === 1, {
      timeout: 15000,
      message: 'stage containment log',
    })
    ok(server.out.includes('P1_STAGE_BOOM'), 'error logged')
    const beat1 = await watcher.waitForReport('P1_OBSERVER_BEAT', { from, timeout: 10000 })
    const beat2 = await watcher.waitForReport('P1_OBSERVER_BEAT', { from: watcher.mark(), timeout: 10000 })
    ok(beat2.n > beat1.n, 'observer keeps ticking')
    eq(server.count('giving up on node'), 0, 'app nodes are never retried')
  })

  await step('A5b Stage containment completes when the destroy listener throws (server)', async () => {
    admin.installApp({
      id: 's-stage2',
      script: 'asset://stage-crash.js',
      model: 'asset://ai.glb',
      props: { destroyThrows: true },
    })
    await waitUntil(() => server.lines(/\[stage\] node update failed .*entity s-stage2\)/).length === 1, {
      timeout: 15000,
      message: 'stage containment log (destroy variant)',
    })
    await waitUntil(() => server.count('P1_DESTROY_BOOM') >= 1, {
      timeout: 10000,
      message: 'destroy listener error log',
    })
    eq(server.lines(/script destroy\(\) crashed/).length >= 1, true, 'destroy failure logged')
    eq(server.lines(/crash rebuild failed|SES_UNHANDLED|UnhandledPromiseRejection/).length, 0, 'no unhandled rejection')
    const beat1 = await watcher.waitForReport('P1_OBSERVER_BEAT', { from: watcher.mark(), timeout: 10000 })
    const beat2 = await watcher.waitForReport('P1_OBSERVER_BEAT', { from: watcher.mark(), timeout: 10000 })
    ok(beat2.n > beat1.n, 'observer keeps ticking')
  })

  await step('A6 a throwing _onChangeCallback crashes only its app on the Physics path (server)', async () => {
    admin.installApp({ id: 's-physics', script: 'asset://physics-crash.js', model: 'asset://ai.glb' })
    await waitUntil(() => server.lines(/\[physics\] interpolation failed .*entity s-physics\)/).length === 1, {
      timeout: 15000,
      message: 'physics containment log',
    })
    ok(server.out.includes('P1_PHYSICS_BOOM'), 'error logged')
    const beat1 = await watcher.waitForReport('P1_OBSERVER_BEAT', { from: watcher.mark(), timeout: 10000 })
    const beat2 = await watcher.waitForReport('P1_OBSERVER_BEAT', { from: watcher.mark(), timeout: 10000 })
    ok(beat2.n > beat1.n, 'observer keeps ticking')
  })

  await step('A6b Physics containment completes when the destroy listener throws (server)', async () => {
    const destroyLogs = server.lines(/script destroy\(\) crashed/).length
    admin.installApp({
      id: 's-physics2',
      script: 'asset://physics-crash.js',
      model: 'asset://ai.glb',
      props: { destroyThrows: true },
    })
    await waitUntil(() => server.lines(/\[physics\] interpolation failed .*entity s-physics2\)/).length === 1, {
      timeout: 15000,
      message: 'physics containment log (destroy variant)',
    })
    await waitUntil(() => server.lines(/script destroy\(\) crashed/).length > destroyLogs, {
      timeout: 10000,
      message: 'destroy failure log',
    })
    eq(server.lines(/crash rebuild failed|SES_UNHANDLED|UnhandledPromiseRejection/).length, 0, 'no unhandled rejection')
    const beat1 = await watcher.waitForReport('P1_OBSERVER_BEAT', { from: watcher.mark(), timeout: 10000 })
    const beat2 = await watcher.waitForReport('P1_OBSERVER_BEAT', { from: watcher.mark(), timeout: 10000 })
    ok(beat2.n > beat1.n, 'observer keeps ticking')
  })

  await step('A7 retry cap: a host-owned node that keeps failing is given up once and recovers', async () => {
    const from = watcher.mark()
    admin.installApp({ id: 's-retry', script: 'asset://retry-probe.js', model: 'asset://ai.glb', props: { ms: 4000 } })
    const armed = await watcher.waitForReport('P1_RETRY', { from, timeout: 15000 })
    eq(armed.patched, true, 'patched')
    // the watcher's own player node composes with x > 900 every pass while the patch is active
    const end = Date.now() + 3000
    while (Date.now() < end) {
      watcher.send('entityModified', { id: watcher.id, p: [999, 0, Math.random()], q: [0, 0, 0, 1] })
      await sleep(50)
    }
    const failedLines = server.lines(new RegExp(`\\[stage\\] node update failed .*entity ${watcher.id}\\)`))
    const gaveUp = server.lines(new RegExp(`\\[stage\\] giving up on node .*entity ${watcher.id}\\)`))
    eq(failedLines.length, 1, 'first failure logged once')
    eq(gaveUp.length, 1, 'gave up once')
    eq(server.count('script crashed'), 1, 'no app crashed because of the host node')
    await watcher.waitForReport('P1_RETRY', { from: watcher.mark(), timeout: 10000 }) // restored
    watcher.send('entityModified', { id: watcher.id, p: [1, 0, 1], q: [0, 0, 0, 1] })
    await sleep(500)
    const status = await fetch(`${base}/status`)
    eq(status.status, 200, 'server still responsive')
    const beat = await watcher.waitForReport('P1_OBSERVER_BEAT', { from: watcher.mark(), timeout: 10000 })
    ok(beat.n > 0, 'world still ticking')
    eq(server.lines(/giving up on node/).length, 1, 'no further give-ups after the patch is lifted')
  })

  await step('A8 server log: no unhandled rejections or SES errors', async () => {
    const bad = server.lines(/SES_UNCAUGHT|SES_UNHANDLED|UnhandledPromiseRejection/)
    eq(bad.length, 0, bad.slice(0, 2).join(' | '))
  })

  // the server-phase apps go away before the browser loads the world
  for (const id of [
    's-observer',
    's-sandbox',
    's-console-a',
    's-console-b',
    's-crasher',
    's-stage',
    's-stage2',
    's-physics',
    's-physics2',
    's-retry',
  ]) {
    admin.send('entityRemoved', id)
  }
  await sleep(500)
  watcher.close()
  admin.close()

  // ---------- phase B: browser ----------
  browser = await launchBrowser(ENGINE)
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const consoleLines = []
  const pageErrors = []
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.goto(server.url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.sidebar', { timeout: 180000 })
  await page.waitForFunction(() => window.world?.ui?.state?.active === true, null, { timeout: 60000 })
  await sleep(6000)
  const errorLines = () =>
    consoleLines.filter(
      l => l.startsWith('[error]') && !/WebGL|GPU|swiftshader|favicon|livekit|ERR_|Failed to load resource/i.test(l)
    )
  record(true, `${ENGINE}: world loaded`)

  const appsAtLoad = await page.evaluate(() => {
    const list = [...window.world.entities.items.values()].filter(e => e.data?.type === 'app')
    return list.map(e => ({
      id: e.data.id,
      name: e.blueprint?.name,
      script: !!e.blueprint?.script,
      loaded: !!e.script,
      error: e.scriptError?.message || null,
    }))
  })
  record(
    appsAtLoad.every(a => !a.error) && (!WORLD_SOURCE || appsAtLoad.length >= 5),
    `B1 apps built without script errors (${appsAtLoad.length} apps, ${appsAtLoad.filter(a => a.loaded).length} scripted)`,
    appsAtLoad
      .filter(a => a.error)
      .map(a => `${a.name}: ${a.error}`)
      .join(' | ')
  )
  const lockState = await page.evaluate(() => ({
    hardenReal: typeof globalThis.harden === 'function' && !globalThis.harden.isFake,
    objectProtoFrozen: Object.isFrozen(Object.prototype),
    arrayProtoFrozen: Object.isFrozen(Array.prototype),
    writeThrows: (() => {
      try {
        Array.prototype.__probe = 1
        delete Array.prototype.__probe
        return false
      } catch {
        return true
      }
    })(),
  }))
  record(
    lockState.hardenReal && lockState.objectProtoFrozen && lockState.arrayProtoFrozen && lockState.writeThrows,
    'B2 intrinsics frozen, harden real',
    JSON.stringify(lockState)
  )
  record(
    errorLines().length === 0 && pageErrors.length === 0,
    'B3 no console or page errors at load',
    [...errorLines(), ...pageErrors].slice(0, 3).join(' | ')
  )

  await becomeAdmin(page)
  record(true, 'B4 browser player is admin')

  // browser-side probes (these also run on the server, under different ids)
  await installApp(page, {
    id: 'b-observer',
    script: 'asset://observer.js',
    model: 'asset://ai.glb',
    position: [2, 0, -3],
  })
  await installApp(page, {
    id: 'b-sandbox',
    script: 'asset://sandbox-probe.js',
    model: 'asset://ai.glb',
    props: probeProps,
    position: [4, 0, -3],
  })
  await installApp(page, {
    id: 'b-open',
    script: 'asset://open-probe.js',
    model: 'asset://ai.glb',
    props: probeProps,
    position: [6, 0, -3],
  })
  await step('B5 intrinsic, endowment and stash writes are contained (browser)', async () => {
    const state = await waitUntil(
      async () => {
        const s = await appState(page, 'b-sandbox')
        const r = s?.state?.P1_SANDBOX
        return r && (r.done || r.failed) ? r : null
      },
      { timeout: 30000, message: 'browser sandbox probe' }
    )
    ok(!state.failed, `probe failed: ${state.failed}`)
    for (const key of [
      'arrayProto',
      'objectProto',
      'mathWrite',
      'endowmentWrite',
      'endowmentDefine',
      'consoleStash',
      'helperStash',
      'blobProtoWrite',
      'objectUrlNonFacade',
    ]) {
      eq(state[key], 'TypeError', key)
    }
    eq(state.stash, true, 'own stash')
    eq(state.arrayProbeLeak, undefined, 'no leak')
    eq(state.blob.frozen, true, 'facade frozen')
    eq(state.blob.stream, 'undefined', 'no stream()')
    eq(state.objectUrlType, 'application/octet-stream', 'html object URL is opaque')
    eq(state.objectUrlPngType, 'image/png', 'png object URL keeps its type')
    for (const key of ['syncError', 'loadError', 'readerError']) {
      eq(
        state[key].isError && state[key].chainFrozen && !state[key].hasCause && state[key].objectProps.length === 0,
        true,
        key
      )
    }
    const look = (await appState(page, 'b-observer')).state?.P1_OBSERVER
    ok(look, 'observer reported')
    eq(look.stash, 'undefined', 'observer sees no stash')
    eq(look.arrayProbe, 'undefined', 'observer sees no prototype write')
  })

  const probeCommand = async cmd => {
    await page.evaluate(cmd => {
      window.world.entities.get('b-open').data.state.cmd = cmd
    }, cmd)
    return waitUntil(async () => (await appState(page, 'b-open')).state?.results?.[cmd] ?? null, {
      timeout: 20000,
      message: `probe ${cmd}`,
    })
  }
  const openErrors = () => consoleLines.filter(l => l.includes('[world.open] only http(s)')).length
  const urlBefore = page.url()
  await step('B6 world.open (a): an html blob URL does not navigate', async () => {
    const before = openErrors()
    const r = await probeCommand('openBlob')
    ok(r.ok, r.error)
    await sleep(800)
    eq(page.url(), urlBefore, 'page url')
    eq(openErrors(), before + 1, 'one console error')
  })
  await step('B7 world.open (b): javascript: and data: URLs are rejected', async () => {
    const before = openErrors()
    ok((await probeCommand('openJavascript')).ok)
    ok((await probeCommand('openData')).ok)
    await sleep(800)
    eq(page.url(), urlBefore, 'page url')
    eq(openErrors(), before + 2, 'two console errors')
  })
  await step(
    'B8 world.open: same-origin /assets/ paths, asset:// and percent-encoded spellings are rejected',
    async () => {
      const before = openErrors()
      const r = await probeCommand('openAsset')
      ok(r.ok, r.error)
      eq(r.encodedStatus, 200, 'the server serves /%61ssets/ like /assets/')
      await sleep(800)
      eq(page.url(), urlBefore, 'page url')
      eq(openErrors(), before + 4, 'four console errors')
    }
  )
  await step('B9 world.open (c): a new window opens with no opener', async () => {
    const popupPromise = context.waitForEvent('page', { timeout: 15000 })
    ok((await probeCommand('openPopup')).ok)
    const popup = await popupPromise
    await popup.waitForLoadState('domcontentloaded')
    const info = await popup.evaluate(() => ({ opener: window.opener, url: location.href }))
    eq(info.opener, null, 'opener')
    ok(info.url.endsWith('/status'), info.url)
    await popup.close()
    eq(page.url(), urlBefore, 'page url')
  })
  await step('B10 world.open (d): a slice that asked for text/html is served as octet-stream', async () => {
    const r = await probeCommand('blobType')
    ok(r.ok, r.error)
    eq(r.contentType, 'application/octet-stream', 'content-type')
    eq(r.length, 5, 'slice length')
  })
  await step('B11 an image created from createObjectURL renders', async () => {
    const r = await probeCommand('image')
    ok(r.ok, r.error)
    eq(r.type, 'image/png', 'blob type')
    const loaded = await waitUntil(
      () =>
        page.evaluate(() => {
          const e = window.world.entities.get('b-open')
          let found = null
          e?.root?.traverse(n => {
            if (n.name === 'image' && n.texture?.image)
              found = { width: n.texture.image.naturalWidth || n.texture.image.width, mesh: !!n.mesh }
          })
          return found
        }),
      { timeout: 15000, message: 'image node texture' }
    )
    ok(loaded.width >= 1, JSON.stringify(loaded))
  })
  await step('B12 fetch options whitelist: extra keys are dropped and the request still works', async () => {
    const r = await probeCommand('fetchOptions')
    ok(r.ok, r.error)
    eq(r.status, 200, 'status')
    eq(r.json, 'object', 'json')
  })

  await installApp(page, {
    id: 'b-throwing',
    script: 'asset://throwing.js',
    model: 'asset://ai.glb',
    position: [8, 0, -3],
  })
  await installApp(page, {
    id: 'b-crasher',
    script: 'asset://crasher.js',
    model: 'asset://ai.glb',
    position: [10, 0, -3],
  })
  await installApp(page, {
    id: 'b-stage',
    script: 'asset://stage-crash.js',
    model: 'asset://ai.glb',
    position: [12, 0, -3],
  })
  await installApp(page, {
    id: 'b-physics',
    script: 'asset://physics-crash.js',
    model: 'asset://ai.glb',
    position: [14, 0, -3],
  })
  await step('B13 a throwing script shows the crash block', async () => {
    const s = await waitUntil(
      async () => {
        const s = await appState(page, 'b-throwing')
        return s?.error ? s : null
      },
      { timeout: 20000, message: 'throwing app crash' }
    )
    eq(s.error, 'P1_THROWING_SCRIPT', 'scriptError')
    // the crash block is fetched after scriptError is set; wait for the rebuilt root
    await waitUntil(() => page.evaluate(() => window.world.loader.results.has('model/asset://crash-block.glb')), {
      timeout: 15000,
      message: 'crash block model',
    })
  })
  await step('B14 an uncaught intrinsic write crashes only its app; the observer keeps running (browser)', async () => {
    const s = await waitUntil(
      async () => {
        const s = await appState(page, 'b-crasher')
        return s?.error ? s : null
      },
      { timeout: 20000, message: 'crasher crash' }
    )
    ok(/TypeError|readonly|not extensible|Cannot add property/i.test(s.error), s.error)
    // the heartbeat counts frames of update time (delta is clamped), so a slow headless renderer needs a while
    const n1 = (await appState(page, 'b-observer')).state?.P1_OBSERVER_BEAT?.n ?? 0
    const beat = await waitUntil(
      async () => {
        const b = (await appState(page, 'b-observer')).state?.P1_OBSERVER_BEAT
        return b && b.n > n1 ? b : null
      },
      { timeout: 30000, message: 'observer heartbeat' }
    )
    eq(beat.crasher, 'undefined', 'observer sees no crasher write')
  })
  await step('B15 Stage and Physics containment crash only the offending app (browser)', async () => {
    await waitUntil(async () => (await appState(page, 'b-stage'))?.error === 'P1_STAGE_BOOM', {
      timeout: 20000,
      message: 'stage crash',
    })
    await waitUntil(async () => (await appState(page, 'b-physics'))?.error === 'P1_PHYSICS_BOOM', {
      timeout: 20000,
      message: 'physics crash',
    })
    ok(
      consoleLines.some(l => l.includes('[stage] node update failed')),
      'stage log'
    )
    ok(
      consoleLines.some(l => l.includes('[physics] interpolation failed')),
      'physics log'
    )
    const observer = await appState(page, 'b-observer')
    ok(!observer.error, 'observer did not crash')
    const n1 = observer.state?.P1_OBSERVER_BEAT?.n ?? 0
    await waitUntil(async () => ((await appState(page, 'b-observer')).state?.P1_OBSERVER_BEAT?.n ?? 0) > n1, {
      timeout: 30000,
      message: 'observer heartbeat',
    })
  })

  await installApp(page, {
    id: 'b-stage2',
    script: 'asset://stage-crash.js',
    model: 'asset://ai.glb',
    props: { destroyThrows: true },
    position: [16, 0, -3],
  })
  await installApp(page, {
    id: 'b-physics2',
    script: 'asset://physics-crash.js',
    model: 'asset://ai.glb',
    props: { destroyThrows: true },
    position: [18, 0, -3],
  })
  await step('B15b containment teardown completes when the destroy listener throws (browser, both paths)', async () => {
    for (const [id, boom] of [
      ['b-stage2', 'P1_STAGE_BOOM'],
      ['b-physics2', 'P1_PHYSICS_BOOM'],
    ]) {
      const s = await waitUntil(
        async () => {
          const s = await appState(page, id)
          return s?.error === boom && !s.building && s.rootIsCrashBlock ? s : null
        },
        { timeout: 30000, message: `${id} crash block` }
      )
      eq(s.timers, 0, `${id} timers cleared`)
      eq(s.rootMounted, true, `${id} crash block mounted`)
    }
    ok(consoleLines.filter(l => l.includes('script destroy() crashed')).length >= 2, 'destroy failures logged')
    ok(!consoleLines.some(l => /crash rebuild failed/.test(l)), 'no failed rebuild')
    eq(
      pageErrors.filter(l => /P1_DESTROY_BOOM|Unhandled/i.test(l)).length,
      0,
      'no unhandled rejection from the destroy listener'
    )
    const observer = await appState(page, 'b-observer')
    ok(!observer.error, 'observer did not crash')
  })

  // ---------- script editor (Monaco from cdnjs) ----------
  const target = WORLD_SOURCE ? appsAtLoad.find(a => a.script && a.loaded) : { id: 'b-observer', name: 'b-observer' }
  const bpBefore = await page.evaluate(id => {
    const e = window.world.entities.get(id)
    return { bp: e.blueprint.id, version: e.blueprint.version, script: e.blueprint.script }
  }, target.id)
  let monacoUp = false
  for (let attempt = 1; attempt <= 3 && !monacoUp; attempt++) {
    await page.evaluate(id => {
      const w = window.world
      w.ui.setApp(w.entities.get(id))
      ;(w.ui.togglePane || w.ui.setPane).call(w.ui, 'script')
    }, target.id)
    try {
      await page.waitForSelector('.monaco-editor .view-lines .view-line', { timeout: 30000 })
      monacoUp = true
    } catch {
      console.log(`monaco did not render (attempt ${attempt}); reloading the page`)
      await sleep(2000 * attempt)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.sidebar', { timeout: 180000 })
      await page.waitForFunction(
        () => window.world?.ui?.state?.active === true && window.world.entities.player?.data?.rank === 2,
        null,
        { timeout: 60000 }
      )
      await sleep(4000)
    }
  }
  record(
    monacoUp,
    `B16 script editor opened on "${target.name}" (Monaco from cdnjs)`,
    monacoUp ? '' : 'cdnjs unreachable: the editor did not render in 3 attempts'
  )
  if (monacoUp) {
    await sleep(2000)
    const colour = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.monaco-editor .view-lines [class*="mtk"]')]
      const classes = new Set(spans.map(s => s.className))
      const tokens = window.monaco.editor
        .tokenize('const x = 1 // c', 'javascript')[0]
        .map(t => t.type)
        .filter(Boolean)
      return { spans: spans.length, classes: classes.size, tokens }
    })
    record(colour.classes >= 5 && colour.tokens.length >= 4, 'B17 syntax colouring works', JSON.stringify(colour))
    await page.screenshot({ path: path.join(OUT, `fullstack-${ENGINE}-editor.png`) })
    const widgets = await page.evaluate(async () => {
      const ed = window.monaco.editor.getEditors()[0]
      const visible = sel => {
        const el = document.querySelector(sel)
        return !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden'
      }
      const wait = async (sel, ms = 8000) => {
        const t0 = Date.now()
        while (Date.now() - t0 < ms) {
          if (visible(sel)) return true
          await new Promise(r => setTimeout(r, 100))
        }
        return false
      }
      const out = {}
      ed.focus()
      ed.setPosition({ lineNumber: 1, column: 1 })
      ed.trigger('e2e', 'editor.action.triggerSuggest')
      out.suggest = await wait('.suggest-widget.visible, .suggest-widget:not(.hidden) .monaco-list-row')
      ed.trigger('e2e', 'hideSuggestWidget')
      ed.getAction('actions.find').run()
      out.find = await wait('.find-widget.visible')
      ed.trigger('e2e', 'closeFindWidget')
      ed.getAction('editor.action.quickCommand').run()
      out.f1 = await wait('.quick-input-widget')
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
      )
      await new Promise(r => setTimeout(r, 200))
      document.activeElement?.blur?.()
      const model = ed.getModel()
      ed.focus()
      ed.setPosition({ lineNumber: model.getLineCount(), column: 1 })
      ed.trigger('e2e', 'type', { text: '\nconst broken = ;\n' })
      const t0 = Date.now()
      let markers = []
      while (Date.now() - t0 < 15000) {
        markers = window.monaco.editor.getModelMarkers({ resource: model.uri })
        if (markers.length) break
        await new Promise(r => setTimeout(r, 250))
      }
      out.markers = markers.length
      ed.trigger('e2e', 'undo', null)
      return out
    })
    record(
      widgets.suggest && widgets.find && widgets.f1 && widgets.markers > 0,
      'B18 editor widgets: suggest, find, F1, error markers',
      JSON.stringify(widgets)
    )
    await page.click('.monaco-editor .view-lines')
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('\n// e2e edit')
    await sleep(300)
    const saved = await page.evaluate(async () => {
      const ed = window.monaco.editor.getEditors()[0]
      const action = ed.getAction('save')
      if (!action) return 'no save action'
      await action.run()
      return 'ran'
    })
    let rebuilt
    try {
      await page.waitForFunction(
        ({ id, v }) => {
          const e = window.world.entities.get(id)
          return e?.blueprint?.version > v && e.script?.code?.includes('e2e edit') && !e.scriptError
        },
        { id: target.id, v: bpBefore.version },
        { timeout: 30000 }
      )
      rebuilt = await page.evaluate(id => {
        const e = window.world.entities.get(id)
        return { version: e.blueprint.version, script: e.blueprint.script, error: e.scriptError?.message || null }
      }, target.id)
    } catch (err) {
      rebuilt = { error: `timeout: ${err.message}` }
    }
    record(
      saved === 'ran' && rebuilt && !rebuilt.error,
      'B19 edit + save: version bumped, app rebuilt, no crash',
      JSON.stringify({ saved, before: bpBefore, after: rebuilt })
    )
    await sleep(1500)
    const snap = await snapshot(PORT)
    const bp = snap.blueprints.find(b => b.id === bpBefore.bp)
    record(
      !!bp && bp.version > bpBefore.version && bp.script !== bpBefore.script,
      'B20 server confirms the saved blueprint (fresh snapshot)',
      JSON.stringify({ version: bp?.version, script: bp?.script })
    )
  }

  // SES prints a logged error as a marker line, a "Name#n: message" line and stack frames; judge the message lines
  const SES_DETAIL = /^\[error\] (\([A-Za-z]*#\d+\)|\s+at |[\w$.<>[\] ]*@)/
  const unexpected = errorLines().filter(l => !SES_DETAIL.test(l) && !EXPECTED_ERROR.test(l))
  record(unexpected.length === 0, 'B21 no unexpected console errors', unexpected.slice(0, 3).join(' | '))
  record(pageErrors.length === 0, 'B22 no uncaught page errors', pageErrors.slice(0, 3).join(' | '))
  record(
    server.lines(/SES_UNCAUGHT|SES_UNHANDLED|UnhandledPromiseRejection/).length === 0,
    'B23 server log: no unhandled rejections or SES errors'
  )
  fs.writeFileSync(path.join(OUT, `fullstack-${ENGINE}-console.log`), consoleLines.join('\n'))
} catch (err) {
  record(false, 'aborted', err?.stack || String(err))
} finally {
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await server?.stop()
  process.exit(finish() ? 1 : 0)
}
