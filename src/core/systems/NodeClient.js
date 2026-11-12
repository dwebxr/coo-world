import { System } from './System'

const TICK_RATE = 1 / 30

/**
 * Node Client System
 *
 * - Runs on node
 * - Ticks!
 *
 */
export class NodeClient extends System {
  constructor(world) {
    super(world)
    this.timerId = null
  }

  start() {
    this.tick()
  }

  tick = () => {
    if (this.world.fatalError || this.destroyed) return
    const time = performance.now()
    this.world.tick(time)
    // (a world destroyed from inside its own tick used to be scheduled again here, after destroy() had cleared the
    // timer: it went on ticking with its physics released)
    if (!this.world.fatalError && !this.destroyed) this.timerId = setTimeout(this.tick, TICK_RATE * 1000)
  }

  stopForFatal() {
    this.destroy()
  }

  destroy() {
    this.destroyed = true
    clearTimeout(this.timerId)
  }
}
