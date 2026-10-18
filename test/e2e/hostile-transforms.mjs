// Local-only regression suite. The parent owns a deadline independent of the renderer and server.
// usage: node test/e2e/hostile-transforms.mjs --engine=chromium|webkit|firefox [--port=3125]
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { APPS_DIR, TIMEOUT_SCALE, arg, createResults, ensureOut, eq, ok, sleep, waitUntil } from './lib/common.mjs'
import { launchBrowser, openWorld } from './lib/browser.mjs'
import { installAsset, startServer } from './lib/server.mjs'
import { WireClient } from './lib/ws.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3125))
const PREFIX = path.join(ensureOut(), `hostile-transforms-${ENGINE}`)
const ANCHOR_APP = 'transform-anchor'
const MOVER_APP = 'transform-mover'
const IDENTITY = [0, 0, 0, 1]
const TURN = [0, Math.SQRT1_2, 0, Math.SQRT1_2]
const ANCHOR_POSITION = [3, 2, -3]
// These exact warnings are permitted, but never conceal script/physics failures or page errors.
const EXPECTED_MESSAGE =
  /^\[warning\] \[(LooseOctree|SnapOctree)\] parked (item|point) with non-finite or out-of-budget bounds$/
const BROWSER_NOISE = /WebGL|GPU|swiftshader|favicon|livekit|ERR_|Failed to load resource/i

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
  const deadline = setTimeout(() => stop(1, 'suite exceeded its 240s deadline (scaled)'), 240000 * TIMEOUT_SCALE)
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
  const { record, finish, results } = createResults(`hostile-transforms/${ENGINE}`)
  const evidence = []
  const clients = []
  const consoleLines = []
  const pageErrors = []
  let server
  let browser
  let page
  let watcher
  let visitor
  let seq = 0
  const writeLogs = () => {
    fs.writeFileSync(`${PREFIX}-console.log`, consoleLines.join('\n'))
    fs.writeFileSync(`${PREFIX}-page-errors.log`, pageErrors.join('\n'))
    fs.writeFileSync(`${PREFIX}-results.json`, JSON.stringify({ results, evidence }, null, 2))
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
  const connect = async label => {
    const client = new WireClient(PORT, label)
    clients.push(client)
    return bounded(client.connect(), `${label} connect`, 20000)
  }
  const packet = (client, predicate, from) => client.waitFor(predicate, { from, timeout: 10000 * TIMEOUT_SCALE })
  const report = async (playerId, appId = ANCHOR_APP) => {
    const from = watcher.mark()
    const request = ++seq
    watcher.send('entityEvent', [appId, 0, 'probe', { seq: request, playerId }])
    const message = await packet(
      watcher,
      m => m.method === 'onEntityEvent' && m.data[0] === appId && m.data[2] === 'report' && m.data[3]?.seq === request,
      from
    )
    const value = message.data[3]
    evidence.push({ server: appId, ...value })
    finitePose(value.player, 'server player')
    finitePose(value.body, 'server rigidbody')
    finiteArray(value.anchorMatrix, 16, 'server anchor matrix')
    return value
  }
  const playerState = id => evaluate(readPlayer, id)
  const waitPlayer = (id, predicate, message, timeout = 30000) =>
    waitUntil(
      async () => {
        const state = await playerState(id)
        return state && predicate(state) && state
      },
      { timeout, message }
    )
  const health = async () => {
    const response = await bounded(
      fetch(`${server.url}status`, { signal: AbortSignal.timeout(5000 * TIMEOUT_SCALE) }),
      '/status'
    )
    eq(response.status, 200, '/status')
    await bounded(response.arrayBuffer(), '/status body')
    const from = visitor.mark()
    const token = ++seq
    visitor.send('ping', token)
    await packet(visitor, m => m.method === 'onPong' && m.data === token, from)
  }
  const modify = async (client, data) => {
    const from = watcher.mark()
    client.send('entityModified', data)
    return (await packet(watcher, m => m.method === 'onEntityModified' && m.data.id === data.id, from)).data
  }
  const check = async (name, fn) => {
    await fn()
    record(true, name)
  }
  try {
    server = await bounded(startServer({ port: PORT, logPath: `${PREFIX}-server.log` }), 'server startup', 125000)
    process.send({ type: 'world', worldDir: server.worldDir })
    const script = installAsset(server, path.join(APPS_DIR, 'transform-probe.js'))
    const admin = await connect('admin')
    watcher = await connect('watcher')
    visitor = await connect('visitor')
    const mover = await connect('mover')
    await admin.becomeAdmin()
    const rank = async value => {
      const from = mover.mark()
      admin.send('modifyRank', { playerId: mover.id, rank: value })
      await packet(mover, m => m.method === 'onEntityModified' && m.data.id === mover.id && m.data.rank === value, from)
    }
    await rank(1)
    for (const [id, position] of [
      [ANCHOR_APP, [0, 0, 0]],
      [MOVER_APP, [7, 0, -3]],
    ]) {
      const from = watcher.mark()
      mover.installApp({ id, script, model: 'asset://ai.glb', position })
      await packet(watcher, m => m.method === 'onEntityAdded' && m.data.id === id, from)
      await report(visitor.id, id)
    }
    browser = await bounded(launchBrowser(ENGINE), 'browser launch', 60000)
    await bounded(
      openWorld(browser, server.url, {
        settle: 1000,
        onPage: opened => {
          page = opened.page
          // Keep collectors usable even if openWorld never resolves.
          page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
          page.on('pageerror', err => pageErrors.push(String(err)))
        },
      }),
      'world load',
      180000
    )

    let baseline
    await check('remote avatar loaded and valid baseline rendered', async () => {
      await waitPlayer(visitor.id, state => state.avatar, 'remote avatar instance')
      await modify(visitor, { id: visitor.id, p: [2, 0, -2], q: IDENTITY, t: true })
      baseline = await waitPlayer(visitor.id, state => near(state.position, [2, 0, -2]), 'baseline transform')
      assertPlayer(baseline)
      evidence.push({ baseline })
    })

    await check('lip sync: avatars sharing one VRM keep separate mouths', async () => {
      const probe = await evaluate(mouthProbe, visitor.id)
      ok(probe.instances, `remote and local avatar instances: ${JSON.stringify(probe)}`)
      // the same factory hands both instances one shallow-copied glb, so they share one template
      ok(probe.sharedTemplate, 'both avatars come from one VRM template')
      // the default avatar.vrm drives its mouth with one bind: the `aa` (VRM 0.x `a`) morph 39 on its face mesh
      eq(JSON.stringify(probe.opened), JSON.stringify([{ morph: 39, value: 1 }]), 'only the remote mouth morph opens')
      ok(probe.localUnchanged, 'the local avatar from the same template is untouched')
      ok(probe.remoteRestored, 'closing restores every remote morph')
      evidence.push({ mouth: probe })
    })

    const hostile = [{ q: [1e200, 0, 0, 1] }, { q: [0, 0, 0, 0] }, { p: [1e300, 0, 0] }, { p: [1e308, 0, 0] }]
    for (const [index, payload] of hostile.entries()) {
      await check(
        `hostile ${JSON.stringify(payload)}: baseline, frames, status, pong, ticks and recovery`,
        async () => {
          const before = await report(visitor.id)
          const relay = await modify(visitor, { id: visitor.id, ...payload, t: true })
          assert.deepEqual(relay, { id: visitor.id, t: true }, 'only the teleport marker is relayed')
          // A marker proves the browser processed this packet, then observe multiple completed frames
          // over the reproduction's three-second window before sending anything that could repair it.
          let state = await waitPlayer(visitor.id, value => value.teleport > baseline.teleport, 'hostile packet marker')
          const end = Date.now() + 3000
          do {
            const previous = state
            state = await waitPlayer(
              visitor.id,
              value => value.frame > previous.frame && value.time > previous.time,
              'completed frame'
            )
            assertPlayer(state)
            assert.deepEqual(state.position, baseline.position, 'rendered position preserved')
            assert.deepEqual(state.quaternion, baseline.quaternion, 'rendered quaternion preserved')
            assert.deepEqual(state.dataPosition, baseline.dataPosition, 'stored position preserved')
            assert.deepEqual(state.dataQuaternion, baseline.dataQuaternion, 'stored quaternion preserved')
            await health()
            await sleep(200)
          } while (Date.now() < end)
          const after = await report(visitor.id)
          ok(after.ticks > before.ticks, 'server update loop progressed')
          nearPose(after.player, baseline.position, baseline.quaternion)
          evidence.push({ payload, baseline, after: state })
          const position = [3 + index, 0, -2]
          await modify(visitor, { id: visitor.id, p: position, q: TURN, t: true })
          baseline = await waitPlayer(
            visitor.id,
            value => near(value.position, position) && near(value.quaternion, TURN),
            'valid recovery'
          )
          assertPlayer(baseline)
        }
      )
    }

    await check('benign quaternion drift is relayed as exact identity', async () => {
      const relay = await modify(visitor, { id: visitor.id, q: [0, 0, 0, 1.0000001] })
      assert.deepEqual(relay.q, IDENTITY)
      await waitPlayer(visitor.id, state => near(state.quaternion, IDENTITY), 'normalised quaternion')
    })

    await check('scaled rotated anchor: remote pose and body remount stay finite and unit scale', async () => {
      const probe = await report(visitor.id)
      const anchorId = probe.anchorId
      eq(anchorId, `${ANCHOR_APP}:seat`, 'stable anchor id')
      assertNear(
        [0, 4, 8].map(i => Math.hypot(...probe.anchorMatrix.slice(i, i + 3))),
        [2, 2, 2],
        'anchor world scale'
      )
      const anchorMatrix = await evaluate(anchorId => {
        const matrix = window.world.anchors.get(anchorId)
        if (!matrix) throw new Error('browser anchor missing')
        return matrix.toArray()
      }, anchorId)
      assertNear(anchorMatrix, probe.anchorMatrix, 'browser/server anchor matrix')
      const original = await playerState(visitor.id)
      await modify(visitor, { id: visitor.id, ef: { anchorId } })
      const anchored = await waitPlayer(
        visitor.id,
        state => state.effect?.anchorId === anchorId && near(state.position, ANCHOR_POSITION),
        'remote anchor'
      )
      assertPlayer(anchored)
      nearPose(anchored, ANCHOR_POSITION, TURN)
      eq(anchored.bodyActive, false, 'remote body disabled while anchored')
      const serverAnchor = await report(visitor.id)
      nearPose(serverAnchor.player, ANCHOR_POSITION, TURN)
      eq(serverAnchor.player.effect, true, 'server anchored')
      // Wire visitors do not publish the anchored pose themselves. Clear only ef to exercise remount
      // from the anchor's last base matrix, before a later valid movement repairs anything.
      await modify(visitor, { id: visitor.id, ef: null })
      const recovered = await waitPlayer(
        visitor.id,
        state => !state.effect && state.bodyActive && state.bodyPose,
        'remote body remount'
      )
      assertPlayer(recovered)
      finitePose(recovered.bodyPose, 'remounted native player body')
      assertNear(recovered.colliderScale, [1, 1, 1], 'collider world scale')
      const serverRecovered = await report(visitor.id)
      eq(serverRecovered.player.effect, false, 'server cleared effect')
      eq(serverRecovered.player.hit?.playerId, visitor.id, 'server capsule is raycastable again')
      ok(Math.abs(serverRecovered.player.hit.distance - 1.7) < 0.06, 'server capsule keeps its unscaled radius')
      evidence.push({ original, anchored, recovered })
      await modify(visitor, { id: visitor.id, p: [6, 0, -2], q: IDENTITY, t: true })
      await waitPlayer(visitor.id, state => near(state.position, [6, 0, -2]), 'remote movement after effect')
    })

    await check('server-applied local anchor: unit quaternion, expiry and capsule recovery', async () => {
      const localId = await evaluate(() => window.world.entities.player.data.id)
      await waitPlayer(localId, state => state.avatar, 'local avatar')
      watcher.send('entityEvent', [ANCHOR_APP, 0, 'anchor-local', { playerId: localId }])
      const anchored = await waitPlayer(
        localId,
        state => state.capsuleDisabled && near(state.position, ANCHOR_POSITION),
        'local anchor'
      )
      assertPlayer(anchored)
      nearPose(anchored, ANCHOR_POSITION, TURN)
      finitePose(anchored.bodyPose, 'anchored local capsule')
      const serverAnchor = await report(localId)
      nearPose(serverAnchor.player, ANCHOR_POSITION, TURN)
      eq(serverAnchor.player.effect, true, 'server sees local anchor')
      const recovered = await waitPlayer(
        localId,
        state => !state.effect && !state.capsuleDisabled && state.frame > anchored.frame,
        'local effect expiry',
        // the 2 s effect expires in simulated browser time; software-rendered CI browsers run far slower
        30000 + 2 * 30000
      )
      assertPlayer(recovered)
      finitePose(recovered.bodyPose, 'recovered local capsule')
      // Gravity must resume, not merely a boolean toggle on a still-disabled native capsule.
      const falling = await waitPlayer(
        localId,
        state => state.bodyPose?.position[1] < anchored.bodyPose.position[1] - 0.1,
        'capsule resumes simulation'
      )
      assertPlayer(falling)
      finitePose(falling.bodyPose, 'simulating local capsule')
      await waitUntil(async () => !(await report(localId)).player.effect, {
        message: 'server receives local effect clear',
      })
      evidence.push({ localId, anchored, recovered, falling })
      await health()
    })

    await check('demoted mover releases only; retained native pose and later builder move work', async () => {
      const previous = { position: [8, 0, -3], quaternion: [0, 1, 0, 0], scale: [1, 1, 1] }
      await modify(mover, { id: MOVER_APP, mover: mover.id, ...previous })
      await waitUntil(async () => (await evaluate(readApp, MOVER_APP))?.mover === mover.id, {
        message: 'builder moving app',
      })
      await rank(0)
      const relay = await modify(mover, { id: MOVER_APP, mover: null, scale: [0, 1, 1], position: [5, 0, 5] })
      assert.deepEqual(relay, { id: MOVER_APP, mover: null }, 'demoted release drops all transforms')
      const released = await waitUntil(
        async () => {
          const state = await evaluate(readApp, MOVER_APP)
          return state?.mover === null && !state.building && state.bodyPose && state
        },
        { message: 'released app rebuilt' }
      )
      assertApp(released, previous)
      const serverReleased = await report(visitor.id, MOVER_APP)
      nearPose(serverReleased.body, previous.position, previous.quaternion)
      await rank(1)
      await modify(mover, { id: MOVER_APP, mover: mover.id })
      const next = { position: [9, 0, -4], quaternion: IDENTITY, scale: [1.25, 1.25, 1.25] }
      await modify(mover, { id: MOVER_APP, ...next })
      await modify(mover, { id: MOVER_APP, mover: null })
      const moved = await waitUntil(
        async () => {
          const state = await evaluate(readApp, MOVER_APP)
          return (
            state?.mover === null && !state.building && state.bodyPose && near(state.position, next.position) && state
          )
        },
        { message: 'subsequent valid builder move' }
      )
      assertApp(moved, next)
      const serverMoved = await report(visitor.id, MOVER_APP)
      nearPose(serverMoved.body, next.position, next.quaternion)
      evidence.push({ released, moved })
      await health()
    })

    await check('late join receives finite transforms for every player and app', async () => {
      const late = await connect('late-joiner')
      const entities = late.snapshot.entities
      for (const id of [visitor.id, ANCHOR_APP, MOVER_APP])
        ok(
          entities.some(entity => entity.id === id),
          `snapshot includes ${id}`
        )
      for (const entity of entities) {
        if (entity.type !== 'player' && entity.type !== 'app') continue
        finiteNumbers(entity, `snapshot ${entity.id}`)
        finitePose(entity, `snapshot ${entity.id}`)
        ok(
          entity.position.every(value => Math.abs(value) <= 1e6),
          'shared position bound'
        )
        if (entity.type === 'app') {
          finiteArray(entity.scale, 3, 'snapshot scale')
          ok(
            entity.scale.every(value => Number.isFinite(Math.fround(value)) && Math.fround(value) !== 0),
            'f32 scale'
          )
        }
        for (const key of ['axis', 'gaze']) if (entity[key]) finiteArray(entity[key], 3, `snapshot ${key}`)
      }
      evidence.push({ snapshot: entities })
      await health()
    })
    await check('no unexpected browser or server failures', async () => {
      const unexpected = consoleLines
        .filter(line => !EXPECTED_MESSAGE.test(line))
        .filter(line => line.startsWith('[error]') && !BROWSER_NOISE.test(line))
      assert.deepEqual(pageErrors, [], 'uncaught page errors')
      assert.deepEqual(unexpected, [], 'browser errors')
      const serverErrors = server.lines(
        /script .*crashed|\[physics\]|\[stage\]|\[collider\]|Px.*(invalid|error)|SES_UNHANDLED|UnhandledPromiseRejection/i
      )
      assert.deepEqual(serverErrors, [], 'server script/physics errors')
    })
  } catch (err) {
    record(false, 'aborted', err.stack || String(err))
  } finally {
    writeLogs()
    try {
      if (page && !page.isClosed()) {
        const state = await evaluate(() => ({
          frame: window.world?.frame,
          time: window.world?.time,
          active: window.world?.ui?.state?.active,
        }))
        fs.appendFileSync(`${PREFIX}-console.log`, `\n[harness] page state at exit: ${JSON.stringify(state)}\n`)
        // the screenshot is a failure artifact only; software-rendered CI browsers can take longer than the
        // watchdog allows for it, and a frozen page has already failed through the frame checks
        if (results.some(r => !r.ok)) {
          await page.screenshot({ path: `${PREFIX}-final.png`, timeout: 5000 * TIMEOUT_SCALE }).catch(err => {
            fs.appendFileSync(`${PREFIX}-console.log`, `[harness] screenshot unavailable: ${err.message}\n`)
          })
        }
      }
    } catch (err) {
      record(false, 'artifact capture', err.message)
    }
    for (const client of clients) client.close()
    try {
      if (browser) await bounded(browser.close(), 'browser close', 10000)
      if (server) await bounded(server.stop(), 'server stop', 10000)
    } catch (err) {
      record(false, 'cleanup', err.message)
    }
    fs.writeFileSync(`${PREFIX}-results.json`, JSON.stringify({ results, evidence }, null, 2))
    process.send({ type: 'complete', code: finish() ? 1 : 0 })
    // The parent kills the worker and any surviving descendants, including detached browser groups.
    await new Promise(() => {})
  }
}

// runs in the page: drive one avatar's mouth and snapshot the morph influences of both clones
function mouthProbe(id) {
  const remote = window.world.entities.get(id)?.avatar?.instance
  const local = window.world.entities.player?.avatar?.instance
  if (!remote?.setMouth || !local?.setMouth) return { instances: false }
  const snapshot = instance => {
    const arrays = []
    instance.raw.scene.traverse(o => o.isMesh && o.morphTargetInfluences && arrays.push([...o.morphTargetInfluences]))
    return arrays
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const remoteBefore = snapshot(remote)
  const localBefore = snapshot(local)
  remote.setMouth(1)
  const remoteOpen = snapshot(remote)
  const opened = []
  remoteOpen.forEach((arr, m) => arr.forEach((v, i) => v !== remoteBefore[m][i] && opened.push({ morph: i, value: v })))
  const localUnchanged = same(snapshot(local), localBefore)
  remote.setMouth(0)
  return {
    instances: true,
    sharedTemplate: remote.raw.userData === local.raw.userData,
    opened,
    localUnchanged: localUnchanged && same(snapshot(local), localBefore),
    remoteRestored: same(snapshot(remote), remoteBefore),
  }
}

function readPlayer(id) {
  const world = window.world
  const player = world.entities.get(id)
  if (!player?.base) return null
  const matrices = []
  player.base.traverse(node => matrices.push(node.matrixWorld.toArray()))
  player.aura?.traverse(node => matrices.push(node.matrixWorld.toArray()))
  const actor = player.capsule || player.body?.actor
  const pose = actor?.getGlobalPose()
  const matrix = player.collider?.matrixWorld
  const elements = matrix?.elements
  return {
    frame: world.frame,
    time: world.time,
    avatar: !!player.avatar?.instance,
    position: player.base.position.toArray(),
    quaternion: player.base.quaternion.toArray(),
    dataPosition: player.data.position,
    dataQuaternion: player.data.quaternion,
    teleport: player.teleport,
    effect: player.data.effect,
    matrices,
    bodyActive: player.body?.active,
    capsuleDisabled: !!player.capsuleDisabled,
    bodyPose: pose
      ? { position: [pose.p.x, pose.p.y, pose.p.z], quaternion: [pose.q.x, pose.q.y, pose.q.z, pose.q.w] }
      : null,
    colliderScale: elements ? [0, 4, 8].map(i => Math.hypot(elements[i], elements[i + 1], elements[i + 2])) : null,
  }
}

function readApp(id) {
  const entity = window.world.entities.get(id)
  if (!entity) return null
  const body = entity.root?.get('transform-body')
  const pose = body?.actor?.getGlobalPose()
  return {
    ...entity.data,
    building: entity.building,
    error: entity.scriptError?.message,
    matrix: entity.root?.matrixWorld.toArray(),
    bodyPose: pose
      ? { position: [pose.p.x, pose.p.y, pose.p.z], quaternion: [pose.q.x, pose.q.y, pose.q.z, pose.q.w] }
      : null,
  }
}

function finiteArray(value, length, label) {
  ok(
    Array.isArray(value) && value.length === length && value.every(Number.isFinite),
    `${label} must have ${length} finite numbers`
  )
}

function finiteNumbers(value, label) {
  if (typeof value === 'number') ok(Number.isFinite(value), `${label} contains a non-finite number`)
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) finiteNumbers(child, `${label}.${key}`)
  }
}

function finitePose(value, label) {
  ok(value, `${label} exists`)
  finiteArray(value.position, 3, `${label} position`)
  finiteArray(value.quaternion, 4, `${label} quaternion`)
  ok(Math.abs(Math.hypot(...value.quaternion) - 1) < 1e-5, `${label} quaternion is unit length`)
}

function near(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, i) => Math.abs(value - expected[i]) < 1e-5)
  )
}

function assertNear(actual, expected, label) {
  ok(near(actual, expected), `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}

function nearPose(value, position, quaternion) {
  finitePose(value, 'pose')
  assertNear(value.position, position, 'position')
  assertNear(value.quaternion, quaternion, 'quaternion')
}

function assertPlayer(state) {
  ok(state.avatar, 'avatar instance remains mounted')
  finitePose(state, 'browser player')
  ok(state.matrices.length > 0, 'player matrices exist')
  for (const matrix of state.matrices) finiteArray(matrix, 16, 'player world matrix')
}

function assertApp(state, expected) {
  ok(!state.error, `app script: ${state.error}`)
  for (const key of ['position', 'quaternion', 'scale']) assert.deepEqual(state[key], expected[key], `app ${key}`)
  finiteArray(state.matrix, 16, 'app matrix')
  nearPose(state.bodyPose, expected.position, expected.quaternion)
}
