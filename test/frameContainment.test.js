import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundleProbe } from './lib/workerProbe.mjs'

// The real client systems that walk script-owned nodes every frame, and the real node setters, bundled like the
// other node tests. One poisoned node must not stop the frame for the other nodes (or for rendering).
let m
let bundle
before(async () => {
  bundle = await bundleProbe(`
    export { ClientActions } from './src/core/systems/ClientActions'
    export { ClientPointer, PointerState } from './src/core/systems/ClientPointer'
    export { LODs } from './src/core/systems/LODs'
    export { Avatars } from './src/core/systems/Avatars'
    export { createNode } from './src/core/extras/createNode'
    export { Node } from './src/core/nodes/Node'
    export * as THREE from './src/core/extras/three'
  `)
  m = await import(bundle.url)
})
after(() => bundle?.destroy())

function quietly(fn) {
  const original = console.error
  const lines = []
  console.error = (...args) => lines.push(args.map(String).join(' '))
  try {
    fn()
    return lines
  } finally {
    console.error = original
  }
}

const poison = () =>
  Object.assign(new Number(3), {
    valueOf() {
      throw new Error('poison')
    },
    toString() {
      throw new Error('poison')
    },
  })

function appEntity(id) {
  return {
    isApp: true,
    data: { id },
    crashes: 0,
    crashed: false,
    crash() {
      this.crashed = true
      this.crashes++
    },
  }
}

test('setters: action distance/duration, nametag health and node cursor take primitives only', () => {
  const action = m.createNode('action').getProxy()
  for (const key of ['distance', 'duration']) {
    assert.throws(() => (action[key] = poison()), /not a number/)
    assert.throws(() => (action[key] = Infinity), /not a number/)
    assert.throws(() => (action[key] = NaN), /not a number/)
    action[key] = 2
    assert.equal(action[key], 2)
  }
  const nametag = m.createNode('nametag').getProxy()
  assert.throws(() => (nametag.health = poison()), /health not a number/)
  nametag.health = 50
  assert.equal(nametag.health, 50)
  assert.throws(() => (nametag.label = new String('boxed')), /label invalid/)
  const node = new m.Node().getProxy()
  const throwing = {
    toString() {
      throw new Error('poison')
    },
  }
  assert.throws(() => (node.cursor = throwing), /cursor must be a string/)
  assert.throws(() => (node.cursor = 'x'.repeat(200)), /cursor must be a string/)
  node.cursor = 'pointer'
  assert.equal(node.cursor, 'pointer')
  node.cursor = null
  assert.equal(node.cursor, null)
})

// an action system over real action nodes, with stand-ins for the camera, the input control and the prompt
function actionSystem() {
  const world = { rig: { position: new m.THREE.Vector3() } }
  const actions = new m.ClientActions(world)
  actions.control = { keyE: {}, touchB: {}, xrLeftTrigger: {}, xrRightTrigger: {} }
  const prompt = { started: [], start: node => prompt.started.push(node), update() {}, stop() {} }
  actions.action = prompt
  const node = (app, distance = 3) => {
    const n = m.createNode('action', { distance })
    n.ctx = { entity: app }
    actions.register(n)
    return n
  }
  return { actions, prompt, node }
}

test('ClientActions: a node that throws is dropped and its app crashes; the others keep working', () => {
  const { actions, prompt, node } = actionSystem()
  const bad = appEntity('bad')
  const good = appEntity('good')
  const poisoned = node(bad)
  poisoned._distance = poison() // a value the setter now refuses, forced in as an older build would have kept it
  const fine = node(good)
  const lines = quietly(() => {
    for (let i = 0; i < 3; i++) actions.update(1 / 60)
  })
  assert.equal(bad.crashes, 1)
  assert.equal(good.crashes, 0)
  assert.equal(actions.nodes.includes(poisoned), false)
  assert.equal(actions.current.node, fine, 'the healthy action is still found')
  assert.deepEqual(prompt.started, [fine])
  assert.equal(lines.length, 1, 'reported once')
  // the prompt itself throwing for the current node is contained the same way
  prompt.update = () => {
    throw new Error('draw failed')
  }
  quietly(() => {
    for (let i = 0; i < 3; i++) actions.update(1 / 60)
  })
  assert.equal(good.crashes, 1)
  assert.equal(actions.current.node, null)
})

test("ClientPointer: the world's destroy lets go of the nodes under the pointer", () => {
  const pointer = new m.ClientPointer({})
  const node = m.createNode('group')
  pointer.pointerState.activePath.add(node)
  pointer.pointerState.pressedNodes.add(node)
  pointer.pointerState.hit = { node }
  pointer.screenHit = { node }
  pointer.destroy()
  assert.equal(pointer.pointerState.activePath.size, 0)
  assert.equal(pointer.pointerState.pressedNodes.size, 0)
  assert.equal(pointer.pointerState.hit, null)
  assert.equal(pointer.screenHit, null)
})

test('ClientPointer: a path whose handling throws resets, crashes the app and the next frames run', () => {
  const original = globalThis.document
  const style = {}
  globalThis.document = { body: { style } }
  try {
    const pointer = new m.ClientPointer({})
    pointer.control = {
      xrLeftTrigger: { value: 0 },
      xrRightTrigger: { value: 0 },
      pointer: { locked: false },
      mouseLeft: { pressed: false, released: false },
    }
    const app = appEntity('pointer-app')
    const root = new m.Node()
    const child = new m.Node()
    root.add(child)
    child.ctx = { entity: app }
    root.ctx = { entity: app }
    // a cursor object (the setter refuses it now) and a hit resolver that throws
    child._cursor = {
      toString() {
        throw new Error('poison')
      },
    }
    pointer.screenHit = { node: child }
    let lines = quietly(() => {
      for (let i = 0; i < 3; i++) pointer.update(1 / 60)
    })
    assert.equal(style.cursor, undefined, 'a non-string cursor never reaches the page')
    assert.equal(app.crashes, 0)
    assert.equal(lines.length, 0)
    child.resolveHit = () => {
      throw new Error('resolve failed')
    }
    lines = quietly(() => {
      for (let i = 0; i < 3; i++) pointer.update(1 / 60)
    })
    assert.equal(app.crashes, 1)
    assert.equal(lines.length, 1)
    assert.equal(pointer.pointerState.activePath.size, 0)
    // another app's node under the pointer works on the next frame
    const other = new m.Node()
    other.ctx = { entity: appEntity('other') }
    other.cursor = 'pointer'
    pointer.screenHit = { node: other }
    pointer.update(1 / 60)
    assert.equal(style.cursor, 'pointer')
  } finally {
    globalThis.document = original
  }
})

test('LODs and Avatars: one throwing entry is dropped and the rest are still checked', () => {
  const lods = new m.LODs({})
  const app = appEntity('lod-app')
  const checked = []
  const bad = {
    ctx: { entity: app },
    check() {
      throw new Error('lod failed')
    },
  }
  const good = { ctx: { entity: appEntity('ok') }, check: () => checked.push('good') }
  lods.register(bad)
  lods.register(good)
  quietly(() => {
    for (let i = 0; i < 3; i++) lods.update(1 / 60)
  })
  assert.equal(app.crashes, 1)
  assert.deepEqual(checked, ['good', 'good', 'good'])
  assert.equal(lods.nodes.includes(bad), false)
  const avatars = new m.Avatars({})
  const rates = []
  avatars.add({
    hotOwner: { ctx: { entity: app } },
    updateRate() {
      throw new Error('rate failed')
    },
  })
  avatars.add({ updateRate: () => rates.push(1) })
  quietly(() => {
    for (let i = 0; i < 4; i++) avatars.update()
  })
  assert.equal(avatars.avatars.length, 1)
  assert.ok(rates.length >= 2)
})
