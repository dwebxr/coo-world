// `node scripts/coo-world-folder.mjs`, with WORLD in the environment: the world folder the image's entrypoint
// (scripts/coo-entrypoint.sh, which runs this as /app/scripts/coo-world-folder.mjs) may give to 1001:1001, decided by
// scripts/lib/worldFolder.mjs on the folder as the file system resolves it. The app root is /app, as in the image;
// there is no option to change it.
//   exit 0  the folder on stdout, as it is, with nothing after it (no line break: a name may end in one)
//   exit 1  refused: `[entrypoint] refused: WORLD="…" resolves to <folder>: <why>` on stderr
//   exit 2  something went wrong in the decision itself: the error on stderr
import { resolveWorldFolder } from './lib/worldFolder.mjs'

try {
  const result = resolveWorldFolder({ world: process.env.WORLD ?? '' })
  if (result.ok) {
    process.stdout.write(result.folder)
  } else {
    process.stderr.write(`[entrypoint] refused: ${result.reason}\n`)
    process.exitCode = 1
  }
} catch (err) {
  process.stderr.write(`[entrypoint] could not work out the world folder from WORLD: ${err?.message ?? err}\n`)
  process.exitCode = 2
}
