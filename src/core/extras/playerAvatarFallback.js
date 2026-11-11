// When a player (or its avatar) throws in the frame loop, World.hotFailed keeps the player running on the
// built-in avatar instead of dropping it (a dropped local player would freeze). The built-in file, not the
// world's default avatar setting: that one is builder-chosen and may be the failing file.
export const BUILTIN_AVATAR_URL = 'asset://avatar.vrm'

// the avatar a player has asked for
export function playerAvatarSource(player) {
  return player.data.sessionAvatar || player.data.avatar || BUILTIN_AVATAR_URL
}

// the url a player's avatar loads from
export function playerAvatarUrl(player) {
  if (player.avatarFallback) return BUILTIN_AVATAR_URL
  return playerAvatarSource(player)
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

// Every avatar request starts a new load generation; a load that completes after a newer request (or after a
// request for the avatar already installed) is stale and installs nothing, so the avatar shown is always the
// latest one asked for, and the fallback cannot be replaced by an older, slower load.
export function beginAvatarLoad(player) {
  player.avatarLoad = (player.avatarLoad || 0) + 1
  return player.avatarLoad
}

export function isCurrentAvatarLoad(player, load) {
  return player.avatarLoad === load && !player.destroyed
}

// called when the current avatar load settles (either way): the fallback is 'ready' once the built-in avatar is
// installed, or once its load failed (there is nothing left to fall back to)
export function avatarSettled(player, url) {
  if (player.avatarFallback === 'loading' && url === BUILTIN_AVATAR_URL) player.avatarFallback = 'ready'
}

// A newly chosen avatar gets its own chance, and its own choice number: a retry scheduled for an earlier choice does
// nothing, even when the same avatar was chosen again since (that choice has its own load, and its own retry).
// Called wherever the avatar a player asks for changes.
export function avatarChosen(player) {
  player.avatarFallback = null
  player.avatarRetried = false
  player.avatarChoice = (player.avatarChoice || 0) + 1
}

// the code of a load the loader refused only because too many were running (ClientLoader.enter)
export const LOADER_BUSY = 'LOADER_BUSY'
export const AVATAR_RETRY_MS = 15000

// Called when the player's current avatar load failed (a missing file, one the loader's limits refuse, a file that is
// not a usable avatar). A player who has an avatar showing keeps it. One who has none would be a name floating over
// nothing, for everyone, for as long as they stay: they get the built-in avatar. When the load was only turned away
// because the loader was busy, the avatar is asked for once more a little later, whichever avatar shows meanwhile;
// `later` is setTimeout.
export function avatarLoadFailed(player, url, err, later = setTimeout) {
  avatarSettled(player, url)
  if (err?.code === LOADER_BUSY && !player.avatarRetried) {
    player.avatarRetried = true
    const choice = player.avatarChoice
    later(() => {
      // still the same player, with the same choice of avatar
      if (player.destroyed || player.avatarChoice !== choice || playerAvatarSource(player) !== url) return
      player.avatarFallback = null
      player.applyAvatar()
    }, AVATAR_RETRY_MS)
  }
  if (player.avatar || player.avatarFallback) return
  if (url === BUILTIN_AVATAR_URL) {
    // nothing left to fall back to
    player.avatarFallback = 'ready'
    return
  }
  switchToBuiltinAvatar(player)
}
