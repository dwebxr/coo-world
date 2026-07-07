import { hasRank, Ranks } from './ranks'

export function getEffectiveRank(player) {
  return Math.max(player.data.rank, player.world.settings.effectiveRank)
}

export function outranks(player, otherPlayer) {
  return getEffectiveRank(player) > getEffectiveRank(otherPlayer)
}

export function isAdmin(player) {
  return hasRank(getEffectiveRank(player), Ranks.ADMIN)
}

export function isBuilder(player) {
  return hasRank(getEffectiveRank(player), Ranks.BUILDER)
}

export function isMuted(player) {
  return player.world.livekit.isMuted(player.data.id)
}
