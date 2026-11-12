// e2e probe for access-control.mjs (server side only). It says in chat, with a tag, what reached it:
// - P14_APP_EVENT: an event a client sent to this app (app.on). It listens to one ordinary name, `probe`, and to
//   three names of world events (tip, evmWallet, command) that the server must never hand an app from the network.
// - P14_WORLD_EVENT: a world event of one of those three names (world.on), with what it carried. `command` is the
//   one a visitor can cause, by typing a command; the other two come from the wallet flows.
if (world.isServer) {
  const say = (tag, data) => world.chat({ id: uuid(), body: tag + ' ' + JSON.stringify(data) }, true)
  for (const name of ['probe', 'tip', 'evmWallet', 'command']) {
    app.on(name, (data, networkId) => say('P14_APP_EVENT', { name, data, from: networkId }))
  }
  for (const name of ['tip', 'evmWallet', 'command']) {
    world.on(name, event => say('P14_WORLD_EVENT', { name, event }))
  }
}
