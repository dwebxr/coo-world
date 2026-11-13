import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { parse } from '@babel/parser'
import jwt from 'jsonwebtoken'
import { createConnectionLimits, readConnectionLimitsEnv } from '../src/server/connectionLimits.js'
import { TOKEN_MAX_LENGTH } from '../src/server/wsRoute.js'
import { createSessionTokens } from '../src/core/utils-server.js'
import { Ranks } from '../src/core/extras/ranks.js'
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
    handler({ close() {} }, { ...req, raw: { socket: new EventEmitter() } })
    return calls.at(-1)
  }
  const version = String(PROTOCOL_VERSION)
  // no header configured: the connection's own address (an IPv4-mapped one is its IPv4 address)
  const direct = connect({ clientIpHeader: '' }, { query: { v: version }, headers: {}, ip: '::ffff:203.0.113.9' })
  assert.equal(direct[1].v, version, 'the query is passed on as before')
  assert.equal(JSON.stringify(direct[2]), JSON.stringify({ key: '203.0.113.9', parents: [] }))
  assert.deepEqual(direct[3], { rankedUser: null }, 'no place kept for a ranked user was given at the door')
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
  assert.ok(imported('../core/utils-server', 'readJWTNow'), 'readJWTNow comes from utils-server.js')
  assert.ok(imported('../core/utils-server', 'claimedSessionUser'), 'claimedSessionUser comes from utils-server.js')
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
  assert.deepEqual(Object.keys(property).sort(), ['clientIpHeader', 'connectionLimits', 'sessions', 'world'])
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
  // the session tokens' two questions of the door, the server's own (utils-server.js), and nothing else
  assert.equal(property.sessions.type, 'ObjectExpression')
  const sessions = Object.fromEntries(property.sessions.properties.map(({ key, value }) => [key.name, value]))
  assert.deepEqual(Object.keys(sessions).sort(), ['claimedUserId', 'readNow'])
  assert.ok(isName(sessions.readNow, 'readJWTNow'))
  assert.ok(isName(sessions.claimedUserId, 'claimedSessionUser'))
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

// --- the places kept for ranked users at the door (WS_RESERVED_SOCKETS): asked only when the address's own path
// refuses, with the session token's claimed user on the network's list of stored ranks before any signature check ---

const SECRET = 'door-test-secret-0123456789abcdef-xyz'
const PREVIOUS = 'door-test-previous-0123456789abcdef-x'
const replyStub = () => ({
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
})

// A network of the real class with the kept places in effect (an admin code: not open to all) and `ranks` on its list
// of stored ranks; the limits full at WS_MAX_SOCKETS 1 with one visitor, 2 places kept; the session tokens the real
// ones (utils-server.js createSessionTokens) under SECRET and PREVIOUS, each question of the door counted.
function door(t, { env = {}, ranks = {}, limits: overrides = {}, full = true } = {}) {
  const logs = []
  const network = makeNetwork(t, {
    net,
    env: { ADMIN_CODE: 'door-test-code', WS_RESERVED_SOCKETS: '2', ...env },
    log: line => logs.push(line),
  })
  for (const [id, rank] of Object.entries(ranks)) network.storedRanks.set(id, rank)
  const limits = createConnectionLimits({
    ...readConnectionLimitsEnv({}),
    ratePerMin: 0,
    maxSockets: 1,
    reserved: 2,
    ...overrides,
  })
  const tokens = createSessionTokens({ secret: SECRET, previous: PREVIOUS })
  const calls = { readNow: 0, claimedUserId: 0 }
  const sessions = {
    readNow: token => (calls.readNow++, tokens.readNow(token)),
    claimedUserId: token => (calls.claimedUserId++, tokens.claimedUserId(token)),
  }
  const route = loadRoute(limits, network, undefined, sessions)
  // one upgrade request with `query`, on `transport` -> what the door did
  const attempt = (query = {}, transport = new EventEmitter()) => {
    const reply = replyStub()
    let passed = false
    route.preValidation(
      { ws: true, raw: { socket: transport }, headers: {}, ip: '10.0.0.1', query },
      reply,
      () => (passed = true)
    )
    return { passed, status: reply.status, retryAfter: reply['Retry-After'], transport }
  }
  // the visitor that fills the server
  if (full) assert.equal(attempt({}).passed, true)
  const sign = (userId, secret = SECRET, payload = {}) => {
    const iat = Math.floor(Date.now() / 1000)
    return jwt.sign({ userId, iat, exp: iat + 3600, ...payload }, secret, { algorithm: 'HS256' })
  }
  return { network, limits, route, attempt, calls, sign, logs, tokens }
}
const refused = outcome => {
  assert.equal(outcome.passed, false)
  assert.equal(outcome.status, 503)
  assert.equal(outcome.retryAfter, '10')
  assert.equal(outcome.transport.listenerCount('close'), 0, 'no lease on the transport')
}

test('kept places at the door: an admin whose token verifies comes in at WS_MAX_SOCKETS, once per kept place', t => {
  const d = door(t, { ranks: { 'admin-1': Ranks.ADMIN, 'admin-2': Ranks.ADMIN, 'admin-3': Ranks.ADMIN } })
  assert.deepEqual(d.limits.stats(), { tracked: 1, active: 1, ranked: 0, users: 0 })
  const first = d.attempt({ authToken: d.sign('admin-1') })
  assert.equal(first.passed, true)
  assert.equal(first.transport.listenerCount('close'), 1, 'its lease is released at the close, as any')
  assert.deepEqual(d.calls, { readNow: 1, claimedUserId: 1 })
  assert.equal(d.attempt({ authToken: d.sign('admin-2') }).passed, true)
  assert.deepEqual(d.limits.stats(), { tracked: 1, active: 3, ranked: 2, users: 2 })
  // the two kept places are in use: the third admin is refused like anyone (after one verification)
  refused(d.attempt({ authToken: d.sign('admin-3') }))
  assert.deepEqual(d.calls, { readNow: 3, claimedUserId: 3 })
  // said once per user id, without the token
  first.transport.emit('close')
  assert.equal(d.attempt({ authToken: d.sign('admin-1') }).passed, true)
  refused(d.attempt({ authToken: d.sign('admin-3') }))
  assert.deepEqual(d.logs, [
    '[connections] at WS_MAX_SOCKETS: "admin-1" (stored rank admin) came in through a place kept for ranked users (1 of 2 in use)',
    '[connections] at WS_MAX_SOCKETS: "admin-2" (stored rank admin) came in through a place kept for ranked users (2 of 2 in use)',
    '[connections] "admin-3" (stored rank admin) was refused: the 2 places kept for ranked users are in use, or they have 2 connections open on that path, or their connection rate is spent',
  ])
})

test('kept places at the door: nothing but a verified token of a listed user gets one, and most are not verified', t => {
  const d = door(t, { ranks: { admin: Ranks.ADMIN, builder: Ranks.BUILDER } })
  const verifications = () => d.calls.readNow
  // no token, an empty one, one that is no string
  for (const query of [{}, { authToken: '' }, { authToken: ['a', 'b'] }, { authToken: { userId: 'admin' } }]) {
    refused(d.attempt(query))
  }
  assert.deepEqual(d.calls, { readNow: 0, claimedUserId: 0 }, 'not even read')
  // a visitor's token, genuine: not on the list, so not verified
  refused(d.attempt({ authToken: d.sign('visitor') }))
  assert.deepEqual(d.calls, { readNow: 0, claimedUserId: 1 })
  // a builder while the places are for admins: not verified
  refused(d.attempt({ authToken: d.sign('builder') }))
  assert.equal(verifications(), 0)
  // a token naming the admin, signed with another secret: one verification, refused
  refused(d.attempt({ authToken: d.sign('admin', 'not-the-secret-of-this-server') }))
  assert.equal(verifications(), 1)
  // the admin's, past its end: verified and refused
  refused(d.attempt({ authToken: d.sign('admin', SECRET, { iat: 1, exp: 2 }) }))
  assert.equal(verifications(), 2)
  // too long to be read: not even its claim
  const claims = d.calls.claimedUserId
  const forged = d.sign('admin', 'not-the-secret-of-this-server')
  const padded = length => `${forged}${'A'.repeat(length - forged.length)}`
  refused(d.attempt({ authToken: padded(600) }))
  refused(d.attempt({ authToken: padded(TOKEN_MAX_LENGTH + 1) }))
  assert.equal(d.calls.claimedUserId, claims)
  assert.equal(verifications(), 2)
  // at the cap, the longest it reads is read (and refused: its signature is not the secret's)
  assert.equal(TOKEN_MAX_LENGTH, 512)
  refused(d.attempt({ authToken: padded(TOKEN_MAX_LENGTH) }))
  assert.equal(verifications(), 3)
  // nothing of it was let in, and nothing was said
  assert.deepEqual(d.limits.stats(), { tracked: 1, active: 1, ranked: 0, users: 0 })
  assert.deepEqual(d.logs, [])
  // the positive control: the admin's own token
  assert.equal(d.attempt({ authToken: d.sign('admin') }).passed, true)
  assert.equal(verifications(), 4)
})

test('kept places at the door: the list is asked again about the user the verification names', t => {
  // a token that claims a listed user but verifies as another (a stand-in for the session tokens: the real ones
  // cannot do that, which is why the second question costs nothing)
  const d = door(t, { ranks: { admin: Ranks.ADMIN } })
  const route = loadRoute(d.limits, d.network, undefined, {
    claimedUserId: () => 'admin',
    readNow: () => ({ userId: 'visitor', renew: false }),
  })
  const reply = replyStub()
  let passed = false
  const request = { ws: true, raw: { socket: new EventEmitter() }, headers: {}, ip: '10.0.0.1' }
  route.preValidation({ ...request, query: { authToken: 'x' } }, reply, () => (passed = true))
  assert.equal(passed, false)
  assert.equal(reply.status, 503)
  // and a token that does not verify at all
  const none = loadRoute(d.limits, d.network, undefined, { claimedUserId: () => 'admin', readNow: () => null })
  none.preValidation({ ...request, query: { authToken: 'x' } }, replyStub(), () => (passed = true))
  assert.equal(passed, false)
  assert.equal(d.limits.stats().ranked, 0)
})

test('kept places at the door: a token signed with the previous secret is the admin; builders only when the places are theirs', t => {
  const d = door(t, { ranks: { admin: Ranks.ADMIN, builder: Ranks.BUILDER } })
  assert.equal(d.attempt({ authToken: d.sign('admin', PREVIOUS) }).passed, true, 'JWT_SECRET_PREVIOUS')
  refused(d.attempt({ authToken: d.sign('builder') }))
  const b = door(t, { env: { WS_RESERVED_RANK: 'builder' }, ranks: { admin: Ranks.ADMIN, builder: Ranks.BUILDER } })
  assert.equal(b.attempt({ authToken: b.sign('builder') }).passed, true, 'WS_RESERVED_RANK=builder')
  assert.equal(b.attempt({ authToken: b.sign('admin') }).passed, true, 'and admins share them')
  assert.match(b.logs[0], /^\[connections\] at WS_MAX_SOCKETS: "builder" \(stored rank builder\) came in/)
})

test('kept places at the door: none where admin is open to all, or with WS_RESERVED_SOCKETS=0; no token is read', t => {
  for (const env of [
    { ADMIN_CODE: null }, // no code outside production: open to all
    { ADMIN_CODE: null, ADMIN_OPEN: 'true', NODE_ENV: 'production' },
    { WS_RESERVED_SOCKETS: '0' },
  ]) {
    const d = door(t, { env, ranks: { admin: Ranks.ADMIN } })
    refused(d.attempt({ authToken: d.sign('admin') }))
    assert.deepEqual(d.calls, { readNow: 0, claimedUserId: 0 }, JSON.stringify(env))
    assert.deepEqual(d.logs, [])
  }
  // locked (production with neither): stored ranks still apply, and so do the kept places
  const locked = door(t, { env: { ADMIN_CODE: null, NODE_ENV: 'production' }, ranks: { admin: Ranks.ADMIN } })
  assert.equal(locked.attempt({ authToken: locked.sign('admin') }).passed, true)
})

test('kept places at the door: below the cap an admin takes an address place, with nothing read', t => {
  const d = door(t, { ranks: { admin: Ranks.ADMIN }, full: false })
  const first = d.attempt({ authToken: d.sign('admin') })
  assert.equal(first.passed, true)
  assert.deepEqual(d.calls, { readNow: 0, claimedUserId: 0 })
  assert.deepEqual(d.limits.stats(), { tracked: 1, active: 1, ranked: 0, users: 0 })
  // an admin behind an address at its own limit: the ranked path, under the user id
  const busy = door(t, { ranks: { admin: Ranks.ADMIN }, limits: { maxSockets: 0, concurrentPerIp: 1 } })
  const past = busy.attempt({ authToken: busy.sign('admin') })
  assert.equal(past.passed, true)
  assert.equal(busy.limits.stats().ranked, 1)
  assert.equal(busy.attempt({ authToken: busy.sign('admin') }).passed, true)
  refused(busy.attempt({ authToken: busy.sign('admin') }))
  assert.deepEqual(busy.logs, [
    `[connections] "admin" (stored rank admin) came in past their address's connection limits, on the path kept for ranked users`,
    '[connections] "admin" (stored rank admin) was refused: the 2 places kept for ranked users are in use, or they have 2 connections open on that path, or their connection rate is spent',
  ])
})

test('kept places at the door: a transport destroyed or closing while admitted gives its kept place back', t => {
  for (const duringRegistration of [false, true]) {
    const d = door(t, { ranks: { admin: Ranks.ADMIN } })
    const transport = new EventEmitter()
    transport.destroyed = !duringRegistration
    if (duringRegistration) {
      transport.once = (name, fn) => {
        EventEmitter.prototype.once.call(transport, name, fn)
        transport.destroyed = true
        transport.emit('close')
      }
    }
    d.attempt({ authToken: d.sign('admin') }, transport)
    assert.deepEqual(d.limits.stats(), { tracked: 1, active: 1, ranked: 0, users: 1 })
    transport.emit('close')
    assert.equal(d.limits.stats().ranked, 0, 'released once')
  }
})

test('the /ws route hands onConnection the user of a kept place, and nobody for any other lease', t => {
  const d = door(t, { ranks: { admin: Ranks.ADMIN }, full: false })
  const calls = []
  d.network.onConnection = (...args) => calls.push(args)
  let handler
  d.route.register({ get: (_path, _options, fn) => (handler = fn) })
  const version = String(PROTOCOL_VERSION)
  const open = (query, transport) =>
    handler(
      { close() {} },
      { query: { v: version, ...query }, headers: {}, ip: '10.0.0.1', raw: { socket: transport } }
    )
  // an address lease, the admin's token in the query or not
  const visitor = d.attempt({ authToken: d.sign('admin') })
  open({ authToken: d.sign('admin') }, visitor.transport)
  assert.deepEqual(calls.at(-1)[3], { rankedUser: null })
  // a kept place
  const ranked = d.attempt({ authToken: d.sign('admin') })
  assert.equal(ranked.passed, true)
  assert.equal(d.limits.stats().ranked, 1)
  open({ authToken: d.sign('admin') }, ranked.transport)
  assert.deepEqual(calls.at(-1)[3], { rankedUser: 'admin' })
  assert.equal(calls.length, 2)
})
