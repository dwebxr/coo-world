# Mesh

Represents a mesh to be rendered. 
Internally the mesh is automatically instanced for performance.

NOTE: A script cannot set a mesh's material (`mesh.material = …` throws `[mesh] set material not supported`): materials
come from the app's model (a GLTF, e.g. made in Blender). A script can give a mesh the geometry of another mesh (see
below).

## A mesh made by a script

`app.create('mesh')` makes a mesh with `type: 'box'`, `width`, `height` and `depth` `1`, `radius` `0.5`, no `geometry`,
no material and `linked: true`. Added to an app, it draws nothing, and neither does one with another `type` or size: a
mesh is only put into the scene once its `geometry` is set, whatever its `type` (from the code: `mount` returns when
there is no geometry, before it reads `type`).

To see something:

- For a box, a sphere or another simple shape, use a [Prim](/docs/scripting/nodes/types/Prim.md) node:
  `app.create('prim', { type: 'box' })` is drawn.
- To show a mesh of the app's model once more, clone it: `app.get('Cube').clone()` (for a mesh named `Cube` in the
  model), added to the app, is drawn with the model's geometry and material.
- A mesh made with `app.create('mesh')` is drawn once it has a `geometry` (another mesh's, `app.get('Cube').geometry`),
  with a plain white material. With a geometry set, `type: 'box'` draws a box of `width`, `height` and `depth`,
  `type: 'sphere'` a sphere of `radius` (the geometry given is not drawn), and `type: 'geometry'` draws the geometry
  given.

```javascript
const box = app.create('mesh', {
  type: 'box',
  width: 2,
  height: 3,
  depth: 4,
  geometry: app.get('Cube').geometry,
})
app.add(box)
```

With `linked: true` (the default), the meshes one app's script made that draw the same geometry (the same box size,
sphere radius or geometry given) with the same `castShadow` and `receiveShadow` are drawn together as one batch, with
one white material of that app's own. They share that material: its `color`, for one, is the same for all of them.
Another app's meshes are another batch with another material, so one app's script cannot recolour them; so are the
meshes of a model that have that geometry and a material of their own. The batch and its material are let go once the
batch has had no mesh for 10 seconds (for instance after the app is removed). With `linked: false` each mesh has a
white material of its own. (Until this was corrected, giving a
`geometry` to a script's mesh with `linked: true` crashed the app.)

These were observed in a test that runs a script with the engine's app, stage and mesh node, not in a browser ("drawn"
here: put into the scene). The default is left as it is on purpose: drawing a box for a mesh without a geometry would put
boxes into existing worlds whose scripts create such meshes.

## Properties

### `.castShadow`: Boolean

Whether this mesh should cast a shadow. Defaults to `true`.

### `.receiveShadow`: Boolean

Whether this mesh should receive a shadow. Defaults to `true`.

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties
