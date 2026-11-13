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
import { fakeWs, loadNetwork, makeNetwork } from './lib/network.mjs'
import { readPacket, writeClientPacket } from '../src/core/packets.js'

const net = await loadNetwork()
const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length

// settings a developer's shell may hold, each of which changed what the old tests or a first version of this helper
// saw (a save timer, the token gate, EVM, the admin code, the assets URL, the connection limit, the kick list)
const AMBIENT = {
  SAVE_INTERVAL: '0',
  PUBLIC_TOKEN_MINT: 'So11111111111111111111111111111111111111112',
  PUBLIC_EVM_CHAIN_IDS: '137',
  PUBLIC_API_URL: 'https://ambient.example/api',
  WS_MAX_SOCKETS: '7',
  ADMIN_CODE: 'an-ambient-code',
  ASSETS_BASE_URL: 'https://ambient.example/assets',
  KICK_MINUTES: 'not a number',
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
  // a module that throws at import with the value given leaves the environment as it was
  await assert.rejects(loadNetwork({ env: { WS_MAX_SOCKETS: 'many', SAVE_INTERVAL: '5' } }), /WS_MAX_SOCKETS/)
  assert.equal(process.env.WS_MAX_SOCKETS, sockets)
  assert.equal(process.env.SAVE_INTERVAL, saved)
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

test(
  'network helper: the ported files pass with those settings in their environment',
  { timeout: 120000 },
  async () => {
    const files = [
      'announceBeforeApply',
      'blueprintEnforcement',
      'persistence',
      'persistedHydration',
      'scriptChat',
      'serverFileRead',
      'sharedObjects',
    ].map(name => fileURLToPath(new URL(`./${name}.test.js`, import.meta.url)))
    const { PATH, HOME, TMPDIR } = process.env
    const child = spawn(process.execPath, ['--test', ...files], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { PATH, HOME, TMPDIR, ...AMBIENT },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', data => (out += data))
    child.stderr.on('data', data => (out += data))
    const [code] = await once(child, 'close')
    assert.equal(code, 0, out.slice(-3000))
    const [, tests] = /ℹ tests (\d+)/.exec(out)
    assert.ok(Number(tests) > 0)
    assert.match(out, new RegExp(`ℹ pass ${tests}\\n`))
  }
)

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
