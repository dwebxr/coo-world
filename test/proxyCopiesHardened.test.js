import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// the real lockdown config (ses must be imported first, as in src/server/index.js)
import 'ses'
await import('../src/core/lockdown.js')

import { bundleProbe } from './lib/workerProbe.mjs'

// Review finding 5: the player proxy and the raycast hand out fresh copies, but a copy was made by calling a
// prototype method a script could replace (`Vector3.prototype.copy`), which then received the host's live object.
// With the script classes hardened (Scripts hardens them when it is constructed), check inside a real compartment
// that no replacement can be installed and that a fresh copy cannot have been prepared beforehand.
let bundle
let m
let scripts

before(async () => {
  bundle = await bundleProbe(`
    export { Scripts } from './src/core/systems/Scripts'
    export * as THREE from './src/core/extras/three'
    export { createPlayerProxy } from './src/core/extras/createPlayerProxy'
    export { Apps } from './src/core/systems/Apps'
  `)
  m = await import(bundle.url)
  scripts = new m.Scripts({})
})

after(() => bundle?.destroy())

const run = (code, host) => scripts.evaluate(code).exec(host)

function host() {
  const base = {
    position: new m.THREE.Vector3(1, 2, 3),
    quaternion: new m.THREE.Quaternion(0, 0, 0, 1),
    rotation: new m.THREE.Euler(0, 0, 0, 'YXZ'),
  }
  const head = new m.THREE.Matrix4().makeTranslation(0, 1.6, 0)
  const player = {
    world: { network: { isServer: false, isClient: true, id: 'me' } },
    data: { id: 'p', owner: 'me' },
    base,
    avatar: { getBoneTransform: () => head },
  }
  const entity = { deadHook: { dead: false } }
  const hit = { point: new m.THREE.Vector3(4, 5, 6), normal: new m.THREE.Vector3(0, 1, 0), distance: 1, handle: {} }
  const apps = new m.Apps({ network: {}, events: {}, physics: { raycast: () => hit } })
  const world = {
    player: m.createPlayerProxy(entity, player),
    raycast: () => apps.worldMethods.raycast({}, new m.THREE.Vector3(), new m.THREE.Vector3(0, -1, 0)),
    leaked: [],
  }
  return { world, base, head, hit }
}

const PROTOTYPE_ATTACKS = [
  `Vector3.prototype.copy = function (v) { world.leaked.push(v); return this }`,
  `Quaternion.prototype.copy = function (v) { world.leaked.push(v); return this }`,
  `Euler.prototype.copy = function (v) { world.leaked.push(v); return this }`,
  `Matrix4.prototype.copy = function (m) { world.leaked.push(m); return this }`,
  `Object.getPrototypeOf(world.player.position).copy = function (v) { world.leaked.push(v); return this }`,
  `world.player.position.constructor.prototype.copy = function (v) { world.leaked.push(v); return this }`,
  `Object.getPrototypeOf(world.player.getBoneTransform('head')).copy = function (m) { world.leaked.push(m); return this }`,
  `Object.defineProperty(Vector3.prototype, 'x', { set(v) { world.leaked.push(v) } })`,
]

for (const code of PROTOTYPE_ATTACKS) {
  test(`a script cannot install a copy hook on a shared class: ${code.slice(0, 60)}`, () => {
    const { world, base, head } = host()
    assert.throws(() => run(`'use strict'; ${code}`, world), TypeError)
    // the next copies are made by the frozen class methods: nothing reaches the script
    run(
      `world.player.position; world.player.quaternion; world.player.rotation; world.player.getBoneTransform('head'); world.raycast()`,
      world
    )
    assert.deepEqual(world.leaked, [])
    assert.deepEqual(base.position.toArray(), [1, 2, 3])
    assert.equal(head.elements[13], 1.6)
  })
}

test('a fresh copy cannot have been prepared: per-object hooks stay on the object the script already had', () => {
  const { world, base, hit } = host()
  const result = run(
    `
    const first = world.player.position
    first.copy = v => { world.leaked.push(v); return first }
    first.set = v => { world.leaked.push(v); return first }
    const matrix = world.player.getBoneTransform('head')
    matrix.copy = m => { world.leaked.push(m); return matrix }
    const hit = world.raycast()
    hit.point.copy = v => { world.leaked.push(v); return hit.point }
    const second = world.player.position
    const again = world.raycast()
    return {
      distinct: first !== second && matrix !== world.player.getBoneTransform('head') && hit.point !== again.point,
      ownKeys: Object.keys(second).filter(key => !['x', 'y', 'z'].includes(key) && typeof second[key] === 'function'),
      protoFrozen: Object.isFrozen(Object.getPrototypeOf(second)),
      values: [second.x, second.y, second.z, again.point.x],
    }
  `,
    world
  )
  assert.equal(result.distinct, true)
  assert.deepEqual(result.ownKeys, [], 'a new object carries no script method')
  assert.equal(result.protoFrozen, true)
  assert.deepEqual(result.values, [1, 2, 3, 4])
  assert.deepEqual(world.leaked, [], 'no host object reached a script function')
  assert.deepEqual(base.position.toArray(), [1, 2, 3])
  assert.deepEqual(hit.point.toArray(), [4, 5, 6])
})
