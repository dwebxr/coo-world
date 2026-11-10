import { isTouch } from '../../client/utils'
import { bindRotations } from '../extras/bindRotations'
import { buttons, codeToProp } from '../extras/buttons'
import * as THREE from '../extras/three'
import { System } from './System'
import { createControlProxy } from './controlProxy'
import { callEntry, callScript } from '../extras/callScript'
import { readOnce, toText } from '../extras/scriptText'
import { briefError, createLogOnce } from '../extras/logOnce'
import { setQuaternionFromPoint, setVectorFromPoint } from '../extras/xrPose'

const LMB = 1 // bitmask
const RMB = 2 // bitmask
const MouseLeft = 'mouseLeft'
const MouseRight = 'mouseRight'
const HandednessLeft = 'left'
const HandednessRight = 'right'

const XR_TREMOR_SMOOTHING_FACTOR = 0.6

const m1 = new THREE.Matrix4()
const m2 = new THREE.Matrix4()
const v1 = new THREE.Vector3()
const v2 = new THREE.Vector3()
const q1 = new THREE.Quaternion()
const q2 = new THREE.Quaternion()
const s1 = new THREE.Vector3()

const captured = new Set()

// what bind() returned -> { control, release }, for the host only: the host releases a control and hands its pointer
// lock over by this lookup, never by reading the object a script holds (a script can make any property read on it
// throw, eg by defining a non-configurable `release` on it)
const controlsByProxy = new WeakMap()

let actionIds = 0

// a control whose script-held entries make per-frame work throw is reported once per control and phase
const logControlFailure = createLogOnce(message => console.error(message))

// Per-frame work writes into and reads from entries a script holds (accessors and own methods are possible).
// A control that throws there must not stop the frame: an app's control crashes its app (and is skipped from
// then on, see `active`); any other control is reported.
function controlFailed(control, phase, err) {
  const owner = control.options.object
  const label = owner?.isApp ? `app ${String(owner.data?.id).slice(0, 64)}` : 'host'
  logControlFailure(control, phase, `[controls] ${phase} failed (${label}): ${briefError(err)}`)
  if (owner?.isApp && !owner.crashed) {
    owner.scriptError = { name: 'Error', message: `[controls] ${phase} failed` }
    owner.crash?.()
  }
}

// A touch as an app's control sees it: one frozen object per control and touch, the same at onTouch and onTouchEnd
// (so it can be kept and compared), whose getters read the host's live record and return new vectors made from
// its numbers. The live record itself stays with the host and the player's stick. The host lists the facades per
// touch (ClientControls.touchFacades) and drops them when the touch ends or their control is released; a facade kept
// after that answers with the touch's last values and holds nothing of the host's (no record, control or app).
function createTouchFacade(info) {
  let source = info
  const facade = Object.freeze({
    get id() {
      return source.id
    },
    get position() {
      return new THREE.Vector3(source.position.x, source.position.y, 0)
    },
    get prevPosition() {
      return new THREE.Vector3(source.prevPosition.x, source.prevPosition.y, 0)
    },
    get delta() {
      return new THREE.Vector3(source.delta.x, source.delta.y, 0)
    },
    get pointerType() {
      return source.pointerType
    },
  })
  const detach = () => {
    const { id, position, prevPosition, delta, pointerType } = source
    source = {
      id,
      position: { x: position.x, y: position.y },
      prevPosition: { x: prevPosition.x, y: prevPosition.y },
      delta: { x: delta.x, y: delta.y },
      pointerType,
    }
  }
  return { facade, detach }
}

// the action hints a control shows in the HUD (CoreUI Actions): host objects built from the given list, reading
// each property once and keeping only strings (a script's objects, getters or forged React elements never reach
// the renderer, and nothing is written back onto them)
export const ACTIONS_LIMIT = 64
const ACTION_TYPE_MAX = 64
const ACTION_LABEL_MAX = 128
const ACTION_BTN_MAX = 16

export function copyActions(list) {
  const length = readOnce(list, 'length')
  const count = typeof length === 'number' && length > 0 ? Math.min(length, ACTIONS_LIMIT) : 0
  const actions = []
  for (let i = 0; i < count; i++) {
    const action = readOnce(list, i)
    if (action === null || typeof action !== 'object') continue
    actions.push({
      id: ++actionIds,
      type: toText(readOnce(action, 'type'), ACTION_TYPE_MAX),
      label: toText(readOnce(action, 'label'), ACTION_LABEL_MAX),
      btn: toText(readOnce(action, 'btn'), ACTION_BTN_MAX),
    })
  }
  return actions
}

/**
 * Control System
 *
 * - runs on the client
 * - provides a layered priority control system for both input and output
 *
 */

const isBrowser = typeof window !== 'undefined'

const controlTypes = {
  // key: createButton,
  mouseLeft: createButton,
  mouseRight: createButton,
  touchStick: createVector,
  scrollDelta: createValue,
  pointer: createPointer,
  screen: createScreen,
  camera: createCamera,
  xrLeftRayPose: createPose,
  xrLeftGripPose: createPose,
  xrLeftStick: createVector,
  xrLeftTrigger: createButton,
  xrLeftGrip: createButton,
  xrLeftBtn1: createButton,
  xrLeftBtn2: createButton,
  xrRightRayPose: createPose,
  xrRightGripPose: createPose,
  xrRightStick: createVector,
  xrRightTrigger: createButton,
  xrRightGrip: createButton,
  xrRightBtn1: createButton,
  xrRightBtn2: createButton,
  touchA: createButton,
  touchB: createButton,
}

export class ClientControls extends System {
  constructor(world) {
    super(world)
    this.controls = []
    this.actions = []
    this.buttonsDown = new Set()
    this.isUserGesture = false
    this.isMac = /Mac/.test(navigator.platform)
    this.pointer = {
      locked: false,
      shouldLock: false,
      coords: new THREE.Vector3(), // [0,0] to [1,1]
      position: new THREE.Vector3(), // [0,0] to [viewportWidth,viewportHeight]
      delta: new THREE.Vector3(), // position delta (pixels)
    }
    this.touches = new Map() // id -> { id, position, delta, prevPosition }
    // host touch record -> Map(control -> { facade, detach }): the touch facades handed to app controls (above)
    this.touchFacades = new Map()
    // XR tremor smoothing state per ray pose entry: the engine's own vectors, never on the entry a script holds (a
    // script could replace a method there and be handed the engine's shared temporaries); removed with its control
    this.raySmoothing = new Map()
    // the control that locked the pointer: its release (by its script, or when its app run ends) unlocks it
    this.pointerOwner = null
    this.screen = {
      width: 0,
      height: 0,
    }
    this.scroll = {
      delta: 0,
    }
    this.xrSession = null
  }

  start() {
    this.world.on('xrSession', this.onXRSession)
  }

  applyXRRig(xrRig) {
    for (const control of this.controls) {
      if (!control.active) continue
      try {
        this.applyXRRigTo(control, xrRig)
      } catch (err) {
        controlFailed(control, 'xr rig', err)
      }
    }
  }

  // the ray poses in world space: computed in the engine's own objects, written to the script's pose as numbers
  applyXRRigTo(control, xrRig) {
    for (const pose of [control.entries.xrLeftRayPose, control.entries.xrRightRayPose]) {
      const smooth = pose && this.raySmoothing.get(pose)
      if (!smooth) continue
      const scale = v1.set(1, 1, 1)
      m1.compose(smooth.position, smooth.quaternion, scale)
      m2.compose(xrRig.position, xrRig.quaternion, scale)
      m1.premultiply(m2)
      m1.decompose(v2, q2, s1)
      pose.position.set(v2.x, v2.y, v2.z)
      pose.quaternion.set(q2.x, q2.y, q2.z, q2.w)
    }
  }

  preFixedUpdate() {
    // mouse wheel delta
    for (const control of this.controls) {
      if (!control.active) continue
      let captured = false
      try {
        if (control.entries.scrollDelta) {
          control.entries.scrollDelta.value = this.scroll.delta
          captured = !!control.entries.scrollDelta.capture
        }
      } catch (err) {
        controlFailed(control, 'scroll', err)
      }
      if (captured) break
    }
    // xr
    if (this.xrSession) {
      const referenceSpace = this.world.graphics.renderer.xr.getReferenceSpace()
      const frame = this.world.graphics.renderer.xr.getFrame()
      const player = this.world.entities.player
      this.xrSession.inputSources?.forEach(src => {
        if (src.gamepad && src.handedness === HandednessLeft) {
          updateXRHand(this, src, frame, referenceSpace, 'Left')
        }
        if (src.gamepad && src.handedness === HandednessRight) {
          updateXRHand(this, src, frame, referenceSpace, 'Right')
        }
      })
    }
  }

  postLateUpdate() {
    // clear pointer delta
    this.pointer.delta.set(0, 0, 0)
    // clear scroll delta
    this.scroll.delta = 0
    // clear buttons
    for (const control of this.controls) {
      if (!control.active) continue
      try {
        for (const key in control.entries) {
          const value = control.entries[key]
          if (value.$button) {
            value.pressed = false
            value.released = false
          }
        }
      } catch (err) {
        controlFailed(control, 'buttons', err)
      }
    }
    // update camera: only numbers move between the rig and a control's camera, so no host object reaches a method
    // of an object a script holds, and a value that is not a finite number never reaches the rig
    let written
    const rig = this.world.rig
    for (const control of this.controls) {
      if (!control.active) continue
      try {
        const camera = control.entries.camera
        if (camera?.write && !written) {
          written = true
          const p = camera.position
          const q = camera.quaternion
          const values = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, camera.zoom]
          if (values.every(Number.isFinite)) {
            rig.position.set(values[0], values[1], values[2])
            rig.quaternion.set(values[3], values[4], values[5], values[6])
            this.world.camera.position.z = values[7]
          }
        } else if (camera) {
          camera.position.set(rig.position.x, rig.position.y, rig.position.z)
          camera.quaternion.set(rig.quaternion.x, rig.quaternion.y, rig.quaternion.z, rig.quaternion.w)
          camera.zoom = this.world.camera.position.z
        }
      } catch (err) {
        controlFailed(control, 'camera', err)
      }
    }
    // clear touch deltas
    for (const [id, info] of this.touches) {
      info.delta.set(0, 0, 0)
    }
  }

  async init({ viewport }) {
    if (!isBrowser) return
    this.viewport = viewport
    this.screen.width = this.viewport.offsetWidth
    this.screen.height = this.viewport.offsetHeight
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    this.viewport.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    this.viewport.addEventListener('pointerup', this.onPointerUp)
    this.viewport.addEventListener('pointercancel', this.onPointerUp)
    this.viewport.addEventListener('wheel', this.onScroll, { passive: false })
    document.body.addEventListener('contextmenu', this.onContextMenu)
    this.viewport.addEventListener('touchstart', this.onTouchStart)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('focus', this.onFocus)
    window.addEventListener('blur', this.onBlur)
  }

  // `owner` (host-only, from Apps.control) is the app run the control belongs to: once that run has ended the control
  // is inert, whatever its script did to the object it holds
  bind(options = {}, owner = null) {
    const self = this
    const entries = {}
    let reticleSupressor
    // a released control (by its script, or when its app run ended) keeps answering, but changes nothing
    let released = false
    const runEnded = () => !!owner && owner.run !== owner.entity.deadHook
    const control = {
      options,
      get active() {
        return !released && !runEnded() && !self.world.fatalError && !options.object?.crashed
      },
      // true while its onRelease callback runs
      releasing: false,
      entries,
      actions: null,
      api: {
        hideReticle(value = true) {
          if (released || runEnded()) return
          if (reticleSupressor && value) return
          if (!reticleSupressor && !value) return
          if (reticleSupressor) {
            reticleSupressor?.()
            reticleSupressor = null
          } else {
            reticleSupressor = self.world.ui.suppressReticle()
          }
        },
        setActions(value) {
          if (value !== null && !Array.isArray(value)) {
            throw new Error('[control] actions must be null or array')
          }
          if (released) return
          control.actions = value ? copyActions(value) : null
          self.buildActions()
        },
        release: () => {
          if (released) return
          // the onRelease callback runs as before: only for a control whose app did not crash
          const wasActive = control.active
          released = true
          reticleSupressor?.()
          reticleSupressor = null
          const idx = this.controls.indexOf(control)
          if (idx === -1) return
          this.controls.splice(idx, 1)
          // nothing the host keeps for it (touch facades, XR smoothing) outlives it
          self.dropControlState(control)
          // its hints leave the HUD with it
          if (control.actions) self.buildActions()
          // the options object is host-owned, so its callbacks run without a receiver. The control's own callback
          // may still unlock the pointer (control.releasing)
          if (wasActive) {
            control.releasing = true
            try {
              callScript(options.onRelease)
            } finally {
              control.releasing = false
            }
          }
          // a pointer lock it took (and its callback did not end) ends with it
          if (self.pointerOwner === control) self.unlockPointer()
        },
      },
    }
    // insert at correct priority level
    // - 0 is lowest priority generally for player controls
    // - apps use higher priority
    // - global systems use highest priority over everything
    const idx = this.controls.findIndex(c => c.options.priority <= options.priority)
    if (idx === -1) {
      this.controls.push(control)
    } else {
      this.controls.splice(idx, 0, control)
    }
    // return proxy api (over an empty target so the control itself stays unreachable)
    const proxy = createControlProxy(prop => {
      // internal property
      if (prop in control.api) {
        return control.api[prop]
      }
      // existing item
      if (prop in entries) {
        return entries[prop]
      }
      // new button item
      if (buttons.has(prop)) {
        entries[prop] = createButton(self, control, prop)
        return entries[prop]
      }
      // new item based on type
      const createType = controlTypes[prop]
      if (createType) {
        entries[prop] = createType(self, control, prop)
        return entries[prop]
      }
      return undefined
    })
    controlsByProxy.set(proxy, { control, release: control.api.release })
    return proxy
  }

  // releases the control bind() returned as `proxy` (the host's own release, whatever the proxy now answers)
  releaseControl(proxy) {
    controlsByProxy.get(proxy)?.release()
  }

  // an app that replaces its control (app.control() again) keeps the pointer lock its previous control took: the new
  // control holds it from now on, so releasing the previous one does not unlock the pointer
  handOverPointer(fromProxy, toProxy) {
    const from = controlsByProxy.get(fromProxy)?.control
    const to = controlsByProxy.get(toProxy)?.control
    if (from && to && this.pointerOwner === from) this.pointerOwner = to
  }

  dropControlState(control) {
    for (const facades of this.touchFacades.values()) {
      facades.get(control)?.detach()
      facades.delete(control)
    }
    for (const prop of ['xrLeftRayPose', 'xrRightRayPose']) {
      const pose = control.entries[prop]
      if (pose) this.raySmoothing.delete(pose)
    }
  }

  // the stable facade of a touch for an app's control (createTouchFacade)
  touchFacade(control, info) {
    let facades = this.touchFacades.get(info)
    if (!facades) this.touchFacades.set(info, (facades = new Map()))
    let entry = facades.get(control)
    if (!entry) facades.set(control, (entry = createTouchFacade(info)))
    return entry.facade
  }

  // a touch that ended: its facades keep its last values and the host lets go of them
  dropTouchFacades(info) {
    const facades = this.touchFacades.get(info)
    if (!facades) return
    this.touchFacades.delete(info)
    for (const entry of facades.values()) entry.detach()
  }

  releaseAllButtons() {
    // release all down buttons because they can get stuck
    for (const control of this.controls) {
      if (!control.active) continue
      for (const key in control.entries) {
        const value = control.entries[key]
        if (value.$button && value.down) {
          value.released = true
          value.down = false
          callControlEntry(control, value, 'onRelease')
        }
      }
    }
  }

  buildActions() {
    this.actions = []
    for (const control of this.controls) {
      if (!control.active) continue
      const actions = control.actions
      if (actions) {
        for (const action of actions) {
          // ignore if already existing
          if (!action.type === 'custom') {
            const idx = this.actions.findIndex(a => a.type === action.type)
            if (idx !== -1) continue
          }
          this.actions.push(action)
        }
      }
    }
    this.world.emit('actions', this.actions)
  }

  setTouchBtn(prop, down) {
    if (down) {
      this.buttonsDown.add(prop)
      for (const control of this.controls) {
        if (!control.active) continue
        const button = control.entries[prop]
        if (button?.$button) {
          button.pressed = true
          button.down = true
          const capture = callControlEntry(control, button, 'onPress')
          if (capture || button.capture) break
        }
      }
    } else {
      this.buttonsDown.delete(prop)
      for (const control of this.controls) {
        if (!control.active) continue
        const button = control.entries[prop]
        if (button?.$button && button.down) {
          button.down = false
          button.released = true
          callControlEntry(control, button, 'onRelease')
        }
      }
    }
  }

  simulateButton(prop, pressed) {
    if (pressed) {
      if (this.buttonsDown.has(prop)) return
      this.buttonsDown.add(prop)
      for (const control of this.controls) {
        if (!control.active) continue
        const button = control.entries[prop]
        if (button?.$button) {
          button.pressed = true
          button.down = true
          const capture = callControlEntry(control, button, 'onPress')
          if (capture || button.capture) break
        }
        const capture = control.active && control.onButtonPress?.(prop)
        if (capture) break
      }
    } else {
      if (!this.buttonsDown.has(prop)) return
      this.buttonsDown.delete(prop)
      for (const control of this.controls) {
        if (!control.active) continue
        const button = control.entries[prop]
        if (button?.$button && button.down) {
          button.down = false
          button.released = true
          callControlEntry(control, button, 'onRelease')
        }
      }
    }
  }

  onKeyDown = e => {
    if (e.defaultPrevented) return
    if (e.repeat) return
    if (this.isInputFocused()) return
    const code = e.code
    if (code === 'Tab') {
      // prevent default focus switching behavior
      e.preventDefault()
    }
    const prop = codeToProp[code]
    const text = e.key
    this.buttonsDown.add(prop)
    for (const control of this.controls) {
      if (!control.active) continue
      const button = control.entries[prop]
      if (button?.$button) {
        button.pressed = true
        button.down = true
        const capture = callControlEntry(control, button, 'onPress')
        if (capture || button.capture) break
      }
      const capture = control.active && control.onButtonPress?.(prop, text)
      if (capture) break
    }
  }

  onKeyUp = e => {
    if (e.repeat) return
    if (this.isInputFocused()) return
    const code = e.code
    if (code === 'MetaLeft' || code === 'MetaRight') {
      // releasing a meta key while another key is down causes browsers not to ever
      // trigger onKeyUp, so we just have to force all keys up
      return this.releaseAllButtons()
    }
    const prop = codeToProp[code]
    this.buttonsDown.delete(prop)
    for (const control of this.controls) {
      if (!control.active) continue
      const button = control.entries[prop]
      if (button?.$button && button.down) {
        button.down = false
        button.released = true
        callControlEntry(control, button, 'onRelease')
      }
    }
  }

  onPointerDown = e => {
    if (e.isCoreUI) return
    if (e.pointerType === 'touch') {
      e.preventDefault()
      const info = {
        id: e.pointerId,
        position: new THREE.Vector3(e.clientX, e.clientY, 0),
        prevPosition: new THREE.Vector3(e.clientX, e.clientY, 0),
        delta: new THREE.Vector3(),
        pointerType: e.pointerType,
      }
      this.touches.set(e.pointerId, info)
      for (const control of this.controls) {
        if (!control.active) continue
        const touch = control.options.object?.isApp ? this.touchFacade(control, info) : info
        const consume = control.active && callScript(control.options.onTouch, touch)
        if (consume) break
      }
    }
    this.checkPointerChanges(e)
  }

  onPointerMove = e => {
    if (e.isCoreUI) return
    if (e.pointerType === 'touch') {
      const info = this.touches.get(e.pointerId)
      if (info) {
        info.delta.x += e.clientX - info.prevPosition.x
        info.delta.y += e.clientY - info.prevPosition.y
        info.position.x = e.clientX
        info.position.y = e.clientY
        info.prevPosition.x = e.clientX
        info.prevPosition.y = e.clientY
      }
    }
    // this.checkPointerChanges(e)
    const rect = this.viewport.getBoundingClientRect()
    const offsetX = e.pageX - rect.left
    const offsetY = e.pageY - rect.top
    this.pointer.coords.x = Math.max(0, Math.min(1, offsetX / rect.width)) // prettier-ignore
    this.pointer.coords.y = Math.max(0, Math.min(1, offsetY / rect.height)) // prettier-ignore
    this.pointer.position.x = offsetX
    this.pointer.position.y = offsetY
    this.pointer.delta.x += e.movementX
    this.pointer.delta.y += e.movementY
  }

  onPointerUp = e => {
    if (e.isCoreUI) return
    if (e.pointerType === 'touch') {
      const info = this.touches.get(e.pointerId)
      if (info) {
        for (const control of this.controls) {
          if (!control.active) continue
          const touch = control.options.object?.isApp ? this.touchFacade(control, info) : info
          const consume = control.active && callScript(control.options.onTouchEnd, touch)
          if (consume) break
        }
        this.touches.delete(e.pointerId)
        this.dropTouchFacades(info)
      }
    }
    this.checkPointerChanges(e)
  }

  checkPointerChanges(e) {
    const lmb = !!(e.buttons & LMB)
    // left mouse down
    if (!this.lmbDown && lmb) {
      this.lmbDown = true
      this.buttonsDown.add(MouseLeft)
      for (const control of this.controls) {
        if (!control.active) continue
        const button = control.entries.mouseLeft
        if (button) {
          button.down = true
          button.pressed = true
          const capture = callControlEntry(control, button, 'onPress')
          if (capture || button.capture) break
        }
      }
    }
    // left mouse up
    if (this.lmbDown && !lmb) {
      this.lmbDown = false
      this.buttonsDown.delete(MouseLeft)
      for (const control of this.controls) {
        if (!control.active) continue
        const button = control.entries.mouseLeft
        if (button) {
          button.down = false
          button.released = true
          callControlEntry(control, button, 'onRelease')
        }
      }
    }
    const rmb = !!(e.buttons & RMB)
    // right mouse down
    if (!this.rmbDown && rmb) {
      this.rmbDown = true
      this.buttonsDown.add(MouseRight)
      for (const control of this.controls) {
        if (!control.active) continue
        const button = control.entries.mouseRight
        if (button) {
          button.down = true
          button.pressed = true
          const capture = callControlEntry(control, button, 'onPress')
          if (capture || button.capture) break
        }
      }
    }
    // right mouse up
    if (this.rmbDown && !rmb) {
      this.rmbDown = false
      this.buttonsDown.delete(MouseRight)
      for (const control of this.controls) {
        if (!control.active) continue
        const button = control.entries.mouseRight
        if (button) {
          button.down = false
          button.released = true
          callControlEntry(control, button, 'onRelease')
        }
      }
    }
  }

  async lockPointer() {
    if (isTouch) return
    this.pointer.shouldLock = true
    try {
      await this.viewport.requestPointerLock()
      return true
    } catch (err) {
      console.log('pointerlock denied, too quick?')
      return false
    }
  }

  unlockPointer() {
    this.pointerOwner = null
    this.pointer.shouldLock = false
    if (!this.pointer.locked) return
    document.exitPointerLock()
    this.onPointerLockEnd()
  }

  onPointerLockChange = e => {
    const didPointerLock = !!document.pointerLockElement
    if (didPointerLock) {
      this.onPointerLockStart()
    } else {
      this.onPointerLockEnd()
    }
  }

  onPointerLockStart() {
    if (this.pointer.locked) return
    this.pointer.locked = true
    this.world.emit('pointer-lock', true)
    // pointerlock is async so if its no longer meant to be locked, exit
    if (!this.pointer.shouldLock) this.unlockPointer()
  }

  onPointerLockEnd() {
    if (!this.pointer.locked) return
    this.pointer.locked = false
    // (ended by the user, eg Escape): no control holds it now
    this.pointerOwner = null
    this.world.emit('pointer-lock', false)
  }

  onScroll = e => {
    if (e.isCoreUI) return
    e.preventDefault()
    let delta = e.shiftKey ? e.deltaX : e.deltaY
    if (!this.isMac) delta = -delta
    this.scroll.delta += delta
  }

  onContextMenu = e => {
    e.preventDefault()
  }

  onTouchStart = e => {
    if (e.isCoreUI) return
    e.preventDefault()
  }

  onResize = () => {
    this.screen.width = this.viewport.offsetWidth
    this.screen.height = this.viewport.offsetHeight
  }

  onFocus = () => {
    this.releaseAllButtons()
  }

  onBlur = () => {
    this.releaseAllButtons()
  }

  onXRSession = session => {
    this.xrSession = session
  }

  isInputFocused() {
    return document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA'
  }

  destroy() {
    if (!isBrowser) return
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    this.viewport.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    this.viewport.removeEventListener('pointerup', this.onPointerUp)
    this.viewport.removeEventListener('pointercancel', this.onPointerUp)
    this.viewport.removeEventListener('wheel', this.onScroll, { passive: false })
    document.body.removeEventListener('contextmenu', this.onContextMenu)
    this.viewport.removeEventListener('touchstart', this.onTouchStart)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('focus', this.onFocus)
    window.removeEventListener('blur', this.onBlur)
  }
}

function callControlEntry(control, entry, key) {
  if (control.active) return callEntry(entry, key)
}

function updateXRHand(controls, src, frame, referenceSpace, side) {
  const rayPoseProp = `xr${side}RayPose`
  const gripPoseProp = `xr${side}GripPose`
  const stickProp = `xr${side}Stick`
  const triggerProp = `xr${side}Trigger`
  const gripProp = `xr${side}Grip`
  const btn1Prop = `xr${side}Btn1`
  const btn2Prop = `xr${side}Btn2`
  captured.clear()
  for (const control of controls.controls) {
    if (!control.active) continue
    try {
      if (control.entries[rayPoseProp]) {
        if (src.targetRaySpace) {
          const ray = frame.getPose(src.targetRaySpace, referenceSpace)
          if (ray) {
            const pose = control.entries[rayPoseProp]
            // apply tremor smoothing to local change
            let smooth = controls.raySmoothing.get(pose)
            if (!smooth) {
              smooth = {
                position: setVectorFromPoint(new THREE.Vector3(), ray.transform.position),
                quaternion: setQuaternionFromPoint(new THREE.Quaternion(), ray.transform.orientation),
              }
              controls.raySmoothing.set(pose, smooth)
            }
            // the browser's pose objects never reach a method of an object a script may hold (xrPose.js)
            setVectorFromPoint(v1, ray.transform.position)
            setQuaternionFromPoint(q1, ray.transform.orientation)
            smooth.position.lerp(v1, 1 - XR_TREMOR_SMOOTHING_FACTOR)
            smooth.quaternion.slerp(q1, 1 - XR_TREMOR_SMOOTHING_FACTOR)
            // world transform is applied above in this.applyXRRig()
          }
        }
      }
      if (control.entries[gripPoseProp]) {
        if (src.gripSpace) {
          const grip = frame.getPose(src.gripSpace, referenceSpace)
          if (grip) {
            const pose = control.entries[gripPoseProp]
            // todo: tremor smoothing?
            setVectorFromPoint(pose.position, grip.transform.position)
            setQuaternionFromPoint(pose.quaternion, grip.transform.orientation)
            // pose.matrix.fromArray(grip.transform.matrix)
          }
        }
      }
      if (control.entries[stickProp]) {
        if (captured.has(stickProp)) {
          control.entries[stickProp].value.x = 0
          control.entries[stickProp].value.z = 0
        } else {
          control.entries[stickProp].value.x = src.gamepad.axes[2]
          control.entries[stickProp].value.z = src.gamepad.axes[3]
          if (control.entries[stickProp].capture) {
            captured.add(stickProp)
          }
        }
      }
      if (control.entries[triggerProp]) {
        const button = control.entries[triggerProp]
        const down = src.gamepad.buttons[0].value > 0.9
        if (down && !button.down) {
          button.pressed = true
          callControlEntry(control, button, 'onPress')
        }
        if (!down && button.down) {
          button.released = true
          callControlEntry(control, button, 'onRelease')
        }
        button.down = down
        button.value = src.gamepad.buttons[0].value
      }
      if (control.entries[gripProp]) {
        const button = control.entries[gripProp]
        const down = src.gamepad.buttons[1].pressed
        if (down && !button.down) {
          button.pressed = true
          callControlEntry(control, button, 'onPress')
        }
        if (!down && button.down) {
          button.released = true
          callControlEntry(control, button, 'onRelease')
        }
        button.down = down
        button.value = src.gamepad.buttons[1].value
      }
      if (control.entries[btn1Prop]) {
        const button = control.entries[btn1Prop]
        const down = src.gamepad.buttons[4].pressed
        if (down && !button.down) {
          button.pressed = true
          callControlEntry(control, button, 'onPress')
        }
        if (!down && button.down) {
          button.released = true
          callControlEntry(control, button, 'onRelease')
        }
        button.down = down
      }
      if (control.entries[btn2Prop]) {
        const button = control.entries[btn2Prop]
        const down = src.gamepad.buttons[5].pressed
        if (down && !button.down) {
          button.pressed = true
          callControlEntry(control, button, 'onPress')
        }
        if (!down && button.down) {
          button.released = true
          callControlEntry(control, button, 'onRelease')
        }
        button.down = down
      }
    } catch (err) {
      controlFailed(control, 'xr input', err)
    }
  }
}

function createButton(controls, control, prop) {
  const down = controls.buttonsDown.has(prop)
  const pressed = down
  const released = false
  return {
    $button: true,
    value: 0, // eg xr triggers
    down,
    pressed,
    released,
    capture: false,
    onPress: null,
    onRelease: null,
  }
}

function createVector(controls, control, prop) {
  return {
    $vector: true,
    value: new THREE.Vector3(),
    capture: false,
  }
}

function createPose(controls, control, prop) {
  return {
    $pose: true,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    // matrix: new THREE.Matrix4(),
    // capture: false,
  }
}

function createValue(controls, control, prop) {
  return {
    $value: true,
    value: null,
    capture: false,
  }
}

// a new vector per read, made from the host's numbers: no host vector reaches an object a script holds
function snapshot(vector) {
  return new THREE.Vector3(vector.x, vector.y, vector.z)
}

function createPointer(controls, control, prop) {
  return {
    get coords() {
      return snapshot(controls.pointer.coords) // [0,0] to [1,1]
    },
    get position() {
      return snapshot(controls.pointer.position) // [0,0] to [viewportWidth,viewportHeight]
    },
    get delta() {
      return snapshot(controls.pointer.delta) // position delta (pixels)
    },
    get locked() {
      return controls.pointer.locked
    },
    // a released control (or one of a stopped app) changes nothing; its own onRelease callback may still unlock a
    // lock it holds (not one another control took since, or that went to its app's new control)
    lock() {
      if (!control.active) return
      controls.pointerOwner = control
      controls.lockPointer()
    },
    unlock() {
      if (!control.active && !(control.releasing && controls.pointerOwner === control)) return
      controls.unlockPointer()
    },
  }
}

function createScreen(controls, control) {
  return {
    $screen: true,
    get width() {
      return controls.screen.width
    },
    get height() {
      return controls.screen.height
    },
  }
}

function createCamera(controls, control) {
  const world = controls.world
  const position = new THREE.Vector3().copy(world.rig.position)
  const quaternion = new THREE.Quaternion().copy(world.rig.quaternion)
  const rotation = new THREE.Euler(0, 0, 0, 'YXZ').copy(world.rig.rotation)
  bindRotations(quaternion, rotation)
  const zoom = world.camera.position.z
  return {
    $camera: true,
    position,
    quaternion,
    rotation,
    zoom,
    write: false,
  }
}
