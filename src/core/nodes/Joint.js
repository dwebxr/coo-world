import * as THREE from '../extras/three'
import { vec3ToPxPos, quatToPxRot } from '../extras/physxConvert.js'
import { isBoolean, isNumber } from 'lodash-es'

import { Node, getNodeRef } from './Node'
import { Layers } from '../extras/Layers'
import { bindRotations } from '../extras/bindRotations'
import { DEG2RAD, RAD2DEG } from '../extras/general'
import { finiteNumber, normalizeQuat, positionOk, warnPhysicsOnce } from '../extras/physicsValidate.js'

const _q1 = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()

const defaults = {
  type: 'fixed',
  body0: null,
  body1: null,
  breakForce: Infinity,
  breakTorque: Infinity,
  limitY: null,
  limitZ: null,
  limitMin: null,
  limitMax: null,
  limitStiffness: null,
  limitDamping: null,
  collide: false,
}

const types = ['fixed', 'socket', 'hinge', 'distance']

// a break force or torque is a number >= 0 (Infinity, the default, never breaks); anything else is the default
function breakValue(value) {
  return typeof value === 'number' && value >= 0 ? value : Infinity
}

export class Joint extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'joint'

    this.type = data.type || defaults.type
    this.body0 = null
    this.offset0 = new THREE.Vector3(0, 0, 0)
    this.quaternion0 = new THREE.Quaternion(0, 0, 0, 1)
    this.rotation0 = new THREE.Euler(0, 0, 0, 'YXZ')
    bindRotations(this.quaternion0, this.rotation0)
    this.body1 = null
    this.offset1 = new THREE.Vector3(0, 0, 0)
    this.quaternion1 = new THREE.Quaternion(0, 0, 0, 1)
    this.rotation1 = new THREE.Euler(0, 0, 0, 'YXZ')
    bindRotations(this.quaternion1, this.rotation1)
    this.breakForce = isNumber(data.breakForce) ? data.breakForce : defaults.breakForce
    this.breakTorque = isNumber(data.breakTorque) ? data.breakTorque : defaults.breakTorque
    this.axis = new THREE.Vector3(0, 1, 0)
    this.limitY = isNumber(data.limitY) ? data.limitY : defaults.limitY
    this.limitZ = isNumber(data.limitZ) ? data.limitZ : defaults.limitZ
    this.limitMin = isNumber(data.limitMin) ? data.limitMin : defaults.limitMin
    this.limitMax = isNumber(data.limitMax) ? data.limitMax : defaults.limitMax
    this.limitStiffness = isNumber(data.limitStiffness) ? data.limitStiffness : defaults.limitStiffness
    this.limitDamping = isNumber(data.limitDamping) ? data.limitDamping : defaults.limitDamping
    this.collide = isBoolean(data.collide) ? data.collide : defaults.collide

    this.frame0 = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
    this.frame1 = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
  }

  mount() {
    const actor0 = this.body0?.actor
    const actor1 = this.body1?.actor
    if (!actor0 && !actor1) return // at least one required
    const frame0 = this.frame0
    const frame1 = this.frame1
    // every limit, spring and frame is checked before PhysX sees it: an invalid cone, a zero frame rotation, a far
    // anchor or an out-of-range hinge limit turns the jointed bodies (and what they touch) NaN
    if (!positionOk(this.offset0) || !positionOk(this.offset1)) {
      warnPhysicsOnce(this, 'offset', '[joint] an offset is outside the physics range; joint skipped')
      this.needsRebuild = false
      return
    }
    vec3ToPxPos(this.offset0, frame0)
    vec3ToPxPos(this.offset1, frame1)
    _q1.copy(this.quaternion0)
    _q2.copy(this.quaternion1)
    if (this.type === 'socket' || this.type === 'hinge') {
      // create rotation to align X-axis with desired axis and apply (this relates to the limit angles)
      const alignRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), this.axis)
      _q1.multiply(alignRotation)
      _q2.multiply(alignRotation)
    }
    if (this.type !== 'distance') {
      if (!normalizeQuat(_q1) || !normalizeQuat(_q2)) {
        warnPhysicsOnce(this, 'frame', '[joint] a frame rotation has no usable length; joint skipped')
        this.needsRebuild = false
        return
      }
      quatToPxRot(_q1, frame0)
      quatToPxRot(_q2, frame1)
    }
    const physics = this.ctx.world.physics.physics

    if (this.type === 'fixed') {
      this.joint = new PHYSX.FixedJointCreate(physics, actor0, frame0, actor1, frame1)
    }

    if (this.type === 'socket') {
      this.joint = new PHYSX.SphericalJointCreate(physics, actor0, frame0, actor1, frame1)
      // apply cone limit (each angle below 180 degrees)
      if (finiteNumber(this.limitY) && finiteNumber(this.limitZ)) {
        const spring = this.createSpring()
        const cone = new PHYSX.PxJointLimitCone(this.limitY * DEG2RAD, this.limitZ * DEG2RAD, spring)
        if (cone.isValid()) {
          this.joint.setLimitCone(cone)
          this.joint.setSphericalJointFlag(PHYSX.PxSphericalJointFlagEnum.eLIMIT_ENABLED, true)
        } else {
          warnPhysicsOnce(this, 'limit', '[joint] socket limit is not valid; limit skipped')
        }
        PHYSX.destroy(cone)
        if (spring) PHYSX.destroy(spring)
      }
    }

    if (this.type === 'hinge') {
      this.joint = new PHYSX.RevoluteJointCreate(physics, actor0, frame0, actor1, frame1)
      // apply limits: ordered and inside (-360, 360) degrees (PhysX's revolute contract)
      if (finiteNumber(this.limitMin) && finiteNumber(this.limitMax)) {
        const inRange = Math.abs(this.limitMin) < 360 && Math.abs(this.limitMax) < 360
        const spring = this.createSpring()
        const limit = new PHYSX.PxJointAngularLimitPair(this.limitMin * DEG2RAD, this.limitMax * DEG2RAD, spring)
        if (inRange && this.limitMin <= this.limitMax && limit.isValid()) {
          this.joint.setLimit(limit)
          this.joint.setRevoluteJointFlag(PHYSX.PxRevoluteJointFlagEnum.eLIMIT_ENABLED, true)
        } else {
          warnPhysicsOnce(this, 'limit', '[joint] hinge limit is not valid; limit skipped')
        }
        PHYSX.destroy(limit)
        if (spring) PHYSX.destroy(spring)
      }
    }

    if (this.type === 'distance') {
      // create rotation to align X-axis with desired axis and apply
      // const alignRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), this.axis)
      // quatToPxRot(_q1.copy(this.quaternion0).multiply(alignRotation), frame0)
      // quatToPxRot(_q2.copy(this.quaternion1).multiply(alignRotation), frame1)
      this.joint = new PHYSX.DistanceJointCreate(physics, actor0, frame0, actor1, frame1)
      // a new distance joint starts with the max limit enabled at 0, so both flags are cleared first
      this.joint.setDistanceJointFlag(PHYSX.PxDistanceJointFlagEnum.eMIN_DISTANCE_ENABLED, false)
      this.joint.setDistanceJointFlag(PHYSX.PxDistanceJointFlagEnum.eMAX_DISTANCE_ENABLED, false)
      // apply limits: each end only when it is set, finite and >= 0, and both only when they are ordered
      const hasMin = finiteNumber(this.limitMin) && this.limitMin >= 0
      const hasMax = finiteNumber(this.limitMax) && this.limitMax >= 0
      if (hasMin && hasMax && this.limitMin > this.limitMax) {
        warnPhysicsOnce(this, 'limit', '[joint] distance limitMin is above limitMax; limits skipped')
      } else {
        if (hasMin) {
          this.joint.setMinDistance(this.limitMin)
          this.joint.setDistanceJointFlag(PHYSX.PxDistanceJointFlagEnum.eMIN_DISTANCE_ENABLED, true)
        }
        if (hasMax) {
          this.joint.setMaxDistance(this.limitMax)
          this.joint.setDistanceJointFlag(PHYSX.PxDistanceJointFlagEnum.eMAX_DISTANCE_ENABLED, true)
        }
      }
      if (this.springOk()) {
        this.joint.setStiffness(this.limitStiffness)
        this.joint.setDamping(this.limitDamping)
        this.joint.setDistanceJointFlag(PHYSX.PxDistanceJointFlagEnum.eSPRING_ENABLED, true)
      }
    }

    if (this.collide) {
      this.joint.setConstraintFlag(PHYSX.PxConstraintFlagEnum.eCOLLISION_ENABLED, true)
    }
    this.joint.setBreakForce(breakValue(this.breakForce), breakValue(this.breakTorque))
    this.needsRebuild = false
  }

  springOk() {
    const ok = value => finiteNumber(value) && value >= 0
    return ok(this.limitStiffness) && ok(this.limitDamping)
  }

  createSpring() {
    return this.springOk() ? new PHYSX.PxSpring(this.limitStiffness, this.limitDamping) : undefined
  }

  commit(didMove) {
    if (this.needsRebuild) {
      this.unmount()
      this.mount()
      return
    }
    if (didMove) {
      // ...
    }
  }

  unmount() {
    this.joint?.release()
    this.joint = null
  }

  copy(source, recursive) {
    super.copy(source, recursive)
    this.type = source.type
    this.body0 = source.body0
    this.offset0.copy(source.offset0)
    this.quaternion0.copy(source.quaternion0)
    this.body1 = source.body1
    this.offset1.copy(source.offset1)
    this.quaternion1.copy(source.quaternion1)
    this.breakForce = source.breakForce
    this.breakTorque = source.breakTorque
    this.axis.copy(source.axis)
    this.limitY = source.limitY
    this.limitZ = source.limitZ
    this.limitMin = source.limitMin
    this.limitMax = source.limitMax
    this.limitStiffness = source.limitStiffness
    this.limitDamping = source.limitDamping
    this.collide = source.collide
    return this
  }

  getProxy() {
    if (!this.proxy) {
      const self = this
      let proxy = {
        get type() {
          return self.type
        },
        set type(value) {
          if (self.type === value) return
          if (!types.includes(value)) throw new Error(`[joint] invalid type: ${value}`)
          self.type = value
          self.needsRebuild = true
          self.setDirty()
        },
        get body0() {
          return self.body0?.getProxy() ?? null
        },
        set body0(value) {
          const node = value == null ? null : getNodeRef(value)
          if (value != null && (!node || node.name !== 'rigidbody')) {
            throw new Error('[joint] body0 must be a rigidbody')
          }
          self.body0 = node
          self.needsRebuild = true
          self.setDirty()
        },
        get offset0() {
          return self.offset0
        },
        get quaternion0() {
          return self.quaternion0
        },
        get rotation0() {
          return self.rotation0
        },
        get body1() {
          return self.body1?.getProxy() ?? null
        },
        set body1(value) {
          const node = value == null ? null : getNodeRef(value)
          if (value != null && (!node || node.name !== 'rigidbody')) {
            throw new Error('[joint] body1 must be a rigidbody')
          }
          self.body1 = node
          self.needsRebuild = true
          self.setDirty()
        },
        get offset1() {
          return self.offset1
        },
        get quaternion1() {
          return self.quaternion1
        },
        get rotation1() {
          return self.rotation1
        },
        get breakForce() {
          return self.breakForce
        },
        set breakForce(value) {
          self.breakForce = isNumber(value) ? value : defaults.breakForce
          self.needsRebuild = true
          self.setDirty()
        },
        get breakTorque() {
          return self.breakTorque
        },
        set breakTorque(value) {
          self.breakTorque = isNumber(value) ? value : defaults.breakTorque
          self.needsRebuild = true
          self.setDirty()
        },
        get limitY() {
          return self.limitY
        },
        set limitY(value) {
          self.limitY = value
          self.needsRebuild = true
          self.setDirty()
        },
        get axis() {
          return self.axis
        },
        get limitZ() {
          return self.limitZ
        },
        set limitZ(value) {
          self.limitZ = value
          self.needsRebuild = true
          self.setDirty()
        },
        get limitMin() {
          return self.limitMin
        },
        set limitMin(value) {
          self.limitMin = value
          self.needsRebuild = true
          self.setDirty()
        },
        get limitMax() {
          return self.limitMax
        },
        set limitMax(value) {
          self.limitMax = value
          self.needsRebuild = true
          self.setDirty()
        },
        get limitStiffness() {
          return self.limitStiffness
        },
        set limitStiffness(value) {
          self.limitStiffness = value
          self.needsRebuild = true
          self.setDirty()
        },
        get limitDamping() {
          return self.limitDamping
        },
        set limitDamping(value) {
          self.limitDamping = value
          self.needsRebuild = true
          self.setDirty()
        },
        get collide() {
          return self.collide
        },
        set collide(value) {
          self.collide = value
          self.needsRebuild = true
          self.setDirty()
        },
      }
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy())) // inherit Node properties
      this.proxy = proxy
    }
    return this.proxy
  }
}
