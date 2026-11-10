// The world the join-budget tests share (joinBudget.test.js, joinAdmission.test.js): the real Entities, Blueprints,
// Settings and network handlers, with stand-in app and player entities, a stand-in database and a join helper.
import assert from 'node:assert/strict'
import moment from 'moment'
import { readPacket, writeClientPacket, writePacket } from '../../src/core/packets.js'
import { WORLD_JOIN_BYTES, joinStateBytes } from '../../src/core/extras/joinBudget.js'
import { isAvatarUrl, sanitizeName } from '../../src/core/extras/entityModifyPolicy.js'
import { Blueprints } from './clientHarness.mjs'
import { load, Settings } from './persistenceHarness.mjs'
import { connectionMethod, fakeWs, makeNetwork, Socket } from './networkHarness.mjs'

// Real accounting throughout: the real Entities, Blueprints, Settings and network handlers; only the app and player
// entities themselves are stand-ins (no scripts, no physics)
class FakeApp {
  constructor(world, data) {
    this.world = world
    this.data = data
    this.isApp = true
    this.builds = 0
  }
  modify(change) {
    Object.assign(this.data, change)
  }
  build() {
    this.builds++
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.world.entities.remove(this.data.id)
  }
  serialize() {
    return this.data
  }
}
class FakePlayer extends FakeApp {
  constructor(world, data) {
    super(world, data)
    this.isApp = false
    this.isPlayer = true
  }
  isBuilder() {
    return this.data.rank >= 1
  }
  isAdmin() {
    return this.data.rank >= 2
  }
}
const Entities = load('core/systems/Entities.js', 'Entities', {
  App: FakeApp,
  PlayerLocal: FakePlayer,
  PlayerRemote: FakePlayer,
})

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

// `env`: the process environment the network's methods see
export function fixture({ env = {} } = {}) {
  const logs = []
  const network = makeNetwork(line => logs.push(line), { context: { process: { env } } })
  const world = network.world
  world.network = network
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
  network.db = table => {
    if (table === 'entities') return appTable(store.rows)
    assert.equal(table, 'users')
    return {
      where: (key, id) => ({ first: async () => users.get(id) }),
      insert: async row => users.set(row.id, row),
    }
  }
  store.transactions = () => {
    network.db.transaction = async fn => {
      const staged = new Map(store.rows)
      await fn(table => (assert.equal(table, 'entities'), appTable(staged)))
      store.rows = staged
    }
  }
  network.onConnection = connectionMethod({
    isNumber: value => typeof value === 'number',
    sanitizeName,
    isAvatarUrl,
    moment,
    performance,
    HEALTH_MAX: 100,
    readJWT: async token => (token ? { userId: token } : null),
    createJWT: async ({ userId }) => userId,
    uuid: nextId,
    process: { env: {} },
  })
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
  const join = async (params = {}) => {
    const ws = fakeWs()
    ws.closeCodes = []
    ws.close = code => {
      ws.closeCodes.push(code)
      ws.readyState = 3
    }
    await network.onConnection(ws, params)
    ws.drain()
    const [method, snapshot] = ws.packets.length ? readPacket(ws.packets[0]) : []
    return { ws, method, snapshot, bytes: ws.packets[0]?.length }
  }
  world.blueprints.add({ id: 'bp', version: 0, name: 'Box' })
  return { logs, network, world, builder, send, join, users, store }
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
