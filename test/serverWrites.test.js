import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import { isNetworkFile, networkFiles } from './lib/networkSource.mjs'

const root = new URL('../src/', import.meta.url)
const walkFiles = dir =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walkFiles(file) : file.endsWith('.js') ? [file] : []
  })

// Grep every send/ping call, then identify the receiver in the syntax tree. Only known HTTP, S3 and
// network-wrapper receivers are allowed; a newly named raw transport cannot silently bypass the writer.
const receiver = node => {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    return `${receiver(node.object)}.${node.computed ? node.property.value : node.property.name}`
  }
  if (node.type === 'CallExpression') return receiver(node.callee)
  return '?'
}
// The network's own receivers, in the network's own code only (test/lib/networkSource.mjs: the class in
// src/core/systems/ServerNetwork.js and the modules of src/server/network/, whose functions are its methods): `this`,
// the network, and `socket` / `tSocket`, its connections (a Socket, whose send and ping go through the network's write
// ledger). Anywhere else nothing says that these names are either.
const NETWORK_RECEIVERS = ['this', 'socket', 'tSocket']
const allowed = (file, value) => {
  if (value === 'reply' || value.startsWith('reply.')) return true
  if (file.endsWith('/AssetsS3.js') && value === 'this.client') return true
  if (value === 'world.network' || value === 'this.world.network') return true
  if (isNetworkFile(file) && NETWORK_RECEIVERS.includes(value)) return true
  return false
}

function bypasses(file, source) {
  const found = []
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (['CallExpression', 'OptionalCallExpression'].includes(node.type)) {
      const callee = node.callee
      if (['MemberExpression', 'OptionalMemberExpression'].includes(callee.type)) {
        const name = callee.computed ? callee.property.value : callee.property.name
        if (['send', 'ping'].includes(name) && !allowed(file, receiver(callee.object))) {
          found.push(`${file}:${node.loc.start.line}: ${receiver(callee.object)}.${name}`)
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(visit)
      else visit(value)
    }
  }
  visit(parse(source, { sourceType: 'module' }))
  return found
}

test('server writes: no raw transport send or ping outside writeLedger', () => {
  const files = [
    // every folder below src/server too: src/server/network/, where the network's methods move, when it exists
    ...walkFiles(new URL('server/', root).pathname),
    new URL('core/Socket.js', root).pathname,
    ...walkFiles(new URL('core/systems/', root).pathname).filter(file => /\/(Server[^/]*|Apps)\.js$/.test(file)),
  ]
  // the network's files are all read
  for (const file of networkFiles()) assert.ok(files.includes(new URL(`../${file}`, import.meta.url).pathname), file)
  const violations = files.flatMap(file => bypasses(file, fs.readFileSync(file, 'utf8')))
  assert.deepEqual(violations, [])
})

test('server writes: guard detects direct, aliased, optional and computed transport calls', () => {
  for (const source of ['ws.send(data)', 'this.ws.ping()', 'transport?.send(data)', "conn['send'](data)"]) {
    assert.equal(bypasses('src/server/example.js', source).length, 1, source)
  }
})

test("server writes: the network's own receivers are allowed in its files only, the class and src/server/network/", () => {
  // (as the scan names them, absolute, and relative to the repository)
  for (const file of [
    new URL('../src/core/systems/ServerNetwork.js', import.meta.url).pathname,
    new URL('../src/server/network/tips.js', import.meta.url).pathname,
    'src/server/network/wallets/evm.js',
  ]) {
    for (const source of ['this.send(name, data)', 'socket.send(name, data)', 'tSocket.ping()']) {
      assert.deepEqual(bypasses(file, source), [], `${file}: ${source}`)
    }
    for (const source of ['ws.send(data)', 'this.ws.ping()', 'socket.ws.send(data)', 'player.send(data)']) {
      assert.equal(bypasses(file, source).length, 1, `${file}: ${source}`)
    }
  }
  for (const file of [
    'src/server/index.js',
    'src/server/network.js',
    'src/server/networkX/a.js',
    new URL('../src/server/ServerNetwork.js', import.meta.url).pathname,
  ]) {
    for (const source of ['this.send(name, data)', 'socket.send(name, data)']) {
      assert.equal(bypasses(file, source).length, 1, `${file}: ${source}`)
    }
  }
})
