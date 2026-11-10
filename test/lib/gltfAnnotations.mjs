// Reads a source file's syntax tree (acorn, already installed as ESLint's parser) and finds the operations that are
// not answered for by a marker of their own (see test/gltfLoaderAnnotations.test.js, which runs it on the vendored
// GLTFLoader).
//
// Operations: every `new` (except one thrown), every spread, every loop statement, and every call of a method that
// allocates, copies, iterates or moves objects in the scene graph (CALLS below, `X.method.call(...)` included).
// Markers: COO_BUDGET, COO_WORK, COO_ITERATE, COO_OPTIONAL_DRACO, COO_SPARSE, COO_REVOKE, or `COO_EXEMPT: <reason>`,
// in a comment. A comment belongs to one statement: a comment after code, to the statement starting on its line (or,
// on a continuation line, the statement it is in); a comment on lines of its own, to the statement just after it.
// Statements starting on one line count as one (a one-line `if` and its body). Each statement needs at least as
// many marker words as it has operations: one marker covers one operation.
//
// What it cannot see: cost inside the functions the file calls (three.js, three-vrm), other than the calls listed.

import { parse } from 'acorn'

const MARKER = /\bCOO_(?:BUDGET|WORK|ITERATE|OPTIONAL_DRACO|SPARSE|REVOKE)\b|\bCOO_EXEMPT:\s*\S/g
// methods that allocate, copy, go through a list or a subtree, or move objects in the scene graph
const CALLS = new Set([
  'slice',
  'clone',
  'concat',
  'copy',
  'map',
  'filter',
  'flatMap',
  'fill',
  'splice',
  'sort',
  'reverse',
  'forEach',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'indexOf',
  'lastIndexOf',
  'includes',
  'keys',
  'values',
  'entries',
  'assign',
  'from',
  'of',
  'decode',
  'traverse',
  'traverseVisible',
  'traverseAncestors',
  'add',
  'remove',
  'clear',
  'attach',
  'createObjectURL',
  'construct',
  'normalizeSkinWeights',
  'updateMorphTargets',
  'updateMatrixWorld',
  'toTrianglesDrawMode',
])
const JSON_CALLS = new Set(['parse', 'stringify'])
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'])
const isStatement = node =>
  node && /(Statement|Declaration)$/.test(node.type) && node.type !== 'BlockStatement' && node.type !== 'EmptyStatement'

// the name of what a call calls (for `a.b.call(...)` and `a.b.apply(...)`, `b`)
function calledName(callee) {
  if (callee.type === 'Identifier') return { name: callee.name }
  if (callee.type !== 'MemberExpression' || callee.computed) return null
  const name = callee.property.name
  if ((name === 'call' || name === 'apply') && callee.object.type === 'MemberExpression' && !callee.object.computed) {
    return { name: callee.object.property.name, object: callee.object.object }
  }
  return { name, object: callee.object }
}

function operationOf(node, parent) {
  if (node.type === 'NewExpression') return parent?.type === 'ThrowStatement' ? null : 'new'
  if (node.type === 'SpreadElement') return 'spread'
  if (LOOPS.has(node.type)) return 'loop'
  if (node.type === 'CallExpression') {
    const called = calledName(node.callee)
    if (!called) return null
    if (called.name === 'Array' || called.name === 'structuredClone') return `${called.name}()`
    if (called.object?.type === 'Identifier' && called.object.name === 'JSON' && JSON_CALLS.has(called.name)) {
      return `JSON.${called.name}`
    }
    if (called.object && CALLS.has(called.name)) return `.${called.name}()`
  }
  return null
}

// the code of a line, for messages
const lineText = (lines, line) => lines[line - 1].trim().slice(0, 100)

export function unmarkedOperations(source) {
  const comments = []
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, onComment: comments })
  const lines = source.split('\n')
  const statements = [] // in source order, outer before inner
  const operations = [] // { kind, line, statement }
  const visit = (node, parent, statement) => {
    if (isStatement(node)) {
      statements.push(node)
      statement = node
    }
    const kind = operationOf(node, parent)
    if (kind) operations.push({ kind, line: node.loc.start.line, statement })
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') visit(child, node, statement)
      } else if (value && typeof value.type === 'string') {
        visit(value, node, statement)
      }
    }
  }
  visit(ast, null, null)
  // the statement each line's operations and markers count against: the outermost starting on that line
  const startingAt = new Map()
  for (const statement of statements) {
    if (!startingAt.has(statement.loc.start.line)) startingAt.set(statement.loc.start.line, statement)
  }
  const keyOf = statement => startingAt.get(statement.loc.start.line)
  // for a comment after code on a continuation line: the innermost statement it is in, or that ends on its line
  const innermostAt = (offset, line) => {
    let found = null
    for (const statement of statements) {
      if (statement.start <= offset && (offset < statement.end || statement.loc.end.line === line)) found = statement
    }
    return found
  }
  const markers = new Map()
  const bare = []
  for (const comment of comments) {
    if (/\bCOO_EXEMPT\b(?!:\s*\S)/.test(comment.value))
      bare.push(`line ${comment.loc.start.line}: COO_EXEMPT without a reason`)
    const count = (comment.value.match(MARKER) || []).length
    if (count === 0) continue
    const line = comment.loc.start.line
    const before = lines[line - 1].slice(0, comment.loc.start.column)
    let statement
    if (before.trim() !== '') {
      statement = startingAt.get(line) || innermostAt(comment.start, line)
    } else {
      const next = statements.find(s => s.start > comment.end)
      if (next && next.loc.start.line <= comment.loc.end.line + 2) statement = next
    }
    if (!statement) continue
    const key = keyOf(statement)
    markers.set(key, (markers.get(key) || 0) + count)
  }
  const needed = new Map()
  for (const operation of operations) {
    if (!operation.statement) continue
    const key = keyOf(operation.statement)
    if (!needed.has(key)) needed.set(key, [])
    needed.get(key).push(operation)
  }
  const sites = [...bare]
  for (const [statement, ops] of needed) {
    const have = markers.get(statement) || 0
    if (ops.length <= have) continue
    const kinds = ops.map(op => `${op.kind} (line ${op.line})`).join(', ')
    sites.push(
      `line ${statement.loc.start.line}: ${ops.length} operations, ${have} markers: ${kinds}: ${lineText(lines, statement.loc.start.line)}`
    )
  }
  return sites
}
