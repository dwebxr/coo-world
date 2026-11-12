// Small defects of shared helpers (P13): the loose octree kept every node it ever grew, an octree node asked to
// remove what it does not hold dropped its last item, a file extension went into a query as it was, and sizes
// that are not sizes were shown as "NaN undefined".
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundleProbe, runProbe } from './lib/workerProbe.mjs'
import { loadClient } from './lib/clientHarness.mjs'
import { formatBytes } from '../src/core/extras/formatBytes.js'

let bundle
before(async () => {
  bundle = await bundleProbe(`
    export * as THREE from './src/core/extras/three'
    export { LooseOctree } from './src/core/extras/LooseOctree'
    export { SnapOctree } from './src/core/extras/SnapOctree'
  `)
})
after(() => bundle?.destroy())

test('LooseOctree: removing items gives back the nodes that were made for them', () =>
  runProbe(bundle, ({ THREE, LooseOctree }) => {
    const count = node => 1 + node.children.reduce((sum, child) => sum + count(child), 0)
    const tree = new LooseOctree({ center: new THREE.Vector3(), size: 10 })
    const items = []
    for (let i = 0; i < 20; i++) {
      const x = ((i * 7919) % 17) - 8
      const y = ((i * 104729) % 13) - 6
      const z = ((i * 1299709) % 11) - 5
      const item = {
        matrix: new THREE.Matrix4().makeTranslation(x, y, z),
        geometry: new THREE.BoxGeometry(0.1, 0.1, 0.1),
        material: new THREE.MeshBasicMaterial(),
      }
      assert.equal(tree.insert(item), true)
      items.push(item)
    }
    const grown = count(tree.root)
    assert.ok(grown > 100, `${grown} nodes for 20 scattered items`)
    // one item leaves: the others keep their nodes, and can still be found
    tree.remove(items[0])
    assert.equal(items[0]._node, null)
    assert.equal(tree.root.count, 19)
    for (const item of items.slice(1)) assert.ok(item._node.items.includes(item))
    const hit = items[5]
    const origin = new THREE.Vector3().setFromMatrixPosition(hit.matrix).add(new THREE.Vector3(0, 0, 3))
    const found = tree.raycast(new THREE.Raycaster(origin, new THREE.Vector3(0, 0, -1)))
    assert.ok(found.length >= 1, 'an item that stayed is still hit')
    // all of them leave: the tree is one node again (it used to keep every node it had grown)
    for (const item of items) tree.remove(item)
    assert.equal(tree.root.count, 0)
    assert.equal(count(tree.root), 1)
    // and it grows again as before
    for (const item of items) assert.equal(tree.insert(item), true)
    assert.equal(tree.root.count, 20)
    assert.equal(count(tree.root), grown)
    // removing twice, or what was never there, changes nothing
    tree.remove(items[3])
    tree.remove(items[3])
    tree.remove({ matrix: new THREE.Matrix4(), geometry: new THREE.BoxGeometry(), material: null })
    assert.equal(tree.root.count, 19)
  }))

test('LooseOctree: a move does not throw away the nodes the item goes back into', () =>
  runProbe(bundle, ({ THREE, LooseOctree }) => {
    const tree = new LooseOctree({ center: new THREE.Vector3(), size: 10 })
    const item = {
      matrix: new THREE.Matrix4().makeTranslation(3, 3, 3),
      geometry: new THREE.BoxGeometry(0.1, 0.1, 0.1),
      material: new THREE.MeshBasicMaterial(),
    }
    tree.insert(item)
    const node = item._node
    // within the same node: nothing changes hands
    item.matrix.makeTranslation(3.01, 3, 3)
    tree.move(item)
    assert.equal(item._node, node)
    // re-inserted where it is: the same node object is used again, not a new one after a collapse
    assert.equal(tree.insert(item), true)
    assert.equal(item._node, node)
    assert.equal(tree.root.count, 1)
  }))

for (const kind of ['LooseOctree', 'SnapOctree']) {
  test(`${kind}: a node asked to remove what it does not hold keeps what it holds`, () =>
    runProbe(
      bundle,
      ({ THREE, LooseOctree, SnapOctree }, kind) => {
        const loose = kind === 'LooseOctree'
        const tree = loose
          ? new LooseOctree({ center: new THREE.Vector3(), size: 10 })
          : new SnapOctree({ center: new THREE.Vector3(), size: 10 })
        const make = x =>
          loose
            ? {
                matrix: new THREE.Matrix4().makeTranslation(x, 0, 0),
                geometry: new THREE.BoxGeometry(0.1, 0.1, 0.1),
                material: new THREE.MeshBasicMaterial(),
              }
            : { position: new THREE.Vector3(x, 0, 0), active: true }
        const held = make(1)
        assert.equal(tree.insert(held), true)
        const node = held._node
        const list = () => (loose ? node.items : node.points)
        const stranger = make(1)
        // splice(indexOf(stranger), 1) is splice(-1, 1): it took out the last one the node holds, and counted it
        node.remove(stranger)
        assert.deepEqual(list(), [held])
        assert.equal(tree.root.count, 1)
        assert.equal(stranger._node, null)
        node.remove(held)
        assert.deepEqual(list(), [])
        assert.equal(tree.root.count, 0)
      },
      kind
    ))
}

test('formatBytes: sizes read as sizes, and what is not a size reads as 0 B', () => {
  for (const [bytes, text] of [
    [0, '0 B'],
    [1, '1 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '2 KB'],
    [1024 ** 2, '1.0 MB'],
    [5.5 * 1024 ** 2, '5.5 MB'],
    [1024 ** 3, '1.0 GB'],
    [1024 ** 4, '1.0 TB'],
    // past the last unit: counted in it (the unit used to read "undefined")
    [1024 ** 5, '1024.0 TB'],
    [Number.MAX_VALUE, `${(Number.MAX_VALUE / 1024 ** 4).toFixed(1)} TB`],
    [Infinity, '∞ TB'],
    // less than a byte: counted in bytes
    [0.5, `${(0.5).toFixed(0)} B`],
    [1e-9, '0 B'],
    // not a size
    [-5, '0 B'],
    [-0, '0 B'],
    [NaN, '0 B'],
    [-Infinity, '0 B'],
    [undefined, '0 B'],
    [null, '0 B'],
    ['1024', '0 B'],
    [{}, '0 B'],
  ]) {
    const out = formatBytes(bytes)
    assert.equal(out, text, String(bytes))
    assert.doesNotMatch(out, /NaN|undefined/)
  }
})

test('upload check: the file name goes into the query encoded, whatever its extension is', async () => {
  const urls = []
  const ClientNetwork = loadClient('core/systems/ClientNetwork.js', 'ClientNetwork', {
    hashFile: async () => 'a'.repeat(64),
    CHECK_TIMEOUT_MS: 1000,
    fetchWithRetry: async url => {
      urls.push(url)
      return new Response(JSON.stringify({ exists: true }), { status: 200 })
    },
  })
  const network = Object.create(ClientNetwork.prototype)
  network.apiUrl = 'https://world.example/api'
  network.authToken = 'token'
  for (const [name, ext] of [
    ['model.glb', 'glb'],
    ['photo.JPG', 'jpg'],
    // an extension is whatever follows the last dot of the name the visitor's file has
    ['notes.a&size=1', 'a&size=1'],
    ['x.png#frag', 'png#frag'],
    ['y.p g%zz', 'p g%zz'],
    ['z.日本', '日本'],
  ]) {
    urls.length = 0
    await network.uploadNow({ name, size: 5 }, undefined)
    assert.equal(urls.length, 1, name)
    const url = new URL(urls[0])
    assert.equal(url.origin + url.pathname, 'https://world.example/api/upload-check')
    assert.deepEqual([...url.searchParams.keys()], ['filename', 'size'], name)
    assert.equal(url.searchParams.get('filename'), `${'a'.repeat(64)}.${ext}`, name)
    assert.equal(url.searchParams.get('size'), '5', 'the size is the file’s, not something from its name')
    assert.equal(url.hash, '')
  }
})
