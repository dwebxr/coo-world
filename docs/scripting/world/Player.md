# Player

Represents a player. An instance of Player can be retrived via [World.getPlayer](/docs/scripting/world/World.md)

## Properties

### `.id`: String

The players unique ID. This is always the same for the same player, even when they leave and come back.

### `.name`: String

The players name.

### `.local`: Boolean

Whether the player is local to this client.

### `.admin`: Boolean

Whether the player is an admin in this world.

### `.position`: Vector3

The players position in the world.

Shared positions are supported within `[-1e6, 1e6]` metres on each axis (`TRANSFORM_LIMIT`). Local
movement can go beyond this extent, but other players then see the last accepted in-range position.
See [world extent](/docs/scripting/world/World.md#shared-world-extent).

### `.quaternion`: Quaternion

The players rotation in the world.

### `.rotation`: Euler

The players rotation in the world.

## Methods

`teleport` and `push` accept endowed and stock THREE `Vector3` instances; lookalike objects
throw. Non-finite or float32-overflow vector components are ignored, with one warning per method.
The relay bounds below still apply; direct local pushes have no additional `1e4` cap.

### `.getTokenBalance()`: Promise<{ verified, known, balance }>

Returns an intrinsic Promise of a fresh, frozen `{ verified, known, balance }` object for the
local player on a client. The balance is the configured world's COO token in the wallet's
associated SPL Token account; other accounts and Token-2022 are not counted.

- `verified`: the server has verified ownership of the wallet for this connection.
- `known`: a balance read succeeded. A missing token account is known with balance `0`.
- `balance`: a finite, nonnegative token amount, or `0` when unknown. Check both booleans before using it.

A remote player, any server script, or disabled token gating returns
`{ verified: false, known: false, balance: 0 }` without a request. Remote/server use warns once per
app. Operational failures resolve unknown; the Promise never rejects. A call on a stopped app
or in a fatal world throws synchronously, like other guarded APIs. If the app crashes, rebuilds,
is destroyed, or the world becomes fatal while waiting, the old call never settles.

Balances may be up to the server cache TTL (default 30 seconds, configurable up to 300 seconds)
plus 5 seconds on the client old. Budget pressure or outages can make a read unknown; the global
budget bounds cost, not availability. Ownership must be verified again after reconnect or restart.
After verification, any client script in this world can read this balance and send it to a server
script. Neither the wallet address nor verification is stored in player data.

A door opened using this result affects the player's **own screen only**. It is not server-enforced
passage control: a modified client can open it for itself. Use the engine's
[`wallet` event](/docs/scripting/world/World.md#engine-events) to refresh displays after verification changes.

```js
if (world.isClient) {
  try {
    const result = await world.getPlayer().getTokenBalance()
    if (result.verified && result.known && result.balance >= 10000) {
      // Open this client's door.
    }
  } catch (err) {
    // The app has stopped; no request was started.
  }
}
```

### `.teleport(position, rotationY)`

Teleports the player instantly to the new position. The `rotationY` value is in radians, and if omitted (or not a number) the player will continue facing their current direction.

On a client, only the local player can be teleported; server scripts can teleport any player.

Every position component must be finite and within `[-1e6, 1e6]` metres. A server-sent teleport or
local script teleport outside that bound is ignored. `rotationY` must be a finite number to change
the facing direction; otherwise only the position is applied.

### `.push(force)`

Applies a short, impulse-like push to the player in world-space. Multiple pushes accumulate vectorially and decay over time with high drag.

- **force**: A direction/impulse vector. Accepts a `Vector3`.

Behavior:
- Adds the impulse to the player’s current push; subsequent calls add to the existing push rather than replacing it.
- On a client, only the local player can be pushed; server scripts can push any player.
- Server-to-client push relays require every force component to be finite and within `[-1e4, 1e4]`;
  the entire push is ignored otherwise. Direct local script pushes bypass this relay bound.

Example:
```js
// Dash forward relative to camera yaw
const FORWARD = new Vector3(0, 0, -1)
const euler = new Euler(0, 0, 0, 'YXZ')
const quat = new Quaternion()

euler.setFromQuaternion(world.getPlayer().quaternion)
euler.x = 0; euler.z = 0
quat.setFromEuler(euler)

const dir = FORWARD.clone().applyQuaternion(quat).normalize()
world.getPlayer().push(dir.multiplyScalar(30)) // short forward burst
```

### `.setSessionAvatar(url)`

Changes the avatar the player wears for the rest of their session. It does not change the avatar saved on their profile, and it is gone when they leave.

- **url**: an `asset://<name>.vrm` URL (a built-in avatar or an uploaded one) or an `http(s)://` URL, up to 512 characters. `null` clears the session avatar. Other values are ignored.

On a client, only the local player's session avatar can be set; server scripts can set any player's.

### `.getBoneTransform(boneName)`: Matrix4

Returns a matrix of the bone transform in world space.

See [Avatar](/docs/scripting/nodes/types/Avatar.md) for full details.

### `.damage(amount)`

Removes health from the player. Health cannot go below zero.

### `.heal(amount)`

Adds health to the player. Health cannot go above 100.

### `.applyEffect({ anchor, emote, snare, freeze, turn, duration, cancellable, onEnd })`

Applies an effect to the player. If the player already has an effect, it is replaced. The returned
handle has a `cancel()` method; `player.cancelEffect()` also ends the effect applied by this app.

All options are optional.

**anchor**: an [Anchor](/docs/scripting/nodes/types/Anchor.md) to attach the player to. Its network
`anchorId` must be a string of at most 128 characters. A longer or non-string `anchorId` drops the
whole effect sent to other players, including its emote, snare and duration. Scale is removed when
deriving the player's rotation, which is normalised. A non-finite, singular or out-of-range anchor
pose is ignored for that frame, preserving the previous pose.

**emote**: a string URL to an emote to play while this effect is active: `asset://<name>.glb`
(optionally with a playback query, eg `?s=1.5`) or an `http(s)://` URL, up to 512 characters. Invalid
values are ignored locally and do not replace locomotion. Playback speed `s` must parse to a finite
number in `[0.01, 100]`, otherwise it defaults to 1. The `l`/`g` string flags are unchanged.

**snare**: a finite number from 0 to 1 that reduces movement speed, where zero means no snaring and one means entirely snared. Invalid values are treated as 0. When snared, players can still turn and attempt to move.

**freeze**: when true, the player is frozen in place and all movement keys are ignored.

**turn**: a boolean. Only `true` makes the player continually face the direction the camera is looking in.

**duration**: seconds until the effect ends as local simulation time advances. A falsy value
(`0`, `''`, `null`, `undefined`, `NaN` or `false`) means no expiry. Other values count down as
`Number(duration) - delta`: positive remaining time is stored, otherwise the effect ends. Negative
values and non-numeric truthy values end on the next frame; numeric strings such as `'2'` expire
after that many seconds. `Infinity` never expires.

**cancellable**: whether any movement keys will cancel the effect. if enabled, freeze is ignored.

**onEnd**: a function that should be called either at the end of the `duration` or when the player moves if `cancellable`.

### `.screenshare(screenId)`

Can only be called on a local player.

Prompts the player to share their screen, and then casts it to all video nodes that have a matching `.screenId` property.

### `.setVoiceLevel(level)`

Overrides the players voice chat level to `disabled`, `spatial` or `global`.

By default all players have the voice level defined in the world settings menu, but `.setVoiceLevel` allows apps to override it using any logic needed.

Calling `player.setVoiceLevel(null)` removes the current apps override and reverting to the world setting (unless another app is overriding it).

**NOTE:** Changes stack with priority, so if two apps have set a voice level, the higher priority level takes precendence. Global is the highest priority.

Must be called on the server for security reasons.
