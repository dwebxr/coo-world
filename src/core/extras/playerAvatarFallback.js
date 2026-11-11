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

// Puts the avatar a load produced (`src`) in the place of the one showing, as one step, for both player classes. The
// new avatar is made, added beside the one showing and mounted; the player takes it only once it is mounted and
// everything about it is set, and only then does the previous avatar go. A failure on the way takes the new avatar out
// again and leaves the player as it was, then rethrows, so that avatarLoadFailed finds the player with the avatar it
// still shows: the player's avatar, its url and the fields from `takes` are set last, after everything that can fail,
// and the heights of the name and the bubble, and whether the name shows, are put back.
//
// How the mount is known to have worked: an avatar from the loader's toNodes() carries its factory, so its mount
// reaches no await and has ended when base.add returns. But Avatar.mount is async and Node.activate drops its promise:
// a factory.create that throws ends that mount as a rejected promise, not as an exception here, and the instance is set
// before the steps that follow create, so an instance alone does not prove the mount ended well. The mount's own
// promise (Avatar.mounting) does: it is awaited (which is also what handles its rejection), the load is checked again
// (anything may have happened meanwhile), and the instance must be there.
//
// `prepare(avatar)` sets what the avatar needs before it mounts; `takes(avatar)` returns the fields the player takes
// from the mounted avatar, set together with the avatar.
export async function installAvatar(player, load, url, src, { prepare, takes } = {}) {
  if (!isCurrentAvatarLoad(player, load)) return
  const avatar = src.toNodes().get('avatar')
  if (!avatar) throw new Error(`[avatar] no avatar in ${url}`)
  const { base, nametag, bubble } = player
  const before = { nametagY: nametag.position.y, bubbleY: bubble.position.y, nametagActive: nametag.active }
  let aura = false
  let previous
  try {
    prepare?.(avatar)
    base.add(avatar)
    await avatar.mounting
    if (!isCurrentAvatarLoad(player, load)) {
      takeOut(base, avatar)
      return
    }
    if (!avatar.instance) throw new Error(`[avatar] ${url} could not be mounted`)
    // read from the mounted avatar: before its mount it has no instance and no heights
    const headToHeight = avatar.getHeadToHeight()
    const fields = takes?.(avatar)
    aura = true
    nametag.position.y = headToHeight + 0.2
    bubble.position.y = headToHeight + 0.2
    if (!bubble.active) nametag.active = true
    // plain fields: nothing from here on throws
    previous = player.avatar
    Object.assign(player, fields)
    player.avatar = avatar
    player.avatarUrl = url
  } catch (err) {
    if (aura) putAuraBack(player, before)
    takeOut(base, avatar)
    throw err
  }
  avatarSettled(player, url)
  previous?.deactivate()
}

// a new avatar that is not taken leaves the player's base, and its instance leaves the world
function takeOut(base, avatar) {
  try {
    if (avatar.parent === base) base.remove(avatar)
    else if (avatar.mounted) avatar.deactivate()
  } catch (err) {
    console.error('[avatar] a new avatar could not be taken out', err)
  }
}

// each on its own: one that fails does not keep the others from being put back
function putAuraBack({ nametag, bubble }, before) {
  const steps = [
    () => (nametag.position.y = before.nametagY),
    () => (bubble.position.y = before.bubbleY),
    () => (nametag.active = before.nametagActive),
  ]
  for (const step of steps) {
    try {
      step()
    } catch (err) {
      console.error('[avatar] the name or the bubble could not be put back', err)
    }
  }
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
