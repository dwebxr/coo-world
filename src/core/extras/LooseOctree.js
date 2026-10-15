import * as THREE from './three'
import { getOctreeExpansions } from './octreeBounds.js'

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _q1 = new THREE.Quaternion()
const _m1 = new THREE.Matrix4()
const _intersects = []
const _mesh = new THREE.Mesh()

const MIN_RADIUS = 0.2
let warned = false

// https://anteru.net/blog/2008/loose-octrees/

export class LooseOctree {
  constructor({ scene, center, size }) {
    this.scene = scene
    this.root = new LooseOctreeNode(this, null, center, size)
  }

  insert(item) {
    updateSphere(item)
    const expansions = getOctreeExpansions(this.root, item.sphere.center, item.sphere.radius, true)
    if (expansions < 0) return this.park(item)
    const prevNode = item._node
    this.remove(item)
    for (let i = 0; i < expansions; i++) this.expand()
    const added = this.root.insert(item)
    prevNode?.checkCollapse()
    return added
  }

  move(item) {
    if (!item._node && !item._parked) return
    updateSphere(item)
    if (
      [item.sphere.center.x, item.sphere.center.y, item.sphere.center.z, item.sphere.radius].every(Number.isFinite) &&
      item._node?.canContain(item)
    ) {
      return
    }
    return this.insert(item)
  }

  park(item) {
    const prevNode = item._node
    this.remove(item)
    item._node = null
    item._parked = true
    prevNode?.checkCollapse()
    if (!warned) {
      warned = true
      console.warn('[LooseOctree] parked item with non-finite or out-of-budget bounds')
    }
    return false
  }

  remove(item) {
    item._node?.remove(item)
    item._parked = false
  }

  expand() {
    // console.log('expand')
    // when we expand we do it twice so that it expands in both directions.
    // first goes positive, second goes back negative
    let prevRoot
    let size
    let center

    prevRoot = this.root
    size = prevRoot.size * 2
    center = new THREE.Vector3(
      prevRoot.center.x + prevRoot.size,
      prevRoot.center.y + prevRoot.size,
      prevRoot.center.z + prevRoot.size
    )
    const first = new LooseOctreeNode(this, null, center, size)
    first.subdivide()
    first.children[0].destroy()
    first.children[0] = prevRoot
    prevRoot.parent = first
    this.root = first
    this.root.count = prevRoot.count

    prevRoot = this.root
    size = prevRoot.size * 2
    center = new THREE.Vector3(
      prevRoot.center.x - prevRoot.size,
      prevRoot.center.y - prevRoot.size,
      prevRoot.center.z - prevRoot.size
    )
    const second = new LooseOctreeNode(this, null, center, size)
    second.subdivide()
    second.children[7].destroy()
    second.children[7] = prevRoot
    prevRoot.parent = second
    this.root = second
    this.root.count = prevRoot.count
  }

  raycast(raycaster, intersects = []) {
    this.root.raycast(raycaster, intersects)
    intersects.sort(sortAscending)
    // console.log('octree.raycast', intersects)
    return intersects
  }

  // spherecast(sphere, intersects = []) {
  //   // console.time('spherecast')
  //   this.root.spherecast(sphere, intersects)
  //   intersects.sort(sortAscending)
  //   // console.timeEnd('spherecast')
  //   // console.log('octree.spherecast', intersects)
  //   return intersects
  // }

  // prune() {
  //   console.time('prune')
  //   this.pruneCount = 0
  //   this.root.prune()
  //   console.timeEnd('prune')
  //   console.log('pruned:', this.pruneCount)
  // }

}

class LooseOctreeNode {
  constructor(octree, parent, center, size) {
    this.octree = octree
    this.parent = parent
    this.center = center
    this.size = size
    this.inner = new THREE.Box3(
      new THREE.Vector3(center.x - size, center.y - size, center.z - size),
      new THREE.Vector3(center.x + size, center.y + size, center.z + size)
    )
    this.outer = new THREE.Box3(
      new THREE.Vector3(center.x - size * 2, center.y - size * 2, center.z - size * 2), // prettier-ignore
      new THREE.Vector3(center.x + size * 2, center.y + size * 2, center.z + size * 2) // prettier-ignore
    )
    this.items = []
    this.count = 0
    this.children = []
  }

  insert(item) {
    if (!this.canContain(item)) {
      return false
    }
    if (this.size / 2 < item.sphere.radius) {
      this.items.push(item)
      item._node = this
      this.inc(1)
      return true
    }
    if (!this.children.length) {
      this.subdivide()
    }
    for (const child of this.children) {
      if (child.insert(item)) {
        return true
      }
    }
    // this should never happen
    console.error('octree insert fail')
    // this.items.push(item)
    // item._node = this
    return false
  }

  remove(item) {
    const idx = this.items.indexOf(item)
    this.items.splice(idx, 1)
    item._node = null
    this.dec(1)
  }

  inc(amount) {
    let node = this
    while (node) {
      node.count += amount
      node = node.parent
    }
  }

  dec(amount) {
    let node = this
    while (node) {
      node.count -= amount
      node = node.parent
    }
  }

  canContain(item) {
    return this.size >= item.sphere.radius && this.inner.containsPoint(item.sphere.center)
  }

  checkCollapse() {
    // a node can collapse if it has children to collapse AND has no items in any descendants
    let match
    let node = this
    while (node) {
      if (node.count) break
      if (node.children.length) match = node
      node = node.parent
    }
    match?.collapse()
  }

  collapse() {
    for (const child of this.children) {
      child.collapse()
      child.destroy()
    }
    this.children = []
  }

  subdivide() {
    if (this.children.length) return // Ensure we don't subdivide twice
    const halfSize = this.size / 2
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < 2; z++) {
          const center = new THREE.Vector3(
            this.center.x + halfSize * (2 * x - 1),
            this.center.y + halfSize * (2 * y - 1),
            this.center.z + halfSize * (2 * z - 1)
          )
          const child = new LooseOctreeNode(this.octree, this, center, halfSize)
          this.children.push(child)
        }
      }
    }
  }

  raycast(raycaster, intersects) {
    if (!raycaster.ray.intersectsBox(this.outer)) {
      return intersects
    }
    for (const item of this.items) {
      if (raycaster.ray.intersectsSphere(item.sphere)) {
        _mesh.geometry = item.geometry
        _mesh.material = item.material
        _mesh.matrixWorld = item.matrix
        _mesh.raycast(raycaster, _intersects)
        for (let i = 0, l = _intersects.length; i < l; i++) {
          const intersect = _intersects[i]
          intersect.getEntity = item.getEntity
          intersect.node = item.node
          intersect.direction = raycaster.ray.direction
          intersects.push(intersect)
        }
        _intersects.length = 0
      }
    }
    for (const child of this.children) {
      child.raycast(raycaster, intersects)
    }
    return intersects
  }

  // spherecast(sphere, intersects) {
  //   if (!sphere.intersectsBox(this.outer)) {
  //     return intersects
  //   }
  //   for (const item of this.items) {
  //     if (sphere.intersectsSphere(item.sphere)) {
  //       // just sphere-to-sphere is good enough for now
  //       const centerToCenterDistance = sphere.center.distanceTo(
  //         item.sphere.center
  //       )
  //       const overlapDistance =
  //         item.sphere.radius + sphere.radius - centerToCenterDistance
  //       const distance = Math.max(0, overlapDistance)
  //       const intersect = {
  //         distance: distance,
  //         point: null,
  //         object: null,
  //         getEntity: item.getEntity,
  //       }
  //       intersects.push(intersect)
  //       // _mesh.geometry = item.geometry
  //       // _mesh.material = item.material
  //       // _mesh.matrixWorld = item.matrix
  //       // _mesh.raycast(raycaster, _intersects)
  //       // for (let i = 0, l = _intersects.length; i < l; i++) {
  //       //   const intersect = _intersects[i]
  //       //   intersect.getEntity = item.getEntity
  //       //   intersects.push(intersect)
  //       // }
  //       // _intersects.length = 0
  //     }
  //   }
  //   for (const child of this.children) {
  //     child.spherecast(sphere, intersects)
  //   }
  //   return intersects
  // }

  // prune() {
  //   let empty = true
  //   for (const child of this.children) {
  //     const canPrune = !child.items.length && child.prune()
  //     if (!canPrune) {
  //       empty = false
  //     }
  //   }
  //   if (empty) {
  //     for (const child of this.children) {
  //       this.octree.helper?.remove(child)
  //     }
  //     this.children.length = 0
  //     this.octree.pruneCount++
  //   }
  //   return empty
  // }

  destroy() {}
}

function updateSphere(item) {
  if (!item.sphere) item.sphere = new THREE.Sphere()
  if (!item.geometry.boundingSphere) item.geometry.computeBoundingSphere()
  item.sphere.copy(item.geometry.boundingSphere).applyMatrix4(item.matrix)
  if (Number.isFinite(item.sphere.radius) && item.sphere.radius < MIN_RADIUS) {
    item.sphere.radius = MIN_RADIUS // prevent huge subdivisions
  }
}

function sortAscending(a, b) {
  return a.distance - b.distance
}

// function getRandomHexColor() {
//   // Generate a random integer between 0 and 0xFFFFFF (16777215 in decimal)
//   const randomInt = Math.floor(Math.random() * 16777216);
//   // Convert the integer to a hexadecimal string and pad with leading zeros if necessary
//   const hexColor = randomInt.toString(16).padStart(6, '0');
//   // Prefix with '#' to form a valid hex color code
//   return '#' + hexColor;
// }

