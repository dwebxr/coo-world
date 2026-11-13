import { PROTOCOL_VERSION, writePacket } from '../core/packets.js'
import { clientIpKeys } from './uploadLimits.js'

// The /ws route: its admission (the connection limits' preValidation), the route itself and the options
// @fastify/websocket is registered with. index.js registers the plugin and the route; they are written here so that
// they can be imported without booting the server.
//
// createWsRoute({ connectionLimits, clientIpHeader, world }) → { options, preValidation, register }
// - `connectionLimits`: the per-address limits (connectionLimits.js). `clientIpHeader`: the header a client's
//   address is read from, '' for the connection's own (the upload limits' setting, uploadLimits.js). `world`: the
//   server's world, whose `network` is read when a connection comes.
// - `options`: for fastify.register(ws, options). `preValidation`: the admission, which takes a lease for an
//   upgrade and keeps it on the transport until the transport closes. `register`: the plugin that adds the route,
//   which hands a connection of this protocol version to world.network.onConnection.
// Nothing is made or read at import: each call makes its own options and its own key for the lease.
export function createWsRoute({ connectionLimits, clientIpHeader, world }) {
  const options = {
    options: {
      maxPayload: 65536,
      maxFragments: 8,
      maxBufferedChunks: 1024,
      autoPong: false,
      perMessageDeflate: false,
      closeTimeout: 2000,
    },
  }
  const kLease = Symbol('wsLease')

  function admitConnection(request, reply, done) {
    if (request.ws !== true) return done()
    const transport = request.raw.socket
    if (transport[kLease]) return reply.code(503).header('Retry-After', '10').send()
    const header = clientIpHeader
    const lease = connectionLimits.admit(clientIpKeys(header ? request.headers[header] : undefined, request.ip))
    if (!lease.ok) return reply.code(503).header('Retry-After', '10').send()
    transport[kLease] = lease
    transport.once('close', lease.release)
    // An abort before ws takes over must not become an unhandled transport error.
    transport.once('error', () => transport.destroy())
    if (transport.destroyed) lease.release()
    done()
  }

  async function worldNetwork(fastify) {
    fastify.get('/ws', { websocket: true, preValidation: admitConnection }, (ws, req) => {
      if (req.query.v !== String(PROTOCOL_VERSION)) {
        world.network.write(ws, writePacket('kick', 'outdated'), { name: 'kick' })
        ws.close(1008, 'outdated')
        return
      }
      // the address the connection limits counted it under: the brake on wrong admin codes uses the same key
      const header = clientIpHeader
      world.network.onConnection(ws, req.query, clientIpKeys(header ? req.headers[header] : undefined, req.ip))
    })
  }

  return { options, preValidation: admitConnection, register: worldNetwork }
}
