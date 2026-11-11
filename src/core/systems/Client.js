import { briefError } from '../extras/logOnce.js'
import { System } from './System'

import * as THREE from '../extras/three'
import { initYoga } from '../extras/yoga'
import { setDebugGlobal } from '../extras/debugGlobals'

let worker

/**
 * Client System
 *
 * - Runs on the client
 *
 *
 */
export class Client extends System {
  constructor(world) {
    super(world)
    this.tickErrors = new Set()
    setDebugGlobal('world', world)
    setDebugGlobal('THREE', THREE)
  }

  // the frame callback: like the server's tick, one exception is logged (each distinct message once, up to 32)
  // and the next frame runs; a throw out of the animation loop would end it for good
  tick = time => {
    try {
      this.world.tick(time)
    } catch (err) {
      this.world.accumulator = 0
      const message = briefError(err)
      if (this.tickErrors.size < 32 && !this.tickErrors.has(message)) {
        this.tickErrors.add(message)
        console.error(`[client] tick failed: ${message}`, err)
      }
    }
  }

  async init({ loadYoga }) {
    await loadYoga
    initYoga()
  }

  start() {
    if (this.world.fatalError) return
    this.world.graphics.renderer.setAnimationLoop(this.tick)
    document.addEventListener('visibilitychange', this.onVisibilityChange)

    this.world.settings.on('change', this.onSettingsChange)
  }

  onSettingsChange = changes => {
    if (changes.title) {
      const title = changes.title.value
      document.title = typeof title === 'string' && title ? title : 'World'
    }
  }

  onVisibilityChange = () => {
    if (this.world.fatalError) return
    // if the tab is no longer active, browsers stop triggering requestAnimationFrame.
    // this is obviously bad because physics stop running and we stop processing websocket messages etc.
    // instead, we stop using requestAnimationFrame and get a worker to tick at a slower rate using setInterval
    // and notify us.
    // this allows us to keep everything running smoothly.
    // See: https://gamedev.stackexchange.com/a/200503 (kinda fucking genius)
    //
    // spawn worker if we haven't yet
    if (!worker) {
      const script = `
        const rate = 1000 / 5 // 5 FPS
        let intervalId = null;
        self.onmessage = e => {
          if (e.data === 'start' && !intervalId) {
            intervalId = setInterval(() => {
              self.postMessage(1);
            }, rate);
            console.log('[worker] tick started')
          }
          if (e.data === 'stop' && intervalId) {
            clearInterval(intervalId);
            intervalId = null;
            console.log('[worker] tick stopped')
          }
        }
      `
      const blob = new Blob([script], { type: 'application/javascript' })
      worker = new Worker(URL.createObjectURL(blob))
      worker.onmessage = () => {
        if (this.world.fatalError) return
        const time = performance.now()
        this.tick(time)
      }
    }
    if (document.hidden) {
      // stop rAF
      this.world.graphics.renderer.setAnimationLoop(null)
      // tell the worker to start
      worker.postMessage('start')
    } else {
      // tell the worker to stop
      worker.postMessage('stop')
      // resume rAF
      this.world.graphics.renderer.setAnimationLoop(this.tick)
    }
  }

  stopForFatal() {
    this.world.graphics.renderer.setAnimationLoop(null)
    if (worker) {
      worker.onmessage = null
      worker.terminate()
      worker = null
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
  }

  destroy() {
    this.world.graphics.renderer.setAnimationLoop(null)
    worker?.postMessage('stop')
    worker = null
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
  }
}
