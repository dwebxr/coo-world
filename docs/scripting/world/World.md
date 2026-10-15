# World

The global `world` variable is always available within the app scripting runtime.

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

### `.off(event, callback)`

Unsubscribes from world events.

### `.raycast(origin: Vector3, direction: Vector3, maxDistance: ?Number, layerMask: ?Number)`

Raycasts the physics scene.
If `maxDistance` is not specified, max distance is infinite.
If `layerMask` is not specified, it will hit anything.

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
