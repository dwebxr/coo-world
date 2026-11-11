import { toEngineNumber, toEngineOrder } from './engineNumber.js'

// Engine math objects a script can reach by reference (a node's transform and matrices, a joint's offsets, a UI's
// offset, a control's camera, poses and stick values, a skinned mesh's bones) are sealed where they are made, after
// their change hooks are wired: a script can still change their values, but cannot add properties to them or turn a
// field into an accessor. Their change callback (`_onChangeCallback`, wired once, when the object is made) is fixed
// as well: the engine calls it on every change, so a script's own function there would run inside the engine.
// (Their classes are frozen as well, see scriptHardening.js.)
//
// Sealing still leaves the components behind the accessors writable (`_x`, or `x` on three's own Vector3): a script
// can write an object there directly, past the setters. Two ways keep the engine from converting such an object:
//   - a node's own position, quaternion, rotation and scale, which scripts write all the time, are handed out as they
//     are, and the engine reads their components only through Node's guard (guardTransform: a component that is not
//     a number is read as NaN, without being converted);
//   - everything else (rarely written, read by the engine in many places) is handed out as a view (scriptView below).
// A matrix keeps its plain elements array (a typed array there made every matrix operation of the engine slower:
// three's math then sees two kinds of element arrays); a matrix is handed out as a view, whose `elements` is a view
// too, so a script can neither put an accessor on an entry nor replace the array. (The raw matrix's `elements` stays
// writable: a Proxy may only answer with its own view for a property the target could change.)
export function sealMath(object) {
  if (!object) return object
  Object.seal(object)
  if (Object.hasOwn(object, '_onChangeCallback'))
    Object.defineProperty(object, '_onChangeCallback', { writable: false })
  return object
}

export function sealAll(...objects) {
  for (const object of objects) sealMath(object)
}

// Script views of engine math objects: reads and method calls reach the engine object as before (a method called on
// the view writes through the view), a component or matrix entry written through the view is kept by the engine's
// number rule (engineNumber.js: a string, a boolean or null is converted, anything else that is not a number is NaN,
// without being converted; an order that is not a string leaves the order), the change callback cannot be replaced,
// and no property can be redefined or deleted; a matrix's `elements` is a view of the same kind. The engine keeps using the object itself, so
// its own math pays nothing; the view is made once per object (the same view on every read). Per-instance accessors
// on the components instead made the engine's matrix composition about 75 times slower.
const components = new Set(['x', 'y', 'z', 'w', '_x', '_y', '_z', '_w'])
const orders = new Set(['order', '_order'])
const views = new WeakMap()
const viewSet = new WeakSet()
const refuse = message => () => {
  throw new TypeError(message)
}
const viewHandler = {
  get(target, key, receiver) {
    if (key === 'elements' && (target.isMatrix4 || target.isMatrix3)) return elementsView(target.elements)
    return Reflect.get(target, key, receiver)
  },
  set(target, key, value) {
    if (key === '_onChangeCallback') {
      throw new TypeError("[math] an engine object's change callback cannot be replaced")
    }
    if (key === 'elements') throw new TypeError("[math] an engine matrix's elements cannot be replaced")
    if (components.has(key)) return Reflect.set(target, key, toEngineNumber(value))
    if (orders.has(key)) return Reflect.set(target, key, toEngineOrder(value, target._order))
    return Reflect.set(target, key, value)
  },
  defineProperty: refuse('[math] a property of an engine object cannot be redefined'),
  deleteProperty: refuse('[math] a property of an engine object cannot be deleted'),
  setPrototypeOf() {
    return false
  },
}
const elementsHandler = {
  set(target, key, value) {
    if (key === 'length') throw new TypeError("[math] an engine matrix's elements cannot be resized")
    return Reflect.set(target, key, toEngineNumber(value))
  },
  defineProperty: refuse("[math] an entry of an engine matrix's elements cannot be redefined"),
  deleteProperty: refuse("[math] an entry of an engine matrix's elements cannot be deleted"),
  setPrototypeOf() {
    return false
  },
}

function elementsView(elements) {
  let view = views.get(elements)
  if (!view) {
    view = new Proxy(elements, elementsHandler)
    views.set(elements, view)
    viewSet.add(view)
  }
  return view
}

export function scriptView(object) {
  if (!object) return object
  let view = views.get(object)
  if (!view) {
    view = new Proxy(sealMath(object), viewHandler)
    views.set(object, view)
    viewSet.add(view)
  }
  return view
}

// whether a value is one of these views (host code and tests)
export function isScriptView(value) {
  return viewSet.has(value)
}
