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
//   `tSocket` when any binding or write of that name in the unit of the send or ping (the class member, field's
//   function or module's top-level function that holds it, nested functions included, whatever each resolves to) is
//   not an origin on the list at refusedWrite below, the ones today's class binds its sent-to connections by: a plain
//   parameter of the unit; a plain parameter of a function passed directly to `this.sockets.forEach`, or to `forEach`
//   of a local array declared in the unit's body that only receives that name from such parameters; a declaration or
//   assignment of `this.sockets.get(…)`. Where an origin reads `this.sockets`, that `this` is the unit's own. A
//   binding or write of either name at a network module's top level is refused outright. Nothing on the right of a
//   binding is followed, and no use is matched to the binding it resolves to: shadowing, or a write in a nested
//   function, can only refuse more.
// The parser is @babel/parser. It is a tripwire for a maintainer's mistake, not a proof. What it cannot see, said
// plainly:
// - a transport handed in as an argument where an allowed parameter takes it (`tell(ws)` for `function tell(socket)`,
//   a class member or a top-level function), or put into the network's own connections (`this.sockets.set(id, ws)`,
//   whose `get` and `forEach` then hand it out);
// - a member of the class or a module's top-level function called as a method of something that is not the network
//   (`ws.leak = leak; ws.leak()`): its `this` is then that object (handing a transport in through call, apply, bind or
//   Reflect.apply is refused); and a class other than the network's written in one of its files, whose members' `this`
//   is taken for the network's;
// - a key computed at run time (`ws[name](…)`), a transport reached through a helper that takes it (`invoke(ws,
//   'send')`, `Reflect.get(ws, 'send')`), and anything through `eval`, `Function` or `with`;
// - files outside the ones read (src/server, core/Socket.js, the Server*/Apps systems).
// (A transport kept in a property is not among them: `this.raw.send(…)` is a receiver that is not allowed, and
// `socket = this.raw` an origin that is not on the list.)
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
// the network's connections: `this.sockets`
const isSockets = node => isMember(node) && node.object.type === 'ThisExpression' && keyOf(node) === 'sockets'
// a connection of the network's taken from them: `this.sockets.get(…)`
const isConnection = node =>
  isCall(node) && isMember(node.callee) && keyOf(node.callee) === 'get' && isSockets(node.callee.object)

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

// The unit a node is in: the class member (a method, or a field) or the module's top-level function (declared,
// exported, or the function value of a top-level variable) that holds it, outermost; null where there is none (the
// module's top level, a function of an object at the top level).
const CLASS_MEMBERS = new Set(['ClassMethod', 'ClassPrivateMethod', 'ClassProperty', 'ClassPrivateProperty'])
function unitOf(parents) {
  for (const [i, node] of parents.entries()) {
    if (CLASS_MEMBERS.has(node.type)) return node
    if (isFunction(node)) {
      const above = parents[i - 1]
      const topLevel =
        node.type === 'FunctionDeclaration' ||
        above?.type === 'VariableDeclarator' ||
        above?.type === 'ExportDefaultDeclaration'
      return topLevel ? node : null
    }
  }
  return null
}
const unitFunction = unit => (unit.type === 'ClassProperty' || unit.type === 'ClassPrivateProperty' ? unit.value : unit)

// the names a pattern binds
const patternNames = pattern => {
  if (!pattern) return []
  if (pattern.type === 'Identifier') return [pattern.name]
  if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left)
  if (pattern.type === 'RestElement') return patternNames(pattern.argument)
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap(property =>
      patternNames(property.type === 'ObjectProperty' ? property.value : property)
    )
  }
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(patternNames)
  return []
}
const isLoop = node => node?.type === 'ForOfStatement' || node?.type === 'ForInStatement'

// Every place in `root` (a unit, or a module) where `name` is bound or written, whatever it resolves to: a parameter
// of any function (plain: 'param'; with a pattern, a default or a rest: 'pattern'), a declaration in any block
// ('declared', with its value; destructured: 'pattern'), the variable of a for…in or for…of, declared or bare
// ('iterated', with what it iterates), an assignment ('assigned' for `=`, with its value; any other operator: 'other';
// a destructuring target: 'pattern'), an update (`socket++`), a catch parameter, a function, class or import of that
// name ('other'). Parameter defaults and nested functions are read too. -> [{ kind, node, parents, fn, value }]
function writesOf(root, name) {
  const found = []
  const visit = (node, parents) => {
    if (!node || typeof node.type !== 'string') return
    const add = (kind, extra = {}) => found.push({ kind, node, parents, ...extra })
    if (isFunction(node)) {
      if (node.id?.name === name) add('other')
      for (const param of node.params) {
        if (param.type === 'Identifier' && param.name === name) add('param', { fn: node })
        else if (patternNames(param).includes(name)) add('pattern', { fn: node })
      }
    }
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.id?.name === name) add('other')
    if (node.type === 'ImportDeclaration' && node.specifiers.some(specifier => specifier.local.name === name)) {
      add('other')
    }
    if (node.type === 'VariableDeclarator') {
      if (node.id.type === 'Identifier' && node.id.name === name) {
        const loop = parents.at(-2)
        if (isLoop(loop) && loop.left === parents.at(-1)) add('iterated', { value: loop.right })
        else add('declared', { value: node.init ?? null })
      } else if (patternNames(node.id).includes(name)) add('pattern')
    }
    if (node.type === 'AssignmentExpression') {
      if (node.left.type === 'Identifier' && node.left.name === name) {
        if (node.operator === '=') add('assigned', { value: node.right })
        else add('other')
      } else if (patternNames(node.left).includes(name)) add('pattern')
    }
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier' && node.argument.name === name) {
      add('other')
    }
    if (isLoop(node) && node.left.type !== 'VariableDeclaration') {
      if (node.left.type === 'Identifier' && node.left.name === name) add('iterated', { value: node.right })
      else if (patternNames(node.left).includes(name)) add('pattern')
    }
    if (node.type === 'CatchClause' && patternNames(node.param).includes(name)) add('other')
    const inner = [...parents, node]
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue
      if (Array.isArray(value)) value.forEach(child => visit(child, inner))
      else if (value && typeof value === 'object') visit(value, inner)
    }
  }
  visit(root, [])
  return found
}

// whether `this` where `parents` (from the unit down) end is the unit's own: no non-arrow function, nor a member of a
// class or object, between them (the unit's own function aside)
const OWN_THIS_BREAKS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
  'ClassProperty',
  'ClassPrivateProperty',
  'StaticBlock',
])
function ownThis(parents, unit) {
  return parents.every((node, i) => i === 0 || node === unitFunction(unit) || !OWN_THIS_BREAKS.has(node.type))
}

// a local array of the unit's that only ever holds connections, for `forEach` callbacks whose parameter is `name`
// (socket or tSocket): `const <array> = []` as a statement of the unit's own body (so that no other binding of that
// name is seen in the unit), and every other use of the array's name in the unit `<array>.forEach(…)` or
// `<array>.push(<name>)` made in a function whose own plain parameter is `name` (so the element is one of the unit's
// bindings of `name`, every one of which is checked with this one, and not a binding outside the unit):
// checkSockets' `dead`
function onlyConnections(unit, array, name) {
  const body = unitFunction(unit)?.body
  if (body?.type !== 'BlockStatement') return false
  let declared = 0
  let other = 0
  const visit = (node, parents) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'Identifier' && node.name === array) {
      const parent = parents.at(-1)
      const call = parents.at(-2)
      const declaration = parents.at(-2)
      if (parent?.type === 'VariableDeclarator' && parent.id === node) {
        const empty = parent.init?.type === 'ArrayExpression' && parent.init.elements.length === 0
        if (empty && declaration?.kind === 'const' && parents.at(-3) === body) declared++
        else other++
      } else if (
        isMember(parent) &&
        parent.object === node &&
        !parent.computed &&
        isCall(call) &&
        call.callee === parent
      ) {
        const key = keyOf(parent)
        const argument = call.arguments.length === 1 ? call.arguments[0] : null
        const pushed =
          argument?.type === 'Identifier' &&
          argument.name === name &&
          parents.some(
            at => isFunction(at) && at.params.some(param => param.type === 'Identifier' && param.name === name)
          )
        if (!(key === 'forEach' || (key === 'push' && pushed))) other++
      } else if (!(isMember(parent) && parent.property === node && !parent.computed)) other++
    }
    const inner = [...parents, node]
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue
      if (Array.isArray(value)) value.forEach(child => visit(child, inner))
      else if (value && typeof value === 'object') visit(value, inner)
    }
  }
  visit(unit, [])
  return declared === 1 && other === 0
}

// The origins a connection of the network's may be bound or written by (`socket`, `tSocket`, wherever in the unit of
// a send or ping on that name in the network's files): exactly those today's class binds its sent-to connections by,
// each with the units that need it; any other is refused, whatever it holds, and nothing on the right of a binding is
// followed:
// - a plain parameter of the unit itself (a class member, a field's function, a module's top-level function): 44 of
//   today's 48 sends and pings, in 23 units: the methods retireSocket, spend, checkBuilderBalance, endTokenGrant,
//   onTipResult, revertBlueprint, releaseSettings; the fields onCommand, onModifyRank, onRequestBuilderNonce,
//   onRequestBuilderByToken, onTokenBalanceRequest, onRevokeBuilderByToken, onRequestEvmNonce, onRequestEvmVerify,
//   onRevokeEvmWallet, onRequestEvmTipIntent, onEvmTip, onEntityAdded, onEntityModified, onSpawnModified, onAi, onPing;
// - a plain parameter of a function passed directly to `this.sockets.forEach`, or to `forEach` of a local array of
//   the unit's that only ever receives such connections (onlyConnections): checkSockets, whose ping is in the first
//   and whose `dead.forEach(socket => socket.disconnect())` binds the name too;
// - a declaration or assignment of `this.sockets.get(…)`: sendTo, announceTip, and the field onKick (`tSocket`).
// Where an origin reads `this.sockets`, that `this` has to be the unit's own (not that of a nested non-arrow function,
// or of a member of a nested class or object). A for…of over the connections and `new Socket(…)` are not on it: no
// unit that sends on the name binds it so (onConnection makes a Socket and sends nothing on it).
function refusedWrite(write, unit, name) {
  switch (write.kind) {
    case 'param': {
      if (write.fn === unitFunction(unit)) return null
      const call = write.parents.at(-1)
      const callee = call?.callee
      if (isCall(call) && call.arguments.includes(write.fn) && isMember(callee) && keyOf(callee) === 'forEach') {
        if (isSockets(callee.object) && ownThis(write.parents, unit)) return null
        if (callee.object.type === 'Identifier' && onlyConnections(unit, callee.object.name, name)) return null
      }
      return "is a parameter of a function that is neither its unit nor a forEach callback over the network's connections"
    }
    case 'declared':
    case 'assigned': {
      const value = write.value
      if (isConnection(value) && ownThis(write.parents, unit)) return null
      return `is given what is not a connection the network keeps (${value?.type ?? 'nothing'})`
    }
    case 'iterated':
      return 'is the variable of a loop'
    default:
      return 'is bound or written in a shape that is not on the list'
  }
}

// why `name` (socket, tSocket) as the receiver at `parents` is not known to be a connection of the network's, or null:
// every binding or write of the name in its unit is checked, whatever it resolves to
function notAConnection(name, parents) {
  const unit = unitOf(parents)
  if (!unit) return `${name} is used outside a class member or a top-level function`
  const writes = writesOf(unit, name)
  if (!writes.length) return `${name} is not bound in its class member or top-level function`
  for (const write of writes) {
    const why = refusedWrite(write, unit, name)
    if (why) return `${name} ${why} (line ${write.node.loc.start.line})`
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
  const program = parse(source, { sourceType: 'module' }).program
  visit(program, [])
  // a binding or write of a connection's name at a network module's top level: refused outright
  if (network) {
    for (const name of NETWORK_RECEIVERS.slice(1)) {
      for (const write of writesOf(program, name)) {
        // (a parameter is its function's)
        if (!write.fn && !write.parents.some(node => isFunction(node) || node.type === 'ClassBody')) {
          say(write.node, `${name} bound or written at the module's top level`)
        }
      }
    }
  }
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
    'a bare loop target (Codex)':
      'export function f(id) {\n  let socket = this.sockets.get(id)\n  for (socket of this.rawSockets.values()) socket.send(1)\n}',
    'a bare loop target, for…in':
      'export function f(id) {\n  let socket = this.sockets.get(id)\n  for (socket in this.raw) socket.send(1)\n}',
    'a bare destructured loop target':
      'export function f(id) {\n  let tSocket = this.sockets.get(id)\n  for ([, tSocket] of this.rawPairs) tSocket.ping()\n}',
    'a function declaration of the name': 'export function f() {\n  function socket() {}\n  socket.send(1)\n}',
    'a write in a parameter default': 'export function f(socket, x = (socket = this.ws)) {\n  socket.send(x)\n}',
    'an assignment in a nested function hides the first value (Codex)':
      'export function f(id) {\n  let socket = this.raw\n  return () => {\n    socket.send(1)\n    socket = this.sockets.get(id)\n  }\n}',
    'the same through a function called later':
      'export function f(id) {\n  let tSocket = this.peer.transport\n  const g = () => {\n    tSocket = this.sockets.get(id)\n  }\n  g()\n  tSocket.ping()\n}',
    'a raw value written by a nested function':
      'export function f(id) {\n  let socket = this.sockets.get(id)\n  const swap = () => {\n    socket = this.raw\n  }\n  swap()\n  socket.send(1)\n}',
    'an update of the name':
      'export function f(id) {\n  let socket = this.sockets.get(id)\n  socket += 1\n  socket.send(1)\n}',
    "a nested function's this.sockets (Codex)":
      'export function f(id) {\n  return function () {\n    const socket = this.sockets.get(id)\n    socket.send(1)\n  }\n}',
    "a nested function's this.sockets.forEach":
      'export function f() {\n  return function () {\n    this.sockets.forEach(socket => socket.send(1))\n  }\n}',
    "an object method's this.sockets":
      'export function f() {\n  return {\n    go(id) {\n      const socket = this.sockets.get(id)\n      socket.ping()\n    }\n  }\n}',
    'a binding at the top of a network module': 'const socket = make()\nexport function f() {\n  socket.send(1)\n}',
    'a local array that receives something else':
      'export function f(ws) {\n  const dead = []\n  dead.push(ws)\n  dead.forEach(socket => socket.send(1))\n}',
    'a local array that starts with something':
      'export function f(ws) {\n  const dead = [ws]\n  dead.forEach(socket => socket.send(1))\n}',
    'a local array that receives a name of no parameter':
      'export function f() {\n  const dead = []\n  dead.push(socket)\n  dead.forEach(socket => socket.send(1))\n}',
    'a local array that receives another name':
      'export function f() {\n  const dead = []\n  ;[this.raw].forEach(tSocket => dead.push(tSocket))\n  dead.forEach(socket => socket.send(1))\n}',
    "a local array declared in a block, under a module's of that name":
      'const dead = [raw]\nexport function f() {\n  {\n    const dead = []\n  }\n  dead.forEach(socket => socket.send(1))\n}',
    // shapes no unit that sends on the name has today: not on the list
    'its connections, iterated':
      'export function f() {\n  for (const socket of this.sockets.values()) socket.ping()\n}',
    'a connection made here':
      'export function f(ws) {\n  return () => {\n    const socket = new Socket({ ws })\n    socket.send("x")\n  }\n}',
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
    'a local array of connections (checkSockets)':
      'export function f() {\n  const dead = []\n  this.sockets.forEach(socket => {\n    if (socket.alive) socket.ping()\n    else dead.push(socket)\n  })\n  dead.forEach(socket => socket.disconnect())\n}',
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
