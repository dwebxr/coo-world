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
