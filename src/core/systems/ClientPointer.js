import * as THREE from '../extras/three'
import { ControlPriorities } from '../extras/ControlPriorities'

import { System } from './System'
import { nodeFailed } from '../extras/nodeFailure'
import { NODE_CLIMB_LIMIT } from '../extras/nodeLimits.js'

const v1 = new THREE.Vector3()

/**
 *
 * This system handles pointer events.
 * It handles pointer events while the pointer is locked via reticle raycasting.
 * It handles pointer events while the cursor is being used, via world UI.
 *
 */

export class ClientPointer extends System {
  constructor(world) {
    super(world)
    this.pointerState = new PointerState()
  }

  init({ ui }) {
    this.ui = ui
  }

  start() {
    this.control = this.world.controls.bind({
      priority: ControlPriorities.POINTER,
    })
  }

  // the pointer path runs host code over script-owned nodes (hit resolution, cursors, callbacks): if it throws,
  // the hit node's app crashes, the path is reset and the frame goes on
  update(delta) {
    try {
      this.updatePointer()
    } catch (err) {
      nodeFailed(this.pointerState.hit?.node, 'pointer', err)
      this.pointerState.reset()
    }
  }

  updatePointer() {
    let hit
    let pressed
    let released
    if (this.control.xrLeftTrigger.value || this.control.xrRightTrigger.value) {
      const ray = this.control.xrLeftTrigger.value ? this.control.xrLeftRayPose : this.control.xrRightRayPose
      const dir = v1.set(0, 0, -1).applyQuaternion(ray.quaternion)
      hit = this.world.stage.raycast(ray.position, dir)[0]
      const trigger = this.control.xrLeftTrigger.value ? this.control.xrLeftTrigger : this.control.xrRightTrigger
      pressed = trigger.pressed
      released = trigger.released
    } else if (this.control.pointer.locked) {
      hit = this.world.stage.raycastReticle()[0]
      pressed = this.control.mouseLeft.pressed
      released = this.control.mouseLeft.released
    } else {
      hit = this.screenHit
      pressed = this.control.mouseLeft.pressed
      released = this.control.mouseLeft.released
    }
    this.pointerState.hit = hit
    this.pointerState.update(hit, pressed, released)
  }

  setScreenHit(screenHit) {
    this.screenHit = screenHit
    // capture all mouse click events if our pointer is interacting with world UI
    this.control.mouseLeft.capture = !!screenHit
  }

  destroy() {
    this.control?.release()
    this.control = null
  }
}

const PointerEvents = {
  ENTER: 'pointerenter',
  LEAVE: 'pointerleave',
  DOWN: 'pointerdown',
  UP: 'pointerup',
}

const CURSOR_DEFAULT = 'default'

// What a pointer callback of an app script receives: a new frozen object for every call. The engine used to pass
// one shared, mutable event object to every app, so a script could replace its methods (or those of its class)
// for the engine and for the other apps. `stopped()` stays with the engine.
export function createPointerEvent(type) {
  let propagationStopped = false
  const event = Object.freeze({
    type,
    stopPropagation: Object.freeze(() => {
      propagationStopped = true
    }),
  })
  return { event, stopped: () => propagationStopped }
}

// calls one script callback (without a receiver) and reports whether it stopped propagation
function dispatch(callback, type) {
  const { event, stopped } = createPointerEvent(type)
  try {
    Reflect.apply(callback, undefined, [event])
  } catch (err) {
    console.error(err)
  }
  return stopped()
}

export class PointerState {
  constructor() {
    this.activePath = new Set()
    this.cursor = CURSOR_DEFAULT
    this.pressedNodes = new Set()
    this.hit = null
  }

  reset() {
    this.activePath.clear()
    this.pressedNodes.clear()
    this.hit = null
    if (this.cursor !== CURSOR_DEFAULT && typeof document !== 'undefined') document.body.style.cursor = CURSOR_DEFAULT
    this.cursor = CURSOR_DEFAULT
  }

  update(hit, pointerPressed, pointerReleased) {
    const newPath = hit ? this.getAncestorPath(hit) : []
    const oldPath = Array.from(this.activePath)

    // find divergence point
    let i = 0
    while (i < newPath.length && i < oldPath.length && newPath[i] === oldPath[i]) i++

    // pointer leave events bubble up from leaf
    // (script callbacks run without a receiver; the path holds raw nodes)
    for (let j = oldPath.length - 1; j >= i; j--) {
      const onPointerLeave = oldPath[j].onPointerLeave
      // a leave is delivered to the whole path: stopPropagation does not apply to it
      if (onPointerLeave) dispatch(onPointerLeave, PointerEvents.LEAVE)
      this.activePath.delete(oldPath[j])
    }

    // pointer enter events bubble down from divergence
    for (let j = i; j < newPath.length; j++) {
      const onPointerEnter = newPath[j].onPointerEnter
      if (onPointerEnter && dispatch(onPointerEnter, PointerEvents.ENTER)) break
      this.activePath.add(newPath[j])
    }

    // set cursor - check from leaf to root for first defined cursor
    // (Node's cursor setter keeps only primitive strings; anything else here falls back to the default)
    let cursor = CURSOR_DEFAULT
    if (newPath.length > 0) {
      for (let i = newPath.length - 1; i >= 0; i--) {
        if (newPath[i].cursor) {
          if (typeof newPath[i].cursor === 'string') cursor = newPath[i].cursor
          break
        }
      }
    }
    if (cursor !== this.cursor) {
      document.body.style.cursor = cursor
      this.cursor = cursor
    }

    // handle pointer down events
    if (pointerPressed) {
      for (let i = newPath.length - 1; i >= 0; i--) {
        const node = newPath[i]
        const onPointerDown = node.onPointerDown
        if (onPointerDown) {
          const stopped = dispatch(onPointerDown, PointerEvents.DOWN)
          this.pressedNodes.add(node)
          if (stopped) break
        }
      }
    }

    // handle pointer up events
    if (pointerReleased) {
      for (const node of this.pressedNodes) {
        const onPointerUp = node.onPointerUp
        if (onPointerUp && dispatch(onPointerUp, PointerEvents.UP)) break
      }
      this.pressedNodes.clear()
    }
  }

  getAncestorPath(hit) {
    const path = []
    let node = hit.node?.resolveHit?.(hit) || hit.node
    while (node && path.length < NODE_CLIMB_LIMIT) {
      path.unshift(node)
      node = node.parent
    }
    return path
  }
}
