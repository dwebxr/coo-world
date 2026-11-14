// Full-stack e2e: boots the built server against a throwaway world, runs the sandbox and player-relay probes
// over the wire protocol (server side) and then in a real browser engine, and exercises the script editor
// end to end.
//
// usage: node test/e2e/fullstack.mjs --engine=chromium|webkit|firefox [--world=<dir>] [--port=3121]
//   --world: an existing world directory to copy (eg the local 5-app world); without it the server
//            bootstraps the default world from src/world
// Requires the four builds (see .github/workflows/e2e.yml). Logs and screenshots go to test/e2e/out/.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import WebSocket from 'ws'

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
import { waitForMemoryToSettle } from './lib/memory.mjs'
import { failedStart, installAsset, startServer } from './lib/server.mjs'
import { WireClient, snapshot } from './lib/ws.mjs'
import {
  REFUSED_INLINE,
  appState,
  becomeAdmin,
  installApp,
  launchBrowser,
  runInlineScript,
  saveArtifacts,
  watchPolicy,
} from './lib/browser.mjs'

// the client's payload check, applied here to what the server really put on the wire
const { sanitizeTeleport } = await import(pathToFileURL(path.join(REPO_ROOT, 'src/core/extras/playerRelayPolicy.js')))
// the server's old encoder, for the hostile reference-extension probe
const { PROTOCOL_VERSION, writePacket, readPacket } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'src/core/packets.js'))
)

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3121))
const WORLD_SOURCE = arg('world', null)
// --load-only: boot, load the world in the browser and run the load checks only (a diagnostic mode)
const LOAD_ONLY = arg('load-only', false) === true
const OUT = ensureOut()
const { record, step, finish } = createResults(`fullstack/${ENGINE}`)

// a 1x1 transparent PNG as a data URL (the image/png fixture for createObjectURL)
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// console errors the probes produce on purpose
const EXPECTED_ERROR =
  /\[world\.open\]|\[stage\]|\[physics\]|script crashed|script destroy\(\) crashed|script update\(\) crashed|Cannot convert a Symbol value to a number|P1_|crasher|not extensible|readonly property|Cannot add property|does-not-exist|GLTFLoader|createObjectURL expects|Body is unusable|body used already|json|on a remote player must be called on the server|onPlayerSessionAvatar: invalid payload/i
// the server's log line for a relay packet a client sent (once per socket and packet)
const RELAY_DROP = /\[network\] player\w+ from client \S+ ignored/
const RELAY_PACKET = m => /^onPlayer(Teleport|Push|SessionAvatar)$/.test(m.method)

let server
let browser
let context
let page
let base
let probeProps
let bystander
const consoleLines = []
const pageErrors = []
let violations = []
try {
  server = await startServer({
    port: PORT,
    worldSource: WORLD_SOURCE,
    // host-side test methods for the probe apps that used to patch THREE prototypes from a script (A7)
    preload: fileURLToPath(new URL('./lib/script-class-hook.js', import.meta.url)),
    // A12 asks the server what it retains after a flood
    memoryProbe: true,
    logPath: path.join(OUT, `fullstack-${ENGINE}-server.log`),
  })
  base = `http://localhost:${PORT}`
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
    'relay-probe',
    'event-probe',
    'chat-via-probe',
  ]) {
    installAsset(server, path.join(APPS_DIR, `${name}.js`))
  }
  probeProps = { base, png: PNG }

  // ---------- phase A: probes over the wire protocol (server-side compartments) ----------
  const admin = await new WireClient(PORT, 'admin').connect()
  const watcher = await new WireClient(PORT, 'watcher').connect()
  await admin.becomeAdmin()
  record(true, 'wire clients connected, admin granted')
  if (LOAD_ONLY) {
    watcher.close()
    admin.close()
    await loadOnly()
  } else {
    await probes(admin, watcher)
  }
} catch (err) {
  record(false, 'aborted', err?.stack || String(err))
} finally {
  // the browser log, page errors, page state and a screenshot are saved even when the run aborted
  await saveArtifacts({ page, consoleLines, pageErrors, prefix: path.join(OUT, `fullstack-${ENGINE}`) })
  bystander?.close()
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await server?.stop()
  process.exit(finish() ? 1 : 0)
}

async function openBrowser() {
  browser = await launchBrowser(ENGINE)
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  violations = await watchPolicy(context)
  page = await context.newPage()
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.goto(server.url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.sidebar', { timeout: 180000 })
  await page.waitForFunction(() => window.world?.ui?.state?.active === true, null, { timeout: 60000 })
  await sleep(6000)
  record(true, `${ENGINE}: world loaded`)
}

// hoisted: the top-level try block above runs before the declarations that follow it are initialized
function errorLines() {
  return consoleLines.filter(
    l => l.startsWith('[error]') && !/WebGL|GPU|swiftshader|favicon|livekit|ERR_|Failed to load resource/i.test(l)
  )
}

async function loadChecks() {
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
  // in --load-only mode the lock state is reported, not required (the mode exists to compare trees)
  record(
    LOAD_ONLY ||
      (lockState.hardenReal && lockState.objectProtoFrozen && lockState.arrayProtoFrozen && lockState.writeThrows),
    'B2 intrinsics frozen, harden real',
    JSON.stringify(lockState)
  )
  record(
    errorLines().length === 0 && pageErrors.length === 0,
    'B3 no console or page errors at load',
    [...errorLines(), ...pageErrors].slice(0, 3).join(' | ')
  )
  return appsAtLoad
}

async function loadOnly() {
  await openBrowser()
  await loadChecks()
  record(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3).join(' | '))
}

async function probes(admin, watcher) {
  await step('A0 server-side fetch Brotli guard installed at boot', async () => {
    ok(server.out.includes('[fetch] brotli guard installed'), 'boot line present')
  })

  await step('A0b a server that cannot start ends with exit code 1, and does not stay up', async () => {
    // a setting it refuses: thrown at the top of the entry module. This used to end with code 0
    const setting = await failedStart({ port: PORT + 7, env: { PUBLIC_MAX_UPLOAD_SIZE: 'lots' } })
    ok(setting.out.includes('[envs] PUBLIC_MAX_UPLOAD_SIZE must be a positive number'), setting.out.slice(-400))
    ok(setting.out.includes('[server] start-up failed; exiting with code 1'), 'the exit is said')
    eq(setting.code, 1, 'exit code for a refused setting')
    // a setting one of the world's systems refuses as it is made, after a timer of another was started: this is
    // the kind of failure that stayed up without listening
    const system = await failedStart({ port: PORT + 7, env: { AI_MAX_CONCURRENT: '0' } })
    ok(system.out.includes('AI_MAX_CONCURRENT'), system.out.slice(-400))
    eq(system.code, 1, 'exit code for a setting a system refuses')
    // a database it cannot read: a step of the start-up rejects after other things were set up
    const database = await failedStart({
      port: PORT + 7,
      prepare: worldDir => fs.writeFileSync(path.join(worldDir, 'db.sqlite'), 'this is not a database'),
    })
    eq(database.code, 1, `exit code for an unreadable database: ${database.out.slice(-400)}`)
    ok(!database.out.includes('server listening on port'), 'it never listened')
  })

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
          .filter(m => m.method === 'onEntityEvent' && m.data[0] === 's-sandbox' && m.data[2] === 'P1_SANDBOX')
          .map(m => m.data[3])
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
    const at = server.out.indexOf('console probe')
    ok(at >= 0 && /marker: 'P1_CONSOLE_A'/.test(server.out.slice(at, at + 4000)), 'the object is rendered readably')
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

  // what the e2e hook's compose fault throws (the stage probe's stand-in for a Stage failure, stage-crash.js), and
  // what the physics probe's refused callback reports (the node's own transform is sealed, its callback fixed).
  // The refusal is the engine's own TypeError for a write to a read-only property, worded by each engine: V8
  // (the server, Chromium) and SpiderMonkey (Firefox) name the property, JavaScriptCore (WebKit) does not.
  const STAGE_BOOM = /P1_RETRY_PROBE/
  const PHYSICS_REFUSED = new RegExp(
    'P1_PHYSICS_REFUSED .*(' +
      [
        "read only property '_onChangeCallback'",
        'Attempted to assign to readonly property',
        '"_onChangeCallback" is read-only',
        'change callback cannot be replaced',
      ].join('|') +
      ')'
  )
  await step('A5 a planted non-number is read as NaN; a Stage failure crashes only its app (server)', async () => {
    const from = watcher.mark()
    admin.installApp({
      id: 's-stage',
      script: 'asset://stage-crash.js',
      model: 'asset://ai.glb',
      props: { fault: true },
    })
    const guarded = await watcher.waitForReport('P1_STAGE_GUARDED', { from, timeout: 15000 })
    eq(guarded.x, 'NaN', 'a planted Symbol is read as NaN')
    eq(guarded.y, 'NaN', 'a planted object is read as NaN')
    eq(server.count('P1_STAGE_VALUEOF'), 0, "the planted object's valueOf never ran")
    await waitUntil(() => server.lines(/\[stage\] node update failed .*entity s-stage\)/).length === 1, {
      timeout: 15000,
      message: 'stage containment log',
    })
    ok(STAGE_BOOM.test(server.out), 'error logged')
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
      props: { destroyThrows: true, fault: true },
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

  await step(
    'A6 a change callback of its own on an engine transform is refused; only its app crashes (server)',
    async () => {
      const before = server.count('P1_PHYSICS_REFUSED')
      admin.installApp({ id: 's-physics', script: 'asset://physics-crash.js', model: 'asset://ai.glb' })
      await waitUntil(() => server.count('P1_PHYSICS_REFUSED') > before, {
        timeout: 15000,
        message: 'refusal logged',
      })
      ok(PHYSICS_REFUSED.test(server.out), 'the change callback could not be replaced')
      eq(
        server.lines(/\[physics\] interpolation failed .*entity s-physics\)/).length,
        0,
        'nothing ran in the physics step'
      )
      const beat1 = await watcher.waitForReport('P1_OBSERVER_BEAT', { from: watcher.mark(), timeout: 10000 })
      const beat2 = await watcher.waitForReport('P1_OBSERVER_BEAT', { from: watcher.mark(), timeout: 10000 })
      ok(beat2.n > beat1.n, 'observer keeps ticking')
    }
  )

  await step("A6b the physics probe's teardown completes when the destroy listener throws (server)", async () => {
    const destroyLogs = server.lines(/script destroy\(\) crashed/).length
    admin.installApp({
      id: 's-physics2',
      script: 'asset://physics-crash.js',
      model: 'asset://ai.glb',
      props: { destroyThrows: true },
    })
    const refusals = server.count('P1_PHYSICS_REFUSED')
    await waitUntil(() => server.count('P1_PHYSICS_REFUSED') > refusals, {
      timeout: 15000,
      message: 'refusal logged (destroy variant)',
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

  await step('A8 a client-sent player relay packet is dropped and logged once per socket and packet', async () => {
    const from = watcher.mark()
    const fromAdmin = admin.mark()
    for (let i = 0; i < 3; i++) {
      admin.send('playerTeleport', { networkId: watcher.id, position: [9, 9, 9], rotationY: 0 })
      admin.send('playerPush', { networkId: watcher.id, force: [1, 0, 0] })
      admin.send('playerSessionAvatar', { networkId: watcher.id, avatar: 'asset://avatar.vrm' })
    }
    // malformed copies must not reach any property read either
    admin.send('playerTeleport', null)
    admin.send('playerPush', 'junk')
    admin.send('playerSessionAvatar', [])
    await waitUntil(() => server.lines(RELAY_DROP).length >= 3, { timeout: 10000, message: 'relay drop log' })
    await sleep(500)
    const mine = server.lines(new RegExp(`\\[network\\] (\\w+) from client ${admin.id} ignored`))
    eq(mine.length, 3, `one line per packet name: ${mine.join(' | ')}`)
    ok(
      mine.some(l => l.includes(' playerTeleport ')),
      'teleport logged'
    )
    ok(
      mine.some(l => l.includes(' playerPush ')),
      'push logged'
    )
    ok(
      mine.some(l => l.includes(' playerSessionAvatar ')),
      'session avatar logged'
    )
    eq(watcher.since(from).filter(RELAY_PACKET).length, 0, 'the target received nothing')
    eq(admin.since(fromAdmin).filter(RELAY_PACKET).length, 0, 'the sender received nothing')
    // another socket gets its own single line
    watcher.send('playerPush', { networkId: admin.id, force: [1, 0, 0] })
    watcher.send('playerPush', { networkId: admin.id, force: [1, 0, 0] })
    await waitUntil(() => server.lines(RELAY_DROP).length >= 4, { timeout: 10000, message: 'second socket drop log' })
    await sleep(300)
    eq(server.lines(RELAY_DROP).length, 4, 'four lines in total')
    eq(admin.since(fromAdmin).filter(RELAY_PACKET).length, 0, 'the admin received nothing from the watcher')
    const status = await fetch(`${base}/status`)
    eq(status.status, 200, 'server still responsive')
  })

  await step('A8b /status counts who is here and names nobody', async () => {
    const response = await fetch(`${base}/status`)
    const text = await response.text()
    const status = JSON.parse(text)
    ok(Number.isInteger(status.connectedUsers) && status.connectedUsers >= 2, `count: ${status.connectedUsers}`)
    eq(status.protected, true, 'protected')
    for (const client of [admin, watcher]) {
      ok(!text.includes(client.id), 'no user id in the body')
    }
    ok(!/"position"|"name"/.test(text), 'no positions or names')
    return `connectedUsers: ${status.connectedUsers}`
  })

  await step('A9 server-script teleport, push and session avatar still reach the player, well-formed', async () => {
    const from = watcher.mark()
    const fromAdmin = admin.mark()
    admin.installApp({
      id: 's-relay',
      script: 'asset://relay-probe.js',
      model: 'asset://ai.glb',
      props: { serverTarget: watcher.id },
    })
    const report = await watcher.waitForReport('P4_RELAY', { from, timeout: 15000 })
    eq(report.found, true, 'the server script found the target player')
    const got = await waitUntil(
      () => {
        const packets = watcher.since(from).filter(RELAY_PACKET)
        return packets.length >= 3 ? packets : null
      },
      { timeout: 10000, message: 'relay packets from the server path' }
    )
    eq(got.map(m => m.method).join(','), 'onPlayerTeleport,onPlayerTeleport,onPlayerPush', 'packets in call order')
    eq(
      JSON.stringify(sanitizeTeleport(got[0].data)),
      JSON.stringify({ position: [1, 2, 3], rotationY: 0.5 }),
      'teleport'
    )
    ok(typeof got[1].data.rotationY !== 'number', 'the quaternion arrives as a non-number')
    eq(JSON.stringify(sanitizeTeleport(got[1].data)), JSON.stringify({ position: [4, 5, 6] }), 'rotationY ignored')
    eq(JSON.stringify(got[2].data), JSON.stringify({ force: [0, 0, -30] }), 'push payload')
    eq(admin.since(fromAdmin).filter(RELAY_PACKET).length, 0, 'only the target player received them')
    // The session avatar is the server's own change now: applied there and told to everyone, the player included,
    // as a change to the player (it used to go to the player's client alone, which sent it on as its own).
    const avatars = client =>
      client
        .since(client === watcher ? from : fromAdmin)
        .filter(m => m.method === 'onEntityModified' && m.data.id === watcher.id && 'sessionAvatar' in m.data)
        .map(m => m.data.sessionAvatar)
    for (const client of [watcher, admin]) {
      await waitUntil(() => avatars(client).length >= 2, { timeout: 10000, message: 'session avatar changes' })
      eq(JSON.stringify(avatars(client)), JSON.stringify(['asset://avatar.vrm', null]), 'set, then cleared')
    }
  })

  await step('A9b a url outside the world: a script may choose it for a visitor; the visitor may not', async () => {
    // files of this world's own store, by an address that is not the world's assets url (another host name), so
    // they are urls outside the world as far as the rule goes
    const outside = name => `http://127.0.0.1:${PORT}/assets/${name}`
    const scriptAvatar = outside('avatar.vrm')
    const scriptEmote = outside('emote-float.glb')
    const own = outside('avatar.vrm?mine')
    const fromAdmin = admin.mark()
    const fromWatcher = watcher.mark()
    const seen = (client, from, key) =>
      client
        .since(from)
        .filter(m => m.method === 'onEntityModified' && m.data.id === watcher.id && key in m.data)
        .map(m => m.data[key])
    admin.installApp({
      id: 's-outside',
      script: 'asset://relay-probe.js',
      model: 'asset://ai.glb',
      props: { serverTarget: watcher.id, serverAvatar: scriptAvatar, serverEmote: scriptEmote },
    })
    // the script's choice reaches everyone: the avatar as the player's session avatar, the emote inside the effect
    await waitUntil(() => seen(admin, fromAdmin, 'sessionAvatar').length >= 1, { message: "the script's avatar" })
    eq(
      seen(admin, fromAdmin, 'sessionAvatar')[0],
      scriptAvatar,
      'the avatar a script chose, with the visitor a visitor'
    )
    // and the visitor's own connection has it too, before the mark below is taken: arriving after it, this packet
    // would be taken for the answer to the visitor's own update
    await waitUntil(() => seen(watcher, fromWatcher, 'sessionAvatar').length >= 1, {
      message: "the script's avatar, on the visitor's connection",
    })
    eq(JSON.stringify(seen(watcher, fromWatcher, 'sessionAvatar')), JSON.stringify([scriptAvatar]), 'told the visitor')
    await waitUntil(() => seen(admin, fromAdmin, 'ef').length >= 1, { message: "the script's effect" })
    eq(seen(admin, fromAdmin, 'ef')[0].emote, scriptEmote, 'the effect carries its emote')
    // the visitor's client names the emote it plays: the one the script chose is relayed, another is not
    // (each in a tick of its own: of two changes to a player's emote in one tick the others are told the later)
    watcher.send('entityModified', { id: watcher.id, e: scriptEmote })
    await waitUntil(() => seen(admin, fromAdmin, 'e').length >= 1, { message: 'the first emote change' })
    watcher.send('entityModified', { id: watcher.id, e: outside('emote-jump.glb') })
    await waitUntil(() => seen(admin, fromAdmin, 'e').length >= 2, { message: 'two emote changes' })
    eq(JSON.stringify(seen(admin, fromAdmin, 'e')), JSON.stringify([scriptEmote, null]), 'chosen relayed, other nulled')
    // The visitor's own avatar outside the world: not relayed, and put right for the visitor. An update the server
    // does relay follows it (an emote of the world's own store): whatever the refused one made the server send the
    // admin arrives before that one does, on the same ordered connection.
    const barrier = 'asset://emote-float.glb?s=1.25'
    const fromAdminOwn = admin.mark()
    const fromWatcherOwn = watcher.mark()
    // (numbered as a browser numbers its own session avatar updates)
    watcher.send('entityModified', { id: watcher.id, sessionAvatar: own, sessionAvatarRequest: 41 })
    watcher.send('entityModified', { id: watcher.id, e: barrier })
    await waitUntil(() => seen(admin, fromAdminOwn, 'e').includes(barrier), { message: 'the update after it' })
    eq(seen(admin, fromAdminOwn, 'sessionAvatar').length, 0, 'nothing relayed')
    ok(!JSON.stringify(admin.since(fromAdmin)).includes('?mine'), "the visitor's url reached nobody")
    ok(!JSON.stringify(admin.since(fromAdmin)).includes('sessionAvatarRequest'), 'nor its number')
    // the answer: a packet sent after the refused update, with the avatar the server has (the script's) and the
    // update's number
    await waitUntil(() => seen(watcher, fromWatcherOwn, 'sessionAvatar').length >= 1, { message: 'the correction' })
    eq(JSON.stringify(seen(watcher, fromWatcherOwn, 'sessionAvatar')), JSON.stringify([scriptAvatar]), 'the correction')
    eq(JSON.stringify(seen(watcher, fromWatcherOwn, 'sessionAvatarRequest')), '[41]', 'carrying the number')
    // a late joiner's snapshot carries the script's choice and nothing of the visitor's own
    const late = await new WireClient(PORT, 'late').connect()
    const record = late.snapshot.entities.find(entity => entity.id === watcher.id)
    late.close()
    eq(record.sessionAvatar, scriptAvatar, 'the snapshot has the avatar a script chose')
    ok(!JSON.stringify(late.snapshot).includes('sessionAvatarRequest'), 'and no number')
    // a builder's own url outside the world is relayed as before, and the builder is told the value the server took,
    // as every sender of a session avatar is
    const fromWatcher2 = watcher.mark()
    const fromAdmin2 = admin.mark()
    admin.send('entityModified', { id: admin.id, sessionAvatar: own })
    for (const [client, from] of [
      [watcher, fromWatcher2],
      [admin, fromAdmin2],
    ]) {
      await client.waitFor(
        m => m.method === 'onEntityModified' && m.data.id === admin.id && m.data.sessionAvatar === own,
        { from, timeout: 10000 }
      )
    }
    admin.send('entityModified', { id: admin.id, sessionAvatar: null })
    watcher.send('entityModified', { id: watcher.id, sessionAvatar: null, e: null })
    // The script's effect on the visitor has 30 s to run and the visitor's client has not ended it. The app is
    // removed: the server gives the effect back, and everyone is told, the visitor's own connection included
    // (nothing else would end it there before its time; an effect without one would have stayed for good)
    const fromAdminEnd = admin.mark()
    const fromWatcherEnd = watcher.mark()
    admin.send('entityRemoved', 's-outside')
    for (const [client, from] of [
      [admin, fromAdminEnd],
      [watcher, fromWatcherEnd],
    ]) {
      await waitUntil(() => seen(client, from, 'ef').length >= 1, { message: "the end of the script's effect" })
      eq(JSON.stringify(seen(client, from, 'ef')), '[null]', 'the effect is ended for everyone, once')
    }
  })

  await step('A10 a malformed chat message is refused; a valid one is rebuilt by the server', async () => {
    const from = watcher.mark()
    const before = server.count('onChatAdded: invalid message')
    // refused: a non-text body, a blank body, a packet that is not a plain object; logged once per connection
    admin.send('chatAdded', { id: 'p4-bad-object', body: { bad: true } })
    admin.send('chatAdded', { id: 'p4-bad-array', body: ['x'] })
    admin.send('chatAdded', { id: 'p4-bad-blank', body: '   ' })
    admin.send('chatAdded', 'just a string')
    admin.send('chatAdded', null)
    // accepted: the body is kept; the id, sender and time are stamped by the server; the rest is dropped
    admin.send('chatAdded', {
      id: 'p4-chat',
      body: '  P4_CHAT_OK  ',
      from: 'spoof',
      fromId: 'spoof',
      createdAt: 'bogus',
      extra: 1,
    })
    admin.send('chatAdded', { id: 'p4-long', body: 'L'.repeat(5000) })
    admin.send('chatAdded', { id: {}, body: 'P4_CHAT_ID' })
    // the cut never splits a grapheme: 501 units ending in an emoji keep 499, 502 units keep the 500 letters
    admin.send('chatAdded', { body: 'P4_CHAT_E1' + 'a'.repeat(489) + '😀' })
    admin.send('chatAdded', { body: 'P4_CHAT_E2' + 'a'.repeat(490) + '😀' })
    const got = await waitUntil(
      () => {
        const packets = watcher
          .since(from)
          .filter(m => m.method === 'onChatAdded' && /^(P4_CHAT|L{10})/.test(String(m.data?.body)))
        return packets.length >= 5 ? packets : null
      },
      { timeout: 10000, message: 'rebuilt chat messages' }
    )
    await sleep(500)
    eq(server.count('onChatAdded: invalid message') - before, 1, 'the refusals are logged once per connection')
    ok(server.out.includes(`onChatAdded: invalid message from ${admin.id}`), 'the line names the connection')
    eq(got.length, 5, 'exactly the accepted messages arrive')
    const [accepted, long, minted, emoji1, emoji2] = got.map(m => m.data)
    eq(
      JSON.stringify(Object.keys(accepted).sort()),
      JSON.stringify(['body', 'createdAt', 'from', 'fromId', 'id', 'kind']),
      'fields'
    )
    eq(accepted.kind, 'player', 'a player line, stamped by the server')
    ok(
      typeof accepted.id === 'string' && accepted.id.length > 0 && accepted.id !== 'p4-chat',
      `the id is minted by the server (${accepted.id})`
    )
    eq(accepted.body, 'P4_CHAT_OK', 'body trimmed')
    eq(accepted.from, 'admin', 'sender name from the socket')
    eq(accepted.fromId, admin.id, 'sender id from the socket')
    ok(!Number.isNaN(Date.parse(accepted.createdAt)) && accepted.createdAt !== 'bogus', 'server time')
    eq(long.body.length, 500, 'body capped at 500 characters')
    ok(typeof minted.id === 'string' && minted.id !== '[object Object]' && minted.id.length > 0, minted.id)
    eq(emoji1.body.length, 499, 'an emoji crossing the cap is cut off whole')
    ok(emoji1.body.endsWith('a'), 'no lone surrogate at the end')
    eq(emoji2.body.length, 500, 'a full window of letters is kept')
    // a second connection's refusals get their own single line
    watcher.send('chatAdded', { body: 42 })
    watcher.send('chatAdded', { body: 42 })
    await waitUntil(() => server.count('onChatAdded: invalid message') - before === 2, {
      timeout: 5000,
      message: 'second socket chat log',
    })
    await sleep(300)
    eq(server.count('onChatAdded: invalid message') - before, 2, 'two lines in total')
    // the history that later clients receive holds only the accepted messages, as text, under server ids
    const snap = await snapshot(PORT)
    ok(
      snap.chat.every(m => typeof m.body === 'string'),
      'every stored body is a string'
    )
    eq(snap.chat.filter(m => /^p4-/.test(m.id)).length, 0, 'no client-chosen id was stored')
    ok(
      snap.chat.some(m => m.body === 'P4_CHAT_OK' && m.from === 'admin'),
      'the valid one is stored'
    )
    eq(snap.chat.find(m => m.body.startsWith('LLLLLLLLLL'))?.body.length, 500, 'the long one is stored capped')
    eq(
      watcher.since(from).filter(m => m.method === 'onChatAdded' && typeof m.data?.body !== 'string').length,
      0,
      'nothing non-text was relayed'
    )
  })

  await step('A11 server log: no unhandled rejections or SES errors', async () => {
    const bad = server.lines(/SES_UNCAUGHT|SES_UNHANDLED|UnhandledPromiseRejection/)
    eq(bad.length, 0, bad.slice(0, 2).join(' | '))
  })

  // ---------- inbound limits: oversize frames, oversize events, floods, decode bombs, connection churn ----------
  const pingReports = (client, from) =>
    client.since(from).filter(m => m.method === 'onChatAdded' && String(m.data?.body).startsWith('P5_PING '))
  await step(
    'A12 entityEvent floods are bounded: oversize frames close, oversize packets drop, memory stays flat',
    async () => {
      admin.installApp({ id: 's-event', script: 'asset://event-probe.js', model: 'asset://ai.glb' })
      await sleep(500)
      const baseline = await server.retainedMiB()
      // (a) 20 connections each send one message above the 64 KiB ceiling: each is closed with 1009, the server stays up
      const giant = 'x'.repeat(70 * 1024)
      const giants = await Promise.all(
        Array.from({ length: 20 }, (_, i) => new WireClient(PORT, `giant-${i}`).connect())
      )
      for (const g of giants) g.send('entityEvent', ['s-event', 0, 'probe', giant])
      const codes = await Promise.all(giants.map(g => Promise.race([g.closed, sleep(15000).then(() => 'open')])))
      eq(codes.filter(c => c === 1009).length, 20, `close codes: ${codes.join(',')}`)
      // (b) 40 KiB chat packets fit the transport but exceed their 32 KiB packet cap. They are dropped
      // before decoding and logged once; the socket stays open and nothing is broadcast
      const dropper = await new WireClient(PORT, 'dropper').connect()
      const fromDrop = watcher.mark()
      const oversize = 'y'.repeat(40 * 1024)
      for (let i = 0; i < 200; i++) dropper.send('chatAdded', { body: oversize })
      const dropLine = new RegExp(
        `\\[network\\] chatAdded from client ${dropper.id} dropped: \\d+ bytes over the 32768 byte limit`
      )
      await waitUntil(() => server.lines(dropLine).length >= 1, { timeout: 15000, message: 'oversize packet log' })
      await sleep(1000)
      eq(server.lines(new RegExp(`\\[network\\] chatAdded from client ${dropper.id} dropped`)).length, 1, 'logged once')
      ok(dropper.isOpen, 'the socket stays open')
      eq(
        watcher.since(fromDrop).filter(m => m.method === 'onChatAdded' && m.data?.body?.startsWith('yyyy')).length,
        0,
        'oversize chat was not broadcast'
      )
      // (c) 2000 events of 60 KB stamped with a far-future blueprint version: the rate limit drops most of them
      // before decoding, the app refuses the rest without queueing them, and an event with the current version
      // from the same socket is delivered afterwards
      const flood = await new WireClient(PORT, 'flood').connect()
      const chunk = 'z'.repeat(60 * 1000)
      for (let i = 0; i < 2000; i++) flood.send('entityEvent', ['s-event', 1e12, 'probe', chunk])
      const futureLine = /\[app\] s-event: event dropped \(future version\)/
      const rateLine = new RegExp(`\\[network\\] packet from client ${flood.id} dropped: rate limit`)
      await waitUntil(() => server.lines(futureLine).length >= 1, { timeout: 20000, message: 'future version log' })
      await waitUntil(() => server.lines(rateLine).length >= 1, { timeout: 20000, message: 'rate limit log' })
      await sleep(2500)
      eq(server.lines(futureLine).length, 1, 'future version logged once')
      eq(server.lines(rateLine).length, 1, 'rate limit logged once')
      ok(flood.isOpen, 'the flooding socket is not disconnected')
      const fromPing = watcher.mark()
      flood.send('entityEvent', ['s-event', 0, 'probe', { n: 1 }])
      const ping = await watcher.waitForReport('P5_PING', { from: fromPing, timeout: 10000 })
      eq(ping.data.n, 1, 'a current-version event is delivered after the flood')
      eq(ping.from, flood.id, 'from the flooding socket')
      // (d) what the floods left behind. The frames above are garbage: the server must not keep them once it has
      // worked through them (the unfixed server kept the decoded events for ever; the 2000 of (c) alone are
      // 114 MiB). heapUsed + external after a full collection, since how much garbage is still resident depends on
      // the Node version and on how busy the machine is. The bound allows smaller leftovers (all of (a) and (b) are
      // 9 MiB) and cannot see native memory that V8 is not told about; the assertions above carry the rest. The wait
      // covers a server that is still working through the flood; it ends at a fixed deadline, and a request that
      // times out counts as not settled yet (lib/memory.mjs)
      const retained = await waitForMemoryToSettle(options => server.retainedMiB(options), {
        baseline,
        bound: 48,
        timeout: 60000,
      })
      const status = await fetch(`${base}/status`)
      eq(status.status, 200, 'server still responsive')
      dropper.close()
      flood.close()
      return `retained ${baseline} -> ${retained} MiB, rss ${(await admin.serverStats()).rss} MiB`
    }
  )

  await step('A12b per-socket inboxes drain 15 large packets each in FIFO order', async () => {
    const clients = await Promise.all(['inbox-a', 'inbox-b'].map(name => new WireClient(PORT, name).connect()))
    try {
      const from = watcher.mark()
      // Each burst exceeds the former 256 KiB wire budget but fits its socket's 1 MiB charged inbox.
      // The scheduler budgets nodes + floor(bytes / 128), with FIFO preserved separately for each socket.
      for (let i = 0; i < 15; i++) {
        for (const client of clients) client.send('entityEvent', ['s-event', 0, 'size', 's'.repeat(60000 + i)])
      }
      const reports = () =>
        watcher
          .since(from)
          .filter(m => m.method === 'onChatAdded' && String(m.data?.body).startsWith('P5_SIZE '))
          .map(m => JSON.parse(m.data.body.slice('P5_SIZE '.length)))
      await waitUntil(() => reports().length === 30, { timeout: 15000, message: 'both large inbox bursts to drain' })
      for (const client of clients) {
        const lengths = reports()
          .filter(report => report.from === client.id)
          .map(report => report.length)
        eq(JSON.stringify(lengths), JSON.stringify(Array.from({ length: 15 }, (_, i) => 60000 + i)), 'per-socket FIFO')
        ok(client.isOpen, 'the connection remains open after draining')
        eq(
          server.lines(new RegExp(`\\[network\\] entityEvent from client ${client.id} dropped`)).length,
          0,
          'no inbox eviction or drop'
        )
      }
    } finally {
      for (const client of clients) client.close()
    }
  })

  await step(
    'A13 decode bombs (pointer DAG + trailing byte, BigInt, Error) are refused without stalling the server',
    async () => {
      const bomber = await new WireClient(PORT, 'bomber').connect()
      const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
      const dag = (depth, width) => {
        let o = { x: 1 }
        for (let i = 0; i < depth; i++) {
          const n = {}
          for (let j = 0; j < width; j++) n[`k${j}`] = o
          o = n
        }
        return o
      }
      const errorItem = Buffer.from([0xd4, 0x65, 0x00, 0x93, 0xa5, 0x45, 0x72, 0x72, 0x6f, 0x72, 0xa1, 0x78, 0xc0])
      const errorCount = Math.floor(60_000 / errorItem.length)
      const bombs = {
        dag: Buffer.concat([
          Buffer.from(writePacket('entityEvent', ['s-event', 0, 'probe', dag(16, 4)])),
          Buffer.from([0xc0]),
        ]),
        bigint: Buffer.concat([Buffer.from([0x92, 0x08, 0xc9, ...u32(60_000), 0x42]), Buffer.alloc(60_000, 0x7f)]),
        error: Buffer.concat([
          Buffer.from([0x92, 0x08, 0xdd, ...u32(errorCount)]),
          ...Array(errorCount).fill(errorItem),
        ]),
      }
      const latency = async () => {
        const t0 = performance.now()
        const r = await fetch(`${base}/status`)
        eq(r.status, 200, '/status')
        return Math.round(performance.now() - t0)
      }
      const before = (await admin.serverStats()).rss
      const results = {}
      for (const [name, bytes] of Object.entries(bombs)) {
        ok(bytes.length <= 65536, `${name} fits the entityEvent cap (${bytes.length} bytes)`)
        for (let i = 0; i < 10; i++) bomber.sendRaw(bytes)
        await sleep(300)
        results[name] = { bytes: bytes.length, statusMs: await latency() }
        ok(results[name].statusMs < 2000, `${name}: /status answered in ${results[name].statusMs} ms`)
      }
      const undecodable = new RegExp(`entityEvent from client ${bomber.id} dropped: undecodable`)
      await waitUntil(() => server.lines(undecodable).length >= 1, { timeout: 5000, message: 'undecodable log' })
      eq(server.lines(undecodable).length, 1, 'logged once per connection')
      ok(!/Data read, but end of buffer not reached/.test(server.out), 'no rendered view of a bomb in the log')
      ok(bomber.isOpen, 'the socket stays open')
      const fromPing = watcher.mark()
      bomber.send('entityEvent', ['s-event', 0, 'probe', { after: 'bombs' }])
      const ping = await watcher.waitForReport('P5_PING', { from: fromPing, timeout: 10000 })
      eq(ping.data.after, 'bombs', 'a well-formed event from the same socket is delivered')
      const after = (await admin.serverStats()).rss
      ok(after - before < 32, `rss ${before} -> ${after} MB`)
      bomber.close()
      return JSON.stringify({ ...results, rss: [before, after] })
    }
  )

  await step('A14 connection churn from one address is limited while a handful of tabs still connect', async () => {
    // a second server with the default connection limits (the main one runs with them disabled)
    const port = PORT + 1
    const limited = await startServer({
      port,
      worldSource: WORLD_SOURCE,
      logPath: path.join(OUT, `fullstack-${ENGINE}-limited-server.log`),
      env: {
        WS_CONNECT_RATE_PER_MIN: '',
        WS_CONNECT_BURST: '',
        WS_CONNECT_RATE_PER_MIN_56: '',
        WS_CONNECT_RATE_PER_MIN_48: '',
        WS_CONNECT_CONCURRENT_PER_IP: '',
      },
    })
    try {
      const started = performance.now()
      // six tabs at once all get in
      const tabs = await Promise.all(Array.from({ length: 6 }, (_, i) => new WireClient(port, `tab-${i}`).connect()))
      ok(
        tabs.every(t => t.id),
        'six concurrent connections from one address are admitted'
      )
      for (const t of tabs) t.close()
      await Promise.all(tabs.map(t => t.closed))
      // Refusals happen before upgrade, so use ws's HTTP response hook for these attempts.
      let admitted = 0
      let refused = 0
      for (let i = 0; i < 200; i++) {
        const outcome = await new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://localhost:${port}/ws?v=${PROTOCOL_VERSION}&name=churn-${i}`)
          let result
          let upgraded = false
          const timer = setTimeout(() => {
            ws.terminate()
            reject(new Error('churn attempt timed out'))
          }, 5000)
          const finish = value => {
            clearTimeout(timer)
            resolve(value)
          }
          ws.on('open', () => {
            upgraded = true
          })
          ws.on('unexpected-response', (req, res) => {
            result = { status: res.statusCode, retryAfter: res.headers['retry-after'], upgraded }
            res.resume()
            req.destroy()
            finish(result)
          })
          ws.on('message', packet => {
            const [method] = readPacket(packet)
            if (method === 'onSnapshot') {
              result = { admitted: true }
              ws.close()
            }
          })
          ws.on('close', () => {
            if (result) finish(result)
            else {
              clearTimeout(timer)
              reject(new Error('admitted connection closed before snapshot'))
            }
          })
          ws.on('error', err => {
            if (!result) {
              clearTimeout(timer)
              reject(err)
            }
          })
        })
        if (outcome.admitted) admitted++
        else {
          eq(outcome.status, 503, 'refused attempt gets HTTP 503')
          eq(outcome.retryAfter, '10', 'refusal includes Retry-After')
          eq(outcome.upgraded, false, 'refusal never upgrades')
          refused++
        }
      }
      const elapsed = performance.now() - started
      // Six tabs spent six tokens; allow one boundary token for time spent opening those tabs.
      const maxAdmitted = 15 + Math.ceil(elapsed / 6000)
      ok(admitted >= 14 && admitted <= maxAdmitted, `${admitted} admitted over ${Math.ceil(elapsed)} ms`)
      eq(admitted + refused, 200, 'every upgrade attempt accounted for')
      ok(refused > 0, `${refused} refused before upgrade`)
      eq(limited.lines(/SqliteError|UnhandledPromiseRejection|SES_UNHANDLED/).length, 0, 'no errors in the log')
      await sleep(500)
      const status = await fetch(`http://localhost:${port}/status`)
      eq(status.status, 200, 'limited server still responsive')
      eq((await status.json()).connectedUsers, 0, 'no sockets left behind')
      return `${admitted} admitted, ${refused} refused`
    } finally {
      await limited.stop()
    }
  })

  // its own server: wrong codes leave this machine's address slowed for a quarter of an hour, and every other step
  // becomes admin from the same address. What is checked here is the wiring through a real server and real sockets;
  // when a wait is in force is left to test/adminCode.test.js (an injected clock), so nothing below depends on how
  // fast this machine runs.
  await step(
    'A14b wrong admin codes are answered to their socket and end with it closed; the right code still works afterwards',
    async () => {
      const port = PORT + 2
      const code = 'e2e-admin-code-long-enough'
      const braked = await startServer({
        port,
        logPath: path.join(OUT, `fullstack-${ENGINE}-admin-server.log`),
        // the waits at a tenth of their length: 1 s after the third wrong code, 6 s at the most
        env: { ADMIN_CODE: code, ADMIN_ATTEMPT_WAIT_SCALE: '0.1' },
      })
      const clients = []
      const connect = async label => {
        const client = await new WireClient(port, label).connect()
        clients.push(client)
        return client
      }
      const said = (client, body) => client.inbox.filter(m => m.method === 'onChatAdded' && m.data.body === body).length
      const ranked = client => client.inbox.some(m => m.method === 'onEntityModified' && m.data.rank === 2)
      const WRONG = 'Wrong admin code.'
      const WAIT = 'Too many attempts. Try again later.'
      try {
        const witness = await connect('witness')
        const guesser = await connect('guesser')
        let closeCode
        guesser.closed.then(value => (closeCode = value))
        // the first three wrong codes from an address are each looked at and answered, whatever the spelling
        ;['admin', 'Admin', 'ADMIN'].forEach((cmd, i) => guesser.send('command', { args: [cmd, `guess-${i}`] }))
        await waitUntil(() => said(guesser, WRONG) === 3, { timeout: 10000, message: 'three wrong codes answered' })
        // a socket that keeps trying is closed at its 21st attempt, whether its attempts are looked at or refused
        for (let i = 3; i < 23; i++) guesser.send('command', { args: [' aDmIn ', `guess-${i}`] })
        await waitUntil(() => closeCode !== undefined, { timeout: 10000, message: 'the socket to be closed' })
        ok(
          guesser.inbox.some(m => m.method === 'onKick' && m.data === 'admin_attempts'),
          'kick code sent'
        )
        ok(!ranked(guesser), 'never admin')
        eq(said(witness, WRONG) + said(witness, WAIT), 0, 'the answers went to the socket that tried, and no other')
        // the right code from a new connection on this address makes it admin once the address's wait allows: each
        // try on a connection of its own (a refused try is told on its own line), until a deadline
        const deadline = Date.now() + 60000 * TIMEOUT_SCALE
        let tries = 0
        for (;;) {
          ok(Date.now() < deadline, `admin within the deadline (${tries} tries refused)`)
          const client = await connect(`admin-${++tries}`)
          client.send('command', { args: ['Admin', code] })
          const reply = await client.waitFor(
            m =>
              (m.method === 'onEntityModified' && m.data.id === client.id && m.data.rank === 2) ||
              (m.method === 'onChatAdded' && m.data.body === WAIT),
            { timeout: 10000 * TIMEOUT_SCALE }
          )
          if (reply.method === 'onEntityModified') break
          client.close()
          await sleep(500)
        }
        const status = await (await fetch(`http://localhost:${port}/status`)).json()
        eq(status.protected, true, '/status says the world is protected')
        eq(braked.count(code), 0, 'the code is not in the server log')
        eq(braked.count('guess-'), 0, 'no candidate is in the server log')
        return `three answered, socket closed at its 21st attempt, admin on try ${tries}`
      } finally {
        for (const client of clients) client.close()
        await braked.stop()
      }
    }
  )

  // its own server: the kick list holds this machine's address for minutes, and every other step joins from it
  await step(
    'A14c a kicked player is told, closed and kept out; with KICK_BY_ADDRESS new users from its address wait too',
    async () => {
      const port = PORT + 2
      const code = 'e2e-admin-code-long-enough'
      const moderated = await startServer({
        port,
        logPath: path.join(OUT, `fullstack-${ENGINE}-kick-server.log`),
        env: { ADMIN_CODE: code, KICK_BY_ADDRESS: 'true' },
      })
      const clients = []
      const connect = async (label, options) => {
        const client = await new WireClient(port, label).connect(label, options)
        clients.push(client)
        return client
      }
      // a connection that is refused gets a kick code and no snapshot
      const refusal = async (label, options) => {
        const client = new WireClient(port, label)
        clients.push(client)
        await client.open(label, options)
        const kick = await client.waitFor(m => m.method === 'onKick', { timeout: 10000 * TIMEOUT_SCALE })
        eq(client.inbox.filter(m => m.method === 'onSnapshot').length, 0, `${label}: no snapshot`)
        return kick.data
      }
      try {
        const admin = await connect('admin')
        admin.send('command', { args: ['admin', code] })
        await admin.waitFor(m => m.method === 'onEntityModified' && m.data.id === admin.id && m.data.rank === 2)
        const regular = await connect('regular')
        const visitor = await connect('visitor')
        const bystander = await connect('bystander')
        // a visitor cannot kick, and an app's id or a made-up one names nobody
        visitor.send('kick', bystander.id)
        visitor.send('kick', admin.id)
        admin.send('kick', 'nobody-here')
        // A ping is answered once the server has handled what its socket sent before it (in order). The admin's kick
        // below goes on another socket, and the kicked socket's packets still waiting are dropped: without this the
        // visitor's kicks might never be looked at. Each of the three is then asked on its own socket whether it is
        // still connected; one that the visitor's kicks had closed answers with a kick or not at all.
        let token = 0
        const answer = async client => {
          const from = client.mark()
          const sent = ++token
          client.send('ping', sent)
          const reply = await client.waitFor(m => (m.method === 'onPong' && m.data === sent) || m.method === 'onKick', {
            from,
            timeout: 10000 * TIMEOUT_SCALE,
          })
          return reply.method
        }
        for (const client of [visitor, admin, bystander]) {
          eq(await answer(client), 'onPong', `${client.label}: still connected after the visitor's kicks were handled`)
        }
        let closeCode
        visitor.closed.then(value => (closeCode = value))
        const fromBystander = bystander.mark()
        admin.send('kick', visitor.id)
        const kick = await visitor.waitFor(m => m.method === 'onKick')
        eq(kick.data, 'moderation', 'the kicked player is told why')
        await waitUntil(() => closeCode !== undefined, { message: 'the kicked socket to close' })
        await bystander.waitFor(m => m.method === 'onEntityRemoved' && m.data === visitor.id, { from: fromBystander })
        ok(
          ![admin, bystander].some(client => client.inbox.some(m => m.method === 'onKick')),
          "the visitor's kicks did nothing"
        )
        // the same user comes back at once with its session token
        eq(await refusal('visitor-again', { authToken: visitor.authToken }), 'kicked', 'the kicked user id waits')
        // a new user from the same address (this machine) waits too, since an admin kicked and the server asks for it
        eq(await refusal('newcomer'), 'kicked', 'a new user from the kicked address waits')
        // someone who was here before is not a new user: they leave and come back with their token
        regular.close()
        await bystander.waitFor(m => m.method === 'onEntityRemoved' && m.data === regular.id, { from: fromBystander })
        const back = await connect('regular-again', { authToken: regular.authToken })
        eq(back.id, regular.id, 'a returning user from that address joins as themselves')
        const status = await (await fetch(`http://localhost:${port}/status`)).json()
        const users = status.connectedUsers
        eq(Array.isArray(users) ? users.length : users, 3, 'the admin, the bystander and the returning user')
        eq(moderated.count('kept out for 10 min'), 1, 'one kick in the log')
        eq(moderated.lines(/SqliteError|UnhandledPromiseRejection|SES_UNHANDLED/).length, 0, 'no errors in the log')
        return 'kicked user refused with its token, a new user from its address refused, a returning user admitted'
      } finally {
        for (const client of clients) client.close()
        await moderated.stop()
      }
    }
  )

  await step(
    'A14d a flood of chat lines reaches the others as a burst; the flooder is told and nobody is closed',
    async () => {
      const flooder = await new WireClient(PORT, 'flooder').connect()
      const listener = await new WireClient(PORT, 'listener').connect()
      let flooderClosed = false
      let listenerClosed = false
      flooder.closed.then(() => (flooderClosed = true))
      listener.closed.then(() => (listenerClosed = true))
      try {
        const fromListener = listener.mark()
        const fromFlooder = flooder.mark()
        const started = Date.now()
        // far more than a person types, in one go (the inbound gate admits about a thousand small packets a second)
        const LINES = 400
        for (let i = 0; i < LINES; i++) flooder.send('chatAdded', { body: `e2e flood ${i}` })
        // the flooder's packets are handled in order: when its ping is answered, every line before it was looked at
        flooder.send('ping', 424242)
        await flooder.waitFor(m => m.method === 'onPong' && m.data === 424242, {
          from: fromFlooder,
          timeout: 20000 * TIMEOUT_SCALE,
        })
        // and what the server told the others about them reached the listener before this one, sent after them
        flooder.send('entityModified', { id: flooder.id, p: [42.5, 0, -42.5] })
        await listener.waitFor(
          m => m.method === 'onEntityModified' && m.data.id === flooder.id && m.data.p?.[0] === 42.5,
          { from: fromListener, timeout: 20000 * TIMEOUT_SCALE }
        )
        const seconds = Math.ceil((Date.now() - started) / 1000)
        const lines = listener
          .since(fromListener)
          .filter(
            m => m.method === 'onChatAdded' && m.data.fromId === flooder.id && /^e2e flood \d+$/.test(m.data.body)
          )
        // the burst, and at most a line for each second this took
        ok(
          lines.length >= 6 && lines.length <= 6 + seconds,
          `${lines.length} of ${LINES} lines relayed in ${seconds} s`
        )
        eq(lines[0].data.body, 'e2e flood 0', 'the first lines are the ones that went through')
        const told = flooder
          .since(fromFlooder)
          .filter(m => m.method === 'onChatAdded' && m.data.kind === 'system' && /too fast/.test(m.data.body))
        ok(told.length >= 1 && told.length <= 1 + seconds, `the flooder is told, once per wait: ${told.length}`)
        ok(
          !listener.since(fromListener).some(m => m.method === 'onChatAdded' && /too fast/.test(String(m.data.body))),
          'nobody else is told'
        )
        eq(flooderClosed, false, 'the flooder is not closed: its lines are dropped')
        eq(listenerClosed, false, 'the listener is not closed')
        return `${lines.length} of ${LINES} lines relayed; the flooder told ${told.length} time(s)`
      } finally {
        flooder.close()
        listener.close()
      }
    }
  )

  await step(
    'A14e a flood of script events: the server script gets the burst and then the rate; the sender stays',
    async () => {
      const sender = await new WireClient(PORT, 'eventer').connect()
      let senderClosed = false
      sender.closed.then(() => (senderClosed = true))
      try {
        const fromSender = sender.mark()
        const started = Date.now()
        // under the inbound gate's burst (2048 small packets), so that every one of them is handed to the app
        const EVENTS = 2000
        for (let i = 0; i < EVENTS; i++) sender.send('entityEvent', ['s-event', 0, 'count', i])
        // the sender's packets are handled in order: when its ping is answered, every event before it was looked at
        sender.send('ping', 515151)
        await sender.waitFor(m => m.method === 'onPong' && m.data === 515151, {
          from: fromSender,
          timeout: 20000 * TIMEOUT_SCALE,
        })
        // The most the budget can have let through: the burst, and the rate for the time the events took to
        // arrive. On a machine slow enough for that to reach all of them, only the burst can be told here (the
        // exact rate is asserted on a clock of the test's own in test/eventBudget.test.js).
        const elapsed = Date.now() - started
        const most = Math.min(EVENTS, 1280 + Math.ceil((elapsed / 1000) * 320) + 1)
        // a second later the budget has room again: an event is delivered, and tells the count
        await sleep(1100)
        const fromReport = watcher.mark()
        sender.send('entityEvent', ['s-event', 0, 'counted', null])
        const report = await watcher.waitForReport('P5_COUNT', { from: fromReport, timeout: 10000 * TIMEOUT_SCALE })
        eq(report.from, sender.id, "the count is this connection's")
        ok(report.count >= 1280 && report.count <= most, `${report.count} of ${EVENTS} events reached the script`)
        const escaped = sender.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const logged = [
          server.lines(new RegExp(`\\[network\\] "${escaped}" is over its event budget: dropped`)).length,
          server.lines(/\[app\] s-event: event dropped \(sender over its event budget\)/).length,
        ]
        // once for the connection and once for the app, when events were dropped; on a machine so slow that the
        // budget had room for all of them, none need have been
        if (most < EVENTS) eq(logged.join(), '1,1', 'logged once for the connection and once for the app')
        else ok(logged[0] <= 1 && logged[1] <= 1, 'logged at most once each')
        eq(senderClosed, false, 'the sender is not closed: its events are dropped')
        return `${report.count} of ${EVENTS} events reached the script (at most ${most})`
      } finally {
        sender.close()
      }
    }
  )

  await step(
    'A14f a flood of changes to its own player reaches the others once a tick, ending where the flooder is',
    async () => {
      const flooder = await new WireClient(PORT, 'mover').connect()
      const listener = await new WireClient(PORT, 'onlooker').connect()
      let flooderClosed = false
      let listenerClosed = false
      flooder.closed.then(() => (flooderClosed = true))
      listener.closed.then(() => (listenerClosed = true))
      try {
        const fromListener = listener.mark()
        const fromFlooder = flooder.mark()
        const started = Date.now()
        // under the inbound gate's burst (2048 small packets): every one is handled, over a few ticks
        const CHANGES = 1500
        for (let i = 0; i < CHANGES; i++) {
          flooder.send('entityModified', { id: flooder.id, p: [i, 0, -i], q: [0, 0, 0, 1] })
        }
        // the flooder's packets are handled in order: when its ping is answered, every change before it was applied
        flooder.send('ping', 616161)
        await flooder.waitFor(m => m.method === 'onPong' && m.data === 616161, {
          from: fromFlooder,
          timeout: 20000 * TIMEOUT_SCALE,
        })
        // one more, in a later tick: when the listener has it, it has everything about the flood
        await sleep(100)
        flooder.send('entityModified', { id: flooder.id, p: [-7.5, 0, 7.5] })
        await listener.waitFor(
          m => m.method === 'onEntityModified' && m.data.id === flooder.id && m.data.p?.[0] === -7.5,
          { from: fromListener, timeout: 20000 * TIMEOUT_SCALE }
        )
        const elapsed = Date.now() - started
        const seen = listener
          .since(fromListener)
          .filter(m => m.method === 'onEntityModified' && m.data.id === flooder.id)
          .map(m => m.data)
        // the server ticks at most once in 33 ms, and writes at most one packet about this player in a tick
        const most = Math.floor(elapsed / 33) + 2
        ok(seen.length <= most, `${seen.length} packets for ${CHANGES} changes in ${elapsed} ms (at most ${most})`)
        ok(most < CHANGES / 10, `the changes were handled fast enough to tell (${elapsed} ms)`)
        const flood = seen.slice(0, -1)
        ok(
          flood.every((data, i) => i === 0 || data.p[0] > flood[i - 1].p[0]),
          'each packet is later than the one before'
        )
        eq(
          JSON.stringify(flood.at(-1)),
          JSON.stringify({ id: flooder.id, p: [CHANGES - 1, 0, -(CHANGES - 1)], q: [0, 0, 0, 1] }),
          'the flood ends on its last change'
        )
        eq(
          JSON.stringify(seen.at(-1)),
          JSON.stringify({ id: flooder.id, p: [-7.5, 0, 7.5] }),
          'a single change is told as it is'
        )
        ok(
          !flooder.since(fromFlooder).some(m => m.method === 'onEntityModified' && m.data.id === flooder.id),
          'nothing of it comes back to the flooder'
        )
        // a client that joins now is given the position the server ended on
        const late = await new WireClient(PORT, 'latecomer').connect()
        const joined = late.snapshot.entities.find(entity => entity.id === flooder.id)
        late.close()
        eq(JSON.stringify(joined?.position), JSON.stringify([-7.5, 0, 7.5]), 'the server applied every change')
        eq(flooderClosed, false, 'the flooder is not closed')
        eq(listenerClosed, false, 'the listener is not closed')
        return `${seen.length} packets for ${CHANGES + 1} changes in ${elapsed} ms`
      } finally {
        flooder.close()
        listener.close()
      }
    }
  )

  await step(
    'A14g movement at the rate a client sends it (8 a second) reaches the others change by change, within a few ticks',
    async () => {
      const walker = await new WireClient(PORT, 'walker').connect()
      const listener = await new WireClient(PORT, 'bystander-wire').connect()
      try {
        const fromListener = listener.mark()
        const STEPS = 40
        let slowest = 0
        for (let i = 0; i < STEPS; i++) {
          const sentAt = Date.now()
          // changed fields only, as the client sends them
          const change = { id: walker.id, p: [i * 0.25, 0, 3] }
          if (i % 5 === 0) change.q = [0, i % 2 ? 1 : 0, 0, i % 2 ? 0 : 1]
          if (i % 8 === 0) change.m = (i / 8) % 3
          walker.send('entityModified', change)
          await listener.waitFor(
            m => m.method === 'onEntityModified' && m.data.id === walker.id && m.data.p?.[0] === i * 0.25,
            { from: fromListener, timeout: 10000 * TIMEOUT_SCALE }
          )
          slowest = Math.max(slowest, Date.now() - sentAt)
          await sleep(Math.max(0, 125 - (Date.now() - sentAt)))
        }
        const seen = listener
          .since(fromListener)
          .filter(m => m.method === 'onEntityModified' && m.data.id === walker.id)
          .map(m => m.data)
        eq(seen.length, STEPS, 'one packet for each change: none merged, none lost')
        ok(
          seen.every(
            (data, i) => data.p[0] === i * 0.25 && 'q' in data === (i % 5 === 0) && 'm' in data === (i % 8 === 0)
          ),
          'in order, each with the fields that were sent'
        )
        // the end of the tick in which it was handled: a tick is 33 ms
        ok(slowest <= 150 * TIMEOUT_SCALE, `the slowest took ${slowest} ms`)
        return `${STEPS} changes, the slowest reached the listener in ${slowest} ms`
      } finally {
        walker.close()
        listener.close()
      }
    }
  )

  await step('A15 an outdated client is kicked before any users row is created', async () => {
    const db = new Database(path.join(server.worldDir, 'db.sqlite'), { readonly: true, fileMustExist: true })
    const outdated = new WireClient(PORT, 'outdated', { version: null })
    try {
      const countUsers = db.prepare('SELECT COUNT(*) AS count FROM users')
      const before = countUsers.get().count
      await outdated.open()
      const kick = await outdated.waitFor(m => m.method === 'onKick')
      eq(kick.data, 'outdated', 'missing version carries the outdated kick reason')
      let closeCode
      outdated.closed.then(code => (closeCode = code))
      await waitUntil(() => closeCode !== undefined, { message: 'outdated socket to close' })
      eq(closeCode, 1008, 'outdated socket closes with 1008')
      eq(outdated.inbox.filter(m => m.method === 'onSnapshot').length, 0, 'no snapshot was sent')
      eq(countUsers.get().count, before, 'no users row was created')
    } finally {
      outdated.close()
      db.close()
    }
  })

  await step("A15b a name and a rank an admin gives are in the user's row, and in that user's next join", async () => {
    // the real database: the server's writer of user rows (src/server/userRows.js) against knex and SQLite
    const db = new Database(path.join(server.worldDir, 'db.sqlite'), { readonly: true, fileMustExist: true })
    const player = await new WireClient(PORT, 'row-first').connect()
    let again = null
    try {
      const row = db.prepare('SELECT name, rank FROM users WHERE id = ?')
      eq(row.get(player.id)?.rank, 0, 'a new user is a visitor')
      const from = player.mark()
      // two names at once (the second while the first may still be written), then a rank from the admin
      player.send('command', { args: ['name', 'row-second'] })
      player.send('command', { args: ['name', 'row-third'] })
      admin.send('modifyRank', { playerId: player.id, rank: 1 })
      await player.waitFor(m => m.method === 'onEntityModified' && m.data.id === player.id && m.data.rank === 1, {
        from,
        timeout: 20000 * TIMEOUT_SCALE,
      })
      await waitUntil(
        () => {
          const stored = row.get(player.id)
          return stored?.name === 'row-third' && stored?.rank === 1
        },
        { message: "the user's row to hold the last name and the rank" }
      )
      // the same user again, without a name of its own in the connection: the stored one
      const { id, authToken } = player
      player.close()
      await player.closed
      again = await new WireClient(PORT, 'row-again').connect('', { authToken })
      eq(again.id, id, 'the same user')
      const self = again.snapshot.entities.find(entity => entity.id === id)
      eq(self?.name, 'row-third', 'the name of the row')
      eq(self?.rank, 1, 'the rank of the row')
      // back to a visitor, so the user leaves nothing behind for the steps that follow
      const lowered = again.mark()
      admin.send('modifyRank', { playerId: id, rank: 0 })
      await again.waitFor(m => m.method === 'onEntityModified' && m.data.id === id && m.data.rank === 0, {
        from: lowered,
        timeout: 20000 * TIMEOUT_SCALE,
      })
      await waitUntil(() => row.get(id)?.rank === 0, { message: "the user's row to hold the lowered rank" })
    } finally {
      player.close()
      again?.close()
      db.close()
    }
  })

  await step(
    'A16 old-encoder records are refused once, while plain packets from the same socket still work',
    async () => {
      const legacy = await new WireClient(PORT, 'old-encoder').connect()
      try {
        const oldPackr = new Packr({ structuredClone: true })
        const packet = oldPackr.pack([8, ['s-event', 0, 'probe', { oldEncoder: true }]])
        const from = watcher.mark()
        for (let i = 0; i < 3; i++) legacy.sendRaw(packet)
        const refused = new RegExp(`entityEvent from client ${legacy.id} dropped: undecodable`)
        await waitUntil(() => server.lines(refused).length >= 1, { timeout: 5000, message: 'old encoder refusal' })
        await sleep(200)
        eq(server.lines(refused).length, 1, 'old encoding logged once per socket')
        eq(pingReports(watcher, from).length, 0, 'old encoding never reached the handler')
        legacy.send('entityEvent', ['s-event', 0, 'probe', { plainEncoder: true }])
        const ping = await watcher.waitForReport('P5_PING', { from, timeout: 10000 })
        eq(ping.data.plainEncoder, true, 'plain event works after the refusal')
        eq(ping.from, legacy.id, 'plain event came from the same socket')
        ok(legacy.isOpen, 'refused encoding did not close the connection')
        eq(server.lines(refused).length, 1, 'plain packet adds no decode refusal')
      } finally {
        legacy.close()
      }
    }
  )

  await step(
    "A17 cached rebuild delivers the same builder socket's event sent before its blueprint change",
    async () => {
      // A12 already loaded both assets. Each modification rebuilds synchronously from the cache, and the
      // report's revision proves the event ran in the rebuilt script rather than the previous listener.
      for (const version of [1, 2]) {
        const from = watcher.mark()
        admin.send('entityEvent', ['s-event', version, 'probe', { beforeBlueprint: version }])
        admin.send('blueprintModified', { id: 's-event-bp', version, props: { revision: version } })
        const ping = await watcher.waitForReport('P5_PING', { from, timeout: 10000 })
        eq(ping.data.beforeBlueprint, version, 'the event sent before the blueprint was delivered')
        eq(ping.revision, version, 'the rebuilt listener delivered the kept event')
        eq(ping.from, admin.id, 'the event and blueprint have the same author socket')
        await watcher.waitFor(
          m => m.method === 'onBlueprintModified' && m.data.id === 's-event-bp' && m.data.version === version,
          { from }
        )
        eq(pingReports(watcher, from).length, 1, 'the kept event was delivered exactly once')
      }
      ok(admin.isOpen, 'the builder connection remains open')
    }
  )

  await step('A18 watcher receives the blueprint announcement before synchronous cached rebuild events', async () => {
    // A12 and A17 warmed the model and script caches. The script sends init during each rebuild,
    // so moving the server broadcast after modify would put the new-version event first on the wire.
    for (const version of [3, 4]) {
      const from = watcher.mark()
      admin.send('blueprintModified', {
        id: 's-event-bp',
        version,
        props: { revision: version, announceInit: true },
      })
      await watcher.waitFor(
        m => m.method === 'onEntityEvent' && m.data[0] === 's-event' && m.data[1] === version && m.data[2] === 'init',
        { from }
      )
      await watcher.waitFor(
        m => m.method === 'onBlueprintModified' && m.data.id === 's-event-bp' && m.data.version === version,
        { from }
      )
      const messages = watcher.since(from)
      const announced = messages.findIndex(
        m => m.method === 'onBlueprintModified' && m.data.id === 's-event-bp' && m.data.version === version
      )
      const events = messages.filter(
        m => m.method === 'onEntityEvent' && m.data[0] === 's-event' && m.data[1] === version
      )
      eq(events.length, 1, 'the cached script sends exactly one init event')
      eq(events[0].data[3].revision, version, 'init used the new blueprint props')
      ok(
        announced >= 0 && events.every(event => messages.indexOf(event) > announced),
        'announcement precedes every new-version event'
      )
    }
    ok(admin.isOpen && watcher.isOpen, 'both connections remain open')
  })

  await step('A19 invalid event versions cannot wait through a later blueprint rebuild', async () => {
    const from = watcher.mark()
    for (const version of [4.5, -1, -0.5, 1e300, 3.5]) {
      watcher.send('entityEvent', ['s-event', version, 'probe', 'invalid-version'])
    }
    watcher.send('entityEvent', ['s-event', 4, 'probe', 'before-rebuild'])
    eq((await watcher.waitForReport('P5_PING', { from })).data, 'before-rebuild', 'invalid events did not emit')
    admin.send('blueprintModified', { id: 's-event-bp', version: 5, props: { revision: 5 } })
    admin.send('entityEvent', ['s-event', 5, 'probe', 'after-rebuild'])
    await watcher.waitFor(m => m.method === 'onChatAdded' && m.data.body?.includes('after-rebuild'), { from })
    eq(pingReports(watcher, from).length, 2, 'only the two valid barriers delivered across the rebuild')
    ok(admin.isOpen && watcher.isOpen, 'invalid versions leave the connections open')
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
    's-relay',
    's-event',
  ]) {
    admin.send('entityRemoved', id)
  }
  await sleep(500)
  watcher.close()
  admin.close()
  const relayDropsAfterA = server.lines(RELAY_DROP).length

  // ---------- phase B: browser ----------
  // a second player the browser's scripts can see as remote; it must receive nothing from them
  bystander = await new WireClient(PORT, 'bystander').connect()
  await openBrowser()
  const appsAtLoad = await loadChecks()
  await step('B3b the chat history received at join renders as text after the malformed attempts', async () => {
    const chat = await page.evaluate(() => ({
      stored: window.world.chat.msgs.map(m => typeof m.body),
      rendered: [...document.querySelectorAll('.mainchat-msgs .message-body')].map(e => e.textContent),
    }))
    ok(chat.stored.length > 0 && chat.stored.every(t => t === 'string'), `bodies: ${chat.stored.join(',')}`)
    // the probes report through chat, so the 50-message history may have moved past P4_CHAT_OK by now; every
    // message it still holds must render as its text
    eq(chat.rendered.length, chat.stored.length, 'every stored message is rendered')
    ok(!chat.rendered.some(t => t.includes('[object Object]')), 'no object rendered as text')
    eq(errorLines().length + pageErrors.length, 0, 'no errors while rendering the chat')
    return `${chat.rendered.length} messages rendered`
  })

  await becomeAdmin(page)
  record(true, 'B4 browser player is admin')

  await step('B4b the local chat echo is trimmed like the stored copy; a blank message sends nothing', async () => {
    const typeMessage = async text => {
      await page.evaluate(() => document.activeElement?.blur?.())
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.activeElement?.classList.contains('side-chatbox-input'), null, {
        timeout: 8000,
      })
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
    }
    const mine = () =>
      page.evaluate(() => {
        const me = window.world.network.id
        return window.world.chat.msgs.filter(m => m.fromId === me).map(m => ({ id: m.id, body: m.body }))
      })
    const before = (await mine()).length
    await typeMessage('   P4_ECHO   ')
    const echoed = await waitUntil(
      async () => {
        const list = await mine()
        return list.length === before + 1 ? list[list.length - 1] : null
      },
      { message: 'local echo' }
    )
    eq(echoed.body, 'P4_ECHO', 'the echo is trimmed')
    const rendered = await page.evaluate(() =>
      [...document.querySelectorAll('.mainchat-msgs .message-body')].map(e => e.textContent)
    )
    ok(rendered.includes('P4_ECHO'), 'rendered trimmed')
    await typeMessage('     ')
    await sleep(800)
    eq((await mine()).length, before + 1, 'a blank message is not echoed')
    // the server stored the trimmed copy under an id of its own
    const snap = await snapshot(PORT)
    const stored = snap.chat.find(m => m.body === 'P4_ECHO')
    ok(stored && stored.id !== echoed.id, 'stored under a server-minted id')
  })

  await step('B4c a 60 KiB event from the browser reaches the server with the connection open', async () => {
    await installApp(page, {
      id: 'b-event',
      script: 'asset://event-probe.js',
      model: 'asset://ai.glb',
      props: { text: 'kept', file: null },
    })
    await waitUntil(
      async () => {
        const state = await appState(page, 'b-event')
        return state?.script && !state.building
      },
      { message: 'browser event probe built' }
    )
    const from = bystander.mark()
    const id = await page.evaluate(() => {
      const network = window.world.network
      if (!network.send('entityEvent', ['b-event', 0, 'size', 'x'.repeat(60 * 1024)])) {
        throw new Error('60 KiB send refused')
      }
      return network.id
    })
    const report = await bystander.waitForReport('P5_SIZE', { from, timeout: 10000 })
    eq(report.length, 60 * 1024, 'server received the complete 60 KiB payload')
    eq(report.from, id, 'event came from the browser')
    ok(
      await page.evaluate(() => window.world.network.ws.readyState === WebSocket.OPEN),
      'browser connection stays open'
    )
  })

  await step('B4d a 70 KiB textarea prop is refused before local mutation or send', async () => {
    await page.evaluate(() => {
      const w = window.world
      w.ui.setApp(w.entities.get('b-event'))
      if (w.ui.state.pane !== 'app') w.ui.togglePane('app')
      window.limitToasts = []
      w.on('toast', text => window.limitToasts.push(text))
      window.limitBefore = JSON.stringify(w.blueprints.get('b-event-bp'))
    })
    const field = page.locator('.fieldtextarea').filter({ hasText: 'Limit text' }).locator('textarea')
    await field.fill('x'.repeat(70 * 1024))
    await field.blur()
    await page.waitForFunction(() => window.limitToasts.length === 1)
    eq(
      await page.locator('.toast-msg').textContent(),
      'This change is too large to save (limit 64 KB)',
      'visible refusal toast'
    )
    const local = await page.evaluate(() => ({
      same: JSON.stringify(window.world.blueprints.get('b-event-bp')) === window.limitBefore,
      open: window.world.network.ws.readyState === WebSocket.OPEN,
    }))
    ok(local.same && local.open, 'local blueprint unchanged and connection open')
    eq(await field.inputValue(), 'kept', 'textarea restored after refusal')
    const snap = await snapshot(PORT)
    const stored = snap.blueprints.find(bp => bp.id === 'b-event-bp')
    eq(stored.version, 0, 'server version unchanged')
    eq(stored.props.text, 'kept', 'server textarea unchanged')
  })

  await step('B4e an oversized file-field record is refused before uploading or local mutation', async () => {
    let uploads = 0
    const onRequest = request => {
      if (/\/api\/upload(?:-check)?(?:\?|$)/.test(request.url())) uploads++
    }
    page.on('request', onRequest)
    const from = bystander.mark()
    try {
      const file = page.locator('.fieldfile').filter({ hasText: 'Limit file' }).locator('input[type=file]')
      await file.setInputFiles({
        name: 'x'.repeat(70 * 1024) + '.png',
        mimeType: 'image/png',
        buffer: Buffer.from(PNG.split(',')[1], 'base64'),
      })
      await page.waitForFunction(() => window.limitToasts.length === 2)
      eq(
        await page.locator('.toast-msg').textContent(),
        'This change is too large to save (limit 64 KB)',
        'file refusal toast'
      )
      // A valid event on the same FIFO connection is a barrier for the rejected edit.
      await page.evaluate(() => window.world.network.send('entityEvent', ['b-event', 0, 'probe', 'after-file-refusal']))
      await bystander.waitForReport('P5_PING', { from, timeout: 10000 })
      const local = await page.evaluate(() => ({
        same: JSON.stringify(window.world.blueprints.get('b-event-bp')) === window.limitBefore,
        open: window.world.network.ws.readyState === WebSocket.OPEN,
      }))
      ok(local.same && local.open, 'file refusal leaves local blueprint unchanged and connection open')
      eq(uploads, 0, 'neither upload-check nor upload started')
      eq(
        await page.locator('.fieldfile').filter({ hasText: 'Limit file' }).locator('.fieldfile-name').count(),
        0,
        'no file applied'
      )
      const snap = await snapshot(PORT)
      const stored = snap.blueprints.find(bp => bp.id === 'b-event-bp')
      eq(stored.version, 0, 'server version unchanged')
      eq(stored.props.file, null, 'server file unchanged')
      eq(stored.props.text, 'kept', 'server textarea still unchanged')
    } finally {
      page.off('request', onRequest)
      await page.evaluate(() => window.world.ui.setApp(null))
    }
  })

  await step('B4f a blueprint policy refusal shows a toast without changing local state', async () => {
    const refused = await page.evaluate(() => {
      const w = window.world
      const result = w.blueprints.modify({ id: 'b-event-bp', version: 1, disabled: 'invalid' }, true)
      return result === false && JSON.stringify(w.blueprints.get('b-event-bp')) === window.limitBefore
    })
    ok(refused, 'policy refusal returns false and changes no local state')
    await page.waitForFunction(() => window.limitToasts.includes('This change could not be saved'))
    eq(await page.locator('.toast-msg').textContent(), 'This change could not be saved', 'visible policy refusal')
  })

  await step(
    'B4g the world blueprint budget removes refused entities, reverts edits and permits new joins',
    async () => {
      const ids = Array.from({ length: 9 }, (_, i) => `b-budget-${i}`)
      const barrier = async tag => {
        const from = bystander.mark()
        await page.evaluate(tag => window.world.network.send('entityEvent', ['b-event', 0, 'probe', tag]), tag)
        eq((await bystander.waitForReport('P5_PING', { from })).data, tag, 'same-connection barrier delivered')
      }
      try {
        await page.evaluate(ids => {
          const w = window.world
          for (const id of ids) {
            w.blueprints.add({ id, version: 0, disabled: true, props: { notes: 'n'.repeat(60000) } }, true)
            w.entities.add(
              {
                id,
                type: 'app',
                blueprint: id,
                position: [0, 0, 0],
                quaternion: [0, 0, 0, 1],
                scale: [1, 1, 1],
                mover: null,
                uploader: null,
                pinned: false,
                state: {},
              },
              true
            )
          }
        }, ids)
        await barrier('budget-adds')
        const snap = await snapshot(PORT)
        const accepted = ids.filter(id => snap.blueprints.some(bp => bp.id === id))
        ok(accepted.length > 0 && accepted.length < 9, 'some 60 KB adds fit and the over-budget add is refused')
        const total = snap.blueprints.reduce((sum, bp) => sum + writePacket('blueprintAdded', bp).length, 0)
        ok(total <= 512 * 1024, `world blueprint bytes ${total}`)
        await page.waitForFunction(
          ({ ids, accepted }) => ids.every(id => !!window.world.entities.get(id) === accepted.includes(id)),
          { ids, accepted }
        )
        ok(
          !snap.entities.some(e => ids.includes(e.id) && !accepted.includes(e.id)),
          'refused entities are absent on the server'
        )
        await page.evaluate(() =>
          window.world.blueprints.modify(
            {
              id: 'b-event-bp',
              version: 1,
              props: { text: 'x'.repeat(64000) },
            },
            true
          )
        )
        await barrier('budget-modify')
        await page.waitForFunction(
          () => JSON.stringify(window.world.blueprints.get('b-event-bp')) === window.limitBefore
        )
        ok(
          await page.evaluate(() => window.world.network.ws.readyState === WebSocket.OPEN),
          'revert leaves the browser connected'
        )
        eq(
          (await snapshot(PORT)).blueprints.find(bp => bp.id === 'b-event-bp').version,
          0,
          'joins still work after a refused modify'
        )
      } finally {
        // the budget blueprints the server took shrink through a versioned modify (an add never replaces one)
        await page.evaluate(ids => {
          const w = window.world
          for (const id of ids) {
            w.entities.get(id)?.destroy(true)
            const bp = w.blueprints.get(id)
            if (bp) w.blueprints.modify({ id, version: bp.version + 1, disabled: true, props: {} }, true)
          }
        }, ids)
        await barrier('budget-cleanup')
      }
    }
  )

  await step(
    "B4h an app line a browser's client script broadcasts names that browser's player, there and for the others",
    async () => {
      const errorsBefore = errorLines().length + pageErrors.length
      const me = await page.evaluate(() => ({
        id: window.world.network.id,
        name: window.world.entities.player.data.name,
      }))
      const bystanderName = (await snapshot(PORT)).entities.find(entity => entity.id === bystander.id)?.name
      ok(me.name && bystanderName && me.name !== bystanderName, `two names: ${me.name}, ${bystanderName}`)
      const from = bystander.mark()
      await installApp(page, { id: 'b-via', script: 'asset://chat-via-probe.js', model: 'asset://ai.glb' })
      const line = body =>
        bystander.waitFor(m => m.method === 'onChatAdded' && m.data?.body === body, {
          from,
          timeout: 10000 * TIMEOUT_SCALE,
        })
      // what the others get: the client script's line names the browser's player (set by the server), the server
      // script's names nobody. The client script speaks as soon as it starts, which can be before the server's own
      // build of the app has loaded: the app's name is its blueprint record's all the same
      const client = (await line(`P_VIA_CLIENT ${me.id}`)).data
      eq(client.kind, 'app', 'an app line')
      eq(client.app, 'b-via', "the app's name, from the server's blueprint record")
      eq(client.from, 'Clerk', 'the display name the script chose')
      eq(JSON.stringify(client.via), JSON.stringify({ id: me.id, name: me.name }), "the browser's player")
      const server = (await line('P_VIA_SERVER')).data
      eq(server.kind, 'app', "the server script's line is an app line")
      eq(Object.hasOwn(server, 'via'), false, "the server script's line names nobody")
      // a line a wire client posts under the same app (built on the server by now: its script has spoken), claiming
      // the browser's player: the browser shows the wire client
      bystander.send('appChat', { id: 'b-via', body: 'P_VIA_WIRE', from: 'Admin', via: { id: me.id, name: me.name } })
      const row = body =>
        page.evaluate(text => {
          const rows = [...document.querySelectorAll('.mainchat-msgs .message')].filter(
            r => r.querySelector('.message-body')?.textContent === text
          )
          const r = rows[rows.length - 1]
          if (!r) return null
          const via = r.querySelector('.message-via')
          return {
            app: r.querySelector('.message-app')?.textContent ?? null,
            from: r.querySelector('.message-from')?.textContent ?? null,
            via: via?.textContent ?? null,
            title: via?.getAttribute('title') ?? null,
            opacity: via ? getComputedStyle(via).opacity : null,
            order: [...r.children].map(child => child.className),
          }
        }, body)
      const shown = body => waitUntil(() => row(body), { timeout: 10000, message: `the line ${body} in the chat` })
      const own = await shown(`P_VIA_CLIENT ${me.id}`)
      eq(own.via, `via ${me.name}`, "the browser's own copy names its player")
      eq(own.title, `Relayed from ${me.name}'s connection (player id: ${me.id})`, 'the hint')
      eq(own.opacity, '0.6', 'quieter than the line')
      eq(own.order.join(' '), 'message-app message-from message-via message-body', 'after the app and [from]')
      const wire = await shown('P_VIA_WIRE')
      eq(wire.app, 'b-via', "the app's name, from the server's blueprint")
      eq(wire.from, '[Admin]', 'the display name the packet chose')
      eq(wire.via, `via ${bystanderName}`, "the wire client's player, not the via it claimed")
      eq(wire.title, `Relayed from ${bystanderName}'s connection (player id: ${bystander.id})`, "the wire client's id")
      const serverRow = await shown('P_VIA_SERVER')
      eq(serverRow.via, null, "the server script's line shows the app alone")
      eq(serverRow.order.join(' '), 'message-app message-from message-body', 'as before')
      eq(errorLines().length + pageErrors.length - errorsBefore, 0, 'no errors')
      return `the browser (${me.name}) and the wire client (${bystanderName}) each named on their line, with their ids in the hint; the server script's line names nobody`
    }
  )

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
      eq(r.canonicalStatus, 200, 'the server serves /assets/crash-block.glb')
      // /%61ssets/ still matches the /assets/* route, but @fastify/static 10 checks the raw URL prefix and answers
      // 404 (8.x served the file with 200). Sent from Node with the path as is: a browser may decode %61 first
      // (WebKit on Linux does). world.open rejects the spelling either way, for servers and proxies that decode it
      const encodedStatus = await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: server.port, path: '/%61ssets/crash-block.glb' }, res => {
          res.resume()
          resolve(res.statusCode)
        })
        req.on('error', reject)
      })
      eq(encodedStatus, 404, 'the server no longer serves /%61ssets/ like /assets/')
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
  await step('B9b world.open: another origin is asked about first; Cancel opens nothing, Open opens it', async () => {
    const pages = () => context.pages().length
    const before = pages()
    const external = `127.0.0.1:${server.port}`
    ok((await probeCommand('openExternal')).ok)
    const dialog = page.locator('.link-confirm-dialog')
    await dialog.waitFor({ timeout: 15000 })
    eq(await dialog.locator('.link-confirm-host').innerText(), external, 'the host the visitor is shown')
    eq(await dialog.locator('.link-confirm-address').innerText(), `http://${external}/status`, 'the address')
    await sleep(800)
    eq(pages(), before, 'nothing opened while the question waits')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await dialog.waitFor({ state: 'detached', timeout: 5000 })
    await sleep(800)
    eq(pages(), before, 'nothing opened after Cancel')
    eq(page.url(), urlBefore, 'page url')

    const dropped = () =>
      consoleLines.filter(l => l.includes('[world.open] not opened: another link is waiting')).length
    const droppedBefore = dropped()
    // Presses that come before the question has been up for a second: four of them, in one go, as the button
    // appears (made in the page, in the turn that sees the button, so a slow machine cannot make them late)
    await page.evaluate(() => {
      window.__earlyOpen = 0
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.link-confirm-action.open')) return
        observer.disconnect()
        for (let i = 0; i < 4; i++) {
          document.querySelector('.link-confirm-action.open')?.click()
          window.__earlyOpen++
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    let popups = 0
    const countPopup = () => popups++
    context.on('page', countPopup)
    ok((await probeCommand('openExternalTwice')).ok)
    await dialog.waitFor({ timeout: 15000 })
    eq(await dialog.locator('.link-confirm-address').innerText(), `http://${external}/status`, 'the first request')
    eq(dropped(), droppedBefore + 1, 'the second request was dropped and said so in the console')
    await waitUntil(() => page.evaluate(() => window.__earlyOpen === 4), { timeout: 10000, message: 'early presses' })
    eq(await dialog.count(), 1, 'the question is still there after four early presses on Open')
    eq(popups, 0, 'and none of them opened anything')
    // Open works once the question has been on screen for a second without a press
    const openButton = dialog.getByRole('button', { name: 'Open' })
    await page.waitForSelector('.link-confirm-action.open:not(.waiting)', { timeout: 10000 })
    // A pointer press does not leave the button focused, so the jump key answers nothing: the pointer goes down
    // on Open and comes up elsewhere (no click), then Space is pressed
    const box = await openButton.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    eq(
      await page.evaluate(() => !!document.activeElement?.closest?.('.link-confirm')),
      false,
      'no button of the question took the focus'
    )
    await page.mouse.move(5, 5)
    await page.mouse.up()
    await page.keyboard.press('Space')
    await sleep(500)
    eq(await dialog.count(), 1, 'Space did not answer')
    eq(popups, 0, 'still nothing opened')
    eq(pages(), before, 'no new page')
    context.off('page', countPopup)
    const popupPromise = context.waitForEvent('page', { timeout: 20000 })
    await openButton.click()
    // The question closes with the press. Asked of the page directly: with the new tab in front, this page may
    // draw no frames, and a wait that polls on frames (locator.waitFor) then never sees the dialog go
    const questionState = () =>
      page.evaluate(() => ({
        shown: !!document.querySelector('.link-confirm-dialog'),
        waiting: !!window.world.ui.latest.link,
      }))
    await waitUntil(async () => !(await questionState()).shown, {
      timeout: 5000,
      message: `the question to close after Open (${JSON.stringify(await questionState())})`,
    })
    eq((await questionState()).waiting, false, 'no question is left waiting')
    const popup = await popupPromise
    await popup.waitForLoadState('domcontentloaded')
    const info = await popup.evaluate(() => ({ opener: window.opener, url: location.href }))
    eq(info.opener, null, 'opener')
    eq(info.url, `http://${external}/status`, 'the address that was shown is the one that opened')
    await popup.close()
    await page.bringToFront()
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
    // asked through get(): the loader files a stored asset under its resolved URL
    await waitUntil(() => page.evaluate(() => !!window.world.loader.get('model', 'asset://crash-block.glb')), {
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
  await step(
    'B15 a planted non-number is read as NaN; the physics probe is refused and crashes alone (browser)',
    async () => {
      // (the page has no e2e hook: the stage probe only plants, and must not crash)
      const stage = await waitUntil(
        async () => {
          const s = await appState(page, 'b-stage')
          return s?.state?.P1_STAGE_GUARDED ? s : null
        },
        { timeout: 20000, message: 'stage probe report' }
      )
      eq(stage.state.P1_STAGE_GUARDED.x, 'NaN', 'a planted Symbol is read as NaN')
      eq(stage.state.P1_STAGE_GUARDED.y, 'NaN', 'a planted object is read as NaN')
      ok(!stage.error, 'the stage probe did not crash')
      await waitUntil(async () => PHYSICS_REFUSED.test((await appState(page, 'b-physics'))?.error ?? ''), {
        timeout: 20000,
        message: 'physics probe refused',
      })
      ok(!consoleLines.some(l => l.includes('[stage] node update failed')), 'nothing failed on the Stage path')
      ok(!consoleLines.some(l => l.includes('[physics] interpolation failed')), 'nothing ran in the physics step')
      const observer = await appState(page, 'b-observer')
      ok(!observer.error, 'observer did not crash')
      const n1 = observer.state?.P1_OBSERVER_BEAT?.n ?? 0
      await waitUntil(async () => ((await appState(page, 'b-observer')).state?.P1_OBSERVER_BEAT?.n ?? 0) > n1, {
        timeout: 30000,
        message: 'observer heartbeat',
      })
    }
  )

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
  await step('B15b a crash teardown completes when the destroy listener throws (browser)', async () => {
    const stage = await waitUntil(
      async () => {
        const s = await appState(page, 'b-stage2')
        return s?.state?.P1_STAGE_GUARDED ? s : null
      },
      { timeout: 20000, message: 'stage probe report (destroy variant)' }
    )
    ok(!stage.error, 'the stage probe did not crash')
    for (const [id, boom] of [['b-physics2', PHYSICS_REFUSED]]) {
      const s = await waitUntil(
        async () => {
          const s = await appState(page, id)
          return boom.test(s?.error ?? '') && !s.building && s.rootIsCrashBlock ? s : null
        },
        { timeout: 30000, message: `${id} crash block` }
      )
      eq(s.timers, 0, `${id} timers cleared`)
      eq(s.rootMounted, true, `${id} crash block mounted`)
    }
    ok(consoleLines.filter(l => l.includes('script destroy() crashed')).length >= 1, 'destroy failure logged')
    ok(!consoleLines.some(l => /crash rebuild failed/.test(l)), 'no failed rebuild')
    eq(
      pageErrors.filter(l => /P1_DESTROY_BOOM|Unhandled/i.test(l)).length,
      0,
      'no unhandled rejection from the destroy listener'
    )
    const observer = await appState(page, 'b-observer')
    ok(!observer.error, 'observer did not crash')
  })

  // ---------- player relays (client script on a remote player: no effect; on the local player: works) ----------
  await installApp(page, {
    id: 'b-relay',
    script: 'asset://relay-probe.js',
    model: 'asset://ai.glb',
    props: { remote: bystander.id },
    position: [20, 0, -3],
  })
  const relayCommand = async cmd => {
    // the probe replaces app.state when its script starts; a command set before that would be lost
    await waitUntil(async () => !!(await appState(page, 'b-relay'))?.state?.results, {
      timeout: 20000,
      message: 'relay probe ready',
    })
    await page.evaluate(cmd => {
      window.world.entities.get('b-relay').data.state.cmd = cmd
    }, cmd)
    return waitUntil(async () => (await appState(page, 'b-relay')).state?.results?.[cmd] ?? null, {
      timeout: 20000,
      message: `relay probe ${cmd}`,
    })
  }
  const remoteLogs = () =>
    consoleLines.filter(l => /\[player\] \w+ on a remote player must be called on the server/.test(l))
  const playerState = () =>
    page.evaluate(() => {
      const p = window.world.entities.player
      return { position: p.base.position.toArray(), rotationY: p.base.rotation.y, sessionAvatar: p.data.sessionAvatar }
    })
  await step('B16 a client script acting on a remote player sends nothing and logs once per method', async () => {
    const from = bystander.mark()
    const r = await relayCommand('remote')
    ok(r.ok, r.error)
    eq(r.calls, 9, 'three methods over three frames')
    await sleep(1000)
    eq(bystander.since(from).filter(RELAY_PACKET).length, 0, 'the remote player received a relay packet')
    eq(server.lines(RELAY_DROP).length, relayDropsAfterA, 'the browser sent no relay packet')
    const logs = remoteLogs()
    eq(logs.length, 3, `one log per method: ${logs.join(' | ')}`)
    for (const method of ['teleport', 'push', 'setSessionAvatar']) {
      ok(
        logs.some(l => l.includes(`[player] ${method} on a remote player`)),
        `${method} logged`
      )
    }
  })
  await step('B17 a client script still teleports its local player', async () => {
    const r = await relayCommand('localTeleport')
    ok(r.ok, r.error)
    const state = await waitUntil(
      async () => {
        const s = await playerState()
        return Math.abs(s.position[0] - 3) < 0.5 && Math.abs(s.position[2] - 3) < 0.5 ? s : null
      },
      { timeout: 15000, message: 'teleported position' }
    )
    ok(Math.abs(state.rotationY - 1) < 0.01, `rotationY ${state.rotationY}`)
    return `at ${state.position.map(n => n.toFixed(2)).join(', ')}`
  })
  await step('B18 a client script still pushes its local player', async () => {
    const r = await relayCommand('localPush')
    ok(r.ok, r.error)
    const moved = await waitUntil(
      async () => {
        const s = await playerState()
        const d = Math.hypot(s.position[0] - r.start[0], s.position[2] - r.start[2])
        return d > 0.5 ? d : null
      },
      { timeout: 20000, message: 'push displacement' }
    )
    return `moved ${moved.toFixed(2)} m`
  })
  await step('B19 the local session avatar follows the url policy on the client', async () => {
    const rejected = () => consoleLines.filter(l => l.includes('onPlayerSessionAvatar: invalid payload')).length
    const before = rejected()
    ok((await relayCommand('localAvatar')).ok, 'set')
    await waitUntil(async () => (await playerState()).sessionAvatar === 'asset://avatar.vrm', {
      message: 'session avatar set',
    })
    ok((await relayCommand('localAvatarBad')).ok, 'bad')
    await waitUntil(() => rejected() === before + 1, { message: 'rejected url log' })
    eq((await playerState()).sessionAvatar, 'asset://avatar.vrm', 'a rejected url leaves the avatar unchanged')
    ok((await relayCommand('localAvatarClear')).ok, 'clear')
    await waitUntil(async () => (await playerState()).sessionAvatar === null, { message: 'session avatar cleared' })
    eq(bystander.since(0).filter(RELAY_PACKET).length, 0, 'the remote player still received nothing')
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
    `B20 script editor opened on "${target.name}" (Monaco from cdnjs)`,
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
    record(colour.classes >= 5 && colour.tokens.length >= 4, 'B21 syntax colouring works', JSON.stringify(colour))
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
      'B22 editor widgets: suggest, find, F1, error markers',
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
      'B23 edit + save: version bumped, app rebuilt, no crash',
      JSON.stringify({ saved, before: bpBefore, after: rebuilt })
    )
    await sleep(1500)
    const snap = await snapshot(PORT)
    const bp = snap.blueprints.find(b => b.id === bpBefore.bp)
    record(
      !!bp && bp.version > bpBefore.version && bp.script !== bpBefore.script,
      'B24 server confirms the saved blueprint (fresh snapshot)',
      JSON.stringify({ version: bp?.version, script: bp?.script })
    )
  }

  // SES prints a logged error as a marker line, a "Name#n: message" line and stack frames; judge the message lines
  const SES_DETAIL = /^\[error\] (\([A-Za-z]*#\d+\)|\s+at |[\w$.<>[\] ]*@)/
  const unexpected = errorLines().filter(l => !SES_DETAIL.test(l) && !EXPECTED_ERROR.test(l))
  record(unexpected.length === 0, 'B25 no unexpected console errors', unexpected.slice(0, 3).join(' | '))
  record(pageErrors.length === 0, 'B26 no uncaught page errors', pageErrors.slice(0, 3).join(' | '))
  record(
    server.lines(/SES_UNCAUGHT|SES_UNHANDLED|UnhandledPromiseRejection/).length === 0,
    'B27 server log: no unhandled rejections or SES errors'
  )

  // ---------- the world page's policy, enforced ----------
  // The server runs with CSP_MODE=enforce (lib/server.mjs): a refusal in what this run did in the browser (the world,
  // uploads, the script editor from cdnjs with its workers, the apps above) would have broken the step that needed it.
  // No document saw a violation, and no report had reached the server three seconds after the last step (a worker's
  // violation shows only there; reports are posted a moment after the event, and one later than that is not seen).
  await sleep(3000)
  const posted = server.lines(/\[csp\]/)
  record(
    violations.length === 0 && posted.length === 0,
    'B28 the enforced policy: nothing this run did was refused',
    JSON.stringify({ violations: violations.slice(0, 5), posted: posted.slice(0, 5) })
  )
  // And that it is enforced: an inline script without the nonce is outside the policy; it does NOT run, the document
  // is told (disposition `enforce`), and the server writes what was posted to it. (Report mode, where the same script
  // runs and is reported, is checked by gate-extras.mjs.)
  const before = violations.length
  const ran = await runInlineScript(page)
  // the report reaches the server and the event reaches this process each in its own time: wait for both
  const wrote = await waitUntil(() => server.lines(REFUSED_INLINE).length === 1 && violations.length > before, {
    timeout: 15000,
    message: 'the report and the event',
  })
    .then(() => true)
    .catch(() => false)
  const seen = violations.slice(before)
  record(
    ran === undefined &&
      wrote &&
      seen.length === 1 &&
      seen[0].directive === 'script-src-elem' &&
      seen[0].blocked === 'inline' &&
      seen[0].disposition === 'enforce' &&
      server.lines(/\[csp\]/).length === 1,
    'B29 an inline script without the nonce does not run, and is reported (the policy is enforced)',
    JSON.stringify({ ran, seen, posted: server.lines(/\[csp\]/).slice(0, 5) })
  )
}
