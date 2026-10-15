import { System } from './System'
import os from 'os'
import { createTickSampler } from '../extras/tickSampler'

export class ServerMonitor extends System {
  constructor(world) {
    super(world)
    this.tickSampler = null
    // MONITOR_TICK=1 times every world tick and reports a summary per window (see tickSampler.js)
    if (process.env.MONITOR_TICK === '1') this.installTickSampler()
  }

  installTickSampler() {
    const tick = this.world.tick
    const sampler = createTickSampler({ log: line => process.stdout.write(`${line}\n`) })
    this.world.tick = time => {
      const start = performance.now()
      tick(time)
      sampler.sample(performance.now() - start)
    }
    this.tickSampler = sampler
  }

  async getStats() {
    const memUsage = process.memoryUsage()
    const startCPU = process.cpuUsage()
    await new Promise(resolve => setTimeout(resolve, 100))
    const endCPU = process.cpuUsage(startCPU)
    const cpuPercent = (endCPU.user + endCPU.system) / 1000 / 100
    const stats = {
      maxMemory: Math.round(os.totalmem() / 1024 / 1024),
      currentMemory: Math.round(memUsage.rss / 1024 / 1024),
      maxCPU: os.cpus().length * 100,
      currentCPU: cpuPercent,
    }
    if (this.tickSampler?.last) stats.tick = this.tickSampler.last
    return stats
  }
}
