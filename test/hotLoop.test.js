import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadClient } from './lib/clientHarness.mjs'
import { getPhysicsTrapCount, handlePhysicsFailure } from '../src/core/extras/physicsFailure.js'
import { briefError } from '../src/core/extras/logOnce.js'
import { serializeError } from '../src/core/extras/serializeError.js'
import * as fallback from '../src/core/extras/playerAvatarFallback.js'

// the real World frame-loop methods (the systems are never constructed: the world is made from the prototype)
// and the real player avatar fallback
const m = {
  World: loadClient('core/World.js', 'World', {
    EventEmitter,
    getPhysicsTrapCount,
    handlePhysicsFailure,
    briefError,
    serializeError,
  }),
  ...fallback,
}

const PHASES = ['fixedUpdate', 'update', 'lateUpdate', 'postLateUpdate']

function loopWorld() {
  const world = Object.create(m.World.prototype)
  world.hot = new Set()
  world.systems = []
  world.fatalError = null
  return world
}

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

// an item that counts its calls and throws in the given phases
function item(throwIn = [], extra = {}) {
  const calls = Object.fromEntries(PHASES.map(phase => [phase, 0]))
  const it = { calls, ...extra }
  for (const phase of PHASES) {
    it[phase] = () => {
      calls[phase]++
      if (throwIn.includes(phase)) throw new Error(`${phase} boom`)
    }
  }
  return it
}

function runFrames(world, frames = 3) {
  for (let i = 0; i < frames; i++) for (const phase of PHASES) world[phase](1 / 60)
}

test('hot loop: a throwing item stops only itself; the rest keep updating', () => {
  for (const phase of PHASES) {
    const world = loopWorld()
    const before = item()
    const bad = item([phase], { id: 'bad' })
    const afterIt = item()
    world.hot.add(before)
    world.hot.add(bad)
    world.hot.add(afterIt)
    const lines = quietly(() => runFrames(world))
    assert.equal(world.hot.has(bad), false, `${phase}: the throwing item left the hot set`)
    assert.equal(bad.calls[phase], 1)
    for (const ok of [before, afterIt]) for (const p of PHASES) assert.equal(ok.calls[p], 3, `${phase}/${p}`)
    assert.equal(lines.length, 1, 'logged once')
    assert.match(lines[0], new RegExp(`${phase} \\(item bad\\) failed`))
  }
})

test("hot loop: an app's item crashes the app through its crash path", () => {
  const world = loopWorld()
  const app = {
    isApp: true,
    data: { id: 'app' },
    crashed: false,
    crash() {
      this.crashed = true
      world.hot.delete(this) // App.crash leaves the hot set
    },
  }
  const node = item(['lateUpdate'], { ctx: { entity: app } })
  const other = item()
  world.hot.add(node)
  world.hot.add(other)
  world.hot.add(Object.assign(item(['update']), app))
  quietly(() => runFrames(world))
  assert.equal(app.crashed, true)
  assert.equal(app.scriptError.message, 'lateUpdate boom')
  assert.equal(world.hot.has(node), false)
  assert.equal(other.calls.postLateUpdate, 3)
  // the app entity itself throwing (host code inside App.update) crashes it too
  const world2 = loopWorld()
  const failing = Object.assign(item(['update']), {
    isApp: true,
    data: { id: 'a2' },
    crash() {
      this.crashed = true
      world2.hot.delete(this)
    },
  })
  world2.hot.add(failing)
  quietly(() => runFrames(world2))
  assert.equal(failing.crashed, true)
  assert.equal(failing.calls.update, 1)
})

// a player as the frame loop sees it, with the real fallback state machine; loads settle when told
function player(world, { avatar = 'https://example.com/hostile.vrm' } = {}) {
  const loads = []
  const p = Object.assign(item(['update']), {
    isPlayer: true,
    data: { id: 'p1', avatar },
    avatarUrl: avatar,
    applyAvatar() {
      const url = m.playerAvatarUrl(p)
      if (p.avatarUrl === url) return
      loads.push(() => {
        p.avatarUrl = url
        m.avatarSettled(p, url)
      })
    },
    fallBackToDefaultAvatar() {
      return m.switchToBuiltinAvatar(p)
    },
  })
  world.hot.add(p)
  return { p, loads }
}

test('hot loop: a throwing player stays hot on the built-in avatar, and leaves only if that throws too', () => {
  const world = loopWorld()
  const { p, loads } = player(world)
  const other = item()
  world.hot.add(other)
  const lines = quietly(() => runFrames(world))
  assert.equal(world.hot.has(p), true, 'not dropped while the built-in avatar loads')
  assert.equal(p.calls.update, 3)
  assert.equal(loads.length, 1, 'one switch to the built-in avatar')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /using the default avatar/)
  loads[0]()
  assert.equal(p.avatarUrl, m.BUILTIN_AVATAR_URL)
  // still throwing with the built-in avatar: now it leaves the hot set
  const more = quietly(() => runFrames(world))
  assert.equal(world.hot.has(p), false)
  assert.match(more[0], /stopped updating/)
  assert.equal(other.calls.update, 6)
})

test('hot loop: a player already on the built-in avatar gets one more frame, then leaves', () => {
  const world = loopWorld()
  const { p, loads } = player(world, { avatar: m.BUILTIN_AVATAR_URL })
  quietly(() => runFrames(world, 1))
  assert.equal(world.hot.has(p), true)
  quietly(() => runFrames(world, 1))
  assert.equal(world.hot.has(p), false)
  assert.equal(loads.length, 0)
})

test("hot loop: a player's avatar instance that throws is dropped and the player switches avatar", () => {
  const world = loopWorld()
  const { p, loads } = player(world)
  p.update = () => {} // the player itself is fine
  const instance = item(['update'], { hotOwner: { ctx: { entity: p } } })
  world.hot.add(instance)
  quietly(() => runFrames(world))
  assert.equal(world.hot.has(instance), false)
  assert.equal(world.hot.has(p), true)
  assert.equal(loads.length, 1)
})

test('hot loop: a world without failures behaves as before', () => {
  const world = loopWorld()
  const items = Array.from({ length: 50 }, () => item())
  for (const it of items) world.hot.add(it)
  runFrames(world, 10)
  assert.ok(items.every(it => PHASES.every(phase => it.calls[phase] === 10)))
  assert.equal(world.hot.size, 50)
})

test('client tick: an exception out of world.tick is logged and the animation loop keeps its callback', () => {
  const Client = loadClient('core/systems/Client.js', 'Client', {
    briefError,
    initYoga() {},
    window: {},
    document: { addEventListener() {}, removeEventListener() {} },
  })
  let loop
  let throws = true
  let ticks = 0
  const world = {
    fatalError: null,
    accumulator: 0.5,
    settings: { on() {} },
    graphics: { renderer: { setAnimationLoop: fn => (loop = fn) } },
    tick() {
      ticks++
      if (throws) throw new Error('frame boom')
    },
  }
  const client = new Client(world)
  client.start()
  assert.equal(loop, client.tick)
  const lines = quietly(() => {
    for (let i = 0; i < 5; i++) loop(i * 16)
  })
  assert.equal(ticks, 5)
  assert.equal(world.accumulator, 0)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /\[client\] tick failed: frame boom/)
  throws = false
  loop(100)
  assert.equal(ticks, 6)
})
