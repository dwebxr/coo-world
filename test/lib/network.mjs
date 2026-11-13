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
// loadNetwork({ replace, env, sourceRoot }) → net: the bundle's exports (below) plus `url` and `env` (the evaluation
//   these exports come from, and the environment it was evaluated with: a worker or a child process imports that
//   one with importNetwork({ url, env })) and `destroy`. `replace` and `sourceRoot` as buildServer takes them; a
//   file that ran against REAL_PHYSX_SOURCE_ROOT before passes it as `sourceRoot` (nothing else reads it).
//   The classes a test constructs (Socket, RpcError, Settings, …) are taken from `net`: they are the ones the
//   network's code sees, so identity and instanceof hold. One build per distinct (replace, sourceRoot) and process,
//   one evaluation per environment.
//   (`net` holds the exports' values: an override a setter changes is read through its module's namespace, such as
//   net.solanaGating.TOKEN_GATING_ENABLED.)
//   Entities is the real one; the entity classes it makes are stand-ins (`class {}`, as the old harness gave them)
//   unless `replace` gives others: the real ones bring the client's modules (three's examples, which touch
//   `document` at import when a test has put one in place) and no test of the network constructs them.
// makeNetwork(t, { net, world, log, init, env }) → a network made by the real constructor and init(), on a stub
//   world. world: fields the stub world has besides (or instead of) the ones below. init: what init() is given (db,
//   tokenBalanceService, evmHoldings, tipWatcher, evmSignatureVerifier, maxUploadSize). env: values on top of the
//   known environment and of net.env, for what the class reads when it runs (ADMIN_CODE, ASSETS_BASE_URL, …).
//   log: where the network's own once-per-subject lines go (its logOnce, inbound gate and write ledger, made with
//   that sink instead of the console). The test's end stops it (stopForFatal), which clears every timer the class
//   keeps, and puts the environment back.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ENV_TABLE } from './envTable.mjs'

const ENTRY = `
  export { ServerNetwork } from './src/core/systems/ServerNetwork.js'
  export { Socket } from './src/core/Socket.js'
  export { System } from './src/core/systems/System.js'
  export { Settings } from './src/core/systems/Settings.js'
  export { Entities } from './src/core/systems/Entities.js'
  export { Blueprints } from './src/core/systems/Blueprints.js'
  export { createLogOnce } from './src/core/extras/logOnce.js'
  export { createInboundGate } from './src/core/extras/inboundPolicy.js'
  export { createWriteLedger } from './src/core/extras/writeLedger.js'
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

export async function loadNetwork({ replace, env, sourceRoot } = {}) {
  // (imported here: a worker that only constructs from a bundle the main thread built never loads esbuild)
  const { buildServer } = await import('./serverBundle.mjs')
  const built = await buildServer(ENTRY, { replace: { ...STAND_IN_ENTITIES, ...replace }, sourceRoot })
  const evaluation = { ...testEnvironment(), ...known(env) }
  try {
    const { module, url } = await built.evaluate(evaluation)
    return { ...module, url, env: evaluation, destroy: built.destroy }
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

// The environment of a test, from its first makeNetwork to its end: each name the test changes is put back to the
// value it had before the first change
const environments = new WeakMap()
function testEnv(t, env) {
  let saved = environments.get(t)
  if (!saved) {
    environments.set(t, (saved = new Map()))
    t.after(() => {
      for (const [name, value] of saved) setEnv(name, value)
    })
  }
  for (const [name, value] of Object.entries(env)) {
    if (!saved.has(name)) saved.set(name, Object.hasOwn(process.env, name) ? process.env[name] : null)
    setEnv(name, value)
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

// `net`: what loadNetwork returned, or importNetwork in a worker or a child process
export function makeNetwork(t, { net, world: fields, log, init = {}, env } = {}) {
  assert.ok(net?.ServerNetwork && net.env, 'makeNetwork: pass what loadNetwork() or importNetwork() gave as `net`')
  testEnv(t, { ...testEnvironment(), ...net.env, ...known(env) })
  const world = stubWorld(net, fields)
  const network = new net.ServerNetwork(world)
  world.network = network
  // the constructor's socket check, a save timer after start(), a tip announcement: none outlives the test
  t.after(() => network.stopForFatal())
  if (log) {
    network.logOnce = net.createLogOnce(log)
    network.gate = net.createInboundGate({ log })
    network.writer = net.createWriteLedger({ log })
  }
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
