import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ALLOWED, unmarkedOperations } from './lib/gltfAnnotations.mjs'

// The vendored GLTFLoader is metered by hand: where it allocates, copies, loops or moves objects as far as the
// document says, it charges the per-file budget (gltfLimits.js createGLTFBudget). The budget tests record what is
// charged, so an allocation nobody charges passes them. This test reads the file's syntax tree instead: every `new`
// (but a thrown one), spread, loop statement and call needs a marker of its own in a comment on its statement (one
// that starts with COO_BUDGET, COO_WORK, COO_ITERATE, COO_OPTIONAL_DRACO, COO_SPARSE, COO_REVOKE, or
// `COO_EXEMPT: <reason>`), and so does every function that calls itself, unless the call is on the allow-list of
// cheap callees in test/lib/gltfAnnotations.mjs (each with its reason) or calls one of the file's own functions on
// its own objects. One marker covers one operation. A change to the parser (an update of three, a new path) that
// adds such an operation fails here until it is charged or exempted with a reason.
//
// It checks the syntax of the vendored file only: a marker on a call into a library (three.js, three-vrm) is a
// claim about that library's cost, which this test cannot see.
const FILE = new URL('../src/core/libs/gltfloader/GLTFLoader.js', import.meta.url)
const source = fs.readFileSync(FILE, 'utf8')
// a method holding the text given, in a class with one of the parser's own methods, beside two of its functions
// that charge only when handed the budget (not on the allow-list)
const probe = text =>
  'function updateMorphTargets( mesh, def, budget = null ) {}\n\nfunction assignExtrasToUserData( object, def, budget = null ) {}\n\n' +
  `class GLTFParser {\n\n\tgetDependency( type, index ) {\n\n\t\treturn this.cache.get( type + index );\n\n\t}\n\n` +
  `\tunmetered( n, name, array, text ) {\n\n${text}\n\n\t}\n\n}\n`

test('every allocation, copy, loop and move of the vendored GLTFLoader has its own marker', () => {
  const sites = unmarkedOperations(source)
  assert.deepEqual(sites, [], `${sites.length} unmarked:\n${sites.join('\n')}`)
})

test('the check finds what it is for, in the forms Codex found the line check missed', () => {
  // each form inserted into a method of a small class shaped like the parser (one with getDependency)
  const insert = probe
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

test('every call needs a marker but those on the allow-list: the forms the reviewer found the method list missed', () => {
  const insert = probe
  for (const [name, text] of [
    ['a bare call (toTrianglesDrawMode, at the time)', '\t\tconst geometry = convertDrawMode( this.geometry, n );'],
    // the file's own functions not on the allow-list: these charge only when handed the budget
    ['a bare call of updateMorphTargets', '\t\tupdateMorphTargets( this.mesh, this.def );'],
    ['a bare call of assignExtrasToUserData', '\t\tassignExtrasToUserData( this.mesh, this.def );'],
    ['a computed member call', '\t\tthis.json[ name ]( n );'],
    ['globalThis.JSON.parse', '\t\tconst json = globalThis.JSON.parse( text );'],
    ["a typed array's set", '\t\tarray.set( this.json.values );'],
    ['flat', '\t\tconst all = this.json.nodes.flat();'],
    ['toSorted', '\t\tconst sorted = this.json.nodes.toSorted();'],
    ['join', "\t\tconst key = this.json.nodes.join( ':' );"],
    ['repeat', "\t\tconst padding = ' '.repeat( n );"],
    ['Object.fromEntries', '\t\tconst map = Object.fromEntries( this.json.nodes );'],
    ['removeFromParent', '\t\tthis.node.removeFromParent();'],
    ['getObjectByName', '\t\tconst found = this.scene.getObjectByName( name );'],
    ['toNonIndexed', '\t\tconst flat = this.geometry.toNonIndexed();'],
    ['computeVertexNormals', '\t\tthis.geometry.computeVertexNormals();'],
    ["a geometry's applyMatrix4", '\t\tthis.geometry.applyMatrix4( this.matrix );'],
    ['setIndex of an array', '\t\tthis.geometry.setIndex( array );'],
    ['push of a spread', '\t\tarray.push( ... this.json.nodes );'],
    ['a marker word inside prose', '\t\tconst found = this.scene.getObjectByName( name ); // as COO_BUDGET above'],
    [
      'a marker after the closing brace',
      '\t\tfor ( const node of this.json.nodes ) {\n\n\t\t\tn ++;\n\n\t\t} // COO_WORK: a probe',
    ],
  ]) {
    const sites = unmarkedOperations(insert(text))
    assert.equal(sites.length, 1, `${name}: ${sites.join('; ')}`)
  }
  // recursion: a function calling itself needs a marker for its depth, on its own statement
  const recursive =
    '\t\tconst walk = ( node ) => {\n\n\t\t\tfor ( const child of node.children ) walk( child ); // COO_ITERATE: a probe; COO_EXEMPT: a probe\n\n\t\t};'
  const found = unmarkedOperations(insert(recursive))
  assert.equal(found.length, 1, found.join('; '))
  assert.match(found[0], /recursion of walk/)
  assert.deepEqual(unmarkedOperations(insert(recursive.replace('=> {', '=> { // COO_EXEMPT: a probe'))), [])
  // what the allow-list lets through, each entry with its reason
  for (const text of [
    '\t\tconst big = Math.max( n, 1 );',
    "\t\tif ( this.budget ) this.budget.work( n, 'a probe' );",
    '\t\tarray.push( n );',
    '\t\treturn Promise.resolve( n ).then( function ( x ) { return x; } );',
    '\t\tif ( Array.isArray( array ) ) n ++;',
    '\t\tconst dependency = this.getDependency( name, n );',
  ]) {
    assert.deepEqual(unmarkedOperations(insert(text)), [], text)
  }
  for (const group of Object.values(ALLOWED)) {
    for (const [name, reason] of Object.entries(group)) assert.ok(reason.length > 3, `${name} has a reason`)
  }
})
