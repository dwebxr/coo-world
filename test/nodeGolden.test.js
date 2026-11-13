// The golden characterization of the node classes (P17-0). test/lib/nodeGolden.mjs runs every node type (Node and
// the 23 exports of src/core/nodes/index.js) through a fixed list of cases and writes what happened as text, one file
// per type in test/golden/nodes/. This test generates that text again and compares it with the files; a difference
// fails, with the first differing lines. The types are shared among six files that run side by side (SHARDS in
// test/lib/nodeGolden.mjs): this one and nodeGolden{Physics,Scene,Effects,Ui,View}.test.js.
// `UPDATE_GOLDEN=1 node --test test/nodeGolden*.test.js` rewrites the files; the diff of the rewritten files is then
// the record of what a change did, to be read line by line. A run with CI set refuses UPDATE_GOLDEN=1 (a failing test,
// nothing generated or written).
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
//   and what a stopped run makes of them (b).
// - values outside the lists below, combinations of properties beyond the states of rows e and i, and a second set
//   after the first other than the four pairs of row d.
// - a once-only warning after its first time. Each node type starts from a fresh evaluation of the bundle and runs in
//   a fixed order, so such a warning is written once: in the case that says it first, or, when the generator's own
//   probing (sample values, set-up) says it first, in row x, and in no case after that.
//
// The rows of each file (in the proxy's key order within a row):
//   a  the proxy: its own keys in order; for each its kind (get+set, get, set, method), enumerable, configurable,
//      writable, each function's name and length, and whether two instances share the function (`shared`) or each
//      has its own (`per-instance`). For a type other than node, its Node keys in one line when they read as there.
//   b  a stopped run (the node's ctx.run is not its entity's deadHook): what each setter, method and getter of the
//      proxy does, on a new node each time, with the node's own fields it changed and the watched calls; the setters
//      and methods also through `_created` and through a parent's context; a live run; a setter called on
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
//      each sample property set alone (this test also asserts that one). The sources have their own transform (and a
//      joint its frames), and `g full fields at a new node's value` lists what a dropped copy() line would not change.
//   h  two nodes of the type alive at once: a write through the first one's proxy, then one through the second one's,
//      each read back through both proxies; the keys where each write reached its own node only, any other written out.
//   i  every getter, through the proxy (and the class's where it reads otherwise), on a node whose backing values are
//      distinct: under a positioned parent (its matrix is not its matrixWorld), with two children, its own transform
//      and callbacks, and the type's computed state (a playing audio source, a video instance with its own playback
//      fields, a joint's frames, ...); get-only keys that read the same value are listed.
//   x  the console outside the cases (the generator's own probing for sample values, a case's set-up), by row.
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
//   proxy:<type>#<id> a node's proxy, node:<type>#<id>(below) a node (under the case's node), the id where it is not an
//   automatic one; ref(...) a value ref and what it resolves to; <auto id> a node's automatic id; stub:<name> a stub
//   of row e; self the node of the case; reads{k=v} what the getters of a plain object (a script's material) read;
//   !enum !writable !conf after a field: its descriptor says so.
//   Shortened, with the digest of what is left out (#: the first 12 hex digits of the sha256 of the whole text):
//   "abcdefgh…"(len n #d) a string of more than 40 characters; [a,b,c,…,z](len n #d) an array of more than 16 items;
//   […n #d] and {… #d} what lies more than three levels deep; traps[…,…+n #d] more than 24 reads.
//   generation stopped: ... the generator could not go on with the type (a constructor that throws): the rest of the
//                                 type's text is missing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GOLDEN_DIR, NODE_TYPES, SHARDS, goldenTests, nodeTypesIn, updateMode } from './lib/nodeGolden.mjs'

const golden = goldenTests(SHARDS['nodeGolden.test.js'])

test('the node types are Node and the exports of src/core/nodes/index.js, each in one shard', async t => {
  if (!golden.url()) return t.skip('UPDATE_GOLDEN=1 refused in CI: nothing generated')
  assert.deepEqual(await nodeTypesIn(golden.url()), NODE_TYPES)
  assert.deepEqual(Object.values(SHARDS).flat().sort(), [...NODE_TYPES].sort())
  for (const file of Object.keys(SHARDS)) assert.ok(fs.existsSync(new URL(file, import.meta.url)), file)
})

test('every golden file is a node type', () => {
  const files = fs.readdirSync(GOLDEN_DIR).filter(name => name.endsWith('.txt'))
  assert.deepEqual(files.sort(), NODE_TYPES.map(type => `${type}.txt`).sort())
})

// the golden files' bytes, file by file
function goldenHashes() {
  return fs
    .readdirSync(GOLDEN_DIR)
    .sort()
    .map(
      name =>
        `${name} ${createHash('sha256')
          .update(fs.readFileSync(`${GOLDEN_DIR}/${name}`))
          .digest('hex')}`
    )
}

test('UPDATE_GOLDEN=1 is refused when CI is set', () => {
  assert.equal(updateMode({}), false)
  assert.equal(updateMode({ UPDATE_GOLDEN: '1' }), true)
  assert.equal(updateMode({ UPDATE_GOLDEN: '0', CI: 'true' }), false)
  assert.throws(() => updateMode({ UPDATE_GOLDEN: '1', CI: 'true' }), /refused when CI is set/)
  assert.throws(() => updateMode({ UPDATE_GOLDEN: '1', CI: '1' }), /refused when CI is set/)
})

// a shard run with both set fails at once, and writes nothing
test('a golden test file run with UPDATE_GOLDEN=1 and CI fails and rewrites no file', t => {
  // (in a run that is itself rewriting the files, the shards beside this one change them meanwhile)
  if (process.env.UPDATE_GOLDEN === '1') return t.skip('UPDATE_GOLDEN=1: this run rewrites the files')
  const before = goldenHashes()
  const file = fileURLToPath(new URL('nodeGoldenUi.test.js', import.meta.url))
  const { PATH, HOME, TMPDIR } = process.env
  // (the reporter is named: with its output piped, Node 22 would print TAP and Node 24 the spec lines read below)
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { PATH, HOME, TMPDIR, UPDATE_GOLDEN: '1', CI: 'true' },
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.equal(child.status, 1, child.stdout + child.stderr)
  assert.match(child.stdout, /refused when CI is set/)
  assert.doesNotMatch(child.stdout, /golden: ui\b/)
  assert.deepEqual(goldenHashes(), before)
})
