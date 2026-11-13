// Small defects of the node classes and the particle worker that the golden characterization found (P17-F2; its
// "Found, not fixed"): each through the script's handle (the node's proxy, or `app.create` through the real Apps hook)
// where a script reaches it, and the particle worker in a worker thread with a fixed sequence of random numbers.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundleProbe, runProbe } from './lib/workerProbe.mjs'

let bundle
before(async () => {
  bundle = await bundleProbe(`
    import './src/client/particles'
    export { createNode } from './src/core/extras/createNode'
    export { Apps } from './src/core/systems/Apps'
    export * as THREE from './src/core/extras/three'
  `)
})
after(() => bundle?.destroy())

test('audio: before it is in a world, currentTime reads 0 and pause() and stop() do nothing (they threw)', () =>
  runProbe(bundle, async ({ createNode, Apps }) => {
    const apps = new Apps({ network: {}, events: {} })
    const made = []
    const app = { deadHook: { dead: false }, createNode: (type, data) => made[made.push(createNode(type, data)) - 1] }
    const direct = createNode('audio', { src: 'asset://a.mp3', spatial: false })
    const ways = [
      ['proxy', direct.getProxy(), direct],
      ['app.create', apps.appMethods.create(app, 'audio', { src: 'asset://a.mp3' }), made[0]],
    ]
    for (const [way, handle, node] of ways) {
      assert.equal(handle.currentTime, 0, way)
      assert.equal(handle.pause(), undefined, way)
      assert.equal(handle.stop(), undefined, way)
      assert.equal(handle.play(), undefined, way)
      assert.equal(handle.isPlaying, false, way)
      // a time set before it is placed is kept for the play that follows its mount, and reads as 0 meanwhile (as on
      // the server, which has no audio); pause() and stop() leave it
      handle.currentTime = 5
      assert.equal(handle.currentTime, 0, way)
      handle.pause()
      handle.stop()
      assert.equal(handle.currentTime, 0, way)
      assert.equal(node.offset, 5, way)
    }
    // the class, as the engine calls it
    const node = createNode('audio')
    node.currentTime = 2
    node.pause()
    node.stop()
    assert.equal(node.currentTime, 0)
    assert.equal(node.offset, 2)
    // placed in a world with audio (a stand-in), the node plays from the time it was given before
    const started = []
    const output = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} })
    const world = {
      audio: {
        ctx: {
          currentTime: 0,
          createGain: output,
          createBufferSource: () => ({ ...output(), start: (when, offset) => started.push(offset), stop() {} }),
        },
        groupGains: { music: {}, sfx: {} },
        lastDelta: 0,
        ready: fn => fn(),
      },
      loader: { get: () => ({ duration: 10 }) },
    }
    direct.ctx = { world, entity: {} }
    direct.mounted = true
    assert.equal(direct.currentTime, 5)
    await direct.play()
    assert.deepEqual(started, [5])
  }))

test('rigidbody: linearDamping and angularDamping read back through the handle (they read undefined)', () =>
  runProbe(bundle, ({ createNode, Apps }) => {
    const apps = new Apps({ network: {}, events: {} })
    const app = { deadHook: { dead: false }, createNode: (type, data) => createNode(type, data) }
    const proxy = createNode('rigidbody').getProxy()
    assert.equal(proxy.linearDamping, 0, 'the default')
    assert.equal(proxy.angularDamping, 0.05, 'the default')
    proxy.linearDamping = 2
    proxy.angularDamping = 3
    assert.equal(proxy.linearDamping, 2)
    assert.equal(proxy.angularDamping, 3)
    // a refused value leaves what was kept
    assert.throws(() => (proxy.linearDamping = -1), /linearDamping cannot be less than zero/)
    assert.equal(proxy.linearDamping, 2)
    const created = apps.appMethods.create(app, 'rigidbody', { linearDamping: 0.5, angularDamping: 0.25 })
    assert.equal(created.linearDamping, 0.5)
    assert.equal(created.angularDamping, 0.25)
    // a clone's handle reads its own
    assert.equal(created.clone().linearDamping, 0.5)
    // each a getter and a setter, where the setter alone was (the key order is the same)
    for (const key of ['linearDamping', 'angularDamping']) {
      const desc = Object.getOwnPropertyDescriptor(proxy, key)
      assert.equal(typeof desc.get, 'function', key)
      assert.equal(typeof desc.set, 'function', key)
    }
    assert.deepEqual(Object.keys(proxy).slice(0, 6), [
      'type',
      'mass',
      'linearDamping',
      'angularDamping',
      'tag',
      'onContactStart',
    ])
  }))

// A UI in a browser (a window, a document whose canvases are stand-ins), screen-space (its canvas goes to the pointer
// layer, no scene), mounted and unmounted as Node.activate and Node.deactivate do it.
test('UI: an unmount drops a pending rebuild (it set a stray needRebuild); a mount builds with what was set meanwhile', () =>
  runProbe(
    bundle,
    ({ createNode }) => {
      const canvases = []
      globalThis.document = {
        createElement: () => {
          const ctx2d = new Proxy(
            {},
            { get: (target, key) => (key === 'measureText' ? () => ({ width: 0 }) : () => {}) }
          )
          const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx2d }
          canvas.addEventListener = canvas.removeEventListener = () => {}
          canvases.push(canvas)
          return canvas
        },
      }
      const layer = new Set()
      const world = {
        network: { isServer: false },
        stage: { dirtyNodes: new Set() },
        pointer: { ui: { prepend: canvas => layer.add(canvas), removeChild: canvas => layer.delete(canvas) } },
      }
      const clean = () => {
        for (const node of world.stage.dirtyNodes) node.clean()
        world.stage.dirtyNodes.clear()
      }
      const node = createNode('ui', { space: 'screen', width: 100, height: 100, res: 1, pointerEvents: false })
      const ui = node.getProxy()
      let builds = 0
      const build = node.build
      node.build = function () {
        builds++
        return build.call(this)
      }
      node.activate({ world, entity: {} })
      clean()
      assert.equal(builds, 1)
      assert.equal(node.needsRebuild, false)
      // a property set while it is mounted asks for a rebuild; the UI is unmounted before the next clean
      ui.width = 50
      assert.equal(node.needsRebuild, true)
      node.deactivate()
      assert.equal(node.mounted, false)
      assert.equal(layer.size, 0, 'the canvas is out of the page')
      assert.equal(node.needsRebuild, false, 'the pending rebuild went with what it would have rebuilt')
      assert.equal(Object.hasOwn(node, 'needRebuild'), false, 'no stray field')
      // mounted again: built once, at the size set before the unmount
      node.activate({ world, entity: {} })
      clean()
      assert.equal(builds, 2)
      assert.equal(canvases.at(-1).width, 50)
      assert.deepEqual([...layer], [canvases.at(-1)])
      // a property set while it is unmounted is built by the next mount
      node.deactivate()
      ui.height = 30
      assert.equal(node.needsRebuild, true)
      node.activate({ world, entity: {} })
      clean()
      assert.equal(builds, 3)
      assert.deepEqual([canvases.at(-1).width, canvases.at(-1).height], [50, 30])
      assert.equal(node.needsRebuild, false)
      assert.deepEqual([...layer], [canvases.at(-1)])
      node.deactivate()
      assert.equal(layer.size, 0)
    },
    { browser: true }
  ))

// The handle's pointer-callback getters checked `this.ctx`: `this` is the handle (which has no ctx), or whatever a
// script read the getter through. The node's own getter makes the check (and more: a run that has ended).
test("node: the handle's pointer-callback getters ask the node, not the object they are read through", () =>
  runProbe(bundle, ({ createNode }) => {
    const keys = ['onPointerEnter', 'onPointerLeave', 'onPointerDown', 'onPointerUp']
    const node = createNode('group')
    const handle = node.getProxy()
    const callbacks = {}
    for (const key of keys) handle[key] = callbacks[key] = () => key
    let ctxReads = 0
    const crashed = { entity: { crashed: true }, world: { fatalError: true } }
    const inheritor = Object.create(handle, {
      ctx: {
        get() {
          ctxReads++
          return crashed
        },
      },
    })
    for (const key of keys) {
      assert.equal(handle[key], callbacks[key], key)
      // read through an object that inherits from the handle, or with another receiver: the node's callback
      assert.equal(inheritor[key], callbacks[key], `${key} through Object.create(handle)`)
      assert.equal(Reflect.get(handle, key, { ctx: crashed }), callbacks[key], `${key} with another receiver`)
    }
    assert.equal(ctxReads, 0, "the receiver's ctx is not read")
    // the node's own context still decides, through the handle and through an inheritor alike
    for (const ctx of [{ entity: { crashed: true } }, { entity: {}, world: { fatalError: true } }]) {
      node.ctx = ctx
      for (const key of keys) {
        assert.equal(handle[key], null, key)
        assert.equal(Object.create(handle)[key], null, key)
      }
    }
  }))

// `play()` with no options threw a TypeError (it destructured `undefined`); `stop()` has had a default. It is now
// `play({})`: a play with no name, which is a clip not found (said once a play, as for any name the model lacks).
test('skinnedmesh: play() with no options is play({}) (it threw)', () =>
  runProbe(bundle, ({ createNode, Apps, THREE }) => {
    const apps = new Apps({ network: {}, events: {} })
    const app = { deadHook: { dead: false }, createNode: (type, data) => createNode(type, data) }
    // not mounted: nothing to play
    assert.equal(createNode('skinnedmesh').getProxy().play(), undefined)
    assert.equal(apps.appMethods.create(app, 'skinnedmesh').play(), undefined)
    // mounted, playing a clip of its model
    const warned = []
    console.warn = (...args) => warned.push(args.join(' '))
    const playing = () => {
      const clip = new THREE.AnimationClip('walk', 1, [new THREE.NumberKeyframeTrack('.position[x]', [0, 1], [0, 1])])
      const node = createNode('skinnedmesh', { object3d: new THREE.Object3D(), animations: [clip] })
      const world = { stage: { scene: { add() {}, remove() {} }, dirtyNodes: new Set() }, setHot() {} }
      node.activate({ world, entity: {} })
      const handle = node.getProxy()
      handle.play({ name: 'walk' })
      assert.equal(node.action?.getClip().name, 'walk')
      return { node, handle, walk: node.action }
    }
    const results = []
    for (const opts of [[], [{}]]) {
      const { node, handle, walk } = playing()
      warned.length = 0
      assert.equal(handle.play(...opts), undefined)
      // a second on (past the fade of 0.15 s)
      node.update(1)
      results.push({ action: node.action, warned: [...warned], walkRunning: walk.isRunning() })
      node.deactivate()
    }
    // (control: a clip left playing still runs a second on)
    const control = playing()
    control.node.update(1)
    assert.equal(control.walk.isRunning(), true)
    control.node.deactivate()
    assert.deepEqual(results[0], results[1])
    assert.deepEqual(results[0].warned, ['[skinnedmesh] animation not found: undefined'])
    assert.equal(results[0].action, undefined)
    assert.equal(results[0].walkRunning, false, 'the clip that played faded out, as for any name not found')
  }))
