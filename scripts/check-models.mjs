/* eslint-disable no-console -- a command-line tool: its output is the point */
// Lists which model, avatar and emote files the loaders' limits (src/core/extras/gltfLimits.js) refuse.
//
//   node scripts/check-models.mjs [--max-texture-size=<n>] [file or directory ...]     (default: ./world/assets)
//   npm run models:check -- /path/to/world/assets
//
// Run it against an existing world's assets before deploying a version that enforces the limits. Each .glb, .gltf
// and .vrm is taken through the steps of a client: the check before parsing, then the parse charged to a budget,
// with the VRM plugin registered. Nothing is drawn, no image is decoded (their sizes are read from the file
// headers, as a client reads them) and nothing a file names is requested.
//
// What a result means: a file refused by the check before parsing is refused by every client and by the server. A
// file refused during the parse for its "morph target texture" depends on the client: that charge grows with the
// renderer's largest texture size, which is unknown here, so it is charged at its largest; a client with smaller
// textures may accept the file, and the server (which draws nothing) is not charged for it at all. Pass
// --max-texture-size=4096 (a phone) or =16384 (a desktop) to see what such a client would do.
//
// Files are only read. Exit status 1 when a file is refused or something cannot be read.
import fs from 'node:fs'
import path from 'node:path'

import { checkModel } from './lib/checkModels.mjs'

const MODEL = /\.(glb|gltf|vrm)$/i

const options = {}
const targets = []
// a wrong argument is said and nothing is checked: a silently ignored one would check something else than asked
const usage = message => {
  console.error(message)
  process.exit(2) // nothing has been written to stdout yet
}
for (const arg of process.argv.slice(2)) {
  const size = /^--max-texture-size=(.*)$/.exec(arg)
  if (size) {
    const value = Number(size[1])
    if (!/^\d+$/.test(size[1]) || !Number.isSafeInteger(value) || value < 1) {
      usage(`--max-texture-size needs a positive whole number, not "${size[1]}"`)
    }
    options.maxTextureSize = value
  } else if (arg.startsWith('--')) usage(`unknown option ${arg}`)
  else targets.push(arg)
}
if (!targets.length) targets.push(path.join('world', 'assets'))

const warn = console.warn
console.warn = () => {} // the parser's and the plugin's notes about what a run without a browser lacks
const late = []
process.on('unhandledRejection', reason => late.push(String(reason?.message ?? reason)))

let failed = 0
const unreadable = (what, err) => {
  failed++
  console.error(`cannot read ${what}: ${err.message}`)
}

// the model files of a directory (not below it), or the file itself; one entry that cannot be read does not hide
// the others
const files = []
for (const target of targets) {
  let stat
  try {
    stat = fs.statSync(target)
  } catch (err) {
    unreadable(target, err)
    continue
  }
  if (!stat.isDirectory()) {
    files.push(target)
    continue
  }
  let names
  try {
    names = fs.readdirSync(target)
  } catch (err) {
    unreadable(target, err)
    continue
  }
  for (const name of names.filter(name => MODEL.test(name)).sort()) {
    const file = path.join(target, name)
    try {
      if (fs.statSync(file).isFile()) files.push(file)
    } catch (err) {
      unreadable(file, err)
    }
  }
}

const percent = share => `${(100 * share).toFixed(1)}%`
let refused = 0
for (const file of files) {
  let data
  try {
    const bytes = fs.readFileSync(file)
    data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  } catch (err) {
    unreadable(file, err)
    continue
  }
  try {
    const used = await checkModel(data, options)
    const megabytes = (used.fileBytes / 1e6).toFixed(1)
    console.log(
      `ok       ${file}  (${megabytes} MB; ${percent(used.bytes)} of the byte limit, ${percent(used.work)} of the work limit)`
    )
  } catch (err) {
    refused++
    console.log(`REFUSED  ${file}  ${err?.message ?? err}`)
  }
}
console.warn = warn
const plural = files.length === 1 ? '' : 's'
console.log(`${files.length} file${plural} checked, ${refused} refused, ${failed} unreadable`)
if (late.length)
  console.log(`(${late.length} late errors from refused files: ${[...new Set(late)].slice(0, 3).join(' | ')})`)
// not process.exit(): output still on its way to a pipe would be cut off (a long report read slowly lost its end)
process.exitCode = refused || failed ? 1 : 0
