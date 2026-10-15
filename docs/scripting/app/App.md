# App

The global `app` variable is always available within the app scripting runtime.

## Properties

### `.instanceId`: String

The instance ID of the current app.
Every app has its own unique ID that is shared across all clients and the server.

### `.version`: String

The version of the app instance.
This number is incremented whenever the app is modified which includes but is not limited to updating scripts and models.

### `.state`: Object

A plain old javascript object that you can use to store state in.
The servers state object is sent to all new clients that connect in their initial snapshot, allowing clients to initialize correctly, eg in the right position/mode.

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties

When app transforms cross the network (creation or builder edits), position components must be finite
and within `[-1e6, 1e6]` metres. Quaternions with a norm within 0.1 of 1 are normalised; other rotations
are refused. Each scale component must convert to a finite, non-zero f32 value; negative scales and
`1e-9` are allowed, and scale has no `1e6` magnitude cap. Invalid modify fields retain their previous
values; invalid transforms reject a new app. A mover who loses builder rank can only release its own
move/upload, retaining the last accepted transform even if the release packet includes new ones.

These checks apply to network entity transforms, not arbitrary script assignments, composed node
hierarchies or persisted builder records on load. Octrees park non-finite/out-of-budget items: they
can still render but cannot be picked through the octree until a valid move reinserts them. See
[shared world extent](/docs/scripting/world/World.md#shared-world-extent).

## Methods

### `.on(name, callback)`

Subscribes to custom networked app events and engine update events like `update`, `fixedUpdate` and `lateUpdate`.

Custom networked events are received when a different client/server sends an event with `app.send(event, data)`. 

IMPORTANT: Only subscribe to update events when they are needed. The engine is optimized to completely skip over large amounts of apps that don't need to receive update events.

### `.off(name, callback)`

Unsubscribes from custom events and update events.

IMPORTANT: Be sure to unsubscribe from update events when they are not needed. The engine is optimized to completely skip over large amounts of apps that don't need to receive update events.

### `.send(name, data, skipNetworkId)`

Sends an event across the network.
If the caller is on the client, the event is sent to the server. The third argument `skipNetworkId` is a no-op here.
If the caller is on the server, the event is sent to all clients, with the `skipNetworkId` argument allowing you to skip sending to one specific client.

An event sent from a client must fit in 64 KiB on the wire, including the event name and packet envelope, with at most 8,192 decoded nodes and a depth of 32. `app.send` returns `false` when the data does not fit these limits or fails the plain-msgpack checks. Encoding errors listed below throw in the sender. A successful client send is not a delivery acknowledgement: the server can still drop it under load.

Client-to-server events use plain MessagePack. Prefer numbers, strings, booleans, null, arrays, plain objects and `Uint8Array`; other values behave as follows. Server-to-client events retain the existing structured-clone encoding.

| Data passed to client `app.send` | What the server receives |
| --- | --- |
| `Map` with string keys | A plain object |
| `Set` | An array |
| `Error` | `[name, message, cause]`; the third value is `undefined` when there is no cause |
| `RegExp` | `[source, flags]` |
| Functions | `undefined`, including object properties and array elements |
| `undefined` | `undefined` |
| `Uint8Array` | A fresh `Uint8Array` with the same bytes |
| Other numeric typed arrays | A `Uint8Array`; element-to-byte conversion can alter bytes and loses the original type |
| `BigInt64Array` or `BigUint64Array` | Throws in the sender |
| `Date` or a `Map` with non-string keys | Refused by client preflight and by the server |
| BigInt in the signed or unsigned 64-bit range | A Number, with possible loss of precision |
| `Symbol` or BigInt outside the signed/unsigned 64-bit range | Throws in the sender |
| A cyclic value or an object with more than 65,535 keys | Throws in the sender |
| The same object used twice | Two independent copies |
| `-0` | `0` |

Per connection, sustained input is about 32k decoded nodes/s, shared by all apps and other packets. Send deltas, not full state, at high rates. While rebuilding, an app keeps at most 64 pending events; server byte, node and shared queue budgets can reduce this further, dropping the app's own oldest events first.

On the server, packets are capped at 512 KiB. Script output (`app.send`, `app.sendTo`, script chat, player relays and voice updates) shares a 512 KiB budget of unique bytes per tick, counted once before broadcasting. A call that exceeds the packet or tick budget sends nothing and returns `false`. A recipient is skipped if the write would take its accounted backlog above 512 KiB; `app.send` returns `false` if any recipient is skipped, even when others receive the event. Script traffic does not disconnect a recipient for being behind; system traffic that would exceed 1 MiB of backlog disconnects that client.

Script chat bodies must be text. Numbers are converted to text; other values are refused.

### `.emit(name, data)`

Emits a local event to the world that other apps can listen for (using `world.on(name, callback)`).
Emitted events are not networked and only "local" apps (on the same client or server) can receive/listen for them.

NOTE: you cannot emit built-in events such as `enter` or `leave` as these are internal and emitted when players enter or leave the world.

### `.get(nodeId)`: Node

Finds and returns any node with the matching ID from the model the app is using.
If your model is made with blender, this is the object "name".

NOTE: Blender GLTF exporter renames objects in some cases, eg by removing spaces. Best practice is to simply name everything in UpperCamelCase with no other characters.

### `.create(nodeName)`: Node

Creates and returns a node of the specified name.

### `.control(options)`

Gives you control to listen for inputs and modify things like camera position. See [Control(/docs/scripting/app/Control.md) for more info.

#### `.configure(fields)`

Configures custom UI for your app. See [Props](/docs/scripting/app/Props.md) for more info.
