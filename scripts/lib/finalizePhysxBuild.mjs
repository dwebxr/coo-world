import fs from 'fs-extra'
import path from 'path'
import { fork } from 'child_process'

/**
 * Copies over the built PhysX files, then either (re)starts the fork
 * (dev) or exits the process (prod build).
 *
 * A build that failed has nothing to finish:
 * - a production build exits 1. It used to exit 0 here, before esbuild could report the failure to the script, so
 *   `npm run build` succeeded with a syntax error in the server (and left no, or an old, build/index.js);
 * - in dev the fork that is running is left as it is until a build succeeds. It used to be stopped and started
 *   again on the output of the failed build, which esbuild 0.25 deletes: the new fork died at once.
 */
export function makePhysxFinalizePlugin({
  rootDir,
  dev,
  forkEntry,
  exit = code => process.exit(code),
  start = fork,
  log = console,
}) {
  let spawn
  return {
    name: 'server-finalize-plugin',
    setup(build) {
      build.onEnd(async result => {
        if (result.errors.length) {
          if (!dev) return exit(1)
          log.error(`[build] failed (${result.errors.length} errors): ${forkEntry} is left running as it was`)
          return
        }
        // copy over physx js
        const physxIdlSrc = path.join(rootDir, 'src/core/physx-js-webidl.js')
        const physxIdlDest = path.join(rootDir, 'build/physx-js-webidl.js')
        await fs.copy(physxIdlSrc, physxIdlDest)
        // copy over physx wasm
        const physxWasmSrc = path.join(rootDir, 'src/core/physx-js-webidl.wasm')
        const physxWasmDest = path.join(rootDir, 'build/physx-js-webidl.wasm')
        await fs.copy(physxWasmSrc, physxWasmDest)
        // start the server or stop here
        if (dev) {
          // (re)start server
          spawn?.kill('SIGTERM')
          spawn = start(path.join(rootDir, forkEntry))
        } else {
          exit(0)
        }
      })
    },
  }
}
