// The app and player entities of the join tests' world (joinFixture.mjs), in place of the real ones (no scripts, no
// physics): the bundle's Entities makes these (network.mjs entityClasses), from its own copy of this module.
export class FakeApp {
  constructor(world, data) {
    this.world = world
    this.data = data
    this.isApp = true
    this.builds = 0
  }
  modify(change) {
    Object.assign(this.data, change)
  }
  build() {
    this.builds++
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.world.entities.remove(this.data.id)
  }
  serialize() {
    return this.data
  }
}

export class FakePlayer extends FakeApp {
  constructor(world, data) {
    super(world, data)
    this.isApp = false
    this.isPlayer = true
  }
  isBuilder() {
    return this.data.rank >= 1
  }
  isAdmin() {
    return this.data.rank >= 2
  }
  // as playerRanks.outranks: the session's rank and the world's, for both
  outranks(other) {
    const rank = player => Math.max(player.data.rank, player.world.settings.effectiveRank)
    return rank(this) > rank(other)
  }
}

export { FakeApp as App, FakePlayer as PlayerLocal, FakePlayer as PlayerRemote }
