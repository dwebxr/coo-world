// Which environment variable names the source reads, found by reading the code (sourceScan.mjs: comments are out,
// strings are double-quoted, no white space). The shapes that are seen:
//
//   process.env.NAME   process?.env?.NAME   env.NAME   globalThis.env?.NAME     a read by name
//   env["NAME"]                                                                  a read by a quoted name
//   const { NAME, OTHER: alias, THIRD = 1 } = process.env                        destructuring
//   env[`STEM_${id}`]                                                            a templated name -> the stem `STEM_`
//   env[key]                                                                     a computed read (below)
//
// A computed read says nothing about which names it reads. They are taken from the file it stands in: every string
// that is an upper-case name with an underscore ("UPLOAD_MIN_FREE_MB"), every object key of that form
// (`{ WS_MAX_SOCKETS: 64 }`, the tables of defaults) and every template that begins with one
// (`WS_CONNECT_BURST_${suffix}` -> a stem). That finds the names of the readers there are (uploadLimits.js,
// connectionLimits.js, aiBudget.js, Storage.js, the length check in index.js, the client's resolveEnv), and may
// take a string for a name that is none: such a string is listed in NOT_NAMES with the file it is in.
//
// What is not seen: a name handed to a reader from another file, a name put together from parts, and a read through
// another name for the environment (`const e = process.env; e.NAME`). A computed read in a file where no name is
// found is reported, so that case at least does not pass unnoticed.
import { codeOf, sourceFiles, stripComments } from './sourceScan.mjs'

const MEMBER = /\benv\??\.([A-Z][A-Z0-9_]*)\b/g
const QUOTED = /\benv\??\.?\["([A-Za-z_][A-Za-z0-9_]*)"\]/g
const DESTRUCTURED = /(?:const|let|var)\{([^{}]*)\}=(?:process\??\.)?env\b/g
const TEMPLATED = /\benv\??\.?\[`([A-Z][A-Z0-9_]*_)\$\{/g
const COMPUTED = /\benv\??\.?\[(?!["`])/g
const NAME = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+'
const FED_STRING = new RegExp(`"(${NAME})"`, 'g')
const FED_KEY = new RegExp(`[{,](${NAME}):`, 'g')
const FED_STEM = /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_)\$\{/g

// strings in a file with a computed read that have the form of a name and are not variables: [file, string]
export const NOT_NAMES = []

// -> { names, stems, computed, fed }: the names read, the stems of templated names, how many computed reads there
//    are, and how many names and stems the file gave for them
export function scanEnvCode(code, { file = '' } = {}) {
  const names = new Set()
  const stems = new Set()
  for (const match of code.matchAll(MEMBER)) names.add(match[1])
  for (const match of code.matchAll(QUOTED)) names.add(match[1])
  for (const match of code.matchAll(DESTRUCTURED)) {
    for (const item of match[1].split(',')) {
      const name = /^\s*([A-Za-z_$][\w$]*)/.exec(item)?.[1]
      if (name) names.add(name)
    }
  }
  for (const match of code.matchAll(TEMPLATED)) stems.add(match[1])
  const computed = [...code.matchAll(COMPUTED)].length
  let fed = 0
  if (computed) {
    const skip = new Set(NOT_NAMES.filter(([where]) => where === file).map(([, text]) => text))
    for (const pattern of [FED_STRING, FED_KEY]) {
      for (const match of code.matchAll(pattern)) {
        if (skip.has(match[1])) continue
        names.add(match[1])
        fed++
      }
    }
    for (const match of code.matchAll(FED_STEM)) {
      stems.add(match[1])
      fed++
    }
  }
  return { names, stems, computed, fed }
}

export const scanEnvText = (text, options) => scanEnvCode(stripComments(text), options)

// The whole source -> { names: Map(name -> files), stems: Map(stem -> files), blind: files }. `blind`: files with a
// computed read and no name to go with it. `read`: a file's code without comments (tests give their own files).
export function scanEnvSource(files = sourceFiles(), read = codeOf) {
  const names = new Map()
  const stems = new Map()
  const blind = []
  const add = (map, key, file) => map.set(key, [...(map.get(key) ?? []), file])
  for (const file of files) {
    const found = scanEnvCode(read(file), { file })
    for (const name of found.names) add(names, name, file)
    for (const stem of found.stems) add(stems, stem, file)
    if (found.computed && !found.fed) blind.push(file)
  }
  return { names, stems, blind }
}
