import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'

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
const allowed = (file, value) => {
  if (value === 'reply' || value.startsWith('reply.')) return true
  if (file.endsWith('/AssetsS3.js') && value === 'this.client') return true
  if (value === 'world.network' || value === 'this.world.network') return true
  if (file.endsWith('/ServerNetwork.js') && ['this', 'socket', 'tSocket'].includes(value)) return true
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
    ...walkFiles(new URL('server/', root).pathname),
    new URL('core/Socket.js', root).pathname,
    ...walkFiles(new URL('core/systems/', root).pathname).filter(file => /\/(Server[^/]*|Apps)\.js$/.test(file)),
  ]
  const violations = files.flatMap(file => bypasses(file, fs.readFileSync(file, 'utf8')))
  assert.deepEqual(violations, [])
})

test('server writes: guard detects direct, aliased, optional and computed transport calls', () => {
  for (const source of ['ws.send(data)', 'this.ws.ping()', 'transport?.send(data)', "conn['send'](data)"]) {
    assert.equal(bypasses('src/server/example.js', source).length, 1, source)
  }
})
