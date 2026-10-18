# Controller

A capsule controller that can be used to easily build moving characters, npcs, pets, mounts etc.

An invalid native capsule descriptor or failed allocation disables this node's physics and
logs one warning. Even positive dimensions can form an invalid descriptor with the controller's
step offset. Without a native controller, `move` does nothing and `teleport` still updates the
node position. This mount check does not provide general geometry/scalar validation.

## Properties

### `.radius`: Number

The radius of the capsule. Defaults to `0.3` which is the same as the player capsule.

### `.height`: Number

The height of the mid section of the capsule. Defaults to `1` which is also the same as the player capsule.

### `.layer`: String

The physics layer for this controller. This determines what the controller collides with. Can be `environment` or `prop` or `tool`. Defaults to `environment`.

### `.tag`: String

A tag that can be seen by raycast, trigger and contact events.

### `.onContactStart`: Function

A function that is called whenever another physics object comes in contact with this controller.
Receives a [contact event](RigidBody.md#event-objects).

### `.onContactEnd`: Function

A function that is called whenever another physics object ends contact with this controller.
Receives a [contact event](RigidBody.md#event-objects) with an empty `contacts` array.

Events and their contact arrays/vectors are fresh per recipient and may be retained. Synthetic
end events caused by removal run at the next physics step, before simulation. Removed, remounted
or rebuilt recipients are skipped.

### `.isGrounded`: Boolean

A read-only property describing whether the controller is standing on something. Returns `false` before the first move (as does `.isCeiling`).

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties

## Methods

`move` and `teleport` accept endowed and stock THREE `Vector3` instances; lookalike objects
throw. Non-finite or float32-overflow vector components are ignored, with one warning per method.

### `.move(vec3)`

The primary utility of a controller. Will move the controller in the direction and magnitude specified, but will also slide against walls etc.

Note that controllers do not have gravity by default, but you can simulate this by setting vec3.y = -9.81 for example.

### `.teleport(vec3)` 

Teleports the controller to a new position. Before mounting, this sets the position used at mount without requiring a native controller.
