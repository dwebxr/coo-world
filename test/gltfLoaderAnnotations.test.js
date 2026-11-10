import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { unmarkedOperations } from './lib/gltfAnnotations.mjs'

// The vendored GLTFLoader is metered by hand: where it allocates, copies, loops or moves objects as far as the
// document says, it charges the per-file budget (gltfLimits.js createGLTFBudget). The budget tests record what is
// charged, so an allocation nobody charges passes them. This test reads the file's syntax tree instead: every `new`,
// spread, loop statement and call of an allocating, copying, iterating or scene-graph method needs a marker of its
// own in a comment on its statement (COO_BUDGET, COO_WORK, COO_ITERATE, COO_OPTIONAL_DRACO, COO_SPARSE, COO_REVOKE,
// or `COO_EXEMPT: <reason>`): one marker covers one operation. A change to the parser (an update of three, a new
// path) that adds such an operation fails here until it is charged or exempted with a reason.
//
// It checks the syntax of the vendored file only. Cost inside the functions it calls (three.js, three-vrm) is not
// visible to it, except for the few calls listed in test/lib/gltfAnnotations.mjs.
const FILE = new URL('../src/core/libs/gltfloader/GLTFLoader.js', import.meta.url)
const source = fs.readFileSync(FILE, 'utf8')

test('every allocation, copy, loop and move of the vendored GLTFLoader has its own marker', () => {
  const sites = unmarkedOperations(source)
  assert.deepEqual(sites, [], `${sites.length} unmarked:\n${sites.join('\n')}`)
})

test('the check finds what it is for, in the forms Codex found the line check missed', () => {
  // inserted into a method of the file, away from its markers
  const at = source.indexOf('\tloadAccessor( accessorIndex ) {\n')
  assert.ok(at > 0)
  const insert = text => source.slice(0, at) + `\tunmetered( n ) {\n\n${text}\n\n\t}\n\n` + source.slice(at)
  const charged = '\t\tconst first = new Float32Array( n ); // COO_BUDGET: a probe\n'
  for (const [name, text] of [
    ['a second allocation next to a charged one', `${charged}\t\tconst second = new Float32Array( n );`],
    [
      'two in one statement, one marker',
      '\t\tconst a = new Float32Array( n ), b = new Float32Array( n ); // COO_BUDGET: a probe',
    ],
    ['a multi-line constructor', '\t\tconst scratch = new Float32Array(\n\t\t\tn\n\t\t);'],
    ['new globalThis.Float32Array', '\t\tconst scratch = new globalThis.Float32Array( n );'],
    ['an allocation inside a template expression', '\t\tconst label = `${ new Float32Array( n ).length }`;'],
    ['a renamed constructor', '\t\tconst Typed = Float32Array;\n\t\tconst scratch = new Typed( n );'],
    ['a copy', '\t\tconst copy = this.json.buffers.slice();'],
    ['a spread', '\t\tconst copy = [ ... this.json.buffers ];'],
    ['a loop', '\t\tfor ( const node of this.json.nodes ) n ++;'],
    ['an iteration', '\t\tthis.json.nodes.forEach( visit );'],
    ['a walk', '\t\tthis.scene.traverse( visit );'],
    ['a move in the scene graph', '\t\tthis.scene.add( this.node );'],
    ['a method borrowed with call', '\t\tObject3D.prototype.copy.call( this.a, this.b );'],
    ['a marker in a string', "\t\tconst note = 'COO_BUDGET';\n\t\tconst scratch = new Float32Array( n );"],
  ]) {
    const sites = unmarkedOperations(insert(text))
    assert.equal(sites.length, 1, `${name}: ${sites.join('; ')}`)
  }
  // an exemption without a reason is reported, and answers for nothing
  const bare = unmarkedOperations(insert('\t\tconst scratch = new Float32Array( n ); // COO_EXEMPT'))
  assert.equal(bare.length, 2, bare.join('; '))
  assert.match(bare[0], /COO_EXEMPT without a reason/)
  // a marker of its own, after the statement or on the lines just above it, covers one operation
  assert.deepEqual(
    unmarkedOperations(insert(`${charged}\t\tconst second = new Float32Array( n ); // COO_EXEMPT: a probe`)),
    []
  )
  assert.deepEqual(
    unmarkedOperations(insert('\t\t// COO_EXEMPT: a probe\n\t\tconst scratch = new Float32Array( n );')),
    []
  )
  assert.deepEqual(
    unmarkedOperations(
      insert('\t\tconst a = new Float32Array( n ), b = new Float32Array( n ); // COO_BUDGET: a; COO_BUDGET: b')
    ),
    []
  )
  // a marker far above (past a blank stretch) is no statement's
  assert.equal(
    unmarkedOperations(insert('\t\t// COO_EXEMPT: far above\n\n\n\n\t\tconst scratch = new Float32Array( n );')).length,
    1
  )
  // a thrown error is not an operation
  assert.deepEqual(unmarkedOperations(insert("\t\tthrow new Error( 'x' );")), [])
})
