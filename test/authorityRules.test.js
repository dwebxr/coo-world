// Who may do what (ServerNetwork's authority members: the chat commands, `/admin` among them, a change of rank, kick
// and mute, the builder check, the default avatar and what a player who stops being a builder keeps), where no test
// asked before: each of these was found by a mutant that every test passed (P16-8), and each test's name says the
// rule. The real class with players that joined through the real onConnection (test/lib/joinFixture.mjs: the real
// Entities and Settings, stand-in player entities). Nothing here depends on real time: a wait of the admin code's brake
// is measured on a mocked clock, and a budget on the arrival time a packet is given. Each test has a limit of 30 s,
// a budget for a loaded machine: a mutant that keeps what a test awaits from ever settling fails it there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ranks } from '../src/core/extras/ranks.js'
import { fixture, sentTo } from './lib/joinFixture.mjs'

const CODE = 'p16-authority-admin-code'
const ASSETS = 'https://world.example/assets'
const OUTSIDE = 'https://elsewhere.example/a.vrm'
const WORLD_AVATAR = 'asset://the-worlds-own.vrm'

// A world with an admin code (so a visitor is a visitor) and the players asked for: `enter(id, rank, stored)` joins a
// user of that rank (with `stored`, the avatar its row holds)
function stage(t, { env = {} } = {}) {
  const f = fixture(t, { env: { ADMIN_CODE: CODE, ASSETS_BASE_URL: ASSETS, ...env } })
  f.world.settings.setHasAdminCode(true)
  f.world.settings.rank = Ranks.VISITOR
  f.enter = async (id, rank = Ranks.VISITOR, stored = null) => {
    f.users.set(id, { id, name: id, avatar: stored, rank })
    const joined = await f.join({ authToken: id })
    assert.equal(joined.method, 'onSnapshot', `${id} joined`)
    const socket = f.network.sockets.get(id)
    socket.ws.packets.length = 0
    return socket
  }
  f.player = socket => f.world.entities.get(socket.id)
  return f
}

// what a connection has been told since the last call, as [method, data]
const told = socket => {
  for (let i = 0; i < 10 && socket.ws.pending.length; i++) socket.ws.drain()
  const packets = sentTo(socket)
  socket.ws.packets.length = 0
  return packets
}
const lines = packets => packets.filter(([method]) => method === 'onChatAdded').map(([, line]) => line)

test(
  "the default avatar is the world's own: a visitor whose avatar is outside the world joins wearing it, and so does a builder who stops being one",
  { timeout: 30000 },
  async t => {
    const f = stage(t)
    f.world.settings.avatar = { url: WORLD_AVATAR }
    const visitor = await f.enter('visitor1', Ranks.VISITOR, OUTSIDE)
    assert.equal(f.player(visitor).data.avatar, WORLD_AVATAR)
    const builder = await f.enter('builder1', Ranks.BUILDER, OUTSIDE)
    assert.equal(f.player(builder).data.avatar, OUTSIDE, 'a builder wears it')
    await f.network.onModifyRank(f.builder, { playerId: 'builder1', rank: Ranks.VISITOR })
    assert.equal(f.player(builder).data.avatar, WORLD_AVATAR)
    const change = told(visitor).filter(([method, data]) => method === 'onEntityModified' && !('rank' in data))
    assert.deepEqual(change, [['onEntityModified', { id: 'builder1', avatar: WORLD_AVATAR }]], 'another player is told')
    assert.equal(f.users.get('builder1').avatar, OUTSIDE, 'the stored value is left alone')
  }
)

test(
  'what a former builder keeps: a player who has left is neither changed nor told about',
  { timeout: 30000 },
  async t => {
    const f = stage(t)
    const watcher = await f.enter('watcher1')
    const builder = await f.enter('builder1', Ranks.BUILDER, OUTSIDE)
    const player = f.player(builder)
    player.data.rank = Ranks.VISITOR
    // it leaves; the player object a caller may still hold is the one that left
    builder.ws.terminate()
    assert.equal(player.destroyed, true)
    told(watcher)
    f.network.dropBuilderUrls(player)
    assert.equal(player.data.avatar, OUTSIDE)
    assert.deepEqual(told(watcher), [])
  }
)

test(
  "/admin: the brake's waits are the environment's: ADMIN_ATTEMPT_WAIT_SCALE shortens them outside production, and not in it",
  { timeout: 30000 },
  async t => {
    const clock = { now: 0 }
    t.mock.method(performance, 'now', () => clock.now)
    for (const production of [false, true]) {
      clock.now = 1000
      const f = stage(t, {
        env: { ADMIN_ATTEMPT_WAIT_SCALE: '0.01', ...(production ? { NODE_ENV: 'production' } : {}) },
      })
      const visitor = await f.enter('visitor1')
      for (let i = 0; i < 3; i++) await f.network.onCommand(visitor, { args: ['admin', 'wrong'] })
      // the third wrong code starts a wait of 10 s, a hundredth of it where the factor holds
      clock.now += 101
      await f.network.onCommand(visitor, { args: ['admin', CODE] })
      assert.equal(f.player(visitor).data.rank, production ? Ranks.VISITOR : Ranks.ADMIN, `production: ${production}`)
      if (!production) continue
      clock.now = 1000 + 10000
      await f.network.onCommand(visitor, { args: ['admin', CODE] })
      assert.equal(f.player(visitor).data.rank, Ranks.ADMIN, 'production: after the whole wait')
    }
  }
)

// a line of the system's own, as the client shows it: no sender, an id and a time of the server's
const systemLine = (line, body) => {
  assert.deepEqual(
    { ...line, id: typeof line.id, createdAt: typeof line.createdAt },
    { id: 'string', kind: 'system', from: null, fromId: null, body, createdAt: 'string' },
    body
  )
  assert.ok(!Number.isNaN(Date.parse(line.createdAt)), 'a time')
}

test(
  "a command's answers are lines of the system to the sender alone: the admin code's, a name's, the process figures, a locked world's refusal",
  { timeout: 30000 },
  async t => {
    const f = stage(t)
    f.world.monitor = { getStats: async () => ({ currentCPU: 12.34567, currentMemory: 100, maxMemory: 400 }) }
    const watcher = await f.enter('watcher1')
    const visitor = await f.enter('visitor1')
    const builder = await f.enter('builder1', Ranks.BUILDER)
    await f.network.onCommand(visitor, { args: ['admin', 'wrong'] }, { at: 1000 })
    await f.network.onCommand(visitor, { args: ['admin', CODE] }, { at: 1000 })
    await f.network.onCommand(visitor, { args: ['name', 'Ada'] }, { at: 1000 })
    await f.network.onCommand(builder, { args: ['server', 'stats'] }, { at: 1000 })
    const [wrong, granted, named] = lines(told(visitor))
    systemLine(wrong, 'Wrong admin code.')
    systemLine(granted, 'Admin granted!')
    systemLine(named, 'Name set to Ada!')
    const [cpu, memory, ...more] = lines(told(builder))
    systemLine(cpu, 'CPU: 12.346%')
    systemLine(memory, 'Memory: 100 / 400 MB (25.0%)')
    assert.deepEqual(more, [])
    assert.deepEqual(lines(told(watcher)), [], 'nobody else is told any of it')
    // where no admin code is set, the refusal of an admin's own lowering
    f.network.admin().mode = 'locked'
    await f.network.onModifyRank(visitor, { playerId: 'visitor1', rank: Ranks.BUILDER }, { at: 1000 })
    const [locked] = lines(told(visitor))
    systemLine(locked, 'This world has no admin code: you could not become admin again. Your rank was not changed.')
    assert.deepEqual(lines(told(watcher)), [])
  }
)

test(
  '/admin: a toggle is counted with kicks, mutes and changes of rank, in their budget',
  { timeout: 30000 },
  async t => {
    const f = stage(t)
    f.world.livekit.setMuted = () => {}
    const admin = await f.enter('admin1', Ranks.ADMIN)
    await f.enter('visitor1')
    // the moderation budget's ten at once, used by mutes
    for (let i = 0; i < 10; i++) f.network.onMute(admin, { playerId: 'visitor1', muted: i % 2 === 0 }, { at: 1000 })
    await f.network.onCommand(admin, { args: ['admin', CODE] }, { at: 1000 })
    assert.equal(f.player(admin).data.rank, Ranks.ADMIN, 'not toggled')
    assert.deepEqual(
      lines(told(admin)).map(line => line.body),
      ['You are changing ranks too fast.']
    )
    // half a second later the budget has one more (two a second)
    await f.network.onCommand(admin, { args: ['admin', CODE] }, { at: 1500 })
    assert.equal(f.player(admin).data.rank, Ranks.VISITOR, 'toggled')
  }
)

test(
  "/spawn: counted with the settings at the arrival of the packet that carried it, as the spawn's own packet is",
  { timeout: 30000 },
  async t => {
    // the server's clock stands still: only the packets' arrival times move
    t.mock.method(performance, 'now', () => 1000)
    const f = stage(t)
    const saved = []
    f.network.saveConfig = async (key, value) => (saved.push([key, value]), true)
    const builder = await f.enter('builder1', Ranks.BUILDER)
    // the settings budget's thirty at once, used by the spawn's own packet
    for (let i = 0; i < 30; i++) await f.network.onSpawnModified(builder, 'clear', { at: 1000 })
    assert.equal(saved.length, 30)
    told(builder)
    await f.network.onCommand(builder, { args: ['spawn', 'set'] }, { at: 1000 })
    assert.equal(saved.length, 30, 'over the budget')
    assert.deepEqual(
      lines(told(builder)).map(line => line.body),
      ['You are changing the spawn too fast.']
    )
    // 400 ms later the budget has two more (five a second)
    await f.network.onCommand(builder, { args: ['spawn', 'set'] }, { at: 1400 })
    assert.equal(saved.length, 31)
  }
)

test(
  '/name: a name is cut to 64 characters, and one with nothing visible in it changes nothing and is not answered',
  { timeout: 30000 },
  async t => {
    const f = stage(t)
    const watcher = await f.enter('watcher1')
    const visitor = await f.enter('visitor1')
    await f.network.onCommand(visitor, { args: ['name', 'n'.repeat(100)] }, { at: 1000 })
    assert.equal(f.player(visitor).data.name, 'n'.repeat(64))
    assert.deepEqual(told(watcher), [['onEntityModified', { id: 'visitor1', name: 'n'.repeat(64) }]])
    assert.deepEqual(
      lines(told(visitor)).map(line => line.body),
      [`Name set to ${'n'.repeat(64)}!`]
    )
    await f.network.onCommand(visitor, { args: ['name', '\u200b\u200b'] }, { at: 1000 })
    assert.equal(f.player(visitor).data.name, 'n'.repeat(64))
    assert.deepEqual(told(watcher), [])
    assert.deepEqual(told(visitor), [])
    await f.network.userRows().idle()
    assert.deepEqual(f.store.userUpdates, [{ id: 'visitor1', changes: { name: 'n'.repeat(64) } }])
  }
)

test(
  'rank and mute: a payload that is not an object is dropped, the handler ending without a failure',
  { timeout: 30000 },
  async t => {
    const f = stage(t)
    const muted = []
    f.world.livekit.setMuted = (...args) => muted.push(args)
    const admin = await f.enter('admin1', Ranks.ADMIN)
    await f.enter('visitor1')
    for (const payload of [null, undefined, 7, 'visitor1', true]) {
      assert.equal(await f.network.onModifyRank(admin, payload, { at: 1000 }), undefined)
      assert.equal(f.network.onMute(admin, payload, { at: 1000 }), undefined)
    }
    assert.deepEqual(muted, [])
    assert.equal(f.world.entities.get('visitor1').data.rank, Ranks.VISITOR)
    assert.deepEqual(f.logs, [])
  }
)

test(
  'rank: only visitor, builder or admin; any other value changes nothing, and an admin is made by the right one',
  { timeout: 30000 },
  async t => {
    const f = stage(t)
    const admin = await f.enter('admin1', Ranks.ADMIN)
    const visitor = await f.enter('visitor1')
    for (const rank of [3, -1, 1.5, NaN, Infinity, '1', null, true, undefined]) {
      await f.network.onModifyRank(admin, { playerId: 'visitor1', rank }, { at: 1000 })
    }
    assert.equal(f.player(visitor).data.rank, Ranks.VISITOR)
    assert.deepEqual(told(visitor), [], 'nobody is told')
    assert.equal(f.store.userUpdates, undefined, 'nothing is stored')
    await f.network.onModifyRank(admin, { playerId: 'visitor1', rank: Ranks.ADMIN }, { at: 1000 })
    assert.equal(f.player(visitor).data.rank, Ranks.ADMIN)
    assert.deepEqual(told(visitor), [['onEntityModified', { id: 'visitor1', rank: Ranks.ADMIN }]])
    await f.network.userRows().idle()
    assert.deepEqual(f.store.userUpdates, [{ id: 'visitor1', changes: { rank: Ranks.ADMIN } }])
  }
)

test(
  'kick: one refused over the budget is not answered (the players pane shows who is still here); the next refusal that is, is',
  { timeout: 30000 },
  async t => {
    const f = stage(t)
    f.world.livekit.setMuted = () => {}
    const admin = await f.enter('admin1', Ranks.ADMIN)
    await f.enter('visitor1')
    await f.enter('visitor2')
    // the moderation budget's ten at once, used by mutes
    for (let i = 0; i < 10; i++) f.network.onMute(admin, { playerId: 'visitor1', muted: i % 2 === 0 }, { at: 1000 })
    f.network.onKick(admin, 'visitor2', { at: 1000 })
    assert.equal(f.network.sockets.has('visitor2'), true, 'not kicked')
    assert.deepEqual(lines(told(admin)), [])
    await f.network.onModifyRank(admin, { playerId: 'visitor1', rank: Ranks.BUILDER }, { at: 1000 })
    assert.deepEqual(
      lines(told(admin)).map(line => line.body),
      ['You are changing ranks too fast.']
    )
  }
)

test("rank: of a player only: an app's id changes nothing, and nobody is told", { timeout: 30000 }, async t => {
  const f = stage(t)
  const admin = await f.enter('admin1', Ranks.ADMIN)
  const watcher = await f.enter('watcher1')
  const app = f.world.entities.add({
    id: 'app1',
    type: 'app',
    blueprint: 'bp',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    mover: null,
    uploader: null,
    pinned: false,
    state: {},
  })
  told(watcher)
  await f.network.onModifyRank(admin, { playerId: 'app1', rank: Ranks.BUILDER }, { at: 1000 })
  assert.equal('rank' in app.data, false)
  assert.deepEqual(told(watcher), [])
  assert.equal(f.store.userUpdates, undefined)
})
