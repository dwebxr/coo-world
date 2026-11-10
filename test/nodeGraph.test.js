import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundleProbe } from './lib/workerProbe.mjs'

// the real Node, Stage and Apps (bundled like the server build: the runtime's imports are extensionless)
let m
let bundle
before(async () => {
  bundle = await bundleProbe(`
    export { Node, NODE_LIMIT, NODE_DEPTH_LIMIT, NodeLimitError } from './src/core/nodes/Node'
    export { Stage } from './src/core/systems/Stage'
    export { Apps } from './src/core/systems/Apps'
  `)
  m = await import(bundle.url)
})
after(() => bundle?.destroy())

// an app entity as the node budget sees it: crash() latches like App.crash
function appEntity() {
  const entity = {
    isApp: true,
    data: { id: 'app' },
    crashed: false,
    crashes: 0,
    crash() {
      if (entity.crashed) return
      entity.crashed = true
      entity.crashes++
    },
  }
  return entity
}

function quietly(fn) {
  const original = console.error
  const lines = []
  console.error = (...args) => lines.push(args.map(String).join(' '))
  try {
    return [fn(), lines]
  } finally {
    console.error = original
  }
}

function chain(length) {
  const nodes = Array.from({ length }, () => new m.Node())
  for (let i = 1; i < length; i++) nodes[i - 1].add(nodes[i])
  return nodes
}

test('Node.add: a node cannot go under itself or under one of its descendants', () => {
  const a = new m.Node({ id: 'a' })
  const b = new m.Node({ id: 'b' })
  const c = new m.Node({ id: 'c' })
  assert.throws(() => a.add(a), /cannot add a node to itself or to one of its descendants/)
  a.add(b)
  b.add(c)
  assert.throws(() => b.add(a), /cannot add a node to itself/)
  assert.throws(() => c.add(a), /cannot add a node to itself/)
  // the refused add changed nothing
  assert.equal(a.parent, null)
  assert.deepEqual(a.children, [b])
  assert.deepEqual(b.children, [c])
  // a mounted root (an app's root) under its own descendant, as `app.add(c); c.add(app)` would do
  const world = { stage: { dirtyNodes: new Set() } }
  const root = new m.Node({ id: 'root' })
  const child = new m.Node({ id: 'child' })
  root.activate({ world, entity: { data: { id: 'host' } } })
  root.add(child)
  assert.throws(() => child.add(root), /cannot add a node to itself/)
  assert.equal(root.parent, null)
  // moving a node elsewhere in the same tree still works
  c.add(new m.Node({ id: 'd' }))
  a.add(c)
  assert.deepEqual(
    a.children.map(n => n.id),
    ['b', 'c']
  )
  assert.equal(c.parent, a)
})

test('Node.add through the proxy: the refusal reaches the script as an error', () => {
  const a = new m.Node()
  const b = new m.Node()
  a.getProxy().add(b.getProxy())
  assert.throws(() => b.getProxy().add(a.getProxy()), /cannot add a node to itself/)
})

test('Node.clean, Stage containment and world.attach terminate on a hand-forced cycle', () => {
  const world = { stage: new m.Stage({}) }
  const a = new m.Node({ id: 'a' })
  const b = new m.Node({ id: 'b' })
  a.activate({ world, entity: { data: { id: 'host' } } })
  b.activate({ world, entity: { data: { id: 'host' } } })
  // corrupt the graph by hand: add() would refuse this
  a.parent = b
  b.parent = a
  a.isDirty = true
  b.isDirty = true
  assert.throws(() => a.clean(), /node tree too deep or cyclic/)
  // the stage contains the failure and gives up after its retry cap instead of spinning
  world.stage.dirtyNodes.add(a)
  quietly(() => {
    for (let i = 0; i < 12; i++) world.stage.clean()
  })
  assert.equal(world.stage.dirtyNodes.size, 0)
  // children that loop as well: the containment's walks are bounded too
  a.children.push(b)
  b.children.push(a)
  a.isDirty = true
  b.isDirty = true
  world.stage.dirtyNodes.add(a)
  quietly(() => {
    for (let i = 0; i < 12; i++) world.stage.clean()
  })
  const apps = new m.Apps({ network: {}, events: {} })
  const entity = { worldNodes: new Set() }
  assert.throws(() => apps.worldMethods.attach(entity, a.getProxy()), /node tree too deep or cyclic/)
})

test('node budget: live mounted nodes per app; the app crashes once past the limit', () => {
  const world = { stage: { dirtyNodes: new Set() } }
  const entity = appEntity()
  const root = new m.Node({ id: 'root' })
  root.activate({ world, entity })
  for (let i = 1; i < m.NODE_LIMIT; i++) root.add(new m.Node())
  assert.equal(entity.liveNodes, m.NODE_LIMIT)
  assert.equal(entity.crashes, 0)
  // built but never mounted nodes (clones, nodes kept for later) cost nothing
  const template = new m.Node()
  for (let i = 0; i < 100; i++) template.add(new m.Node())
  const clones = Array.from({ length: 300 }, () => template.clone(true))
  assert.equal(clones.length, 300)
  assert.equal(entity.liveNodes, m.NODE_LIMIT)
  const extra = new m.Node({ id: 'extra' })
  const [, lines] = quietly(() => {
    assert.throws(() => root.getProxy().add(extra.getProxy()), /node limit reached: more than 20000 live nodes/)
  })
  assert.equal(extra.mounted, false)
  assert.equal(entity.crashes, 1)
  assert.equal(entity.scriptError.message, '[app] node limit reached: more than 20000 live nodes')
  assert.equal(lines.length, 1)
  assert.equal(entity.liveNodes, m.NODE_LIMIT)
  // unmounting returns the budget (the crash rebuild starts from zero)
  root.deactivate()
  assert.equal(entity.liveNodes, 0)
  root.remove(extra)
  // removing a mounted subtree returns its nodes too
  const fresh = appEntity()
  const other = new m.Node()
  other.activate({ world, entity: fresh })
  const sub = new m.Node()
  sub.add(new m.Node())
  other.add(sub)
  assert.equal(fresh.liveNodes, 3)
  other.remove(sub)
  assert.equal(fresh.liveNodes, 1)
})

test('node depth: at most 256 levels are mounted; a 256-deep chain survives every recursive walk', () => {
  const world = { stage: { dirtyNodes: new Set() } }
  const entity = appEntity()
  const nodes = chain(m.NODE_DEPTH_LIMIT)
  const top = nodes[0]
  top.activate({ world, entity })
  assert.ok(nodes.every(node => node.mounted))
  assert.equal(entity.liveNodes, m.NODE_DEPTH_LIMIT)
  // the walks that recurse once per level
  let visited = 0
  top.traverse(() => visited++)
  assert.equal(visited, m.NODE_DEPTH_LIMIT)
  const copy = top.clone(true)
  let depth = 0
  for (let node = copy; node; node = node.children[0]) depth++
  assert.equal(depth, m.NODE_DEPTH_LIMIT)
  top.isTransformed = false
  top.setTransformed()
  top.clean()
  top.deactivate()
  assert.equal(entity.liveNodes, 0)
  top.activate({ world, entity })
  // one level more is refused and crashes the app
  quietly(() => {
    assert.throws(() => nodes.at(-1).add(new m.Node()), /more than 256 levels of nodes/)
  })
  assert.equal(entity.crashes, 1)
  // nodes of a player or of the host have no budget
  const host = chain(m.NODE_DEPTH_LIMIT + 10)
  host[0].activate({ world, entity: { isPlayer: true, data: { id: 'p' } } })
  assert.ok(host.every(node => node.mounted))
})

test('world.attach: a node whose activation stops at the limit is still tracked for teardown', () => {
  const world = { stage: { dirtyNodes: new Set() }, network: {}, events: {} }
  const apps = new m.Apps(world)
  const entity = appEntity()
  entity.worldNodes = new Set()
  const holder = new m.Node()
  const nodes = chain(m.NODE_DEPTH_LIMIT + 1)
  holder.add(nodes[0])
  quietly(() => {
    assert.throws(() => apps.worldMethods.attach(entity, nodes[0].getProxy()), /more than 256 levels of nodes/)
  })
  assert.ok(entity.worldNodes.has(nodes[0]), 'the unbuild deactivates it')
  assert.equal(nodes.at(-2).mounted, true)
  assert.equal(nodes.at(-1).mounted, false)
  assert.equal(entity.crashes, 1)
  for (const node of entity.worldNodes) node.deactivate()
  assert.equal(entity.liveNodes, 0)
})

test('node.getWorldMatrix() without a target returns a new matrix, not one shared by every app', () => {
  const a = new m.Node().getProxy()
  const b = new m.Node().getProxy()
  const first = a.getWorldMatrix()
  let leaked = null
  first.copy = value => (leaked = value)
  const second = b.getWorldMatrix()
  assert.notEqual(first, second)
  assert.equal(leaked, null)
})
