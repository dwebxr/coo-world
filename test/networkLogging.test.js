import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { createLogOnce } from '../src/core/extras/logOnce.js'
import { Ranks } from '../src/core/extras/ranks.js'
import { inside, loadNetwork, makeNetwork } from './lib/network.mjs'

// The real network (test/lib/network.mjs). What the old harness gave the class is given the same way here: an admin
// code in the environment, and the token gate switched on through a stand-in of its module (the rest of it is the
// real module's)
const SOLANA = 'src/server/solana-gating.js'
const net = await loadNetwork({ standIns: [SOLANA] })

function fixture(t) {
  const lines = []
  const calls = []
  // plain lines of the server's log (console.error): none, unless the test says it expects some
  const server = { lines: null }
  const entities = new Map()
  // What the class must not touch of a thrown value or a packet fails the test when it is touched. The class reads
  // such values inside catches of its own (briefError catches what reading an error throws), so each check is made
  // through inside(), which also reports it at the end of the test.
  const touched = what => inside(t, () => assert.fail(what))
  const failure = {
    get message() {
      return touched('thrown message getter')
    },
    toString() {
      touched('thrown value coerced')
    },
    toJSON() {
      touched('thrown value serialized')
    },
    [inspect.custom]() {
      touched('thrown value inspected')
    },
  }
  const db = () => ({
    where: () => ({
      update: async () => {
        throw failure
      },
    }),
    insert: () => ({
      onConflict: () => ({
        merge: async () => {
          throw failure
        },
      }),
    }),
  })
  const network = makeNetwork(t, {
    net,
    env: { ADMIN_CODE: 'code' },
    modules: { [SOLANA]: { TOKEN_GATING_ENABLED: true, clearWallet() {} } },
    // (the token gate is on: no balance is read in these tests)
    init: { db, tokenBalanceService: { get: () => touched('a token balance read') } },
    world: {
      blueprints: { get() {} },
      entities: { get: id => entities.get(id) },
      settings: {},
      events: { emit() {} },
    },
    // the server's log (console.error; the constructor's own once-per-subject lines too)
    // (the class writes some of these lines inside catches of its own: the user rows' failures)
    log: line => {
      if (!server.lines) touched('refusals must go through logOnce')
      inside(t, () => assert.equal(typeof line, 'string'))
      server.lines.push(line)
    },
  })
  // and nothing else of the console: the class's console under the old harness had only `error`, so a line on any
  // other of its methods failed the test. Every other method of the console, as it has them now (a method added to
  // it later is covered too)
  for (const method of Object.keys(console)) {
    if (method === 'error' || method === 'Console' || typeof console[method] !== 'function') continue
    t.mock.method(console, method, () => touched(`console.${method} in a handler`))
  }
  network.loadedConfig.set('spawn', null)
  const once = createLogOnce(line => {
    inside(t, () => assert.equal(typeof line, 'string'))
    lines.push(line)
  })
  network.logOnce = (subject, key, line) => {
    calls.push({ subject, key })
    return once(subject, key, line)
  }
  network.send = () => {}
  const socket = (id = 'socket') => ({
    id,
    player: {
      data: { id, userId: id, position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      rankRevision: 0,
      isPlayer: true,
      isBuilder: () => true,
      isAdmin: () => true,
      modify() {},
    },
    send() {},
  })
  return {
    network,
    lines,
    calls,
    entities,
    socket,
    packet: fields => packet(touched, fields),
    serverLines: () => (server.lines = []),
  }
}

// Packet payloads must never be coerced, serialized, inspected or enumerated for a refusal log (`touched`: the
// fixture's check, made through inside())
function packet(touched, fields) {
  return new Proxy(
    {
      ...fields,
      toString() {
        touched('packet coerced')
      },
      toJSON() {
        touched('packet serialized')
      },
      [inspect.custom]() {
        touched('packet inspected')
      },
    },
    {
      ownKeys() {
        touched('packet enumerated')
      },
    }
  )
}

const refusals = [
  [
    'blueprint-missing',
    'onBlueprintModified: no blueprint found',
    (f, s, id) => {
      // Blueprint ids now pass through the policy before lookup (at most 64 characters).
      return f.network.onBlueprintModified(s, { id: id.slice(0, 64) })
    },
  ],
  [
    'entity-missing',
    'onEntityModified: no entity found',
    (f, s, id) => {
      return f.network.onEntityModified(s, f.packet({ id }))
    },
  ],
  [
    'entity-invalid',
    'onEntityAdded: invalid entity',
    (f, s, id) => {
      return f.network.onEntityAdded(s, f.packet({ id, type: 'player' }))
    },
  ],
  [
    'entity-fields',
    'onEntityModified: no permitted fields',
    (f, s, id) => {
      f.entities.set(id, s.player)
      return f.network.onEntityModified(s, f.packet({ id }))
    },
  ],
  [
    'entity-fields',
    'onEntityModified: no permitted fields',
    (f, s, id) => {
      f.entities.set(id, { isApp: true, data: { id } })
      return f.network.onEntityModified(s, f.packet({ id }))
    },
  ],
  [
    'entity-fields',
    'onEntityModified: no permitted fields',
    (f, s, id) => {
      s.player.isBuilder = () => false
      f.entities.set(id, { isApp: true, data: { id, mover: s.id } })
      return f.network.onEntityModified(s, f.packet({ id }))
    },
  ],
  [
    'setting-unknown',
    'onSettingsModified: unknown setting',
    (f, s, id) => {
      return f.network.onSettingsModified(s, f.packet({ key: id }))
    },
  ],
]

for (const [index, [key, message, refuse]] of refusals.entries()) {
  test(`handler logging ${index}: ${message} logs bounded ids once per socket and key`, async t => {
    const f = fixture(t)
    const a = f.socket()
    const b = f.socket() // the same user reconnecting is a new log subject
    const id = 'i'.repeat(64) + 'secret-packet-tail'.repeat(1000)
    for (const s of [a, b]) {
      await refuse(f, s, id)
      await refuse(f, s, 'different-id'.repeat(100))
      await refuse(f, s, id)
    }
    // the id as previewValue gives it: quoted, cut at 64 characters with a mark (a blueprint id reaches its handler
    // already cut to 64 by the policy, so it has no mark)
    const shown = JSON.stringify('i'.repeat(64) + (key === 'blueprint-missing' ? '' : '...'))
    assert.deepEqual(f.lines, Array(2).fill(`${message}: ${shown}`))
    assert.ok(f.calls.every(call => call.key === key && (call.subject === a || call.subject === b)))
  })
}

test('handler logging: an id with a line break or control characters cannot start a log line of its own', async t => {
  const f = fixture(t)
  const s = f.socket()
  const forged = 'x\n[network] admin granted to everyone\r\u001b[2J\u2028y'
  await f.network.onEntityModified(s, f.packet({ id: forged }))
  await f.network.onSettingsModified(s, f.packet({ key: forged }))
  assert.equal(f.lines.length, 2)
  for (const line of f.lines) {
    assert.ok(!['\n', '\r', '\u001b', '\u2028'].some(character => line.includes(character)), JSON.stringify(line))
    assert.match(line, /: "x\?\[network\] admin granted to everyone\?\?\[2J\?y"$/)
  }
})

test('handler logging: builder refusals use builder:<action> and a bounded socket id', t => {
  const f = fixture(t)
  for (const s of [f.socket('s'.repeat(1000)), f.socket('s'.repeat(1000))]) {
    s.player.isBuilder = () => false
    for (const action of [
      'add blueprint',
      'modify blueprint',
      'add entity',
      'remove entity',
      'modify settings',
      'modify spawn',
      'use ai',
    ]) {
      for (let i = 0; i < 3; i++) assert.equal(f.network.requireBuilder(s, action), false)
      assert.equal(f.calls.at(-1).key, `builder:${action}`)
    }
  }
  assert.equal(f.lines.length, 14)
  assert.ok(f.lines.every(line => line.endsWith(`: ${JSON.stringify('s'.repeat(64) + '...')}`)))
  const builder = f.socket()
  assert.equal(f.network.requireBuilder(builder, 'add blueprint'), true)
  assert.equal(f.lines.length, 14)
})

test('handler logging: all refusal reasons are independently logged once per socket', async t => {
  const f = fixture(t)
  const s = f.socket()
  s.player.isAdmin = () => false
  const refuse = async () => {
    await f.network.onEntityModified(s, null)
    f.entities.set('other', { isPlayer: true })
    await f.network.onEntityModified(s, f.packet({ id: 'other' }))
    f.network.onEntityRemoved(s, 'other')
    f.network.onSettingsModified(s, f.packet({ key: 'rank', value: 0 }))
    f.network.onSettingsModified(s, f.packet({ key: 'voice', value: false }))
    await f.network.onRequestBuilderByToken(s, f.packet({}))
    s.player.isBuilder = () => false
    f.entities.set('app', { isApp: true, data: {} })
    await f.network.onEntityModified(s, f.packet({ id: 'app' }))
    f.network.onAi(s, f.packet({}))
    s.player.isBuilder = () => true
  }
  await refuse()
  assert.equal(f.lines.length, 8)
  assert.equal(new Set(f.calls.map(call => call.key)).size, 8)
  await refuse()
  assert.equal(f.lines.length, 8)
})

test('handler logging: caught handler failures use briefError, and logOnce or the once-per-run rule of the user rows', async t => {
  const f = fixture(t)
  const serverLines = f.serverLines()
  const s = f.socket()
  f.entities.set(s.id, s.player)
  const fail = async () => {
    await f.network.onEntityModified(s, { id: s.id, name: 'new-name' })
    await f.network.onCommand(s, { args: ['name', 'new-name'] })
    await f.network.onCommand(s, { args: ['admin', 'code'] })
    await f.network.onModifyRank(s, { playerId: s.id, rank: Ranks.BUILDER })
    await f.network.onSpawnModified(s, 'set')
  }
  // the user's row: a name from the player's own change, a name from the command, a rank from the admin code and a
  // rank from an admin, each a write that fails. A plain line of the server's log, said once for the run of failures
  // of that user (userRows.js limits it, nothing else does); the spawn goes through logOnce
  await fail()
  await f.network.userRows().idle()
  assert.deepEqual(serverLines, [
    '[network] name of user "socket" not stored (kept in memory; written again with that user\'s next change or at the final save): error',
  ])
  assert.deepEqual(f.lines, ['[network] error saving spawn: error'])
  assert.deepEqual(
    f.calls.map(call => call.key),
    ['config:spawn']
  )
  await fail()
  await f.network.userRows().idle()
  assert.equal(serverLines.length, 1)
  assert.equal(f.lines.length, 1)
  assert.deepEqual(f.network.userRows().intended('socket'), { name: 'new-name', rank: Ranks.BUILDER })
})
