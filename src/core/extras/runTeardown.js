// An app run's teardown (App.unbuild) as one host-private, monotonic state.
//
// Script code can run while a run is torn down: its destroy listeners, a control's onRelease, an effect's onEnd, and
// any method a script defined on an object the host also uses (a method on a node's matrixWorld that unmounting
// reads, say). Each kind of resource has the stage that releases it; once that stage has started for a run, every
// path that could make that kind for the run refuses it, for good: a lookup, a method of a handle kept from before,
// a callback. Nothing made by a late callback can then be left behind by a stage that has already run. The state is
// keyed by the run (the app's dead hook), which scripts never hold, and only ever moves forward.
//
// The stages, in the order unbuild runs them (and the kinds each one closes):
export const Teardown = Object.freeze({
  // before the destroy event: controls (app.control)
  CONTROLS: 1,
  // player handles (world.getPlayer), and through any handle: effects and voice modifiers
  PLAYERS: 2,
  // node mounts: world.add, world.attach, node.add into a mounted tree of the run, and Node.activate
  NODES: 3,
  // app and world listeners (and with them the hot registration of update listeners)
  LISTENERS: 4,
  // fetch
  REQUESTS: 5,
  // setTimeout
  TIMERS: 6,
})

const stages = new WeakMap() // run -> the latest stage that has started

export function beginTeardown(run, stage) {
  if (run && (stages.get(run) || 0) < stage) stages.set(run, stage)
}

// whether `stage` (and so the kind it releases) has started for this run
export function tornDown(run, stage) {
  return !!run && (stages.get(run) || 0) >= stage
}
