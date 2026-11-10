import { storable } from './storable.js'

// Engine math objects a script can reach by reference (a node's transform and matrices, a joint's offsets, a UI's
// offset, a control's camera, poses and stick values, a skinned mesh's bones) are sealed where they are made, after
// their change hooks are wired: a script can still change their values, but cannot add properties to them or turn a
// field into an accessor, so no script code runs when the engine reads them. (Their classes are frozen as well, see
// scriptHardening.js.)
//
// A matrix's elements become a Float64Array that cannot be replaced: an index of a typed array cannot carry an
// accessor, a value written to it is converted to a number when it is written (by the script's own code), and sealing
// a plain array would make every matrix operation about ten times slower.
export function sealMath(object) {
  if (!object) return object
  if (object.isMatrix4 || object.isMatrix3) {
    if (!ArrayBuffer.isView(object.elements)) object.elements = new Float64Array(object.elements)
    Object.defineProperty(object, 'elements', { writable: false })
  }
  return Object.seal(object)
}

export function sealAll(...objects) {
  for (const object of objects) sealMath(object)
}

// Script views of engine vectors, quaternions and eulers. Sealing leaves their data properties writable: the
// components behind the accessors (`_x`, or `x` on three's own Vector3) and the change callback (`_onChangeCallback`).
// A script that wrote an object into a component, or its own function into the callback, would have its code run by
// the engine's next arithmetic on the object or its next change notification, in the middle of an engine operation
// (a physics step, a commit, a mount). A handle hands out a view instead: reads and method calls reach the engine
// object as before (a method called on the view writes through the view), a component written through the view keeps
// only a primitive (an object becomes NaN without being converted, storable.js), the change callback cannot be
// replaced, and no property can be redefined. The engine keeps using the object itself, so its own math pays nothing;
// the view is made once per object (the same view on every read). Per-instance accessors instead of a view made the
// engine's matrix composition about 75 times slower.
const components = new Set(['x', 'y', 'z', 'w', '_x', '_y', '_z', '_w', 'order', '_order'])
const views = new WeakMap()
const viewHandler = {
  set(target, key, value) {
    if (key === '_onChangeCallback') {
      throw new TypeError("[math] an engine object's change callback cannot be replaced")
    }
    return Reflect.set(target, key, components.has(key) ? storable(value) : value)
  },
  defineProperty() {
    throw new TypeError('[math] a property of an engine object cannot be redefined')
  },
  deleteProperty() {
    throw new TypeError('[math] a property of an engine object cannot be deleted')
  },
  setPrototypeOf() {
    return false
  },
}

export function scriptView(object) {
  if (!object) return object
  let view = views.get(object)
  if (!view) {
    view = new Proxy(sealMath(object), viewHandler)
    views.set(object, view)
  }
  return view
}
