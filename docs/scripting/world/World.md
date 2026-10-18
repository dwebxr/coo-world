# World

The global `world` variable is always available within the app scripting runtime.

## Shared world extent

Networked player positions, app positions and spawn positions support `[-1e6, 1e6]` metres on each
axis (`TRANSFORM_LIMIT = 1e6`, inclusive). Values must be finite. Invalid movement components are
dropped as a whole position field, so observers retain the previous accepted position. Local flying
or script-driven movement is not clamped by this network rule; moving outside the extent can make
the local and shared positions diverge. Teleports also enforce this bound, and server-to-client
pushes have a separate `1e4` per-component bound; see [Player](/docs/scripting/world/Player.md).

Network quaternions must have a finite norm within 0.1 of 1 and are normalised before use. Invalid
spawn records fall back to the default spawn; invalid spawn changes are refused. At startup,
persisted app transforms are repaired where possible (bounded positions, normalised or identity
quaternions, valid scales or `[1, 1, 1]`). Unusable apps and blueprints are skipped and logged;
their stored rows remain untouched. Repairs stay in memory until an explicit edit. Arbitrary
composed script transforms and geometry are not globally validated by these checks.

## Physics availability

A crash stops the affected app's script dispatch and timers immediately. Native physics failures
do so even if the script catches the error. Crash presentation is scheduled once after the current
call returns. Latched API calls report `[app] this app has stopped`, or the physics-failure message
when a native trap caused the latch. During the destroy event, world/app reads, `app.send/sendTo`,
`world.off/app.off` and `world.remove` of the app's own nodes remain available for cleanup.
Native queries, creation and other native-capable calls remain blocked. A legitimate replacement
script can run again after cleanup of the old run.

A separate simulation health probe checks PhysX after a native trap. If it fails, or an exception
interrupts the main scene's simulation/fetch, the world stops ticking. The server refuses further
mutations and attempts to save settled edits, deletions and changed, loaded settings/spawn values before
exiting with code 1 for a process restart. One five-second deadline includes in-flight writes and
the final flush; failed or timed-out saves are logged. Clients stop their animation and background
tick loops and display a reload error. Ordinary server tick exceptions keep the tick loop running.

This is Phase 3b-1 availability handling. Geometry/scalar validation, joint limits and native
allocation leaks remain for Phase 3b-2. Invalid geometry can still corrupt other bodies without
throwing, so a successful health probe cannot detect every failure. Pending asynchronous native
continuations are not globally cancelled after fatal shutdown.

## API

### `.networkId`: String

A unique ID for the current server or client.

### `.isServer`: Boolean

Whether the script is currently executing on the server.

### `.isClient`: Boolean

Whether the script is currently executing on the client.

### `.add(node)`

Adds a node into world-space, outside of the apps local hierarchy.

### `.remove(node)`

Removes a node from world-space, outside of the apps local hierarchy.

### `.attach(node)`

Adds a node into world-space, maintaining its current world transform.

### `.on(event, callback)`

Subscribes to both engine events (eg when players `enter` or `leave` the world) and custom events emitted by other apps (via `app.emit()`)

#### Engine events

- `enter`: a player enters the world (`{ playerId }`).
- `leave`: a player leaves the world (`{ playerId }`).
- `wallet`: the local client's server-verified wallet status is accepted. The payload is a frozen
  `{ playerId, verified }` object; `verified` is a boolean independent of build permission. Only
  the local player produces this event, only on the client. Discarded/obsolete statuses emit
  nothing, and scripts cannot emit or send this engine event. The balance is not in the event;
  read it with [`player.getTokenBalance()`](/docs/scripting/world/Player.md).

```js
world.on('wallet', async ({ playerId, verified }) => {
  const result = await world.getPlayer().getTokenBalance()
  // Update the local wallet/balance display.
})
```

### `.off(event, callback)`

Unsubscribes from world events.

### `.raycast(origin: Vector3, direction: Vector3, maxDistance: ?Number, layerMask: ?Number)`

Raycasts the physics scene.
Returns the nearest hit (`point`, `normal`, `distance`, `tag`, `playerId`), or `null`.
If `maxDistance` is omitted or `null`, max distance is infinite. Zero is allowed; negative values,
NaN and non-numbers throw. `origin` and `direction` accept endowed and stock THREE `Vector3`
instances; lookalike objects throw. A component that is non-finite or overflows float32 returns
`null` and logs a warning once, without querying physics.

An omitted or `null` `layerMask` means `0` (unfiltered). Explicit masks must be integers in
`[-2147483648, 4294967295]` and are converted to unsigned 32-bit masks; invalid masks throw.

### `.overlapSphere(radius: Number, origin: Vector3, layerMask: ?Number)`

Returns an array of overlapping physics hits, each exposing `tag` and `playerId` (which may be
`null`). No hits returns `[]`.

`radius` must be positive and remain finite and positive after conversion to float32; invalid
radii throw. `origin` accepts endowed and stock THREE `Vector3` instances; lookalike objects
throw. Non-finite or float32-overflow origin components return `[]` and log a warning once.
`layerMask` follows the same rules as `raycast`, including unfiltered `undefined`/`null`.
Changing query radii reuses one native sphere geometry rather than growing a radius cache.

### `.createLayerMask(...groups)`

Creates a bitmask to be used in `world.raycast()`.
Currently the only groups available are `environment` and `player`.

### `.getPlayer(playerId)`: Player

Returns a player. If no `playerId` is provided it returns the local player.

### `.getPlayers()`: [...Player]

Returns an array of all players.

### `.getQueryParam(key)`

Gets a query parameter value from the browsers url

### `.setQueryParam(key, value)`

Sets a query parameter in the browsers url

### `.open(url: string, newTab: ?Boolean)`

Opens a link in the current window, or in a new tab when `newTab` is true (client only).

Only `http(s)` URLs can be opened: relative paths resolve against the world's own origin and a bare host (`example.com/page`) gets `https://`, while scheme URLs such as `javascript:`, `data:` or `blob:` and anything served from the world's `/assets/` store (including `asset://` URLs and percent-encoded spellings of it) are rejected with a console error. A `host:port/path` without a scheme is rejected too (it parses as a scheme); write `http://host:port/path`. New tabs are opened with `noopener,noreferrer`, so the opened page cannot reach the world.
