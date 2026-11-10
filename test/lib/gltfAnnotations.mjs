// Finds the lines of a source file shaped like an allocation, a copy or a loop with no marker on them or within
// WINDOW lines above (see test/gltfLoaderAnnotations.test.js, which runs it on the vendored GLTFLoader).

export const WINDOW = 3

const SHAPES = [
  ['a typed array or ArrayBuffer', /\bnew\s+(?:\w*Array\w*|ArrayBuffer|DataView)\s*\(/],
  ['an object constructed', /\bnew\s+(?!Error\s*\()[A-Za-z_$][\w$]*\s*\(/],
  ['a copy', /\.(?:slice|clone|concat|copy|copy\.call)\s*\(|\bObject\.assign\s*\(|\.\.\.\s*[\w$[(]/],
  ['an array made', /(?<![\w$.])Array\s*\(|\bArray\.from\s*\(/],
  ['a Blob or object URL', /\bBlob\b|\bcreateObjectURL\b/],
  ['a loop', /\bfor\s*\(|\bwhile\s*\(|\bdo\s*\{/],
  [
    'an iteration',
    /\.(?:forEach|map|filter|reduce|some|every|find|findIndex|flatMap|traverse\w*)\s*\(|\bObject\.(?:keys|values|entries)\s*\(/,
  ],
]
const MARKER = /\bCOO_(?:BUDGET|WORK|ITERATE|OPTIONAL_DRACO|SPARSE|REVOKE)\b|\bCOO_EXEMPT:\s*\S/

// each line split into its code and its comment text (what is inside a string is neither)
export function splitLines(source) {
  const out = []
  let inBlock = false
  for (const line of source.split('\n')) {
    let code = ''
    let comment = ''
    let quote = null
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (inBlock) {
        if (char === '*' && line[i + 1] === '/') {
          inBlock = false
          i++
        } else {
          comment += char
        }
      } else if (quote) {
        // a string's text is neither code nor comment
        if (char === '\\') i++
        else if (char === quote) {
          quote = null
          code += char
        }
      } else if (char === '/' && line[i + 1] === '/') {
        comment += line.slice(i + 2)
        break
      } else if (char === '/' && line[i + 1] === '*') {
        inBlock = true
        i++
      } else {
        if (char === "'" || char === '"' || char === '`') quote = char
        code += char
      }
    }
    out.push({ code, comment })
  }
  return out
}

// the lines shaped like an allocation, copy or loop with no marker on them or within WINDOW lines above
export function unmarkedSites(source) {
  const lines = splitLines(source)
  const sites = []
  lines.forEach(({ code }, i) => {
    const shapes = SHAPES.filter(([, pattern]) => pattern.test(code)).map(([name]) => name)
    if (shapes.length === 0) return
    for (let k = Math.max(0, i - WINDOW); k <= i; k++) if (MARKER.test(lines[k].comment)) return
    sites.push(`line ${i + 1} (${shapes.join(', ')}): ${code.trim().slice(0, 100)}`)
  })
  return sites
}
