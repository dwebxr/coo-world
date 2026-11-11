// The id of the screen a participant's share is for, read from the participant's LiveKit metadata.
//
// The metadata is the participant's own to write (the voice token lets a client update it: that is how a share
// names its screen), so every other client reads it as untrusted text: JSON holding an object whose screenTargetId
// is a short string. Anything else names no screen, and a share that names none is not shown.

export const SCREEN_TARGET_MAX_LENGTH = 128

export function screenTarget(metadata) {
  if (typeof metadata !== 'string' || !metadata) return null
  let data
  try {
    data = JSON.parse(metadata)
  } catch {
    return null
  }
  const id = data !== null && typeof data === 'object' ? data.screenTargetId : null
  return typeof id === 'string' && id.length > 0 && id.length <= SCREEN_TARGET_MAX_LENGTH ? id : null
}
