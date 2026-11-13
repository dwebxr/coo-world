// The network system for tests: the REAL ServerNetwork (src/core/systems/ServerNetwork.js), bundled with its real
// imports (serverBundle.mjs) and run in the test's own realm, as the server runs it. It replaces the cutting of the
// class out of its source text (by networkHarness.mjs, since removed, and persistenceHarness.mjs), which ran it in
// another realm with injected names.
//
// The environment is a known one. testEnvironment(): every name the server reads (envTable.mjs), but the system's
// PATH, HOME and TMPDIR, unset, as the old harness gave the class (`process: { env: {} }`); the defaults the code
// documents apply (SAVE_INTERVAL 60, no token gate, no EVM, no admin code, …). The bundle is evaluated with it
// (plus loadNetwork's `env`), and process.env holds it (plus makeNetwork's `env`) from makeNetwork to the test's end,
// when the values the test found are put back. What a developer's shell sets changes nothing in these tests.
//
// That environment, and the objects of the stand-ins (below), are the process's: tests that make networks must not
// run concurrently. One test holds them from its first makeNetwork to its end, and a makeNetwork of another test in
// that time throws ("the network helper holds process-wide state: …").
//
// loadNetwork({ replace, env, sourceRoot, standIns }) → net: the bundle's exports (below) plus `url` and `env` (the
//   evaluation these exports come from, and the environment it was evaluated with: a worker or a child process imports
//   that one with importNetwork({ url, env })) and `destroy`. `replace` and `sourceRoot` as buildServer takes them; a
//   file that ran against REAL_PHYSX_SOURCE_ROOT before passes it as `sourceRoot` (nothing else reads it). Without a
//   `sourceRoot` of its own, NETWORK_SOURCE_ROOT is the one where it is set: every network of the run is then bundled
//   from that checkout's src/core and src/server, to run the tests as they are against the product code of another
//   commit (`NETWORK_SOURCE_ROOT=<checkout> node --test test/serverEvmWallet.test.js`; the checkout needs its src/
//   only). It is a setting of the test run, read here only, not a name the server reads. In such a bundle the timers'
//   line of a module of TIMED_FILES goes only where the bundle has the module (below).
//   `standIns`: modules (repository paths) a test gives per network, as the old harness's `context` gave names to the
//   class: each becomes a CommonJS stand-in (serverBundle.mjs) whose every export, each time the bundle's code uses
//   it, is read from the object makeNetwork's `modules` gave for that path last, where that object has the name, and
//   from the real module otherwise (or when no object is given). A Proxy given there sees each of those reads that is
//   left in the bundle: esbuild removes a read of a module's export whose value is not used (a bare
//   `void solanaGating.WALLET_HOST`), as the server's own build does. The stand-in is the module's, for the whole bundle: where another module of the bundle imports it too (evm-gating.js
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
// makeNetwork(t, { net, world, log, init, env, modules, timers }) → a network made by the real constructor and
//   init(), on a stub world. world: fields the stub world has besides (or instead of) the ones below. init: what
//   init() is given (db, tokenBalanceService, evmHoldings, tipWatcher, evmSignatureVerifier, maxUploadSize). env:
//   values on top of the known environment and of net.env, for what the class reads when it runs (ADMIN_CODE,
//   ASSETS_BASE_URL, …).
//   modules: { path: object } for stand-ins of `net` (loadNetwork's standIns), set before the constructor runs and
//   kept until the test ends (null: the real module again); every network of the test sees the last one given.
//   timers: an object with any of setTimeout, clearTimeout, setInterval and clearInterval, which the class's own calls
//   of those names use (the names it lacks are the global functions, read at each call), as the old harness injected
//   them into the class: test/lib/networkTimers.mjs is imported on the first line of the bundle's ServerNetwork.js and
//   of each module of src/server/network/ whose functions (members of the class, moved there) call them: tips.js, a tip
//   announcement that waits (TIMED_FILES below; serverBundle.mjs `prepend`). Only those files' calls: the other modules
//   (a tip watcher, the admin code's brake) call the globals. A member moved with a timer call to a module of its own
//   needs that file in TIMED_FILES. Set before the constructor runs (its socket check is a setInterval) and kept until
//   the test ends, after its networks are stopped (stopForFatal clears with it); every network of the test makes its
//   timers with the last one given (there is one table for the process). A timer whose handle is an object or a
//   function is cancelled by the object that made it, whichever is the last one by then (a test with two networks, each
//   with its own fake); a handle that is a number, or one the class did not make through here, is cancelled by the last
//   one given: two fakes that hand out numbers leave the first one's timers.
//   (Date is the global one: node:test's mock timers reach it in this realm.)
//   log: where the network's own once-per-subject lines go: the console its constructor wires them to is `log`
//   (console.warn while the constructor runs, which its logOnce, inbound gate and relay drop keep; console.error for
//   the rest of the test, which its write ledger calls, as does every other line the class writes there, whichever
//   network writes it: a later makeNetwork's `log` takes it over). The constructor's own wiring is what runs.
//   The test's end stops every network it made (stopForFatal), which clears every timer the class keeps, and puts
//   the environment and the stand-ins' objects back.
// inside(t, check) → what `check` returns: for an assertion a test makes in code the network calls and catches (a
//   handler the flush dispatches, a collaborator of a join, the write ledger's ping), which the class takes for a
//   failure of its own and only logs or works around, so that the test would not fail on it. `check` runs as it is,
//   and so does reading what it returns (a `then` getter); what either throws is thrown on, as before, and is reported
//   again: by the end of test `t` while that test holds the helper and its end has not reported yet (a check that fails
//   while the end stops the networks is reported by it, after everything is put back, unless a stop failed there
//   first); otherwise (a test that never made a network, or whose end has reported, as for a check in a later hook of
//   it) it is thrown from a turn of its own, scheduled from the async context this module was evaluated in, where
//   node:test reports it as an uncaught exception of the file and charges no test with it (not the one that happens
//   to run then). A check is synchronous: one that returns a thenable is refused with a TypeError, reported the same
//   way, and a rejection of it is handled (not an unhandled rejection besides). fakeWs's own check of a ping is made
//   this way, for the test that held the helper when the fake was made.
//   What it does not do, said plainly:
//   - it sees only the checks written through it: an assertion in a stub that a catch hides, without it, stays hidden;
//   - a failure that nothing catches on its way (it reaches the test) is reported twice: where it is thrown, and again
//     by the end or as an uncaught exception;
//   - the end reports the first failure it recorded, not every one;
//   - a check that must wait is refused, not awaited: such a check is made after the act;
//   - a failure thrown outside every test fails the file and names no test: which one caused it is in its stack;
//   - it is per process: a check in a worker or a child process reports in that process only;
//   - a fake connection made while no test holds the helper (at a file's top, in a `before` hook) has no owner: its
//     failing check is an uncaught exception of the file;
//   - it counts on this module being evaluated outside every test (a test file imports it at its top): imported for
//     the first time from within a test, its throws outside would be charged to that test.
import assert from 'node:assert/strict'
import { AsyncResource } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { ENV_TABLE } from './envTable.mjs'
import * as classTimers from './networkTimers.mjs'

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

// the class's own timers go through test/lib/networkTimers.mjs (makeNetwork's `timers`): those of ServerNetwork.js
// and of the network's modules that call them (its members moved there: tips.js, a tip announcement that waits).
// Every file's line is required (a bundle without the file is an error, and so is a path that is no file), but in a
// bundle of a `sourceRoot` a module's goes only where that bundle has the module: another checkout's class may not
// import it (one from before its members moved there). The class's line is required there too.
const NETWORK = 'src/core/systems/ServerNetwork.js'
const TIMED_FILES = [NETWORK, 'src/server/network/tips.js']
const TIMER_NAMES = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
const TIMER_IMPORT = `import { ${TIMER_NAMES.join(', ')} } from ${JSON.stringify(fileURLToPath(new URL('./networkTimers.mjs', import.meta.url)))};`
const prependFor = sourceRoot =>
  Object.fromEntries(
    TIMED_FILES.map(file => [
      file,
      file === NETWORK || !sourceRoot ? TIMER_IMPORT : { text: TIMER_IMPORT, optional: true },
    ])
  )
const timerTable = (globalThis[Symbol.for('test/lib/network.mjs: timers')] ??= { current: null })

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

export async function loadNetwork({
  replace,
  env,
  sourceRoot = process.env.NETWORK_SOURCE_ROOT || undefined,
  standIns = [],
} = {}) {
  // (imported here: a worker that only constructs from a bundle the main thread built never loads esbuild)
  const { buildServer } = await import('./serverBundle.mjs')
  for (const file of standIns) assert.ok(!replace?.[file], `loadNetwork: ${file} is both replaced and a stand-in`)
  const forwarded = Object.fromEntries(standIns.map(file => [file, { commonjs: standInSource(file) }]))
  const built = await buildServer(ENTRY, {
    replace: { ...STAND_IN_ENTITIES, ...replace, ...forwarded },
    prepend: prependFor(sourceRoot),
    sourceRoot,
  })
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
// that threw): each network it made is stopped (stopForFatal), whatever another one's stop threw (a test's stand-in
// that fails when it is touched); the timers the class keeps in its fields (the socket check, a save timer, a tip
// announcement) are cleared even where its stop threw part way (a collaborator's own, such as those of a tip watcher
// whose stop threw, are not); then the class's timers, each stand-in's object and each name of the environment the
// test changed are what they were before the test's first change of them. The hook throws what the first stop that
// failed threw (`throw 0` included), once all that is done.
// That state is the process's (process.env, the objects the stand-ins read, the class's timers): one test holds it, from its first
// makeNetwork to its end, and a makeNetwork of another test meanwhile throws. node:test runs a file's tests one after
// another unless they ask for concurrency; a test whose subtest makes networks makes its own after that subtest.
const CONCURRENT = 'the network helper holds process-wide state: tests that use it must not run concurrently'
let holder = null
const tests = new WeakMap()
const ENDED = 'makeNetwork after the end of its test: the network would not be stopped, nor the environment put back'
function testState(t) {
  let state = tests.get(t)
  // (a test's state is used up at its end: a network made later, from another hook of the test, would be left. So
  // would the first one of a test that is over already: a body that timed out and goes on running)
  if (state?.ended || t.signal?.aborted) throw new Error(ENDED)
  if (state) return state
  if (holder) throw new Error(CONCURRENT)
  state = {
    networks: [],
    modules: new Map(),
    env: new Map(),
    timers: null, // { saved }: what the class's timers were before the test's first `timers`
    ended: false,
    threw: false,
    failure: undefined,
    inside: [], // what a check made inside the class's own catch threw (inside())
    reported: false, // the end has reported (or, after an earlier hook threw, cannot): inside() throws outside then
  }
  tests.set(t, state)
  holder = t
  // the end, once
  const end = () => {
    if (state.ended) return
    state.ended = true
    for (const network of state.networks) {
      try {
        network.stopForFatal()
      } catch (err) {
        if (!state.threw) state.failure = err
        state.threw = true
        // the stop ended half way: what it had not reached is cancelled as the class would have, with the timers
        // the test gave (each by the object that made it, or by the one in the table, still the test's here; a
        // handle of the test's own means nothing to the global functions below).
        for (const cancel of [
          () => classTimers.clearTimeout(network.saveTimerId),
          () => classTimers.clearInterval(network.socketIntervalId),
          () => network.tipAnnounce?.timer && classTimers.clearTimeout(network.tipAnnounce.timer),
        ]) {
          try {
            cancel()
          } catch {
            // not reported: the stop's own error is
          }
        }
      } finally {
        clearTimeout(network.saveTimerId)
        clearInterval(network.socketIntervalId)
        if (network.tipAnnounce?.timer) clearTimeout(network.tipAnnounce.timer)
      }
    }
    if (state.timers) timerTable.current = state.timers.saved
    for (const [file, object] of state.modules) {
      if (object === undefined) given.delete(file)
      else given.set(file, object)
    }
    for (const [name, value] of state.env) setEnv(name, value)
    holder = null
  }
  t.after(() => {
    end()
    state.reported = true
    if (state.threw) throw state.failure
    if (state.inside.length) throw state.inside[0]
  })
  // node:test runs no later hook of a test once one has thrown: a hook registered BEFORE the first makeNetwork that
  // throws would leave all of this standing, and the next test would be refused as concurrent. The test's signal
  // is aborted when the test is over, whatever its hooks did; what a stop threw is then no longer reported (the
  // test has failed already, with the hook's own error). (A stand-in context without a signal, as a child process
  // that makes one network and exits hands in, has no later test to protect.)
  t.signal?.addEventListener('abort', () => {
    end()
    // (the hook above did not run: a check that failed meanwhile is thrown outside, as one after the end is)
    if (state.reported) return
    state.reported = true
    for (const err of state.inside) throwOutside(err)
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

// The class's timers (makeNetwork's `timers`) during a test
function testTimers(t, timers) {
  // (other names an object has, a fake's own record of its timers, say, are not read)
  assert.ok(
    typeof timers === 'object' && TIMER_NAMES.some(name => typeof timers[name] === 'function'),
    `makeNetwork: timers is an object with any of ${TIMER_NAMES.join(', ')}`
  )
  const state = testState(t)
  state.timers ??= { saved: timerTable.current }
  timerTable.current = timers
}

// The world the old harnesses gave the network (the removed networkHarness.mjs's makeNetwork): the app event ledger and the
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
export function makeNetwork(t, { net, world: fields, log, init = {}, env, modules, timers } = {}) {
  assert.ok(net?.ServerNetwork && net.env, 'makeNetwork: pass what loadNetwork() or importNetwork() gave as `net`')
  testEnv(t, { ...testEnvironment(), ...net.env, ...known(env) })
  if (modules) testModules(t, net, modules)
  if (timers) testTimers(t, timers)
  const world = stubWorld(net, fields)
  if (log) t.mock.method(console, 'error', log)
  const network = log ? constructedWithWarn(log, () => new net.ServerNetwork(world)) : new net.ServerNetwork(world)
  world.network = network
  testState(t).networks.push(network)
  network.init(init)
  return network
}

// See the top
const SYNCHRONOUS =
  'inside(): the check must be synchronous; it returned a thenable, whose failure would come after the catch it is for'
export function inside(t, check) {
  try {
    const result = check()
    // (inside the try: reading `then` runs a getter, which can fail as the check does)
    const then = result?.then
    if (typeof then === 'function') {
      // a refused promise that rejects would surface as an unhandled rejection as well: it is handled here
      try {
        then.call(result, undefined, () => {})
      } catch {
        // (a thenable whose `then` throws: refused all the same)
      }
      throw new TypeError(SYNCHRONOUS)
    }
    return result
  } catch (err) {
    report(t, err)
    throw err
  }
}

// a failure inside() saw: to the end of the test that holds the helper and has not reported, else out of every catch.
// The throw is scheduled from the async context this module was evaluated in (a test file imports it at its top, outside
// every test): scheduled from the caller's, it would be charged by node:test to whatever test that context belongs to,
// a later test that pinged an earlier test's connection, say.
const outsideTests = new AsyncResource('network.mjs: outside every test')
function throwOutside(err) {
  outsideTests.runInAsyncScope(() =>
    setImmediate(() => {
      throw err
    })
  )
}
function report(t, err) {
  const state = t ? tests.get(t) : undefined
  if (state && !state.reported) state.inside.push(err)
  else throwOutside(err)
}

// a connection as the ws library gives it: what is written stays in `packets`, its write callbacks in `pending`
// until `drain()`, and `terminate()` closes it as the transport would. It belongs to `owner`: by default the test that
// holds the helper when it is made (none: a fake made outside such a test), whose end reports what its checks find
export function fakeWs(owner = holder) {
  const ws = new EventEmitter()
  ws.readyState = 1
  ws.pending = []
  ws.packets = []
  ws.terminations = 0
  ws.send = (packet, cb) => {
    ws.packets.push(packet)
    ws.pending.push(cb)
  }
  // (the write ledger catches a ping that throws and takes the connection for a dead one: the check is reported for
  // the fake's own test, or thrown outside the class: inside())
  ws.ping = (data, mask, cb) => {
    inside(owner, () => {
      assert.equal(data, undefined)
      assert.equal(mask, false)
    })
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
