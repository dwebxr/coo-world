import fs from 'fs-extra'
import path from 'path'
import { fork } from 'child_process'

/**
 * Copies over the built PhysX files, then either (re)starts the fork
 * (dev) or exits the process (prod build).
 */
export function makePhysxFinalizePlugin({ rootDir, dev, forkEntry }) {
  let spawn
  return {
    name: 'server-finalize-plugin',
    setup(build) {
      build.onEnd(async () => {
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
          spawn = fork(path.join(rootDir, forkEntry))
        } else {
          process.exit(0)
        }
      })
    },
  }
}
