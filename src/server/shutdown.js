import { briefError } from '../core/extras/logOnce.js'

// explicit `.js` imports only: this module is exercised directly by node:test

// The final save runs inside the platform's grace period: Fly sends SIGKILL 5 s after the stop signal by default
// (kill_timeout), and a stopped or restarted machine is routine (auto-stop, deploys).
export const SHUTDOWN_DEADLINE_MS = 3500
// how long after the deadline the process exits even if the save never returned (a write that ignores it)
const EXIT_MARGIN_MS = 500

// SIGINT/SIGTERM. Installed at the very start of the server, before the database, the cleaner and the world exist.
// - Before attach() (start-up, nothing loaded that could have changed): the process exits 0 with a log line.
// - After attach({ network, stopWorld, closeServer }) (the world exists, scripts may run): the first signal stops
//   the world (no tick runs, app timers are cleared), stops accepting connections and runs the network's final save
//   (ServerNetwork.flushBeforeExit: blueprints, apps, settings, spawn and the script storage file) under one
//   deadline, then exits 0, or 1 when something was not saved (flushBeforeExit logs what).
// A second signal exits at once with 1. Open connections are not waited for: the exit closes them.
export function installShutdown({
  proc = process,
  network,
  stopWorld = () => {},
  closeServer = () => {},
  deadlineMs = SHUTDOWN_DEADLINE_MS,
  log = console,
} = {}) {
  let target = network ? { network, stopWorld, closeServer } : null
  let stopping = false
  const exit = code => proc.exit(code)
  const onSignal = async signal => {
    if (stopping) {
      log.error(`[server] ${signal} again: exiting without waiting for the final save`)
      return exit(1)
    }
    stopping = true
    if (!target) {
      log.log(`[server] ${signal} during start-up, before the world was loaded: nothing to save; exiting`)
      return exit(0)
    }
    log.log(`[server] ${signal}: saving the world before exit (deadline ${deadlineMs} ms)`)
    const guard = setTimeout(() => {
      log.error('[server] the final save did not return in time; exiting')
      exit(1)
    }, deadlineMs + EXIT_MARGIN_MS)
    guard.unref?.()
    let saving
    try {
      target.stopWorld?.()
    } catch (err) {
      log.error(`[server] stopping the world failed: ${briefError(err)}`)
    }
    try {
      // marks the network as stopping before anything awaits, so no connection or packet is taken from here on
      saving = target.network.flushBeforeExit(deadlineMs)
    } catch (err) {
      saving = Promise.reject(err)
    }
    try {
      // stop listening; the close itself (open requests, websocket close frames) is not waited for
      Promise.resolve(target.closeServer?.()).catch(err => log.error(`[server] close failed: ${briefError(err)}`))
    } catch (err) {
      log.error(`[server] close failed: ${briefError(err)}`)
    }
    let code = 0
    try {
      await saving
    } catch (err) {
      code = 1
      log.error(`[server] final save failed: ${briefError(err)}`)
    }
    clearTimeout(guard)
    exit(code)
  }
  proc.on('SIGINT', onSignal)
  proc.on('SIGTERM', onSignal)
  return {
    attach(next) {
      target = next
    },
    onSignal,
  }
}

// The stop a crashed app gets (App.crash), for every app at once: its timers are cleared and its pending
// continuations (world.load, world event listeners, timer callbacks already queued) see a dead run and return.
// Script code that still runs (a fetch resolving) finds world.set refused once the final save has started.
export function stopApps(entities) {
  for (const entity of entities?.items?.values() ?? []) {
    if (!entity?.isApp) continue
    entity.timers?.clear()
    if (entity.deadHook) entity.deadHook.dead = true
  }
}
