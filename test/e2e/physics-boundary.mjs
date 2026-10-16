// Local throwaway-world suite. A separate process owns the deadline, including hung WASM/renderers.
// usage: node test/e2e/physics-boundary.mjs --engine=chromium|webkit|firefox [--sentinel-only] [--expect-violations]
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { APPS_DIR, TIMEOUT_SCALE, arg, createResults, ensureOut, eq, ok, waitUntil } from './lib/common.mjs'
import { launchBrowser, openWorld } from './lib/browser.mjs'
import { installAsset, startServer } from './lib/server.mjs'
import { WireClient } from './lib/ws.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3126))
const SUBSET = arg('sentinel-only', false) === true
const EXPECT_VIOLATIONS = arg('expect-violations', false) === true
if (EXPECT_VIOLATIONS && !SUBSET) throw new Error('--expect-violations requires --sentinel-only')
const PREFIX = path.join(ensureOut(), `physics-boundary-${ENGINE}${SUBSET ? '-sentinel-only' : ''}`)
const SENTINEL = 'native-sentinel'
const PROBE = 'physics-probe'
const BROWSER_NOISE = /WebGL|GPU|swiftshader|favicon|livekit|ERR_|Failed to load resource/i
// Exact expected input-policy diagnostics; intentional brand errors stay in structured probe reports.
const EXPECTED_MESSAGES = new Set([
  '[rigidbody] addForce ignored a non-finite force',
  '[rigidbody] addForceAtPos ignored a non-finite force or pos',
  '[rigidbody] addForceAtLocalPos ignored a non-finite force or pos',
  '[rigidbody] addTorque ignored a non-finite torque',
  '[rigidbody] setPosition ignored a non-finite position',
  '[rigidbody] setQuaternion ignored a non-finite quaternion',
  '[rigidbody] setLinearVelocity ignored a non-finite velocity',
  '[rigidbody] setAngularVelocity ignored a non-finite velocity',
  '[rigidbody] setCenterOfMass ignored a non-finite pos',
  '[rigidbody] setKinematicTarget ignored a non-finite position or quaternion',
  '[rigidbody] getVelocityAtPos ignored a non-finite pos',
  '[rigidbody] getLocalVelocityAtLocalPos ignored a non-finite pos',
  '[controller] teleport ignored a non-finite vector',
  '[controller] move ignored a non-finite vector',
  '[player] teleport ignored a non-finite position',
  '[player] push ignored a non-finite force',
  '[raycast] ignored a non-finite origin or direction',
  '[overlapSphere] ignored a non-finite origin',
])
const expected = line => EXPECTED_MESSAGES.has(line.replace(/^\[(warning|warn|error)\] /, '').trim())

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
  const deadline = setTimeout(() => stop(1, 'suite exceeded its 360s deadline (scaled)'), 360000 * TIMEOUT_SCALE)
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

async function runSuite() {
  const { record, finish, results } = createResults(`physics-boundary/${ENGINE}`)
  const evidence = []
  let server
  let browser
  let page
  let wire
  let consoleLines = []
  let pageErrors = []
  let seq = 0
  let serverArmed = false
  let clientArmed = false
  const writeLogs = () => {
    fs.writeFileSync(`${PREFIX}-console.log`, consoleLines.join('\n'))
    fs.writeFileSync(`${PREFIX}-page-errors.log`, pageErrors.join('\n'))
    fs.writeFileSync(
      `${PREFIX}-results.json`,
      JSON.stringify({ subset: SUBSET, expectViolations: EXPECT_VIOLATIONS, results, evidence }, null, 2)
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
  const evaluate = (fn, data) => bounded(page.evaluate(fn, data), 'page.evaluate')
  const command = async (realm, id, name, data = {}) => {
    const request = { seq: ++seq, command: name, ...data }
    let result
    if (realm === 'server') {
      const from = wire.mark()
      wire.send('entityEvent', [id, 0, 'probe:command', request])
      const packet = await bounded(
        wire.waitFor(
          m =>
            m.method === 'onEntityEvent' &&
            m.data[0] === id &&
            m.data[2] === 'report' &&
            m.data[3]?.seq === request.seq,
          { from, timeout: 8000 * TIMEOUT_SCALE }
        ),
        'server command',
        10000
      )
      result = packet.data[3]
    } else {
      result = await evaluate(
        ({ id, request }) => {
          const entity = window.world.entities.get(id)
          if (entity.scriptError) throw new Error(entity.scriptError.message)
          entity.emit('probe:command', request)
          return entity.data.state.last
        },
        { id, request }
      )
    }
    ok(result?.seq === request.seq && result.ok, `${realm} ${id}.${name}: ${result?.error || 'missing report'}`)
    return id === SENTINEL ? result : result.value
  }
  const status = realm => command(realm, PROBE, 'status')
  const waitStatus = (realm, predicate, message, timeout = 45000) =>
    waitUntil(
      async () => {
        const value = await status(realm)
        return predicate(value) && value
      },
      { timeout, interval: 150, message: `${realm}: ${message}` }
    )
  const player = () =>
    evaluate(() => {
      const w = window.world
      const p = w.entities.player
      return {
        id: p.data.id,
        frame: w.frame,
        time: w.time,
        position: p.base.position.toArray(),
        yaw: p.base.rotation.y,
        lastJumpAt: p.lastJumpAt,
        grounded: p.grounded,
        flying: p.flying,
        building: w.builder.enabled,
        effect: p.data.effect,
        capsuleDisabled: !!p.capsuleDisabled,
        platform: !!p.platform.actor,
        onProbePlatform: p.platform.actor === w.entities.get('physics-probe')?.root?.get('platform')?.actor,
      }
    })
  const simulate = async seconds => {
    const start = await status('client')
    // software-rendered CI browsers simulate far slower than real time
    return waitStatus('client', value => value.elapsed - start.elapsed >= seconds, `${seconds}s simulated time`, 45000 + seconds * 30000)
  }
  const key = (action, name) => bounded(page.keyboard[action](name), `keyboard ${action} ${name}`)
  const check = async (name, fn) => {
    const value = await fn()
    evidence.push({ scenario: name, value: value ?? null })
    record(true, name)
  }
  const install = async (id, filename, props = {}) => {
    const script = installAsset(server, path.join(APPS_DIR, filename))
    // the server does not echo entityAdded to its sender; the browser below observes the app instead.
    // ('command' is an internal event name the server never dispatches from the network, hence 'probe:command')
    wire.installApp({ id, script, model: 'asset://ai.glb', props })
    await waitUntil(
      () =>
        evaluate(id => {
          const app = window.world.entities.get(id)
          if (app?.scriptError) throw new Error(app.scriptError.message)
          return !!app?.data.state?.ready && !app.building
        }, id),
      { timeout: 30000, message: `${id} ready` }
    )
  }
  try {
    server = await bounded(startServer({ port: PORT, logPath: `${PREFIX}-server.log` }), 'server startup', 125000)
    process.send({ type: 'world', worldDir: server.worldDir })
    wire = new WireClient(PORT, 'physics-admin')
    await bounded(wire.connect(), 'wire connect', 25000)
    await bounded(wire.becomeAdmin(), 'wire admin', 15000)
    browser = await bounded(launchBrowser(ENGINE), 'browser launch', 60000)
    await bounded(
      openWorld(browser, server.url, {
        settle: 500,
        onPage: handles => {
          page = handles.page
          consoleLines = handles.consoleLines
          pageErrors = handles.pageErrors
        },
      }),
      'open world',
      180000
    )
    const localId = (await player()).id
    wire.send('modifyRank', { playerId: localId, rank: 2 })
    await waitUntil(() => evaluate(() => window.world.entities.player.data.rank === 2), { message: 'browser admin' })
    await evaluate(() => document.activeElement?.blur?.())
    await install(SENTINEL, 'native-sentinel.js')
    await check('server and browser sentinel self-tests; arm before fixtures', async () => {
      const s = await command('server', SENTINEL, 'arm')
      serverArmed = true
      const c = await command('client', SENTINEL, 'arm')
      clientArmed = true
      for (const result of [s, c]) {
        eq(result.selfTest.violations, 1, 'self-test detects exactly one fake native')
        eq(result.total, 0, 'scenario count starts at zero')
        ok(result.selfTest.descriptors > 100 && result.selfTest.behavior.chaining, 'all prototypes instrumented')
      }
      return { server: s, client: c }
    })
    await install(PROBE, 'physics-probe.js', { sentinelOnly: SUBSET })
    if (!SUBSET) {
      await check(
        'both vector brands, shadowing, invalid values, intrinsic errors and bug fixes in both realms',
        async () => {
          const s = await command('server', PROBE, 'inputs', { playerId: localId })
          const c = await command('client', PROBE, 'inputs', { playerId: localId })
          for (const value of [s, c]) {
            eq(value.recorderCalls, 0, 'own methods not invoked')
            eq(value.recorderNatives, 0, 'own methods receive no native')
            eq(value.brands, 4, 'Enhanced/stock, plain/shadowed')
            ok(value.intrinsicErrors.length >= 40, 'bad-call errors checked inside SES')
          }
          return { server: s, client: c }
        }
      )
      await check('impulse modes change velocity after the physics step', async () => {
        const reports = []
        for (const realm of ['server', 'client']) {
          for (const local of [false, true]) {
            const before = await command(realm, PROBE, 'impulse', { local })
            const after = await waitStatus(realm, s => s.ticks > before.ticks + 2, 'impulse integrated')
            ok(after.impulseVelocity[0] > 0.5, 'impulse changes velocity (force default would be < 0.1)')
            reports.push({ realm, local, before, after })
          }
        }
        return reports
      })
    }
    await check('dynamic contacts: two begin/end cycles with pooled contact points', async () => {
      const reports = []
      for (const realm of ['server', 'client']) {
        let previous = { prim: 0, body: 0 }
        for (let cycle = 1; cycle <= 2; cycle++) {
          const begin = await waitStatus(
            realm,
            s =>
              s.counts.prim.begin > previous.prim &&
              s.falling[1] < 3 &&
              (SUBSET || (s.counts.body.begin > previous.body && s.dynamic[1] < 3)),
            'contact begin'
          )
          ok(begin.falling[1] < 3, 'prim fell to floor')
          if (!SUBSET) ok(begin.dynamic[1] < 3, 'rigidbody fell to floor')
          await command(realm, PROBE, 'lift')
          const end = await waitStatus(
            realm,
            s =>
              s.counts.prim.end > begin.counts.prim.end &&
              s.falling[1] > 4 &&
              (SUBSET || (s.counts.body.end > begin.counts.body.end && s.dynamic[1] > 4)),
            'contact end'
          )
          previous = { prim: begin.counts.prim.begin, body: begin.counts.body.begin }
          ok(end.counts.prim.points > 0 && (SUBSET || end.counts.body.points > 0), 'finite contact points received')
          reports.push({ realm, cycle, begin, end })
        }
      }
      return reports
    })
    await check('server raycast and client interpolation', async () => {
      const hit = await command('server', PROBE, 'query')
      // Node positions are updated by Physics.postFixedUpdate -> lerp -> onInterpolate.
      await command('client', PROBE, 'lift')
      const start = await waitStatus('client', s => s.falling[1] > 4, 'lift committed')
      const end = await waitStatus('client', s => s.falling[1] < start.falling[1] - 0.5, 'interpolated fall')
      ok(end.ticks > start.ticks, 'client keeps interpolating')
      return { hit, start, end }
    })
    if (!SUBSET) {
      await check('trigger enter/leave and all four server joints constrain dynamic bodies', async () => {
        const reports = []
        for (const realm of ['server', 'client']) {
          await command(realm, PROBE, 'trigger', { inside: true })
          await waitStatus(realm, s => s.counts.enter > 0, 'trigger enter')
          await command(realm, PROBE, 'trigger', { inside: false })
          const s = await waitStatus(realm, s => s.counts.leave > 0 && s.elapsed > 2, 'trigger leave')
          eq(s.joints.length, 4, 'four joints mounted')
          ok(
            s.controllerWorld.every((n, i) => Math.abs(n - s.controller[i]) < 1e-5),
            'controller output dirties and re-commits its node'
          )
          ok(Math.hypot(...s.kinematic.map((n, i) => n - [35, 4, 0][i])) < 0.1, 'invalid kinematic targets ignored')
          for (const joint of s.joints)
            ok(Number.isFinite(joint.distance) && joint.distance < 3, `${realm} ${joint.type} constrains separation`)
          reports.push({ realm, ...s, query: await command(realm, PROBE, 'query') })
        }
        return reports
      })
    }
    await check('player walks while sentinel is armed', async () => {
      if (!SUBSET) {
        await command('client', PROBE, 'teleport', { playerId: localId, position: [0, 0.1, 0] })
        await simulate(0.5)
      }
      const start = await player()
      await key('down', 'KeyW')
      await simulate(1.5)
      await key('up', 'KeyW')
      await simulate(0.3)
      const end = await player()
      const distance = Math.hypot(end.position[0] - start.position[0], end.position[2] - start.position[2])
      ok(distance > 0.5, `walked ${distance}m`)
      return { start, end, distance }
    })
    if (!SUBSET) {
      await check('player jumps', async () => {
        await waitUntil(async () => (await player()).grounded, { message: 'grounded before jump' })
        const start = await player()
        await key('down', 'Space')
        await simulate(0.15)
        await key('up', 'Space')
        let maxY = (await player()).position[1]
        const t0 = (await status('client')).elapsed
        await waitUntil(
          async () => {
            maxY = Math.max(maxY, (await player()).position[1])
            return (await status('client')).elapsed - t0 >= 1.5
          },
          { timeout: 45000, interval: 50, message: 'jump sampled over simulated time' }
        )
        ok(maxY - start.position[1] > 0.3, `jump rise ${maxY - start.position[1]}`)
        return { start, maxY }
      })
      await check(
        'server/local player teleport and push preserve both vector brands and quaternion rotationY',
        async () => {
          const reports = []
          for (const realm of ['server', 'client']) {
            for (const stockVector of [false, true]) {
              await simulate(1) // let the preceding push decay, or it carries the player off the target at once
              // PlayerLocal.teleport broadcasts the snapped position with `t: true`; sampling the falling player
              // instead can miss the short window on slow engines
              const from = wire.mark()
              await command(realm, PROBE, 'teleport', { playerId: localId, position: [0, 10, 5], stockVector })
              const snapped = await bounded(
                wire.waitFor(
                  m =>
                    m.method === 'onEntityModified' &&
                    m.data.id === localId &&
                    m.data.t === true &&
                    Math.abs(m.data.p?.[0]) < 0.1 &&
                    Math.abs(m.data.p?.[1] - 10) < 0.1 &&
                    Math.abs(m.data.p?.[2] - 5) < 0.1,
                  { from, timeout: 10000 * TIMEOUT_SCALE }
                ),
                `${realm} teleport applied`,
                12000
              )
              const start = { position: snapped.data.p }
              await command(realm, PROBE, 'push', { playerId: localId, stockVector })
              const end = await waitUntil(
                async () => {
                  const p = await player()
                  return p.position[2] < start.position[2] - 0.1 && p
                },
                { timeout: 30000, message: `${realm} push applied` }
              )
              reports.push({ realm, stockVector, start, end })
            }
          }
          return reports
        }
      )
      await check('platform translation and rotation carry player position and yaw', async () => {
        await simulate(1) // let the preceding push decay before placing the player
        await command('client', PROBE, 'teleport', { playerId: localId, position: [1, 5.5, -15] })
        await waitUntil(
          async () => {
            const p = await player()
            return p.grounded && p.onProbePlatform
          },
          { timeout: 30000, message: 'standing on probe platform' }
        )
        await simulate(0.3)
        const start = await player()
        const initial = await status('client')
        await command('client', PROBE, 'platform', { moving: true })
        await command('server', PROBE, 'platform', { moving: true })
        const state = await simulate(3)
        const end = await player()
        await command('client', PROBE, 'platform', { moving: false })
        await command('server', PROBE, 'platform', { moving: false })
        ok(end.grounded && end.onProbePlatform, 'player stays on moving platform')
        const dx = start.position[0] - initial.platform[0]
        const dz = start.position[2] - initial.platform[2]
        const angle = state.platformYaw - initial.platformYaw
        const expectedX = state.platform[0] + Math.cos(angle) * dx + Math.sin(angle) * dz
        const expectedZ = state.platform[2] - Math.sin(angle) * dx + Math.cos(angle) * dz
        ok(
          Math.hypot(end.position[0] - expectedX, end.position[2] - expectedZ) < 0.4,
          'player follows platform transform'
        )
        ok(
          Math.hypot(end.position[0] - start.position[0], end.position[2] - start.position[2]) > 0.3,
          'platform carries player'
        )
        ok(
          Math.abs(Math.atan2(Math.sin(end.yaw - start.yaw), Math.cos(end.yaw - start.yaw))) > 0.3,
          'player yaw rotates'
        )
        return { start, end, initial, state }
      })
      await check('server seat effect anchors local browser player and restores simulation', async () => {
        await command('server', PROBE, 'anchor', { playerId: localId })
        const anchored = await waitUntil(
          async () => {
            const p = await player()
            return p.capsuleDisabled && Math.hypot(p.position[0] - 5, p.position[1] - 8, p.position[2] + 15) < 0.1 && p
          },
          { message: 'seat pose' }
        )
        await simulate(2.5)
        const end = await player()
        ok(!end.capsuleDisabled && !end.effect, 'anchor expired and native simulation restored')
        ok(end.position[1] < anchored.position[1] - 0.1, 'player falls after seat release')
        return { anchored, end }
      })
      await check('build mode flying is enabled and moves the player', async () => {
        await key('press', 'Tab')
        await waitUntil(async () => (await player()).building, { message: 'Tab enabled build mode' })
        // Each key transition gets separate simulated frames; the actual flight gate uses world.time.
        await key('down', 'Space')
        await simulate(0.03)
        const firstPress = await player()
        await key('up', 'Space')
        await simulate(0.03)
        await key('down', 'Space')
        await simulate(0.03)
        await key('up', 'Space')
        const secondPress = await player()
        const gap = secondPress.lastJumpAt - firstPress.lastJumpAt
        let method = 'two sampled Space presses'
        if (!secondPress.flying || !(gap > 0 && gap < 0.4)) {
          // R3.3 fallback when slow software rendering misses the 0.4s world.time window.
          await evaluate(() => window.world.entities.player.toggleFlying(true))
          method = 'PlayerLocal.toggleFlying(true) after missed key window'
        }
        const start = await player()
        eq(start.flying, true, 'flying === true')
        await key('down', 'KeyW')
        await simulate(1)
        await key('up', 'KeyW')
        const end = await player()
        eq(end.flying, true, 'flying remains enabled')
        ok(Math.hypot(...end.position.map((n, i) => n - start.position[i])) > 0.3, 'flying movement')
        await evaluate(() => window.world.entities.player.toggleFlying(false))
        await key('press', 'Tab')
        return { start, end, method, firstPress, secondPress, gap }
      })
      await check('constructor zero-scale geometry collider does not stop either world', async () => {
        const reports = []
        for (const realm of ['server', 'client']) {
          const before = await command(realm, PROBE, 'zeroScale')
          const after = await waitStatus(realm, s => s.ticks > before.zeroScaleTick + 10, 'ticks after zero scale')
          reports.push({ realm, before, after })
        }
        return reports
      })
    }
    await check(
      EXPECT_VIOLATIONS
        ? 'base positive control detects native leaks in both realms'
        : 'zero native violations in both realms',
      async () => {
        const s = await command('server', SENTINEL, 'disarm')
        serverArmed = false
        const c = await command('client', SENTINEL, 'disarm')
        clientArmed = false
        evidence.push({ sentinelCounts: { server: s.total, client: c.total }, server: s, client: c })
        for (const [realm, value] of [
          ['server', s],
          ['client', c],
        ]) {
          eq(value.armed, false, `${realm} disarmed/restored`)
          if (EXPECT_VIOLATIONS) ok(value.total > 0, `${realm} base must produce violations`)
          else eq(value.total, 0, `${realm} native violations: ${JSON.stringify(value.methods)}`)
        }
        return { server: s.total, client: c.total }
      }
    )
    await check('no script, physics or uncaught browser failures', async () => {
      const browserFailures = consoleLines.filter(
        line =>
          !expected(line) &&
          !BROWSER_NOISE.test(line) &&
          (/^\[error\]/.test(line) ||
            /\[(physics|rigidbody|controller|raycast|overlapSphere|prim|collider|stage)\]|Px.*(invalid|error)|script .*crashed/i.test(
              line
            ))
      )
      const serverFailures = server
        .lines(
          /script .*crashed|\[(physics|rigidbody|controller|raycast|overlapSphere|prim|collider|stage)\]|Px.*(invalid|error)|SES_UNHANDLED|UnhandledPromiseRejection|event dropped/i
        )
        .filter(line => !expected(line))
      assert.deepEqual(pageErrors, [], 'page errors')
      assert.deepEqual(browserFailures, [], 'unexpected browser messages')
      assert.deepEqual(serverFailures, [], 'unexpected server messages')
      const response = await bounded(
        fetch(`${server.url}status`, { signal: AbortSignal.timeout(5000 * TIMEOUT_SCALE) }),
        '/status'
      )
      eq(response.status, 200, 'server health')
      await bounded(response.arrayBuffer(), '/status body')
    })
  } catch (err) {
    record(false, 'aborted', err.stack || String(err))
  } finally {
    // Restore prototype descriptors even after a failed scenario; a hard hang is killed by the parent.
    for (const realm of ['server', 'client']) {
      if (!(realm === 'server' ? serverArmed : clientArmed)) continue
      try {
        evidence.push({ cleanupSentinel: realm, result: await command(realm, SENTINEL, 'disarm') })
      } catch (err) {
        record(false, `${realm} disarm`, err.message)
      }
    }
    writeLogs()
    if (page && !page.isClosed() && results.some(r => !r.ok)) {
      await bounded(
        page.screenshot({ path: `${PREFIX}-final.png`, timeout: 5000 * TIMEOUT_SCALE }),
        'failure screenshot'
      ).catch(err => fs.appendFileSync(`${PREFIX}-console.log`, `\n[screenshot] ${err.message}\n`))
    }
    wire?.close()
    try {
      if (browser) await bounded(browser.close(), 'browser close', 10000)
      if (server) await bounded(server.stop(), 'server stop', 10000)
    } catch (err) {
      record(false, 'cleanup', err.message)
    }
    writeLogs()
    process.send({ type: 'complete', code: finish() ? 1 : 0 })
    await new Promise(() => {})
  }
}
