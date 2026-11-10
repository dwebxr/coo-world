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
