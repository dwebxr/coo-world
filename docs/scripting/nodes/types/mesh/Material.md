# Material

A material on a [Mesh](/docs/scripting/Mesh.md) node.

## Properties

### `.textureX`: Number

The offset of the texture on the `x` axis. Useful for UV scrolling. Must be a finite number.

### `.textureY`: Number

The offset of the texture on the `y` axis. Useful for UV scrolling. Must be a finite number.

### `.color`: String

The base color of the material. Set it with any valid CSS color string (e.g. "red", "#ff0000", "rgb(255,0,0)");
anything that is not a string throws. Reading it gives a new `Color` with the material's current values (`r`, `g`,
`b`, `getHexString()`, ...): changing that object does not change the material, assign a string instead. A
material can be shared by several apps, so its own colour is never handed out.

### `.emissiveIntensity`: Number

The emissive intensity of the material. Values greater than `1` will activate HDR Bloom, as long as the emissive color is not black. Must be a finite number.

### `.fog`: Boolean

Whether the material is affected by fog. Must be a boolean.