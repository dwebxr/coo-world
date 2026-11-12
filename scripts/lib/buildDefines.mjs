// The `define` maps of the esbuild builds in scripts/build.mjs: what a build writes into a bundle in place of
// `process.env.<NAME>`.
import { buildPublicEnvDefines } from '../../src/core/extras/publicEnv.js'

// The page's bundles (the app and the particles worker). Whatever the environment of the build holds, the keys are
// the build flag and the PUBLIC_ names the client reads (publicEnv.js PUBLIC_ENV_NAMES; not the three /env.js serves
// as before, which no bundled code reads): a bundle is a file anyone can download, so nothing else of the
// environment may be written into it.
export function clientDefines(env, { dev = false } = {}) {
  return {
    'process.env.NODE_ENV': dev ? '"development"' : '"production"',
    ...buildPublicEnvDefines(env),
  }
}

// The server's bundle: two flags, and nothing of the environment (the server reads its settings when it runs).
export function serverDefines() {
  return {
    'process.env.CLIENT': 'false',
    'process.env.SERVER': 'true',
  }
}
