import { Matrix4, Quaternion, Vector3 } from 'three'
import { TRANSFORM_LIMIT } from './entityModifyPolicy.js'

const matrix = new Matrix4()
const position = new Vector3()
const quaternion = new Quaternion()
const scale = new Vector3()

// Validate into scratch so a rejected anchor leaves both outputs untouched.
export function readAnchorPose(value, outPosition, outQuaternion) {
  const elements = value.elements
  for (let i = 0; i < 16; i++) {
    const v = elements[i]
    if (!Number.isFinite(v)) return false
    matrix.elements[i] = v
  }
  const determinant = matrix.determinant()
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return false
  matrix.decompose(position, quaternion, scale)
  if (
    !Number.isFinite(position.x) ||
    Math.abs(position.x) > TRANSFORM_LIMIT ||
    !Number.isFinite(position.y) ||
    Math.abs(position.y) > TRANSFORM_LIMIT ||
    !Number.isFinite(position.z) ||
    Math.abs(position.z) > TRANSFORM_LIMIT ||
    !Number.isFinite(scale.x) ||
    scale.x === 0 ||
    !Number.isFinite(scale.y) ||
    scale.y === 0 ||
    !Number.isFinite(scale.z) ||
    scale.z === 0
  )
    return false
  const n = Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
  if (!Number.isFinite(n) || n === 0) return false
  quaternion.set(quaternion.x / n, quaternion.y / n, quaternion.z / n, quaternion.w / n)
  outPosition.copy(position)
  outQuaternion.copy(quaternion)
  return true
}
