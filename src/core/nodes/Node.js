import { callForScript } from '../extras/scriptValues'
import { stoppedError } from '../extras/physicsFailure.js'
import { Teardown, tornDown } from '../extras/runTeardown.js'
import { scriptView, sealAll } from '../extras/sealMath.js'
import { toEngineNumber } from '../extras/engineNumber.js'
import { cursorKeyword } from '../extras/cursorKeyword.js'
import { isBoolean, isPrimitive } from '../extras/scriptPrimitives.js'
import { briefError } from '../extras/logOnce.js'
import * as THREE from '../extras/three'
import { getNodeRef, isRefAllowed, registerNodeRefGetter } from './refs'
import {
  NODE_CLIMB_LIMIT,
  NODE_DEPTH_LIMIT,
  NODE_LIMIT,
  NodeLimitError,
  assertMovableRoot,
  treeApp,
  unplaceWorldNode,
} from '../extras/nodeLimits.js'

export { getRef, getNodeRef, resolveValueRef, secureRef } from './refs'
export { NODE_CLIMB_LIMIT, NODE_DEPTH_LIMIT, NODE_LIMIT, NodeLimitError } from '../extras/nodeLimits.js'

// Node proxies are bound to the app run their node belongs to (nodeRunOwner): once that run has ended (or crashed),
// or its node teardown has started, every method and setter of the proxy throws the stopped error; getters keep
// reading. The binding is applied where a proxy is stored (Node#proxy below), once for each method and setter, so
// every getProxy() of every node class is covered: create, get, clone, parent/children, traverse.
const runBound = new WeakSet() // the wrapped methods and setters (a subclass proxy copies its base's descriptors)

// The app run a node belongs to: the one it was mounted for, or else the one that created or loaded it (app.create,
// a clone, world.load); a node that was neither (a descendant under an inactive part of a model, a loaded child)
// belongs to its nearest ancestor's run. A node another live app adopts (mounts) follows that app from then on.
function nodeRunOwner(node) {
  let current = node
  for (let steps = 0; current && steps <= NODE_CLIMB_LIMIT; steps++) {
    if (current.ctx?.run) return current.ctx
    if (current._created) return current._created
    current = current.parent
  }
  return null
}

// A node's own position, quaternion, rotation and scale are handed to scripts as they are (sealed, their change
// callbacks fixed: sealMath.js), and a script can write anything into a component directly (`node.position._x = …`),
// past the setters. The engine reads those components only after these guards, which apply the engine's number rule
// (engineNumber.js) to each component that is not a number: a string, a boolean or null is converted, anything else
// is NaN, without being converted (an Euler order that is not a string is read as 'YXZ', a node's order), so an
// object planted there has its valueOf called only by the script's own code. They run where the engine consumes the
// four objects: Node.updateTransform (the matrix composition), the rotation and quaternion change callbacks (each
// sets the other from it), Collider (its local pose), UI (a screen-space position), Animation (an app's distance),
// App (its network interpolation) and ClientBuilder (a moved app's transform, the grab and gizmo targets).
export function guardVector(v) {
  if (typeof v._x !== 'number') v._x = toEngineNumber(v._x)
  if (typeof v._y !== 'number') v._y = toEngineNumber(v._y)
  if (typeof v._z !== 'number') v._z = toEngineNumber(v._z)
}

export function guardQuaternion(q) {
  if (typeof q._x !== 'number') q._x = toEngineNumber(q._x)
  if (typeof q._y !== 'number') q._y = toEngineNumber(q._y)
  if (typeof q._z !== 'number') q._z = toEngineNumber(q._z)
  if (typeof q._w !== 'number') q._w = toEngineNumber(q._w)
}

export function guardEuler(e) {
  guardVector(e)
  // (a node's rotation is made with the order 'YXZ')
  if (typeof e._order !== 'string') e._order = 'YXZ'
}

export function guardTransform(node) {
  guardVector(node.position)
  guardQuaternion(node.quaternion)
  guardEuler(node.rotation)
  guardVector(node.scale)
}

function assertNodeRunActive(node) {
  const owner = nodeRunOwner(node)
  const run = owner?.run
  if (!run) return
  const entity = owner.entity
  if (run !== entity?.deadHook || tornDown(run, Teardown.NODES) || (entity.crashed && !entity.destroying)) {
    throw stoppedError(entity)
  }
}

// Setters share one wrapper per property name (a proxy can hold dozens of them; one closure each would make every
// node proxy half as heavy again): it finds its node through the proxy it is called on, and the node's own setter for
// that name. Methods keep a wrapper each, so a method taken off the proxy still works when called on its own.
const proxyNodes = new WeakMap() // proxy -> node
const nodeSetters = new WeakMap() // node -> Map(name -> the setter a node class defined)
const sharedSetters = new Map() // name -> the shared wrapper

// the node of the handle a setter is called on: the handle itself, or one it inherits from (Object.create(handle));
// a setter copied onto another object, or called without one, has no node and is refused, and so is a setter called
// on the handle of a node whose class has no such property (a mesh's castShadow setter called on a group's handle)
function receiverNode(receiver) {
  let current = receiver
  for (let steps = 0; current !== null && current !== undefined && steps < 64; steps++) {
    if (typeof current !== 'object' && typeof current !== 'function') return null
    const node = proxyNodes.get(current)
    if (node) return node
    current = Object.getPrototypeOf(current)
  }
  return null
}

function sharedSetter(key) {
  let set = sharedSetters.get(key)
  if (!set) {
    set = function (value) {
      const node = receiverNode(this)
      if (!node) throw new TypeError('[node] not a node')
      const setter = nodeSetters.get(node)?.get(key)
      if (!setter) throw new TypeError(`[node] a ${node.name} node has no ${key} to set`)
      assertNodeRunActive(node)
      Reflect.apply(setter, this, [value])
    }
    runBound.add(set)
    sharedSetters.set(key, set)
  }
  return set
}

function bindProxyToRun(node, proxy) {
  proxyNodes.set(proxy, node)
  let setters = nodeSetters.get(node)
  if (!setters) nodeSetters.set(node, (setters = new Map()))
  for (const key of Reflect.ownKeys(proxy)) {
    const desc = Reflect.getOwnPropertyDescriptor(proxy, key)
    if (typeof desc.value === 'function' && !runBound.has(desc.value)) {
      const method = desc.value
      const bound = function (...args) {
        assertNodeRunActive(node)
        return Reflect.apply(method, this, args)
      }
      // (the same name and arity as the method it stands for)
      Object.defineProperty(bound, 'name', { value: method.name, configurable: true })
      Object.defineProperty(bound, 'length', { value: method.length, configurable: true })
      runBound.add(bound)
      Object.defineProperty(proxy, key, { ...desc, value: bound })
    } else if (desc.set && !runBound.has(desc.set)) {
      // (a subclass proxy copies its base's descriptors: those setters are already shared, their originals listed)
      setters.set(key, desc.set)
      Object.defineProperty(proxy, key, { ...desc, set: sharedSetter(key) })
    }
  }
  return proxy
}

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q1 = new THREE.Quaternion()
const _m1 = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()
const _m3 = new THREE.Matrix4()
const _box3 = new THREE.Box3()
const _sphere = new THREE.Sphere()
const _points = []

const defaults = {
  active: true,
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
}

let nodeIds = -1

// A class's mount or build may be async: it waits for a file. Nothing awaits it, so a load that fails (a missing file,
// one the loader's limits refuse) was an unhandled rejection, and before the world is ready the page counts one as a
// failed start (the watchdog in index.html). The node stays as it is, without the file, and says so. What is reported
// of the reason is read without running its getters (briefError: an avatar's onLoad can throw any object; a Proxy's
// traps can still run, and what they throw is caught), and nothing in the handler may throw: that would be the
// unhandled rejection again.
export function watchLoad(node, pending) {
  if (pending instanceof Promise) {
    pending.catch(err => {
      try {
        console.warn(`[${node.name}] not loaded: ${typeof err === 'string' ? err.slice(0, 200) : briefError(err)}`)
      } catch {
        // (a console that throws: the failure stays unsaid, and still handled)
      }
    })
  }
}

const EPSILON = 0.000000001
const CURSOR_MAX_LENGTH = 128
let cursorWarned = false

// a mounting node of an app takes one unit of its budget; past the budget the app is crashed (once) and the
// node is not mounted
function chargeNode(node, entity) {
  const parent = node.parent
  const depth = parent?.mounted && parent._nodeOwner === entity ? parent._nodeDepth + 1 : 0
  const count = (entity.liveNodes || 0) + 1
  if (count <= NODE_LIMIT && depth < NODE_DEPTH_LIMIT) {
    entity.liveNodes = count
    node._nodeOwner = entity
    node._nodeDepth = depth
    return
  }
  const message =
    count > NODE_LIMIT
      ? `[app] node limit reached: more than ${NODE_LIMIT} live nodes`
      : `[app] node limit reached: more than ${NODE_DEPTH_LIMIT} levels of nodes`
  if (!entity.crashed && !entity.destroyed) {
    entity.scriptError = { name: 'Error', message }
    console.error(`${message} (entity ${String(entity.data?.id).slice(0, 64)})`)
    entity.crash?.()
  }
  throw new NodeLimitError(message)
}

function releaseNode(node) {
  const owner = node._nodeOwner
  if (!owner) return
  node._nodeOwner = null
  owner.liveNodes--
}

export class Node {
  constructor(data = {}) {
    this.id = data.id || `${++nodeIds}`
    this.name = 'node'

    this.parent = null
    this.children = []
    this.ctx = null
    this.position = new THREE.Vector3()
    if (data.position?.isVector3) {
      this.position.copy(data.position)
    } else {
      this.position.fromArray(data.position || defaults.position)
    }
    this.rotation = new THREE.Euler(0, 0, 0, 'YXZ')
    this.quaternion = new THREE.Quaternion()
    if (data.rotation) {
      if (data.rotation.isEuler) {
        this.rotation.copy(data.rotation)
      } else {
        this.rotation.fromArray(data.rotation)
      }
      this.quaternion.setFromEuler(this.rotation)
    }
    if (data.quaternion) {
      if (data.quaternion.isQuaternion) {
        this.quaternion.copy(data.quaternion)
      } else {
        this.quaternion.fromArray(data.quaternion)
      }
      this.rotation.setFromQuaternion(this.quaternion)
    }
    this.scale = new THREE.Vector3()
    if (data.scale?.isVector3) {
      this.scale.copy(data.scale)
    } else {
      this.scale.fromArray(data.scale || defaults.scale)
    }
    this.matrix = new THREE.Matrix4()
    this.matrixWorld = new THREE.Matrix4()
    this.position._onChange(() => {
      this.setTransformed()
    })
    this.rotation._onChange(() => {
      guardEuler(this.rotation)
      this.quaternion.setFromEuler(this.rotation, false)
      this.setTransformed()
    })
    this.quaternion._onChange(() => {
      // (setting the rotation from the quaternion reads the rotation's order too)
      guardQuaternion(this.quaternion)
      guardEuler(this.rotation)
      this.rotation.setFromQuaternion(this.quaternion, undefined, false)
      this.setTransformed()
    })
    this.scale._onChange(() => {
      // scale set to exactly zero on any axis causes matrices to have NaN values.
      // this causes our octrees to fail into an infinite loop
      if (this.scale.x === 0 || this.scale.y === 0 || this.scale.z === 0) {
        return this.scale.set(this.scale.x || EPSILON, this.scale.y || EPSILON, this.scale.z || EPSILON)
      }
      this.setTransformed()
    })
    // scripts hold these through the node's handle: sealed once wired, their change callbacks fixed (sealMath.js);
    // the engine reads their components only through guardTransform (the matrices go to scripts as views)
    sealAll(this.position, this.rotation, this.quaternion, this.scale, this.matrix, this.matrixWorld)
    this._onPointerEnter = data.onPointerEnter
    this._onPointerLeave = data.onPointerLeave
    this._onPointerDown = data.onPointerDown
    this._onPointerUp = data.onPointerUp
    this._cursor = data.cursor === undefined || data.cursor === null ? data.cursor : cursorKeyword(data.cursor)
    this._active = isBoolean(data.active) ? data.active : defaults.active
    // this.scale._onChange?
    this.isDirty = false
    this.isTransformed = true
    this.mounted = false
    // the app whose node budget this node holds while mounted, and its level below the mounted root
    this._nodeOwner = null
    this._nodeDepth = 0
    // the app that placed this node in world space (nodeLimits.js placeWorldNode), while it is there
    this._worldOwner = null
    // the app this node is the root of (App.build), which alone may move it (nodeLimits.js assertMovableRoot)
    this._appRoot = null
    // true while this node unmounts: nothing mounts under it meanwhile (see deactivate)
    this._unmounting = false
    // the app run that created this node (App.createNode, or a clone's source), until it is mounted for one
    this._created = null
  }

  // the script-facing proxy (see bindProxyToRun): whatever a node class stores here is bound to the node's app run
  get proxy() {
    return this._proxy
  }

  set proxy(value) {
    this._proxy = value ? bindProxyToRun(this, value) : value
  }

  // The one gate on the way to a node class's mount() and commit() (Node.activate and Node.clean are the only
  // callers of either; a class's own commit mounts or rebuilds from there): nothing mounts or rebuilds while the node,
  // or the node above it, is unmounting, nor for an app run that has ended or whose node teardown has started.
  canMount() {
    if (this._unmounting || this.parent?._unmounting) return false
    const run = this.ctx?.run
    return !run || (run === this.ctx.entity?.deadHook && !tornDown(run, Teardown.NODES))
  }

  // Mounts this node and its active descendants into `ctx` (the world and the entity that owns them). A mounted
  // node keeps the context it was mounted with: moving it to another parent or owner unmounts it first (see add
  // and world.add), so its budget is charged again where it lands. A node that was never placed in a world has
  // no context and is not mounted.
  activate(ctx) {
    if (this.mounted) return
    if (ctx) this.ctx = ctx
    if (!this._active || !this.ctx) return
    // a context from an app run that has ended (the app was rebuilt or removed), or whose node teardown has started,
    // mounts nothing; nor does a node added under one that is unmounting (canMount)
    if (!this.canMount()) return
    // top down mount
    this.updateTransform()
    // (checked again right before the node is charged and mounted: nothing the engine called in between may have ended
    // the run)
    if (!this.canMount()) return
    const entity = this.ctx.entity
    if (entity?.isApp) chargeNode(this, entity)
    this.mounted = true
    watchLoad(this, this.mount())
    // a mount that ran script code which unmounted this node (its run retired meanwhile) is taken back: what the mount
    // made after the unmount goes again
    if (!this.mounted) return this.rollBackMount()
    const children = this.children
    for (let i = 0, l = children.length; i < l && this.mounted; i++) {
      children[i].activate(this.ctx)
    }
  }

  rollBackMount() {
    try {
      this.unmount()
    } catch (err) {
      console.error('[node] unmount after an interrupted mount failed', err)
    }
  }

  // A class's commit that rebuilds: unmount, then mount again only if that is still allowed (the unmount can run script
  // code that ends the node's run), and take back a mount that was interrupted the same way.
  remount() {
    this.unmount()
    if (!this.mounted || !this.canMount()) return false
    watchLoad(this, this.mount())
    if (!this.mounted) {
      this.rollBackMount()
      return false
    }
    return true
  }

  // Unmounts bottom up. Every mounted node in the subtree is unmounted and returns its budget even when an unmount
  // throws; the first error is rethrown afterwards. An unmount that reaches script code (through a callback: the
  // engine's math objects, through which scripts once could, are sealed) may change the children: nothing mounts under
  // this node meanwhile, and the children are read again until none is mounted (each pass unmounts at least one, so the
  // passes are bounded).
  deactivate() {
    if (!this.mounted) return
    let failed = false
    let failure
    const fail = err => {
      if (!failed) [failed, failure] = [true, err]
    }
    const unmounting = this._unmounting
    this._unmounting = true
    try {
      for (let pass = 0; pass <= NODE_LIMIT && this.children.length; pass++) {
        const mounted = this.children.filter(child => child.mounted)
        if (!mounted.length) break
        for (const child of mounted) {
          // (a child a callback moved elsewhere is no longer this node's to unmount)
          if (child.parent !== this) continue
          try {
            child.deactivate()
          } catch (err) {
            fail(err)
          }
        }
      }
      try {
        this.unmount()
      } catch (err) {
        fail(err)
      }
    } finally {
      this._unmounting = unmounting
    }
    this.isDirty = false
    this.isTransformed = true
    this.mounted = false
    releaseNode(this)
    if (failed) throw failure
  }

  add(node) {
    if (!node) return console.error('no node to add')
    // a node under itself or under its own descendant would make the parent chain a loop
    let steps = 0
    for (let ancestor = this; ancestor; ancestor = ancestor.parent) {
      if (ancestor === node) throw new Error('[node] cannot add a node to itself or to one of its descendants')
      if (++steps > NODE_CLIMB_LIMIT) throw new Error('[node] node tree too deep or cyclic')
    }
    // an app's root goes only where its own app placed the tree (not into a detached one, which could be mounted
    // anywhere later)
    if (node._appRoot) assertMovableRoot(node, treeApp(this), 'node.add')
    // nothing is added to a mounted tree of a run whose node teardown has started (it would mount for that run)
    const run = this.mounted ? this.ctx?.run : null
    if (run && tornDown(run, Teardown.NODES)) throw stoppedError(this.ctx.entity)
    if (node.parent) {
      node.parent.remove(node)
    } else if (node.mounted) {
      // a mounted root (a world-space node, or another tree's root) leaves its place before it moves here
      node.deactivate()
    }
    // a world-space node moved under a node is no longer its app's world-space node
    unplaceWorldNode(node)
    node.parent = this
    this.children.push(node)
    if (this.mounted) {
      node.activate(this.ctx)
    }
    return this
  }

  remove(node) {
    const idx = this.children.indexOf(node)
    if (idx === -1) return
    try {
      node.deactivate()
    } finally {
      node.parent = null
      this.children.splice(idx, 1)
    }
    return this
  }

  // detach(node) {
  //   if (node) {
  //     const idx = this.children.indexOf(node)
  //     if (idx === -1) return
  //     this.project()
  //     node.parent = null
  //     this.children.splice(idx, 1)
  //     node.matrix.copy(node.matrixWorld)
  //     node.matrix.decompose(node.position, node.quaternion, node.scale)
  //     node.project()
  //     node.update()
  //   } else {
  //     this.parent?.detach(this)
  //   }
  // }

  setTransformed() {
    // - ensure this is marked as transformed
    // - ensure this and all descendants are dirty
    // - ensure only this node is tracked dirty
    if (this.isTransformed) return
    this.traverse(node => {
      if (node === this) {
        node.isTransformed = true
        node.setDirty()
      } else if (node.isDirty) {
        // if we come across an already dirty node we must ensure its not tracked
        // as we will clean it via this one
        this.ctx.world.stage.dirtyNodes.delete(node)
      } else {
        node.isDirty = true
      }
    })
  }

  setDirty() {
    // if we haven't mounted no track
    if (!this.mounted) return
    // if already dirty, either this or a parent is being tracked so we're good
    if (this.isDirty) return
    this.isDirty = true
    this.ctx.world.stage.dirtyNodes.add(this)
  }

  get active() {
    return this._active
  }

  set active(value) {
    // (a primitive: an object would be kept, and its truth is all that counts)
    if (!isPrimitive(value)) throw new Error('[node] active must be a boolean')
    if (this._active === value) return
    this._active = value
    if (!this._active && this.mounted) {
      this.deactivate()
    } else if (this._active && this.parent?.mounted) {
      this.activate(this.parent.ctx)
    } else if (this._active && !this.parent) {
      // only a node that was placed in a world before (it kept that context) mounts again; see activate
      this.activate(this.ctx)
    }
  }

  clean() {
    if (!this.isDirty) return
    let top = this
    let steps = 0
    while (top.parent && top.parent.isDirty) {
      if (++steps > NODE_CLIMB_LIMIT) throw new Error('[node] node tree too deep or cyclic')
      top = top.parent
    }
    let didTransform
    top.traverse(node => {
      if (node.isTransformed) {
        didTransform = true
      }
      if (didTransform) {
        node.updateTransform()
      }
      // (a commit can mount or rebuild: it passes the same gate as a mount)
      if (node.mounted && node.canMount()) {
        node.commit(didTransform)
      }
      node.isDirty = false
    })
  }

  mount() {
    // called when transforms are ready and this thing should be added to the scene
  }

  commit(_didTransform) {
    // called when dirty (either transform changed or node-specific)
    // if the transform changed it should be moved in the same (this.matrixWorld)
  }

  unmount() {
    // called when this thing should be removed from scene
  }

  updateTransform() {
    if (this.isTransformed) {
      guardTransform(this)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      this.isTransformed = false
    }
    if (this.parent) {
      this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix)
    } else {
      this.matrixWorld.copy(this.matrix)
    }
    // const children = this.children
    // for (let i = 0, l = children.length; i < l; i++) {
    //   children[i].project()
    // }
  }

  traverse(callback) {
    callback(this)
    const children = this.children
    for (let i = 0, l = children.length; i < l; i++) {
      children[i].traverse(callback)
    }
  }

  clone(recursive) {
    return new this.constructor().copy(this, recursive)
  }

  copy(source, recursive) {
    // a clone belongs to the run its source belongs to
    this._created = nodeRunOwner(source) || null
    this.id = source.id
    this.position.copy(source.position)
    this.quaternion.copy(source.quaternion)
    this.scale.copy(source.scale)
    this._onPointerEnter = source._onPointerEnter
    this._onPointerLeave = source._onPointerLeave
    this._onPointerDown = source._onPointerDown
    this._onPointerUp = source._onPointerUp
    this._cursor = source._cursor
    this._active = source._active
    if (recursive) {
      for (let i = 0; i < source.children.length; i++) {
        const child = source.children[i]
        this.add(child.clone(recursive))
      }
    }
    return this
  }

  get(id) {
    if (this.id === id) return this
    for (let i = 0, l = this.children.length; i < l; i++) {
      const found = this.children[i].get(id)
      if (found) {
        return found
      }
    }
    return null
  }

  // todo: getWorldQuaternion etc
  getWorldPosition(vec3 = _v1) {
    this.matrixWorld.decompose(vec3, _q1, _v2)
    return vec3
  }

  getWorldMatrix(mat = _m1) {
    return mat.copy(this.matrixWorld)
  }

  getStats(recursive, stats) {
    if (!stats) {
      stats = {
        geometries: new Set(),
        materials: new Set(),
        triangles: 0,
        textureBytes: 0,
      }
    }
    this.applyStats(stats)
    if (recursive) {
      for (const child of this.children) {
        child.getStats(recursive, stats)
      }
    }
    return stats
  }

  applyStats(_stats) {
    // nodes should override this and add their stats
  }

  // a pointer callback of a crashed app, or of an app run that has ended (the node was its), is not delivered
  callbacksStopped() {
    const ctx = this.ctx
    return !!(ctx?.entity?.crashed || ctx?.world?.fatalError || (ctx?.run && ctx.run !== ctx.entity?.deadHook))
  }

  get onPointerEnter() {
    if (this.callbacksStopped()) return null
    return this._onPointerEnter
  }

  set onPointerEnter(value) {
    this._onPointerEnter = value
  }

  get onPointerLeave() {
    if (this.callbacksStopped()) return null
    return this._onPointerLeave
  }

  set onPointerLeave(value) {
    this._onPointerLeave = value
  }

  get onPointerDown() {
    if (this.callbacksStopped()) return null
    return this._onPointerDown
  }

  set onPointerDown(value) {
    this._onPointerDown = value
  }

  get onPointerUp() {
    if (this.callbacksStopped()) return null
    return this._onPointerUp
  }

  set onPointerUp(value) {
    this._onPointerUp = value
  }

  get cursor() {
    return this._cursor
  }

  // written to the page's cursor style while the pointer is over the node: a CSS cursor keyword, or nothing. Of an
  // image cursor its closing keyword is kept (cursorKeyword.js); a string with no keyword is kept as nothing. Either
  // is said once, and neither throws, since a script written before this rule may set one.
  set cursor(value) {
    if (value === undefined || value === null) {
      this._cursor = value
      return
    }
    if (typeof value !== 'string' || value.length > CURSOR_MAX_LENGTH) {
      throw new Error(`[node] cursor must be a string of at most ${CURSOR_MAX_LENGTH} characters`)
    }
    const keyword = cursorKeyword(value)
    if ((keyword === null || value.includes(',')) && !cursorWarned) {
      cursorWarned = true
      console.warn('[node] cursor: only CSS cursor keywords are used (pointer, grab, crosshair, ...), not images')
    }
    this._cursor = keyword
  }

  getProxy() {
    if (!this.proxy) {
      const self = this
      const proxy = {
        get id() {
          return self.id
        },
        set id(value) {
          throw new Error('Setting ID not currently supported')
        },
        get name() {
          return self.name
        },
        get position() {
          return self.position
        },
        set position(value) {
          throw new Error('Cannot replace node position')
        },
        get quaternion() {
          return self.quaternion
        },
        set quaternion(value) {
          throw new Error('Cannot replace node quaternion')
        },
        get rotation() {
          return self.rotation
        },
        set rotation(value) {
          throw new Error('Cannot replace node rotation')
        },
        get scale() {
          return self.scale
        },
        set scale(value) {
          throw new Error('Cannot replace node scale')
        },
        get matrixWorld() {
          return scriptView(self.matrixWorld)
        },
        get active() {
          return self.active
        },
        set active(value) {
          callForScript(
            () => {
              self.active = value
            },
            self,
            []
          )
        },
        get parent() {
          return self.parent?.getProxy()
        },
        set parent(value) {
          throw new Error('Cannot set parent directly')
        },
        get children() {
          return self.children.map(child => {
            return child.getProxy()
          })
        },
        get(id) {
          const node = self.get(id)
          return node?.getProxy() || null
        },
        getWorldMatrix(mat) {
          // without a target the result is a new matrix, never the module's shared one
          return self.getWorldMatrix(mat ?? new THREE.Matrix4())
        },
        add(pNode) {
          const node = getNodeRef(pNode)
          if (!node && pNode != null) {
            console.error('[node.add] expected a node')
            return this
          }
          callForScript(self.add, self, [node])
          return this
        },
        remove(pNode) {
          const node = getNodeRef(pNode)
          if (!node && pNode != null) {
            console.error('[node.remove] expected a node')
            return this
          }
          callForScript(self.remove, self, [node])
          return this
        },
        traverse(callback) {
          self.traverse(node => {
            callback(node.getProxy())
          })
        },
        // detach(node) {
        //   self.detach(node)
        // },
        clone(recursive) {
          const node = callForScript(self.clone, self, [recursive])
          return node.getProxy()
        },
        clean() {
          callForScript(self.clean, self, [])
        },
        get _ref() {
          if (!isRefAllowed()) return null
          return self
        },
        get _isRef() {
          return true
        },
        get onPointerEnter() {
          if (self.ctx?.entity?.crashed || self.ctx?.world?.fatalError) return null
          return self.onPointerEnter
        },
        set onPointerEnter(value) {
          self.onPointerEnter = value
        },
        get onPointerLeave() {
          if (self.ctx?.entity?.crashed || self.ctx?.world?.fatalError) return null
          return self.onPointerLeave
        },
        set onPointerLeave(value) {
          self.onPointerLeave = value
        },
        get onPointerDown() {
          if (self.ctx?.entity?.crashed || self.ctx?.world?.fatalError) return null
          return self.onPointerDown
        },
        set onPointerDown(value) {
          self.onPointerDown = value
        },
        get onPointerUp() {
          if (self.ctx?.entity?.crashed || self.ctx?.world?.fatalError) return null
          return self.onPointerUp
        },
        set onPointerUp(value) {
          self.onPointerUp = value
        },
        get cursor() {
          return self.cursor
        },
        set cursor(value) {
          self.cursor = value
        },
      }
      registerNodeRefGetter(proxy)
      this.proxy = proxy
    }
    return this.proxy
  }
}
