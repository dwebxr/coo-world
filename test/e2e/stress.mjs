// e2e stress: installs N instances of apps/stress.js (K moving prims each) and measures per-frame JS time
// in the page (mean/median/p90 over F frames), render commit time, and server CPU. With --monitor the
// server runs with MONITOR_TICK=1 and the tick sampler summary is included.
//
// usage: node test/e2e/stress.mjs --engine=chromium [--apps=20] [--prims=50] [--frames=600] [--monitor] [--port=3125]
// In CI this is a smoke only: budgets are enforced on a designated machine (see test/e2e/README.md).
import { execSync } from 'node:child_process'
import path from 'node:path'

import { APPS_DIR, arg, ensureOut, sleep } from './lib/common.mjs'
import { installAsset, startServer } from './lib/server.mjs'
import { becomeAdmin, launchBrowser, openWorld, saveArtifacts } from './lib/browser.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3125))
const N = Number(arg('apps', 20))
const K = Number(arg('prims', 50))
const F = Number(arg('frames', 600))
const MONITOR = arg('monitor', false) === true
const WORLD_SOURCE = arg('world', null)
const OUT = ensureOut()

const cpuSeconds = pid => {
  // ps cputime: "mm:ss.cc" or "hh:mm:ss" on macOS, "[[dd-]hh:]mm:ss" on Linux
  const text = execSync(`ps -o cputime= -p ${pid}`).toString().trim().replace('-', ':')
  const parts = text.split(':').map(Number)
  return parts.reduce((total, part) => total * 60 + part, 0)
}
const cpuPercent = async (pid, ms) => {
  const c0 = cpuSeconds(pid)
  const t0 = Date.now()
  await sleep(ms)
  return +(((cpuSeconds(pid) - c0) / ((Date.now() - t0) / 1000)) * 100).toFixed(1)
}

const out = { engine: ENGINE, apps: N, prims: K, nodes: N * K, monitor: MONITOR }
let server
let browser
let handles = {}
try {
  server = await startServer({
    port: PORT,
    worldSource: WORLD_SOURCE,
    logPath: path.join(OUT, `stress-${ENGINE}-server.log`),
    env: MONITOR ? { MONITOR_TICK: '1' } : {},
  })
  installAsset(server, path.join(APPS_DIR, 'stress.js'))
  browser = await launchBrowser(ENGINE)
  // a small viewport keeps the software renderer's share of each frame low
  const { page, errorLines, pageErrors } = await openWorld(browser, server.url, {
    viewport: { width: 480, height: 320 },
    settle: 5000,
    onPage: h => (handles = h),
  })
  out.serverCpuIdle = await cpuPercent(server.child.pid, 10000)
  await becomeAdmin(page)
  await page.evaluate(
    ({ N, K }) => {
      const w = window.world
      const bp = {
        id: 'stress-bp',
        version: 0,
        name: 'Stress',
        image: null,
        author: null,
        url: null,
        desc: null,
        model: 'asset://crash-block.glb',
        script: 'asset://stress.js',
        props: { k: K },
        preload: false,
        public: false,
        locked: false,
        frozen: false,
        unique: false,
        scene: false,
        disabled: false,
      }
      w.blueprints.add(bp, true)
      for (let i = 0; i < N; i++) {
        w.entities.add(
          {
            id: `stress-${i}`,
            type: 'app',
            blueprint: bp.id,
            position: [(i % 5) * 4 - 8, 0, -6 - Math.floor(i / 5) * 4],
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
    },
    { N, K }
  )
  await page.waitForFunction(
    N => {
      const list = [...window.world.entities.items.values()].filter(e => e.data?.id?.startsWith('stress-'))
      return list.length === N && list.every(e => e.script && !e.building)
    },
    N,
    { timeout: 60000 }
  )
  out.crashed = await page.evaluate(
    () =>
      [...window.world.entities.items.values()].filter(e => e.data?.id?.startsWith('stress-') && e.scriptError).length
  )
  await sleep(3000)
  const cpuPromise = cpuPercent(server.child.pid, 20000)
  out.frames = await page.evaluate(async F => {
    const w = window.world
    const phases = ['fixedUpdate', 'postFixedUpdate', 'preUpdate', 'update', 'lateUpdate', 'postLateUpdate', 'commit']
    const orig = {}
    const cur = {}
    const samples = { js: [], commit: [] }
    // the render loop keeps its own reference to world.tick, so sample at the end of commit() (the last phase)
    for (const p of phases) {
      orig[p] = w[p]
      w[p] = function (...a) {
        const t = performance.now()
        const r = orig[p].apply(this, a)
        cur[p] = (cur[p] || 0) + performance.now() - t
        if (p === 'commit') {
          samples.js.push(phases.filter(q => q !== 'commit').reduce((s, q) => s + (cur[q] || 0), 0))
          samples.commit.push(cur.commit)
          for (const q of phases) cur[q] = 0
        }
        return r
      }
    }
    const t0 = performance.now()
    while (samples.js.length < F && performance.now() - t0 < 150000) await new Promise(r => setTimeout(r, 200))
    for (const p of phases) w[p] = orig[p]
    const q = (a, p) => {
      const s = [...a].sort((x, y) => x - y)
      return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3)
    }
    const mean = a => +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3)
    return {
      n: samples.js.length,
      seconds: +((performance.now() - t0) / 1000).toFixed(1),
      jsMean: mean(samples.js),
      jsMedian: q(samples.js, 0.5),
      jsP90: q(samples.js, 0.9),
      commitMean: mean(samples.commit),
      commitMedian: q(samples.commit, 0.5),
    }
  }, F)
  out.serverCpuStress = await cpuPromise
  // the apps must still be healthy after the measurement, not only before it
  out.crashedAfter = await page.evaluate(
    () =>
      [...window.world.entities.items.values()].filter(e => e.data?.id?.startsWith('stress-') && e.scriptError).length
  )
  if (MONITOR) {
    // the sampler reports per minute: the first window includes boot and idle time, so keep the stress
    // world running until a second window (fully under load) has been reported
    const deadline = Date.now() + 90000
    while (server.lines(/\[monitor\] tick ms/).length < 2 && Date.now() < deadline) await sleep(1000)
    out.serverTickLines = server.lines(/\[monitor\] tick ms/)
    const last = out.serverTickLines[out.serverTickLines.length - 1] || ''
    const num = key => Number((last.match(new RegExp(`${key}=([0-9.]+)`)) || [])[1])
    out.serverTick = last
      ? { n: num('n'), mean: num('mean'), median: num('median'), p90: num('p90'), max: num('max') }
      : null
  }
  out.errors = [...errorLines(), ...pageErrors]
  // every crash or containment line the host can log
  out.serverErrors = server.lines(
    /script crashed|script \w+(\(\))? crashed|\[stage\] (node update failed|giving up)|\[physics\] interpolation failed|crash rebuild failed|SES_UNCAUGHT|SES_UNHANDLED|UnhandledPromiseRejection|Cannot assign to read only/
  )
  const failures = []
  if (out.crashed) failures.push(`${out.crashed} stress apps crashed before sampling`)
  if (out.crashedAfter) failures.push(`${out.crashedAfter} stress apps crashed after sampling`)
  if (out.frames.n < F) failures.push(`only ${out.frames.n} of ${F} frames were sampled`)
  if (out.errors.length) failures.push(`${out.errors.length} browser errors`)
  if (out.serverErrors.length) failures.push(`${out.serverErrors.length} server errors`)
  out.failures = failures
} catch (err) {
  out.error = err?.stack || String(err)
} finally {
  await saveArtifacts({ ...handles, prefix: path.join(OUT, `stress-${ENGINE}`) })
  await browser?.close().catch(() => {})
  await server?.stop()
  console.log(JSON.stringify(out))
  process.exit(out.error || out.failures?.length ? 1 : 0)
}
