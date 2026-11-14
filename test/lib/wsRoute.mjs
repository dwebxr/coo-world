// The /ws route (src/server/wsRoute.js): its admission (`admitConnection`, the connection limits' preValidation), the
// route itself (`worldNetwork`) and the options it registers @fastify/websocket with. A plain import: the module's own
// imports (packets.js, uploadLimits.js, connectionLimits.js and two of core/extras) are ones Node loads as they are,
// so it needs no bundle (until P16, step 16-9, the three were cut out of src/server/index.js's text and run in a `vm`
// context).
//
// loadRoute(limits, network, config, sessions) → { register, preValidation, options }: `limits` the connection limits
// (connectionLimits.js), `network` what the route hands each connection to (`world.network`): a network of the real
// class (test/lib/network.mjs), as on the server; `config` the upload limits' settings it reads the client address
// header from; `sessions` the session tokens' questions the door asks for a place kept for ranked users
// ({ readNow, claimedUserId }, utils-server.js). By default no token names anyone and none verifies, so no kept place
// is ever given: a test of those places passes its own (wsAdmission.test.js).
import { createWsRoute } from '../../src/server/wsRoute.js'

export const NO_SESSIONS = Object.freeze({ readNow: () => null, claimedUserId: () => null })

export function loadRoute(limits, network, config = { clientIpHeader: '' }, sessions = NO_SESSIONS) {
  return createWsRoute({
    connectionLimits: limits,
    clientIpHeader: config.clientIpHeader,
    world: { network },
    sessions,
  })
}
