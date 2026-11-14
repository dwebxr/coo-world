import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { bundleServer } from './lib/serverBundle.mjs'
import { loadClient } from './lib/clientHarness.mjs'
import { getPhysicsTrapCount, handlePhysicsFailure } from '../src/core/extras/physicsFailure.js'
import { briefError } from '../src/core/extras/logOnce.js'
import { serializeError } from '../src/core/extras/serializeError.js'

// A player's avatar where the loader is ServerLoader (the server's, and the node client's): every avatar url gives the
// same stand-in, an Avatar node with no factory, which never has an instance. Here: the real PlayerRemote (applyAvatar,
// modify, update, lateUpdate), the real ServerLoader, the real Avatar, group, nametag and ui nodes, the real handle a
// server script gets for the player (createPlayerProxy) and the real World.hotFailed. The player is made as
// PlayerRemote.init makes the parts its avatar uses (the base, the name and the bubble, both mounted) and then asks for
// its avatar as init does; its physics body is left out (its mount needs PhysX), and nothing here reads it.
// What the server had before #51 (6b4a892a), for a player on the stand-in: the stand-in as its avatar and its url,
// the name and the bubble at 0.2 with the name shown, and for a server script `height` and `headToHeight` null. Not
// as before #51: a stand-in that is replaced leaves the player (it stayed under it, deactivated).

let bundle
let m
const globals = {}
before(async () => {
  bundle = await bundleServer(`
    export { PlayerRemote } from './src/core/entities/PlayerRemote'
    export { ServerLoader } from './src/core/systems/ServerLoader'
    export { createNode } from './src/core/extras/createNode'
    export { createPlayerAura } from './src/core/extras/playerAura'
    export { createPlayerProxy } from './src/core/extras/createPlayerProxy'
    export { BufferedLerpVector3 } from './src/core/extras/BufferedLerpVector3'
    export { BufferedLerpQuaternion } from './src/core/extras/BufferedLerpQuaternion'
    export { BUILTIN_AVATAR_URL } from './src/core/extras/playerAvatarFallback'
    export * as THREE from './src/core/extras/three'
  `)
  m = bundle.module
  // ServerLoader's constructor sets these for the model parser, as on the server; they are put back afterwards
  for (const name of ['self', 'window', 'document']) globals[name] = Object.getOwnPropertyDescriptor(globalThis, name)
})
after(() => {
  for (const [name, descriptor] of Object.entries(globals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  bundle?.destroy()
})

// the real World frame-loop methods, the world made from the prototype (as test/hotLoop.test.js makes it)
const World = loadClient('core/World.js', 'World', {
  EventEmitter,
  getPhysicsTrapCount,
  handlePhysicsFailure,
  briefError,
  serializeError,
})

const WORLD_AVATAR = 'asset://world-default.vrm'
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

// what is said in the console while a test runs
function consoleLines(t) {
  const lines = []
  for (const level of ['error', 'warn']) {
    t.mock.method(console, level, (...args) => lines.push(args.map(arg => String(arg?.message ?? arg)).join(' ')))
  }
  return lines
}

// a world as a player's avatar sees it; `loads` lists the avatar urls asked of the loader. `loader`: another loader
// (the server's by default); `server`: whether the network is the server's
function makeWorld({ loader, server = true } = {}) {
  const world = Object.create(World.prototype)
  Object.assign(world, {
    network: { isServer: server, isClient: !server, id: server ? undefined : 'me' },
    stage: { dirtyNodes: new Set() },
    hot: new Set(),
    systems: [],
    fatalError: null,
    networkRate: 1 / 8,
    avatars: new Set(),
    events: { emit() {} },
  })
  world.emit = () => {}
  world.avatars.remove = world.avatars.delete
  world.loader = loader ?? new m.ServerLoader(world)
  const loads = []
  const load = world.loader.load.bind(world.loader)
  world.loader.load = (type, url) => {
    loads.push(url)
    return load(type, url)
  }
  return { world, loads }
}

// a remote player as PlayerRemote.init makes the parts its avatar uses, then asks for its avatar; `mounted: false`
// leaves its base out of the world
function join(world, avatar, { mounted = true } = {}) {
  const p = Object.create(m.PlayerRemote.prototype)
  Object.assign(p, {
    world,
    isPlayer: true,
    isRemote: true,
    data: { id: 'visitor', owner: 'visitor', name: 'Visitor', health: 100, avatar, sessionAvatar: null, emote: null },
  })
  p.base = m.createNode('group')
  Object.assign(p, m.createPlayerAura({ label: p.data.name, health: p.data.health }))
  p.aura.activate({ world, entity: p })
  if (mounted) p.base.activate({ world, entity: p })
  p.applyAvatar()
  p.position = new m.BufferedLerpVector3(p.base.position, world.networkRate * 1.5)
  p.quaternion = new m.BufferedLerpQuaternion(p.base.quaternion, world.networkRate * 1.5)
  p.teleport = 0
  p.mode = 0
  p.axis = new m.THREE.Vector3()
  p.gaze = new m.THREE.Vector3()
  world.setHot(p, true)
  return p
}

// the player's avatar is the one avatar node under it, mounted or not (compared by identity: a failed deepEqual of two
// node trees would print them whole)
function assertOneAvatarUnder(p, label) {
  const avatars = p.base.children.filter(node => node.name === 'avatar')
  assert.equal(avatars.length, 1, `${label}: one avatar under the player, not ${avatars.length}`)
  assert.ok(avatars[0] === p.avatar, `${label}: the player's own`)
}

// what a player on the server's stand-in has, as before #51
function assertOnStandIn(p, url, label) {
  const avatar = p.avatar
  assert.ok(avatar, `${label}: the player has an avatar`)
  assert.equal(avatar.name, 'avatar', label)
  assert.equal(avatar.factory, null, `${label}: the loader's stand-in`)
  assert.equal(avatar.instance, null, label)
  assert.ok(avatar.parent === p.base, `${label}: under the player`)
  assert.equal(avatar.mounted, true, label)
  assert.equal(p.avatarUrl, url, `${label}: with its url`)
  assert.equal(p.avatarFallback ?? null, null, `${label}: no fallback`)
  assert.equal(p.nametag.position.y, 0.2, `${label}: the name at 0.2`)
  assert.equal(p.bubble.position.y, 0.2, label)
  assert.equal(p.nametag.active, true, `${label}: and shown`)
  assert.equal(p.world.avatars.size, 0, `${label}: no avatar instance in the world`)
}

test('server: a joining player takes the stand-in its avatar url gives; nothing is reported, nothing else is loaded', async t => {
  const lines = consoleLines(t)
  for (const [label, avatar, url] of [
    ['the world avatar', WORLD_AVATAR, WORLD_AVATAR],
    ['no avatar (the built-in one)', null, m.BUILTIN_AVATAR_URL],
  ]) {
    const { world, loads } = makeWorld()
    const p = join(world, avatar)
    await settle()
    assert.deepEqual(lines, [], `${label}: nothing in the log`)
    assert.deepEqual(loads, [url], `${label}: its url loaded once, no built-in avatar after it`)
    assertOnStandIn(p, url, label)
    // the frame loop goes on with it: the emote is handed to the stand-in, which has no head to put the name over
    p.data.emote = 'asset://wave.glb'
    p.update(1 / 60)
    p.lateUpdate(1 / 60)
    assert.equal(p.avatar.emote, 'asset://wave.glb', label)
    assert.deepEqual(p.aura.position.toArray(), [0, 0, 0], label)
    assert.deepEqual(lines, [], label)
  }
})

test('server: what a server script reads of the player is what it read before #51', async t => {
  const lines = consoleLines(t)
  const { world } = makeWorld()
  const p = join(world, WORLD_AVATAR)
  const app = { deadHook: {}, getDeadHook: () => app.deadHook }
  const player = m.createPlayerProxy(app, p)
  await settle()
  assert.equal(player.height, null)
  assert.equal(player.headToHeight, null)
  assert.equal(player.getBoneTransform('head'), undefined)
  assert.deepEqual(lines, [])
})

test('server: an avatar change loads the new url once; the same url again, or a name, loads nothing', async t => {
  const lines = consoleLines(t)
  const { world, loads } = makeWorld()
  const p = join(world, WORLD_AVATAR)
  await settle()
  const first = p.avatar
  // a visitor's session avatar (ServerNetwork applies a changed one with modify), and a server script's
  p.modify({ sessionAvatar: 'asset://other.vrm' })
  await settle()
  assert.deepEqual(loads, [WORLD_AVATAR, 'asset://other.vrm'])
  assertOnStandIn(p, 'asset://other.vrm', 'the new avatar')
  assert.ok(p.avatar !== first, 'a stand-in of its own')
  assert.equal(first.mounted, false, 'the one before is unmounted')
  assert.ok(first.parent === null, 'and has left the player')
  assertOneAvatarUnder(p, 'after a change')
  // the same url, told again (a server script's setSessionAvatar applies it whatever the player has): nothing loads
  p.modify({ sessionAvatar: 'asset://other.vrm' })
  p.modify({ avatar: WORLD_AVATAR })
  p.modify({ name: 'Renamed' })
  await settle()
  assert.equal(loads.length, 2, 'nothing more was loaded')
  assertOnStandIn(p, 'asset://other.vrm', 'the same avatar')
  // back to the stored avatar: one load
  p.modify({ sessionAvatar: null })
  await settle()
  assert.deepEqual(loads.slice(2), [WORLD_AVATAR])
  assertOnStandIn(p, WORLD_AVATAR, 'the stored avatar')
  assert.deepEqual(lines, [])
})

// Before #51 the stand-in a change replaced stayed under the player, deactivated: one more node for every change,
// for as long as the player stayed, each gone through again whenever the player moved
test('server: a player whose avatar changes many times keeps one stand-in under it', async t => {
  const lines = consoleLines(t)
  const { world, loads } = makeWorld()
  const p = join(world, WORLD_AVATAR)
  await settle()
  for (let i = 0; i < 20; i++) {
    p.modify({ sessionAvatar: `asset://choice-${i % 2}.vrm` })
    await settle()
  }
  assert.equal(loads.length, 21)
  assertOnStandIn(p, 'asset://choice-1.vrm', 'the last choice')
  assertOneAvatarUnder(p, 'after twenty changes')
  // and after a switch to the built-in avatar (World.hotFailed)
  world.hotFailed(p, 'update', new Error('boom'))
  await settle()
  assert.equal(p.avatarUrl, m.BUILTIN_AVATAR_URL)
  assertOneAvatarUnder(p, 'after the switch')
  assert.equal(lines.length, 1, 'the frame loop says the player failed, and nothing else is said')
})

test('server: a player that throws in the frame loop is kept once, on the built-in avatar, and dropped the second time', async t => {
  const lines = consoleLines(t)
  const { world, loads } = makeWorld()
  const p = join(world, WORLD_AVATAR)
  await settle()
  world.hotFailed(p, 'update', new Error('boom'))
  assert.equal(world.hot.has(p), true, 'kept')
  await settle()
  assert.deepEqual(loads, [WORLD_AVATAR, m.BUILTIN_AVATAR_URL])
  assert.equal(p.avatarUrl, m.BUILTIN_AVATAR_URL)
  assert.equal(p.avatarFallback, 'ready')
  assert.equal(p.avatar.factory, null)
  world.hotFailed(p, 'update', new Error('boom again'))
  assert.equal(world.hot.has(p), false, 'dropped')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /\[world\] update \(player visitor\) failed, using the default avatar: boom/)
  assert.match(lines[1], /\[world\] update \(player visitor\) failed and stopped updating: boom again/)
})

// The rule that decides is the avatar's factory, not where it runs. An avatar that has one and was not mounted (its
// player's base is out of the world) is a failed mount, in a browser's world and in the server's: reported, and the
// built-in avatar asked for (whose load fails the same way here). The stand-in, with no factory, is taken in both.
test('an avatar with a factory and no instance after its mount is still a failed mount; the stand-in is not, anywhere', async t => {
  const lines = consoleLines(t)
  // a loader that gives an avatar with a factory (as ClientLoader's buildAvatarResult does) for every url
  const factoryLoader = () => ({
    load: async () => {
      const root = m.createNode('group', { id: '$root' })
      root.add(m.createNode('avatar', { id: 'avatar', factory: { create: () => ({}) }, hooks: {} }))
      return { toNodes: () => root.clone(true) }
    },
  })
  for (const server of [false, true]) {
    const where = server ? 'the server' : 'a browser'
    const { world, loads } = makeWorld({ loader: factoryLoader(), server })
    const p = join(world, WORLD_AVATAR, { mounted: false })
    await settle()
    assert.deepEqual(loads, [WORLD_AVATAR, m.BUILTIN_AVATAR_URL], `${where}: the built-in avatar was asked for`)
    assert.equal(p.avatar, undefined, where)
    assert.equal(p.avatarUrl, undefined, where)
    assert.equal(p.avatarFallback, 'ready', `${where}: nothing left to try`)
    assert.deepEqual(
      lines.splice(0),
      [`[avatar] ${WORLD_AVATAR} could not be mounted`, `[avatar] ${m.BUILTIN_AVATAR_URL} could not be mounted`],
      where
    )

    const standIn = makeWorld({ server })
    const q = join(standIn.world, WORLD_AVATAR, { mounted: false })
    await settle()
    assert.deepEqual(standIn.loads, [WORLD_AVATAR], where)
    assert.equal(q.avatarUrl, WORLD_AVATAR, `${where}: the stand-in is taken`)
    assert.equal(q.avatar?.factory, null, where)
    assert.deepEqual(lines, [], where)
  }
})
