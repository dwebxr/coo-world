// Reads a source file's syntax tree (acorn, already installed as ESLint's parser) and finds the operations that are
// not answered for by a marker of their own (see test/gltfLoaderAnnotations.test.js, which runs it on the vendored
// GLTFLoader).
//
// Operations: every `new` (except one thrown), every spread, every loop statement, every call, and every function
// that calls itself. A call needs no marker only when its callee is on the allow-list below (each entry with its
// reason) or is a function of the file itself called on the file's own objects (its cost is in its body, which is
// checked here too). Markers: a comment, or a `;`-separated part of one, that starts with COO_BUDGET, COO_WORK,
// COO_ITERATE, COO_OPTIONAL_DRACO, COO_SPARSE, COO_REVOKE, or `COO_EXEMPT: <reason>` (a marker word inside prose
// is not one). A comment belongs to one statement: a comment after code, to the statement starting on its line
// (or, on a continuation line, the statement it is in); a comment on lines of its own, to the statement just after
// it. Statements starting on one line count as one (a one-line `if` and its body). Each statement needs at least as
// many markers as it has operations: one marker covers one operation. A function calling itself needs one more on
// its own statement, for what bounds its depth.
//
// What it cannot see: cost inside the functions the file calls in libraries (three.js, three-vrm); those calls need
// a marker, but the marker is a claim, not a proof.

import { parse } from 'acorn'

const MARKER = /^(?:COO_(?:BUDGET|WORK|ITERATE|OPTIONAL_DRACO|SPARSE|REVOKE)\b|COO_EXEMPT:\s*\S)/

// callees that need no marker: cheap, allocating nothing that grows with the document, iterating nothing
export const ALLOWED = {
  // Math.*, Number.*, Array.isArray: arithmetic and type tests on one value
  receivers: {
    Math: 'arithmetic on numbers',
    MathUtils: 'arithmetic on numbers',
    Number: 'tests and conversions of one number',
  },
  // functions the file is handed: settling its own promise, and handing the result (or the error) to its caller
  identifiers: {
    resolve: 'settles a promise',
    reject: 'settles a promise',
    onLoad: "hands the result to the loader's caller",
    onError: "hands the error to the loader's caller",
  },
  qualified: {
    'Array.isArray': 'a type test',
    'Object.prototype.hasOwnProperty.call': 'one property look-up',
    'Promise.resolve': 'wraps one value',
    'Promise.reject': 'wraps one error',
    'Promise.all': "gathers the promises the file's (marked) loops made",
    'console.warn': 'logging',
    'console.error': 'logging',
    'console.log': 'logging',
  },
  methods: {
    // promise plumbing
    then: 'a promise continuation',
    catch: 'a promise continuation',
    finally: 'a promise continuation',
    // the budget's own charges (and its first refusal)
    bytes: 'a charge (the budget)',
    count: 'a charge (the budget)',
    work: 'a charge (the budget)',
    jsonCopy: 'a charge (the budget): a JSON copy, at what it holds',
    image: 'a charge (the budget): reads an image header',
    imageURI: 'a charge (the budget): measures a data: URI image',
    refuse: 'a refusal (the budget)',
    // one entry of a Map, a Set or a cache
    get: 'one look-up',
    has: 'one look-up',
    delete: 'one entry',
    // three.js math on one vector, quaternion, colour, matrix or box: constant work
    setX: 'one component',
    setY: 'one component',
    setZ: 'one component',
    setW: 'one component',
    setRGB: 'three components',
    fromArray: 'at most 16 numbers',
    toArray: 'at most 16 numbers',
    fromBufferAttribute: 'one element',
    compose: 'one matrix',
    multiplyScalar: 'one vector',
    max: 'one vector, or numbers',
    expandByVector: 'one box',
    getCenter: 'one box',
    distanceTo: 'one vector',
    normalize: 'one quaternion',
    getUint32: 'four bytes',
    // one object's setter, look-up or release in three.js or the DOM
    setAttribute: 'one attribute set on a geometry',
    setMatrixAt: 'one instance matrix',
    updateMatrix: "one object's matrix",
    getHandler: "the manager's few handlers",
    revokeObjectURL: 'releases one URL',
    startsWith: 'a prefix test',
    getValueSize: 'a division',
    // a loader's options and the loading manager's counters
    setPath: 'a loader option',
    setResponseType: 'a loader option',
    setRequestHeader: 'a loader option',
    setWithCredentials: 'a loader option',
    setCrossOrigin: 'a loader option',
    itemStart: "the loading manager's counter",
    itemEnd: "the loading manager's counter",
    itemError: "the loading manager's counter",
    // the last element taken (no shift), or one pushed (a call with one argument and no spread; checked below)
    pop: 'the last element',
    push: 'one element',
  },
  // the file's own functions that need no marker where they are called, each charging what it does itself, every
  // time (its body is checked here). Not on the list, so marked where called: assignExtrasToUserData and
  // updateMorphTargets (they charge only when handed the budget), addUnknownExtensionsToUserData, createPrimitiveKey
  // and createAttributesKey (they go through a definition's entries)
  own: {
    getDependency: 'a dependency, started once and cached: its loader is checked, and charges per load',
    getDependencies: 'every entry of a type, once (cached), charged as it starts',
    _startDependency: "dispatches to a loader of this file's or a plugin hook (each marked)",
    _invokeOne: 'a hook of each registered plugin: each call marked',
    _invokeAll: 'a hook of each registered plugin: each call marked',
    loadScene: 'a loader of this file, charging per load',
    loadNode: 'a loader of this file, charging per load',
    _loadNodeShallow: 'a loader of this file, cached, charging per load',
    loadMesh: 'a loader of this file, charging per load',
    loadGeometries: 'a loader of this file, charging per geometry',
    loadAccessor: 'a loader of this file, charging per load',
    loadBuffer: 'a loader of this file, charging per load',
    loadBufferView: 'a loader of this file, charging per load',
    loadSkin: 'a loader of this file, charging per load',
    loadCamera: 'a loader of this file, charging per load',
    loadAnimation: 'a loader of this file, charging per load',
    loadMaterial: 'a loader of this file, charging per load',
    loadTexture: 'a loader of this file, charging per load',
    loadTextureImage: 'a loader of this file, cached by source and sampler, charging per texture',
    loadImageSource: 'a loader of this file, cached by source, charging per decode',
    _loadLight: 'a loader of this file, cached, charging per light',
    createNodeMesh: "a node's mesh, by getDependency",
    createNodeAttachment: "a node's light, by its loader",
    assignTexture: 'one texture slot: a dependency, and the clones it makes charged inside',
    assignFinalMaterial: 'the variants of one material, cached and charged inside',
    _getNodeRef: 'a further use of a mesh, camera or light: the clone charged inside',
    _createAnimationTracks: 'the tracks of one channel, each charged inside',
    _getArrayFromAccessor: 'its copy charged inside',
    _createCubicSplineTrackInterpolant: 'sets one factory',
    _markDefs: 'marks the definitions, charged inside',
    _addNodeRef: 'one counter',
    addPrimitiveAttributes: "one geometry's attributes, charged inside",
    addMorphTargets: "one geometry's targets, charged inside",
    computeBounds: "one geometry's bounds, its targets charged inside",
    startGeometry: 'one geometry, charged inside',
    createDracoPrimitive: 'needs a decoder this client does not have',
    assignAttributeAccessor: 'one attribute, by getDependency',
    createDefaultMaterial: 'one material, cached',
    reduceAssociations: 'its walk charged inside, a step per object',
    createUniqueName: 'one name (its sanitising marked inside)',
    getImageURIMimeType: "one URI's type (its searches marked inside)",
    getNormalizedComponentScale: 'a constant per component type',
    detectSupport: 'once per parser',
    arrayOf: 'a type test',
    guarded: 'starts one dependency (its operations checked), catching a refusal',
    refuseDocument: 'a refusal',
    revokeObjectURL: 'releases one URL',
    chargeUserData: 'a charge',
    chargeMaterialClone: 'a charge (the uniforms of one material: a fixed set)',
    chargeClone: 'a charge (its walk charged per object)',
    placeWork: 'a charge',
    accessorWork: 'computes a charge: one look-up',
    primitiveWork: "computes a charge: the primitive's entries",
    serializedBytes: 'measures what a copy costs (its stringify marked inside)',
    morphTextureBytes: 'computes a charge: arithmetic',
    padded: 'arithmetic',
    conversionBytes: "computes a charge: one geometry's attributes",
    add: "conversionBytes's: one attribute's size",
    register: 'one plugin callback',
    setExtensions: 'one option',
    setPlugins: 'one option',
    _onError: "hands the error to the caller's callback",
    parse: 'the entry of a parse (once per load)',
    parseAsync: 'the entry of a parse (once per load)',
    interpolate_: "the cubic spline's interpolation (a loop over the sample size, marked inside)",
    updateMappings: "a clone's associations (its recursion marked)",
  },
}

const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'])
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const isStatement = node =>
  node &&
  ((/(Statement|Declaration)$/.test(node.type) && node.type !== 'BlockStatement' && node.type !== 'EmptyStatement') ||
    node.type === 'MethodDefinition')
// the receivers that are the file's own objects (the loader, the parser, an extension of the file)
const OWN = new Set(['this', 'parser', 'scope', 'self', 'this.parser'])

// a member chain as text (`a.b.c`), or null when it is not one
function chain(node) {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type === 'MemberExpression' && !node.computed) {
    const object = chain(node.object)
    return object === null ? null : `${object}.${node.property.name}`
  }
  return null
}

export function unmarkedOperations(source) {
  const comments = []
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, onComment: comments })
  const lines = source.split('\n')

  // the file's own functions: declarations, methods, and functions assigned to a name
  const own = new Set()
  const collect = node => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'FunctionDeclaration' && node.id) own.add(node.id.name)
    if (node.type === 'MethodDefinition' && !node.computed) own.add(node.key.name)
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && FUNCTIONS.has(node.init?.type)) {
      own.add(node.id.name)
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue
      const value = node[key]
      if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value.type === 'string') collect(value)
    }
  }
  collect(ast)

  // what a call needs: null when allowed, else the kind of operation
  const callNeeds = call => {
    const callee = call.callee
    // the base class's constructor, or a method of the file's own class through super
    if (callee.type === 'Super') return null
    if (callee.type === 'MemberExpression' && callee.object.type === 'Super' && !callee.computed) {
      return own.has(callee.property.name) && Object.hasOwn(ALLOWED.own, callee.property.name)
        ? null
        : `super.${callee.property.name}()`
    }
    if (callee.type === 'Identifier') {
      if (callee.name === 'Array' || callee.name === 'structuredClone') return `${callee.name}()`
      if (own.has(callee.name) && Object.hasOwn(ALLOWED.own, callee.name)) return null // its body is checked
      if (Object.hasOwn(ALLOWED.identifiers, callee.name)) return null
      return `${callee.name}()`
    }
    const text = chain(callee)
    // a method of something that is not a plain chain (`extensions[ name ].method()`): its name, on no own object
    if (text === null && callee.type === 'MemberExpression' && !callee.computed) {
      const method = callee.property.name
      if (method === 'push') {
        return call.arguments.length === 1 && call.arguments[0].type !== 'SpreadElement' ? null : '.push(...)'
      }
      return Object.hasOwn(ALLOWED.methods, method) ? null : `.${method}()`
    }
    if (text !== null) {
      if (Object.hasOwn(ALLOWED.qualified, text)) return null
      const parts = text.split('.')
      if (parts.length === 2 && Object.hasOwn(ALLOWED.receivers, parts[0])) return null
      const method = parts.at(-1)
      // this.method(), parser.method(), this.parser.method(): the file's own objects
      if (OWN.has(parts.slice(0, -1).join('.')) && own.has(method) && Object.hasOwn(ALLOWED.own, method)) return null
      if (method === 'push') {
        return call.arguments.length === 1 && call.arguments[0].type !== 'SpreadElement' ? null : '.push(...)'
      }
      if (Object.hasOwn(ALLOWED.methods, method)) return null
      return `.${method}()`
    }
    return 'a computed call'
  }

  const statements = [] // in source order, outer before inner
  const operations = [] // { kind, line, statement }
  const visit = (node, parent, statement, fn) => {
    if (isStatement(node)) {
      statements.push(node)
      statement = node
    }
    // a function and the statement that names it (for its recursion marker)
    if (FUNCTIONS.has(node.type) || node.type === 'MethodDefinition') {
      let name = null
      if (node.type === 'FunctionDeclaration' && node.id) name = node.id.name
      if (node.type === 'MethodDefinition' && !node.computed) name = node.key.name
      if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') name = parent.id.name
      if (name !== null) fn = { name, statement, method: node.type === 'MethodDefinition', recursive: false }
    }
    let kind = null
    if (node.type === 'NewExpression') kind = parent?.type === 'ThrowStatement' ? null : 'new'
    else if (node.type === 'SpreadElement') kind = 'spread'
    else if (LOOPS.has(node.type)) kind = 'loop'
    else if (node.type === 'CallExpression') kind = callNeeds(node)
    if (kind) operations.push({ kind, line: node.loc.start.line, statement })
    // a call of the function it is in: recursion, answered for on the function's own statement
    if (node.type === 'CallExpression' && fn && !fn.recursive) {
      const text = chain(node.callee)
      const self = fn.method ? text === `this.${fn.name}` : text === fn.name
      if (self) {
        fn.recursive = true
        operations.push({ kind: `recursion of ${fn.name}`, line: fn.statement.loc.start.line, statement: fn.statement })
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') visit(child, node, statement, fn)
      } else if (value && typeof value.type === 'string') {
        visit(value, node, statement, fn)
      }
    }
  }
  visit(ast, null, null, null)

  // the statement each line's operations and markers count against: the outermost starting on that line
  const startingAt = new Map()
  for (const statement of statements) {
    if (!startingAt.has(statement.loc.start.line)) startingAt.set(statement.loc.start.line, statement)
  }
  const keyOf = statement => startingAt.get(statement.loc.start.line)
  // for a comment after code on a continuation line: the innermost statement it is in, or that ends on its line
  // (a call or declaration spanning lines; not a loop, `if` or function closing its block there: a marker after a
  // closing brace is no one's)
  const BLOCKED =
    /^(For|ForIn|ForOf|While|DoWhile|If|Try|Switch|Labeled)Statement$|^(Function|Class)Declaration$|^MethodDefinition$/
  const innermostAt = (offset, line) => {
    let found = null
    for (const statement of statements) {
      const ends = statement.loc.end.line === line && !BLOCKED.test(statement.type)
      if (statement.start <= offset && (offset < statement.end || ends)) found = statement
    }
    return found
  }
  const markers = new Map()
  const bare = []
  for (const comment of comments) {
    const parts = comment.value.split(';').map(part => part.trim())
    for (const part of parts) {
      if (/^COO_EXEMPT\b(?!:\s*\S)/.test(part)) bare.push(`line ${comment.loc.start.line}: COO_EXEMPT without a reason`)
    }
    const count = parts.filter(part => MARKER.test(part)).length
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
    const text = lines[statement.loc.start.line - 1].trim().slice(0, 100)
    sites.push(`line ${statement.loc.start.line}: ${ops.length} operations, ${have} markers: ${kinds}: ${text}`)
  }
  return sites
}
