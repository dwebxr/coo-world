// The network system for tests: the REAL ServerNetwork (src/core/systems/ServerNetwork.js), bundled with its real
// imports (serverBundle.mjs) and run in the test's own realm, as the server runs it. It replaces the cutting of the
// class out of its source text (networkHarness.mjs, persistenceHarness.mjs), which ran it in another realm with
// injected names.
//
// The environment is a known one. testEnvironment(): every name the server reads (envTable.mjs), but the system's
// PATH, HOME and TMPDIR, unset, as the old harness gave the class (`process: { env: {} }`); the defaults the code
// documents apply (SAVE_INTERVAL 60, no token gate, no EVM, no admin code, …). The bundle is evaluated with it
// (plus loadNetwork's `env`), and process.env holds it (plus makeNetwork's `env`) from makeNetwork to the test's end,
// when the values the test found are put back. What a developer's shell sets changes nothing in these tests.
//
// loadNetwork({ replace, env, sourceRoot, standIns }) → net: the bundle's exports (below) plus `url` and `env` (the
//   evaluation these exports come from, and the environment it was evaluated with: a worker or a child process imports
//   that one with importNetwork({ url, env })) and `destroy`. `replace` and `sourceRoot` as buildServer takes them; a
//   file that ran against REAL_PHYSX_SOURCE_ROOT before passes it as `sourceRoot` (nothing else reads it).
//   `standIns`: modules (repository paths) a test gives per network, as the old harness's `context` gave names to the
//   class: each becomes a CommonJS stand-in (serverBundle.mjs) whose every export, each time the bundle's code uses
//   it, is read from the object makeNetwork's `modules` gave for that path last, where that object has the name, and
//   from the real module otherwise (or when no object is given). A Proxy given there sees each of those reads. The
//   stand-in is the module's, for the whole bundle: where another module of the bundle imports it too (evm-gating.js
//   imports solana-gating.js), that one reads the object as well.
//   The classes a test constructs (Socket, RpcError, Settings, …) are taken from `net`: they are the ones the
//   network's code sees, so identity and instanceof hold. One build per distinct (replace, sourceRoot) and process,
//   one evaluation per environment.
//   (`net` holds the exports' values: an override a setter changes is read through its module's namespace, such as
//   net.solanaGating.TOKEN_GATING_ENABLED.)
//   Entities is the real one; the entity classes it makes are stand-ins (`class {}`, as the old harness gave them)
//   unless `replace` gives others (entityClasses(url): those a file of the tests exports): the real ones bring the
//   client's modules (three's examples, which touch `document` at import when a test has put one in place) and no
//   test of the network constructs them.
// makeNetwork(t, { net, world, log, init, env, modules }) → a network made by the real constructor and init(), on a
//   stub world. world: fields the stub world has besides (or instead of) the ones below. init: what init() is given
//   (db, tokenBalanceService, evmHoldings, tipWatcher, evmSignatureVerifier, maxUploadSize). env: values on top of the
//   known environment and of net.env, for what the class reads when it runs (ADMIN_CODE, ASSETS_BASE_URL, …).
//   modules: { path: object } for stand-ins of `net` (loadNetwork's standIns), set before the constructor runs and
//   kept until the test ends (null: the real module again); every network of the test sees the last one given.
//   log: where the network's own once-per-subject lines go: the console its constructor wires them to is `log`
//   (console.warn while the constructor runs, which its logOnce, inbound gate and relay drop keep; console.error for
//   the rest of the test, which its write ledger calls, as does every other line the class writes there, whichever
//   network writes it: a later makeNetwork's `log` takes it over). The constructor's own wiring is what runs.
//   The test's end stops every network it made (stopForFatal), which clears every timer the class keeps, and puts
//   the environment and the stand-ins' objects back.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { ENV_TABLE } from './envTable.mjs'

const ENTRY = `
  export { ServerNetwork } from './src/core/systems/ServerNetwork.js'
  export { Socket } from './src/core/Socket.js'
  export { System } from './src/core/systems/System.js'
  export { Settings } from './src/core/systems/Settings.js'
  export { Entities } from './src/core/systems/Entities.js'
  export { Blueprints } from './src/core/systems/Blueprints.js'
  export { createEventLedger } from './src/core/extras/appEventQueue.js'
  export { RpcError } from './src/server/evmRpc.js'
  export * as solanaGating from './src/server/solana-gating.js'
  export * as evmGating from './src/server/evm-gating.js'
`

const STAND_IN_ENTITIES = {
  'src/core/entities/App.js': 'export class App {}',
  'src/core/entities/PlayerLocal.js': 'export class PlayerLocal {}',
  'src/core/entities/PlayerRemote.js': 'export class PlayerRemote {}',
}

// replace entries: the entity classes Entities makes are the `App`, `PlayerLocal` and `PlayerRemote` that the module
// at `url` (a file of the tests) exports. The bundle has its own copy of that module: its classes are not the ones
// the test imports, and its state is not the test's.
export function entityClasses(url) {
  const file = JSON.stringify(fileURLToPath(url))
  return Object.fromEntries(
    ['App', 'PlayerLocal', 'PlayerRemote'].map(name => [
      `src/core/entities/${name}.js`,
      `export { ${name} } from ${file}`,
    ])
  )
}

// The objects the stand-ins read, per repository path (makeNetwork's `modules`): one table for the process, which the
// stand-in modules of every bundle look up
const GIVEN = Symbol.for('test/lib/network.mjs: modules')
const given = (globalThis[GIVEN] ??= new Map())
const standInSource = file => `
const real = require('real:')
const names = Object.keys(real)
const given = (globalThis[Symbol.for(${JSON.stringify(GIVEN.description)})] ??= new Map())
module.exports = new Proxy({}, {
  ownKeys: () => names,
  getOwnPropertyDescriptor: (_, name) =>
    names.includes(name) ? { configurable: true, enumerable: true, value: undefined } : undefined,
  get(_, name) {
    if (!names.includes(name)) return undefined
    const object = given.get(${JSON.stringify(file)})
    return object && name in object ? object[name] : real[name]
  },
})
`

// the system's own, which the server reads too and the tests leave as they are (and the build's define keys)
const KEPT = new Set(['PATH', 'HOME', 'TMPDIR', 'CLIENT', 'SERVER'])

// every name the server reads, unset (null); a name of a family (EVM_RPC_URL_*) is listed where the environment
// has one
export function testEnvironment(ambient = process.env) {
  const env = {}
  for (const name of Object.keys(ENV_TABLE)) {
    if (KEPT.has(name)) continue
    if (!name.endsWith('*')) env[name] = null
    else for (const key of Object.keys(ambient)) if (key.startsWith(name.slice(0, -1))) env[key] = null
  }
  return env
}

// undefined and null both mean unset; null is what survives a hand-off as JSON
const known = (env = {}) =>
  Object.fromEntries(Object.entries(env).map(([name, value]) => [name, value == null ? null : String(value)]))

const setEnv = (name, value) => {
  if (value == null) delete process.env[name]
  else process.env[name] = value
}

export async function loadNetwork({ replace, env, sourceRoot, standIns = [] } = {}) {
  // (imported here: a worker that only constructs from a bundle the main thread built never loads esbuild)
  const { buildServer } = await import('./serverBundle.mjs')
  for (const file of standIns) assert.ok(!replace?.[file], `loadNetwork: ${file} is both replaced and a stand-in`)
  const forwarded = Object.fromEntries(standIns.map(file => [file, { commonjs: standInSource(file) }]))
  const built = await buildServer(ENTRY, { replace: { ...STAND_IN_ENTITIES, ...replace, ...forwarded }, sourceRoot })
  const evaluation = { ...testEnvironment(), ...known(env) }
  try {
    const { module, url } = await built.evaluate(evaluation)
    return { ...module, url, env: evaluation, standIns: [...standIns], destroy: built.destroy }
  } catch (err) {
    built.destroy()
    throw err
  }
}

// In a worker or a child process: the evaluation loadNetwork made in the test ({ url, env } of its result), with
// its environment set first (a fresh process or worker starts from its own, which the query in the url does not
// change). That environment stays: the worker or process is the test's.
export async function importNetwork({ url, env }) {
  for (const [name, value] of Object.entries(env)) setEnv(name, value)
  return { ...(await import(url)), url, env }
}

// What a test changes through makeNetwork, undone in one hook at its end (node:test runs no hook of a test after one
// that threw): each network it made is stopped (stopForFatal: the constructor's socket check, a save timer after
// start(), a tip announcement), whatever another one's stop threw (a test's stand-in that fails when it is
// touched), so that none of their timers outlives the test; then each stand-in's object and each name of the
// environment the test changed is what it was before the test's first change of it. The hook throws the first
// error a stop threw, once all that is done.
const tests = new WeakMap()
function testState(t) {
  let state = tests.get(t)
  if (state) return state
  state = { networks: [], modules: new Map(), env: new Map() }
  tests.set(t, state)
  t.after(() => {
    let failure = null
    for (const network of state.networks) {
      try {
        network.stopForFatal()
      } catch (err) {
        failure ??= err
      }
    }
    for (const [file, object] of state.modules) {
      if (object === undefined) given.delete(file)
      else given.set(file, object)
    }
    for (const [name, value] of state.env) setEnv(name, value)
    if (failure) throw failure
  })
  return state
}

// The environment of a test, from its first makeNetwork to its end
function testEnv(t, env) {
  const saved = testState(t).env
  for (const [name, value] of Object.entries(env)) {
    if (!saved.has(name)) saved.set(name, Object.hasOwn(process.env, name) ? process.env[name] : null)
    setEnv(name, value)
  }
}

// The objects of the stand-ins (makeNetwork's `modules`) during a test (none, for a test that follows another
// one's end)
function testModules(t, net, modules) {
  for (const file of Object.keys(modules)) {
    assert.ok(
      net.standIns?.includes(file),
      `makeNetwork: ${file} is not a stand-in of this bundle (loadNetwork's standIns)`
    )
  }
  const saved = testState(t).modules
  for (const [file, object] of Object.entries(modules)) {
    if (!saved.has(file)) saved.set(file, given.get(file))
    if (object == null) given.delete(file)
    else given.set(file, object)
  }
}

// The world the old harnesses gave the network (networkHarness.mjs's makeNetwork): the app event ledger and the
// voice system the disconnect path and the socket check touch, and no entities unless a test brings its own
export function stubWorld(net, fields = {}) {
  return {
    apps: { eventLedger: net.createEventLedger() },
    livekit: { clearModifiers() {} },
    entities: { items: new Map() },
    ...fields,
  }
}

// console.warn is `warn` while `construct` runs: what takes it then (createLogOnce(), createInboundGate(),
// createRelayDrop() default to it) keeps it
function constructedWithWarn(warn, construct) {
  const original = console.warn
  console.warn = warn
  try {
    return construct()
  } finally {
    console.warn = original
  }
}

// `net`: what loadNetwork returned, or importNetwork in a worker or a child process
export function makeNetwork(t, { net, world: fields, log, init = {}, env, modules } = {}) {
  assert.ok(net?.ServerNetwork && net.env, 'makeNetwork: pass what loadNetwork() or importNetwork() gave as `net`')
  testEnv(t, { ...testEnvironment(), ...net.env, ...known(env) })
  if (modules) testModules(t, net, modules)
  const world = stubWorld(net, fields)
  if (log) t.mock.method(console, 'error', log)
  const network = log ? constructedWithWarn(log, () => new net.ServerNetwork(world)) : new net.ServerNetwork(world)
  world.network = network
  testState(t).networks.push(network)
  network.init(init)
  return network
}

// a connection as the ws library gives it: what is written stays in `packets`, its write callbacks in `pending`
// until `drain()`, and `terminate()` closes it as the transport would
export function fakeWs() {
  const ws = new EventEmitter()
  ws.readyState = 1
  ws.pending = []
  ws.packets = []
  ws.terminations = 0
  ws.send = (packet, cb) => {
    ws.packets.push(packet)
    ws.pending.push(cb)
  }
  ws.ping = (data, mask, cb) => {
    assert.equal(data, undefined)
    assert.equal(mask, false)
    ws.pending.push(cb)
  }
  ws.terminate = () => {
    ws.terminations++
    if (ws.readyState === 3) return
    ws.readyState = 3
    ws.emit('close')
  }
  ws.close = ws.terminate
  ws.drain = () => {
    for (const cb of ws.pending.splice(0)) cb()
  }
  return ws
}
