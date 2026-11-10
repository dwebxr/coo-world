/* eslint-disable no-console -- a command-line tool: its output is the point */
// Lists which model, avatar and emote files the loaders' limits (src/core/extras/gltfLimits.js) would refuse.
//
//   node scripts/check-models.mjs [file or directory ...]        (default: ./world/assets)
//   npm run models:check -- /path/to/world/assets
//
// Run it against an existing world's assets before deploying a version that enforces the limits: a file refused
// here fails to load in every client and on the server, with the reason shown. Each .glb, .gltf and .vrm is taken
// through the same steps as a client: the check before parsing, then the parse charged to a budget, with the VRM
// plugin registered. Nothing is drawn and no image is decoded (their sizes are read from the file headers, as the
// client reads them); the renderer's texture size is unknown here, so morph targets are charged at their largest.
// Files are only read. Exit status 1 when a file is refused or cannot be read.
import fs from 'node:fs'
import path from 'node:path'

import { VRMLoaderPlugin } from '@pixiv/three-vrm'

import { GLTFLoader } from '../src/core/libs/gltfloader/GLTFLoader.js'
import { checkGLTF, createGLTFBudget, GLTF_LIMITS } from '../src/core/extras/gltfLimits.js'

const MODEL = /\.(glb|gltf|vrm)$/i

// what the parser expects of a browser; images are never decoded here
globalThis.self ??= globalThis
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })
const warn = console.warn
console.warn = () => {} // the parser's and the plugin's notes about what a headless run lacks
const unhandled = []
process.on('unhandledRejection', reason => unhandled.push(String(reason?.message ?? reason)))

function collect(target, out) {
  const stat = fs.statSync(target)
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target).sort()) {
      const file = path.join(target, name)
      if (fs.statSync(file).isFile() && MODEL.test(name)) out.push(file)
    }
  } else if (stat.isFile()) out.push(target)
  return out
}

const percent = (used, limit) => `${((100 * used) / limit).toFixed(1)}%`

async function check(file) {
  const bytes = fs.readFileSync(file)
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const budget = createGLTFBudget({ fileBytes: data.byteLength })
  checkGLTF(data, GLTF_LIMITS, budget)
  const loader = new GLTFLoader()
  loader.register(parser => new VRMLoaderPlugin(parser))
  await loader.parseAsync(data, '', budget)
  return {
    megabytes: (data.byteLength / 1e6).toFixed(1),
    bytes: percent(budget.used.bytes, budget.maxBytes),
    work: percent(budget.used.work, budget.maxWork),
  }
}

const targets = process.argv.slice(2)
if (!targets.length) targets.push(path.join('world', 'assets'))
const files = []
let failed = 0
for (const target of targets) {
  try {
    collect(target, files)
  } catch (err) {
    console.error(`cannot read ${target}: ${err.message}`)
    failed++
  }
}
for (const file of files) {
  try {
    const used = await check(file)
    console.log(
      `ok       ${file}  (${used.megabytes} MB; ${used.bytes} of the byte limit, ${used.work} of the work limit)`
    )
  } catch (err) {
    failed++
    console.log(`REFUSED  ${file}  ${err?.message ?? err}`)
  }
}
console.warn = warn
console.log(`${files.length} file${files.length === 1 ? '' : 's'} checked, ${failed} refused or unreadable`)
if (unhandled.length)
  console.log(
    `(${unhandled.length} late errors from refused files: ${[...new Set(unhandled)].slice(0, 3).join(' | ')})`
  )
process.exit(failed ? 1 : 0)
