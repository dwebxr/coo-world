import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// a browser-like global before anything is bundled or locked down: UI nodes only build their canvas in a browser
// (window), and screen-space UIs put it in the pointer layer
globalThis.window = {
  location: { href: 'http://localhost/', search: '' },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
}

// the real lockdown config (ses must be imported first, as in src/server/index.js)
import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'
import { calloutOn, createSweep } from './lib/sweepWorld.mjs'

// The node-type axis of the teardown sweep (teardownSweep.test.js has the others): every node type that can mount in
// this harness, with real content (a geometry, a played sound source, a video source, a mounted and playing skinned
// mesh, a canvas, a registry entry), placed under the app's root or in world space. While the run lives, the
// footprint must show what the node holds (so the footprint can see it); after the app is removed or rebuilt, alone or
// with a second retirement from inside the node's own unmount, nothing may remain.
// Not here (they cannot mount without PhysX, a VRM factory or a browser): collider, rigidbody, controller, joint,
// avatar; the e2e suites (physics-boundary, hostile-transforms, fullstack) mount those.
let bundle
let m
let scripts
let sweep
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
    export { getNodeRef } from './src/core/nodes/refs'
    export * as Nodes from './src/core/nodes'
    export * as THREE from './src/core/extras/three'
    export { Object3D } from 'three'
  `)
  m = await import(bundle.url)
  scripts = new m.Scripts({})
  sweep = createSweep({ m, scripts, requests })
})
after(() => {
  globalThis.document = realDocument
  delete globalThis.window
  bundle?.destroy()
})

// `code` makes the node (or `node` picks it from the model); `then` runs after it is placed; `holds` is what the
// footprint must show while the run lives, per side
const TYPES = {
  'mesh (model geometry, linked)': { node: `app.get('first')`, model: true, holds: ['linkedInstances', 'octreeItems'] },
  'mesh (model geometry, unlinked)': {
    node: `app.get('first')`,
    then: `node.linked = false; node.clean()`,
    model: true,
    holds: ['sceneMeshes', 'octreeItems'],
  },
  'skinned mesh (model, playing)': {
    node: `app.get('skinned')`,
    then: `node.play({ name: 'idle' })`,
    model: true,
    holds: ['hot'],
  },
  'audio (source, playing)': {
    code: `app.create('audio', { src: 'asset://tone.mp3', loop: true, spatial: false })`,
    then: `node.play()`,
    holds: ['playingSounds'],
  },
  'audio (source, waiting for the audio unlock)': {
    code: `app.create('audio', { src: 'asset://tone.mp3', loop: true, spatial: true })`,
    then: `node.play()`,
    // nobody has clicked the page yet: the start waits
    setup: world => (world.audio.locked = []),
    holds: ['audioOutputs'],
  },
  'video (source)': {
    code: `app.create('video', { src: 'asset://clip.mp4', width: 1, height: 1 })`,
    holds: { client: ['videoInstances', 'octreeItems'], server: [] },
  },
  'image (source)': { code: `app.create('image', { src: 'asset://pic.png', width: 1, height: 1 })`, holds: [] },
  anchor: { code: `app.create('anchor')`, holds: ['anchors'] },
  'lod (with a mesh)': {
    code: `(() => { const lod = app.create('lod'); lod.insert(app.create('mesh', { type: 'box' }), 10); return lod })()`,
    holds: ['lods'],
  },
  snap: { code: `app.create('snap')`, holds: ['snaps'] },
  action: { code: `app.create('action', { label: 'Use' })`, holds: ['actions'] },
  nametag: { code: `app.create('nametag', { label: 'Hi' })`, holds: ['nametags'] },
  particles: { code: `app.create('particles')`, holds: ['particles'] },
  sky: { code: `app.create('sky')`, holds: ['skies'] },
  'prim (box)': { code: `app.create('prim', { type: 'box' })`, holds: [] },
  'ui (world space, pointer events)': {
    code: `app.create('ui', { pointerEvents: true })`,
    holds: { client: ['hot', 'sceneMeshes', 'octreeItems'], server: [] },
  },
  'ui (screen space)': {
    code: `app.create('ui', { space: 'screen', pointerEvents: true })`,
    holds: { client: ['uiCanvases'], server: [] },
  },
  'ui with a view, a text and an image': {
    code: `(() => {
      const ui = app.create('ui')
      const view = app.create('uiview')
      view.add(app.create('uitext', { value: 'x' }))
      view.add(app.create('uiimage', { src: 'asset://pic.png' }))
      ui.add(view)
      return ui
    })()`,
    holds: { client: ['hot', 'sceneMeshes'], server: [] },
    // (on the server a uitext under a ui does not mount: the ui has no layout node there)
    client: true,
  },
  group: { code: `app.create('group')`, holds: [] },
}

const ENDINGS = ['removed', 'rebuilt into an empty script']
const PLACES = ['under the app root', 'in world space']
const NESTED = ['', '; its unmount retires the app again']

const emptyModel = () => m.createNode('group')

for (const [type, spec] of Object.entries(TYPES)) {
  for (const place of PLACES) {
    for (const nested of NESTED) {
      for (const ending of ENDINGS) {
        for (const isServer of [false, true]) {
          if (spec.client && isServer) continue
          const side = isServer ? 'server' : 'client'
          test(`teardown sweep (node types): ${type} ${place}${nested}; ${ending}; ${side}`, async () => {
            requests.length = 0
            const env = sweep.makeWorld({ isServer, models: spec.model ? undefined : emptyModel })
            const { world } = env
            spec.setup?.(world)
            const app = sweep.addApp(
              world,
              `
              const node = (app.state.node = ${spec.node || spec.code})
              ${place === 'in world space' ? 'world.add(node)' : 'app.add(node)'}
              ${spec.then || ''}
            `
            )
            await sweep.tick()
            assert.equal(app.crashed, false, `the script ran: ${app.scriptError?.message}`)
            const node = m.getNodeRef(app.data.state.node)
            assert.ok(node?.mounted, 'the node is mounted')
            const live = sweep.footprint(env, app)
            const holds = Array.isArray(spec.holds) ? spec.holds : spec.holds[side]
            for (const key of holds) assert.ok(live[key] > 0, `the footprint shows the node's ${key} (${live[key]})`)
            const retired = sweep.onRetire(world, app, ending)
            if (nested) calloutOn(node, 'unmount', () => world.events.emit('retire', 1))
            // a teardown stage that fails is reported, and is a bug here (each stage still runs)
            const failures = []
            // (the console object is frozen by lockdown; the global binding is not, so it is swapped for the call)
            const realConsole = globalThis.console
            globalThis.console = {
              ...realConsole,
              error: (...args) => {
                if (args.some(arg => typeof arg === 'string' && /teardown \(/.test(arg))) failures.push(args.join(' '))
                return realConsole.error(...args)
              },
            }
            let ended
            try {
              ended = await sweep.end(world, app, ending)
            } finally {
              globalThis.console = realConsole
            }
            retired.stop()
            assert.deepEqual(failures, [], 'no teardown stage failed')
            if (nested) assert.ok(retired.retired, 'the app was retired again from inside the unmount')
            assert.equal(node.mounted, false, 'the node is unmounted')
            assert.deepEqual(sweep.footprint(env, app, ended), sweep.CLEAN)
          })
        }
      }
    }
  }
}
