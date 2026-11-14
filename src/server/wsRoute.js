import { PROTOCOL_VERSION, writePacket } from '../core/packets.js'
import { previewValue } from '../core/extras/assetURL.js'
import { Ranks } from '../core/extras/ranks.js'
import { RESERVED_PER_USER } from './connectionLimits.js'
import { clientIpKeys } from './uploadLimits.js'

// The /ws route: its admission (the connection limits' preValidation), the route itself and the options
// @fastify/websocket is registered with. index.js registers the plugin and the route; they are written here so that
// they can be imported without booting the server.
//
// createWsRoute({ connectionLimits, clientIpHeader, world, sessions }) → { options, preValidation, register }
// - `connectionLimits`: the per-address limits (connectionLimits.js). `clientIpHeader`: the header a client's
//   address is read from, '' for the connection's own (the upload limits' setting, uploadLimits.js). `world`: the
//   server's world, whose `network` is read when a connection comes. `sessions`: { readNow, claimedUserId }, the
//   session tokens' two questions that answer in the turn they are asked (utils-server.js readJWTNow and
//   claimedSessionUser).
// - `options`: for fastify.register(ws, options). `preValidation`: the admission, which takes a lease for an
//   upgrade and keeps it on the transport until the transport closes. `register`: the plugin that adds the route,
//   which hands a connection of this protocol version to world.network.onConnection.
// Nothing is made or read at import: each call makes its own options and its own key for the lease.
//
// The places kept for ranked users (connectionLimits.js, WS_RESERVED_SOCKETS): asked only when the address's own
// path refuses, and only while they are in effect (world.network.keptPlaces(): none where admin is open to all).
// Everything here is done in the turn the request is admitted in: no database, no wait, so the cap is asked and the
// lease taken with nothing in between.
// - The token is the one the client sends in the query (`authToken`), where the route's onConnection reads it too. A
//   value that is not a string of 1 to TOKEN_MAX_LENGTH characters is not read.
// - The user id it claims is read without its signature (about a microsecond). Unless that user has the kept places'
//   rank in the network's list of stored ranks (ServerNetwork.storedRankOf: the ranks stored with the users, read at
//   start-up and changed with every rank given or taken), the request is refused there: no signature is checked.
// - Then the token is verified (HS256, one HMAC, two with JWT_SECRET_PREVIOUS) and the user it names is asked about
//   again; only then is the user id handed to the limits, which admit it on the ranked path or refuse.
// - The lease of the ranked path carries the user id. The route hands it on to onConnection (`rankedUser`), which
//   checks it against the user's row before anything is made for the connection.
// - Said once per user id and process, through the network's log: a user let in on that path, and one refused on
//   it. The token is never said; the user id goes through previewValue. A request refused before its token was
//   verified is not said (nor is a visitor's refusal, as before).
export const TOKEN_MAX_LENGTH = 512

export function createWsRoute({ connectionLimits, clientIpHeader, world, sessions }) {
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

  // the answer of the ranked path for this request, or null where it is not asked (see the top)
  function keptPlace(origin, token) {
    const network = world.network
    const { places, rank } = network.keptPlaces()
    if (!(places > 0)) return null
    if (typeof token !== 'string' || !token || token.length > TOKEN_MAX_LENGTH) return null
    if (!(network.storedRankOf(sessions.claimedUserId(token)) >= rank)) return null
    const user = sessions.readNow(token)?.userId
    if (!(network.storedRankOf(user) >= rank)) return null
    const lease = connectionLimits.admit(origin, { user })
    const who = `${previewValue(user, 64)} (stored rank ${network.storedRankOf(user) >= Ranks.ADMIN ? 'admin' : 'builder'})`
    if (lease.ok && lease.ranked) {
      network.logOnce(
        network,
        `kept-door:${user}`,
        lease.beyond > 0
          ? `[connections] at WS_MAX_SOCKETS: ${who} came in through a place kept for ranked users (${lease.beyond} of ${places} in use)`
          : `[connections] ${who} came in past their address's connection limits, on the path kept for ranked users`
      )
    } else if (!lease.ok) {
      network.logOnce(
        network,
        `kept-door-refused:${user}`,
        `[connections] ${who} was refused: the ${places} places kept for ranked users are in use, or they have ${RESERVED_PER_USER} connections open on that path, or their connection rate is spent`
      )
    }
    return lease
  }

  function admitConnection(request, reply, done) {
    if (request.ws !== true) return done()
    const transport = request.raw.socket
    if (transport[kLease]) return reply.code(503).header('Retry-After', '10').send()
    const header = clientIpHeader
    const origin = clientIpKeys(header ? request.headers[header] : undefined, request.ip)
    let lease = connectionLimits.admit(origin)
    if (!lease.ok) lease = keptPlace(origin, request.query?.authToken) ?? lease
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
      const lease = req.raw.socket[kLease]
      world.network.onConnection(ws, req.query, clientIpKeys(header ? req.headers[header] : undefined, req.ip), {
        // the user a place kept for ranked users was given to at the door, whom onConnection checks again
        rankedUser: lease?.ranked === true ? lease.user : null,
      })
    })
  }

  return { options, preValidation: admitConnection, register: worldNetwork }
}
