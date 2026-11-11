import { boundedNumber } from './boundedValue.js'

// What an audio or video node keeps of the numbers it hands to Web Audio (boundedValue.js). A gain takes any finite
// number and a panner refuses what is outside these ranges with an exception, which came in the middle of play(),
// after the source was made, or in the setter of a node that was playing. Kept inside them, nothing there throws.
export const AUDIO_BOUNDS = {
  volume: [0, 100],
  refDistance: [0, 1e6],
  maxDistance: [0.0001, 1e6], // a panner refuses zero
  rolloffFactor: [0, 1e6],
  coneInnerAngle: [0, 360],
  coneOuterAngle: [0, 360],
  coneOuterGain: [0, 1],
}

// a NaN gives the fallback (the property's default), a value outside the range its nearest bound
export function boundedAudio(name, value, fallback) {
  const [min, max] = AUDIO_BOUNDS[name]
  return boundedNumber(value, fallback, min, max)
}
