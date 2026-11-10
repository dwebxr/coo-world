// When a player (or its avatar) throws in the frame loop, World.hotFailed keeps the player running on the
// built-in avatar instead of dropping it (a dropped local player would freeze). The built-in file, not the
// world's default avatar setting: that one is builder-chosen and may be the failing file.
export const BUILTIN_AVATAR_URL = 'asset://avatar.vrm'

// the url a player's avatar loads from
export function playerAvatarUrl(player) {
  if (player.avatarFallback) return BUILTIN_AVATAR_URL
  return player.data.sessionAvatar || player.data.avatar || BUILTIN_AVATAR_URL
}

// true while the player should stay hot: on the first failure (the switch starts) and until the built-in avatar
// is in place; false once a failure happens with the built-in avatar
export function switchToBuiltinAvatar(player) {
  if (!player.avatarFallback) {
    player.avatarFallback = player.avatarUrl === BUILTIN_AVATAR_URL ? 'ready' : 'loading'
    player.applyAvatar()
    return true
  }
  return player.avatarFallback === 'loading'
}

// called when an avatar load settles (either way)
export function avatarSettled(player, url) {
  if (player.avatarFallback === 'loading' && url === BUILTIN_AVATAR_URL) player.avatarFallback = 'ready'
}

// a newly chosen avatar gets its own chance
export function avatarChosen(player) {
  player.avatarFallback = null
}
