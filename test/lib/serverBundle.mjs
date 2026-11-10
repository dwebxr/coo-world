// Bundles server modules (whose imports omit the `.js` extension) into a temp ESM file that node:test can import,
// with packages resolved from the repo's node_modules, as persistenceIntegration.test.js does for the server.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))

export async function bundleServer(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-bundle-'))
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const outfile = path.join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: { contents, resolveDir: root, sourcefile: 'server-bundle-entry.js' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    define: { 'process.env.CLIENT': 'false', 'process.env.SERVER': 'true' },
    logLevel: 'silent',
  })
  return {
    module: await import(pathToFileURL(outfile).href),
    destroy: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}
