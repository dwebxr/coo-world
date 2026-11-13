// The world the join tests share (joinBudget.test.js, joinAdmission.test.js, …): the real network (network.mjs) with
// the real Entities, Blueprints and Settings of its bundle, stand-in app and player entities (joinEntities.mjs), a
// stand-in database and a join helper.
import assert from 'node:assert/strict'
import { readPacket, writeClientPacket, writePacket } from '../../src/core/packets.js'
import { WORLD_JOIN_BYTES, joinStateBytes } from '../../src/core/extras/joinBudget.js'
import { entityClasses, fakeWs, loadNetwork, makeNetwork } from './network.mjs'

// The stand-ins a join reads (network.mjs standIns): a session token is the id of its user (readJWT, createJWT),
// one that fails to verify is taken for a forgery, not for an expired session (expiredSessionUser), and new ids are
// nextId's; the gating modules are the real ones unless a test gives its own (fixture's `modules`)
const UTILS = 'src/core/utils.js'
const SESSION = 'src/core/utils-server.js'
const GATING = { solanaGating: 'src/server/solana-gating.js', evmGating: 'src/server/evm-gating.js' }

// Real accounting throughout: the real Entities, Blueprints, Settings and network handlers; only the app and player
// entities themselves are stand-ins (no scripts, no physics). The old harness saved nothing on a timer
// (SAVE_INTERVAL 0)
export const net = await loadNetwork({
  replace: entityClasses(new URL('./joinEntities.mjs', import.meta.url)),
  standIns: [UTILS, SESSION, ...Object.values(GATING)],
  env: { SAVE_INTERVAL: 0 },
})
const { Blueprints, Entities, Settings, Socket } = net

const F3 = () => [Math.random() * 10, 1.25, -3.5]
export const app = (id, blueprint = 'bp', extra = {}) => ({
  id,
  type: 'app',
  blueprint,
  position: F3(),
  quaternion: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)],
  scale: [1.5, 1.5, 1.5],
  mover: null,
  uploader: null,
  pinned: false,
  state: {},
  ...extra,
})
// ids of the shape uuid() makes (10 of [0-9a-zA-Z]), unique per test
let counter = 0
export const nextId = () => `id${String(++counter).padStart(8, '0')}`

const session = {
  readJWT: async token => (token ? { userId: token } : null),
  createJWT: async ({ userId }) => userId,
  expiredSessionUser: async () => null,
}

// `t`: the test; `env`: the process environment the network sees while the test runs; `modules`: the gating modules
// the handlers see in place of the real ones ({ solanaGating, evmGating }: objects with the modules' names)
export function fixture(t, { env = {}, modules = {} } = {}) {
  for (const name of Object.keys(modules)) assert.ok(GATING[name], `fixture: ${name} is not a module it can give`)
  const logs = []
  const users = new Map()
  // the stored app rows, as the database holds them; `store.hangAfter` makes every write after that many hang for
  // ever (the process stopping there), `store.transactions()` gives the database transactions
  const store = { rows: new Map(), writes: 0, hangAfter: Infinity }
  const write = apply => {
    if (store.writes++ >= store.hangAfter) return new Promise(() => {})
    apply()
    return Promise.resolve()
  }
  const appTable = rows => ({
    insert: row => ({
      onConflict: () => ({
        merge: () =>
          store.failInserts
            ? Promise.reject(new Error('disk full'))
            : write(() => rows.set(row.id, JSON.parse(row.data))),
      }),
    }),
    where: (key, id) => ({ delete: () => write(() => rows.delete(id)) }),
  })
  const db = table => {
    if (table === 'entities') return appTable(store.rows)
    assert.equal(table, 'users')
    return {
      where: (key, id) => ({
        first: async () => users.get(id),
        // a user row's UPDATE, recorded in `store.userUpdates` when it starts and applied to the row when it lands;
        // `store.holdUserUpdate`: a promise the next one waits for before it lands
        update: async changes => {
          ;(store.userUpdates ??= []).push({ id, changes: { ...changes } })
          const hold = store.holdUserUpdate
          store.holdUserUpdate = null
          if (hold) await hold
          const row = users.get(id)
          if (row) Object.assign(row, changes)
          return row ? 1 : 0
        },
      }),
      insert: async row => users.set(row.id, row),
    }
  }
  store.transactions = () => {
    db.transaction = async fn => {
      const staged = new Map(store.rows)
      await fn(table => (assert.equal(table, 'entities'), appTable(staged)))
      store.rows = staged
    }
  }
  const network = makeNetwork(t, {
    net,
    log: line => logs.push(line),
    init: { db },
    env,
    modules: {
      [UTILS]: { uuid: nextId },
      [SESSION]: session,
      ...Object.fromEntries(Object.entries(GATING).map(([name, file]) => [file, modules[name] ?? null])),
    },
  })
  const world = network.world
  world.entities = new Entities(world)
  world.blueprints = new Blueprints(world)
  world.settings = new Settings(world)
  world.collections = { serialize: () => [] }
  world.chat = { msgs: [], serialize: () => world.chat.msgs }
  world.ai = { serialize: () => ({ enabled: false }) }
  world.livekit = { state: null, serialize: async () => world.livekit.state, clearModifiers() {} }
  world.events = { emit() {} }
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  network.settingsBytes = writePacket('settingsModified', world.settings.serialize()).length
  network.collectionsBytes = writePacket('settingsModified', []).length
  // a builder connection that sends packets (its player is not in the world)
  const builder = new Socket({
    id: 'builder',
    ws: fakeWs(),
    network,
    player: { isBuilder: () => true, isAdmin: () => true, data: { rank: 2 } },
  })
  const send = (name, data, socket = builder) => {
    socket.ws.emit('message', writeClientPacket(name, data))
    network.flush()
  }
  // a connection as the route hands it over: the server's close is recorded, and `terminate()` is the client going
  // away (the transport reports its close)
  const connection = () => {
    const ws = fakeWs()
    ws.closeCodes = []
    ws.close = code => {
      ws.closeCodes.push(code)
      ws.readyState = 3
    }
    return ws
  }
  // `origin`: where the connection comes from ({ key, parents }), as the route gives it; `ws`: a test's own
  // connection, to close while the join waits
  const join = async (params = {}, origin, ws = connection()) => {
    await network.onConnection(ws, params, origin)
    ws.drain()
    const [method, snapshot] = ws.packets.length ? readPacket(ws.packets[0]) : []
    return { ws, method, snapshot, bytes: ws.packets[0]?.length }
  }
  world.blueprints.add({ id: 'bp', version: 0, name: 'Box' })
  return { logs, network, world, builder, send, join, connection, users, store }
}

// lets a save that is stuck on a hanging write show where it stopped
export const settle = async (turns = 40) => {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve))
}

export const sentTo = socket => socket.ws.packets.map(readPacket)
export const apps = world => [...world.entities.items.values()].filter(entity => entity.isApp)
// brings the world to `room` bytes under its budget through the accounting alone (as if the operator's collections
// were that large), where a test needs a full world but not thousands of apps
export const fillTo = (f, room) => {
  f.network.collectionsBytes += WORLD_JOIN_BYTES - room - joinStateBytes(f.world)
  assert.equal(joinStateBytes(f.world), WORLD_JOIN_BYTES - room)
}

export const long = n => '€'.repeat(n) // a 3-byte character: the most a UTF-16 unit costs in UTF-8
