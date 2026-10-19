// Voice loudness -> mouth opening (0..1). Pure, so the constants are pinned by tests.
//
// floor: RMS below it is silence (noise-suppressed mics sit well under it)
// gain: how fast RMS above the floor reaches a fully open mouth (speech RMS ~0.01-0.18 maps onto 0..1)
// attack / release: time constants (s) for opening and closing
// epsilon: a closing mouth below it snaps to exactly 0, so writes stop
export const MOUTH = Object.freeze({ floor: 0.01, gain: 6, attack: 0.06, release: 0.12, epsilon: 0.005 })

const clamp01 = v => Math.min(Math.max(v, 0), 1)

export function mouthTarget(rms, { floor, gain } = MOUTH) {
  if (!Number.isFinite(rms)) return 0
  return clamp01((rms - floor) * gain)
}

export function nextMouth(prev, target, delta, { attack, release, epsilon } = MOUTH) {
  const from = Number.isFinite(prev) ? clamp01(prev) : 0
  const to = Number.isFinite(target) ? clamp01(target) : 0
  const dt = Number.isFinite(delta) && delta > 0 ? delta : 0
  const tau = to > from ? attack : release
  const next = from + (to - from) * (1 - Math.exp(-dt / tau))
  if (to === 0 && next < epsilon) return 0
  return clamp01(next)
}

export const quantizeMouth = value => Math.round(value * 100) / 100
