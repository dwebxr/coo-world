# RigidBody

A rigidbody that has colliders as children will act under physics.

Contact and trigger callbacks are experimental.

## Properties

### `.type`: String

The type of rigidbody, either `static`, `kinematic` or `dynamic`. Defaults to `static`.

NOTE: if you plan to move the rigidbody with code without being dynamic, use `kinematic` for performance reasons.

### `.onContactStart`: Function (Experimental)

The function to call when a child collider generates contacts with another rigidbody.
Receives a [contact event](#event-objects).

### `.onContactEnd`: Function (Experimental)

The function to call when a child collider ends contacts with another rigidbody.
Receives a [contact event](#event-objects) with an empty `contacts` array.

### `.onTriggerEnter`: Function (Experimental)

The function to call when a child trigger collider is entered.
Receives a [trigger event](#event-objects).

### `.onTriggerLeave`: Function (Experimental)

The function to call when a child trigger collider is left.
Receives a [trigger event](#event-objects).

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties

## Event objects

Contact callbacks receive `{ tag, playerId, contacts }`. `tag` and `playerId` identify the other
body (and may be `null`); `contacts` contains up to 64 points, each with `position`, `normal` and
`impulse` as `Vector3` values. Contact-end events always have an empty `contacts` array.
Normals retain the physics engine's pair orientation; they are not flipped for each recipient.

Trigger callbacks receive `{ tag, playerId, isLocalPlayer }`. `isLocalPlayer` is true when the
other body belongs to this client's local player, including for a synthetic trigger leave.

Every recipient gets a fresh event, array and vectors. You may retain or modify them: another
recipient is unaffected, and the engine never clears or reuses those objects. Callbacks have no
bound receiver (`this` is `undefined`). Ordinary contacts are delivered after the physics step,
then triggers, before interpolated node positions are updated.

Removing a body queues synthetic contact-end and trigger-leave callbacks for the next physics
step, before simulation. They do not run inside the removal call. Callbacks queued during that
dispatch wait for the following step. A recipient that has been removed, remounted or whose app
script has been rebuilt or stopped is skipped, including when an earlier recipient removes it.

## Static-body methods

`getVelocityAtPos(position, target?)` and `getLocalVelocityAtLocalPos(position, target?)` return
a zero vector for a static or unmounted body. They return the supplied target, or a new vector
when it is omitted. `addForceAtPos(force, position, mode?)` and
`addForceAtLocalPos(force, position, mode?)` do nothing for those bodies. These checks use the
currently mounted actor, including while a type change awaits rebuilding.

See [physics availability](/docs/scripting/world/World.md#physics-availability) for native failure
handling and its limits.
