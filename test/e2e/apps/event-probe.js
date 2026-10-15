// e2e probe: receives script events on the server and reports every 'probe' event through chat, so the
// harness can tell which events survived the inbound limits and the app's queue.
if (world.isServer) {
  app.on('probe', (data, networkId) => {
    world.chat({ id: uuid(), body: 'P5_PING ' + JSON.stringify({ data, from: networkId }) }, true)
  })
}
