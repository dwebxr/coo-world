import { App } from '../entities/App'
import { PlayerLocal } from '../entities/PlayerLocal'
import { PlayerRemote } from '../entities/PlayerRemote'
import { System } from './System'
import { preflightPacket } from '../extras/clientPreflight'
import { eventPayload } from '../extras/eventPayload.js'
import { appRecordBytes, fitsJoinState, stateBytes } from '../extras/joinBudget'

const Types = {
  app: App,
  playerLocal: PlayerLocal,
  playerRemote: PlayerRemote,
}

/**
 * Entities System
 *
 * - Runs on both the server and client.
 * - Supports inserting entities into the world
 * - Executes entity scripts
 *
 */
export class Entities extends System {
  constructor(world) {
    super(world)
    this.items = new Map()
    this.players = new Map()
    this.player = null
    this.hot = new Set()
    // server: what each app entity spends in the join snapshot (joinBudget.js), { record, state } bytes by id
    this.appSizes = new Map()
    this.appBytes = 0
  }

  get(id) {
    return this.items.get(id)
  }

  getPlayer(entityId) {
    return this.players.get(entityId)
  }

  add(data, local) {
    // one entity per id: a second one would replace the first in the map and leave it running, unreachable.
    // callers that take ids from outside check first (ServerNetwork: entityAdded, a joining player)
    if (this.items.has(data?.id)) {
      console.error(`entity already exists: ${String(data.id).slice(0, 64)}`)
      return null
    }
    if (local && this.world.network.isClient && !preflightPacket(this.world, 'entityAdded', data)) return false
    // measured before the entity exists: its script may replace the state while it is constructed
    const size = data.type === 'app' && this.world.network.isServer ? this.measureApp(data.id, data) : null
    let Entity
    if (data.type === 'player') {
      Entity = Types[data.owner === this.world.network.id ? 'playerLocal' : 'playerRemote']
    } else if (Object.prototype.hasOwnProperty.call(Types, data.type)) {
      Entity = Types[data.type]
    }
    if (!Entity) return console.error(`unknown entity type: ${data.type}`)
    const entity = new Entity(this.world, data, local)
    this.items.set(entity.data.id, entity)
    if (size) this.trackApp(entity.data.id, size)
    if (data.type === 'player') {
      this.players.set(entity.data.id, entity)
      // on the client remote players emit enter events here.
      // but on the server, enter events is delayed for players entering until after their snapshot is sent
      // that way they can actually respond correctly to follow-through events.
      // see ServerNetwork.js -> onConnection
      if (this.world.network.isClient && data.owner !== this.world.network.id) {
        this.world.events.emit('enter', eventPayload({ playerId: entity.data.id }))
      }
    }
    if (data.owner === this.world.network.id) {
      this.player = entity
      this.world.emit('player', entity)
    }
    this.emit('added', entity)
    return entity
  }

  remove(id) {
    const entity = this.items.get(id)
    if (!entity) return console.warn(`tried to remove entity that did not exist: ${id}`)
    if (entity.isPlayer) this.players.delete(entity.data.id)
    if (entity.isApp && this.world.network.isServer && !this.destroying) this.world.network.markAppDeleted(id)
    entity.destroy()
    this.items.delete(id)
    this.untrackApp(id)
    this.emit('removed', entity)
  }

  // An app's join-snapshot size, after `change` (an add's data, or the fields a modify sets): the record changes
  // with the blueprint id only (appRecordBytes measures the rest at its largest), the state with a client-set
  // state or a rebuild's reset (joinBudget.js); a server script's app.state is never read
  measureApp(id, change = {}) {
    const current = this.appSizes.get(id)
    const has = key => Object.prototype.hasOwnProperty.call(change, key)
    let record = current?.record
    if (!current || has('blueprint')) record = appRecordBytes({ ...(this.items.get(id)?.data || {}), ...change, id })
    return { record, state: has('state') ? stateBytes(change.state) : current?.state || 0 }
  }

  // A blueprint change rebuilds its apps and resets their state to {} (Blueprints.modify): the bytes that frees
  emptiedStateBytes(blueprintId) {
    const empty = stateBytes({})
    let bytes = 0
    for (const [id, size] of this.appSizes) {
      if (size.state > empty && this.items.get(id)?.data.blueprint === blueprintId) bytes += size.state - empty
    }
    return bytes
  }

  // called where a rebuild resets an app's state to {}
  stateEmptied(id) {
    const size = this.appSizes.get(id)
    if (size) this.trackApp(id, { record: size.record, state: stateBytes({}) })
  }

  // whether an app add or modify fits the join-state budget (growth only)
  canFitApp(id, change) {
    const next = this.measureApp(id, change)
    const current = this.appSizes.get(id)
    const delta = next.record + next.state - (current ? current.record + current.state : 0)
    return fitsJoinState(this.world, delta)
  }

  trackApp(id, size) {
    this.untrackApp(id)
    this.appSizes.set(id, size)
    this.appBytes += size.record + size.state
  }

  untrackApp(id) {
    const size = this.appSizes.get(id)
    if (!size) return
    this.appBytes -= size.record + size.state
    this.appSizes.delete(id)
  }

  setHot(entity, hot) {
    if (hot) {
      this.hot.add(entity)
    } else {
      this.hot.delete(entity)
    }
  }

  fixedUpdate(delta) {
    for (const entity of this.hot) {
      entity.fixedUpdate(delta)
    }
  }

  update(delta) {
    for (const entity of this.hot) {
      entity.update(delta)
    }
  }

  lateUpdate(delta) {
    for (const entity of this.hot) {
      entity.lateUpdate(delta)
    }
  }

  serialize() {
    const data = []
    this.items.forEach(entity => {
      data.push(entity.serialize())
    })
    return data
  }

  deserialize(datas) {
    for (const data of datas) {
      this.add(data)
    }
  }

  destroy() {
    this.destroying = true
    try {
      this.items.forEach(item => {
        this.remove(item.data.id)
      })
      this.items.clear()
      this.players.clear()
      this.hot.clear()
      this.appSizes.clear()
      this.appBytes = 0
    } finally {
      this.destroying = false
    }
  }
}
