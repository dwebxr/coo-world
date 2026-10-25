import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { bundleRealPhysx, runRealPhysx } from './lib/realPhysx.mjs'

// Phase 3b-2b on the real PhysX wasm: no native allocation outlives its node, and assigning an unchanged value does
// not rebuild. Live wasm chunks are counted exactly (test/lib/physxHeap.mjs) over a warmed window; PhysX's own pools
// still grow a little (~0.1 chunk per cycle for a bare create/destroy loop), hence the tolerance. On the code before
// this change: RigidBody leaks 1-2 chunks per mount, Controller 4, a Joint node 2, addForceAtPos 2 per node.
let bundle
before(async () => {
  bundle = await bundleRealPhysx()
})
after(() => bundle?.destroy())
const probe = (name, fn, args) => test(name, () => runRealPhysx(bundle, fn, args, { deadline: 120000 }))

function cycles({ B, root, body, liveChunks }, name) {
  const V = (x, y, z) => new B.THREE.Vector3(x, y, z)
  const perCycle = (fn, n = 200) => {
    for (let i = 0; i < 20; i++) fn(i)
    const start = liveChunks()
    for (let i = 0; i < n; i++) fn(i)
    return (liveChunks() - start) / n
  }
  const rigid = (data = {}) => {
    const rb = new B.RigidBody({ type: 'dynamic', ...data })
    rb.add(new B.Collider({ type: 'box', width: 1, height: 1, depth: 1 }))
    return rb
  }
  let leak
  switch (name) {
    case 'RigidBody with a box collider, fresh nodes':
      leak = perCycle(() => {
        const rb = rigid()
        root.add(rb)
        root.remove(rb)
      })
      break
    case 'RigidBody with a box collider, the same node remounted': {
      const rb = rigid()
      leak = perCycle(() => {
        root.add(rb)
        root.remove(rb)
      })
      break
    }
    case 'RigidBody with a centre of mass, remounted by a new mass': {
      const rb = rigid()
      root.add(rb)
      rb.getProxy().setCenterOfMass(V(0, 0.5, 0))
      rb.clean()
      leak = perCycle(i => {
        rb.mass = 1 + (i % 2)
        rb.clean()
      })
      break
    }
    case 'RigidBody addForceAtPos and setKinematicTarget, fresh nodes':
      leak = perCycle(() => {
        const dynamic = rigid()
        root.add(dynamic)
        dynamic.getProxy().addForceAtPos(V(1, 0, 0), V(0, 1, 0))
        root.remove(dynamic)
        const kinematic = rigid({ type: 'kinematic' })
        root.add(kinematic)
        kinematic.getProxy().setKinematicTarget(V(0, 1, 0), new B.THREE.Quaternion())
        root.remove(kinematic)
      })
      break
    case 'Controller, the same node remounted': {
      const node = new B.Controller({ radius: 0.4, height: 1 })
      leak = perCycle(() => {
        root.add(node)
        root.remove(node)
      })
      break
    }
    case 'Joint of each type, fresh nodes': {
      const a = body('RigidBody', { position: [0, 0, 0] })
      const b = body('RigidBody', { position: [3, 0, 0] })
      const types = ['fixed', 'socket', 'hinge', 'distance']
      leak = perCycle(i => {
        const node = new B.Joint({ type: types[i % 4], limitY: 30, limitZ: 30, limitMin: -10, limitMax: 10, limitStiffness: 10, limitDamping: 1 })
        node.body0 = a
        node.body1 = b
        root.add(node)
        root.remove(node)
      })
      break
    }
    case 'Prim box, the same node remounted': {
      const node = new B.Prim({ type: 'box', size: [1, 1, 1], physics: 'dynamic', opacity: 0 })
      leak = perCycle(() => {
        root.add(node)
        root.remove(node)
      })
      break
    }
    default:
      throw new Error(`unknown case ${name}`)
  }
  assert.ok(leak < 0.5, `${name}: ${leak} live chunks per cycle`)
}

for (const name of [
  'RigidBody with a box collider, fresh nodes',
  'RigidBody with a box collider, the same node remounted',
  'RigidBody with a centre of mass, remounted by a new mass',
  'RigidBody addForceAtPos and setKinematicTarget, fresh nodes',
  'Controller, the same node remounted',
  'Joint of each type, fresh nodes',
  'Prim box, the same node remounted',
]) {
  probe(`physics lifetimes: ${name}`, cycles, name)
}

probe('physics lifetimes: an unchanged value does not rebuild', ({ B, root }) => {
  const mounts = node => {
    let count = 0
    const mount = node.mount
    node.mount = function (...args) {
      count++
      return mount.apply(this, args)
    }
    return () => count
  }
  const rb = new B.RigidBody({ type: 'dynamic', mass: 2, linearDamping: 0.1, angularDamping: 0.2 })
  const collider = new B.Collider({ type: 'box', width: 1, height: 1, depth: 1 })
  rb.add(collider)
  const controller = new B.Controller({ radius: 0.4, height: 1 })
  root.add(rb)
  root.add(controller)
  const rbMounts = mounts(rb)
  const colliderMounts = mounts(collider)
  const controllerMounts = mounts(controller)
  for (let i = 0; i < 10; i++) {
    rb.mass = 2
    rb.linearDamping = 0.1
    rb.angularDamping = 0.2
    rb.getProxy().setCenterOfMass(new B.THREE.Vector3(0, 0, 0))
    collider.width = 1
    collider.staticFriction = collider.staticFriction
    collider.layer = collider.layer
    collider.trigger = false
    controller.radius = 0.4
    controller.height = 1
    rb.clean()
    controller.clean()
  }
  assert.deepEqual([rbMounts(), colliderMounts(), controllerMounts()], [1, 0, 0], 'rigid body mounts once (for the centre of mass), the rest never')
  // a different value still rebuilds
  rb.mass = 3
  collider.width = 2
  controller.radius = 0.5
  rb.clean()
  controller.clean()
  assert.ok(rbMounts() >= 2 && colliderMounts() >= 1 && controllerMounts() === 1, 'changed values rebuild')
  // requestRebuild stays unconditional
  const before = colliderMounts()
  collider.requestRebuild()
  collider.clean()
  assert.equal(colliderMounts(), before + 1, 'requestRebuild rebuilds')
})

function jointSurvival({ B, root, step, body, liveChunks, physics }, name) {
  const V = (x, y, z) => new B.THREE.Vector3(x, y, z)
  const constraints = () => physics.scene.getNbConstraints()
  const at = node => {
    const { x, y, z } = node.actor.getGlobalPose().p
    return { x, y, z }
  }
  // a fixed joint holds the two boxes 3 m apart: pushing one drags the other along (the pair turns about them both).
  // Without the joint the first box stays at z = 0 and the gap opens to about 3.9 m.
  const holds = (a, b) => {
    b.getProxy().setLinearVelocity(V(0, 0, 5))
    step(30)
    const pa = at(a)
    const pb = at(b)
    return Math.abs(Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z) - 3) < 0.2 && pa.z > 0.1
  }
  const pair = () => {
    const a = body('RigidBody', { position: [0, 0, 0], linearDamping: 0, angularDamping: 0 })
    const b = body('RigidBody', { position: [3, 0, 0], linearDamping: 0, angularDamping: 0 })
    const joint = new B.Joint({ type: 'fixed' })
    joint.body0 = a
    joint.body1 = b
    joint.offset0.set(1.5, 0, 0)
    joint.offset1.set(-1.5, 0, 0)
    root.add(joint)
    return { a, b, joint }
  }
  switch (name) {
    case 'a new mass on one body': {
      const { a, b } = pair()
      a.mass = 2
      a.clean()
      assert.equal(constraints(), 1)
      assert.ok(holds(a, b), 'the joint still holds')
      break
    }
    case 'the joint cleaned before the body': {
      const { a, b, joint } = pair()
      joint.getProxy().breakForce = 1e9
      a.mass = 2
      joint.clean()
      a.clean()
      assert.equal(constraints(), 1)
      assert.ok(holds(a, b), 'the joint still holds')
      break
    }
    case 'both bodies rebuilt with the joint dirtied first': {
      const { a, b, joint } = pair()
      joint.getProxy().breakForce = 1e9
      a.mass = 2
      b.mass = 3
      joint.clean()
      a.clean()
      b.clean()
      assert.equal(constraints(), 1)
      assert.ok(holds(a, b), 'the joint still holds')
      break
    }
    case 'one body removed, then added back': {
      const { a, b, joint } = pair()
      root.remove(a)
      assert.equal(constraints(), 0, 'the joint waits')
      // the survivor is free, not pinned to the world
      b.getProxy().setLinearVelocity(V(0, 0, 5))
      step(30)
      assert.ok(at(b).z > 0.5, 'the remaining body moves')
      joint.getProxy().active = false
      joint.getProxy().active = true
      root.add(a)
      assert.equal(constraints(), 1, 'the joint mounts again once the body is back')
      const start = liveChunks()
      for (let i = 0; i < 50; i++) {
        root.remove(a)
        root.add(a)
      }
      assert.equal(constraints(), 1)
      assert.ok((liveChunks() - start) / 50 < 0.5, 'no joint is created twice')
      break
    }
    case 'a joint created before its body is mounted': {
      const a = new B.RigidBody({ type: 'dynamic', linearDamping: 0, angularDamping: 0 })
      a.add(new B.Collider({ type: 'box', width: 2, height: 2, depth: 2 }))
      const b = body('RigidBody', { position: [3, 0, 0], linearDamping: 0, angularDamping: 0 })
      const joint = new B.Joint({ type: 'fixed' })
      joint.body0 = a
      joint.body1 = b
      joint.offset0.set(1.5, 0, 0)
      joint.offset1.set(-1.5, 0, 0)
      root.add(joint)
      assert.equal(constraints(), 0, 'the joint waits for the body')
      root.add(a)
      assert.equal(constraints(), 1, 'the joint mounts with the body')
      assert.ok(holds(a, b), 'the joint holds')
      break
    }
    default:
      throw new Error(`unknown case ${name}`)
  }
}

for (const name of [
  'a new mass on one body',
  'the joint cleaned before the body',
  'both bodies rebuilt with the joint dirtied first',
  'one body removed, then added back',
  'a joint created before its body is mounted',
]) {
  probe(`physics lifetimes: joints survive a body rebuild: ${name}`, jointSurvival, name)
}

probe('physics lifetimes: mesh checks and budgets', ({ B, root, world }) => {
  const mesh = (vertexCount, indices) => {
    const geometry = new B.THREE.BufferGeometry()
    // vertex 3k, 3k+1, 3k+2 form a right triangle at x = k, so consecutive index triples never degenerate
    const positions = new Float32Array(vertexCount * 3)
    for (let i = 0; i < vertexCount; i++) positions.set([Math.floor(i / 3), i % 3 === 1 ? 1 : 0, i % 3 === 2 ? 1 : 0], i * 3)
    geometry.setAttribute('position', new B.THREE.BufferAttribute(positions, 3))
    // setIndex keeps a bare typed array unwrapped, so wrap it the way a loaded model has it
    if (indices) geometry.setIndex(Array.isArray(indices) ? indices : new B.THREE.BufferAttribute(indices, 1))
    return geometry
  }
  const collide = (geometry, entity, convex = false) => {
    const rb = new B.RigidBody({ type: 'static' })
    const collider = new B.Collider({ type: 'geometry', geometry, convex })
    rb.add(collider)
    // a different app per entity: the per-app budget is charged to ctx.entity
    if (entity) {
      const node = new B.Node()
      node.activate({ world, entity, moving: false })
      node.add(rb)
    } else {
      root.add(rb)
    }
    return collider
  }
  // malformed indices: not whole triangles, an index past the vertices
  assert.equal(collide(mesh(4, [0, 1, 2, 3])).shape, null, 'index count not a multiple of 3')
  assert.equal(collide(mesh(4, [0, 1, 99])).shape, null, 'index past the vertices')
  // a forged negative or fractional vertex count is refused before anything is allocated
  const forged = mesh(3, [0, 1, 2])
  Object.defineProperty(forged.attributes.position, 'count', { value: -1 })
  assert.doesNotThrow(() => collide(forged))
  // per mesh: too many triangles (a 200k-triangle limit; 200 001 triangles over 3 vertices is enough to test it)
  const many = new Uint32Array(200_001 * 3)
  assert.equal(collide(mesh(3, many)).shape, null, 'too many triangles')
  // per app: two 150k-vertex meshes fit one app's 400k budget only once each with their triangles
  const app = { isApp: true, data: { id: 'app-a' }, deadHook: { dead: false } }
  const other = { isApp: true, data: { id: 'app-b' }, deadHook: { dead: false } }
  const big = () => mesh(150_000, new Uint32Array(30_000 * 3).map((_, i) => i))
  const first = collide(big(), app)
  const second = collide(big(), app)
  const third = collide(big(), app)
  assert.ok(first.shape && second.shape, 'two meshes fit the app budget')
  assert.equal(third.shape, null, 'the third mesh is over the app budget')
  // another app has its own budget
  assert.ok(collide(big(), other).shape, 'another app still gets its mesh')
  // releasing returns the budget
  first.parent.parent.remove(first.parent)
  const fourth = collide(big(), app)
  assert.ok(fourth.shape, 'the budget comes back after a release')
})

probe('physics lifetimes: a native throw mid-mount leaves no temporaries and no stale handle', ({ B, PHYSX, root, physics, liveChunks }) => {
  // throw once from a native method, then restore it
  const failOnce = (proto, method) => {
    const original = proto[method]
    proto[method] = function () {
      proto[method] = original
      throw new Error(`injected ${method} failure`)
    }
  }
  const perCycle = (fn, n = 40) => {
    for (let i = 0; i < 5; i++) fn()
    const start = liveChunks()
    for (let i = 0; i < n; i++) fn()
    return (liveChunks() - start) / n
  }
  const collider = () => {
    const rb = new B.RigidBody({ type: 'static' })
    rb.add(new B.Collider({ type: 'box', width: 1, height: 1, depth: 1 }))
    return rb
  }
  // Collider: setLocalPose throws after the shape exists (the throw reaches the caller; the temporaries do not leak)
  const colliderLeak = perCycle(() => {
    const rb = collider()
    failOnce(PHYSX.PxShape.prototype, 'setLocalPose')
    assert.throws(() => root.add(rb), /injected setLocalPose failure/)
    root.remove(rb)
  })
  assert.ok(colliderLeak < 0.5, `collider temporaries: ${colliderLeak} chunks per throw`)
  // Physics.addActor: scene.addActor throws, so no handle is published
  const handles = physics.handles.size
  const registrations = physics.registrations.size
  const rb = collider()
  failOnce(PHYSX.PxScene.prototype, 'addActor')
  assert.throws(() => root.add(rb), /injected addActor failure/)
  assert.equal(physics.handles.size, handles, 'no stale handle')
  assert.equal(physics.registrations.size, registrations, 'no stale registration')
  // Prim: attachShape throws after the geometry was built (Prim logs mount failures instead of throwing)
  const primLeak = perCycle(() => {
    const node = new B.Prim({ type: 'box', size: [1, 1, 1], physics: 'static', opacity: 0 })
    failOnce(PHYSX.PxRigidActor.prototype, 'attachShape')
    root.add(node)
    root.remove(node)
  })
  assert.ok(primLeak < 0.5, `prim geometry: ${primLeak} chunks per throw`)
})
