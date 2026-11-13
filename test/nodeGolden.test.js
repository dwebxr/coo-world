// The golden characterization of the node classes (P17-0). test/lib/nodeGolden.mjs runs every node type (Node and
// the 23 exports of src/core/nodes/index.js) through a fixed list of cases and writes what happened as text, one file
// per type in test/golden/nodes/. This test generates that text again and compares it with the files; a difference
// fails, with the first differing lines. The types are shared among three files that run side by side (SHARDS in
// test/lib/nodeGolden.mjs): this one, nodeGoldenScene.test.js and nodeGoldenUi.test.js.
// `UPDATE_GOLDEN=1 node --test test/nodeGolden*.test.js` rewrites the files; the diff of the rewritten files is then
// the record of what a change did, to be read line by line.
//
// It records behaviour as it is today, defects included: a line in the files is not a statement that the behaviour is
// right, and a change that keeps the files equal is not shown to be safe. It sees only what the cases below ask.
//
// What it does NOT see:
// - what a mount, a commit or a build makes: the three.js meshes, materials and textures, the UI canvas and what is
//   drawn on it, the Yoga layout's results, the WebAudio graph, the PhysX actors and shapes, the particle worker. The
//   nodes are never mounted for real; row e only puts stand-ins where a setter looks for a mounted node's parts, and
//   records what the setter did to them.
// - anything asynchronous: a load (a texture, an image, a video, an avatar, a sound) and what happens when it ends.
// - the `isBrowser` gates (UI, UIText): the bundle runs without `window`, as on the server.
// - SES: the classes run unhardened, outside lockdown and outside a compartment; what a script inside one can reach
//   or change is tested elsewhere (proxyCopiesHardened, scriptHardening, teardownLockdown).
// - the live behaviour of the proxy's methods (add, clone, play, setSize, addForce, ...): only their descriptors (a)
//   and that a stopped run refuses them (b).
// - values outside the lists below, combinations of properties beyond the states of row e, and a second set after
//   the first other than the four pairs of row d.
// - a once-only warning after its first time: each node type starts from a fresh evaluation of the bundle, and the
//   cases run in a fixed order, so such a warning shows on the first case that says it.
//
// The rows of each file (in the proxy's key order within a row):
//   a  the proxy: its own keys in order; for each its kind (get+set, get, set, method), enumerable, configurable,
//      writable, each function's name and length, and whether two instances share the function (`shared`) or each
//      has its own (`per-instance`). For a type other than node, its Node keys in one line when they read as there.
//   b  a stopped run (the node's ctx.run is not its entity's deadHook): what each setter, method and getter of the
//      proxy does; the setters through `_created` and through a parent's context; a live run; a setter called on
//      Object.create(proxy), on a plain object, on no receiver, on a group's proxy, on another type's proxy with the
//      same key.
//   c  one set on a fresh unmounted node for each settable key: the hostile list (undefined, null, NaN, ±Infinity,
//      -1, -0, 0, 0.5, 1, 1e9, '', 'x', true, false, {}, [], [1,2,3], [NaN], boxed Number/String/Boolean, a Proxy over
//      [1,2,3], a function, a Symbol, 1n, an object whose toString throws), then the property's own values (its enum,
//      a vector, an array of its shape, a fixture). `pc` the proxy and the class (`node[key] = value`) alike, `p` the
//      proxy, `c` the class. A line is `outcome <- the values that had it`.
//   d  a second set on the same node: the same value again (`same`), an equal new object (`copy`), NaN then NaN,
//      0 then -0; unmounted, and in the type's first mounted-like state. What the second set did shows whether the
//      setter compares before its effect, and how.
//   e  the sets of c with the parts a setter looks for on a mounted node stubbed (a handle, a yoga node and its ui, a
//      source and its gain and panner, an instance, a shape, an emitter, a controller, a parent): only the values
//      whose outcome differs from c; `e as in c:` lists the keys for which none does.
//   f  the constructor: the defaults read through the proxy; each settable key given through `data`, beside the same
//      value set through the class on a new node (one line when they agree); the data only a host loader gives.
//   g  the node's own fields after construction; then, for a node with each property set to its sample value (the
//      first of its values that is accepted and reads back otherwise than the default) and one child, for the nodes
//      glbToNodes makes from a small scene, and for the host-only fields other loaders give: each own field after
//      clone() and clone(true) (`same` value, an equal `copy`, `differs`); and whether a clone reads as its source for
//      each sample property set alone (this test also asserts that one).
// An outcome:
//   throw Ctor: "message"         the set threw (`<in>`: the message ends with the value given)
//   read v [fresh]                the value read back the same way (`fresh`: a new object on every read)
//   Δ{field:v ...}                the node's own fields that changed, appeared, or went (`<deleted>`)
//   calls[name,...]               watched methods called on the node: setDirty, rebuild, redraw, activate, play, ...
//   stub[a.b=v a.c(args) ...]     what was written to, or called on, the stubs of row e
//   traps[get:length,...]         what was read of the Proxy input
//   log[level:"text" ...]         the console
//   $in / $in~                    the value given itself / an equal copy of it. An object is the one given by identity;
//                                 a primitive only in the property's own read and field, and a string in a stub's
//                                 record (a number there is written as it is: it is often computed from the value).
//   values: F frozen, S sealed; V3, Q, E, M4, Color: three's math objects; view: a script view (sealMath.js);
//   proxy:<type> a node's proxy; ref(...) a value ref and what it resolves to; node:<type>(below) a node under the
//   case's node; <auto id> a node's automatic id; stub:<name> a stub of row e; self the node of the case;
//   [a,b,c,…,z](len n) an array of more than 16 items: its first three, its last, and its length.
//   generation stopped: ... the generator could not go on with the type (a constructor that throws): the rest of the
//                                 type's text is missing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GOLDEN_DIR, NODE_TYPES, SHARDS, goldenTests, nodeTypesIn } from './lib/nodeGolden.mjs'

const golden = goldenTests(SHARDS['nodeGolden.test.js'])

test('the node types are Node and the exports of src/core/nodes/index.js, each in one shard', async () => {
  assert.deepEqual(await nodeTypesIn(golden.url()), NODE_TYPES)
  assert.deepEqual(Object.values(SHARDS).flat().sort(), [...NODE_TYPES].sort())
  for (const file of Object.keys(SHARDS)) assert.ok(fs.existsSync(new URL(file, import.meta.url)), file)
})

test('every golden file is a node type', () => {
  const files = fs.readdirSync(GOLDEN_DIR).filter(name => name.endsWith('.txt'))
  assert.deepEqual(files.sort(), NODE_TYPES.map(type => `${type}.txt`).sort())
})
