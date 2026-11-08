import 'dotenv-flow/config'
import fs from 'fs-extra'
import path from 'path'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { polyfillNode } from 'esbuild-plugin-polyfill-node'
import { makePhysxFinalizePlugin } from './lib/finalizePhysxBuild.mjs'
import { buildPublicEnvDefines } from '../src/core/extras/publicEnv.js'

const dev = process.argv.includes('--dev')
const dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(dirname, '../')
const buildDir = path.join(rootDir, 'build')

// 公開可能な PUBLIC_ 環境変数だけをクライアントに渡す
const publicEnvDefines = buildPublicEnvDefines(process.env)

// await fs.emptyDir(buildDir)
await fs.emptyDir(path.join(buildDir, 'public'))

/**
 * Build Client
 */

const clientPublicDir = path.join(rootDir, 'src/client/public')
const clientBuildDir = path.join(rootDir, 'build/public')
const clientHtmlSrc = path.join(rootDir, 'src/client/public/index.html')
const clientHtmlDest = path.join(rootDir, 'build/public/index.html')

{
  const shared = {
    outdir: clientBuildDir,
    entryNames: '/[name]-[hash]',
    platform: 'browser',
    format: 'esm',
    bundle: true,
    treeShaking: true,
    minify: !dev,
    sourcemap: true,
    metafile: true,
    jsx: 'automatic',
    jsxImportSource: '@firebolt-dev/jsx',
    define: {
      'process.env.NODE_ENV': dev ? '"development"' : '"production"',
      ...publicEnvDefines,
    },
    loader: {
      '.js': 'jsx',
    },
    alias: {
      react: 'react', // always use our own local react (jsx)
    },
  }
  // the served path of an entry's output (matched by entry point, so split chunks are never picked)
  const entryOutput = (metafile, entry) => {
    const found = Object.entries(metafile?.outputs ?? {}).find(([, output]) => output.entryPoint === entry)
    return found ? found[0].split('build/public')[1] : null
  }
  const paths = { js: null, particles: null }
  const writeHtml = async () => {
    if (!paths.js || !paths.particles) return
    let htmlContent = await fs.readFile(clientHtmlSrc, 'utf-8')
    htmlContent = htmlContent.replace('{jsPath}', paths.js)
    htmlContent = htmlContent.replace('{particlesPath}', paths.particles)
    htmlContent = htmlContent.replaceAll('{buildId}', Date.now())
    await fs.writeFile(clientHtmlDest, htmlContent)
  }
  // The particles worker is a classic Worker (new Worker(path)): one self-contained file, never split.
  const particlesCtx = await esbuild.context({
    ...shared,
    entryPoints: ['src/client/particles.js'],
    plugins: [
      polyfillNode({}),
      {
        name: 'particles-finalize-plugin',
        setup(build) {
          build.onEnd(async result => {
            if (result.errors.length) return
            paths.particles = entryOutput(result.metafile, 'src/client/particles.js')
            await writeHtml()
          })
        },
      },
    ],
  })
  // The app is split: code loaded with import() (eg WalletConnect) goes to /chunks and loads only when used.
  const clientCtx = await esbuild.context({
    ...shared,
    entryPoints: ['src/client/index.js'],
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    plugins: [
      polyfillNode({}),
      {
        name: 'client-finalize-plugin',
        setup(build) {
          build.onEnd(async result => {
            if (result.errors.length) return
            // copy over public files
            await fs.copy(clientPublicDir, clientBuildDir)
            // copy physx wasm to public
            const physxWasmSrc = path.join(rootDir, 'src/core/physx-js-webidl.wasm')
            const physxWasmDest = path.join(rootDir, 'build/public/physx-js-webidl.wasm')
            await fs.copy(physxWasmSrc, physxWasmDest)
            // inject the entry paths into the html (after the copy, which brings the template back)
            paths.js = entryOutput(result.metafile, 'src/client/index.js')
            await writeHtml()
          })
        },
      },
    ],
  })
  if (dev) {
    await particlesCtx.watch()
    await clientCtx.watch()
  } else {
    await particlesCtx.rebuild()
    await clientCtx.rebuild()
  }
  const buildResult = await clientCtx.rebuild()
  fs.writeFileSync(path.join(buildDir, 'meta.json'), JSON.stringify(buildResult.metafile, null, 2))
}

/**
 * Build Server
 */

{
  const serverCtx = await esbuild.context({
    entryPoints: ['src/server/index.js'],
    outfile: 'build/index.js',
    platform: 'node',
    format: 'esm',
    bundle: true,
    treeShaking: true,
    minify: false,
    sourcemap: true,
    packages: 'external',
    define: {
      'process.env.CLIENT': 'false',
      'process.env.SERVER': 'true',
    },
    plugins: [makePhysxFinalizePlugin({ rootDir, dev, forkEntry: 'build/index.js' })],
    loader: {},
  })
  if (dev) {
    await serverCtx.watch()
  } else {
    await serverCtx.rebuild()
  }
}
