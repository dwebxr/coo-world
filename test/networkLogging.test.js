import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { inspect } from 'node:util'
import moment from 'moment'
import {
  sanitizeAppModify,
  sanitizeAppRelease,
  sanitizeEntityAdd,
  sanitizeName,
  sanitizePlayerSelfModify,
  sanitizeSpawn,
} from '../src/core/extras/entityModifyPolicy.js'
import { isAdminOnlySettingKey, isKnownSettingKey, normalizeSettingValue } from '../src/core/extras/settingsPolicy.js'
import { briefError, createLogOnce } from '../src/core/extras/logOnce.js'
import { Ranks } from '../src/core/extras/ranks.js'
import { sanitizeBlueprintModify } from '../src/core/extras/blueprintPolicy.js'

const source = fs.readFileSync(new URL('../src/core/systems/ServerNetwork.js', import.meta.url), 'utf8')
const methods = [
  'requireBuilder',
  'saveConfig',
  'onBlueprintModified',
  'revertBlueprint',
  'onEntityModified',
  'onEntityAdded',
  'onEntityRemoved',
  'onSettingsModified',
  'onAi',
  'onCommand',
  'onModifyRank',
  'onSpawnModified',
  'onRequestBuilderByToken',
]
  .map(name => {
    const method = source.match(new RegExp(`^  ${name}(?:\\(| = )[^]*?^  }`, 'm'))?.[0]
    assert.ok(method, `${name} method found`)
    return method
  })
  .join('\n')

function fixture() {
  const lines = []
  const calls = []
  const entities = new Map()
  const failure = {
    get message() {
      return assert.fail('thrown message getter')
    },
    toString() {
      assert.fail('thrown value coerced')
    },
    toJSON() {
      assert.fail('thrown value serialized')
    },
    [inspect.custom]() {
      assert.fail('thrown value inspected')
    },
  }
  const Network = vm.runInNewContext(`(class { ${methods} })`, {
    isObject: value => value !== null && typeof value === 'object',
    sanitizeAppModify,
    sanitizeAppRelease,
    sanitizeEntityAdd,
    sanitizeName,
    sanitizePlayerSelfModify,
    sanitizeSpawn,
    sanitizeBlueprintModify,
    isAdminOnlySettingKey,
    isKnownSettingKey,
    normalizeSettingValue,
    briefError,
    moment,
    Ranks,
    uuid: () => 'message',
    process: { env: { ADMIN_CODE: 'code' } },
    solanaGating: { TOKEN_GATING_ENABLED: true },
    persistRank: async () => {
      throw failure
    },
    console: {
      error() {
        assert.fail('refusals must go through logOnce')
      },
    },
  })
  const network = new Network()
  network.loadedConfig = new Map([['spawn', null]])
  network.dirtyConfig = new Map()
  const once = createLogOnce(line => {
    assert.equal(typeof line, 'string')
    lines.push(line)
  })
  network.logOnce = (subject, key, line) => {
    calls.push({ subject, key })
    return once(subject, key, line)
  }
  network.world = {
    blueprints: { get() {} },
    entities: { get: id => entities.get(id) },
    settings: {},
    events: { emit() {} },
  }
  network.send = () => {}
  network.db = () => ({
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
  const socket = (id = 'socket') => ({
    id,
    player: {
      data: { id, userId: id, position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      isPlayer: true,
      isBuilder: () => true,
      isAdmin: () => true,
      modify() {},
    },
    send() {},
  })
  return { network, lines, calls, entities, socket }
}

// Packet payloads must never be coerced, serialized, inspected or enumerated for a refusal log.
function packet(fields) {
  return new Proxy(
    {
      ...fields,
      toString() {
        assert.fail('packet coerced')
      },
      toJSON() {
        assert.fail('packet serialized')
      },
      [inspect.custom]() {
        assert.fail('packet inspected')
      },
    },
    {
      ownKeys() {
        assert.fail('packet enumerated')
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
      return f.network.onEntityModified(s, packet({ id }))
    },
  ],
  [
    'entity-invalid',
    'onEntityAdded: invalid entity',
    (f, s, id) => {
      return f.network.onEntityAdded(s, packet({ id, type: 'player' }))
    },
  ],
  [
    'entity-fields',
    'onEntityModified: no permitted fields',
    (f, s, id) => {
      f.entities.set(id, s.player)
      return f.network.onEntityModified(s, packet({ id }))
    },
  ],
  [
    'entity-fields',
    'onEntityModified: no permitted fields',
    (f, s, id) => {
      f.entities.set(id, { isApp: true, data: { id } })
      return f.network.onEntityModified(s, packet({ id }))
    },
  ],
  [
    'entity-fields',
    'onEntityModified: no permitted fields',
    (f, s, id) => {
      s.player.isBuilder = () => false
      f.entities.set(id, { isApp: true, data: { id, mover: s.id } })
      return f.network.onEntityModified(s, packet({ id }))
    },
  ],
  [
    'setting-unknown',
    'onSettingsModified: unknown setting',
    (f, s, id) => {
      return f.network.onSettingsModified(s, packet({ key: id }))
    },
  ],
]

for (const [index, [key, message, refuse]] of refusals.entries()) {
  test(`handler logging ${index}: ${message} logs bounded ids once per socket and key`, async () => {
    const f = fixture()
    const a = f.socket()
    const b = f.socket() // the same user reconnecting is a new log subject
    const id = 'i'.repeat(64) + 'secret-packet-tail'.repeat(1000)
    for (const s of [a, b]) {
      await refuse(f, s, id)
      await refuse(f, s, 'different-id'.repeat(100))
      await refuse(f, s, id)
    }
    assert.deepEqual(f.lines, Array(2).fill(`${message}: ${'i'.repeat(64)}`))
    assert.ok(f.calls.every(call => call.key === key && (call.subject === a || call.subject === b)))
  })
}

test('handler logging: builder refusals use builder:<action> and a bounded socket id', () => {
  const f = fixture()
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
  assert.ok(f.lines.every(line => line.endsWith(`: ${'s'.repeat(64)}`)))
  const builder = f.socket()
  assert.equal(f.network.requireBuilder(builder, 'add blueprint'), true)
  assert.equal(f.lines.length, 14)
})

test('handler logging: all refusal reasons are independently logged once per socket', async () => {
  const f = fixture()
  const s = f.socket()
  s.player.isAdmin = () => false
  const refuse = async () => {
    await f.network.onEntityModified(s, null)
    f.entities.set('other', { isPlayer: true })
    await f.network.onEntityModified(s, packet({ id: 'other' }))
    f.network.onEntityRemoved(s, 'other')
    f.network.onSettingsModified(s, packet({ key: 'rank', value: 0 }))
    f.network.onSettingsModified(s, packet({ key: 'voice', value: false }))
    await f.network.onRequestBuilderByToken(s, packet({}))
    s.player.isBuilder = () => false
    f.entities.set('app', { isApp: true, data: {} })
    await f.network.onEntityModified(s, packet({ id: 'app' }))
    f.network.onAi(s, packet({}))
    s.player.isBuilder = () => true
  }
  await refuse()
  assert.equal(f.lines.length, 8)
  assert.equal(new Set(f.calls.map(call => call.key)).size, 8)
  await refuse()
  assert.equal(f.lines.length, 8)
})

test('handler logging: caught handler failures use briefError and logOnce', async () => {
  const f = fixture()
  const s = f.socket()
  f.entities.set(s.id, s.player)
  const fail = async () => {
    await f.network.onEntityModified(s, { id: s.id, name: 'new-name' })
    await f.network.onCommand(s, { args: ['name', 'new-name'] })
    await f.network.onCommand(s, { args: ['admin', 'code'] })
    await f.network.onModifyRank(s, { playerId: s.id, rank: Ranks.BUILDER })
    await f.network.onSpawnModified(s, 'set')
  }
  await fail()
  assert.equal(f.lines.length, 4)
  assert.ok(f.lines.every(line => line.endsWith(': error')))
  await fail()
  assert.equal(f.lines.length, 4)
})
