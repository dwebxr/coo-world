# Material

A material on a [Mesh](/docs/scripting/nodes/types/mesh/Mesh.md) node.

`mesh.material` belongs to the run of the app the mesh is mounted for: reading it again in that run gives the same
object (also for another mesh of the run that uses the same material), and the object is frozen, so nothing can be
added to it or redefined on it. Once that app stops (it is removed or rebuilt), setting a property on a material
kept from it throws `[app] this app has stopped` (a write to `id` throws a `TypeError`, also after the app has
stopped); reading still works. The app's own `destroy` handler still runs inside its run (also when the app
crashed), so it can set a material back. Another app gets its own object for the same material. A mesh that is not
mounted (not yet added to the app or to world space, or removed again) has no material: `undefined`.

## Properties

A material has only the properties below; `id` is read-only, and setting it throws a `TypeError`. Setting any
property a material does not have (`material.opacity = 0.5`) does nothing: the write is ignored, and the app's console
says so once per name in each run of the app, for the first 16 names of a run; the next new name gets one line saying
that further ones are not reported, and after that nothing is said in that run. What counts as one name: a name of up
to 64 characters is itself; a longer one counts by its length only (two long names of the same length count as one,
and the line shows only the length); a symbol counts by its description under the same rule, and a string and a
symbol never count as one. So the 17th different property set need not be the one that gets the last line.

### `.id`: String

The material's id. Read-only: setting it throws a `TypeError`.

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