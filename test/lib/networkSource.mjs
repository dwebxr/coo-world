// The network's own source, for the tests that read it as text on purpose (the tripwires of imageCheck.test.js and
// serverWrites.test.js): which files are the network's, and where a function is written in them, found by parsing
// (@babel/parser), not by a line number or by the text of a signature.
//
// The network is the class in src/core/systems/ServerNetwork.js and the modules of src/server/network/ (any depth),
// where parts of the class are to move as functions whose `this` is the network (P16, step 3). The folder is read
// when it exists; it does not yet. `root`: the checkout read, this one by default (the tests of the tripwires give a
// tree of their own, with such a folder).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const NETWORK_CLASS = 'src/core/systems/ServerNetwork.js'
const NETWORK_DIR = 'src/server/network'

const posix = file => file.split(path.sep).join('/')

// the network's files: repository paths, the class first, then the folder's .js files in name order
export function networkFiles(root = ROOT) {
  const files = [NETWORK_CLASS]
  const walk = dir => {
    const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.js')) files.push(file)
    }
  }
  if (fs.existsSync(path.join(root, NETWORK_DIR))) walk(NETWORK_DIR)
  return files
}

// whether `file` (absolute, or relative to the checkout) is one of the network's
export function isNetworkFile(file, root = ROOT) {
  const relative = posix(path.isAbsolute(file) ? path.relative(root, file) : path.normalize(file))
  return relative === NETWORK_CLASS || relative.startsWith(`${NETWORK_DIR}/`)
}

const readSource = (file, root) => fs.readFileSync(path.join(root, file), 'utf8')

const FUNCTION_VALUES = new Set(['FunctionExpression', 'ArrowFunctionExpression'])
const keyName = node => {
  if (node.computed) return null
  if (node.key.type === 'Identifier') return node.key.name
  if (node.key.type === 'StringLiteral') return node.key.value
  return null
}

// The definitions of the function `name` in `source`: a method of a class or of an object literal
// (`async saveDirty() {…}`), a property of either whose value is a function (`save = () => {…}`), a function
// declaration (`export function installShutdown(…)`) or a variable whose value is a function. A name qualified by
// its class (`Storage.write`) is a member of that class only. -> [{ line, text, node, ast, source }]: the line it
// starts on and its text, from its name (or `async`, `function`) to its end; its node in the file's syntax tree, the
// tree and the file's source.
const parsed = new Map()
export function definitionsIn(source, name) {
  const [owner, member] = name.includes('.') ? name.split('.') : [null, name]
  if (!parsed.has(source)) parsed.set(source, parse(source, { sourceType: 'module' }))
  const ast = parsed.get(source)
  const found = []
  // `members`: the name of the class whose body `node` is a member of (null elsewhere)
  const visit = (node, members) => {
    if (!node || typeof node.type !== 'string') return
    let defined = false
    if (node.type === 'ClassMethod' || node.type === 'ObjectMethod') {
      defined = node.kind === 'method' && keyName(node) === member
    } else if (node.type === 'ClassProperty' || node.type === 'ObjectProperty') {
      defined = keyName(node) === member && FUNCTION_VALUES.has(node.value?.type)
    } else if (node.type === 'FunctionDeclaration') {
      defined = node.id?.name === member
    } else if (node.type === 'VariableDeclarator') {
      defined = node.id?.type === 'Identifier' && node.id.name === member && FUNCTION_VALUES.has(node.init?.type)
    }
    if (defined && (!owner || members === owner)) {
      found.push({ line: node.loc.start.line, text: source.slice(node.start, node.end), node, ast, source })
    }
    const className = ['ClassDeclaration', 'ClassExpression'].includes(node.type) ? (node.id?.name ?? null) : null
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments'].includes(key))
        continue
      // a class's name reaches its body's members only
      const inner = node.type === 'ClassBody' ? members : key === 'body' ? className : null
      if (Array.isArray(value)) for (const child of value) visit(child, inner)
      else if (value && typeof value === 'object') visit(value, inner)
    }
  }
  visit(ast.program, null)
  return found
}

// Every definition of `name` in `files` (paths in the checkout `root`; the network's by default), in file order:
// [{ file, line, text, node, ast, source }]. Throws when there is none: a function that is gone, or renamed, is not
// silently skipped. More than one is not an error: a member of the class that hands its call on to a function of a
// module of the folder is a definition too, and every one of them is what that name runs.
export function findFunction(name, files, root = ROOT) {
  files ??= networkFiles(root)
  const found = files.flatMap(file => definitionsIn(readSource(file, root), name).map(at => ({ file, ...at })))
  if (!found.length) throw new Error(`no function ${name} in ${files.join(', ')}`)
  return found
}
