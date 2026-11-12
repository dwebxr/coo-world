import { isBoolean, isPrimitive } from '../extras/scriptPrimitives.js'
import * as THREE from '../extras/three'

import { getNodeRef, Node } from './Node'

const v0 = new THREE.Vector3()
const v1 = new THREE.Vector3()
const v2 = new THREE.Vector3()

const defaults = {
  scaleAware: true,
}

export class LOD extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'lod'

    this.scaleAware = data.scaleAware

    this.lods = [] // [...{ node, maxDistance }]
    this.readding = null // (the child add() is putting back: see add)
  }

  insert(node, maxDistance) {
    // a number, kept as one: the distance is compared on every sort and every frame (an object's valueOf would run
    // there, in the middle of a mount or of the LOD system's update)
    if (!isPrimitive(maxDistance)) throw new Error('[lod.insert] maxDistance must be a number')
    maxDistance = Number(maxDistance)
    node.active = false
    // The node is added first, then given its level, the one level it has here: a node that cannot be added (an
    // ancestor of this LOD) is no level of it, and one inserted again, into this LOD or from another, has the new
    // distance only. (The level was recorded before the add, and the add took the node out of its parent first: when
    // that was this LOD, both levels went, and the node was never shown again.)
    this.add(node)
    this.forget(node)
    // a distance that is not a number (NaN: `insert(node)` without one) is no level: no distance is within it, so its
    // node was never shown, and in the list it broke the order of the others (a sort cannot place a NaN: [10, NaN, 5]
    // stayed as it was, and 10 was found before 5). The node is still added, switched off, as before.
    if (!Number.isNaN(maxDistance)) {
      this.lods.push({ node, maxDistance })
      this.lods.sort((a, b) => a.maxDistance - b.maxDistance) // ascending
    }
  }

  // A child added again (Node.add takes a node out of its parent first, also when that is this LOD) keeps its level:
  // it does not leave.
  add(node) {
    if (node?.parent !== this) return super.add(node)
    this.readding = node
    try {
      return super.add(node)
    } finally {
      this.readding = null
      // unless it did: an add that failed after Node.add took it out (its unmount threw), or a child that left during
      // the add (removed, or moved elsewhere, by what its mount ran) is no child of this LOD, and no level of it
      if (node.parent !== this) this.forget(node)
    }
  }

  // A child that leaves (removed, or added to another node) is no level any more. It used to stay in the list: the
  // next time the camera came within its distance, check() switched it on again, and a node without a parent that is
  // switched on mounts by itself, with the context it had here.
  remove(node) {
    if (node !== this.readding) this.forget(node)
    return super.remove(node)
  }

  forget(node) {
    this.lods = this.lods.filter(lod => lod.node !== node)
    // (nor is it this LOD's to switch off later: it stays as it is)
    if (this.lod?.node === node) this.lod = null
    if (this.prevLod?.node === node) this.prevLod = null
  }

  mount() {
    this.ctx.world.lods?.register(this)
    this.check()
  }

  check() {
    if (this.prevLod) {
      this.prevLod.node.active = false
      this.prevLod = null
    }
    const cameraPos = v0.setFromMatrixPosition(this.ctx.world.camera.matrixWorld)
    const itemPos = v1.setFromMatrixPosition(this.matrixWorld)
    let distance = cameraPos.distanceTo(itemPos)
    if (this._scaleAware) {
      v2.setFromMatrixScale(this.matrixWorld)
      const avgScale = (v2.x + v2.y + v2.z) / 3
      distance = distance / avgScale
    }
    const lod = this.lods.find(lod => distance <= lod.maxDistance)
    // if this lod hasnt change, stop here
    if (this.lod === lod) return
    // if we have a new lod, lets activate it immediately
    if (lod) {
      lod.node.active = true
    }
    // if we have a pre-existing active lod, queue to remove it next frame
    if (this.lod) {
      this.prevLod = this.lod
    }
    // track the new lod (if any)
    this.lod = lod
  }

  unmount() {
    this.ctx.world.lods?.unregister(this)
  }

  copy(source, recursive) {
    super.copy(source, recursive)
    this._scaleAware = source._scaleAware
    // the levels are the clone's own children: a clone made without them (`clone()`, not `clone(true)`) has none (it
    // threw here, looking for them)
    this.lods = []
    for (const lod of source.lods) {
      const node = this.children.find(node => node.id === lod.node.id)
      if (!node) continue
      node.active = false
      this.lods.push({ node, maxDistance: lod.maxDistance })
    }
    return this
  }

  get scaleAware() {
    return this._scaleAware
  }

  set scaleAware(value = defaults.scaleAware) {
    if (!isBoolean(value)) {
      throw new Error('[lod] scaleAware not a boolean')
    }
    if (this._scaleAware === value) return
    this._scaleAware = value
  }

  getProxy() {
    if (!this.proxy) {
      const self = this
      let proxy = {
        get scaleAware() {
          return self.scaleAware
        },
        set scaleAware(value) {
          self.scaleAware = value
        },
        insert(pNode, maxDistance) {
          const node = getNodeRef(pNode)
          if (!node) {
            if (pNode != null) console.error('[lod.insert] expected a node')
            return this
          }
          self.insert(node, maxDistance)
          return this
        },
      }
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy())) // inherit Node properties
      this.proxy = proxy
    }
    return this.proxy
  }
}
