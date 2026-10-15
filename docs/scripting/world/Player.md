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
`anchorId` must be a string of at most 128 characters. Scale is removed when deriving the player's
rotation, which is normalised. A non-finite, singular or out-of-range anchor pose is ignored for
that frame, preserving the previous pose.

**emote**: a string URL to an emote to play while this effect is active: `asset://<name>.glb`
(optionally with a playback query, eg `?s=1.5`) or an `http(s)://` URL, up to 512 characters. Invalid
values are ignored locally and do not replace locomotion. Playback speed `s` must parse to a finite
number in `[0.01, 100]`, otherwise it defaults to 1. The `l`/`g` string flags are unchanged.

**snare**: a finite number from 0 to 1 that reduces movement speed, where zero means no snaring and one means entirely snared. Invalid values are treated as 0. When snared, players can still turn and attempt to move.

**freeze**: when true, the player is frozen in place and all movement keys are ignored.

**turn**: a boolean. Only `true` makes the player continually face the direction the camera is looking in.

**duration**: a finite non-negative number of seconds. A positive value expires as local simulation
time advances; 0 or an omitted value means no expiry. Invalid values are ignored.

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
