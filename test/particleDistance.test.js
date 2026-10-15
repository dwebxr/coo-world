import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundleProbe, runProbe } from './lib/workerProbe.mjs'

let bundle
before(async () => {
  bundle = await bundleProbe(`
    import './src/client/particles'
    export * as THREE from './src/core/extras/three'
    export { Particles } from './src/core/nodes/Particles'
  `)
})
after(() => bundle?.destroy())

const cases = [
  { name: 'ordinary fractional remainder', rate: 2, moves: [0, 0.25, 0.5, 1], counts: [0, 0, 1, 2] },
  { name: 'exact cap preserves fractional remainder', rate: 1, moves: [0, 1000.5, 1001], counts: [0, 1000, 1001] },
  {
    name: 'over cap discards fractional remainder',
    rate: 1,
    moves: [0, 1001.5, 1002, 1002.5],
    counts: [0, 1000, 1000, 1001],
  },
  { name: 'large accepted displacement is capped', rate: 10, moves: [-1e6, 1e6], counts: [0, 1000] },
  { name: 'huge finite rate is capped', rate: 1e300, moves: [0, 1], counts: [0, 1000] },
  { name: 'exhausted pool still terminates', rate: 1e300, max: 1, moves: [0, 1, 2], counts: [0, 1, 1] },
  { name: 'overflowed count resets and recovers', rate: 1e155, moves: [0, 1e154, 0, 2.5e-155], counts: [0, 0, 0, 2] },
  { name: 'infinite rate cannot loop', rate: Infinity, moves: [0, 1, 2], counts: [0, 0, 0] },
  {
    name: 'non-finite distance resets and recovers',
    rate: 1,
    moves: [0, 0.5, NaN, 0, 0.5, 1],
    counts: [0, 0, 0, 0, 0, 1],
  },
  {
    name: 'overflowed distance resets and recovers',
    rate: 1,
    moves: [0, 0.5, 1e300, 0, 0.5, 1],
    counts: [0, 0, 0, 0, 0, 1],
  },
]

for (const entry of cases) {
  test(`particle worker distance emission: ${entry.name}`, () =>
    runProbe(
      bundle,
      ({ THREE }, { rate, moves, counts, max = 2001 }) => {
        let output
        self.postMessage = msg => {
          output = msg
        }
        self.onmessage({
          data: {
            op: 'create',
            id: 'probe',
            emitting: true,
            rate: 0,
            rateOverDistance: rate,
            bursts: [],
            duration: 100,
            loop: true,
            max,
            timescale: 1,
            life: '5',
            speed: '0',
            size: '1',
            rotate: '0',
            color: 'white',
            alpha: '1',
            emissive: '1',
            shape: ['point'],
            direction: 0,
            space: 'world',
            blending: 'additive',
          },
        })
        for (let i = 0; i < moves.length; i++) {
          self.onmessage({
            data: {
              op: 'update',
              emitterId: 'probe',
              delta: 0,
              camPosition: [0, 0, 0],
              matrixWorld: new THREE.Matrix4().makeTranslation(moves[i], 0, 0).toArray(),
              aPosition: new Float32Array(max * 3),
              aRotation: new Float32Array(max),
              aDirection: new Float32Array(max * 3),
              aSize: new Float32Array(max),
              aColor: new Float32Array(max * 3),
              aAlpha: new Float32Array(max),
              aEmissive: new Float32Array(max),
              aUV: new Float32Array(max * 4),
            },
          })
          assert.equal(output.op, 'update')
          assert.equal(output.n, counts[i], `update ${i}`)
        }
        self.onmessage({ data: { op: 'destroy', emitterId: 'probe' } })
      },
      entry
    ))
}

test('Particles.rateOverDistance: only finite nonnegative primitive numbers replace the prior value', () =>
  runProbe(bundle, ({ Particles }) => {
    const node = new Particles({ rateOverDistance: 7 })
    let dirtied = 0
    node.setDirty = () => dirtied++
    node.needsRebuild = false
    for (const invalid of [NaN, Infinity, -Infinity, -1, '2', null, {}, new Number(2)]) {
      node.rateOverDistance = invalid
      assert.equal(node.rateOverDistance, 7)
      assert.equal(node.needsRebuild, false)
      assert.equal(dirtied, 0)
    }
    for (const value of [0, 0.5, 1e300]) {
      node.rateOverDistance = value
      assert.equal(node.rateOverDistance, value)
      assert.equal(node.needsRebuild, true)
    }
    assert.equal(dirtied, 3)
  }))
