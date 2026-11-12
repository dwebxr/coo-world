// A server that could not start ends with exit code 1.
//
// explicit `.js` imports only: this module is exercised directly by node:test
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
// - Before scriptsStart(): any uncaught exception ends the process with 1 at once. Nothing but the server's own
//   start-up code has run by then.
// - From scriptsStart() (index.js calls it before the world loads and its app scripts start): only the failure of
//   the start-up sequence itself does, which Node reports as an uncaught exception of origin 'unhandledRejection'
//   (the entry module threw, or a promise it awaited rejected). An exception thrown from a callback while the world
//   loads is printed and survived, as it is in a running server: content in the world must not be able to keep the
//   server from starting. This rests on SES handling stray promise rejections itself (unhandledRejectionTrapping
//   'report'), so that they do not arrive here; test/startupExit.test.js runs it against the real lockdown.
//   A start-up sequence that throws inside a callback of its own after scriptsStart() is not caught by this: the
//   exit code is still 1 if the process ends, and nothing ends it if something keeps it alive.
// After listening(): nothing here acts any more, and the exit code is whatever the shutdown gives (shutdown.js).
export function installStartupExit({ proc = process, log = console } = {}) {
  let phase = 'config'
  proc.exitCode = 1
  const onUncaught = (err, origin) => {
    if (phase === 'scripts' && origin !== 'unhandledRejection') return
    // SES has printed the error (its listener was installed first, by lockdown)
    log.error('[server] start-up failed; exiting with code 1')
    proc.exit(1)
  }
  proc.on('uncaughtException', onUncaught)
  return {
    // the world is about to load: app scripts run from here on
    scriptsStart() {
      if (phase === 'config') phase = 'scripts'
    },
    // the server accepts connections: start-up is over
    listening() {
      phase = 'listening'
      proc.exitCode = 0
      proc.off('uncaughtException', onUncaught)
    },
    get phase() {
      return phase
    },
  }
}
