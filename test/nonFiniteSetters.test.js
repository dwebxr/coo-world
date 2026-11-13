// Two setters that kept NaN or Infinity (17-F). A prim's `emissiveIntensity` refuses a number that is not finite as a
// float32, as it refuses -1: the value is written to a Float32Array the shader reads. A particles node's `direction`
// and `velocityRadial` follow the rule of their bounded neighbours (boundedValue.js): NaN is the default, a number
// past the largest float32 is that bound, a finite value inside it is kept as it is. Each is tried through the
// script's handle (the proxy), the class's setter and the options of app.create; a clone keeps what was kept.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { bundleProbe, runProbe } from './lib/workerProbe.mjs'

let bundle
before(async () => {
  bundle = await bundleProbe(`
    import './src/client/particles'
    export { createNode } from './src/core/extras/createNode'
    export { PARTICLES_MAX_FACTOR } from './src/core/nodes/Particles'
    export { Stage } from './src/core/systems/Stage'
    export * as THREE from './src/core/extras/three'
    export { Object3D } from 'three'
  `)
})
after(() => bundle?.destroy())

// the largest float32; the doubles on either side of where float32 rounding goes to Infinity (the largest that still
// rounds to FLOAT32_MAX, and the halfway point, which rounds up); the next double above FLOAT32_MAX
const FLOAT32_MAX = 3.4028234663852886e38
const LAST_TO_FLOAT32_MAX = 3.4028235677973362e38
const FIRST_TO_INFINITY = 3.4028235677973366e38
const ABOVE_FLOAT32_MAX = 3.402823466385289e38
const bounds = { FLOAT32_MAX, LAST_TO_FLOAT32_MAX, FIRST_TO_INFINITY, ABOVE_FLOAT32_MAX }

test('the boundary numbers are what their names say', () => {
  assert.equal(Math.fround(FLOAT32_MAX), FLOAT32_MAX)
  assert.equal(Math.fround(LAST_TO_FLOAT32_MAX), FLOAT32_MAX)
  assert.equal(Math.fround(FIRST_TO_INFINITY), Infinity)
  assert.ok(ABOVE_FLOAT32_MAX > FLOAT32_MAX && LAST_TO_FLOAT32_MAX < FIRST_TO_INFINITY)
})

test('prim: emissiveIntensity refuses NaN, Infinity and a number past the float32 range, as it refuses -1', () =>
  runProbe(
    bundle,
    ({ createNode }, { FLOAT32_MAX, LAST_TO_FLOAT32_MAX, FIRST_TO_INFINITY }) => {
      // the class and the message of the refusal that was already there
      let refusal
      try {
        createNode('prim').emissiveIntensity = -1
      } catch (err) {
        refusal = err
      }
      assert.equal(refusal?.constructor, Error)
      assert.equal(refusal.message, '[prim] emissiveIntensity must be positive number')
      const refused = err => err.constructor === Error && err.message === refusal.message
      for (const value of [
        NaN,
        Infinity,
        -Infinity,
        FIRST_TO_INFINITY,
        1e39,
        Number.MAX_VALUE,
        -1,
        -Number.MIN_VALUE,
      ]) {
        const handle = createNode('prim', { emissiveIntensity: 3 }).getProxy()
        assert.throws(() => (handle.emissiveIntensity = value), refused, `proxy: ${value}`)
        assert.equal(handle.emissiveIntensity, 3, `proxy: ${value} leaves what was kept`)
        const node = createNode('prim', { emissiveIntensity: 3 })
        assert.throws(() => (node.emissiveIntensity = value), refused, `class: ${value}`)
        assert.equal(node.emissiveIntensity, 3)
        assert.throws(() => createNode('prim', { emissiveIntensity: value }), refused, `data: ${value}`)
      }
      // a number in range is kept as it is: zero, the smallest positive number, the largest float32 and the largest
      // double that a Float32Array stores as it
      for (const value of [0, Number.MIN_VALUE, 0.25, 2, FLOAT32_MAX, LAST_TO_FLOAT32_MAX]) {
        const handle = createNode('prim').getProxy()
        handle.emissiveIntensity = value
        assert.equal(handle.emissiveIntensity, value, `proxy: ${value}`)
        const node = createNode('prim')
        node.emissiveIntensity = value
        assert.equal(node.emissiveIntensity, value, `class: ${value}`)
        const made = createNode('prim', { emissiveIntensity: value })
        assert.equal(made.emissiveIntensity, value, `data: ${value}`)
        assert.equal(made.clone().emissiveIntensity, value, `clone: ${value}`)
      }
      assert.equal(createNode('prim').emissiveIntensity, 0, 'the default')
      assert.equal(createNode('prim', { emissiveIntensity: undefined }).emissiveIntensity, 0)
      // what is not a number is refused as before
      for (const value of ['2', null, new Number(2), {}]) {
        assert.throws(() => (createNode('prim').getProxy().emissiveIntensity = value), refused, String(value))
      }
    },
    bounds
  ))

// The Stage is the real one, and what the prim hands its instance is read back from the instance attribute. The
// shader that reads the attribute is not run here.
test('prim: only finite values reach the instance attribute of a mounted prim', () =>
  runProbe(
    bundle,
    ({ createNode, Stage, Object3D }, { FLOAT32_MAX, LAST_TO_FLOAT32_MAX, FIRST_TO_INFINITY }) => {
      const world = { rig: new Object3D(), camera: new Object3D(), setupMaterial() {} }
      world.stage = new Stage(world)
      const entity = { deadHook: { dead: false } }
      const prim = createNode('prim', { emissive: '#ff0000', emissiveIntensity: 2 })
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
      for (const value of [NaN, Infinity, FIRST_TO_INFINITY]) {
        assert.throws(() => (handle.emissiveIntensity = value), /emissiveIntensity must be positive number/)
        assert.equal(attribute(), 2, `${value} left the attribute as it was`)
      }
      handle.emissiveIntensity = LAST_TO_FLOAT32_MAX
      assert.equal(attribute(), FLOAT32_MAX, 'stored as the largest float32')
      handle.emissiveIntensity = 0.5
      assert.equal(attribute(), 0.5)
      assert.deepEqual(written, [LAST_TO_FLOAT32_MAX, 0.5], 'only the accepted values were written')
      assert.ok(Array.from(iMesh.instanceEmissiveIntensity.array).every(Number.isFinite))
      prim.deactivate()
    },
    bounds
  ))

test('particles: direction and velocityRadial keep NaN and Infinity in range; a finite value is kept as it is', () =>
  runProbe(
    bundle,
    ({ createNode, PARTICLES_MAX_FACTOR: max }, { FLOAT32_MAX, ABOVE_FLOAT32_MAX }) => {
      assert.equal(max, FLOAT32_MAX, 'the bound is the largest float32')
      // [value given, value kept]
      const keeps = (name, pairs) => {
        for (const [given, kept] of pairs) {
          const label = `${name} = ${String(given)}`
          const handle = createNode('particles').getProxy()
          handle[name] = given
          assert.ok(Object.is(handle[name], kept), `proxy: ${label} keeps ${kept}, got ${handle[name]}`)
          const node = createNode('particles')
          node[name] = given
          assert.ok(Object.is(node[name], kept), `class: ${label} keeps ${kept}, got ${node[name]}`)
          const made = createNode('particles', { [name]: given })
          assert.ok(Object.is(made[name], kept), `data: ${label} keeps ${kept}, got ${made[name]}`)
          assert.ok(Object.is(made.clone()[name], kept), `clone: ${label}`)
          assert.ok(Object.is(made.getConfig()[name], kept), `the worker's config: ${label}`)
        }
      }
      // finite values outside the documented 0 to 1 are kept: the worker does not clamp them (above 1 randomizes
      // more, 0 and below not at all)
      keeps('direction', [
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
      keeps('velocityRadial', [
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
      assert.equal(createNode('particles').direction, 0)
      assert.equal(createNode('particles').velocityRadial, null)
      // what is not a number is refused as before (null too, for direction)
      for (const value of ['1', null, new Number(1), {}]) {
        assert.throws(() => (createNode('particles').getProxy().direction = value), /direction not a number/)
      }
      for (const value of ['1', new Number(1), {}]) {
        assert.throws(() => (createNode('particles').getProxy().velocityRadial = value), /velocityRadial not a number/)
      }
    },
    bounds
  ))

// The particle worker with the config the node gives it (what the client sends): eight particles started at once,
// `steps` steps at 60 a second. The probe checks the positions (and directions) of every step for `kind`.
const runWorker = (kind, data, steps) =>
  runProbe(
    bundle,
    ({ createNode, THREE }, { kind, data, steps }) => {
      const node = createNode('particles', { rate: 0, bursts: [{ time: 0, count: 8 }], max: 8, speed: '1', ...data })
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
      outputs.forEach((out, step) => {
        assert.equal(out.n, 8)
        const positions = Array.from(out.aPosition)
        if (kind === 'direction') {
          assert.ok(positions.every(Number.isFinite), `step ${step}: ${positions}`)
          for (let i = 0; i < 8; i++) {
            const [x, y, z] = out.aDirection.slice(i * 3, i * 3 + 3)
            assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-6, `step ${step}: a unit direction, ${[x, y, z]}`)
          }
        } else {
          // the first steps are finite (one radial step is the bound over 60); then the particles are farther away than
          // a float32 holds, and the position buffer has Infinity for them, never NaN
          if (step < 5) assert.ok(positions.every(Number.isFinite), `step ${step}: ${positions}`)
          assert.ok(!positions.some(Number.isNaN), `step ${step}: no NaN`)
        }
      })
    },
    { kind, data, steps }
  )

test('particle worker: a direction of Infinity, kept as the bound, starts particles in finite unit directions', () =>
  runWorker('direction', { direction: Infinity }, 5))

test('particle worker: a radial velocity of Infinity, kept as the bound, leaves no NaN in the positions', () =>
  runWorker('velocityRadial', { shape: ['sphere', 1, 1], velocityRadial: Infinity }, 120))
