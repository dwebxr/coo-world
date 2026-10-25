// Physics preflight: the values that reach PhysX are checked before any native allocation. A builder script or a
// model file can otherwise hand PhysX an Infinity radius, a NaN or huge scale, a denormal mass or a far controller
// position, and PhysX answers with NaN poses that spread to unrelated actors in the shared scene. A node whose
// inputs fail is skipped (its visual stays) with one warning per node and reason.
import { createLogOnce } from './logOnce.js'

// one window for every length, scale axis and position that reaches PhysX (= PX_MESH_SCALE_MIN/MAX)
export const MIN_LENGTH = 1e-6
export const MAX_LENGTH = 1e6
// below this a mass rounds to 0 with an infinite inverse mass inside PhysX, and a body that hits it goes NaN
export const MIN_MASS = 1e-9

export function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(Math.fround(value))
}

// the bounds are compared as float32 too, so 1e-6 and 1e6 themselves are inside (Math.fround(1e-6) < 1e-6)
const MIN_LENGTH_F32 = Math.fround(MIN_LENGTH)
const MAX_LENGTH_F32 = Math.fround(MAX_LENGTH)
const MIN_MASS_F32 = Math.fround(MIN_MASS)

export function lengthOk(value) {
  if (typeof value !== 'number') return false
  const length = Math.abs(Math.fround(value))
  return Number.isFinite(length) && length >= MIN_LENGTH_F32 && length <= MAX_LENGTH_F32
}

// each axis in the length window; a negative axis (a mirror) only when allowed
export function scaleOk(scale, allowNegative = false) {
  for (const axis of [scale.x, scale.y, scale.z]) {
    if (!lengthOk(axis)) return false
    if (!allowNegative && axis < 0) return false
  }
  return true
}

// the physical extent of a mesh: its largest |vertex coordinate| per axis (scanned from the vertices, never from a
// file's bounding box) times the absolute scale
export function extentOk(maxAbs, absScale) {
  if (!maxAbs) return false
  const products = [maxAbs[0] * absScale.x, maxAbs[1] * absScale.y, maxAbs[2] * absScale.z]
  return products.every(value => Number.isFinite(Math.fround(value)) && Math.fround(value) <= MAX_LENGTH_F32)
}

export function positionOk(position) {
  for (const value of [position.x, position.y, position.z]) {
    if (!finiteNumber(value) || Math.abs(Math.fround(value)) > MAX_LENGTH_F32) return false
  }
  return true
}

export function massOk(value) {
  return finiteNumber(value) && (value === 0 || Math.fround(value) >= MIN_MASS_F32)
}

// normalises a quaternion in place; false for a zero, denormal or non-finite length (PhysX turns those into NaN
// poses, and a kinematic target with one spreads NaN to the bodies it touches)
export function normalizeQuat(quat) {
  const length = Math.hypot(quat.x, quat.y, quat.z, quat.w)
  if (!Number.isFinite(length) || length <= MIN_LENGTH) return false
  quat.set(quat.x / length, quat.y / length, quat.z / length, quat.w / length)
  return true
}

// how hard one call can push a body: in the force and impulse modes the velocity change is |F| times the inverse
// mass, and through a lever |r| * |F| times the inverse inertia; the acceleration and velocity-change modes are
// velocities already. Each must stay finite in float32, or the body turns NaN and spreads it to what it touches.
export function pushOk(actor, massModes, forceLength, torqueLength = 0) {
  if (!actor?.getInvMass) return true
  const invMass = massModes ? actor.getInvMass() : 1
  if (!Number.isFinite(Math.fround(forceLength * invMass))) return false
  if (torqueLength) {
    let invInertia = 1
    if (massModes) {
      const tensor = actor.getMassSpaceInvInertiaTensor()
      invInertia = Math.max(tensor.x, tensor.y, tensor.z)
    }
    if (!Number.isFinite(Math.fround(torqueLength * invInertia))) return false
  }
  return true
}

export function geometryOk(pxGeometry) {
  try {
    return globalThis.PHYSX.PxGeometryQuery.prototype.isValid(pxGeometry) === true
  } catch {
    return false
  }
}

const warnNode = createLogOnce(console.warn)

export function warnPhysicsOnce(node, reason, message) {
  warnNode(node, reason, message)
}
