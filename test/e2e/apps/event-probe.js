// e2e probe: receives script events on the server and reports every 'probe' event through chat, so the
// harness can tell which events survived the inbound limits and the app's queue.
app.configure([
  { key: 'text', type: 'textarea', label: 'Limit text' },
  { key: 'file', type: 'file', kind: 'texture', label: 'Limit file' },
])

if (world.isServer) {
  app.on('size', (data, networkId) => {
    world.chat({ id: uuid(), body: 'P5_SIZE ' + JSON.stringify({ length: data.length, from: networkId }) }, true)
  })
  app.on('probe', (data, networkId) => {
    world.chat(
      { id: uuid(), body: 'P5_PING ' + JSON.stringify({ data, from: networkId, revision: props.revision || 0 }) },
      true
    )
  })
}
