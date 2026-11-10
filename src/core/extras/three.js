import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'

import * as THREE from 'three'
import { storable } from './storable.js'

export * from 'three'

// override THREE.Vector3 with ours to support _onChange
export { Vector3Enhanced as Vector3 } from './Vector3Enhanced'

// Quaternion and Euler (a node's quaternion and rotation): a component is never an object, as for our Vector3 (an
// object, or a function, is stored as NaN without being converted, so no valueOf or toString a script defined runs in
// the engine's arithmetic later). Installed once on the prototypes (x/y/z/w, set, copy, fromArray), before they are
// frozen for scripts.
function storeComponents(proto, keys) {
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(proto, key)
    if (!desc?.set) continue
    const set = desc.set
    Object.defineProperty(proto, key, {
      ...desc,
      set(value) {
        set.call(this, storable(value))
      },
    })
  }
}
function storedFields(target, keys) {
  for (const key of keys) target[key] = storable(target[key])
  return target
}
if (!Object.prototype.hasOwnProperty.call(THREE.Quaternion.prototype, '__componentsStored')) {
  storeComponents(THREE.Quaternion.prototype, ['x', 'y', 'z', 'w'])
  storeComponents(THREE.Euler.prototype, ['x', 'y', 'z'])
  const quaternion = ['_x', '_y', '_z', '_w']
  const euler = ['_x', '_y', '_z']
  const qSet = THREE.Quaternion.prototype.set
  THREE.Quaternion.prototype.set = function (x, y, z, w) {
    return qSet.call(this, storable(x), storable(y), storable(z), storable(w))
  }
  const qCopy = THREE.Quaternion.prototype.copy
  THREE.Quaternion.prototype.copy = function (value) {
    return storedFields(qCopy.call(this, value), quaternion)
  }
  const qFromArray = THREE.Quaternion.prototype.fromArray
  THREE.Quaternion.prototype.fromArray = function (array, offset = 0) {
    return storedFields(qFromArray.call(this, array, offset), quaternion)
  }
  const eSet = THREE.Euler.prototype.set
  THREE.Euler.prototype.set = function (x, y, z, order) {
    return eSet.call(this, storable(x), storable(y), storable(z), order)
  }
  const eCopy = THREE.Euler.prototype.copy
  THREE.Euler.prototype.copy = function (value) {
    return storedFields(eCopy.call(this, value), euler)
  }
  const eFromArray = THREE.Euler.prototype.fromArray
  THREE.Euler.prototype.fromArray = function (array) {
    return storedFields(eFromArray.call(this, array), euler)
  }
  Object.defineProperty(THREE.Quaternion.prototype, '__componentsStored', { value: true })
}

// install three-mesh-bvh
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

// utility to resize instanced mesh buffers
THREE.InstancedMesh.prototype.resize = function (size) {
  const prevSize = this.instanceMatrix.array.length / 16
  if (size <= prevSize) return
  const matrices = new Float32Array(size * 16)
  matrices.set(this.instanceMatrix.array)
  this.instanceMatrix = new THREE.InstancedBufferAttribute(matrices, 16)
  this.instanceMatrix.needsUpdate = true
  if (this.instanceColor) {
    const colors = new Float32Array(size * 3) // RGB values
    colors.set(this.instanceColor.array)
    this.instanceColor = new THREE.InstancedBufferAttribute(colors, 3)
    this.instanceColor.needsUpdate = true
  }
  if (this.instanceEmissive) {
    const colors = new Float32Array(size * 3) // RGB values
    colors.set(this.instanceEmissive.array)
    this.instanceEmissive = new THREE.InstancedBufferAttribute(colors, 3)
    this.instanceEmissive.needsUpdate = true
    this.geometry.setAttribute('instanceEmissive', this.instanceEmissive)
  }
  if (this.instanceEmissiveIntensity) {
    const values = new Float32Array(size) // floats
    values.set(this.instanceEmissiveIntensity.array)
    this.instanceEmissiveIntensity = new THREE.InstancedBufferAttribute(values, 1)
    this.instanceEmissiveIntensity.needsUpdate = true
    this.geometry.setAttribute('instanceEmissiveIntensity', this.instanceEmissiveIntensity)
  }
}

THREE.InstancedMesh.prototype.setEmissiveAt = function (index, color) {
  // similar to .setColorAt
  if (!this.instanceEmissive) {
    const colors = new Float32Array(this.instanceMatrix.count * 3)
    this.instanceEmissive = new THREE.InstancedBufferAttribute(colors, 3)
    this.geometry.setAttribute('instanceEmissive', this.instanceEmissive)
  }
  color.toArray(this.instanceEmissive.array, index * 3)
  this.instanceEmissive.needsUpdate = true
}

THREE.InstancedMesh.prototype.setEmissiveIntensityAt = function (index, amount) {
  // similar to .setColorAt
  if (!this.instanceEmissiveIntensity) {
    const values = new Float32Array(this.instanceMatrix.count)
    this.instanceEmissiveIntensity = new THREE.InstancedBufferAttribute(values, 1)
    this.geometry.setAttribute('instanceEmissiveIntensity', this.instanceEmissiveIntensity)
  }
  this.instanceEmissiveIntensity.array[index] = amount
  this.instanceEmissiveIntensity.needsUpdate = true
}
