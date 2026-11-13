// The repository's own source, as tests that read it for names need it: which files there are, each file's code
// without its comments, and which of them end up in a bundle a browser loads.
//
// Comments are taken out by esbuild (a parse, not a pattern). It prints the code without white space, writes every
// string with double quotes, and leaves names, property reads and template literals as they were written:
// `process.env.NAME`, `process?.env.NAME` and `env[\`STEM_${id}\`]` come out as they went in. What a scan of this code
// finds is what the code says, not what it does at run time: a name put together from parts, or handed in from
// another file, is not seen. The tests that use this say which shapes they look for.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))

// not this project's code: files a build puts beside the pages, vendored libraries, the generated PhysX binding
const NOT_SOURCE = [/^src\/client\/public\//, /^src\/core\/libs\//, /^src\/core\/physx-js-webidl\.js$/, /^src\/world\//]

function walk(dir, out) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(file, out)
    else if (/\.(js|mjs)$/.test(entry.name) && !NOT_SOURCE.some(pattern => pattern.test(file))) out.push(file)
  }
  return out
}

// every file of the server, the client, the shared core, the node client, the scripts and the agent (paths relative
// to the repository, with forward slashes)
export function sourceFiles() {
  return [...walk('src', []), ...walk('scripts', []), 'agent.mjs'].sort()
}

const codes = new Map()

// a file's code without comments (see the top)
export function codeOf(file) {
  if (!codes.has(file)) codes.set(file, stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'), file))
  return codes.get(file)
}

export function stripComments(text, name = 'snippet.js') {
  // (without `minifyWhitespace` a comment inside an expression is kept)
  return esbuild.transformSync(text, {
    loader: 'jsx',
    jsx: 'preserve',
    legalComments: 'none',
    minifyWhitespace: true,
    sourcefile: name,
  }).code
}

// The entry points of everything that is built for a browser: the page and its particles worker (scripts/build.mjs),
// the client library (build-client.mjs) and the viewer (build-viewer.mjs).
export const BROWSER_ENTRIES = [
  'src/client/index.js',
  'src/client/particles.js',
  'src/client/world-client.js',
  'src/core/createViewerWorld.js',
]

let inputs = null

// The project's files that those entry points pull in, through static and dynamic imports alike: esbuild's own list
// of what it read to bundle them (packages are left out of the bundle here, so the list is this project's files).
export async function browserInputs() {
  if (inputs) return inputs
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: BROWSER_ENTRIES,
    outdir: 'unused',
    write: false,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    packages: 'external',
    metafile: true,
    jsx: 'automatic',
    jsxImportSource: '@firebolt-dev/jsx',
    loader: { '.js': 'jsx' },
    logLevel: 'silent',
  })
  inputs = Object.keys(result.metafile.inputs)
    .filter(file => /\.(js|mjs)$/.test(file) && !NOT_SOURCE.some(pattern => pattern.test(file)))
    .sort()
  return inputs
}
