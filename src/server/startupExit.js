// A server that could not start ends with exit code 1.
//
// explicit `.js` imports only, and none of the server's own: this module is the first of the server's modules that
// index.js loads, before lockdown runs, and it is exercised directly by node:test
//
// lockdown (src/core/lockdown.js) runs SES with errorTrapping 'report': SES listens for uncaught exceptions, prints
// them, and lets the process go on. For a running server that is the choice made there. For one that is starting it
// meant that a refused setting (`[envs] ...` thrown at the top of index.js), an unreadable database or a world that
// failed to load ended in one of two ways: the process ran out of work and exited with code 0, which a supervisor
// reads as a clean stop, or something already kept it alive (a database connection, a timer) and it stayed up
// without ever listening.
//
// From install() until listening():
// - process.exitCode is 1, so a process that ends by itself during start-up says so, whatever the path.
// - Before scriptsStart(): any uncaught exception ends the process with 1. Nothing but the server's own start-up
//   code (and the modules it loads, lockdown among them) has run by then.
// - From scriptsStart() (index.js calls it before the world loads and its app scripts start): uncaught exceptions
//   are left to SES, printed and survived as in a running server, whatever their origin: content in the world must
//   not be able to keep the server from starting, and which exceptions are the start-up's own cannot be told from
//   the event (it depends on how Node was told to treat unhandled rejections). The steps of the start-up that can
//   fail from then on (loading the world, listening) are awaited through step(), which ends the process with 1
//   when one rejects.
//   Not covered: start-up code that throws synchronously between those steps, or from a callback of its own. The
//   exit code is still 1 if the process then ends by itself, and nothing ends it if something keeps it alive.
// After listening(): nothing here acts any more, and the exit code is whatever the shutdown gives (shutdown.js).
//
// Ending the process: the reason is written to stderr, and the exit waits until stdout and stderr have handed over
// what was written before it (SES's report of the error among it; writes to a pipe are asynchronous, and an exit
// at once cut a long report short), for at most EXIT_FLUSH_MS.
export const EXIT_FLUSH_MS = 2000

const describe = err => {
  try {
    return typeof err?.stack === 'string' && err.stack ? err.stack : String(err)
  } catch {
    return 'an error that cannot be shown'
  }
}

export function installStartupExit({
  proc = process,
  setImmediate = globalThis.setImmediate,
  setTimeout = globalThis.setTimeout,
} = {}) {
  let phase = 'config'
  let failing = false
  proc.exitCode = 1

  const fail = err => {
    if (failing) return
    failing = true
    proc.exitCode = 1
    const exit = () => proc.exit(1)
    setTimeout(exit, EXIT_FLUSH_MS)
    // in a later turn: the other listeners of the event (SES) write their report first, and it is waited for too
    setImmediate(() => {
      let open = 2
      const flushed = () => {
        if (--open === 0) exit()
      }
      try {
        proc.stderr.write(`[server] start-up failed; exiting with code 1: ${describe(err)}\n`, flushed)
        proc.stdout.write('', flushed)
      } catch {
        exit()
      }
    })
  }

  const onUncaught = err => {
    if (phase === 'config') fail(err)
  }
  proc.on('uncaughtException', onUncaught)

  return {
    // the world is about to load: app scripts run from here on
    scriptsStart() {
      if (phase === 'config') phase = 'scripts'
    },
    // One awaited step of the start-up: its value when it succeeds. When it fails the process is ended with 1 and
    // this never returns (the start-up does not go on with a step missing).
    async step(run) {
      try {
        return await run()
      } catch (err) {
        fail(err)
        return new Promise(() => {})
      }
    },
    // the server accepts connections: start-up is over
    listening() {
      if (failing) return
      phase = 'listening'
      proc.exitCode = 0
      proc.off('uncaughtException', onUncaught)
    },
    get phase() {
      return phase
    },
  }
}
