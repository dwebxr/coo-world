// Prim geometries are cached by their normalised size, and the server and every client must build the same shape, so
// the one free ratio of a tapered cylinder or a torus is snapped to a fixed grid. Only exact operations are used:
// division by a power of two and Math.round are exact everywhere, while ECMA-262 lets Math.log2 and Math.pow differ by
// engine, so the torus grid reads the exponent from the float bits and compares the mantissa with literals.

// a normalised cylinder radius in [-1, 1], on a grid of 1/64 (at most 0.8% of the larger radius)
export function quantizeRadiusRatio(value) {
  return Math.round(value * 64) / 64
}

// 2^(k/8) for k = 0..7, and the log-space midpoints 2^((k + 0.5)/8) between neighbours, as correctly rounded literals
const STEPS = [
  1, 1.0905077326652577, 1.189207115002721, 1.2968395546510096, 1.4142135623730951, 1.5422108254079407, 1.681792830507429,
  1.8340080864093424,
]
const MIDS = [
  1.0442737824274138, 1.1387886347566916, 1.241857812073484, 1.3542555469368927, 1.4768261459394993, 1.6104903319492543,
  1.7562521603732995, 1.9152065613971474,
]
export const RATIO_MIN_EXPONENT = -10
export const RATIO_MAX_EXPONENT = 10

const view = new DataView(new ArrayBuffer(8))

// a torus tube-to-radius ratio on a log2 grid of 1/8 octave (at most 4.4% of the tube), sign kept, 0 kept exactly;
// null when |ratio| leaves [2^-10, 2^10] or is not finite
export function quantizeTubeRatio(value) {
  if (value === 0) return 0
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const sign = value < 0 ? -1 : 1
  view.setFloat64(0, Math.abs(value), false)
  const high = view.getUint32(0, false)
  const exponentField = (high >>> 20) & 0x7ff
  // a denormal is far below the range
  if (exponentField === 0) return null
  let exponent = exponentField - 1023
  // the mantissa in [1, 2): the same bits with the exponent field of 2^0
  view.setUint32(0, (high & 0x800fffff) | (1023 << 20), false)
  const mantissa = view.getFloat64(0, false)
  let step = 0
  while (step < 8 && mantissa >= MIDS[step]) step++
  if (step === 8) {
    step = 0
    exponent += 1
  }
  if (exponent < RATIO_MIN_EXPONENT || exponent > RATIO_MAX_EXPONENT || (exponent === RATIO_MAX_EXPONENT && step > 0)) {
    return null
  }
  // 2^exponent exactly, from its bits
  view.setUint32(0, (exponent + 1023) << 20, false)
  view.setUint32(4, 0, false)
  return sign * STEPS[step] * view.getFloat64(0, false)
}
