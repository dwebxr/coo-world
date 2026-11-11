# Node

The base class for all other nodes.

## Properties

### `.id`: String

The ID of the node. This is auto generated when creating nodes via script. For GLTF models converted to nodes, it uses the same object name you would see in blender.

NOTE: Blender GLTF exporter does rename objects in some cases, eg by removing spaces. Best practice is to simply name everything in UpperCamelCase with no other characters.

### `.position`: Vector3

The local position of the node.

### `.quaternion`: Quaternion

The local quaternion rotation of the node. Updating this automatically updates the `rotation` property.

### `.rotation`: Euler

The local euler rotation of the node. Updating this automatically updates the `quaternion` property.

### `.scale`: Vector3

The local scale of the node.

For app root transforms sent over the network, position, quaternion and scale validation follows the
[app transform rules](/docs/scripting/app/App.md). Local node assignments and composed child
transforms are not constrained by that network boundary.

### `.matrixWorld`: Matrix4

The world matrix of this node in global space.

### `.parent`: Node

The parent node, if any.

### `.children`: [Node]

The child nodes.

### `.cursor`: String

The page's mouse cursor while the pointer is over the node: a CSS cursor keyword (`pointer`, `grab`, `crosshair`,
`not-allowed`, ...), or `null`. Anything other than a string throws. A string that is not a keyword, such as an image
cursor without one, is not used: the property reads back as `null` and the default cursor shows. Of an image cursor
with its fallback (`url(hand.png), pointer`) the closing keyword is used, and the property reads back as that
keyword; the image is not.

## Methods

### `.add(otherNode)`: Self

Adds `otherNode` as a child of this node.

Adding a node to itself or to one of its own descendants throws (`[node] cannot add a node to itself or to one of
its descendants`), so the parent chain can never loop. One app may have at most 20,000 nodes mounted at once
(in its own tree and in world space together) and 256 levels of nesting below a mounted root; nodes that are created
but not added (for example clones kept for later) do not count. Mounting past either limit throws
`[app] node limit reached: …` and crashes the app, as any other script error does.

A node is counted for the app it is mounted for. Moving a mounted node (also one placed in world space with
`world.add`) under another node unmounts it and mounts it again at its new place, so it is counted at its new depth.
A node that was never placed in the world (or under a mounted node) is not mounted by setting `active = true`.

A node belongs to the app run that created, loaded or mounted it: a node made with `app.create`, a tree
`world.load()` returned (its root, its children and their clones), and every node of the app's model, also one below
an inactive node that has never mounted. Once that run has ended (the app was removed or rebuilt), or while its nodes
are being torn down, every method and setter of the node throws `[app] this app has stopped`; getters keep reading. A
node that is not mounted does not play, animate or load (an audio's `play()`, a skinned mesh's `play()`, a UI image's
`src`), and nothing mounts or rebuilds under a node while it unmounts.

A handle follows its node. If another app's live run places the node (it was handed that app's way, and that app adds
it with `world.add` or under one of its own nodes), the node then belongs to that run: every handle of the node, also
one the first app kept, works again for as long as that run lasts and stops with it, and that run's teardown releases
what the node holds.

A node keeps plain values. A setter that takes a number, a string or a boolean refuses an object that only stands
for one (a boxed `new Number(1)` or `new String('red')`, a Proxy): `audio.volume = new Number(0.5)`,
`mesh.castShadow = new Boolean(false)` and a material's `color = new String('red')` throw. `active`, a joint's
limits and `collide`, and an LOD's `insert(node, maxDistance)` refuse objects too. (A node's transform is not a
setter of the node: its components follow the number rule of [the math classes](/docs/scripting/Utils.md), where a
boxed value is `NaN` and a numeric string a number.) An array a node gives back (a UI's `padding`, `margin` and
`scaler`, a particles node's `shape`, `bursts` and `spritesheet`) is the node's own frozen copy of what was set:
changing it throws a `TypeError`; set the property again instead.

A node handle's setters act on the handle they are called on (their receiver), which must be a node handle or an
object that inherits from one (`Object.create(node)` works like the handle). Any other receiver is refused: a setter
copied onto another object (`Object.defineProperties({}, Object.getOwnPropertyDescriptors(node))`) or called without a
receiver throws `[node] not a node`, and one called on the handle of a node that has no such property (a mesh's
`castShadow` setter called on a group's handle) throws `[node] a group node has no castShadow to set`. A method acts on
the node it was read from: it can be taken off the handle and called on its own, and keeps its `name` and `length`.

An app's root (what its `app` stands for) stays where its app placed it: adding another app's root throws
`[node.add] cannot add another app's root node`, and so does adding an app's own root under a node that is not
placed anywhere yet (place that node first, then add the root).

### `.remove(otherNode)`: Self

Removes `otherNode` if it is a child of this node.

### `.traverse(callback)`

Traverses this and all descendents calling `callback` with the node in the first argument.





