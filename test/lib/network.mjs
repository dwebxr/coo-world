// The network system for tests: the REAL ServerNetwork (src/core/systems/ServerNetwork.js), bundled with its real
// imports (serverBundle.mjs) and run in the test's own realm, as the server runs it. It replaces the cutting of the
// class out of its source text (networkHarness.mjs, persistenceHarness.mjs), which ran it in another realm with
// injected names.
//
// loadNetwork({ replace, env, sourceRoot }) → net: the bundle's exports (below) plus `url` and `destroy`.
//   `replace` and `sourceRoot` as bundleServer takes them; `sourceRoot` is REAL_PHYSX_SOURCE_ROOT unless given.
//   `env`: values process.env holds while the bundle is evaluated (bundleServer's importWith), for constants a
//   module computes at import; process.env is as before once this returns.
//   The classes a test constructs (Socket, RpcError, Settings, …) are taken from `net`: they are the ones the
//   network's code sees, so identity and instanceof hold. One bundle per distinct (replace, sourceRoot) and process.
//   (`net` holds the exports' values: an override a setter changes is read through its module's namespace, such as
//   net.solanaGating.TOKEN_GATING_ENABLED.)
//   Entities is the real one; the entity classes it makes are stand-ins (`class {}`, as the old harness gave them)
//   unless `replace` gives others: the real ones bring the client's modules (three's examples, which touch
//   `document` at import when a test has put one in place) and no test of the network constructs them.
// makeNetwork(t, { net, world, log, init }) → a network made by the real constructor and init(), on a stub world.
//   world: fields the stub world has besides (or instead of) the ones below. init: what init() is given (db,
//   tokenBalanceService, evmHoldings, tipWatcher, evmSignatureVerifier, maxUploadSize). log: where the network's own
//   once-per-subject lines go (its logOnce, inbound gate and write ledger, made with that sink instead of the
//   console). The test's end stops it (stopForFatal), which clears every timer the class keeps.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

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

export async function loadNetwork({ replace, env, sourceRoot = process.env.REAL_PHYSX_SOURCE_ROOT } = {}) {
  // (imported here: a worker that only constructs from a bundle the main thread built never loads esbuild)
  const { bundleServer } = await import('./serverBundle.mjs')
  const bundle = await bundleServer(ENTRY, {
    replace: { ...STAND_IN_ENTITIES, ...replace },
    sourceRoot: sourceRoot || undefined,
  })
  const module = env ? await bundle.importWith(env) : bundle.module
  return { ...module, url: bundle.url, destroy: bundle.destroy }
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

// `net`: what loadNetwork returned, or the namespace of its bundle imported elsewhere (a worker)
export function makeNetwork(t, { net, world: fields, log, init = {} } = {}) {
  assert.ok(net?.ServerNetwork, 'makeNetwork: pass the bundle loadNetwork() gave as `net`')
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
