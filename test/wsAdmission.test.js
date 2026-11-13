import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { parse } from '@babel/parser'
import { createConnectionLimits, readConnectionLimitsEnv } from '../src/server/connectionLimits.js'
import { loadNetwork, makeNetwork } from './lib/network.mjs'
import { loadRoute } from './lib/wsRoute.mjs'
import { PROTOCOL_VERSION } from '../src/core/packets.js'

// the route on a network of the real class (test/lib/network.mjs)
const net = await loadNetwork()

function fixture(t) {
  const limits = createConnectionLimits({ ...readConnectionLimitsEnv({}), ratePerMin: 0 })
  const route = loadRoute(limits, makeNetwork(t, { net }))
  const transport = new EventEmitter()
  const request = { ws: true, raw: { socket: transport }, headers: {}, ip: '::ffff:102:304' }
  const reply = {
    code(value) {
      this.status = value
      return this
    },
    header(key, value) {
      this[key] = value
      return this
    },
    send() {
      this.sent = true
    },
  }
  return { limits, ...route, transport, request, reply }
}

test('preValidation: HTTP GETs take no lease and only one upgrade lease may occupy a transport', t => {
  const { limits, preValidation, request, reply, transport } = fixture(t)
  let next = 0
  for (let i = 0; i < 8; i++) preValidation({ ...request, ws: false }, reply, () => next++)
  assert.equal(limits.stats().active, 0)
  preValidation(request, reply, () => next++)
  assert.equal(limits.stats().active, 1)
  preValidation(request, reply, () => next++)
  assert.equal(next, 9)
  assert.equal(reply.status, 503)
  assert.equal(reply['Retry-After'], '10')
  assert.equal(transport.listenerCount('close'), 1)
  transport.emit('close')
  transport.emit('close')
  assert.equal(limits.stats().active, 0)
})

test('preValidation: already destroyed and synchronously closing transports release their lease', t => {
  for (const duringRegistration of [false, true]) {
    const { limits, preValidation, request, reply, transport } = fixture(t)
    transport.destroyed = !duringRegistration
    if (duringRegistration) {
      transport.once = (name, fn) => {
        EventEmitter.prototype.once.call(transport, name, fn)
        transport.destroyed = true
        transport.emit('close')
      }
    }
    preValidation(request, reply, () => {})
    assert.equal(limits.stats().active, 0)
  }
})

test("preValidation: the address it counts is the named header's, or the connection's own when no header is named", t => {
  const counted = []
  const limits = {
    admit(origin) {
      counted.push(origin)
      return { ok: true, release() {} }
    },
  }
  const network = makeNetwork(t, { net })
  const admit = (config, headers) => {
    const { preValidation } = loadRoute(limits, network, config)
    let passed = false
    const request = { ws: true, raw: { socket: new EventEmitter() }, headers, ip: '10.0.0.1' }
    preValidation(request, {}, () => (passed = true))
    assert.equal(passed, true)
    return counted.at(-1)
  }
  const header = 'fly-client-ip'
  // the proxy's header, when one is named: an IPv4 client is its address
  assert.deepEqual(admit({ clientIpHeader: header }, { [header]: '203.0.113.9' }), { key: '203.0.113.9', parents: [] })
  // no header named: the connection's own address, whatever a header says
  assert.deepEqual(admit({ clientIpHeader: '' }, { [header]: '203.0.113.9' }), { key: '10.0.0.1', parents: [] })
  // an IPv6 client behind the proxy: its /64, with its /56 and /48
  assert.deepEqual(admit({ clientIpHeader: header }, { [header]: '2001:db8:1:2:3:4:5:6' }), {
    key: '2001:db8:1:2::/64',
    parents: ['2001:db8:1:0::/56', '2001:db8:1::/48'],
  })
  assert.equal(counted.length, 3)
})

test('transport: actual registration pins all six ws limits', t => {
  const { options } = fixture(t)
  assert.deepEqual(
    { ...options.options },
    {
      maxPayload: 65536,
      maxFragments: 8,
      maxBufferedChunks: 1024,
      autoPong: false,
      perMessageDeflate: false,
      closeTimeout: 2000,
    }
  )
})

test('the /ws route hands the connection its address key and wider networks, from the header the limits use', t => {
  const calls = []
  const network = makeNetwork(t, { net })
  network.onConnection = (...args) => calls.push(args)
  const connect = (config, req) => {
    const { register } = loadRoute(
      createConnectionLimits({ ...readConnectionLimitsEnv({}), ratePerMin: 0 }),
      network,
      config
    )
    let handler
    register({ get: (_path, _options, fn) => (handler = fn) })
    handler({ close() {} }, req)
    return calls.at(-1)
  }
  const version = String(PROTOCOL_VERSION)
  // no header configured: the connection's own address (an IPv4-mapped one is its IPv4 address)
  const direct = connect({ clientIpHeader: '' }, { query: { v: version }, headers: {}, ip: '::ffff:203.0.113.9' })
  assert.equal(direct[1].v, version, 'the query is passed on as before')
  assert.equal(JSON.stringify(direct[2]), JSON.stringify({ key: '203.0.113.9', parents: [] }))
  // the proxy's header, when one is named: an IPv6 client is its /64, with its /56 and /48
  const proxied = connect(
    { clientIpHeader: 'fly-client-ip' },
    { query: { v: version }, headers: { 'fly-client-ip': '2001:db8:1:2:3:4:5:6' }, ip: '10.0.0.1' }
  )
  assert.match(proxied[2].key, /^2001:db8:1:2/)
  assert.equal(proxied[2].parents.length, 2)
  // nothing usable: 'unknown', which the admin brake does not take for a key
  const hidden = connect({ clientIpHeader: 'fly-client-ip' }, { query: { v: version }, headers: {}, ip: undefined })
  assert.equal(hidden[2].key, 'unknown')
})

// How src/server/index.js makes the route and registers it, read from its syntax tree (@babel/parser), not from its
// formatting: what the tests above run is what the server registers only if index.js hands the module the connection
// limits, the header the upload limits read the client address from and the world (whose network the route reads
// when a connection comes), and registers @fastify/websocket with the route's options before the route itself.
const SKIP = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments'])
function* nodesOf(node) {
  if (!node || typeof node.type !== 'string') return
  yield node
  for (const [key, value] of Object.entries(node)) {
    if (SKIP.has(key)) continue
    if (Array.isArray(value)) for (const child of value) yield* nodesOf(child)
    else yield* nodesOf(value)
  }
}
const isName = (node, name) => node?.type === 'Identifier' && node.name === name
const isMember = (node, object, property) =>
  node?.type === 'MemberExpression' && !node.computed && isName(node.object, object) && isName(node.property, property)
const isCallOf = (node, name) => node?.type === 'CallExpression' && isName(node.callee, name)

test('index.js: the route is made once from the connection limits, the header and the world, and registered after its plugin', () => {
  const source = fs.readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8')
  const program = parse(source, { sourceType: 'module' }).program
  const nodes = [...nodesOf(program)]
  // the names: the plugin and the factory as imported, and the top-level constants
  const imported = (from, name) =>
    program.body.some(
      statement =>
        statement.type === 'ImportDeclaration' &&
        statement.source.value === from &&
        statement.specifiers.some(specifier =>
          name === 'default'
            ? specifier.type === 'ImportDefaultSpecifier' && specifier.local.name === 'ws'
            : specifier.type === 'ImportSpecifier' && isName(specifier.imported, name) && specifier.local.name === name
        )
    )
  assert.ok(imported('@fastify/websocket', 'default'), 'ws is the @fastify/websocket plugin')
  assert.ok(imported('./wsRoute', 'createWsRoute'), 'createWsRoute comes from wsRoute.js')
  const constants = new Map()
  for (const statement of program.body) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue
    for (const { id, init } of statement.declarations) if (id.type === 'Identifier') constants.set(id.name, init)
  }
  // createWsRoute: called once, its result a top-level constant
  const made = nodes.filter(node => isCallOf(node, 'createWsRoute'))
  assert.equal(made.length, 1, 'createWsRoute is called once')
  const route = [...constants].find(([, init]) => init === made[0])?.[0]
  assert.ok(route, 'its result is a top-level constant')
  // with exactly these three properties
  assert.equal(made[0].arguments.length, 1)
  const [given] = made[0].arguments
  assert.equal(given.type, 'ObjectExpression')
  assert.ok(given.properties.every(property => property.type === 'ObjectProperty' && !property.computed))
  const property = Object.fromEntries(given.properties.map(({ key, value }) => [key.name, value]))
  assert.deepEqual(Object.keys(property).sort(), ['clientIpHeader', 'connectionLimits', 'world'])
  // the connection limits made from their settings
  assert.equal(property.connectionLimits.type, 'Identifier')
  const limits = constants.get(property.connectionLimits.name)
  assert.ok(isCallOf(limits, 'createConnectionLimits'), 'connectionLimits is the result of createConnectionLimits')
  assert.equal(limits.arguments.length, 1)
  assert.ok(isName(limits.arguments[0], 'connectionLimitsConfig'))
  // the header the upload limits read the client address from (the one the CSP and upload routes are given)
  assert.ok(isMember(property.clientIpHeader, 'uploadLimitsConfig', 'clientIpHeader'))
  // the world itself (its network is read when a connection comes), the one createServerWorld made
  assert.ok(isName(property.world, 'world'))
  assert.ok(isCallOf(constants.get('world'), 'createServerWorld'))
  // registered: the plugin with the route's options, then the route, each once
  const registers = nodes.filter(node => node.type === 'CallExpression' && isMember(node.callee, 'fastify', 'register'))
  const plugin = registers.filter(call => isName(call.arguments[0], 'ws'))
  assert.equal(plugin.length, 1, 'the plugin is registered once')
  assert.equal(plugin[0].arguments.length, 2)
  assert.ok(isMember(plugin[0].arguments[1], route, 'options'), "with the route's options")
  const routes = registers.filter(call => isMember(call.arguments[0], route, 'register'))
  assert.equal(routes.length, 1, 'the route is registered once')
  assert.equal(routes[0].arguments.length, 1)
  assert.ok(plugin[0].start < routes[0].start, 'the plugin before the route')
  // and nothing else in index.js names a /ws route
  const paths = nodes.filter(
    node =>
      (node.type === 'StringLiteral' && node.value.startsWith('/ws')) ||
      (node.type === 'TemplateElement' && (node.value.cooked ?? node.value.raw).startsWith('/ws'))
  )
  assert.deepEqual(paths, [])
})
