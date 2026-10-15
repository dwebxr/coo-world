// e2e probe: the player relays. On the server, when props.serverTarget names a player, it teleports, pushes
// and re-skins that player through the server path, which must still reach them. On a client it acts on a
// remote player (props.remote; must do nothing and log once per method) or on the local player (must
// work), driven by app.state.cmd and reporting through app.state.results.
if (world.isServer) {
  if (props.serverTarget) {
    const player = world.getPlayer(props.serverTarget)
    if (player) {
      player.teleport(new Vector3(1, 2, 3), 0.5)
      // a respawn hook passes a quaternion as rotationY; the client ignores it and still teleports
      player.teleport(new Vector3(4, 5, 6), new Quaternion())
      player.push(new Vector3(0, 0, -30))
      player.setSessionAvatar('asset://avatar.vrm')
      player.setSessionAvatar(null)
    }
    world.chat({ id: uuid(), body: 'P4_RELAY ' + JSON.stringify({ found: !!player }) }, true)
  }
} else {
  const results = {}
  app.state = { cmd: null, results }
  let remote = null
  const commands = {
    // three frames of calls on the remote player: nothing may leave this client, one log per method
    remote() {
      return new Promise(resolve => {
        const player = world.getPlayer(props.remote)
        if (!player) throw new Error('remote player not found')
        remote = { player, frames: 3, calls: 0, resolve }
      })
    },
    localTeleport() {
      world.getPlayer().teleport(new Vector3(3, 0, 3), 1)
      return {}
    },
    localPush() {
      const start = world.getPlayer().position.toArray()
      world.getPlayer().push(new Vector3(0, 0, -30))
      return { start }
    },
    localAvatar() {
      world.getPlayer().setSessionAvatar('asset://avatar.vrm')
      return {}
    },
    localAvatarBad() {
      world.getPlayer().setSessionAvatar('javascript:1')
      return {}
    },
    localAvatarClear() {
      world.getPlayer().setSessionAvatar(null)
      return {}
    },
  }
  let busy = false
  app.on('update', () => {
    if (remote) {
      remote.player.teleport(new Vector3(9, 9, 9), 0)
      remote.player.push(new Vector3(0, 0, -30))
      remote.player.setSessionAvatar('asset://avatar.vrm')
      remote.calls += 3
      if (--remote.frames === 0) {
        remote.resolve({ calls: remote.calls })
        remote = null
      }
      return
    }
    const cmd = app.state.cmd
    if (busy || !cmd) return
    busy = true
    Promise.resolve()
      .then(() => commands[cmd]())
      .then(
        value => {
          results[cmd] = { ok: true, ...value }
        },
        err => {
          results[cmd] = { ok: false, error: String(err && err.message) }
        }
      )
      .then(() => {
        app.state.cmd = null
        busy = false
      })
  })
}
