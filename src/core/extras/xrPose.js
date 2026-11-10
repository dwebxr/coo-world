// Copies a WebXR pose (DOMPointReadOnly position and orientation) into math objects as numbers.
//
// The targets can be objects an app script holds (a control's pose entries), and a script may put its own
// `copy` method on an object it holds. Calling `target.copy(domPoint)` would then hand the script a browser
// object. `set` only ever receives numbers.

export function setVectorFromPoint(vector, point) {
  return vector.set(point.x, point.y, point.z)
}

export function setQuaternionFromPoint(quaternion, point) {
  return quaternion.set(point.x, point.y, point.z, point.w)
}
