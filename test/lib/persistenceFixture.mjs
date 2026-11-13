// The persistence tests' world (persistence.test.js, persistenceIntegration.test.js): the real network (network.mjs)
// with the real Settings and Entities of its bundle, a stand-in database whose writes can be held, and the World's
// fatal() as written.
import fs from 'node:fs'
import path from 'node:path'
import { makeNetwork } from './network.mjs'

export const appData = () => ({
  id: 'app',
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

export function deferred() {
  let resolve
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}

// `writes`: every write, in order; `db.pause(table)` holds the next write to that table until `release` resolves
export function database() {
  const tables = { entities: new Map(), blueprints: new Map(), config: new Map() }
  const writes = []
  let pause
  const write = async (table, row, remove = false) => {
    const entry = { table, row: { ...row }, remove }
    writes.push(entry)
    if (pause && pause.table === table) {
      const held = pause
      pause = null
      held.started.resolve(entry)
      await held.release.promise
    }
    if (remove) tables[table].delete(row.id)
    else tables[table].set(row.id ?? row.key, { ...row })
  }
  const db = table => ({
    insert: row => ({ onConflict: () => ({ merge: () => write(table, row) }) }),
    where: (key, id) => ({ delete: () => write(table, { id }, true), first: async () => tables[table].get(id) }),
  })
  db.pause = table => {
    pause = { table, started: deferred(), release: deferred() }
    return pause
  }
  return { db, tables, writes }
}

// World.fatal as written (src/core/World.js, or the REAL_PHYSX_SOURCE_ROOT checkout's), with the process exit
// recorded in `exits` instead of taken
function worldFatal(exits) {
  const file = process.env.REAL_PHYSX_SOURCE_ROOT
    ? path.join(process.env.REAL_PHYSX_SOURCE_ROOT, 'src/core/World.js')
    : new URL('../../src/core/World.js', import.meta.url)
  const fatal = fs.readFileSync(file, 'utf8').match(/^ {2}fatal\(reason\) \{[^]*?^ {2}}/m)[0]
  const Fatal = new Function('getPhysicsTrapCount', 'process', `return class { ${fatal} }`)(() => 0, {
    exit: code => exits.push(code),
  })
  return Fatal.prototype.fatal
}

// A world as hydration leaves it (spawn and settings loaded, settings changes saved) with one app of blueprint 'bp'
// and a builder connection. `net`: the bundle (loadNetwork); `db`: a database() db
export function fixture(t, { net, db = database().db }) {
  const network = makeNetwork(t, { net, world: { server: { destroy() {} } }, init: { db } })
  const world = network.world
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  world.settings = new net.Settings(world)
  network.loadedConfig.set('spawn', JSON.stringify(network.spawn))
  network.loadedConfig.set('settings', JSON.stringify(world.settings.serialize()))
  world.settings.on('change', network.saveSettings)
  world.entities = new net.Entities(world)
  world.entities.add = data => {
    const entity = { data, isApp: true, modify: change => Object.assign(data, change), destroy() {} }
    world.entities.items.set(data.id, entity)
    return entity
  }
  const blueprints = new Map([['bp', { id: 'bp', version: 0, props: { n: 0 } }]])
  world.blueprints = {
    get: id => blueprints.get(id),
    canFit: () => true,
    add: data => blueprints.set(data.id, data),
    modify: change => blueprints.set(change.id, { ...blueprints.get(change.id), ...change }),
  }
  const entity = world.entities.add(appData())
  const socket = { id: 'builder', player: { isBuilder: () => true, isAdmin: () => true, data: appData() }, send() {} }
  network.send = () => {}
  const exits = []
  world.fatal = worldFatal(exits)
  return { network, world, entity, socket, exits }
}
