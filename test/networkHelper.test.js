// The helpers that run the real network in tests (test/lib/network.mjs, test/lib/serverBundle.mjs): what `replace`
// and `env` do to the bundled ServerNetwork, which classes a test shares with it, and what a test leaves behind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { bundleServer, heldBundles } from './lib/serverBundle.mjs'
import { entityClasses, fakeWs, inside, loadNetwork, makeNetwork } from './lib/network.mjs'
import * as classTimers from './lib/networkTimers.mjs'
import { readPacket, writeClientPacket } from '../src/core/packets.js'
import { readKickEnv } from '../src/server/kickList.js'

const net = await loadNetwork()
const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length

// settings a developer's shell may hold, each of which changed what the old tests or a first version of this helper
// saw (a save timer, the token gate, EVM, the admin code, the assets URL, the connection limit, the kick list), and
// NETWORK_SOURCE_ROOT, which an earlier version of the helper took for a checkout to bundle the network from (here a
// folder that exists and is no checkout)
const AMBIENT = {
  SAVE_INTERVAL: '0',
  PUBLIC_TOKEN_MINT: 'So11111111111111111111111111111111111111112',
  PUBLIC_EVM_CHAIN_IDS: '137',
  PUBLIC_API_URL: 'https://ambient.example/api',
  WS_MAX_SOCKETS: '7',
  ADMIN_CODE: 'an-ambient-code',
  ASSETS_BASE_URL: 'https://ambient.example/assets',
  KICK_MINUTES: 'not a number',
  NETWORK_SOURCE_ROOT: os.tmpdir(),
}
// process.env as it was for `names`, to put back after a test that changes it
function keepEnvironment(t, names) {
  const saved = names.map(name => [name, process.env[name]])
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

// a network of `from` that start() can hydrate: an empty database and stand-in settings
function startable(t, from) {
  const network = makeNetwork(t, {
    net: from,
    world: { settings: { deserialize() {}, serialize: () => ({}), setHasAdminCode() {}, on() {} } },
    init: { db: table => (table === 'config' ? { where: () => ({ first: async () => undefined }) } : []) },
  })
  network.world.blueprints = new from.Blueprints(network.world)
  return network
}

test('network helper: the class is the real one, constructed and initialised, in the realm of the test', t => {
  const network = makeNetwork(t, { net })
  // what the constructor and init() set, not the helper
  assert.equal(network.isServer, true)
  assert.equal(network.id, 0)
  assert.equal(network.tokenBalanceService, null, 'token gating is off in this environment')
  assert.ok(network.tipSeen instanceof Map)
  assert.equal(network.world.network, network)
  // the test's own Map and Object: no realm of its own
  assert.equal(Object.getPrototypeOf(network.sockets), Map.prototype)
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  const record = network.joinRecord('u', { name: 'U', avatar: null, sessionAvatar: null, rank: 0 })
  assert.equal(Object.getPrototypeOf(record), Object.prototype)
  assert.equal(Object.getPrototypeOf(record.position), Array.prototype)
})

test('network helper: a packet from a socket the test makes goes through the real dispatch', t => {
  const logs = []
  const network = makeNetwork(t, { net, log: line => logs.push(line) })
  const player = { data: { id: 'p' }, isBuilder: () => false }
  const socket = new net.Socket({ id: 'p', ws: fakeWs(), network, player })
  network.sockets.set('p', socket)
  socket.ws.emit('message', writeClientPacket('ping', 42))
  network.flush()
  assert.deepEqual(socket.ws.packets.map(readPacket), [['onPong', 42]])
  // the network's own lines go to `log`: its inbound gate's
  socket.ws.emit('message', Uint8Array.of(0xff))
  network.flush()
  assert.equal(logs.length, 1)
  // and its write ledger's
  assert.equal(network.write(socket.ws, new Uint8Array(512 * 1024 + 1)), false)
  assert.equal(logs.length, 2)
  assert.match(logs[1], /refused: packet too large/)
})

test('network helper: no timer of the class outlives the test that made it', async t => {
  const before = timers()
  let network
  await t.test('a test that starts a network', async t => {
    network = startable(t, net)
    t.mock.method(console, 'log', () => {})
    t.mock.method(console, 'error', () => {})
    await network.start()
    // the constructor's socket check and the first save
    assert.ok(network.saveTimerId)
    assert.equal(timers(), before + 2)
  })
  assert.equal(network.stopping, true)
  assert.equal(timers(), before)
})

test('network helper: replace puts a test source in place of a whole module', async t => {
  const replaced = await loadNetwork({
    replace: {
      'src/server/kickList.js': `
        export const readKickEnv = env => ({ read: typeof env })
        export const createKickList = config => ({ config })
      `,
    },
  })
  t.after(replaced.destroy)
  assert.deepEqual(makeNetwork(t, { net: replaced }).kicks(), { config: { read: 'object' } })
  // the bundle without it is unchanged
  assert.equal(typeof makeNetwork(t, { net }).kicks().add, 'function')
})

test('network helper: replace keeps the real module and overrides one export, changed between calls', async t => {
  const gated = await loadNetwork({
    replace: {
      'src/server/solana-gating.js': `
        export * from 'real:'
        export let TOKEN_GATING_ENABLED = true
        export function setTokenGating(value) {
          TOKEN_GATING_ENABLED = value
        }
      `,
    },
  })
  t.after(gated.destroy)
  const service = { get: () => ({ known: true, balance: 0 }) }
  assert.equal(makeNetwork(t, { net: gated, init: { tokenBalanceService: service } }).tokenBalanceService, service)
  // a live binding: no second bundle
  gated.solanaGating.setTokenGating(false)
  assert.equal(makeNetwork(t, { net: gated, init: { tokenBalanceService: service } }).tokenBalanceService, null)
  // the rest of the module is the real one
  assert.equal(gated.solanaGating.isWalletAddress('11111111111111111111111111111111'), true)
  assert.equal(gated.solanaGating.REQUIRED_TOKEN_AMOUNT, net.solanaGating.REQUIRED_TOKEN_AMOUNT)
})

test('network helper: a stand-in reads each export from the object the test gives, each time the code uses it', async t => {
  const SOLANA = 'src/server/solana-gating.js'
  const swapped = await loadNetwork({ standIns: [SOLANA] })
  t.after(swapped.destroy)
  // none given: the real module (this test makes its own networks after its subtest's: one test at a time)
  assert.equal(swapped.solanaGating.REQUIRED_TOKEN_AMOUNT, net.solanaGating.REQUIRED_TOKEN_AMOUNT)
  const reads = []
  const gate = new Proxy(
    { TOKEN_GATING_ENABLED: true, WALLET_HOST: 'stand-in.example' },
    { get: (target, name) => (reads.push(name), target[name]) }
  )
  const service = { get: () => ({ known: true, balance: 0 }) }
  await t.test('a test that gives one', t => {
    const network = makeNetwork(t, {
      net: swapped,
      init: { tokenBalanceService: service },
      modules: { [SOLANA]: gate },
    })
    // init read the switch from it, once
    assert.equal(network.tokenBalanceService, service)
    assert.deepEqual(reads, ['TOKEN_GATING_ENABLED'])
    // a name it lacks is the real module's (and was not asked of it)
    assert.equal(swapped.solanaGating.REQUIRED_TOKEN_AMOUNT, net.solanaGating.REQUIRED_TOKEN_AMOUNT)
    assert.deepEqual(reads, ['TOKEN_GATING_ENABLED'])
    // another module of the bundle that imports it reads it too (evm-gating.js re-exports the host)
    assert.equal(swapped.evmGating.WALLET_HOST, 'stand-in.example')
    // the last one given is the one read, by every network
    makeNetwork(t, { net: swapped, modules: { [SOLANA]: { TOKEN_GATING_ENABLED: false } } })
    assert.equal(swapped.solanaGating.TOKEN_GATING_ENABLED, false)
    assert.equal(network.tokenBalanceService, service, 'what init made stays')
  })
  // the test's end gives the real module back
  assert.equal(swapped.solanaGating.TOKEN_GATING_ENABLED, false)
  assert.equal(swapped.evmGating.WALLET_HOST, net.evmGating.WALLET_HOST)
  assert.equal(makeNetwork(t, { net: swapped, init: { tokenBalanceService: service } }).tokenBalanceService, null)
  // a module that is no stand-in of the bundle is refused, and so is one both replaced and a stand-in
  assert.throws(() => makeNetwork(t, { net, modules: { [SOLANA]: gate } }), /not a stand-in of this bundle/)
  await assert.rejects(
    loadNetwork({ replace: { [SOLANA]: `export * from 'real:'` }, standIns: [SOLANA] }),
    /both replaced and a stand-in/
  )
})

test('server bundle: a CommonJS replacement is read by property each time an export is used', async t => {
  const counted = await bundleServer(
    `import { readKickEnv } from './src/server/kickList.js'
    export const use = () => readKickEnv
    export * as kickList from './src/server/kickList.js'`,
    {
      replace: {
        'src/server/kickList.js': {
          commonjs: `
            const real = require('real:')
            let reads = 0
            module.exports = {
              get readKickEnv() {
                reads++
                return real.readKickEnv
              },
              get reads() {
                return reads
              },
            }
          `,
        },
      },
    }
  )
  t.after(counted.destroy)
  const { use, kickList } = counted.module
  const before = kickList.reads
  // the real module behind it, read again at each use (an ES module's import would be one binding)
  assert.deepEqual(use()({ KICK_MINUTES: '5' }), readKickEnv({ KICK_MINUTES: '5' }))
  use()
  assert.equal(kickList.reads, before + 2)
  await assert.rejects(
    bundleServer(`export * from './src/server/kickList.js'`, {
      replace: { 'src/server/kickList.js': `export * from 'commonjs:'` },
    }),
    /only for a CommonJS replacement/
  )
})

test("network helper: timers a test gives are the class's own; its imports, and a name not given, call the globals", async t => {
  // a module the class imports, replaced by one that hands out the setTimeout it sees
  const own = await loadNetwork({
    replace: {
      'src/server/kickList.js': `
        import { createKickList as real } from 'real:'
        export * from 'real:'
        export const createKickList = config => Object.assign(real(config), { setTimeout })
      `,
    },
  })
  t.after(own.destroy)
  const before = timers()
  const calls = []
  const fake = {
    setTimeout: (fn, ms) => (calls.push(['setTimeout', ms]), { fn, ms }),
    clearTimeout: timer => calls.push(['clearTimeout', timer?.ms ?? timer]),
  }
  const pinged = (network, ms) => {
    const socket = new own.Socket({ id: 'p', ws: fakeWs(), network })
    network.sockets.set('p', socket)
    return { socket, answered: network.answersPing(socket, ms) }
  }
  await t.test('a test that gives them', async t => {
    assert.throws(() => makeNetwork(t, { net: own, timers: { setImmediate() {} } }), /timers is an object with any of/)
    const network = makeNetwork(t, { net: own, timers: fake })
    // the constructor's socket check: no setInterval given, so the global one
    assert.equal(timers(), before + 1)
    // a takeover's ping: its deadline is the class's own setTimeout
    const { socket, answered } = pinged(network, 1234)
    assert.deepEqual(calls, [['setTimeout', 1234]])
    socket.ws.emit('pong')
    assert.equal(await answered, true)
    assert.equal(timers(), before + 1)
    // a module the class imports calls the global one
    assert.equal(network.kicks().setTimeout, globalThis.setTimeout)
    // a tip announcement waiting when the test ends
    network.tipAnnounce.timer = { ms: 'announcement' }
    calls.length = 0
  })
  // the end stopped the network with them (stopForFatal: the save timer, none here, and the announcement), and
  // cleared the global socket check
  assert.deepEqual(calls, [
    ['clearTimeout', null],
    ['clearTimeout', 'announcement'],
  ])
  assert.equal(timers(), before)
  // then put the globals back: a network of the next test calls them (its socket check, and the ping's deadline,
  // which ends the wait unanswered)
  const { answered } = pinged(makeNetwork(t, { net: own }), 5)
  assert.equal(timers(), before + 2)
  assert.equal(await answered, false)
  assert.equal(calls.length, 2)
})

test("network helper: the timers a test gives are those of the class's code moved to src/server/network/ too (a tip announcement that waits)", async t => {
  // a module the class imports, replaced by one that hands out the setTimeout it sees
  const own = await loadNetwork({
    replace: {
      'src/server/kickList.js': `
        import { createKickList as real } from 'real:'
        export * from 'real:'
        export const createKickList = config => Object.assign(real(config), { setTimeout })
      `,
    },
  })
  t.after(own.destroy)
  const before = timers()
  const calls = []
  const fake = {
    setTimeout: (fn, ms) => (calls.push(['setTimeout', ms]), { fn, ms }),
    clearTimeout: timer => calls.push(['clearTimeout', timer?.ms ?? timer]),
  }
  const interval = own.evmGating.TIP_ANNOUNCE_INTERVAL_MS
  await t.test('a test that gives them', t => {
    const announced = []
    const network = makeNetwork(t, {
      net: own,
      timers: fake,
      world: { chat: { add: line => announced.push(line.body) } },
    })
    // no announcement may go out now (none left, none earned back yet): the line waits, on the timer that
    // drainTipAnnouncements sets in src/server/network/tips.js, and that timer is the test's
    const wait = () => Object.assign(network.tipAnnounce, { tokens: 0, at: Date.now() + 60_000 })
    wait()
    network.announceTip({ fromId: 'alice', toPlayerId: 'bob', body: 'alice tipped bob', privateBody: 'to bob' })
    assert.deepEqual(calls, [['setTimeout', interval]])
    assert.deepEqual(announced, [])
    const timer = network.tipAnnounce.timer
    assert.equal(timer.ms, interval)
    assert.equal(timers(), before + 1, 'the socket check only: no global timer')
    // run by the test once one announcement is earned back: the waiting line goes out, and nothing waits any more
    network.tipAnnounce.at = Date.now() - interval
    timer.fn()
    assert.deepEqual(announced, ['alice tipped bob'])
    assert.equal(network.tipAnnounce.timer, null)
    // another line that waits, when the test ends
    wait()
    network.announceTip({ fromId: 'carol', toPlayerId: 'bob', body: 'carol tipped bob', privateBody: 'to bob' })
    assert.deepEqual(calls, [
      ['setTimeout', interval],
      ['setTimeout', interval],
    ])
    // a module the class imports calls the global one
    assert.equal(network.kicks().setTimeout, globalThis.setTimeout)
    calls.length = 0
  })
  // the end stopped the network with them: the class's clearTimeout (stopForFatal) cancelled the save timer (none
  // here) and the announcement the moved code made with the test's setTimeout
  assert.deepEqual(calls, [
    ['clearTimeout', null],
    ['clearTimeout', interval],
  ])
  assert.equal(timers(), before)
})

test("network helper: the timers a test gives are those of the class's code moved to src/server/network/ too (the save timer, the final save's deadline)", async t => {
  const before = timers()
  const calls = []
  const made = []
  const fake = {
    setTimeout: (fn, ms) => (calls.push(['setTimeout', ms]), made.push({ fn, ms }), made.at(-1)),
    clearTimeout: timer => calls.push(['clearTimeout', timer?.ms ?? timer]),
  }
  // a database with nothing stored, whose writes of a row never end
  const db = table => {
    if (table === 'config') return { where: () => ({ first: async () => undefined }) }
    if (table === 'users') return { select: async () => [] }
    return Object.assign([], { insert: () => ({ onConflict: () => ({ merge: () => new Promise(() => {}) }) }) })
  }
  const interval = 60_000 // SAVE_INTERVAL's default, in ms
  const lines = []
  await t.test('a test that gives them', async t => {
    for (const level of ['log', 'error']) t.mock.method(console, level, line => lines.push(line))
    const network = makeNetwork(t, {
      net,
      timers: fake,
      world: { settings: { deserialize() {}, serialize: () => ({}), setHasAdminCode() {}, on() {} } },
      init: { db },
    })
    network.world.blueprints = new net.Blueprints(network.world)
    // the first save, which hydrate sets in src/server/network/persistence.js: the test's setTimeout
    await network.start()
    assert.deepEqual(calls, [['setTimeout', interval]])
    assert.equal(network.saveTimerId, made[0])
    assert.equal(made[0].fn, network.save)
    assert.equal(timers(), before + 1, 'the socket check only: no global timer')
    // run by the test: the save cancels it with the test's clearTimeout and sets the next one with its setTimeout
    await made[0].fn()
    assert.deepEqual(calls.splice(0), [
      ['setTimeout', interval],
      ['clearTimeout', interval],
      ['setTimeout', interval],
    ])
    assert.equal(network.saveTimerId, made[1])
    // the final save, with a row whose write does not end: stopForFatal (the class's) cancels the save timer with the
    // test's clearTimeout, and the deadline is the test's setTimeout, which ends the save when the test runs it
    network.markBlueprintDirty({ id: 'b1', version: 0 })
    const saving = network.flushBeforeExit(1000)
    assert.deepEqual(calls, [
      ['clearTimeout', interval],
      ['setTimeout', 1000],
    ])
    assert.equal(timers(), before, 'the socket check cleared; no global timer')
    // the save it queues starts (cancelling the save timer again) and the row's write is under way
    for (let turn = 0; turn < 2; turn++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.length, 3)
    made[2].fn()
    await assert.rejects(saving, /save deadline exceeded/)
    assert.equal(network.flushExpired, true)
    // and the deadline, once run, was cancelled at the save's end with the test's clearTimeout
    assert.deepEqual(calls.splice(0), [
      ['clearTimeout', interval],
      ['setTimeout', 1000],
      ['clearTimeout', interval],
      ['clearTimeout', 1000],
    ])
    assert.match(lines.at(-1), /^\[network\] not persisted: blueprints=\["b1"\] /)
  })
  // the end stopped the network: the class's clearTimeout cancelled the save timer, with the test's
  assert.deepEqual(calls, [['clearTimeout', interval]])
  assert.equal(timers(), before)
})

test('server bundle: prepend puts a line before one module of the bundle', async t => {
  const seen = (globalThis.prependedLines = [])
  t.after(() => delete globalThis.prependedLines)
  const bundle = await bundleServer(`export { readKickEnv } from './src/server/kickList.js'`, {
    prepend: { 'src/server/kickList.js': `globalThis.prependedLines.push(typeof readKickEnv);` },
  })
  t.after(bundle.destroy)
  // run once, in the module's own scope: it sees the module's function
  assert.deepEqual(seen, ['function'])
  assert.equal(typeof bundle.module.readKickEnv, 'function')
  await assert.rejects(
    bundleServer(`export { readKickEnv } from './src/server/kickList.js'`, {
      prepend: { 'src/server/cleaner.js': ';' },
    }),
    /prepend: src\/server\/cleaner.js is not imported by the bundle/
  )
  await assert.rejects(
    bundleServer(`export { readKickEnv } from './src/server/kickList.js'`, {
      replace: { 'src/server/kickList.js': `export * from 'real:'` },
      prepend: { 'src/server/kickList.js': ';' },
    }),
    /prepend: src\/server\/kickList.js is replaced/
  )
  await assert.rejects(
    bundleServer(`export { readKickEnv } from './src/server/kickList.js'`, {
      prepend: { 'src/server/kickList.js': ';\n;' },
    }),
    /not one line/
  )
  // an optional line goes where the bundle has the module, and a module it has not is no error; a path that is no file
  // of this repository still is, and so is a replaced module
  seen.length = 0
  const optional = await bundleServer(`export { readKickEnv as optionalRead } from './src/server/kickList.js'`, {
    prepend: {
      'src/server/kickList.js': { text: `globalThis.prependedLines.push('kickList');`, optional: true },
      'src/server/cleaner.js': { text: `globalThis.prependedLines.push('cleaner');`, optional: true },
    },
  })
  t.after(optional.destroy)
  assert.deepEqual(seen, ['kickList'])
  await assert.rejects(
    bundleServer(`export { readKickEnv } from './src/server/kickList.js'`, {
      prepend: { 'src/server/network/tip.js': { text: ';', optional: true } },
    }),
    /prepend: src\/server\/network\/tip.js is not a file of this repository/
  )
  await assert.rejects(
    bundleServer(`export { readKickEnv } from './src/server/kickList.js'`, {
      replace: { 'src/server/kickList.js': `export * from 'real:'` },
      prepend: { 'src/server/kickList.js': { text: ';', optional: true } },
    }),
    /prepend: src\/server\/kickList.js is replaced/
  )
})

// TIMED_FILES (network.mjs): a checkout whose class does not import tips.js, as before its tip members moved there, is
// a `sourceRoot` the helper loads (the line for tips.js goes nowhere in that bundle), and the class's own timers there
// are the test's (its line is required). Without a sourceRoot, tips.js is in the bundle and has its line (the test of
// the moved announcement above)
test("network helper: a sourceRoot whose class does not import tips.js (from before the move) loads, and the class's timers there are the test's", async t => {
  // the baseline: the class alone, today's without its import of tips.js (whose members it then never calls here)
  const CLASS = 'src/core/systems/ServerNetwork.js'
  const IMPORT = "import * as tips from '../../server/network/tips'\n"
  const source = fs.readFileSync(fileURLToPath(new URL(`../${CLASS}`, import.meta.url)), 'utf8')
  assert.equal(source.split(IMPORT).length, 2, 'the class imports tips.js once')
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'network-baseline-'))
  t.after(() => fs.rmSync(baseline, { recursive: true, force: true }))
  fs.mkdirSync(path.join(baseline, path.dirname(CLASS)), { recursive: true })
  fs.writeFileSync(path.join(baseline, CLASS), source.replace(IMPORT, ''))
  const old = await loadNetwork({ sourceRoot: baseline })
  t.after(old.destroy)
  // the network's modules in that bundle (each module of a bundle starts with a line of its path)
  const modules = fs.readFileSync(fileURLToPath(old.url), 'utf8').match(/^\/\/ src\/server\/network\/\S+$/gm)
  assert.deepEqual(modules, [
    '// src/server/network/solanaWallet.js',
    '// src/server/network/evmWallet.js',
    '// src/server/network/persistence.js',
    '// src/server/network/authority.js',
  ])
  const calls = []
  const network = makeNetwork(t, {
    net: old,
    timers: { setTimeout: (fn, ms) => (calls.push(ms), { fn, ms }), clearTimeout: () => {} },
  })
  // a takeover's ping: its deadline is the class's own setTimeout, the test's
  const socket = new old.Socket({ id: 'p', ws: fakeWs(), network })
  network.sockets.set('p', socket)
  const answered = network.answersPing(socket, 1234)
  assert.deepEqual(calls, [1234])
  socket.ws.emit('pong')
  assert.equal(await answered, true)
})

test("network helper: a sourceRoot whose class does not import persistence.js (from before the move) loads, and the class's timers there are the test's", async t => {
  // the baseline: the class alone, today's without its import of persistence.js (whose members it then never calls
  // here: the test does not start the world)
  const CLASS = 'src/core/systems/ServerNetwork.js'
  const IMPORT = "import * as persistence from '../../server/network/persistence'\n"
  const source = fs.readFileSync(fileURLToPath(new URL(`../${CLASS}`, import.meta.url)), 'utf8')
  assert.equal(source.split(IMPORT).length, 2, 'the class imports persistence.js once')
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'network-baseline-'))
  t.after(() => fs.rmSync(baseline, { recursive: true, force: true }))
  fs.mkdirSync(path.join(baseline, path.dirname(CLASS)), { recursive: true })
  fs.writeFileSync(path.join(baseline, CLASS), source.replace(IMPORT, ''))
  const old = await loadNetwork({ sourceRoot: baseline })
  t.after(old.destroy)
  // the network's modules in that bundle (each module of a bundle starts with a line of its path)
  const modules = fs.readFileSync(fileURLToPath(old.url), 'utf8').match(/^\/\/ src\/server\/network\/\S+$/gm)
  assert.deepEqual(modules, [
    '// src/server/network/solanaWallet.js',
    '// src/server/network/evmWallet.js',
    '// src/server/network/tips.js',
    '// src/server/network/authority.js',
  ])
  const calls = []
  const network = makeNetwork(t, {
    net: old,
    timers: { setTimeout: (fn, ms) => (calls.push(ms), { fn, ms }), clearTimeout: () => {} },
  })
  // a takeover's ping: its deadline is the class's own setTimeout, the test's
  const socket = new old.Socket({ id: 'p', ws: fakeWs(), network })
  network.sockets.set('p', socket)
  const answered = network.answersPing(socket, 1234)
  assert.deepEqual(calls, [1234])
  socket.ws.emit('pong')
  assert.equal(await answered, true)
})

test('network helper: entityClasses gives Entities the classes a file of the tests exports', async t => {
  const own = await loadNetwork({ replace: entityClasses(new URL('./lib/joinEntities.mjs', import.meta.url)) })
  t.after(own.destroy)
  // (a world that hears of its own player: the local one)
  const world = makeNetwork(t, { net: own, world: { emit() {} } }).world
  world.entities = new own.Entities(world)
  const app = world.entities.add({ id: 'app', type: 'app', blueprint: 'bp', state: {} })
  const player = world.entities.add({ id: 'player', type: 'player', owner: 'someone', rank: 1 })
  assert.equal(app.constructor.name, 'FakeApp')
  assert.equal(player.constructor.name, 'FakePlayer')
  assert.equal(player.isBuilder(), true)
  // the local player is the same class, from one copy of the file in the bundle
  world.network.id = 'me'
  const local = world.entities.add({ id: 'me', type: 'player', owner: 'me', rank: 0 })
  assert.equal(local.constructor, player.constructor)
})

// A test context as node:test hands it to the helper, whose hooks the test runs itself with `end()`: in order, and,
// as node:test runs them, none after one that threw. -> { context, end }; end() -> { threw, error }. (The real
// test's end runs them, where the test failed before.)
function handedContext(t) {
  const hooks = []
  // (the signal node:test aborts when a test is over, whatever its hooks did)
  const over = new AbortController()
  const context = { after: hook => hooks.push(hook), mock: t.mock, signal: over.signal }
  const end = async () => {
    try {
      for (const hook of hooks.splice(0)) {
        try {
          await hook()
        } catch (error) {
          return { threw: true, error }
        }
      }
      return { threw: false }
    } finally {
      over.abort()
    }
  }
  t.after(end)
  return { context, end }
}

test('network helper: every network of a test is stopped at its end, whatever one of them throws while it stops', async t => {
  const SOLANA = 'src/server/solana-gating.js'
  const swapped = await loadNetwork({ standIns: [SOLANA] })
  t.after(swapped.destroy)
  const saved = process.env.ADMIN_CODE
  const before = timers()
  const { context, end } = handedContext(t)
  const first = makeNetwork(context, { net: swapped, env: { ADMIN_CODE: 'during' } })
  first.tipWatcher = {
    stop() {
      throw new Error('a stand-in that fails when it is touched')
    },
  }
  // a tip announcement waiting (announceTip's timer), which stopForFatal clears after the tip watcher's stop
  first.tipAnnounce.timer = setTimeout(() => assert.fail('a tip announcement outlived the test'), 60_000)
  const second = makeNetwork(context, { net: swapped, modules: { [SOLANA]: { TOKEN_GATING_ENABLED: true } } })
  assert.equal(timers(), before + 3)
  const ended = await end()
  assert.equal(ended.threw, true)
  assert.match(ended.error?.message ?? '', /fails when it is touched/)
  assert.equal(first.stopping && second.stopping, true)
  assert.equal(timers(), before, 'the timers of both, the one whose stop threw included')
  assert.equal(process.env.ADMIN_CODE, saved)
  assert.equal(swapped.solanaGating.TOKEN_GATING_ENABLED, false)
})

test('network helper: a stop that throws half way still cancels with the timers the test gave', async t => {
  const before = timers()
  const pending = new Set()
  const cleared = []
  const fake = {
    setTimeout: fn => {
      const handle = { fn }
      pending.add(handle)
      return handle
    },
    clearTimeout: handle => {
      cleared.push(handle)
      pending.delete(handle)
    },
  }
  const { context, end } = handedContext(t)
  const network = makeNetwork(context, { net, timers: fake })
  network.tipWatcher = {
    stop() {
      throw new Error('a stand-in that fails when it is touched')
    },
  }
  // a tip announcement waiting on the test's own timer: stopForFatal cancels it after the tip watcher's stop, which
  // it never gets past here
  const announcement = (network.tipAnnounce.timer = fake.setTimeout(() => {}))
  assert.equal(pending.size, 1)
  const ended = await end()
  assert.match(ended.error?.message ?? '', /fails when it is touched/)
  assert.equal(pending.size, 0, "the announcement was cancelled with the test's clearTimeout")
  assert.equal(cleared.at(-1), announcement)
  // (the socket check, for which the test gave no timer, is the global one)
  assert.equal(timers(), before)
  // a cancellation of the test's that throws as well changes neither what is reported nor what is put back
  const second = handedContext(t)
  const other = makeNetwork(second.context, {
    net,
    timers: {
      clearTimeout() {
        throw new Error('a clearTimeout that fails')
      },
    },
  })
  assert.match((await second.end()).error?.message ?? '', /a clearTimeout that fails/)
  assert.equal(other.stopping, true)
  assert.equal(timers(), before)
  makeNetwork(t, { net })
})

test('network helper: with two objects of timers in a test, each timer is cancelled by the one that made it', async t => {
  const before = timers()
  const fake = () => {
    const pending = new Set()
    const make = fn => {
      const handle = { fn }
      pending.add(handle)
      return handle
    }
    const drop = handle => pending.delete(handle)
    return { pending, setTimeout: make, clearTimeout: drop, setInterval: make, clearInterval: drop }
  }
  for (const throwing of [false, true]) {
    const [a, b] = [fake(), fake()]
    const { context, end } = handedContext(t)
    const first = makeNetwork(context, { net, timers: a })
    // a tip announcement that waits, set as the class sets it (the table holds `a`)
    first.tipAnnounce.timer = classTimers.setTimeout(() => {}, 1000)
    if (throwing) {
      first.tipWatcher = {
        stop() {
          throw new Error('a stand-in that fails when it is touched')
        },
      }
    }
    // (the constructor's socket check, and the announcement)
    assert.equal(a.pending.size, 2)
    const second = makeNetwork(context, { net, timers: b })
    second.tipAnnounce.timer = classTimers.setTimeout(() => {}, 1000)
    assert.deepEqual([a.pending.size, b.pending.size], [2, 2])
    assert.equal((await end()).threw, throwing)
    assert.deepEqual([a.pending.size, b.pending.size], [0, 0], `a stop that ${throwing ? 'throws' : 'ends'}`)
  }
  assert.equal(timers(), before)
  // and a timer the global function made, for an object without that name, is the global's to cancel: the socket
  // check here, which the object's clearInterval never sees
  const seen = []
  await t.test('an object with clearInterval alone', t => {
    makeNetwork(t, { net, timers: { clearInterval: handle => seen.push(handle) } })
    assert.equal(timers(), before + 1)
  })
  assert.deepEqual(seen, [])
  assert.equal(timers(), before)
})

test('network helper: a stop that throws a falsy value fails the end of the test as well', async t => {
  const before = timers()
  const { context, end } = handedContext(t)
  const network = makeNetwork(context, { net })
  network.tipWatcher = {
    stop() {
      throw 0
    },
  }
  const ended = await end()
  assert.deepEqual(ended, { threw: true, error: 0 })
  assert.equal(timers(), before)
})

test('network helper: a check that fails inside a catch of the class fails the end of the test as well', async t => {
  const { context, end } = handedContext(t)
  const logs = []
  const network = makeNetwork(context, { net, log: line => logs.push(line) })
  // a handler the flush dispatches: what it throws, the flush logs and goes on
  network.onPing = () => inside(context, () => assert.fail('seen in the handler'))
  const socket = new net.Socket({ id: 'peer', ws: fakeWs(), network, player: { isBuilder: () => false } })
  socket.ws.emit('message', writeClientPacket('ping', 1))
  network.flush()
  assert.equal(logs.length, 1)
  assert.match(logs[0], /ping from client peer failed: AssertionError: seen in the handler/)
  const ended = await end()
  assert.equal(ended.threw, true)
  assert.equal(ended.error.message, 'seen in the handler')
  // a check that passes returns what it returns (a test that never made a network: nothing to report)
  assert.equal(
    inside(t, () => 'value'),
    'value'
  )
})

test('network helper: a check that fails while the end stops the networks is reported by that end', async t => {
  const { context, end } = handedContext(t)
  const network = makeNetwork(context, { net })
  // a collaborator of the stop that catches what it throws, as the class's catches do
  network.tipWatcher = {
    stop() {
      try {
        inside(context, () => assert.fail('seen during the stop'))
      } catch {
        // taken for its own failure
      }
    },
  }
  const ended = await end()
  assert.equal(ended.threw, true)
  assert.equal(ended.error.message, 'seen during the stop')
})

test('network helper: a check is synchronous; one that returns a thenable is refused, and reported', async t => {
  const { context, end } = handedContext(t)
  makeNetwork(context, { net })
  assert.throws(() => inside(context, () => Promise.resolve()), {
    name: 'TypeError',
    message: /inside\(\): the check must be synchronous/,
  })
  const ended = await end()
  assert.equal(ended.threw, true)
  assert.equal(ended.error.name, 'TypeError')
})

test("network helper: a check's result is read inside the report: a `then` getter that fails is reported", async t => {
  const { context, end } = handedContext(t)
  makeNetwork(context, { net })
  // a caller that catches, as the class's catches do
  try {
    inside(context, () => ({
      get then() {
        return assert.fail('seen reading then')
      },
    }))
  } catch {
    // taken for its own failure
  }
  const ended = await end()
  assert.equal(ended.threw, true)
  assert.equal(ended.error.message, 'seen reading then')
})

test('network helper: a refused promise that rejects is not an unhandled rejection as well', async t => {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  const { context, end } = handedContext(t)
  makeNetwork(context, { net })
  assert.throws(() => inside(context, () => Promise.reject(new Error('rejected later'))), TypeError)
  // (a turn of the event loop and more: an unhandled rejection is said by then)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(unhandled, [])
  const ended = await end()
  assert.equal(ended.error.name, 'TypeError')
})

// A test file of its own, run by `node --test` in a child process: what it reports (the reporter is named: with its
// output piped, Node 22 would print TAP and Node 24 the spec lines read below)
async function runTestFile(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'network-helper-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'case.test.mjs')
  const helper = new URL('./lib/network.mjs', import.meta.url).href
  fs.writeFileSync(
    file,
    `import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeWs, importNetwork, inside, makeNetwork } from ${JSON.stringify(helper)}
const net = await importNetwork(JSON.parse(process.env.NETWORK_UNDER_TEST))
// (a test that is still running when the deferred throw comes)
const pending = () => new Promise(resolve => setTimeout(resolve, 100))
${body}
`
  )
  const child = spawn(process.execPath, ['--test', '--test-reporter=spec', file], {
    // (not the runner's own variables: a child of a test file that runs `node --test` would skip its files)
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NETWORK_UNDER_TEST: JSON.stringify({ url: net.url, env: net.env }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', data => (out += data))
  child.stderr.on('data', data => (out += data))
  const [code] = await once(child, 'close')
  return { code, out }
}

test(
  'network helper: a check that fails with no test left to report it is thrown outside the class, and fails the file',
  { timeout: 60000 },
  async t => {
    for (const [what, body] of [
      [
        'in a hook after the end',
        `test('late', t => {
  makeNetwork(t, { net })
  t.after(() => {
    try {
      inside(t, () => assert.fail('seen after the end'))
    } catch {}
  })
})`,
      ],
      [
        "a ping of an earlier test's connection, from a test still running when the throw comes",
        `let old
test('first', t => {
  makeNetwork(t, { net })
  old = fakeWs()
})
test('second', async t => {
  makeNetwork(t, { net })
  try {
    old.ping('seen by an earlier test', false, () => {})
  } catch {}
  await pending()
})`,
      ],
      [
        'a connection made outside every test',
        `const loose = fakeWs()
test('nobody', async t => {
  makeNetwork(t, { net })
  try {
    loose.ping('seen by nobody', false, () => {})
  } catch {}
  await pending()
})`,
      ],
      [
        'a connection made in a before hook',
        `let early
before(() => {
  early = fakeWs()
})
test('later', async t => {
  makeNetwork(t, { net })
  try {
    early.ping('seen from before', false, () => {})
  } catch {}
  await pending()
})`,
      ],
    ]) {
      const { code, out } = await runTestFile(t, body)
      assert.notEqual(code, 0, `${what}: ${out.slice(-1500)}`)
      assert.match(out, /seen (after the end|by an earlier test|by nobody|from before)/, what)
      // thrown outside every test: the file fails on it, and no test of it does (not the one running when it came)
      assert.match(out, /uncaughtException/, what)
      assert.doesNotMatch(out, /^✖ (late|first|second|nobody|later) /m, what)
      assert.match(out, /^✔ (late|second|nobody|later) /m, what)
    }
  }
)

test("network helper: a fake connection's check of a ping is reported at the end, though the write ledger catches it", async t => {
  const { context, end } = handedContext(t)
  const network = makeNetwork(context, { net, log: () => {} })
  // the class's own ping: no payload, unmasked
  const ws = fakeWs()
  assert.equal(network.write(ws, null), true)
  assert.deepEqual(await end(), { threw: false })
  // another: the ledger takes the throw for a dead connection and closes it, and the end reports the check
  const other = handedContext(t)
  const second = makeNetwork(other.context, { net, log: () => {} })
  const pinged = fakeWs()
  const ping = pinged.ping
  pinged.ping = (data, mask, cb) => ping('a payload', mask, cb)
  assert.equal(second.write(pinged, null), false)
  assert.equal(pinged.terminations, 1)
  const ended = await other.end()
  assert.equal(ended.threw, true)
  assert.equal(ended.error.code, 'ERR_ASSERTION')
  assert.equal(ended.error.actual, 'a payload')
})

test('network helper: a test that makes a network while another one holds the helper is refused', async t => {
  const first = handedContext(t)
  const second = handedContext(t)
  makeNetwork(first.context, { net, env: { ADMIN_CODE: 'first' } })
  assert.throws(
    () => makeNetwork(second.context, { net, env: { ADMIN_CODE: 'second' } }),
    /the network helper holds process-wide state: tests that use it must not run concurrently/
  )
  // nothing of the second was put in place, and the first's end gives the helper back
  assert.equal(process.env.ADMIN_CODE, 'first')
  assert.deepEqual(await first.end(), { threw: false })
  makeNetwork(second.context, { net, env: { ADMIN_CODE: 'second' } })
  assert.equal(process.env.ADMIN_CODE, 'second')
  assert.deepEqual(await second.end(), { threw: false })
})

test("network helper: a hook that throws before the helper's own does not leave the helper held", async t => {
  const saved = process.env.ADMIN_CODE
  const before = timers()
  const failing = handedContext(t)
  // registered first, so it runs first; node:test then runs none of the test's later hooks
  failing.context.after(() => {
    throw new Error('the test’s own hook')
  })
  const network = makeNetwork(failing.context, { net, env: { ADMIN_CODE: 'during' } })
  assert.ok(network.socketIntervalId)
  const ended = await failing.end()
  assert.equal(ended.threw, true)
  assert.equal(ended.error.message, 'the test’s own hook')
  // the end of the test did what the skipped hook would have: timers, environment, and the helper is free
  assert.deepEqual(timers(), before)
  assert.equal(process.env.ADMIN_CODE, saved)
  const next = handedContext(t)
  makeNetwork(next.context, { net })
  assert.deepEqual(await next.end(), { threw: false })
})

test('network helper: a network cannot be made for a test that is over', async t => {
  const done = handedContext(t)
  makeNetwork(done.context, { net })
  assert.deepEqual(await done.end(), { threw: false })
  // (from a hook registered late, say: it would be left running, with the environment it set)
  const before = timers()
  assert.throws(() => makeNetwork(done.context, { net, env: { ADMIN_CODE: 'late' } }), /after the end of its test/)
  assert.deepEqual(timers(), before)
  assert.notEqual(process.env.ADMIN_CODE, 'late')
  // and the helper is not held by it
  const next = handedContext(t)
  makeNetwork(next.context, { net })
  assert.deepEqual(await next.end(), { threw: false })
  // nor for one that was over before it made its first (a body that timed out and goes on running)
  const late = handedContext(t)
  assert.deepEqual(await late.end(), { threw: false })
  assert.throws(() => makeNetwork(late.context, { net, env: { ADMIN_CODE: 'late' } }), /after the end of its test/)
  assert.deepEqual(timers(), before)
  assert.notEqual(process.env.ADMIN_CODE, 'late')
  const after = handedContext(t)
  makeNetwork(after.context, { net })
  assert.deepEqual(await after.end(), { threw: false })
})

test('network helper: env varies a constant read at import, in one call that restores the environment', async t => {
  const saved = process.env.SAVE_INTERVAL
  const sockets = process.env.WS_MAX_SOCKETS
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const started = async from => {
    const network = startable(t, from)
    await network.start()
    return network
  }
  const unsaved = await loadNetwork({ env: { SAVE_INTERVAL: '0' } })
  assert.equal(process.env.SAVE_INTERVAL, saved)
  assert.equal((await started(unsaved)).saveTimerId, null, 'SAVE_INTERVAL=0: no first save')
  assert.notEqual((await started(net)).saveTimerId, null)
  // the same values give the same evaluation; other values another one
  assert.equal((await loadNetwork({ env: { SAVE_INTERVAL: '0' } })).ServerNetwork, unsaved.ServerNetwork)
  assert.notEqual(unsaved.ServerNetwork, net.ServerNetwork)
  // A module that throws at import with the value given leaves the environment as it was just before. (Not "as the
  // shell had it": the networks started above keep this test's known environment until the test ends, so a shell
  // with WS_MAX_SOCKETS or SAVE_INTERVAL set sees them unset here.)
  const before = { sockets: process.env.WS_MAX_SOCKETS, interval: process.env.SAVE_INTERVAL }
  await assert.rejects(loadNetwork({ env: { WS_MAX_SOCKETS: 'many', SAVE_INTERVAL: '5' } }), /WS_MAX_SOCKETS/)
  assert.deepEqual({ sockets: process.env.WS_MAX_SOCKETS, interval: process.env.SAVE_INTERVAL }, before)
  // ... and when the test is over, the shell's own values are back (hooks run in the order they were registered:
  // the helper's restore, registered by the first makeNetwork above, has run by now)
  t.after(() => {
    assert.equal(process.env.WS_MAX_SOCKETS, sockets)
    assert.equal(process.env.SAVE_INTERVAL, saved)
  })
})

test('server bundle: evaluations wait for each other; none sees the values of another', async () => {
  const saved = process.env.PUBLIC_TOKEN_MINT
  const [off, on] = await Promise.all([
    loadNetwork({ env: { PUBLIC_TOKEN_MINT: '' } }),
    loadNetwork({ env: { PUBLIC_TOKEN_MINT: 'mint' } }),
  ])
  assert.equal(off.solanaGating.TOKEN_GATING_ENABLED, false)
  assert.equal(on.solanaGating.TOKEN_GATING_ENABLED, true)
  assert.equal(process.env.PUBLIC_TOKEN_MINT, saved)
})

test('network helper: a bundle is first evaluated with the environment asked for, never with the ambient one', async t => {
  keepEnvironment(t, ['KICK_MINUTES'])
  process.env.KICK_MINUTES = 'not a number'
  const seen = (globalThis.kickListEvaluations = [])
  t.after(() => delete globalThis.kickListEvaluations)
  const recorded = await loadNetwork({
    replace: {
      'src/server/kickList.js': `globalThis.kickListEvaluations.push(process.env.KICK_MINUTES ?? null)\nexport * from 'real:'`,
    },
    env: { KICK_MINUTES: '5' },
  })
  t.after(recorded.destroy)
  assert.deepEqual(seen, ['5'])
  assert.equal(makeNetwork(t, { net: recorded }).kicks().minutes, 5)
})

test('network helper: url and env name the evaluation the classes come from; a worker given them gets it', async () => {
  const gated = await loadNetwork({ env: { PUBLIC_TOKEN_MINT: 'mint' } })
  assert.equal((await import(gated.url)).ServerNetwork, gated.ServerNetwork)
  assert.notEqual(gated.url, net.url)
  assert.equal(gated.env.PUBLIC_TOKEN_MINT, 'mint')
  // a worker starts from a copy of this environment, which does not have the mint: the hand-off sets it there
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads')
    import(workerData.helper)
      .then(({ importNetwork }) => importNetwork(workerData.network))
      .then(net => parentPort.postMessage({ gated: net.solanaGating.TOKEN_GATING_ENABLED, mint: process.env.PUBLIC_TOKEN_MINT }))`,
    {
      eval: true,
      workerData: {
        helper: new URL('./lib/network.mjs', import.meta.url).href,
        network: { url: gated.url, env: gated.env },
      },
    }
  )
  const [message] = await once(worker, 'message')
  await worker.terminate()
  assert.deepEqual(message, { gated: true, mint: 'mint' })
})

test('network helper: a load whose evaluation fails gives its build back', async () => {
  const held = heldBundles()
  const failing = { 'src/server/kickList.js': `export * from 'real:'\nthrow new Error('evaluation failed')` }
  await assert.rejects(loadNetwork({ replace: failing }), /evaluation failed/)
  assert.equal(heldBundles(), held)
})

test('network helper: settings of the environment the tests run in change nothing they see, and are back after', async t => {
  keepEnvironment(t, Object.keys(AMBIENT))
  Object.assign(process.env, AMBIENT)
  // the evaluation is the one made without them; WS_MAX_SOCKETS=many would have thrown at import
  assert.equal((await loadNetwork()).ServerNetwork, net.ServerNetwork)
  assert.equal((await loadNetwork({ env: { WS_MAX_SOCKETS: undefined } })).ServerNetwork, net.ServerNetwork)
  assert.equal(net.evmGating.TIP_WATCH_MAX, 128)
  await t.test('a test under them', async t => {
    t.mock.method(console, 'log', () => {})
    t.mock.method(console, 'error', () => {})
    const network = startable(t, net)
    assert.equal(network.tokenBalanceService, null)
    assert.equal(network.evmHoldings, null)
    assert.equal(network.admin().mode, 'open')
    assert.equal(network.kicks().minutes, 10)
    assert.equal(process.env.ASSETS_BASE_URL, undefined)
    await network.start()
    assert.ok(network.saveTimerId, 'the first save, after the default interval')
    // a test's own value on top
    makeNetwork(t, { net, env: { ADMIN_CODE: 'this-test' } })
    assert.equal(process.env.ADMIN_CODE, 'this-test')
  })
  for (const [name, value] of Object.entries(AMBIENT)) assert.equal(process.env[name], value)
})

test('network helper: the ported files pass with those settings in their environment', { timeout: 120000 }, async t => {
  const files = [
    'actionBudgetHandlers',
    'adminCommand',
    'aiBudget',
    'announceBeforeApply',
    'blueprintEnforcement',
    'connectionHolds',
    'connectionLifecycle',
    'eventBudget',
    'externalAvatarUrls',
    'inboundNetwork',
    'joinAdmission',
    'joinBudget',
    'moderation',
    'networkLogging',
    'networkTransforms',
    'packetAccess',
    'packetRefusals',
    'persistence',
    'persistedHydration',
    'physicsFailure',
    'playerCoalescing',
    'protocolVersion',
    'scriptChat',
    'serverEvmWallet',
    'serverFileRead',
    'serverWallet',
    'sharedObjects',
    'userRowsNetwork',
    'writeLedger',
    'wsAdmission',
    'wsTransport',
  ].map(name => fileURLToPath(new URL(`./${name}.test.js`, import.meta.url)))
  const { PATH, HOME, TMPDIR } = process.env
  // (the reporter is named: with its output piped, Node 22 would print TAP and Node 24 the spec lines read below)
  const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...files], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { PATH, HOME, TMPDIR, ...AMBIENT },
    stdio: ['ignore', 'pipe', 'pipe'],
    // a group of its own: the runner starts a process per file, and a test of theirs that hung must not outlive
    // this one (its time-out, or the end of the test, stops the whole group)
    detached: process.platform !== 'win32',
  })
  // Stops the group, once, and only while it is ours: after `close` the group is gone and its number may be given to
  // another group, which a late signal would kill.
  let running = true
  const stop = () => {
    if (!running) return
    running = false
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch {
      // (gone already)
    }
  }
  t.signal.addEventListener('abort', stop)
  t.after(stop)
  child.once('close', () => {
    running = false
    t.signal.removeEventListener('abort', stop)
  })
  let out = ''
  child.stdout.on('data', data => (out += data))
  child.stderr.on('data', data => (out += data))
  const [code] = await once(child, 'close')
  assert.equal(code, 0, out.slice(-3000))
  const tests = /ℹ tests (\d+)/.exec(out)?.[1]
  assert.ok(Number(tests) > 0, `no count of tests in the output: ${out.slice(-500)}`)
  assert.match(out, new RegExp(`ℹ pass ${tests}\\n`))
})

test('network helper: the classes a test constructs are the ones the network code checks against', async () => {
  // the same bundle again (cached): the same classes
  assert.equal((await loadNetwork()).Socket, net.Socket)
  // an error a stand-in RPC throws is recognised by the network's own modules only when it is theirs
  const verify = error => {
    const verifier = net.evmGating.createEvmSignatureVerifier({
      rpc: {
        call: async () => {
          throw error
        },
      },
      log: () => {},
    })
    return verifier({ address: `0x${'1'.repeat(40)}`, hash: `0x${'2'.repeat(64)}`, signature: `0x${'3'.repeat(40)}` })
  }
  assert.deepEqual(await verify(new net.RpcError(3, { reverted: true })), { ok: false, reason: 'signature_invalid' })
  const other = await loadNetwork({ env: { SAVE_INTERVAL: '7' } })
  assert.notEqual(other.RpcError, net.RpcError)
  assert.deepEqual(await verify(new other.RpcError(3, { reverted: true })), { ok: false, reason: 'rpc_error' })
})

test('network helper: a replaced module must exist and be part of the bundle', async () => {
  await assert.rejects(loadNetwork({ replace: { 'src/server/noSuchModule.js': '' } }), /not a file of this repository/)
  await assert.rejects(loadNetwork({ replace: { 'src/server/cleaner.js': '' } }), /not imported by the bundle/)
})

test('network helper: sourceRoot reads a baseline checkout where it has the file', async t => {
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'network-baseline-'))
  t.after(() => fs.rmSync(baseline, { recursive: true, force: true }))
  fs.mkdirSync(path.join(baseline, 'src/server'), { recursive: true })
  fs.writeFileSync(
    path.join(baseline, 'src/server/kickList.js'),
    'export const readKickEnv = () => null\nexport const createKickList = () => "baseline"\n'
  )
  const old = await loadNetwork({ sourceRoot: baseline })
  t.after(old.destroy)
  assert.equal(makeNetwork(t, { net: old }).kicks(), 'baseline')
  assert.notEqual(old.ServerNetwork, net.ServerNetwork)
})

test('server bundle: one build per contents and replace; its folder goes with the last reference', async () => {
  const contents = `export { createKickList } from './src/server/kickList.js'`
  const a = await bundleServer(contents)
  const b = await bundleServer(contents)
  assert.equal(a.module, b.module)
  assert.equal(a.url, b.url)
  const file = fileURLToPath(a.url)
  a.destroy()
  a.destroy()
  assert.ok(fs.existsSync(file), 'still held by the other reference')
  b.destroy()
  assert.equal(fs.existsSync(path.dirname(file)), false)
  const c = await bundleServer(contents)
  assert.notEqual(c.url, a.url, 'built again after the last reference went')
  c.destroy()
})
