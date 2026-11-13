// Three node properties that kept NaN or Infinity (17-F) now follow the rule of the bounded neighbours
// (boundedValue.js: no bound throws): NaN is the property's default, a number past the largest float32 is that bound,
// a number inside it is kept as it is. A prim's `emissiveIntensity` still throws for what it threw for before (a
// negative number, -Infinity included, and anything that is not a number). A particles node's `direction` and
// `velocityRadial` are bounded on both sides.
//
// Each value is given four ways: the script's handle (the proxy), app.create (the real Apps hook: the node is
// constructed from host-safe keys and the rest goes through the proxy, createOptions.js), and on the host side the
// class's setter and the constructor's data. A clone keeps what was kept. The particle worker is run in a worker
// thread with a seeded Math.random, on the config the node gives it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { bundleProbe, runProbe } from './lib/workerProbe.mjs'

let bundle
let m
let apps
before(async () => {
  bundle = await bundleProbe(`
    import './src/client/particles'
    export { createNode } from './src/core/extras/createNode'
    export { FLOAT32_MAX } from './src/core/extras/boundedValue.js'
    export { PARTICLES_MAX_FACTOR } from './src/core/nodes/Particles'
    export { Apps } from './src/core/systems/Apps'
    export { Stage } from './src/core/systems/Stage'
    export * as THREE from './src/core/extras/three'
    export { Object3D } from 'three'
  `)
  // the particle worker's module expects a worker's global
  const hadSelf = 'self' in globalThis
  const realSelf = globalThis.self
  globalThis.self = {}
  try {
    m = await import(bundle.url)
  } finally {
    if (hadSelf) globalThis.self = realSelf
    else delete globalThis.self
  }
  apps = new m.Apps({ network: {}, events: {} })
})
after(() => bundle?.destroy())

// the largest float32; the doubles on either side of where float32 rounding goes to Infinity (the largest that still
// rounds to FLOAT32_MAX, and the halfway point, which rounds up); the next double above FLOAT32_MAX
const FLOAT32_MAX = 3.4028234663852886e38
const LAST_TO_FLOAT32_MAX = 3.4028235677973362e38
const FIRST_TO_INFINITY = 3.4028235677973366e38
const ABOVE_FLOAT32_MAX = 3.402823466385289e38

test('the boundary numbers are what their names say, and the bound is the largest float32', () => {
  assert.equal(Math.fround(FLOAT32_MAX), FLOAT32_MAX)
  assert.equal(Math.fround(LAST_TO_FLOAT32_MAX), FLOAT32_MAX)
  assert.equal(Math.fround(FIRST_TO_INFINITY), Infinity)
  assert.ok(ABOVE_FLOAT32_MAX > FLOAT32_MAX && LAST_TO_FLOAT32_MAX < FIRST_TO_INFINITY)
  assert.equal(m.FLOAT32_MAX, FLOAT32_MAX)
  assert.equal(m.PARTICLES_MAX_FACTOR, FLOAT32_MAX)
})

// an app as Apps.create sees it: its run, and its createNode (App.createNode, without the run's bookkeeping)
const app = () => ({ deadHook: { dead: false }, createNode: (type, data) => m.createNode(type, data) })

// the four ways a value reaches a node; each gives back what the value can be read from
const ways = (type, name) => ({
  proxy: value => {
    const handle = m.createNode(type).getProxy()
    handle[name] = value
    return handle
  },
  'app.create': value => apps.appMethods.create(app(), type, { [name]: value }),
  class: value => {
    const node = m.createNode(type)
    node[name] = value
    return node
  },
  data: value => m.createNode(type, { [name]: value }),
})

// [value given, value kept], every way, and the clone of each
function keeps(type, name, pairs) {
  for (const [given, kept] of pairs) {
    for (const [way, give] of Object.entries(ways(type, name))) {
      const label = `${way}: ${type}.${name} = ${String(given)}`
      const node = give(given)
      assert.ok(Object.is(node[name], kept), `${label} keeps ${kept}, got ${node[name]}`)
      assert.ok(Object.is(node.clone()[name], kept), `${label}: the clone keeps ${kept}`)
    }
  }
}

// every way throws `message` (the class Error), and a node that had a value keeps it
function throws(type, name, values, message) {
  const refused = err => err.constructor === Error && message.test(err.message)
  for (const value of values) {
    for (const [way, give] of Object.entries(ways(type, name))) {
      assert.throws(() => give(value), refused, `${way}: ${type}.${name} = ${String(value)}`)
    }
    const handle = m.createNode(type, { [name]: 3 }).getProxy()
    assert.throws(() => (handle[name] = value), refused)
    assert.equal(handle[name], 3, `${String(value)} leaves what was kept`)
  }
}

test('prim: emissiveIntensity keeps NaN as the default and a number past the largest float32 as that number', () => {
  keeps('prim', 'emissiveIntensity', [
    [0, 0],
    [Number.MIN_VALUE, Number.MIN_VALUE],
    [0.25, 0.25],
    [2, 2],
    [1e30, 1e30],
    [FLOAT32_MAX, FLOAT32_MAX],
    [NaN, 0],
    [Infinity, FLOAT32_MAX],
    [ABOVE_FLOAT32_MAX, FLOAT32_MAX],
    [LAST_TO_FLOAT32_MAX, FLOAT32_MAX],
    [FIRST_TO_INFINITY, FLOAT32_MAX],
    [1e39, FLOAT32_MAX],
    [Number.MAX_VALUE, FLOAT32_MAX],
  ])
  assert.equal(m.createNode('prim').emissiveIntensity, 0, 'the default')
  assert.equal(m.createNode('prim', { emissiveIntensity: undefined }).emissiveIntensity, 0)
})

test('prim: emissiveIntensity throws what it threw before, with the same message', () => {
  const message = /^\[prim\] emissiveIntensity must be positive number$/
  throws('prim', 'emissiveIntensity', [-1, -Infinity, -Number.MIN_VALUE, -FLOAT32_MAX, -Number.MAX_VALUE], message)
  throws('prim', 'emissiveIntensity', ['2', null, new Number(2), {}, true], message)
})

// The Stage is the real one; what the prim hands its instance is read back from the instance attribute. The shader
// that reads the attribute is not run here.
test('prim: only finite values reach the instance attribute of a mounted prim; Infinity reaches it as the bound', () => {
  const world = { rig: new m.Object3D(), camera: new m.Object3D(), setupMaterial() {} }
  world.stage = new m.Stage(world)
  const entity = { deadHook: { dead: false } }
  const prim = m.createNode('prim', { emissive: '#ff0000', emissiveIntensity: 2 })
  prim.activate({ world, entity, run: entity.deadHook })
  assert.ok(prim.handle, 'mounted, with an instance')
  const { iMesh } = [...world.stage.models.values()][0]
  const written = []
  const setAt = iMesh.setEmissiveIntensityAt
  iMesh.setEmissiveIntensityAt = function (index, amount) {
    written.push(amount)
    return setAt.call(this, index, amount)
  }
  const attribute = () => iMesh.instanceEmissiveIntensity.array[0]
  assert.equal(attribute(), 2)
  const handle = prim.getProxy()
  handle.emissiveIntensity = NaN
  assert.equal(attribute(), 0, 'NaN is the default')
  handle.emissiveIntensity = Infinity
  assert.equal(attribute(), FLOAT32_MAX, 'Infinity is the bound')
  // the same kept value again: nothing is written
  handle.emissiveIntensity = 1e39
  handle.emissiveIntensity = LAST_TO_FLOAT32_MAX
  assert.equal(attribute(), FLOAT32_MAX)
  assert.throws(() => (handle.emissiveIntensity = -Infinity), /emissiveIntensity must be positive number/)
  assert.equal(attribute(), FLOAT32_MAX, 'a refused value leaves the attribute as it was')
  handle.emissiveIntensity = 0.5
  assert.equal(attribute(), 0.5)
  assert.deepEqual(written, [0, FLOAT32_MAX, 0.5], 'what was written')
  assert.ok(written.every(Number.isFinite))
  assert.ok(Array.from(iMesh.instanceEmissiveIntensity.array).every(Number.isFinite))
  prim.deactivate()
})

test('particles: direction and velocityRadial keep NaN and Infinity in range; a finite value inside is kept as it is', () => {
  const max = FLOAT32_MAX
  // finite values outside the documented 0 to 1 are kept: the worker does not clamp them (above 1 randomizes more, 0
  // and below not at all)
  keeps('particles', 'direction', [
    [0, 0],
    [0.2, 0.2],
    [1, 1],
    [2, 2],
    [-1, -1],
    [1e32, 1e32],
    [max, max],
    [-max, -max],
    [NaN, 0],
    [Infinity, max],
    [-Infinity, -max],
    [ABOVE_FLOAT32_MAX, max],
    [-ABOVE_FLOAT32_MAX, -max],
    [Number.MAX_VALUE, max],
  ])
  keeps('particles', 'velocityRadial', [
    [null, null],
    [0, 0],
    [3, 3],
    [-3, -3],
    [0.001, 0.001],
    [1e6, 1e6],
    [max, max],
    [-max, -max],
    [NaN, null],
    [Infinity, max],
    [-Infinity, -max],
    [ABOVE_FLOAT32_MAX, max],
    [-Number.MAX_VALUE, -max],
  ])
  // the worker gets what was kept
  assert.equal(m.createNode('particles', { direction: Infinity }).getConfig().direction, max)
  assert.equal(m.createNode('particles', { velocityRadial: -Infinity }).getConfig().velocityRadial, -max)
  assert.equal(m.createNode('particles', { velocityRadial: NaN }).getConfig().velocityRadial, null)
  assert.equal(m.createNode('particles').direction, 0)
  assert.equal(m.createNode('particles').velocityRadial, null)
  // what is not a number is refused as before (null too, for direction)
  throws('particles', 'direction', ['1', null, new Number(1), {}], /direction not a number/)
  throws('particles', 'velocityRadial', ['1', new Number(1), {}], /velocityRadial not a number/)
})

// The particle worker with the config the node gives it (what the client sends), in world space with the emitter at
// the origin: eight particles started at once by a burst, `steps` steps at 60 a second, additive blending (no sort,
// so the buffers are in pool order), and Math.random replaced by a fixed sequence. `kind` says what is checked.
const runWorker = (kind, data, steps) =>
  runProbe(
    bundle,
    ({ createNode, THREE }, { kind, data, steps }) => {
      const LCG = seed => () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 2 ** 32
      }
      Math.random = LCG(1)
      const node = createNode('particles', {
        rate: 0,
        bursts: [{ time: 0, count: 8 }],
        max: 8,
        speed: '1',
        blending: 'additive',
        ...data,
      })
      const outputs = []
      self.postMessage = msg => {
        if (msg.op === 'update') outputs.push(msg)
      }
      self.onmessage({ data: { op: 'create', id: 'probe', ...node.getConfig() } })
      for (let i = 0; i < steps; i++) {
        self.onmessage({
          data: {
            op: 'update',
            emitterId: 'probe',
            delta: 1 / 60,
            camPosition: [0, 0, 5],
            matrixWorld: new THREE.Matrix4().toArray(),
            aPosition: new Float32Array(8 * 3),
            aRotation: new Float32Array(8),
            aDirection: new Float32Array(8 * 3),
            aSize: new Float32Array(8),
            aColor: new Float32Array(8 * 3),
            aAlpha: new Float32Array(8),
            aEmissive: new Float32Array(8),
            aUV: new Float32Array(8 * 4),
          },
        })
      }
      assert.equal(outputs.length, steps)
      for (const out of outputs) assert.equal(out.n, 8)
      const particle = (array, i) => Array.from(array.slice(i * 3, i * 3 + 3))

      if (kind === 'cone') {
        // the default shape is a cone of 25 degrees: each particle's own direction has a y of cos(25 deg). For each
        // particle the cone draws two numbers (an angle, a radius) and the randomization three more (x, y, z).
        const cos25 = Math.cos((25 * Math.PI) / 180)
        const drawn = LCG(1)
        for (let i = 0; i < 8; i++) {
          const got = particle(outputs[0].aDirection, i)
          assert.ok(Math.abs(Math.hypot(...got) - 1) < 1e-6, `particle ${i}: a unit direction, ${got}`)
          if (data.direction === 0) {
            assert.ok(Math.abs(got[1] - cos25) < 1e-6, `particle ${i}: the cone's own direction, ${got}`)
            continue
          }
          // the shape's own direction is lost: the direction is the three drawn offsets (2r - 1), normalized
          drawn()
          drawn()
          const offset = [drawn() * 2 - 1, drawn() * 2 - 1, drawn() * 2 - 1]
          const expected = offset.map(v => v / Math.hypot(...offset))
          assert.ok(
            expected.every((v, k) => Math.abs(v - got[k]) < 1e-6),
            `particle ${i}: ${got}, expected ${expected}`
          )
          assert.ok(Math.abs(got[1] - cos25) > 0.01, `particle ${i} is not in the cone: ${got}`)
        }
        for (const out of outputs) assert.ok(Array.from(out.aPosition).every(Number.isFinite), 'finite positions')
      }

      if (kind === 'radial') {
        // a sphere of radius 1 around the emitter: a particle's own direction points away from the centre. Each step
        // the radial velocity moves it by velocityRadial / 60 and adds velocityRadial to its velocity, so after the
        // first step it is 2 * bound / 60 from the centre (the radius and the start speed are lost in the rounding).
        // The worker's numbers are doubles; the position buffer is float32 and holds Infinity once a coordinate passes
        // the largest float32, which in this configuration is on the tenth step. Never NaN.
        const max = 3.4028234663852886e38
        for (let i = 0; i < 8; i++) {
          const distance = Math.hypot(...particle(outputs[0].aPosition, i))
          assert.ok(Math.abs(distance / ((2 * max) / 60) - 1) < 1e-6, `particle ${i} after one step: ${distance}`)
        }
        const infinite = outputs.map(out => Array.from(out.aPosition).some(v => v === Infinity || v === -Infinity))
        assert.equal(infinite.indexOf(true) + 1, 10, 'the first step with Infinity in the position buffer')
        outputs.forEach((out, step) => {
          assert.ok(!Array.from(out.aPosition).some(Number.isNaN), `step ${step + 1}: no NaN`)
        })
      }
    },
    { kind, data, steps }
  )

test('particle worker: a direction of Infinity, kept as the bound, randomizes the directions completely', () =>
  runWorker('cone', { direction: Infinity }, 5))

test('particle worker (control): a direction of 0 keeps the cone directions the test above tells apart', () =>
  runWorker('cone', { direction: 0 }, 1))

test('particle worker: a radial velocity of Infinity, kept as the bound, moves the particles by the bound', () =>
  runWorker('radial', { shape: ['sphere', 1, 1], velocityRadial: Infinity }, 120))
