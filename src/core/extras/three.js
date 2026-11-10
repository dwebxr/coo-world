import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'

import * as THREE from 'three'
import { toEngineNumber, toEngineOrder } from './engineNumber.js'

export * from 'three'

// override THREE.Vector3 with ours to support _onChange
export { Vector3Enhanced as Vector3 } from './Vector3Enhanced'

// Quaternion and Euler (a node's quaternion and rotation, and every Object3D's): a component is always a number, as
// for our Vector3 (the engine's number rule, engineNumber.js: a string, a boolean or null is converted, anything else
// that is not a number is NaN, without being converted, so no valueOf or toString a script defined runs in the
// engine's arithmetic later), and an order is always a string (anything else leaves the order as it was). The
// methods that store what they are given or read from another object (x/y/z/w and order, set, copy, fromArray)
// apply the rule to each value before they store it, so the change callback (an Object3D sets its rotation from its
// quaternion there, a node its matrix inputs) only ever sees numbers. Installed once on the prototypes, before they
// are frozen for scripts.
function storeComponents(proto, keys) {
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(proto, key)
    if (!desc?.set) continue
    const set = desc.set
    Object.defineProperty(proto, key, {
      ...desc,
      set(value) {
        set.call(this, toEngineNumber(value))
      },
    })
  }
}
if (!Object.prototype.hasOwnProperty.call(THREE.Quaternion.prototype, '__componentsStored')) {
  storeComponents(THREE.Quaternion.prototype, ['x', 'y', 'z', 'w'])
  storeComponents(THREE.Euler.prototype, ['x', 'y', 'z'])
  const orderDesc = Object.getOwnPropertyDescriptor(THREE.Euler.prototype, 'order')
  const setOrder = orderDesc.set
  Object.defineProperty(THREE.Euler.prototype, 'order', {
    ...orderDesc,
    set(value) {
      setOrder.call(this, toEngineOrder(value, this._order))
    },
  })
  const qSet = THREE.Quaternion.prototype.set
  THREE.Quaternion.prototype.set = function (x, y, z, w) {
    return qSet.call(this, toEngineNumber(x), toEngineNumber(y), toEngineNumber(z), toEngineNumber(w))
  }
  THREE.Quaternion.prototype.copy = function (quaternion) {
    this._x = toEngineNumber(quaternion.x)
    this._y = toEngineNumber(quaternion.y)
    this._z = toEngineNumber(quaternion.z)
    this._w = toEngineNumber(quaternion.w)
    this._onChangeCallback()
    return this
  }
  THREE.Quaternion.prototype.fromArray = function (array, offset = 0) {
    this._x = toEngineNumber(array[offset])
    this._y = toEngineNumber(array[offset + 1])
    this._z = toEngineNumber(array[offset + 2])
    this._w = toEngineNumber(array[offset + 3])
    this._onChangeCallback()
    return this
  }
  const eSet = THREE.Euler.prototype.set
  THREE.Euler.prototype.set = function (x, y, z, order) {
    const value = toEngineOrder(order, this._order)
    return eSet.call(this, toEngineNumber(x), toEngineNumber(y), toEngineNumber(z), value)
  }
  THREE.Euler.prototype.copy = function (euler) {
    this._x = toEngineNumber(euler._x)
    this._y = toEngineNumber(euler._y)
    this._z = toEngineNumber(euler._z)
    this._order = toEngineOrder(euler._order, this._order)
    this._onChangeCallback()
    return this
  }
  THREE.Euler.prototype.fromArray = function (array) {
    this._x = toEngineNumber(array[0])
    this._y = toEngineNumber(array[1])
    this._z = toEngineNumber(array[2])
    if (array[3] !== undefined) this._order = toEngineOrder(array[3], this._order)
    this._onChangeCallback()
    return this
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
