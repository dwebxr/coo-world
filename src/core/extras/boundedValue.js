// What a node keeps of a number or a text a script gives it, where that value becomes a size: the pixels of a
// canvas, the length of a typed array or of a loop, a parameter the browser's own API refuses outside a range.
//
// These bounds are not a defence against a builder who wants to stall a visitor's client: a script can do that with a
// loop, and no bound here changes it. They are there so that a wrong value (a bug, a NaN, 1e9, a pasted book) costs a
// visitor a blurry panel or a capped effect, not the tab.
//
// No bound throws: a script that ran before a limit existed keeps running. The getter returns what was kept.

// a number: NaN gives the fallback (the property's default), anything outside [min, max] the nearest bound
// (so Infinity is the maximum). The caller has checked that the value is a number.
export function boundedNumber(value, fallback, min, max) {
  if (value !== value) return fallback
  if (value < min) return min
  if (value > max) return max
  return value
}

// the same, as a whole number (rounded down)
export function boundedInteger(value, fallback, min, max) {
  return Math.floor(boundedNumber(value, fallback, min, max))
}

// a text: cut to `max` UTF-16 units, never in the middle of a surrogate pair
export function boundedText(value, max) {
  if (value.length <= max) return value
  const last = value.charCodeAt(max - 1)
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

// the width and height of an image or video screen, in metres: a geometry, not an allocation, but one NaN in it is a
// NaN in the scene's bounds
export const SCREEN_MAX_SIDE = 1e6
