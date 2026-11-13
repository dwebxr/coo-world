// A TRIPWIRE ON THE SOURCE (parsed with @babel/parser): nothing of the server writes to a transport but the write
// ledger (writeLedger.js), through the network's write. It reads every file of src/server with its subfolders (the
// network's modules of src/server/network/ among them), core/Socket.js and the Server*/Apps systems, and fails on:
// - a `send` or `ping` called on anything but the receivers allowed below: `x.send(…)`, `x?.send(…)`,
//   `x['send'](…)`, `` x[`send`](…) `` (a computed key that is a string, or a template without substitutions);
// - a `send` or `ping` member referred to without being called there, whatever its object (`x.send.bind(x)`,
//   `x.send.call(x, …)`, `const s = x.send`), or taken out of an object (`const { send } = x`);
// - a transport handed to a function as its `this` (`f.call(ws, …)`, `f.apply(ws, …)`, `f.bind(ws)`,
//   `Reflect.apply(f, ws, …)`), where a transport is an expression that is `ws` or ends in `.ws`;
// - in the network's own files (networkSource.mjs), an allowed receiver that is not what its name says: `this` where
//   it is not the network's (the class's members and the module's top-level functions have it, with the arrows inside
//   them; a non-arrow function nested in another has its own, and the module's top level has none); and `socket` or
//   `tSocket` bound, in the function that binds it, by anything but the origins listed at allowedParam below (a
//   parameter of a class member, of a top-level function or of a `this.sockets.forEach` callback; `this.sockets.get(…)`;
//   `new Socket(…)`; a for…of over the network's connections). Nothing on the right of a binding is followed: a name, a
//   member, a call, a destructuring, a default, a condition is refused whatever it holds.
// The parser is @babel/parser. It is a tripwire for a maintainer's mistake, not a proof. What it cannot see, said
// plainly:
// - a transport handed in as an argument where an allowed parameter takes it (`tell(ws)` for `function tell(socket)`,
//   a class member or a top-level function), or put into the network's own connections (`this.sockets.set(id, ws)`,
//   whose `get` and `forEach` then hand it out);
// - a module's top-level function called as a method of something that is not the network (`ws.leak = leak;
//   ws.leak()`): its `this` is then that object (handing a transport in through call, apply, bind or Reflect.apply is
//   refused);
// - a key computed at run time (`ws[name](…)`), a transport reached through a helper that takes it (`invoke(ws,
//   'send')`, `Reflect.get(ws, 'send')`), and anything through `eval`, `Function` or `with`;
// - files outside the ones read (src/server, core/Socket.js, the Server*/Apps systems).
// (A transport kept in a property is not among them: `this.raw.send(…)` is a receiver that is not allowed, and
// `socket = this.raw` an origin that is not on the list. Bindings are resolved per function, not per block: a
// `socket` an inner block declares again is taken together with the outer one, which can refuse more, not less.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { isNetworkFile, networkFiles } from './lib/networkSource.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const walkFiles = dir =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walkFiles(file) : file.endsWith('.js') ? [file] : []
  })

const SENDS = ['send', 'ping']
// the methods of the network's connections a callback whose parameter is a connection is passed to (today: forEach)
const ITERATORS = new Set(['forEach'])
const isMember = node => node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
const isCall = node => node?.type === 'CallExpression' || node?.type === 'OptionalCallExpression'
const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
])
const isFunction = node => FUNCTIONS.has(node?.type)
// a member's key: its name, or a computed key that is a string or a template without substitutions (null: computed
// at run time)
const keyOf = member => {
  if (!member.computed) return member.property.name ?? null
  if (member.property.type === 'StringLiteral') return member.property.value
  if (member.property.type === 'TemplateLiteral' && member.property.expressions.length === 0) {
    return member.property.quasis[0].value.cooked
  }
  return null
}
const receiver = node => {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'ThisExpression') return 'this'
  if (isMember(node)) return `${receiver(node.object)}.${keyOf(node) ?? '?'}`
  if (isCall(node)) return receiver(node.callee)
  return '?'
}
// a transport: `ws`, or an expression that ends in `.ws`
const isTransport = node =>
  (node?.type === 'Identifier' && node.name === 'ws') || (isMember(node) && keyOf(node) === 'ws')
// the network's connections: `this.sockets`, its `.values()`, or a spread of either
const isSockets = node => {
  if (node?.type === 'ArrayExpression') return node.elements.length === 1 && isSockets(node.elements[0]?.argument)
  if (isCall(node) && isMember(node.callee) && keyOf(node.callee) === 'values') return isSockets(node.callee.object)
  return isMember(node) && node.object.type === 'ThisExpression' && keyOf(node) === 'sockets'
}
// an expression a connection of the network's is taken from
const isConnection = node =>
  (isCall(node) && isMember(node.callee) && keyOf(node.callee) === 'get' && isSockets(node.callee.object)) ||
  (node?.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Socket')

// Receivers allowed everywhere: HTTP replies, the S3 client, the network itself
const allowedAnywhere = (file, value) =>
  value === 'reply' ||
  value.startsWith('reply.') ||
  (file.endsWith('/AssetsS3.js') && value === 'this.client') ||
  value === 'world.network' ||
  value === 'this.world.network'
// and in the network's own files: `this`, the network, and `socket` / `tSocket`, its connections (a Socket, whose send
// and ping go through the network's write ledger), where they are what their names say (below)
const NETWORK_RECEIVERS = ['this', 'socket', 'tSocket']

// `this` at `parents` (outermost first) is the network's: that of a class member or of a top-level function
function networkThis(parents) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const node = parents[i]
    if (node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty') return true
    if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') return true
    if (node.type === 'ArrowFunctionExpression') continue
    if (isFunction(node)) return !parents.slice(0, i).some(isFunction)
  }
  return false // the module's own
}

// Every binding a name has in the innermost function (or the module) that binds it, seen from `parents`: its
// parameters, its declarations (in blocks too), and every assignment to the name in that function's body (in the
// functions nested in it too). Each as { kind, node }: 'param' (a plain parameter), 'param-pattern' (a parameter
// with a pattern, a default or a rest), 'declared' (a variable, with its initializer or none), 'declared-pattern' (a
// variable bound by destructuring), 'iterated' (a for…of or for…in variable, with what it iterates), 'assigned' (with
// the value), 'other' (a catch parameter, a function, a class or an import of that name).
function bindingOf(name, parents) {
  const scopes = [...parents.filter(node => isFunction(node) || node.type === 'Program')].reverse()
  const names = pattern => {
    if (!pattern) return []
    if (pattern.type === 'Identifier') return [pattern.name]
    if (pattern.type === 'AssignmentPattern') return names(pattern.left)
    if (pattern.type === 'RestElement') return names(pattern.argument)
    if (pattern.type === 'ObjectPattern') {
      return pattern.properties.flatMap(property =>
        names(property.type === 'ObjectProperty' ? property.value : property)
      )
    }
    if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(names)
    return []
  }
  for (const scope of scopes) {
    const sources = []
    if (isFunction(scope)) {
      for (const param of scope.params) {
        if (names(param).includes(name)) sources.push({ kind: param.type === 'Identifier' ? 'param' : 'param-pattern' })
      }
    }
    const visit = (node, nested) => {
      if (!node || typeof node.type !== 'string') return
      if (node !== scope && isFunction(node)) nested = true
      if (!nested) {
        if (node.type === 'VariableDeclarator' && names(node.id).includes(name)) {
          if (node.id.type !== 'Identifier') sources.push({ kind: 'declared-pattern' })
          else if (node.iterated) sources.push({ kind: 'iterated', node: node.iterated })
          else sources.push({ kind: 'declared', node: node.init ?? null })
        }
        if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
          for (const declaration of node.left.declarations ?? []) declaration.iterated = node.right
        }
        if (node.type === 'CatchClause' && names(node.param).includes(name)) sources.push({ kind: 'other' })
        if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id?.name === name) {
          sources.push({ kind: 'other' })
        }
        if (node.type === 'ImportDeclaration' && node.specifiers.some(specifier => specifier.local.name === name)) {
          sources.push({ kind: 'other' })
        }
      }
      if (node.type === 'AssignmentExpression' && names(node.left).includes(name)) {
        sources.push(
          node.left.type === 'Identifier' ? { kind: 'assigned', node: node.right } : { kind: 'declared-pattern' }
        )
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key === 'iterated') continue
        if (Array.isArray(value)) value.forEach(child => visit(child, nested))
        else if (value && typeof value === 'object') visit(value, nested)
      }
    }
    visit(isFunction(scope) ? scope.body : scope, false)
    if (sources.length) return { scope, sources }
  }
  return null
}

// The origins a connection of the network's may be bound by (`socket`, `tSocket` as a receiver of send or ping in
// the network's files), as today's class binds them; any other origin is refused, whatever it holds, and nothing
// on the right of a binding is followed:
// - a plain parameter of a class member (a method, or the function of a field), of a module's top-level function
//   (declared, exported, or the function value of a top-level variable), or of a function passed to `forEach` of the
//   network's connections (`this.sockets.forEach(socket => …)`, on `this.sockets.values()` or a spread of either);
// - a declaration or assignment of `this.sockets.get(…)` or of `new Socket(…)`;
// - the variable of a for…of over the network's connections (`this.sockets`, `this.sockets.values()`).
// (Today's class uses the first two: 48 receivers, by parameters of its methods and fields and of one callback of
// `this.sockets.forEach`, and by `this.sockets.get(…)`.)
function allowedParam(binding, parents) {
  const scope = binding.scope
  const at = parents.indexOf(scope)
  const above = parents[at - 1]
  if (scope.type === 'ClassMethod' || scope.type === 'ClassPrivateMethod') return true
  if (above?.type === 'ClassProperty' || above?.type === 'ClassPrivateProperty') return true
  const topLevel = !parents.slice(0, at).some(isFunction)
  if (topLevel && (scope.type === 'FunctionDeclaration' || above?.type === 'VariableDeclarator')) return true
  const callee = above?.callee
  if (isCall(above) && above.arguments.includes(scope) && isMember(callee) && ITERATORS.has(keyOf(callee))) {
    return isSockets(callee.object)
  }
  return false
}
function refusedOrigin(source, binding, parents) {
  switch (source.kind) {
    case 'param':
      return allowedParam(binding, parents)
        ? null
        : "is a parameter of a function that is not a class member, a top-level function or a callback of the network's connections"
    case 'declared':
    case 'assigned':
      if (isConnection(source.node)) return null
      return `is given what is not a connection of the network's (${source.node?.type ?? 'nothing'})`
    case 'iterated':
      return isSockets(source.node) ? null : "iterates what is not the network's connections"
    default:
      return 'is bound by a pattern, a default, a catch, a declaration or an import, which is not on the list'
  }
}

// why `name` (socket, tSocket) at `parents` is not known to be a connection of the network's, or null
function notAConnection(name, parents) {
  const binding = bindingOf(name, parents)
  if (!binding) return `${name} is not bound in this file`
  for (const source of binding.sources) {
    const why = refusedOrigin(source, binding, parents)
    if (why) return `${name} ${why}`
  }
  return null
}

function bypasses(file, source, root = ROOT) {
  const found = []
  const say = (node, what) => found.push(`${file}:${node.loc.start.line}: ${what}`)
  const network = isNetworkFile(file, root)
  const visit = (node, parents) => {
    if (!node || typeof node.type !== 'string') return
    const parent = parents.at(-1)
    // a send or ping called
    if (isCall(node) && isMember(node.callee) && SENDS.includes(keyOf(node.callee))) {
      const value = receiver(node.callee.object)
      const name = `${value}.${keyOf(node.callee)}`
      if (allowedAnywhere(file, value)) {
        // as before
      } else if (network && NETWORK_RECEIVERS.includes(value)) {
        if (value === 'this') {
          if (!networkThis(parents)) say(node, `${name}: this is not the network's here`)
        } else {
          const why = notAConnection(value, [...parents, node])
          if (why) say(node, `${name}: ${why}`)
        }
      } else say(node, name)
    }
    // a send or ping referred to without a call
    if (isMember(node) && SENDS.includes(keyOf(node)) && !(isCall(parent) && parent.callee === node)) {
      say(node, `${receiver(node.object)}.${keyOf(node)} referred to without a call`)
    }
    // … or taken out of an object
    if (node.type === 'ObjectPattern') {
      for (const property of node.properties) {
        if (property.type === 'ObjectProperty' && SENDS.includes(keyOf({ ...property, property: property.key }))) {
          say(property, `{ ${keyOf({ ...property, property: property.key })} } taken out of an object`)
        }
      }
    }
    // a transport handed in as `this`
    if (isCall(node) && isMember(node.callee)) {
      const key = keyOf(node.callee)
      const given =
        ['call', 'apply', 'bind'].includes(key) && node.arguments[0]
          ? node.arguments[0]
          : key === 'apply' && receiver(node.callee.object) === 'Reflect'
            ? node.arguments[1]
            : null
      if (key === 'apply' && receiver(node.callee.object) === 'Reflect' && isTransport(node.arguments[1])) {
        say(node, 'a transport handed in as this (Reflect.apply)')
      } else if (given && isTransport(given)) say(node, `a transport handed in as this (.${key})`)
    }
    const inner = [...parents, node]
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'iterated'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(child => visit(child, inner))
      else if (value && typeof value === 'object') visit(value, inner)
    }
  }
  visit(parse(source, { sourceType: 'module' }).program, [])
  return found
}

// the files read, in a checkout (`root`): every file of src/server and its subfolders, core/Socket.js and the
// Server*/Apps systems; and what they write
function scan(root = ROOT) {
  const files = [
    // every folder below src/server too: src/server/network/, where the network's methods move, when it exists
    ...walkFiles(path.join(root, 'src/server')),
    ...[path.join(root, 'src/core/Socket.js')].filter(file => fs.existsSync(file)),
    ...walkFiles(path.join(root, 'src/core/systems')).filter(file => /\/(Server[^/]*|Apps)\.js$/.test(file)),
  ]
  return { files, violations: files.flatMap(file => bypasses(file, fs.readFileSync(file, 'utf8'), root)) }
}

test('server writes: no raw transport send or ping outside writeLedger', () => {
  const { files, violations } = scan()
  // the network's files are all read
  for (const file of networkFiles()) assert.ok(files.includes(path.join(ROOT, file)), file)
  assert.deepEqual(violations, [])
})

test('server writes: guard detects direct, aliased, optional and computed transport calls', () => {
  for (const source of ['ws.send(data)', 'this.ws.ping()', 'transport?.send(data)', "conn['send'](data)"]) {
    assert.equal(bypasses('src/server/example.js', source).length, 1, source)
  }
})

test("server writes: the network's own receivers are allowed in its files only, the class and src/server/network/", () => {
  // the shape the network's code has: a class member, a module's top-level function (`this` is the network)
  const shaped = body => `export function tell(socket, tSocket, name, data) {\n${body}\n}`
  // (as the scan names them, absolute, and relative to the repository)
  for (const file of [
    path.join(ROOT, 'src/core/systems/ServerNetwork.js'),
    path.join(ROOT, 'src/server/network/tips.js'),
    'src/server/network/wallets/evm.js',
  ]) {
    for (const source of ['this.send(name, data)', 'socket.send(name, data)', 'tSocket.ping()']) {
      assert.deepEqual(bypasses(file, shaped(source)), [], `${file}: ${source}`)
    }
    for (const source of ['ws.send(data)', 'this.ws.ping()', 'socket.ws.send(data)', 'player.send(data)']) {
      assert.equal(bypasses(file, shaped(source)).length, 1, `${file}: ${source}`)
    }
  }
  for (const file of [
    'src/server/index.js',
    'src/server/network.js',
    'src/server/networkX/a.js',
    path.join(ROOT, 'src/server/ServerNetwork.js'),
  ]) {
    for (const source of ['this.send(name, data)', 'socket.send(name, data)']) {
      assert.equal(bypasses(file, shaped(source)).length, 1, `${file}: ${source}`)
    }
  }
})

test('server writes: what escaped before (an alias, an extracted or bound send, a transport as this, a template key) is caught', () => {
  const file = 'src/server/network/tips.js'
  const caught = {
    'an alias under an allowed name': 'export function f(ws, data) {\n  const socket = ws\n  socket.send(data)\n}',
    'an alias of a transport field':
      'export function f(peer) {\n  let tSocket\n  tSocket = peer.ws\n  tSocket.ping()\n}',
    'a send taken out of the transport': 'export function f(ws, data) {\n  const { send } = ws\n  send(data)\n}',
    'a send renamed out of the transport':
      'export function f(ws, data) {\n  const { send: write } = ws\n  write(data)\n}',
    'a bound send': 'export function f(ws, data) {\n  const write = ws.send.bind(ws)\n  write(data)\n}',
    'a send called through call': 'export function f(ws, data) {\n  ws.send.call(ws, data)\n}',
    'a send extracted': 'export function f(ws) {\n  return ws.ping\n}',
    'a function given the transport as this':
      'function raw(data) {\n  this.send(data)\n}\nexport const f = ws => raw.call(ws, 1)',
    'the same through apply': 'function raw(data) {\n  this.send(data)\n}\nexport const f = ws => raw.apply(ws, [1])',
    'the same through Reflect.apply':
      'function raw(data) {\n  this.send(data)\n}\nexport const f = ws => Reflect.apply(raw, ws, [1])',
    'a template key': 'export function f(ws, data) {\n  ws[`send`](data)\n}',
    "this of a nested function: not the network's":
      'export function f(data) {\n  return function () {\n    this.send(data)\n  }\n}',
    "this of an object's method: not the network's":
      'export function f(data) {\n  return { go() { this.send(data) } }\n}',
    "this of the module: not the network's": 'export const f = data => this.send(data)',
    'a nested parameter under an allowed name':
      'export function f(list, data) {\n  list.forEach(socket => socket.send(data))\n}',
    'a call result under an allowed name, nested':
      'export function f(make) {\n  return () => {\n    const socket = make()\n    socket.send(1)\n  }\n}',
    'an allowed name bound to nothing': 'export function f(data) {\n  socket.send(data)\n}',
    'an alias chain of two links':
      'export function f(ws) {\n  const raw = ws\n  const socket = raw\n  socket.send(1)\n}',
    'an alias chain of three links':
      'export function f(ws) {\n  const a = ws\n  const b = a\n  const socket = b\n  socket.send(1)\n}',
    'an alias reassigned':
      'export function f(peer, ws) {\n  let raw = peer\n  raw = ws\n  const tSocket = raw\n  tSocket.ping()\n}',
    'a destructured alias':
      'export function f(peer) {\n  const { ws: raw } = peer\n  const socket = raw\n  socket.send(1)\n}',
    'a destructured parameter': 'export function f({ ws: socket }) {\n  socket.send(1)\n}',
    'an alias through a condition':
      'export function f(ws, other) {\n  const raw = other ?? ws\n  const socket = raw\n  socket.send(1)\n}',
    'an alias whose initializer a nested parameter shadows':
      'export function f(ws) {\n  const raw = ws,\n    socket = raw\n  return raw => socket.send(1)\n}',
    'an alias whose initializer a nested connection shadows':
      'export function f(ws) {\n  const raw = ws,\n    socket = raw\n  return () => {\n    const raw = new Socket({ ws })\n    socket.send(1)\n  }\n}',
    'a connection given another value later':
      'export function f(id, peer) {\n  let socket = this.sockets.get(id)\n  socket = peer\n  socket.send(1)\n}',
    'a connection or a transport':
      'export function f(id, ws) {\n  const socket = id ? this.sockets.get(id) : ws\n  socket.send(1)\n}',
    'a default value': 'export function f(socket = this.ws) {\n  socket.send(1)\n}',
    'a catch parameter':
      'export function f() {\n  try {\n    this.go()\n  } catch (socket) {\n    socket.send(1)\n  }\n}',
    'a member of something else': 'export function f(peer) {\n  const tSocket = peer.socket\n  tSocket.send(1)\n}',
    'a call result, in a top-level function': 'export function f(make) {\n  const socket = make()\n  socket.send(1)\n}',
    'a callback of another collection': 'export function f(list) {\n  list.forEach(socket => socket.ping())\n}',
  }
  for (const [what, source] of Object.entries(caught)) {
    assert.ok(bypasses(file, source).length >= 1, `${what}:\n${source}`)
  }
  // and what the network's code does: not caught
  const fine = {
    'a member of the class':
      'class N {\n  tell(socket, data) {\n    this.send("x", data)\n    socket.send("x", data)\n  }\n}',
    'an arrow property of the class':
      'class N {\n  onPing = (socket, time) => {\n    socket.send("pong", time)\n  }\n}',
    'an arrow inside a top-level function': 'export function f(data) {\n  [1].forEach(() => this.send("x", data))\n}',
    'a connection the network keeps':
      'export function f(id) {\n  const tSocket = this.sockets.get(id)\n  tSocket.send("x")\n}',
    'a callback of its connections': 'export function f() {\n  this.sockets.forEach(socket => socket.send("x"))\n}',
    'its connections, iterated':
      'export function f() {\n  for (const socket of this.sockets.values()) socket.ping()\n}',
    'a connection made here':
      'export function f(ws) {\n  return () => {\n    const socket = new Socket({ ws })\n    socket.send("x")\n  }\n}',
  }
  for (const [what, source] of Object.entries(fine)) {
    assert.deepEqual(bypasses(file, source), [], `${what}:\n${source}`)
  }
})

// The guard's own tripwire against false alarms, for the moves to come: every method and function-valued field of
// today's class, written as a top-level function of a network module (the shape a move gives it: its `this` is the
// network), passes
test("server writes: the class's members, rewritten as a network module's top-level functions, pass", () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/core/systems/ServerNetwork.js'), 'utf8')
  const ast = parse(source, { sourceType: 'module' })
  const declaration = ast.program.body
    .map(node => (node.type === 'ExportNamedDeclaration' ? node.declaration : node))
    .find(node => node?.type === 'ClassDeclaration' && node.id.name === 'ServerNetwork')
  const text = node => source.slice(node.start, node.end)
  const params = fn => (fn.params.length ? source.slice(fn.params[0].start, fn.params.at(-1).end) : '')
  const functions = []
  let methods = 0
  let fields = 0
  for (const member of declaration.body.body) {
    if (member.type === 'ClassMethod' && member.kind === 'method') {
      methods++
      const head = `${member.async ? 'async ' : ''}function ${member.generator ? '*' : ''}${member.key.name}`
      functions.push(`export ${head}(${params(member)}) ${text(member.body)}`)
    } else if (member.type === 'ClassProperty' && isFunction(member.value)) {
      fields++
      const fn = member.value
      const body = fn.body.type === 'BlockStatement' ? text(fn.body) : `{\n  return ${text(fn.body)}\n}`
      functions.push(`export ${fn.async ? 'async ' : ''}function ${member.key.name}(${params(fn)}) ${body}`)
    }
  }
  // (today: 62 methods besides the constructor, and 33 function-valued fields)
  assert.ok(methods >= 60 && fields >= 30, `${methods} methods, ${fields} fields`)
  const imports = ast.program.body.filter(node => node.type === 'ImportDeclaration').map(text)
  const module = [...imports, ...functions].join('\n\n')
  assert.deepEqual(bypasses('src/server/network/all.js', module), [])
  // and the guard reads them: one of them changed to send raw is refused
  const leaked = module.replace('export function write(ws, packet, options = {}) {', '$&\n  ws.send(packet)')
  assert.notEqual(leaked, module)
  assert.equal(bypasses('src/server/network/all.js', leaked).length, 1)
})

test('server writes: a module nested in src/server/network/ is found, read, and its raw send refused', t => {
  // a checkout of its own: the class, a socket, and a network module two folders down
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-writes-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  put(
    'src/core/systems/ServerNetwork.js',
    'export class ServerNetwork {\n  tell(socket) {\n    socket.send("x")\n  }\n}\n'
  )
  put('src/core/Socket.js', 'export class Socket {}\n')
  put(
    'src/server/network/deep/raw.js',
    'export function leak(ws) {\n  console.error("[network] leaking")\n  ws.send(1)\n}\n'
  )
  assert.deepEqual(networkFiles(root), ['src/core/systems/ServerNetwork.js', 'src/server/network/deep/raw.js'])
  const { files, violations } = scan(root)
  assert.ok(files.includes(path.join(root, 'src/server/network/deep/raw.js')))
  assert.deepEqual(violations, [`${path.join(root, 'src/server/network/deep/raw.js')}:3: ws.send`])
})
