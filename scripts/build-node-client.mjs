import 'dotenv-flow/config'
import path from 'path'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { makePhysxFinalizePlugin } from './lib/finalizePhysxBuild.mjs'

const dev = process.argv.includes('--dev')
const dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(dirname, '../')

// await fs.emptyDir(buildDir)

/**
 * Build Node Client
 *
 * This creates a hybrid client build that can in nodejs headlessly, as such it doesn't utilize rendering and other systems
 * that use browser apis
 *
 */

{
  const nodeClientCtx = await esbuild.context({
    entryPoints: ['src/node-client/index.js'],
    outfile: 'build/world-node-client.js',
    platform: 'node',
    format: 'esm',
    bundle: true,
    treeShaking: true,
    minify: false,
    sourcemap: true,
    packages: 'external',
    loader: {},
    plugins: [makePhysxFinalizePlugin({ rootDir, dev, forkEntry: 'build/world-node-client.js' })],
  })
  if (dev) {
    await nodeClientCtx.watch()
  } else {
    await nodeClientCtx.rebuild()
  }
}
