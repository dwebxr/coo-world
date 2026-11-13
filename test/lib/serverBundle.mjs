// Bundles server modules (whose imports omit the `.js` extension) into a temp ESM file that node:test can import,
// with packages resolved from the repo's node_modules, as persistenceIntegration.test.js does for the server.
//
// buildServer(contents, { replace, prepend, sourceRoot }) → { url, evaluate(env), destroy }: the bundle built, not
// evaluated.
// - `replace`: { 'src/…/module.js': source } — the module, wherever the bundle imports it, is that source instead
//   (resolved from the module's own folder, so its relative imports read as in the original). In the source,
//   `'real:'` is the real module: `export * from 'real:'` plus local `export let name = …` overrides keeps the rest
//   of it (a name the source declares itself wins over the star export). A setter the source exports (`export
//   function setName(value) { name = value }`) changes the override between two calls without bundling again:
//   importers see `let` exports as live bindings. A replaced module the bundle never imports is an error.
//   `{ commonjs: source }` instead of the source: the module is that CommonJS source (`module.exports`;
//   `require('real:')` is the real module), which the bundle reads by property each time the code uses an export of
//   it (where an import of an ES module is a binding), so its exports can be getters or the traps of a Proxy: they see
//   every such use that is left in the bundle (esbuild removes a read of an export whose value is not used). (A file
//   of this package is an ES module by its package.json: the CommonJS source is a module of its own, which the
//   module in the file's place re-exports, without a default export.)
// - `prepend`: { 'src/…/module.js': text } — the text goes before the module's own source, on its first line (the
//   module's line numbers stay): an import there of a module of the tests (by absolute path) gives that one module
//   bindings that shadow the globals of the same names, which the rest of the bundle still reads
//   (network.mjs: the timers of ServerNetwork.js). The module must be part of the bundle and not replaced.
// - `sourceRoot`: a checkout whose src/core and src/server files are read instead of this one's where they exist
//   (REAL_PHYSX_SOURCE_ROOT, as in persistedStartup.test.js); `replace` wins over it, and `prepend` goes before the
//   baseline's source.
// - `evaluate(env)` → { module, url }: the bundle evaluated with `env` in process.env, for constants a module
//   computes from the environment at import (SAVE_INTERVAL, the gating flags). The values (null or undefined: unset)
//   are put into process.env, the bundle is imported under a query that names them (`url` is that evaluation's),
//   and process.env is restored before this returns, whether the import succeeded or threw. Evaluations of every
//   bundle of the process run one at a time, so none sees another's values. The same values give the same module
//   instance; every evaluation has its own classes, so a test takes Socket, the error classes, … from the module it
//   constructs the network from. Without `env` the bundle is evaluated with the environment as it is.
// bundleServer(contents, options) → { module, url, evaluate, destroy }: built and evaluated with the environment as
// it is (the bundles of cleanerTrash.test.js and assets.test.js).
// Builds are cached per (contents, replace, prepend, sourceRoot): a file whose tests ask for the same bundle builds
// it once.
// Each call is one reference; `destroy()` gives it up and the temp folder is removed with the last one (or when the
// process exits). heldBundles(): how many builds are held, for the tests of this helper.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))

const REAL = 'real:'
const COMMONJS = 'commonjs:'
const cache = new Map()
process.once('exit', () => {
  for (const entry of cache.values()) if (entry.dir) fs.rmSync(entry.dir, { recursive: true, force: true })
})

// replace: repository-relative path → absolute path of the file it replaces (which must exist) → { source, commonjs }
function replacements(replace = {}) {
  const map = new Map()
  for (const [file, value] of Object.entries(replace)) {
    const commonjs = typeof value?.commonjs === 'string'
    const source = commonjs ? value.commonjs : value
    if (typeof source !== 'string') throw new TypeError(`replace: the source for ${file} is not text`)
    const absolute = path.resolve(root, file)
    if (!fs.existsSync(absolute)) throw new Error(`replace: ${file} is not a file of this repository`)
    map.set(absolute, { source, commonjs })
  }
  return map
}

// prepend: repository-relative path → absolute path of the module (which must exist, and not be replaced) → text
function prefixes(prepend = {}, replaced) {
  const map = new Map()
  for (const [file, text] of Object.entries(prepend)) {
    if (typeof text !== 'string' || text.includes('\n')) {
      throw new TypeError(`prepend: the text for ${file} is not one line`)
    }
    const absolute = path.resolve(root, file)
    if (!fs.existsSync(absolute)) throw new Error(`prepend: ${file} is not a file of this repository`)
    if (replaced.has(absolute)) throw new Error(`prepend: ${file} is replaced`)
    map.set(absolute, text)
  }
  return map
}

function plugin(replaced, prefixed, sourceRoot) {
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
      // a CommonJS replacement: its source, as a module outside the package (which would make it an ES module)
      build.onResolve({ filter: /^commonjs:$/ }, args => {
        if (!replaced.get(args.importer)?.commonjs) throw new Error(`'${COMMONJS}' is only for a CommonJS replacement`)
        return { path: args.importer, namespace: 'commonjs' }
      })
      build.onLoad({ filter: /.*/, namespace: 'commonjs' }, args => ({
        contents: replaced.get(args.path).source,
        resolveDir: path.dirname(args.path),
        loader: 'js',
      }))
      build.onLoad({ filter: /\.(m?js|jsx)$/ }, args => {
        if (replaced.has(args.path)) {
          const { source, commonjs } = replaced.get(args.path)
          const contents = commonjs ? `export * from '${COMMONJS}'` : source
          return { contents, resolveDir: path.dirname(args.path), loader: 'js' }
        }
        const contents = read(args.path)
        if (prefixed.has(args.path)) {
          return { contents: prefixed.get(args.path) + (contents ?? fs.readFileSync(args.path, 'utf8')), loader: 'js' }
        }
        if (contents !== null) return { contents, loader: 'js' }
      })
    },
  }
}

async function build(contents, { replace, prepend, sourceRoot }) {
  const replaced = replacements(replace)
  const prefixed = prefixes(prepend, replaced)
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
      metafile: replaced.size + prefixed.size > 0,
      plugins: replaced.size || prefixed.size || sourceRoot ? [plugin(replaced, prefixed, sourceRoot)] : [],
    })
    if (replaced.size + prefixed.size) {
      const inputs = new Set(Object.keys(result.metafile.inputs).map(input => path.resolve(root, input)))
      for (const [option, files] of [
        ['replace', replaced],
        ['prepend', prefixed],
      ]) {
        for (const file of files.keys()) {
          if (!inputs.has(file))
            throw new Error(`${option}: ${path.relative(root, file)} is not imported by the bundle`)
        }
      }
    }
    return { dir, url: pathToFileURL(outfile).href }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

export const heldBundles = () => cache.size

export async function buildServer(contents, { replace, prepend, sourceRoot } = {}) {
  const key = JSON.stringify([
    contents,
    Object.entries(replace ?? {}).sort(),
    Object.entries(prepend ?? {}).sort(),
    sourceRoot ?? null,
  ])
  let entry = cache.get(key)
  if (!entry) {
    entry = { refs: 0, dir: null }
    entry.ready = build(contents, { replace, prepend, sourceRoot }).then(
      built => Object.assign(entry, built),
      err => {
        if (cache.get(key) === entry) cache.delete(key)
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
  return { url: entry.url, evaluate: env => evaluate(entry.url, env), destroy: release }
}

export async function bundleServer(contents, options) {
  const built = await buildServer(contents, options)
  try {
    const { module } = await built.evaluate()
    return { module, url: built.url, evaluate: built.evaluate, destroy: built.destroy }
  } catch (err) {
    built.destroy()
    throw err
  }
}

// one evaluation at a time, process-wide: each sets process.env for its own import only
let queue = Promise.resolve()
function serially(task) {
  const run = queue.then(task)
  queue = run.catch(() => {})
  return run
}

const setEnv = (name, value) => {
  if (value === undefined || value === null) delete process.env[name]
  else process.env[name] = String(value)
}

function evaluate(url, env = {}) {
  return serially(async () => {
    const names = Object.keys(env).sort()
    const values = names.map(name => [name, env[name] === undefined || env[name] === null ? null : String(env[name])])
    const at = names.length
      ? `${url}?env=${createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16)}`
      : url
    const saved = names.map(name => [name, Object.hasOwn(process.env, name) ? process.env[name] : undefined])
    try {
      for (const [name, value] of values) setEnv(name, value)
      return { module: await import(at), url: at }
    } finally {
      for (const [name, value] of saved) setEnv(name, value)
    }
  })
}
