export const CHANGE_TOO_LARGE = 'This change is too large to save (limit 64 KB)'

export function preflightPacket(world, name, data) {
  if (world.network.fits(name, data)) return true
  world.emit('toast', CHANGE_TOO_LARGE)
  return false
}
