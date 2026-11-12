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

The data is read once, when `app.send` (or `app.sendTo`) is called, and what goes out is the engine's copy of it. If reading it ends the app's run (a getter that removes or rebuilds the app), nothing is sent and the call throws `[app] this app has stopped`; if reading it sends another message (a getter that calls `app.send`), that message goes out first and this one after it. The copy holds what the data held: numbers, strings, booleans, `null`, arrays, objects (their own properties; an instance of a class is sent as a plain object, or as what its `toJSON()` returns), and `Map`, `Set`, `Date` and typed arrays (a subclass of one of these is sent as the built-in). A function in it is sent as `undefined` (or as what its `toJSON()` returns, if it has one). Data with more than 524,288 values in all is refused with a `RangeError` (it would not fit the largest packet).

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

Per connection, sustained input is about 32k decoded nodes/s, shared by all apps and other packets. Of the events one connection sends, the server's apps take at most 320 a second (up to 1,280 at once after a quiet time), shared by all the apps that connection sends to; an event counts when the app keeps it (it arrives while the app is building, or it is a builder's event for the blueprint's next version) or when the running server script has a listener for its name, and no other event counts. An event over that is dropped, not delayed: the server script never gets it, although `app.send` returned `true` in the browser. The server counts it with the app's dropped events, and the browser console warns once, from the browser's own count, that events may be dropped. Do not send on every frame (one app doing so sends 60 to 240 events a second, depending on the display): send at a fixed rate, and deltas, not full state. Events that waited out a network stall arrive together and count as one burst. While rebuilding, an app keeps at most 64 pending events; server byte, node and shared queue budgets can reduce this further, dropping the app's own oldest events first.

On the server, packets are capped at 512 KiB. Script output (`app.send`, `app.sendTo`, script chat, player relays and voice updates) shares a 512 KiB budget of unique bytes per tick, counted once before broadcasting. A call that exceeds the packet or tick budget sends nothing and returns `false`. A recipient is skipped if the write would take its accounted backlog above 512 KiB; `app.send` returns `false` if any recipient is skipped, even when others receive the event. Script traffic does not disconnect a recipient for being behind; system traffic that would exceed 1 MiB of backlog disconnects that client.

Script chat bodies must be text. Numbers are converted to text; other values are refused. See [`world.chat`](/docs/scripting/world/World.md) for how script messages are shown.

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

## Teardown

When an app is removed or rebuilt (its blueprint changed, it crashed), the engine tears its run down in this order:
the run's `destroy` listeners, then its controls (their `onRelease`), its player handles (their effects end: `onEnd`),
its nodes (its own and those it placed in world space), its listeners, its update registration, its requests, its
object URLs and its timers. A crash tears the run down the same way, at once, whether or not the crash block can be
shown. Your script can still run during that: from those callbacks and from a world listener an event it emits
reaches. (The engine's own math objects a handle gives you, such as a node's `matrixWorld`, are sealed, so the engine
does not read anything a script defined on them; see [Utils](/docs/scripting/Utils.md).)

A call can also run your code while it reads its arguments: a getter on an options object, a `toString` on a name,
a `valueOf` on a number. If that code ends the run (it removes or rebuilds the app), the call makes nothing for the
run: a method that makes something the run owns (a listener, a control, an effect, a voice level, a node placement,
fields) reads its arguments first, then checks that the run that called it is still current and that its stage has not
begun, and only then makes it. Such a call throws `[app] this app has stopped`. The same holds for the engine callbacks a call itself causes, such as the `onEnd` of the
effect `applyEffect` replaces or of a handle a lookup evicts: the run is checked again after them.

A rebuild or removal asked for during a teardown (by a host listener of an event the script emits from `destroy`)
waits until that teardown has finished. A rebuild asked for that way takes its place in the build order when it is
asked for: a newer build (a blueprint change that arrives meanwhile) supersedes it, and a removal wins over both.

Two kinds of things behave differently:

**What the run owns** is released at teardown and cannot be made again by the run once its stage has begun; a handle
kept to it does nothing afterwards:

- controls: `app.control()` throws `[app] this app has stopped` from the start (in a `destroy` listener too);
- player effects and voice levels: from the player stage on, `world.getPlayer()` and `world.getPlayers()` throw
  `[app] this app has stopped`, and no handle of the run starts an effect or a voice level (`applyEffect`,
  `setVoiceLevel(level)` throw); ending them (`cancelEffect`, `setVoiceLevel(null)`) still works;
- nodes and what they hold (meshes, sounds, videos, animations, physics): from the node stage on, `world.add`,
  `world.attach` and every method and setter of a node of the run throw `[app] this app has stopped` (getters keep
  reading), and nothing mounts or rebuilds for the run; a node's handle stays that way once the run has ended;
- listeners (`app.on`, `world.on`), requests (`fetch`), object URLs (`URL.createObjectURL`, all revoked at their stage)
  and timers (`setTimeout`) are refused from their own stages.

Whatever the run makes before a stage (a player looked up in a `destroy` listener, a timer set from an effect's
`onEnd`) is released by that stage.

**Effects on shared or persistent state** are not resources: chat messages (`world.chat`), network sends
(`app.send`, `app.sendTo`, `app.emit`), storage writes (`world.set`), a player's `teleport`, `push`, `damage`, `heal`,
`setSessionAvatar` and `screenshare`, wallet queries and `world.open`. They are allowed while the run is alive,
including in the callbacks the teardown runs, and refused (`[app] this app has stopped`) once the run has ended.
