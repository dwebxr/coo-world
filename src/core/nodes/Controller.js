import { createLogOnce } from '../extras/logOnce.js'
import { callForScript } from '../extras/scriptValues'
import * as THREE from '../extras/three'
import {
  readVec3,
  writeVec3,
  warnOnce,
  vec3ToPx,
  pxToVec3,
  scratchPxVec3,
  scratchPxExtVec3,
} from '../extras/physxConvert.js'
import { isNumber, isBoolean, isString, isFunction } from 'lodash-es'

import { DEG2RAD } from '../extras/general'
import { finiteNumber, lengthOk, positionOk } from '../extras/physicsValidate.js'

import { Node } from './Node'
import { Layers } from '../extras/Layers'

const warnController = createLogOnce()

const layers = ['environment', 'prop', 'player', 'tool']

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()

const defaults = {
  radius: 0.4,
  height: 1,
  visible: false,
  layer: 'environment',
  tag: null,
  onContactStart: null,
  onContactEnd: null,
}

export class Controller extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'controller'

    this.radius = data.radius
    this.height = data.height
    this.visible = data.visible
    this.layer = data.layer
    this.tag = data.tag
    this.onContactStart = data.onContactStart
    this.onContactEnd = data.onContactEnd
  }

  mount() {
    this.needsRebuild = false
    if (this._visible) {
      const geometry = new THREE.CapsuleGeometry(this._radius, this._height, 2, 8)
      geometry.translate(0, this._height / 2 + this._radius, 0)
      geometry.computeBoundsTree()
      const material = new THREE.MeshStandardMaterial({ color: 'green' })
      this.mesh = new THREE.Mesh(geometry, material)
      this.mesh.receiveShadow = true
      this.mesh.castShadow = true
      this.mesh.matrixAutoUpdate = false
      this.mesh.matrixWorldAutoUpdate = false
      this.mesh.matrix.copy(this.matrix)
      this.mesh.matrixWorld.copy(this.matrixWorld)
      this.mesh.node = this
      this.ctx.world.graphics.scene.add(this.mesh)
    }
    this.controller = null
    // a capsule or a foot position outside the physics range corrupts the shared scene (a controller placed at 1e30
    // turns unrelated bodies NaN without touching them), so it gets no controller; teleport still moves the node
    if (!lengthOk(this._radius) || !lengthOk(this._height) || !positionOk(this.getWorldPosition())) {
      warnController(this, 'range', '[controller] radius, height or position outside the physics range; no controller')
      return
    }
    const desc = new PHYSX.PxCapsuleControllerDesc()
    desc.height = this._height
    desc.radius = this._radius
    desc.climbingMode = PHYSX.PxCapsuleClimbingModeEnum.eCONSTRAINED
    desc.slopeLimit = Math.cos(60 * DEG2RAD) // 60 degrees
    desc.material = this.ctx.world.physics.defaultMaterial
    desc.contactOffset = 0.1 // PhysX default = 0.1
    desc.stepOffset = 0.5 // PhysX default = 0.5m
    try {
      if (desc.isValid()) {
        const controller = this.ctx.world.physics.controllerManager.createController(desc)
        if (controller?.ptr) this.controller = controller
      }
    } finally {
      PHYSX.destroy(desc)
    }
    if (!this.controller) {
      warnController(this, 'controller', '[controller] invalid descriptor or failed to create controller')
      return
    }
    const worldPosition = this.getWorldPosition()
    const px = scratchPxExtVec3()
    vec3ToPx(worldPosition, px)
    this.controller.setFootPosition(px)

    const actor = this.controller.getActor()
    const nbShapes = actor.getNbShapes()
    const shapeBuffer = new PHYSX.PxArray_PxShapePtr(nbShapes)
    const shapesCount = actor.getShapes(shapeBuffer.begin(), nbShapes, 0)
    for (let i = 0; i < shapesCount; i++) {
      const shape = shapeBuffer.get(i)
      const layer = Layers[this._layer]
      let pairFlags =
        PHYSX.PxPairFlagEnum.eNOTIFY_TOUCH_FOUND |
        PHYSX.PxPairFlagEnum.eNOTIFY_TOUCH_LOST |
        PHYSX.PxPairFlagEnum.eNOTIFY_CONTACT_POINTS
      const filterData = new PHYSX.PxFilterData(layer.group, layer.mask, pairFlags, 0)
      const shapeFlags = new PHYSX.PxShapeFlags()
      shapeFlags.raise(PHYSX.PxShapeFlagEnum.eSCENE_QUERY_SHAPE | PHYSX.PxShapeFlagEnum.eSIMULATION_SHAPE)
      shape.setFlags(shapeFlags)
      shape.setQueryFilterData(filterData)
      shape.setSimulationFilterData(filterData)
    }
    const self = this
    this.actorHandle = this.ctx.world.physics.addActor(actor, {
      controller: true,
      node: self,
      get tag() {
        return self._tag
      },
      playerId: null,
      get onContactStart() {
        return self._onContactStart
      },
      get onContactEnd() {
        return self._onContactEnd
      },
      onTriggerEnter: null,
      onTriggerLeave: null,
    })
  }

  commit(didMove) {
    if (this.needsRebuild) {
      this.unmount()
      this.mount()
      return
    }
    if (didMove) {
      this.mesh?.matrix.copy(this.matrix)
      this.mesh?.matrixWorld.copy(this.matrixWorld)
    }
    // if (this.didMove) {
    //   console.log('character position change without move() ????')
    //   const worldPosition = this.getWorldPosition()
    //   const px = scratchPxExtVec3()
    //   vec3ToPx(worldPosition, px)
    //   this.controller.setFootPosition(px)
    //   this.didMove = false
    // }
  }

  unmount() {
    if (this.mesh) {
      this.ctx.world.graphics.scene.remove(this.mesh)
      this.mesh = null
    }
    this.actorHandle?.destroy()
    this.actorHandle = null
    this.controller?.release()
    this.controller = null
    this.moveFlags = null
  }

  copy(source, recursive) {
    super.copy(source, recursive)
    this._radius = source._radius
    this._height = source._height
    this._visible = source._visible
    this._layer = source._layer
    this._tag = source._tag
    this._onContactStart = source._onContactStart
    this._onContactEnd = source._onContactEnd
    return this
  }

  get radius() {
    return this._radius
  }

  set radius(value = defaults.radius) {
    if (!finiteNumber(value)) {
      throw new Error('[controller] radius not a finite number')
    }
    this._radius = value
    this.needsRebuild = true
    this.setDirty()
  }

  get height() {
    return this._height
  }

  set height(value = defaults.height) {
    if (!finiteNumber(value)) {
      throw new Error('[controller] height not a finite number')
    }
    this._height = value
    this.needsRebuild = true
    this.setDirty()
  }

  get visible() {
    return this._visible
  }

  set visible(value = defaults.visible) {
    if (!isBoolean(value)) {
      throw new Error('[controller] visible not a boolean')
    }
    this._visible = value
    this.needsRebuild = true
    this.setDirty()
  }

  get layer() {
    return this._layer
  }

  set layer(value = defaults.layer) {
    if (!isLayer(value)) {
      throw new Error(`[controller] invalid layer: ${value}`)
    }
    this._layer = value
    if (this.controller) {
      // TODO: we could just update the PxFilterData tbh
      this.needsRebuild = true
      this.setDirty()
    }
  }

  get tag() {
    return this._tag
  }

  set tag(value = defaults.tag) {
    if (isNumber(value)) {
      value = value + ''
    }
    if (value !== null && !isString(value)) {
      throw new Error('[controller] tag not a string')
    }
    this._tag = value
  }

  get onContactStart() {
    return this._onContactStart
  }

  set onContactStart(value = defaults.onContactStart) {
    if (value !== null && !isFunction(value)) {
      throw new Error('[controller] onContactStart not a function')
    }
    this._onContactStart = value
  }

  get onContactEnd() {
    return this._onContactEnd
  }

  set onContactEnd(value = defaults.onContactEnd) {
    if (value !== null && !isFunction(value)) {
      throw new Error('[controller] onContactEnd not a function')
    }
    this._onContactEnd = value
  }

  get isGrounded() {
    if (!this.moveFlags) return false
    return this.moveFlags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_DOWN)
  }

  get isCeiling() {
    if (!this.moveFlags) return false
    return this.moveFlags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_UP)
  }

  teleport(vec3) {
    if (!readVec3(vec3, _v1, '[controller] teleport expected Vector3')) {
      warnOnce('[controller] teleport ignored a non-finite vector')
      return
    }
    if (!positionOk(_v1)) {
      warnOnce('[controller] teleport ignored a position outside the physics range')
      return
    }
    writeVec3(this.position, _v1.x, _v1.y, _v1.z)
    if (!this.controller) return
    const px = scratchPxExtVec3()
    vec3ToPx(_v1, px)
    this.controller.setFootPosition(px)
  }

  move(vec3) {
    if (!readVec3(vec3, _v1, '[controller] move expected Vector3')) {
      warnOnce('[controller] move ignored a non-finite vector')
      return
    }
    if (!this.controller) return
    const foot = this.controller.getFootPosition()
    if (!positionOk(_v2.set(foot.x + _v1.x, foot.y + _v1.y, foot.z + _v1.z))) {
      warnOnce('[controller] move ignored a displacement that leaves the physics range')
      return
    }
    const px = scratchPxVec3()
    vec3ToPx(_v1, px)
    const physics = this.ctx.world.physics
    try {
      this.moveFlags = this.controller.move(px, 0, 1 / 60, physics.controllerFilters)
    } finally {
      physics.drainCallbackFailures()
    }
    // this.isGrounded = moveFlags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_DOWN) // prettier-ignore
    const pos = this.controller.getFootPosition()
    pxToVec3(this.position, pos)
    this.didMove = true
  }

  getProxy() {
    if (!this.proxy) {
      const self = this
      let proxy = {
        get radius() {
          return self.radius
        },
        set radius(value) {
          self.radius = value
        },
        get height() {
          return self.height
        },
        set height(value) {
          self.height = value
        },
        get visible() {
          return self.visible
        },
        set visible(value) {
          self.visible = value
        },
        get layer() {
          return self.layer
        },
        set layer(value) {
          if (value === 'player') {
            throw new Error('[controller] layer invalid: player')
          }
          self.layer = value
        },
        get tag() {
          return self.tag
        },
        set tag(value) {
          self.tag = value
        },
        get onContactStart() {
          return self.onContactStart
        },
        set onContactStart(value) {
          self.onContactStart = value
        },
        get onContactEnd() {
          return self.onContactEnd
        },
        set onContactEnd(value) {
          self.onContactEnd = value
        },
        get isGrounded() {
          return callForScript(() => self.isGrounded, self, [])
        },
        get isCeiling() {
          return callForScript(() => self.isCeiling, self, [])
        },
        teleport(vec3) {
          return callForScript(self.teleport, self, [vec3])
        },
        move(vec3) {
          return callForScript(self.move, self, [vec3])
        },
      }
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy())) // inherit Node properties
      this.proxy = proxy
    }
    return this.proxy
  }
}

function isLayer(value) {
  return layers.includes(value)
}
