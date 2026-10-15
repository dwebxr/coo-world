// e2e only: a scaled anchor and a native rigidbody, with reports from the server's update loop.
const anchor = app.create('anchor', { id: 'seat', position: [3, 2, -3], scale: [2, 2, 2] })
anchor.rotation.y = Math.PI / 2
app.add(anchor)
const body = app.create('rigidbody', { id: 'transform-body', type: 'static' })
body.add(app.create('collider', { type: 'box', width: 0.5, height: 0.5, depth: 0.5 }))
app.add(body)

if (world.isServer) {
  let ticks = 0
  const pending = []
  app.on('probe', request => pending.push({ ...request, after: ticks + 2 }))
  app.on('anchor-local', ({ playerId }) => {
    // The real server -> local player effect path; duration expires in simulated browser time.
    world.getPlayer(playerId).applyEffect({ anchor, duration: 2 })
  })
  app.on('update', () => {
    ticks++
    while (pending.length && pending[0].after <= ticks) {
      const { seq, playerId } = pending.shift()
      const player = world.getPlayer(playerId)
      const origin = player.position.clone().add(new Vector3(0, 0.9, 2))
      const hit = world.raycast(origin, new Vector3(0, 0, -1), 4, world.createLayerMask('player'))
      app.send('report', {
        seq,
        ticks,
        anchorId: anchor.anchorId,
        anchorMatrix: anchor.matrixWorld.toArray(),
        player: {
          position: player.position.toArray(),
          quaternion: player.quaternion.toArray(),
          effect: player.hasEffect(),
          hit: hit ? { playerId: hit.playerId, distance: hit.distance } : null,
        },
        body: { position: body.getPosition().toArray(), quaternion: body.getQuaternion().toArray() },
      })
    }
  })
}
