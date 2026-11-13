// The /ws route of src/server/index.js: its admission (`admitConnection`, the connection limits' preValidation),
// the route itself (`worldNetwork`) and the options it registers @fastify/websocket with. They are written inline in
// index.js, which cannot be imported without booting the server (physics, the database, the listening port), so they
// are still cut out of its TEXT here and run in a `vm` context with the names they read given in. When the route
// moves into a module of its own (P16, step 16-9), this imports it instead.
//
// loadRoute(limits, network, config) → { register, preValidation, options }: `limits` the connection limits
// (connectionLimits.js), `network` what the route hands each connection to (`world.network`): a network of the real
// class (test/lib/network.mjs), as on the server; `config` the upload limits' settings it reads the client address
// header from.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { PROTOCOL_VERSION, writePacket } from '../../src/core/packets.js'
import { clientIpKeys } from '../../src/server/uploadLimits.js'

const serverSource = fs.readFileSync(new URL('../../src/server/index.js', import.meta.url), 'utf8')

// Run the actual index.js options, preValidation and route without booting physics or a database.
export function loadRoute(limits, network, config = { clientIpHeader: '' }) {
  const admission = serverSource.match(/^function admitConnection\([^]*?^}/m)?.[0]
  const route = serverSource.match(/^async function worldNetwork\([^]*?^}/m)?.[0]
  const options = serverSource.match(/fastify.register\(ws, (\{\n {2}options: \{[^]*?\n\})\)/)?.[1]
  assert.ok(admission && route && options)
  const context = vm.createContext({
    PROTOCOL_VERSION,
    writePacket,
    clientIpKeys,
    connectionLimits: limits,
    uploadLimitsConfig: config,
    kLease: Symbol('lease'),
    world: { network },
  })
  vm.runInContext(`${admission}\n${route}`, context)
  return {
    register: vm.runInContext('worldNetwork', context),
    preValidation: vm.runInContext('admitConnection', context),
    options: vm.runInContext(`(${options})`, context),
  }
}
