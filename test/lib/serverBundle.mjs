// Bundles server modules (whose imports omit the `.js` extension) into a temp ESM file that node:test can import,
// with packages resolved from the repo's node_modules, as persistenceIntegration.test.js does for the server.
//
// bundleServer(contents, { replace, sourceRoot }) → { module, url, importWith(env), destroy }
// - `replace`: { 'src/…/module.js': source } — the module, wherever the bundle imports it, is that source instead
//   (resolved from the module's own folder, so its relative imports read as in the original). In the source,
//   `'real:'` is the real module: `export * from 'real:'` plus local `export let name = …` overrides keeps the rest
//   of it (a name the source declares itself wins over the star export). A setter the source exports (`export
//   function setName(value) { name = value }`) changes the override between two calls without bundling again:
//   importers see `let` exports as live bindings. A replaced module the bundle never imports is an error.
// - `sourceRoot`: a checkout whose src/core and src/server files are read instead of this one's where they exist
//   (REAL_PHYSX_SOURCE_ROOT, as in persistedStartup.test.js); `replace` wins over it.
// - `importWith(env)`: the same bundle evaluated again with `env` in process.env, for constants a module computes
//   from the environment at import (SAVE_INTERVAL, the gating flags). The values (undefined: unset) are put into
//   process.env, the bundle is imported under a query naming them, and process.env is restored before this returns.
//   A second call with the same values returns the same module instance. Every evaluation has its own classes, so
//   a test takes Socket, the error classes, … from the module it constructs the network from.
// Bundles are cached per (contents, replace, sourceRoot): a file whose tests ask for the same bundle builds it once
// and gets one module instance. Each call is one reference; `destroy()` gives it up and the temp folder is removed
// with the last one (or when the process exits).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))

const REAL = 'real:'
const cache = new Map()
process.once('exit', () => {
  for (const entry of cache.values()) if (entry.dir) fs.rmSync(entry.dir, { recursive: true, force: true })
})

// replace: repository-relative path → absolute path of the file it replaces (which must exist)
function replacements(replace = {}) {
  const map = new Map()
  for (const [file, source] of Object.entries(replace)) {
    if (typeof source !== 'string') throw new TypeError(`replace: the source for ${file} is not text`)
    const absolute = path.resolve(root, file)
    if (!fs.existsSync(absolute)) throw new Error(`replace: ${file} is not a file of this repository`)
    map.set(absolute, source)
  }
  return map
}

function plugin(replaced, sourceRoot) {
  // what the bundle reads for a file of src/core or src/server: the baseline checkout's where it has one
  const read = file => {
    if (sourceRoot && /\/src\/(core|server)\/.*\.js$/.test(file)) {
      const baseline = path.join(sourceRoot, path.relative(root, file))
      if (fs.existsSync(baseline)) return fs.readFileSync(baseline, 'utf8')
    }
    return null
  }
  return {
    name: 'test-replace',
    setup(build) {
      // the real module behind a replaced one: the same file in a namespace of its own, so its own imports
      // (resolved from its folder) find the other modules as usual
      build.onResolve({ filter: /^real:$/ }, args => {
        if (!replaced.has(args.importer)) throw new Error(`'${REAL}' is only for the source of a replaced module`)
        return { path: args.importer, namespace: 'real' }
      })
      build.onLoad({ filter: /.*/, namespace: 'real' }, args => ({
        contents: read(args.path) ?? fs.readFileSync(args.path, 'utf8'),
        resolveDir: path.dirname(args.path),
        loader: 'js',
      }))
      build.onLoad({ filter: /\.(m?js|jsx)$/ }, args => {
        if (replaced.has(args.path)) {
          return { contents: replaced.get(args.path), resolveDir: path.dirname(args.path), loader: 'js' }
        }
        const contents = read(args.path)
        if (contents !== null) return { contents, loader: 'js' }
      })
    },
  }
}

async function build(contents, { replace, sourceRoot }) {
  const replaced = replacements(replace)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-bundle-'))
  try {
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    const outfile = path.join(dir, 'bundle.mjs')
    const result = await esbuild.build({
      stdin: { contents, resolveDir: root, sourcefile: 'server-bundle-entry.js' },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      define: { 'process.env.CLIENT': 'false', 'process.env.SERVER': 'true' },
      logLevel: 'silent',
      metafile: replaced.size > 0,
      plugins: replaced.size || sourceRoot ? [plugin(replaced, sourceRoot)] : [],
    })
    if (replaced.size) {
      const inputs = new Set(Object.keys(result.metafile.inputs).map(input => path.resolve(root, input)))
      for (const file of replaced.keys()) {
        if (!inputs.has(file)) throw new Error(`replace: ${path.relative(root, file)} is not imported by the bundle`)
      }
    }
    const url = pathToFileURL(outfile).href
    return { dir, url, module: await import(url) }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

export async function bundleServer(contents, { replace, sourceRoot } = {}) {
  const key = JSON.stringify([contents, Object.entries(replace ?? {}).sort(), sourceRoot ?? null])
  let entry = cache.get(key)
  if (!entry) {
    entry = { refs: 0, dir: null }
    entry.ready = build(contents, { replace, sourceRoot }).then(
      built => Object.assign(entry, built),
      err => {
        cache.delete(key)
        throw err
      }
    )
    cache.set(key, entry)
  }
  entry.refs++
  let held = true
  const release = () => {
    if (!held) return
    held = false
    if (--entry.refs > 0) return
    if (cache.get(key) === entry) cache.delete(key)
    if (entry.dir) fs.rmSync(entry.dir, { recursive: true, force: true })
  }
  try {
    await entry.ready
  } catch (err) {
    held = false
    throw err
  }
  return {
    module: entry.module,
    url: entry.url,
    importWith: env => importWith(entry.url, env),
    destroy: release,
  }
}

async function importWith(url, env) {
  const names = Object.keys(env).sort()
  const saved = new Map(names.map(name => [name, Object.hasOwn(process.env, name) ? process.env[name] : undefined]))
  const set = (name, value) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = String(value)
  }
  try {
    for (const name of names) set(name, env[name])
    const query = new URLSearchParams(names.map(name => [name, env[name] === undefined ? '\0' : String(env[name])]))
    return await import(`${url}?${query}`)
  } finally {
    for (const [name, value] of saved) set(name, value)
  }
}
