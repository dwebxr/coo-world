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

The page's mouse cursor while the pointer is over the node (a CSS cursor value, at most 128 characters), or
`null`. Anything other than a string throws.

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

### `.remove(otherNode)`: Self

Removes `otherNode` if it is a child of this node.

### `.traverse(callback)`

Traverses this and all descendents calling `callback` with the node in the first argument.





