// e2e probe: forwards the server-only `tip` event to every client, with whether it arrived frozen.
if (world.isServer) {
  world.on('tip', tip => app.send('tip-seen', { ...tip, frozen: Object.isFrozen(tip) }))
}
