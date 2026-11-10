import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// the real lockdown config (ses must be imported first, as in src/server/index.js)
import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'
import { calloutOn, createSweep } from './lib/sweepWorld.mjs'

// The executable teardown sweep (see test/lib/sweepWorld.mjs for the world and the footprint). Four axes:
//   1. callback points x allocating APIs: at every point where an app's script code runs while its run is torn down
//      (or while a handle of it is evicted, or an effect of it is replaced), the script tries every allocating API;
//   2. callback points x retirement: from inside each point the app is retired (removed, or rebuilt) and the
//      operation that was running finishes;
//   3. arguments x retirement: every handle method that takes arguments gets arguments whose reads retire the app;
//   4. the engine math objects reachable from a handle are sealed.
// After each, once the app is removed (or rebuilt into an empty script), nothing of the run may remain and the
// handles it kept may no longer change host state. "Engine callouts" stand for any script code the engine could reach
// in the middle of an operation (a script can no longer reach one through an engine math object: those are sealed);
// the test puts them on a host node's unmount or mount. A new callback point, API or argument trap is one table entry.
let bundle
let m
let scripts
let sweep
const realFetch = globalThis.fetch
const realDocument = globalThis.document
const requests = []

before(async () => {
  bundle = await bundleProbe(`
    export { Scripts } from './src/core/systems/Scripts'
    export { App } from './src/core/entities/App'
    export { Apps } from './src/core/systems/Apps'
    export { Anchors } from './src/core/systems/Anchors'
    export { Blueprints } from './src/core/systems/Blueprints'
    export { ClientControls } from './src/core/systems/ClientControls'
    export { ServerLiveKit } from './src/core/systems/ServerLiveKit'
    export { Stage } from './src/core/systems/Stage'
    export { createNode } from './src/core/extras/createNode'
    export * as Nodes from './src/core/nodes'
    export * as THREE from './src/core/extras/three'
    export { Object3D } from 'three'
  `)
  m = await import(bundle.url)
  scripts = new m.Scripts({})
  sweep = createSweep({ m, scripts, requests })
  // a request to .../blob answers with an image; any other only ends when it is aborted (no network)
  globalThis.fetch = (url, init) => {
    const request = { signal: init.signal, settled: false }
    requests.push(request)
    if (String(url).endsWith('/blob')) {
      request.settled = true
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
    }
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
})
after(() => {
  globalThis.fetch = realFetch
  globalThis.document = realDocument
  bundle?.destroy()
})

const STOPPED = '[app] this app has stopped'
const LEFT = '[player] this player has left'
const ENDINGS = ['removed', 'rebuilt into an empty script']
const ENVS = [false, true]
const side = isServer => (isServer ? 'server' : 'client')

// what the run makes at build, and keeps: a player handle, a control, a world-space holder with an inactive child, a
// node under a detached parent, the two linked meshes and a material of theirs, a video and its material, a sound, a
// skinned mesh, a blob; `retire()` asks the host to remove or rebuild the app (sweepWorld.onRetire)
const PRELUDE = `
    const log = (app.state.log = [])
    const fired = (app.state.fired = [])
    const urls = (app.state.urls = [])
    // one-shot: a getter read again after the retirement returns its value (it does not throw from the stopped app)
    let retiring = false
    const retire = () => {
      if (retiring) return
      retiring = true
      app.emit('retire', 1)
    }
    const kept = (app.state.kept = {})
    kept.player = world.getPlayer('p1')
    kept.holder = app.create('group', { id: 'holder' })
    world.add(kept.holder)
    kept.hidden = app.create('group', { id: 'hidden', active: false })
    kept.holder.add(kept.hidden)
    kept.attachable = app.create('group')
    app.create('group').add(kept.attachable)
    kept.first = app.get('first')
    kept.last = app.get('last')
    kept.skinned = app.get('skinned')
    kept.material = kept.first.material
    kept.video = app.create('video', { width: 1, height: 1 })
    world.add(kept.video)
    kept.videoMaterial = kept.video.material
    kept.audio = app.create('audio', { src: 'asset://tone.mp3', loop: true, spatial: false })
    app.add(kept.audio)
    kept.particles = app.create('particles')
    app.add(kept.particles)
    fetch('https://example.invalid/blob').then(response => response.blob()).then(blob => (kept.blob = blob))
`

// ---- axis 1: callback points x allocating APIs ---------------------------------------------------------------------

// every allocating API of the script surface; `env` limits an attempt to the side where it allocates (voice levels
// exist on the server, a video's material on the client)
const ATTEMPTS = [
  ['getPlayer', `if (!world.getPlayer('p1')) throw new Error('no handle')`],
  ['getPlayers', `world.getPlayers().map(player => player.id)`],
  ['fresh handle: applyEffect', `world.getPlayer('p1').applyEffect({ freeze: true, duration: 600 })`],
  ['fresh handle: setVoiceLevel', `world.getPlayer('p1').setVoiceLevel('global')`, 'server'],
  ['kept handle: applyEffect', `kept.player.applyEffect({ freeze: true, duration: 600 })`],
  ['kept handle: setVoiceLevel', `kept.player.setVoiceLevel('global')`, 'server'],
  ['app.control', `app.control().hideReticle()`],
  ['kept control: hideReticle', `kept.control.hideReticle()`],
  ['kept control: pointer.lock', `kept.control.pointer.lock()`],
  ['kept control: setActions', `kept.control.setActions([{ type: 'keyE', label: 'Use' }])`],
  ['world.add', `world.add(app.create('group'))`],
  ['world.add (video)', `world.add(app.create('video', { width: 1, height: 1 }))`],
  ['world.attach', `world.attach(kept.attachable)`],
  ['app.add', `app.add(app.create('group'))`],
  ['kept node: add', `kept.holder.add(app.create('group'))`],
  ['kept node: active false -> true', `kept.hidden.active = false; kept.hidden.active = true`],
  ['kept mesh: rebuild (linked, clean)', `kept.first.linked = !kept.first.linked; kept.first.clean()`],
  ['kept audio: play', `kept.audio.play()`],
  ['kept skinned mesh: play', `kept.skinned.play({ name: 'idle' })`],
  ['kept blob: URL.createObjectURL', `urls.push(URL.createObjectURL(kept.blob))`],
  ['setTimeout', `setTimeout(() => fired.push('timer'), 0)`],
  ['app.on (update)', `app.on('update', () => fired.push('update'))`],
  ['world.on', `world.on('enter', () => fired.push('enter'))`],
  ['fetch', `fetch('https://example.invalid/')`],
  ['app.emit', `app.emit('sweep-ping', 1)`],
  ['app.send', `app.send('sweep-ping', 1)`],
  ['world.chat', `world.chat('hello', true)`],
  ['kept material: color', `kept.material.color = 'red'`],
  ['kept video material: textureX', `kept.videoMaterial.textureX = 0.5`, 'client'],
]
const attemptsFor = isServer => ATTEMPTS.filter(([, , env]) => !env || env === side(isServer))

// where script code runs, as { script: code run at build, host: what the test does on the host side to reach it }
const POINTS = {
  'destroy event': { script: `app.on('destroy', () => attemptAll('destroy'))` },
  'control onRelease': { control: `{ onRelease: () => attemptAll('onRelease') }` },
  'effect onEnd': {
    script: `kept.player.applyEffect({ freeze: true, duration: 60, onEnd: () => attemptAll('onEnd') })`,
  },
  'engine callout while unmounting (root stage)': {
    host: ({ app, attemptAll }) => calloutOn(app.root.get('first'), 'unmount', () => attemptAll('callout (root)')),
  },
  'engine callout while unmounting (world-nodes stage)': {
    script: `world.add(kept.first); world.add(kept.last)`,
    host: ({ app, attemptAll }) =>
      calloutOn(
        [...app.worldNodes].find(node => node.id === 'first'),
        'unmount',
        () => attemptAll('callout (world)')
      ),
  },
  'world listener reached from an engine callout (app.emit)': {
    script: `world.on('sweep-relay', () => attemptAll('relayed listener')); app.state.relay = () => app.emit('sweep-relay', 1)`,
    host: ({ app, state }) => calloutOn(app.root.get('first'), 'unmount', () => state.relay()),
  },
  // eviction: the lookup in the leave listener evicts and cleans the kept handle
  'leave listener after eviction': {
    script: `world.on('leave', ({ playerId }) => { if (playerId !== 'p1') return; world.getPlayer(playerId); attemptAll('leave') })`,
    trigger: ({ world, player }) => {
      world.livekit.clearModifiers?.('p1')
      player.destroyed = true
      world.events.emit('leave', { playerId: 'p1' })
    },
  },
  // another app replaces the kept effect (the real PlayerRemote ends it first: its onEnd runs)
  'effect replaced by another app': {
    script: `kept.player.applyEffect({ freeze: true, duration: 60, onEnd: () => attemptAll('replaced') })`,
    trigger: ({ player }) => player.setEffect({ freeze: true }, null),
  },
  // the app's own lookup evicts the kept handle (its player left and came back): the cleanup runs its effect's onEnd
  'handle eviction (own lookup)': {
    script: `kept.player.applyEffect({ freeze: true, duration: 60, onEnd: () => attemptAll('evicted') }); app.state.lookup = () => world.getPlayer('p1')`,
    trigger: ({ world, player, state, makePlayer }) => {
      player.destroyed = true
      world.entities.players.set('p1', makePlayer('p1'))
      state.lookup()
    },
  },
}

const PLAYER_KINDS = [
  ['getPlayer', STOPPED],
  ['getPlayers', STOPPED],
  ['fresh handle: applyEffect', STOPPED],
  ['fresh handle: setVoiceLevel', STOPPED],
  ['kept handle: applyEffect', STOPPED],
  ['kept handle: setVoiceLevel', STOPPED],
]
const NODE_KINDS = [
  ['world.add', STOPPED],
  ['world.add (video)', STOPPED],
  ['world.attach', STOPPED],
  ['app.add', STOPPED],
  ['kept node: add', STOPPED],
  ['kept node: active false -> true', STOPPED],
  ['kept mesh: rebuild (linked, clean)', STOPPED],
  ['kept audio: play', STOPPED],
  ['kept skinned mesh: play', STOPPED],
]
// what each point must refuse, with the documented error (what it may still do is released by a later stage)
const REFUSED = {
  'destroy event': [['app.control', STOPPED]],
  'control onRelease': [['app.control', STOPPED]],
  'effect onEnd': [['app.control', STOPPED], ...PLAYER_KINDS],
  'engine callout while unmounting (root stage)': [['app.control', STOPPED], ...PLAYER_KINDS, ...NODE_KINDS],
  'engine callout while unmounting (world-nodes stage)': [['app.control', STOPPED], ...PLAYER_KINDS, ...NODE_KINDS],
  'world listener reached from an engine callout (app.emit)': [
    ['app.control', STOPPED],
    ...PLAYER_KINDS,
    ...NODE_KINDS,
  ],
  'leave listener after eviction': [
    ['getPlayer', 'no handle'],
    ['kept handle: applyEffect', LEFT],
    ['kept handle: setVoiceLevel', LEFT],
  ],
  'effect replaced by another app': [],
  'handle eviction (own lookup)': [
    ['kept handle: applyEffect', LEFT],
    ['kept handle: setVoiceLevel', LEFT],
  ],
}
const ALLOWED = {
  'destroy event': ['getPlayer', 'getPlayers'],
  'control onRelease': ['getPlayer'],
  'leave listener after eviction': ['getPlayers'],
  'effect replaced by another app': ['app.control', 'world.add', 'getPlayer'],
}
// after teardown a kept handle refuses with the stopped error, except these, which answer and change nothing (the
// footprint shows it): a released control, a fetch of an ended run (it stays pending)
const NO_OPS = ['kept control: hideReticle', 'kept control: pointer.lock', 'kept control: setActions', 'fetch']

function scriptFor(point, isServer, extra = '') {
  const attempts = attemptsFor(isServer)
    .map(([name, code]) => `[${JSON.stringify(name)}, () => { ${code} }]`)
    .join(',\n')
  return `
    ${PRELUDE}
    ${isServer ? `kept.player.setVoiceLevel('spatial')` : ''}
    kept.control = app.control(${POINTS[point]?.control || ''})
    const ATTEMPTS = [${attempts}]
    function attemptAll(label) {
      for (const [name, attempt] of ATTEMPTS) {
        try {
          attempt()
          log.push(label + ' | ' + name + ' | ok')
        } catch (err) {
          log.push(label + ' | ' + name + ' | ' + err.message)
        }
      }
    }
    app.state.attemptAll = attemptAll
    ${POINTS[point]?.script || ''}
    ${extra}
  `
}

for (const point of Object.keys(POINTS)) {
  for (const ending of ENDINGS) {
    for (const isServer of ENVS) {
      test(`teardown sweep: ${point} x every allocating API; ${ending}; ${side(isServer)}`, async () => {
        requests.length = 0
        const env = sweep.makeWorld({ isServer })
        const { world } = env
        const app = sweep.addApp(world, scriptFor(point, isServer))
        await sweep.tick()
        assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
        const state = app.data.state
        const { log, fired, urls, attemptAll } = state
        POINTS[point].host?.({ ...env, app, state, attemptAll })
        POINTS[point].trigger?.({ ...env, app, state })
        const ended = await sweep.end(world, app, ending)
        assert.ok(log.length > 0, `script code ran at the callback point (${point})`)
        const label = log[0].split(' | ')[0]
        const outcome = name => log.find(entry => entry.startsWith(`${label} | ${name} | `))?.split(' | ')[2]
        for (const [name, message] of REFUSED[point]) {
          if (!attemptsFor(isServer).some(([attempt]) => attempt === name)) continue
          assert.equal(outcome(name), message, `${name} at ${point}\n${log.join('\n')}`)
        }
        for (const name of ALLOWED[point] || []) assert.equal(outcome(name), 'ok', `${name} at ${point}`)
        assert.deepEqual(
          sweep.footprint(env, app, { ...ended, urls }),
          sweep.CLEAN,
          `nothing remains\n${log.join('\n')}`
        )
        // the handles the run kept change nothing any more
        const colors = [...world.stage.linkedMaterials.values()].map(entry => entry.raw.color.getHex())
        const locks = env.lock.request
        const tried = log.length
        attemptAll('after teardown')
        await sweep.tick(20)
        for (const line of log.slice(tried)) {
          const [, name, result] = line.split(' | ')
          if (NO_OPS.includes(name)) continue
          assert.equal(result, STOPPED, `a kept handle refuses after teardown: ${line}`)
        }
        assert.deepEqual(sweep.footprint(env, app, { ...ended, urls }), sweep.CLEAN, 'kept handles changed nothing')
        assert.equal(env.lock.request, locks, 'no lock requested through a kept control')
        assert.deepEqual(
          [...world.stage.linkedMaterials.values()].map(entry => entry.raw.color.getHex()),
          colors,
          'a kept material changes nothing'
        )
        assert.deepEqual([...fired], [], 'no timer or listener of the run fired')
      })
    }
  }
}

// ---- axis 2: callback points x retirement ---------------------------------------------------------------------------

// from inside each point the app is retired (removed or rebuilt) while an engine operation is running; that
// operation finishes, and nothing of the run may remain
const RETIRE_POINTS = {
  'destroy event': { script: `app.on('destroy', retire)` },
  'control onRelease': { control: `{ onRelease: retire }` },
  'effect onEnd (teardown)': {
    script: `kept.player.applyEffect({ freeze: true, duration: 60, onEnd: retire })`,
  },
  'engine callout while unmounting (teardown)': {
    host: ({ app, world }) => calloutOn(app.root.get('first'), 'unmount', () => world.events.emit('retire', 1)),
  },
  // the review's finding 1: a commit that unmounts (and calls out) and then mounts again
  'engine callout inside a commit (live)': {
    script: `app.state.go = () => { kept.first.linked = false; kept.first.clean() }`,
    host: ({ app, world }) => calloutOn(app.root.get('first'), 'unmount', () => world.events.emit('retire', 1)),
    go: ({ state }) => state.go(),
  },
  // world.add and world.attach detach the node first (an unmount): the run is checked again before it is placed
  'engine callout while world.add detaches the node (live)': {
    script: `app.state.go = () => world.add(kept.first)`,
    host: ({ app, world }) => calloutOn(app.root.get('first'), 'unmount', () => world.events.emit('retire', 1)),
    go: ({ state }) => state.go(),
  },
  'engine callout while world.attach detaches the node (live)': {
    script: `app.state.go = () => world.attach(kept.first)`,
    host: ({ app, world }) => calloutOn(app.root.get('first'), 'unmount', () => world.events.emit('retire', 1)),
    go: ({ state }) => state.go(),
  },
  // an activation updates the node's transform before it is charged and mounted (the review's position getter)
  'engine callout in an activation before it mounts (live)': {
    script: `app.state.go = () => { kept.hidden.active = true }`,
    host: ({ app, world }) => {
      const holder = [...app.worldNodes].find(node => node.id === 'holder')
      const hidden = holder.children.find(node => node.id === 'hidden')
      calloutOn(hidden, 'updateTransform', () => world.events.emit('retire', 1))
    },
    go: ({ state }) => state.go(),
  },
  // world.add of a node whose mount calls out
  'engine callout inside an activation (live)': {
    script: `app.state.go = () => world.add(kept.last)`,
    host: ({ app, world }) => calloutOn(app.root.get('last'), 'mount', () => world.events.emit('retire', 1)),
    go: ({ state }) => state.go(),
  },
  // the review's finding 2 (effects): another app's effect, whose onEnd retires this app, is replaced by ours
  'effect replacement (live)': {
    script: `app.state.go = () => kept.player.applyEffect({ freeze: true, duration: 600 })`,
    host: ({ world, player }) => player.setEffect({ freeze: true }, () => world.events.emit('retire', 1)),
    go: ({ state }) => state.go(),
  },
  // the review's finding 2 (registry): the lookup evicts a handle whose effect's onEnd retires the app
  'handle eviction (live)': {
    script: `
      kept.player.applyEffect({ freeze: true, duration: 60, onEnd: retire })
      app.state.go = () => {
        const p = world.getPlayer('p1')
        p.setVoiceLevel('global')
        p.applyEffect({ freeze: true, duration: 600 })
      }`,
    host: ({ world, player, makePlayer }) => {
      player.destroyed = true
      world.entities.players.set('p1', makePlayer('p1'))
    },
    go: ({ state }) => state.go(),
  },
}

// the same, through world.getPlayers (a second player is listed after the one whose handle is evicted)
RETIRE_POINTS['handle eviction inside getPlayers (live)'] = {
  script: `
    kept.player.applyEffect({ freeze: true, duration: 60, onEnd: retire })
    app.state.go = () => {
      for (const p of world.getPlayers()) {
        p.setVoiceLevel('global')
        p.applyEffect({ freeze: true, duration: 600 })
      }
    }`,
  host: ({ world, player, makePlayer }) => {
    player.destroyed = true
    world.entities.players.set('p1', makePlayer('p1'))
    world.entities.players.set('p2', makePlayer('p2'))
  },
  go: ({ state }) => state.go(),
}

for (const point of Object.keys(RETIRE_POINTS)) {
  for (const ending of ENDINGS) {
    for (const isServer of ENVS) {
      test(`teardown sweep: retired from inside ${point}; ${ending}; ${side(isServer)}`, async () => {
        requests.length = 0
        const env = sweep.makeWorld({ isServer })
        const { world } = env
        const spec = RETIRE_POINTS[point]
        const app = sweep.addApp(
          world,
          `
          ${PRELUDE}
          ${isServer ? `kept.player.setVoiceLevel('spatial')` : ''}
          kept.control = app.control(${spec.control || ''})
          kept.control.hideReticle()
          ${spec.script || ''}
        `
        )
        await sweep.tick()
        assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
        const state = app.data.state
        const urls = state.urls
        const retired = sweep.onRetire(world, app, ending)
        spec.host?.({ ...env, app })
        let error = null
        try {
          spec.go?.({ ...env, app, state })
        } catch (err) {
          error = err
        }
        await sweep.tick(20)
        if (spec.go) assert.ok(retired.retired, 'the app was retired from inside the operation')
        if (error) assert.equal(error.message, STOPPED, 'the interrupted operation reports the stopped error')
        const ended = retired.retired
          ? { replacement: ending === 'removed' ? null : app.root, oldRoot: retired.oldRoot, oldRun: retired.oldRun }
          : await sweep.end(world, app, ending)
        retired.stop()
        assert.deepEqual(sweep.footprint(env, app, { ...ended, urls }), sweep.CLEAN)
      })
    }
  }
}

// ---- engine code reaching a node while it unmounts (live) -----------------------------------------------------------

// What a node's own unmount may reach in the engine while its app is alive (a commit of the rebuild it has pending, a
// node added under it) mounts nothing: one gate (Node.canMount) covers activate, clean and commit, and refuses a node
// that is unmounting or whose parent is. The node is deactivated by its script (active = false); the footprint is
// taken while the app still runs (only the app's own model and kept nodes are mounted), then after removal.
const UNMOUNT_CALLOUTS = {
  "clean() from the node's own unmount, with a rebuild pending": {
    script: `kept.first.linked = false`,
    host: ({ app }) => {
      const first = app.root.get('first')
      calloutOn(first, 'unmount', () => first.clean())
    },
  },
  "clean() at the end of the node's own unmount, with a rebuild pending": {
    script: `kept.first.linked = false`,
    host: ({ app }) => {
      const first = app.root.get('first')
      calloutOn(first, 'unmount', () => first.clean(), { after: true })
    },
  },
  'a node added under the node from its own unmount': {
    host: ({ app }) => {
      const first = app.root.get('first')
      const geometry = new m.THREE.BoxGeometry(1, 1, 1)
      const material = new m.THREE.MeshStandardMaterial()
      calloutOn(first, 'unmount', () =>
        first.add(m.createNode('mesh', { id: 'late', type: 'geometry', geometry, material, linked: false }))
      )
    },
  },
}

for (const point of Object.keys(UNMOUNT_CALLOUTS)) {
  for (const isServer of ENVS) {
    test(`teardown sweep: ${point} (live); ${side(isServer)}`, async () => {
      requests.length = 0
      const env = sweep.makeWorld({ isServer })
      const { world } = env
      const spec = UNMOUNT_CALLOUTS[point]
      const app = sweep.addApp(
        world,
        `
        ${PRELUDE}
        ${spec.script || ''}
        app.state.go = () => { kept.first.active = false }
      `
      )
      await sweep.tick()
      assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
      const state = app.data.state
      const first = app.root.get('first')
      const sceneMeshes = () =>
        world.stage.scene.children.filter(object => object.isMesh && !object.isInstancedMesh).length
      // (the kept video's mesh is in the scene on the client)
      const meshes = sceneMeshes()
      spec.host({ ...env, app })
      state.go()
      assert.equal(first.mounted, false, 'the node is unmounted')
      let stray = 0
      first.traverse(node => node.mounted && stray++)
      assert.equal(stray, 0, 'nothing mounted under (or as) the unmounted node')
      assert.equal(sceneMeshes(), meshes, 'no mesh of the node in the scene')
      const ended = await sweep.end(world, app, 'removed')
      assert.deepEqual(sweep.footprint(env, app, { ...ended, urls: state.urls }), sweep.CLEAN)
    })
  }
}

// ---- axis 3: arguments x retirement ------------------------------------------------------------------------------

// every handle method that takes arguments, given arguments whose reads retire the app (a getter, a toString, a
// valueOf, a Proxy trap); the call finishes (or refuses), and nothing of the run may remain. A row marked NOT_READ is a
// call that refuses or stores such an argument without running its code (here: the network stand-in does not encode
// what app.send is given), so the app is not retired at all
const NOT_READ = 'not read'
const ARGUMENTS = [
  ['app.control: an options getter', `app.control({ get onRelease() { retire(); return undefined } }).hideReticle()`],
  [
    'applyEffect: a nested value whose second read retires (the player reads the effect again)',
    `let reads = 0; kept.player.applyEffect({ duration: 600, emote: { get url() { if (++reads === 2) retire(); return 'x' } } })`,
    NOT_READ,
  ],
  [
    'lod.insert: a distance with a valueOf',
    `const lod = app.create('lod'); app.add(lod); lod.insert(app.create('group'), 1); lod.insert(app.create('group'), { valueOf() { retire(); return 2 } })`,
    NOT_READ,
  ],
  [
    'particles.shape: a parameter with a valueOf',
    `kept.particles.shape = ['sphere', { valueOf() { retire(); return 1 } }]`,
    NOT_READ,
  ],
  [
    'sky.rotationY: a boxed number whose valueOf retires',
    `const sky = app.create('sky'); app.add(sky); const n = new Number(1); n.valueOf = () => { retire(); return 1 }; sky.rotationY = n; sky.clean()`,
    NOT_READ,
  ],
  [
    'audio.volume: a Proxy posing as a number',
    `kept.audio.volume = new Proxy({}, { get: (t, k) => (k === Symbol.toStringTag ? 'Number' : k === Symbol.toPrimitive ? () => (retire(), 1) : undefined), has: () => true, set: () => true }); kept.audio.play()`,
    NOT_READ,
  ],
  ['app.off: a name with a toString', `app.off({ toString() { retire(); return 'update' } }, () => {})`],
  [
    'applyEffect: an options getter',
    `kept.player.applyEffect({ get freeze() { retire(); return true }, duration: 600 })`,
  ],
  [
    'setVoiceLevel: a level with a toString',
    `kept.player.setVoiceLevel({ toString() { retire(); return 'global' } })`,
    NOT_READ,
  ],
  ['app.on: a name with a toString', `app.on({ toString() { retire(); return 'late' } }, () => {})`],
  ['world.on: a name with a toString', `world.on({ toString() { retire(); return 'late' } }, () => {})`],
  ['fetch: a url with a toString', `fetch({ toString() { retire(); return 'https://example.invalid/' } })`],
  ['fetch: an options getter', `fetch('https://example.invalid/', { get method() { retire(); return 'GET' } })`],
  ['setTimeout: a delay with a valueOf', `setTimeout(() => {}, { valueOf() { retire(); return 0 } })`, NOT_READ],
  [
    'URL.createObjectURL: a Proxy for a blob',
    `urls.push(URL.createObjectURL(new Proxy(kept.blob, { get(t, k) { retire(); return t[k] } })))`,
    NOT_READ,
  ],
  [
    'world.add: a Proxy node handle',
    `world.add(new Proxy(app.create('group'), { getOwnPropertyDescriptor(t, k) { retire(); return Reflect.getOwnPropertyDescriptor(t, k) } }))`,
  ],
  [
    'node.add: a Proxy node handle',
    `kept.holder.add(new Proxy(app.create('group'), { getOwnPropertyDescriptor(t, k) { retire(); return Reflect.getOwnPropertyDescriptor(t, k) } }))`,
  ],
  [
    'world.attach: a Proxy node handle',
    `world.attach(new Proxy(kept.attachable, { getOwnPropertyDescriptor(t, k) { retire(); return Reflect.getOwnPropertyDescriptor(t, k) } }))`,
  ],
  ['app.create + app.add: a data getter', `app.add(app.create('group', { get active() { retire(); return true } }))`],
  ['app.create + app.add: a type with a toString', `app.add(app.create({ toString() { retire(); return 'group' } }))`],
  [
    'app.create + app.add: a position array with an element getter',
    `app.add(app.create('group', { position: { length: 3, get 0() { retire(); return 1 }, 1: 0, 2: 0 } }))`,
  ],
  [
    'app.configure: a fields function that retires',
    `app.configure(() => { retire(); return [{ key: 'a', type: 'text', label: 'A' }] })`,
  ],
  [
    'app.configure: a field getter',
    `app.configure([{ get key() { retire(); return 'a' }, type: 'text', label: 'A' }])`,
  ],
  [
    'skinned mesh play: a clip name with a toString',
    `kept.skinned.play({ name: { toString() { retire(); return 'idle' } } })`,
  ],
  [
    'skinned mesh play: a fade with a valueOf',
    `kept.skinned.play({ name: 'idle', fade: { valueOf() { retire(); return 0.1 } } })`,
  ],
  [
    'world.load: a url with a toString',
    `world.load('model', { toString() { retire(); return 'loaded.glb' } }).then(root => app.add(root))`,
  ],
  [
    'particles.force: a vector getter (a setter that rebuilds)',
    `kept.particles.force = { isVector3: true, get x() { retire(); return 1 }, y: 0, z: 0 }`,
  ],
  [
    'control.setActions: an action getter',
    `kept.control.setActions([{ type: 'keyE', get label() { retire(); return 'x' } }])`,
  ],
  ['world.chat: a message with a toString', `world.chat({ toString() { retire(); return 'hi' } }, true)`, NOT_READ],
  ['app.send: data with a getter', `app.send('sweep-ping', { get x() { retire(); return 1 } })`, NOT_READ],
  [
    'node.position.set: components with a valueOf',
    `kept.holder.position.set({ valueOf() { retire(); return 1 } }, 0, 0); kept.holder.clean()`,
    NOT_READ,
  ],
  [
    'material.color: a value with a toString',
    `kept.material.color = { toString() { retire(); return 'red' } }`,
    NOT_READ,
  ],
]

for (const [label, code, reads] of ARGUMENTS) {
  for (const ending of ENDINGS) {
    for (const isServer of ENVS) {
      test(`teardown sweep: arguments that retire the app: ${label}; ${ending}; ${side(isServer)}`, async () => {
        requests.length = 0
        const env = sweep.makeWorld({ isServer })
        const { world } = env
        const app = sweep.addApp(
          world,
          `
          ${PRELUDE}
          kept.control = app.control()
          app.state.go = () => { ${code} }
        `
        )
        await sweep.tick()
        assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
        const { urls, go } = app.data.state
        const retired = sweep.onRetire(world, app, ending)
        try {
          go()
        } catch (err) {
          // a call the retirement interrupted refuses with the stopped error, or returns; one that refuses the
          // argument without reading it the way it was trapped (a type check) does not retire the app at all
          if (retired.retired) assert.equal(err?.message, STOPPED, err?.stack)
        }
        assert.equal(retired.retired, reads !== NOT_READ, reads === NOT_READ ? 'the argument is not read' : 'retired')
        await sweep.tick(20)
        const ended = retired.retired
          ? { replacement: ending === 'removed' ? null : app.root, oldRoot: retired.oldRoot, oldRun: retired.oldRun }
          : await sweep.end(world, app, ending)
        retired.stop()
        assert.deepEqual(sweep.footprint(env, app, { ...ended, urls }), sweep.CLEAN)
      })
    }
  }
}

// ---- axis 4: sealed engine math objects -----------------------------------------------------------------------------

const MATH = ['isVector3', 'isQuaternion', 'isEuler', 'isMatrix3', 'isMatrix4', 'isColor']
const isMath = value => value !== null && typeof value === 'object' && MATH.some(flag => value[flag] === true)

// every getter of a handle (and of the plain objects it returns, a level down) that returns the same math object on
// every read hands out a live engine object: it must be sealed, and a matrix's elements a typed array it cannot replace
function liveMath(handle, label, out, depth = 0) {
  for (const key of Reflect.ownKeys(handle)) {
    const desc = Reflect.getOwnPropertyDescriptor(handle, key)
    let first
    let second
    try {
      first = desc.get ? desc.get.call(handle) : desc.value
      second = desc.get ? desc.get.call(handle) : desc.value
    } catch {
      continue
    }
    if (first !== second || first === null || typeof first !== 'object') continue
    const name = `${label}.${String(key)}`
    if (isMath(first)) out.push([name, first])
    else if (depth < 1 && !Array.isArray(first) && Object.getPrototypeOf(first) === Object.prototype) {
      liveMath(first, name, out, depth + 1)
    }
  }
}

test('every engine math object a handle hands out by reference is sealed (and a matrix keeps typed elements)', async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const types = Object.keys(m.Nodes)
  const app = sweep.addApp(
    world,
    `
    const handles = (app.state.handles = {})
    for (const type of ${JSON.stringify(types)}) handles[type] = app.create(type)
    handles['mounted mesh'] = app.get('first')
    handles['mounted skinnedmesh'] = app.get('skinned')
    handles.app = app
    handles.player = world.getPlayer('p1')
    const control = app.control()
    for (const entry of ['camera', 'pointer', 'screen', 'xrLeftRayPose', 'xrRightGripPose', 'xrLeftStick', 'touchStick', 'scrollDelta', 'mouseLeft']) {
      handles['control.' + entry] = control[entry]
    }
    handles.bone = app.get('skinned').getBone('hip')
    handles.particles.force = new Vector3(0, 1, 0)
    handles.particles.velocityLinear = new Vector3(1, 0, 0)
    handles.particles.velocityOrbital = new Vector3(0, 0, 1)
    // (the app handle stands for its root: its transform is the root's)
    handles['app (root)'] = {}
    for (const key of ['position', 'quaternion', 'rotation', 'scale', 'matrixWorld']) handles['app (root)'][key] = app[key]
  `
  )
  await sweep.tick()
  assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
  const found = []
  for (const [label, handle] of Object.entries(app.data.state.handles)) {
    if (handle && typeof handle === 'object') liveMath(handle, label, found)
  }
  // (a floor for what the walk must reach, so a handle that stops being walked is noticed)
  const names = found.map(([name]) => name)
  for (const name of [
    'mesh.matrixWorld',
    'mounted mesh.position',
    'mounted mesh.parent.matrixWorld',
    'joint.axis',
    'joint.offset1',
    'ui.offset',
    'particles.force',
    'particles.velocityOrbital',
    'bone.position',
    'bone.quaternion',
    'bone.matrixWorld',
    'control.camera.position',
    'control.camera.rotation',
    'control.xrLeftRayPose.quaternion',
    'control.xrRightGripPose.position',
    'control.xrLeftStick.value',
    'control.touchStick.value',
    'app (root).position',
    'app (root).matrixWorld',
  ]) {
    assert.ok(names.includes(name), `the walk reaches ${name}`)
  }
  for (const name of ['player.position', 'player.quaternion']) assert.ok(!names.includes(name), `${name} is a copy`)
  const unsealed = found.filter(([, value]) => !Object.isSealed(value)).map(([name]) => name)
  assert.deepEqual(unsealed, [], 'sealed')
  for (const [name, value] of found) {
    if (!value.isMatrix4 && !value.isMatrix3) continue
    assert.ok(ArrayBuffer.isView(value.elements), `${name}.elements is typed`)
    assert.equal(Object.getOwnPropertyDescriptor(value, 'elements').writable, false, `${name}.elements is fixed`)
  }
  // what a script can no longer do to them (inside a compartment, strict mode)
  const result = scripts
    .evaluate(
      `'use strict'
      const node = app.get('first')
      const out = []
      for (const attack of [
        () => Object.defineProperty(node.matrixWorld, 'elements', { get() { return [] } }),
        () => Object.defineProperty(node.matrixWorld.elements, '13', { get() { return 0 } }),
        () => { node.matrixWorld.elements = [] },
        () => Object.defineProperty(node.position, 'x', { get() { return 0 } }),
        () => { node.position.extra = 1 },
        () => Object.defineProperty(node.quaternion, '_x', { get() { return 0 } }),
      ]) {
        try { attack(); out.push('allowed') } catch (err) { out.push(err.name) }
      }
      node.position.x = { valueOf() { out.push('valueOf ran') ; return 5 } }
      out.push(Number.isNaN(node.position.x) ? 'stored NaN' : 'stored ' + typeof node.position.x)
      node.position.x = '2'
      out.push(typeof node.position.x)
      return out`
    )
    .exec(world.apps ? app.getWorldProxy() : null, app.getAppProxy())
  assert.deepEqual(result, [
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'TypeError',
    'stored NaN',
    'string',
  ])
  app.destroy()
})

// every setter of every node type, given an object that only poses as a primitive (a boxed primitive, whose valueOf a
// script can replace, or a Proxy whose Symbol.toStringTag says Number, String or Boolean): the node never keeps it (it
// would be converted later by host code, in the middle of a mount, a commit or another app's frame). An array a node
// hands back is frozen (or a new copy on every read), so nothing can be put into the node's own afterwards either.
test('node setters keep plain values only: no boxed primitive or look-alike Proxy is stored', async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const types = Object.keys(m.Nodes)
  const app = sweep.addApp(
    world,
    `
    const kept = (app.state.kept = [])
    const arrays = (app.state.arrays = [])
    const tagged = tag =>
      new Proxy({}, {
        get: (target, key) => (key === Symbol.toStringTag ? tag : undefined),
        has: (target, key) => key === Symbol.toStringTag,
        set: () => true,
      })
    const fakes = () => [new Number(1), new String('red'), new Boolean(true), tagged('Number'), tagged('String'), tagged('Boolean')]
    const base = new Set(Object.getOwnPropertyNames(app.create('group')))
    for (const type of ${JSON.stringify(types)}) {
      let node
      try { node = app.create(type) } catch { continue }
      for (const key of Object.getOwnPropertyNames(node)) {
        if (base.has(key) && type !== 'group') continue
        const desc = Object.getOwnPropertyDescriptor(node, key)
        // (callbacks take functions, which the engine calls with Reflect.apply: a non-callable object only throws)
        if (!desc.set || /^on[A-Z]/.test(key)) continue
        for (const fake of fakes()) {
          try { node[key] = fake } catch { continue }
          let read
          try { read = node[key] } catch { continue }
          if (read === fake) kept.push(type + '.' + key)
        }
        // arrays: every array a setter takes (an edge, a shape, a spritesheet, a size) is tried, then with each entry
        // replaced by a fake; what the node keeps is frozen or read back as a copy, and never holds a fake
        const samples = [[1, 1, 1, 1], ['sphere', 1, 1], [2, 2, 2, true], [1, 1, 1]]
        for (const sample of samples) {
          try { node[key] = sample } catch { continue }
          let value
          try { value = node[key] } catch { continue }
          if (!Array.isArray(value)) continue
          // (frozen, or a new copy on every read)
          if (!Object.isFrozen(value) && value === node[key]) arrays.push(type + '.' + key)
          for (let i = 0; i < sample.length; i++) {
            for (const fake of fakes()) {
              const next = [...sample]
              next[i] = fake
              try { node[key] = next } catch { continue }
              let read
              try { read = node[key] } catch { continue }
              if (Array.isArray(read) && read.includes(fake)) kept.push(type + '.' + key + '[' + i + ']')
            }
          }
        }
      }
    }
  `
  )
  await sweep.tick()
  assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
  assert.deepEqual([...new Set(app.data.state.kept)], [], 'no setter kept an object posing as a primitive')
  assert.deepEqual([...new Set(app.data.state.arrays)], [], 'every array a node hands back is frozen or a copy')
  app.destroy()
})

// ---- reproductions from the review that are not a row above -------------------------------------------------------

test('queued transitions: an older deferred build never supersedes a newer one (review finding 4, A)', async () => {
  const env = sweep.makeWorld({ isServer: false, models: url => m.createNode('group', { id: String(url) }) })
  const { world } = env
  const app = sweep.addApp(world, `app.on('destroy', () => app.emit('reenter', 1))`)
  await sweep.tick()
  let once = false
  world.events.on('reenter', () => {
    if (once) return
    once = true
    app.build(true) // deferred: a crash build asked for during the teardown
  })
  app.unbuild()
  // a newer blueprint, published right after the teardown returned (its model and script are cached)
  world.scripts['new.js'] = ''
  world.blueprints.modify({ id: app.data.blueprint, version: 1, script: 'new.js', model: 'new.glb' })
  await sweep.tick(20)
  assert.equal(app.root.id, 'new.glb', 'the newer build stays: the older deferred one was superseded')
  app.destroy()
})

test("queued transitions: a failing older build does not clear a newer one's state (review finding 4, B)", async () => {
  const env = sweep.makeWorld({ isServer: false, models: () => m.createNode('group') })
  const { world } = env
  const app = sweep.addApp(world, `app.on('destroy', () => app.emit('reenter', 1))`)
  await sweep.tick()
  let rejectCrash
  const pending = new Promise(() => {})
  world.loaderOverride = {
    model: url =>
      String(url).includes('crash-block') || url === 'slow.glb' ? null : { toNodes: () => m.createNode('group') },
  }
  world.loaderLoad = (type, url) =>
    String(url).includes('crash-block') ? new Promise((_resolve, reject) => (rejectCrash = reject)) : pending
  let once = false
  world.events.on('reenter', () => {
    if (once) return
    once = true
    app.build(true)
  })
  app.unbuild()
  await sweep.tick() // the deferred crash build now waits on the crash block
  world.blueprints.modify({ id: app.data.blueprint, version: 1, model: 'slow.glb' }) // a newer build waits on its model
  await sweep.tick()
  assert.equal(app.building, true)
  assert.ok(rejectCrash, 'the deferred crash build waits on the crash block')
  rejectCrash(new Error('crash block unavailable'))
  await sweep.tick(20)
  assert.equal(app.building, true, 'the newer build is still building')
  world.loaderOverride = null
  app.destroy()
})

for (const settle of ['rejects', 'never settles']) {
  test(`a crash retires the run at once, whatever the crash block does (it ${settle}) (review finding 5)`, async () => {
    requests.length = 0
    const env = sweep.makeWorld({ isServer: true })
    const { world } = env
    const app = sweep.addApp(
      world,
      `
      ${PRELUDE}
      kept.control = app.control()
      kept.control.hideReticle()
      kept.player.setVoiceLevel('global')
      app.on('update', () => {})
      world.on('enter', () => {})
      fetch('https://example.invalid/')
      app.state.mint = () => urls.push(URL.createObjectURL(kept.blob))
    `
    )
    await sweep.tick()
    app.data.state.mint()
    const urls = app.data.state.urls
    world.loaderOverride = { model: url => (String(url).includes('crash-block') ? null : undefined) }
    world.loaderLoad = () =>
      settle === 'rejects' ? Promise.reject(new Error('no crash block')) : new Promise(() => {})
    const run = app.deadHook
    const quiet = console.error
    app.crash()
    await sweep.tick(20)
    assert.equal(run.dead, true)
    assert.deepEqual(sweep.footprint(env, app, { urls }), sweep.CLEAN, 'nothing of the crashed run remains')
    assert.equal(console.error, quiet)
    world.loaderOverride = null
    app.destroy()
  })
}

test('world.load trees, model descendants under an inactive node and unplaced nodes belong to the run (review finding 6)', async () => {
  const env = sweep.makeWorld({
    isServer: false,
    models: url => {
      const root = m.createNode('group')
      const dormant = m.createNode('group', { id: 'dormant', active: false })
      dormant.add(m.createNode('group', { id: 'below' }))
      root.add(dormant)
      if (String(url) === 'loaded.glb') root.add(m.createNode('group', { id: 'child' }))
      return root
    },
  })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    const kept = (app.state.kept = {})
    kept.below = app.get('below')
    // (and a node the run made and never placed anywhere)
    kept.made = app.create('group')
    world.load('model', 'loaded.glb').then(root => {
      kept.loaded = root
      kept.child = root.get('child')
      kept.clone = root.clone(true)
    })
  `
  )
  await sweep.tick()
  const kept = app.data.state.kept
  assert.ok(kept.loaded && kept.child && kept.clone && kept.below && kept.made)
  app.destroy()
  for (const [name, handle] of Object.entries(kept)) {
    assert.throws(() => (handle.active = false), /this app has stopped/, `${name}.active`)
    assert.throws(() => handle.clone(), /this app has stopped/, `${name}.clone()`)
  }
})

test('node handle setters: an inheriting object works, a copied or bare setter is refused; methods keep their name and arity (review finding 7)', async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    const node = app.create('group')
    app.add(node)
    const out = (app.state.out = [])
    Object.create(node).active = false
    out.push(node.active === false ? 'inherited ok' : 'inherited missed')
    for (const [label, attempt] of [
      ['copied', () => { const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(node)); copy.active = true }],
      ['bare', () => { const { set } = Object.getOwnPropertyDescriptor(node, 'active'); set(true) }],
    ]) {
      try { attempt(); out.push(label + ' allowed') } catch (err) { out.push(label + ': ' + err.message) }
    }
    const mesh = app.create('mesh')
    out.push(mesh.add.name + '/' + mesh.add.length, mesh.getWorldMatrix.name + '/' + mesh.getWorldMatrix.length)
  `
  )
  await sweep.tick()
  assert.deepEqual(
    [...app.data.state.out],
    ['inherited ok', 'copied: [node] not a node', 'bare: [node] not a node', 'add/1', 'getWorldMatrix/1']
  )
  app.destroy()
})

test('a voice level the voice system refuses keeps the current modifier tracked, so it ends with the run', async () => {
  const env = sweep.makeWorld({ isServer: true })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    const player = world.getPlayer('p1')
    player.setVoiceLevel('spatial')
    player.setVoiceLevel('no such level')
  `
  )
  await sweep.tick()
  assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
  assert.equal(sweep.footprint(env, app).voiceModifiers, 1)
  app.destroy()
  assert.equal(sweep.footprint(env, app).voiceModifiers, 0, 'the modifier ended with the run')
})

test("a node made by a call whose arguments ended the run is not the next run's", async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    // (a type whose toString ends the run: no option is applied through the new node's handle afterwards, which would
    // refuse on its own)
    app.state.make = () => app.create({ toString() { app.emit('retire', 1); return 'group' } })
  `
  )
  await sweep.tick()
  const { make } = app.data.state
  const retired = sweep.onRetire(world, app, 'rebuilt into an empty script')
  assert.throws(() => make(), { message: STOPPED })
  retired.stop()
  await sweep.tick(20)
  app.destroy()
})

test('instance matrices: a read nested inside another keeps its own values (review finding 3)', () => {
  // Node matrices are sealed, so no script can run code inside a read any more; this drives the Stage with host
  // matrices whose entries are accessors, which is what such a read would look like
  const { world } = sweep.makeWorld({ isServer: false })
  const stage = world.stage
  const geometry = new m.THREE.BoxGeometry(1, 1, 1)
  const material = new m.THREE.MeshStandardMaterial()
  const at = x => new m.THREE.Matrix4().makeTranslation(x, 0, 0)
  const insert = matrix =>
    stage.insertLinked({ geometry, material, castShadow: true, receiveShadow: true, node: {}, matrix })
  const a = insert(at(1))
  const firstMatrix = at(10)
  const first = insert(firstMatrix)
  const lastMatrix = at(20)
  insert(lastMatrix)
  let armed = false
  const entries = lastMatrix.elements
  lastMatrix.elements = new Proxy(entries, {
    get(target, key) {
      if (armed && key === '13') {
        armed = false
        firstMatrix.elements[12] = 77
        first.move(firstMatrix)
      }
      return target[key]
    },
  })
  armed = true
  // taking `a` out moves `last` into its slot: reading last's matrix moves `first` meanwhile
  a.destroy()
  assert.equal(armed, false, 'the nested read ran')
  const model = [...stage.models.values()][0]
  const x = matrix => {
    const idx = model.items.findIndex(item => item.matrix === matrix)
    return model.iMesh.instanceMatrix.array[idx * 16 + 12]
  }
  assert.equal(x(lastMatrix), 20, "last's slot keeps last's values")
  assert.equal(x(firstMatrix), 77, "first's slot has first's new values")
})

test('app.off converts its name as app.on does (the update registration follows)', async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    const update = () => {}
    app.on('update', update)
    app.off({ toString: () => 'update' }, update)
  `
  )
  await sweep.tick()
  assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
  assert.equal(world.hot.has(app), false, 'no update registration is left')
  app.destroy()
})

for (const isServer of ENVS) {
  test(`a node that is not mounted does not play or animate, also one unmounted while its sound loads; ${side(isServer)}`, async () => {
    const env = sweep.makeWorld({ isServer })
    const { world } = env
    let loaded
    world.loaderOverride = { audio: url => (String(url).includes('slow') ? null : { duration: 1 }) }
    world.loaderLoad = (type, url) =>
      type === 'audio' ? new Promise(resolve => (loaded = resolve)) : Promise.reject(new Error(`no ${type} ${url}`))
    const app = sweep.addApp(
      world,
      `
      const sound = src => app.create('audio', { src, loop: true, spatial: false })
      sound('asset://tone.mp3').play()
      const off = sound('asset://tone.mp3')
      app.add(off)
      off.active = false
      off.play()
      const skinned = app.get('skinned')
      skinned.active = false
      skinned.play({ name: 'idle' })
      const slow = sound('asset://slow.mp3')
      app.add(slow)
      slow.play()
      app.state.unmountSlow = () => { slow.active = false }
    `
    )
    await sweep.tick()
    assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
    assert.ok(loaded, 'the slow sound waits on its load')
    app.data.state.unmountSlow()
    loaded({ duration: 1 })
    await sweep.tick()
    const live = sweep.footprint(env, app)
    assert.equal(live.playingSounds, 0, 'no sound plays')
    assert.equal(live.audioOutputs, 0, 'nothing feeds an output')
    assert.equal(live.hot, 0, 'nothing animates')
    world.loaderOverride = null
    const ended = await sweep.end(world, app, 'removed')
    assert.deepEqual(sweep.footprint(env, app, ended), sweep.CLEAN)
  })
}

test('a removal asked for during a rebuild waits for it, then removes the app (nothing of either run remains)', async () => {
  requests.length = 0
  const env = sweep.makeWorld({ isServer: true })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    ${PRELUDE}
    kept.control = app.control()
    kept.control.hideReticle()
    kept.player.setVoiceLevel('global')
    app.on('destroy', retire)
  `
  )
  await sweep.tick()
  const { urls } = app.data.state
  const retired = sweep.onRetire(world, app, 'removed')
  sweep.retireNow(world, app, 'rebuilt into an empty script')
  await sweep.tick(20)
  retired.stop()
  assert.ok(retired.retired, 'the destroy listener asked for the removal')
  assert.equal(app.destroyed, true, 'the app was removed once the rebuild had torn its run down')
  assert.deepEqual(sweep.footprint(env, app, { urls }), sweep.CLEAN)
})

test("a teardown asked for again from inside the app's teardown does not run twice", async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    app.state.destroyed = 0
    app.on('destroy', () => {
      app.state.destroyed++
      app.emit('reenter', 1)
    })
  `
  )
  await sweep.tick()
  const state = app.data.state
  const reenter = () => app.unbuild()
  world.events.on('reenter', reenter)
  app.destroy()
  world.events.off('reenter', reenter)
  assert.equal(state.destroyed, 1, 'the destroy listeners ran once')
  assert.deepEqual(sweep.footprint(env, app), sweep.CLEAN)
})

// the Stage, driven with host matrices whose entries are accessors (what a read that runs code would look like)
function stageWithThree() {
  const { world } = sweep.makeWorld({ isServer: false })
  const stage = world.stage
  const geometry = new m.THREE.BoxGeometry(1, 1, 1)
  const material = new m.THREE.MeshStandardMaterial()
  const at = x => new m.THREE.Matrix4().makeTranslation(x, 0, 0)
  const insert = matrix =>
    stage.insertLinked({ geometry, material, castShadow: true, receiveShadow: true, node: {}, matrix })
  const matrices = [at(1), at(10), at(20)]
  const handles = matrices.map(insert)
  handles.world = world
  const model = [...stage.models.values()][0]
  const x = matrix => {
    const idx = model.items.findIndex(item => item.matrix === matrix)
    return idx === -1 ? undefined : model.iMesh.instanceMatrix.array[idx * 16 + 12]
  }
  return { matrices, handles, model, x }
}

test('instance matrices: an instance taken out while its own values are read is not written back (review 6)', () => {
  const { matrices, handles, x } = stageWithThree()
  const [, first, last] = matrices
  let armed = false
  const entries = last.elements
  last.elements = new Proxy(entries, {
    get(target, key) {
      if (armed && key === '13') {
        armed = false
        handles[2].destroy()
      }
      return target[key]
    },
  })
  armed = true
  // taking the first instance out moves `last` into its slot; reading it takes `last` out, which moves `first` there
  handles[0].destroy()
  assert.equal(armed, false, 'the nested removal ran')
  assert.equal(x(last), undefined, 'last is gone')
  assert.equal(x(first), 10, "the slot shows first's values, not the removed instance's")
})

test('instance matrices: an instance taken out leaves the octree even when reading the moved one throws', () => {
  const { matrices, handles } = stageWithThree()
  const last = matrices[2]
  const entries = last.elements
  last.elements = new Proxy(entries, {
    get(target, key) {
      if (key === '13') throw new Error('unreadable')
      return target[key]
    },
  })
  assert.throws(() => handles[0].destroy(), /unreadable/)
  last.elements = entries
  handles[1].destroy()
  handles[2].destroy()
  assert.equal(sweep.octreeItems(handles.world.stage.octree.root), 0, 'no octree entry is left')
})

test("instance matrices: a matrix's own toArray is never handed the shared buffer (review 6)", () => {
  const { matrices, handles, x } = stageWithThree()
  const last = matrices[2]
  let called = false
  last.toArray = (array, offset = 0) => {
    called = true
    array.fill(99, offset, offset + 16)
    return array
  }
  handles[0].destroy()
  assert.equal(called, false, 'the class method reads the values')
  assert.equal(x(last), 20)
})

test('getPlayers is refused at the player stage even when nobody is in the world (review finding 8)', async () => {
  const env = sweep.makeWorld({ isServer: false })
  const { world } = env
  const app = sweep.addApp(
    world,
    `
    const out = (app.state.out = [])
    app.state.ask = () => {
      try { out.push(world.getPlayers().length) } catch (err) { out.push(err.message) }
    }
  `
  )
  await sweep.tick()
  world.entities.players.clear()
  calloutOn(app.root.get('first'), 'unmount', () => app.data.state.ask())
  app.destroy()
  assert.deepEqual([...app.data.state.out], [STOPPED])
})

test('the footprint sees a node registry a teardown leaves behind (review finding 9: a broken anchor unmount)', async () => {
  const env = sweep.makeWorld({ isServer: false, models: () => m.createNode('group') })
  const { world } = env
  const app = sweep.addApp(world, `app.add(app.create('anchor'))`)
  await sweep.tick()
  assert.equal(world.anchors.matrices.size, 1)
  const anchor = app.root.children.find(node => node.name === 'anchor')
  anchor.unmount = () => {}
  app.destroy()
  assert.equal(sweep.footprint(env, app).anchors, 1, 'the leftover is measured')
  world.anchors.matrices.clear()
})
