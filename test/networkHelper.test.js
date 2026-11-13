// The helpers that run the real network in tests (test/lib/network.mjs, test/lib/serverBundle.mjs): what `replace`
// and `env` do to the bundled ServerNetwork, which classes a test shares with it, and what a test leaves behind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleServer } from './lib/serverBundle.mjs'
import { fakeWs, loadNetwork, makeNetwork } from './lib/network.mjs'
import { readPacket, writeClientPacket } from '../src/core/packets.js'

const net = await loadNetwork()
const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length

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
  // the network's own lines go to `log`
  socket.ws.emit('message', Uint8Array.of(0xff))
  network.flush()
  assert.equal(logs.length, 1)
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
  assert.equal(process.env.WS_MAX_SOCKETS, undefined)
  assert.equal(process.env.SAVE_INTERVAL, saved)
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
