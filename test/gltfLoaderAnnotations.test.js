import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { splitLines, unmarkedSites } from './lib/gltfAnnotations.mjs'

// The vendored GLTFLoader is metered by hand: each place it allocates, copies or loops as far as the document says
// charges the per-file budget (gltfLimits.js createGLTFBudget). The budget tests record what is charged, so an
// allocation nobody charges passes them. This test reads the file instead: every line shaped like an allocation, a
// copy or a loop must carry a marker on it, or on one of the three lines above it:
//   COO_BUDGET / COO_WORK: charged here; COO_ITERATE: iterates a real array; COO_OPTIONAL_DRACO, COO_SPARSE,
//   COO_REVOKE: one of this client's other changes; COO_EXEMPT: <why no charge is needed>
// A change to the parser (an update of three, a new path) that adds such a line fails here until it is charged or
// exempted with a reason.
const FILE = new URL('../src/core/libs/gltfloader/GLTFLoader.js', import.meta.url)

test('every allocation, copy and loop of the vendored GLTFLoader is charged, or exempt with a reason', () => {
  const source = fs.readFileSync(FILE, 'utf8')
  const sites = unmarkedSites(source)
  assert.deepEqual(sites, [], `${sites.length} unmarked:\n${sites.join('\n')}`)
  // an exemption says why
  const bare = splitLines(source).flatMap(({ comment }, i) =>
    /\bCOO_EXEMPT\b(?!:\s*\S)/.test(comment) ? [`line ${i + 1}`] : []
  )
  assert.deepEqual(bare, [], 'COO_EXEMPT without a reason')
})

test('the check finds what it is for: an allocation, a copy or a loop added away from the markers', () => {
  const source = fs.readFileSync(FILE, 'utf8')
  const at = source.indexOf('\tloadAccessor( accessorIndex ) {\n')
  assert.ok(at > 0)
  const insert = text => source.slice(0, at) + `\tunmetered() {\n\n\n\n\n${text}\n\n\t}\n\n` + source.slice(at)
  for (const [text, shape] of [
    ['\t\tconst scratch = new Float32Array( this.json.accessors.length * 1e6 );', 'a typed array'],
    ['\t\tconst copy = this.json.buffers.slice();', 'a copy'],
    ['\t\tfor ( const node of this.json.nodes ) node.traverse( visit );', 'a loop'],
    ['\t\tthis.json.nodes.forEach( visit );', 'an iteration'],
    ["\t\tconst url = URL.createObjectURL( new Blob( [ 'x' ] ) ); // a COO_EXEMPT with no reason", 'a Blob'],
  ]) {
    const sites = unmarkedSites(insert(text))
    assert.equal(sites.length, 1, `${shape}: ${sites.join('; ')}`)
    assert.ok(sites[0].includes(shape), sites[0])
  }
  // and a marker on it, or just above, covers it
  assert.deepEqual(unmarkedSites(insert('\t\t// COO_EXEMPT: a test\n\t\tconst scratch = new Float32Array( 4 );')), [])
  // text in strings and comments is not code
  assert.deepEqual(unmarkedSites("const a = 'for ( x ) new Float32Array( 1 )'; // new ArrayBuffer( 1 )\n"), [])
})
