// e2e probe for fullstack.mjs B4h: an app line of each kind. In each browser that builds it, the client script
// broadcasts one line (world.chat(msg, true)) with a display name of its choosing: the server relays it as this app's
// line and names that browser's player in `via`. The server script broadcasts one line of its own, which names
// nobody.
if (world.isClient) {
  world.chat({ body: 'P_VIA_CLIENT ' + world.networkId, from: 'Clerk' }, true)
}
if (world.isServer) {
  world.chat({ body: 'P_VIA_SERVER', from: 'Clerk' }, true)
}
