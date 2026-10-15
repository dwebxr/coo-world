import { isEqual, merge } from 'lodash-es'
import { System } from './System'
import { sanitizeBlueprintAdd, sanitizeBlueprintModify } from '../extras/blueprintPolicy'
import { preflightPacket } from '../extras/clientPreflight'

/**
 * Blueprints System
 *
 * - Runs on both the server and client.
 * - A central registry for app blueprints
 *
 */
export class Blueprints extends System {
  constructor(world) {
    super(world)
    this.items = new Map()
    this.authors = new Map()
  }

  get(id) {
    return this.items.get(id)
  }

  getScene() {
    return this.items.get('$scene')
  }

  add(data, local) {
    if (local && this.world.network.isClient) {
      data = this.preflight(data, true)
      if (!data || !this.world.network.send('blueprintAdded', data)) return false
    }
    this.items.set(data.id, data)
    this.authors.delete(data.id)
    if (local && !this.world.network.isClient) {
      this.world.network.send('blueprintAdded', data)
    }
    return true
  }

  preflight(data, add = false) {
    const result = add ? sanitizeBlueprintAdd(data) : sanitizeBlueprintModify(data)
    if (!result.ok) return false
    if (!preflightPacket(this.world, add ? 'blueprintAdded' : 'blueprintModified', result.value)) return false
    return result.value
  }

  modify(data, local, { authorSocketId = null } = {}) {
    if (local && this.world.network.isClient) {
      data = this.preflight(data)
      if (!data || !this.world.network.send('blueprintModified', data)) return false
    }
    const blueprint = this.items.get(data.id)
    const modified = {
      ...blueprint,
      ...data,
    }
    const changed = !isEqual(blueprint, modified)
    if (!changed) return true
    this.items.set(blueprint.id, modified)
    if (this.world.network.isServer) {
      this.authors.set(blueprint.id, { version: modified.version, socketId: authorSocketId })
    }
    for (const [_, entity] of this.world.entities.items) {
      if (entity.data.blueprint === blueprint.id) {
        entity.data.state = {}
        entity.build()
      }
    }
    this.emit('modify', modified)
    return true
  }

  serialize() {
    const datas = []
    this.items.forEach(data => {
      datas.push(data)
    })
    return datas
  }

  deserialize(datas) {
    for (const data of datas) {
      this.add(data)
    }
  }

  destroy() {
    this.items.clear()
    this.authors.clear()
  }
}
