// Small defects of the node classes (P13: NODE-07, 09, 10, 13, 14, 16, 20): what a node kept after its source was
// taken away, what a clone lost, what a remount left behind, and a UI child that could not be hit where it was drawn.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundleProbe, runProbe } from './lib/workerProbe.mjs'

let bundle
before(async () => {
  bundle = await bundleProbe(`
    export * as THREE from './src/core/extras/three'
    export { Stage } from './src/core/systems/Stage'
    export { Anchors } from './src/core/systems/Anchors'
    export { Node } from './src/core/nodes/Node'
    export { Anchor } from './src/core/nodes/Anchor'
    export { Audio } from './src/core/nodes/Audio'
    export { Avatar } from './src/core/nodes/Avatar'
    export { Controller } from './src/core/nodes/Controller'
    export { Image } from './src/core/nodes/Image'
    export { LOD } from './src/core/nodes/LOD'
    export { Nametag } from './src/core/nodes/Nametag'
    export { RigidBody } from './src/core/nodes/RigidBody'
    export { SkinnedMesh } from './src/core/nodes/SkinnedMesh'
    export { UI } from './src/core/nodes/UI'
    export { UIImage } from './src/core/nodes/UIImage'
    export { Video } from './src/core/nodes/Video'
  `)
})
after(() => bundle?.destroy())

test('Image: a src set to null takes the image out of the scene, and a pending load of the old one is dropped', () =>
  runProbe(bundle, async ({ Stage, Image }) => {
    const pending = new Map()
    const world = {
      setupMaterial() {},
      network: { isServer: false },
      graphics: { maxAnisotropy: 1 },
      loader: {
        get: (type, src) => (src === 'asset://ready.png' ? { width: 2, height: 1 } : null),
        load: (type, src) => new Promise(resolve => pending.set(src, resolve)),
      },
    }
    world.stage = new Stage(world)
    const node = new Image({ src: 'asset://ready.png' })
    node.ctx = { world, entity: {} }
    node.mounted = true
    await node.build()
    assert.ok(node.mesh)
    assert.equal(world.stage.octree.root.count, 1)
    assert.ok(world.stage.scene.children.includes(node.mesh))
    const mesh = node.mesh
    node.src = null
    node.commit(false)
    assert.equal(node.mesh, null)
    assert.equal(node.sItem, null)
    assert.equal(world.stage.octree.root.count, 0)
    assert.equal(world.stage.scene.children.includes(mesh), false)
    // an image still loading when the src is cleared does not appear once it arrives
    node.src = 'asset://slow.png'
    node.commit(false)
    assert.ok(pending.has('asset://slow.png'))
    node.src = null
    node.commit(false)
    pending.get('asset://slow.png')({ width: 1, height: 1 })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(node.mesh, null)
    assert.equal(world.stage.octree.root.count, 0)
  }))

test('Image: the texture of an image that is rebuilt or unmounted is disposed', () =>
  runProbe(bundle, async ({ Stage, Image }) => {
    const world = {
      setupMaterial() {},
      network: { isServer: false },
      graphics: { maxAnisotropy: 1 },
      loader: { get: () => ({ width: 1, height: 1 }) },
    }
    world.stage = new Stage(world)
    const node = new Image({ src: 'asset://a.png' })
    node.ctx = { world, entity: {} }
    node.mounted = true
    await node.build()
    let disposed = 0
    const first = node.texture
    first.addEventListener('dispose', () => disposed++)
    node.src = 'asset://b.png'
    node.commit(false)
    assert.equal(disposed, 1)
    assert.notEqual(node.texture, first)
    node.texture.addEventListener('dispose', () => disposed++)
    node.unmount()
    assert.equal(disposed, 2)
    assert.equal(node.texture, null)
    // (nothing left to dispose a second time)
    node.unmount()
    assert.equal(disposed, 2)
  }))

test("Video: the sound goes to the node's own group", () =>
  runProbe(bundle, async ({ Stage, Video }) => {
    for (const group of ['music', 'sfx']) {
      const connected = []
      const gain = { gain: { value: 0 }, connect: target => connected.push(target), disconnect() {} }
      const instance = {
        width: 16,
        height: 9,
        prepare: Promise.resolve(),
        audio: { connect() {}, disconnect() {} },
        texture: null,
        play() {},
        release() {},
      }
      const world = {
        setupMaterial() {},
        network: { isServer: false },
        livekit: { unregisterScreenNode() {} },
        loader: { get: () => ({ get: () => instance }) },
        audio: { ctx: { createGain: () => gain }, groupGains: { music: { name: 'music' }, sfx: { name: 'sfx' } } },
      }
      world.stage = new Stage(world)
      const node = new Video({ src: 'asset://v.mp4', group, spatial: false })
      node.ctx = { world, entity: {} }
      await node.mount()
      assert.deepEqual(connected, [world.audio.groupGains[group]])
      node.unmount()
    }
  }))

test('copy: a clone keeps what its source was given', () =>
  runProbe(bundle, ({ THREE, Nametag, RigidBody, UIImage, Video }) => {
    const nametag = new Nametag({ label: 'a', health: 40 }).clone()
    assert.equal(nametag.health, 40)
    assert.equal(nametag.label, 'a')

    const source = new RigidBody({ type: 'dynamic', linearDamping: 2, angularDamping: 3 })
    source.setCenterOfMass(new THREE.Vector3(1, 2, 3))
    const body = source.clone()
    assert.equal(body.linearDamping, 2)
    assert.equal(body.angularDamping, 3)
    assert.deepEqual(body._centerOfMass.toArray(), [1, 2, 3])
    // the clone's own: moving one body's centre of mass leaves the other's where it was
    assert.notEqual(body._centerOfMass, source._centerOfMass)
    source.setCenterOfMass(new THREE.Vector3(4, 5, 6))
    assert.deepEqual(body._centerOfMass.toArray(), [1, 2, 3])
    // and a body that was given none still has none
    assert.equal(new RigidBody().clone()._centerOfMass, undefined)

    assert.equal(new UIImage({ borderRadius: 7 }).clone().borderRadius, 7)

    const onLoad = () => {}
    const video = new Video({ spatial: false })
    video.onLoad = onLoad
    const copy = video.clone()
    assert.equal(copy.onLoad, onLoad)
    assert.equal(copy.spatial, false)
  }))

test('LOD: a clone without its children has no levels; one with them has its own', () =>
  runProbe(bundle, ({ Node, LOD }) => {
    const lod = new LOD()
    const near = new Node({ id: 'near' })
    const far = new Node({ id: 'far' })
    lod.insert(near, 10)
    lod.insert(far, 100)
    // (threw: Cannot set properties of undefined)
    const alone = lod.clone()
    assert.deepEqual(alone.lods, [])
    assert.equal(alone.children.length, 0)
    const whole = lod.clone(true)
    assert.deepEqual(
      whole.lods.map(level => [level.node.id, level.maxDistance]),
      [
        ['near', 10],
        ['far', 100],
      ]
    )
    assert.deepEqual(
      whole.lods.map(level => level.node),
      whole.children
    )
    assert.ok(whole.children.every(child => child !== near && child !== far && child.active === false))
  }))

test('LOD: a distance that is not a number is no level and leaves the others in order', () =>
  runProbe(bundle, ({ THREE, Node, LOD }) => {
    const world = { camera: new THREE.Object3D(), stage: { dirtyNodes: new Set() } }
    const lod = new LOD({ scaleAware: false })
    const a = new Node({ id: 'a' })
    const b = new Node({ id: 'b' })
    const never = new Node({ id: 'never' })
    const always = new Node({ id: 'always' })
    lod.insert(a, 10)
    lod.insert(never, NaN)
    lod.insert(b, 5)
    lod.insert(always, Infinity)
    // still a child, and never shown: as before
    assert.equal(never.parent, lod)
    assert.equal(never.active, false)
    assert.deepEqual(
      lod.lods.map(level => level.maxDistance),
      [5, 10, Infinity]
    )
    lod.activate({ world })
    const at = distance => {
      world.camera.matrixWorld.makeTranslation(distance, 0, 0)
      lod.check()
      lod.check()
      return [a, b, never, always].filter(node => node.mounted).map(node => node.id)
    }
    assert.deepEqual(at(3), ['b'])
    assert.deepEqual(at(7), ['a'])
    assert.deepEqual(at(1000), ['always'])
    assert.deepEqual(at(0), ['b'])
  }))

test('LOD: a child taken out is no level any more and is not mounted again', () =>
  runProbe(bundle, ({ THREE, Node, LOD }) => {
    const world = { camera: new THREE.Object3D(), stage: { dirtyNodes: new Set() } }
    const lod = new LOD({ scaleAware: false })
    const near = new Node({ id: 'near' })
    const far = new Node({ id: 'far' })
    lod.insert(near, 10)
    lod.insert(far, 100)
    lod.activate({ world })
    const at = distance => {
      world.camera.matrixWorld.makeTranslation(distance, 0, 0)
      lod.check()
      lod.check()
    }
    at(0)
    assert.equal(near.mounted, true)
    assert.equal(far.mounted, false)
    lod.remove(near)
    assert.equal(near.mounted, false)
    assert.equal(near.parent, null)
    assert.deepEqual(
      lod.lods.map(level => level.node),
      [far]
    )
    // the level that was showing left: the next one shows where the camera is, and the LOD no longer switches the
    // one that left (it left switched on, and a script may show it elsewhere)
    at(0)
    assert.equal(far.mounted, true)
    assert.equal(near.active, true)
    // out of every level and back in: what was removed stays out of the scene (it was mounted again, with no parent)
    at(1000)
    assert.equal(far.mounted, false)
    at(0)
    assert.equal(near.mounted, false)
    assert.equal(far.mounted, true)
    // a node that is no child of the LOD is not one of its levels to lose
    const stranger = new Node({ id: 'far' })
    lod.remove(stranger)
    assert.equal(lod.lods.length, 1)
    // a level taken out in the frame it is being replaced (still showing, to be switched off at the next check)
    const mid = new Node({ id: 'mid' })
    lod.insert(mid, 10)
    at(0)
    assert.equal(mid.mounted, true)
    world.camera.matrixWorld.makeTranslation(50, 0, 0)
    lod.check()
    assert.equal(far.mounted, true)
    assert.equal(mid.mounted, true)
    lod.remove(mid)
    at(50)
    assert.equal(mid.active, true)
    assert.equal(mid.mounted, false)
    // moved under another node: the same as removed
    const other = new Node()
    other.add(far)
    assert.deepEqual(lod.lods, [])
    assert.equal(far.mounted, false)
    at(0)
    assert.equal(far.mounted, false)
  }))

test('LOD: a node inserted again has the new distance only, and a child added again keeps its level', () =>
  runProbe(bundle, ({ THREE, Node, LOD }) => {
    const world = { camera: new THREE.Object3D(), stage: { dirtyNodes: new Set() } }
    const lod = new LOD({ scaleAware: false })
    const near = new Node({ id: 'near' })
    const far = new Node({ id: 'far' })
    lod.insert(near, 10)
    lod.insert(far, 100)
    lod.activate({ world })
    const at = distance => {
      world.camera.matrixWorld.makeTranslation(distance, 0, 0)
      lod.check()
      lod.check()
      return [near, far].filter(node => node.mounted).map(node => node.id)
    }
    const levels = owner => owner.lods.map(level => [level.node.id, level.maxDistance])
    assert.deepEqual(at(0), ['near'])
    // inserted again, while it shows, with another distance (was: no level at all, and never shown again)
    lod.insert(near, 20)
    assert.deepEqual(levels(lod), [
      ['near', 20],
      ['far', 100],
    ])
    assert.equal(near.parent, lod)
    assert.deepEqual(at(15), ['near'])
    assert.deepEqual(at(50), ['far'])
    assert.deepEqual(at(0), ['near'])
    // the same distance again is still one level
    lod.insert(near, 20)
    assert.equal(lod.lods.length, 2)
    assert.deepEqual(at(0), ['near'])
    // added again with add (Node.add takes it out of this LOD and puts it back): the level that is off and the one that
    // shows keep their levels, and the LOD still switches them
    lod.add(far)
    lod.add(near)
    assert.deepEqual(levels(lod), [
      ['near', 20],
      ['far', 100],
    ])
    assert.deepEqual(at(0), ['near'])
    assert.deepEqual(at(50), ['far'])
    assert.deepEqual(at(0), ['near'])
    // inserted into another LOD: a level of that one only
    const other = new LOD({ scaleAware: false })
    other.insert(near, 30)
    assert.equal(near.parent, other)
    assert.deepEqual(levels(lod), [['far', 100]])
    assert.deepEqual(levels(other), [['near', 30]])
    assert.deepEqual(at(0), ['far'])
    // a node that cannot be added (the LOD's own parent) is no level of it
    const holder = new Node({ id: 'holder' })
    holder.add(other)
    assert.throws(() => other.insert(holder, 5), /cannot add a node to itself or to one of its descendants/)
    assert.deepEqual(levels(other), [['near', 30]])
  }))

test('SkinnedMesh: remount, shadows, bone names and the skeleton of an unmounted copy', () =>
  runProbe(bundle, ({ THREE, SkinnedMesh }) => {
    const root = new THREE.Group()
    const hips = new THREE.Bone()
    hips.name = 'hips'
    const head = new THREE.Bone()
    head.name = 'head'
    hips.add(head)
    root.add(hips)
    const geometry = new THREE.BoxGeometry(1, 2, 1)
    const count = geometry.attributes.position.count
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4))
    const weights = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) weights[i * 4] = 1
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
    const skinned = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
    root.add(skinned)
    root.updateMatrixWorld(true)
    skinned.bind(new THREE.Skeleton([hips, head]))
    const idle = new THREE.AnimationClip('idle', 1, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 1], [0, 0, 0, 0, 1, 0]),
    ])
    const hot = new Set()
    const world = {
      stage: { scene: new THREE.Scene(), dirtyNodes: new Set() },
      setHot: (item, on) => (on ? hot.add(item) : hot.delete(item)),
    }
    const node = new SkinnedMesh({ object3d: root, animations: [idle] })
    node.ctx = { world, entity: {} }
    node.mounted = true
    node.mount()
    const meshOf = () => {
      let found
      node.obj.traverse(n => {
        if (n.isSkinnedMesh) found = n
      })
      return found
    }

    // a shadow setting changed after the mount reaches the meshes, and the animation that plays goes on
    node.play({ name: 'idle' })
    const mixer = node.mixer
    const action = node.action
    assert.equal(action.isRunning(), true)
    assert.equal(meshOf().castShadow, true)
    assert.equal(meshOf().receiveShadow, true)
    node.castShadow = false
    assert.equal(meshOf().castShadow, false)
    assert.equal(meshOf().receiveShadow, true)
    node.receiveShadow = false
    assert.equal(meshOf().receiveShadow, false)
    assert.equal(world.stage.dirtyNodes.size, 0)
    assert.equal(node.mixer, mixer)
    assert.equal(node.action, action)
    assert.equal(action.isRunning(), true)

    // names every object has are not bones
    const warn = console.warn
    const warnings = []
    console.warn = message => warnings.push(message)
    try {
      for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        const handle = node.getBone(name)
        assert.equal(typeof handle, 'object', name)
        assert.equal(Object.hasOwn(handle, 'matrixWorld'), true, name)
        assert.equal(node.readBone(name), null, name)
        assert.equal(handle.matrixWorld, null, name)
      }
      assert.equal(warnings.length, 8)
    } finally {
      console.warn = warn
    }
    assert.equal(node.readBone('head').isBone, true)
    assert.equal(node.getBone('head'), node.getBone('head'))

    // the copy's skeleton goes with the unmount (its bone texture, once a renderer made one)
    const skeleton = meshOf().skeleton
    assert.notEqual(skeleton, skinned.skeleton)
    skeleton.computeBoneTexture()
    assert.ok(skeleton.boneTexture)
    skinned.skeleton.computeBoneTexture()
    node.unmount()
    assert.equal(skeleton.boneTexture, null)
    // (the model's own skeleton, which other copies are made from, is left alone)
    assert.ok(skinned.skeleton.boneTexture)
    assert.equal(node.action, null)
    assert.equal(hot.size, 0)

    // mounted again, the clip that played before plays again (the call returned without doing anything)
    node.mount()
    node.play({ name: 'idle' })
    assert.ok(node.action)
    assert.notEqual(node.action, action)
    assert.equal(node.action.getMixer(), node.mixer)
    assert.notEqual(node.mixer, mixer)
    assert.equal(node.action.isRunning(), true)
    assert.equal(hot.has(node), true)
    // an unmount of a mesh that never played also forgets nothing it should keep
    node.unmount()
    node.mount()
    node.unmount()
    assert.equal(node.action, null)
  }))

test('Avatar: after its src is set to null a remount makes no avatar', () =>
  runProbe(bundle, async ({ Avatar }) => {
    const made = []
    const instanceOf = name => ({
      name,
      setEmote() {},
      setVisible() {},
      move() {},
      destroy() {
        made.push(`-${name}`)
      },
    })
    const factoryOf = name => ({
      create() {
        made.push(`+${name}`)
        return instanceOf(name)
      },
    })
    const world = {
      setHot() {},
      avatars: { add() {}, remove() {} },
      stage: { dirtyNodes: new Set() },
      loader: { get: (type, src) => ({ factory: factoryOf(src), hooks: { of: src } }) },
    }
    const node = new Avatar({ src: 'a.vrm' })
    node.ctx = { world, entity: {} }
    node.mounted = true
    await node.mount()
    assert.deepEqual(made, ['+a.vrm'])
    node.src = null
    node.commit(false)
    await node.mounting
    assert.deepEqual(made, ['+a.vrm', '-a.vrm'])
    assert.equal(node.instance, null)
    assert.equal(node.factory, null)
    assert.equal(node.hooks, null)
    // and again later (an app moved, a parent switched off and on)
    node.unmount()
    await node.mount()
    assert.deepEqual(made, ['+a.vrm', '-a.vrm'])
    // another src shows that one
    node.src = 'b.vrm'
    node.commit(false)
    await node.mounting
    assert.deepEqual(made, ['+a.vrm', '-a.vrm', '+b.vrm'])
    assert.deepEqual(node.hooks, { of: 'b.vrm' })

    // an avatar made from a model's own factory (no src) keeps it across remounts
    const own = new Avatar({ factory: factoryOf('own'), hooks: {} })
    own.ctx = { world, entity: {} }
    own.mounted = true
    await own.mount()
    own.src = null
    own.unmount()
    await own.mount()
    assert.deepEqual(made.slice(3), ['+own', '-own', '+own'])
  }))

test('Avatar: a load still on its way when the src changes makes no avatar and calls no onLoad', () =>
  runProbe(bundle, async ({ Avatar }) => {
    const made = []
    const loaded = []
    const resolvers = new Map()
    const factoryOf = name => ({
      create() {
        made.push(`+${name}`)
        return {
          setEmote() {},
          setVisible() {},
          move() {},
          destroy() {
            made.push(`-${name}`)
          },
        }
      },
    })
    const world = {
      setHot() {},
      avatars: { add() {}, remove() {} },
      stage: { dirtyNodes: new Set() },
      // nothing is cached: every avatar is loaded, and arrives when the test says
      loader: {
        get: () => null,
        load: (type, src) =>
          new Promise(resolve => resolvers.set(src, () => resolve({ factory: factoryOf(src), hooks: { of: src } }))),
      },
    }
    const avatarOf = src => {
      const node = new Avatar({ src, onLoad: () => loaded.push(node.hooks?.of) })
      node.ctx = { world, entity: {} }
      node.mounted = true
      return node
    }
    // src set to null before the file arrives, and before the stage cleans the node
    const node = avatarOf('a.vrm')
    const first = node.mount()
    node.src = null
    resolvers.get('a.vrm')()
    await first
    assert.deepEqual(made, [])
    assert.deepEqual(loaded, [])
    assert.equal(node.instance, null)
    assert.equal(node.factory, null)
    assert.equal(node.hooks, null)
    // (and the rebuild that the src asked for makes none either)
    node.commit(false)
    await node.mounting
    assert.deepEqual(made, [])
    assert.deepEqual(loaded, [])
    // set to another src: only that one is made, and its onLoad is the only one
    const other = avatarOf('b.vrm')
    const pending = other.mount()
    other.src = 'c.vrm'
    resolvers.get('b.vrm')()
    await pending
    assert.deepEqual(made, [])
    other.commit(false)
    resolvers.get('c.vrm')()
    await other.mounting
    assert.deepEqual(made, ['+c.vrm'])
    assert.deepEqual(loaded, ['c.vrm'])
    assert.deepEqual(other.hooks, { of: 'c.vrm' })
  }))

test('Controller: a visible one mounts without a renderer (the server) and shows its capsule where there is one', () =>
  runProbe(bundle, ({ THREE, Controller }) => {
    // no controller is made (the descriptor is refused): only the capsule mesh is looked at
    globalThis.PHYSX = {
      PxCapsuleControllerDesc: class {
        isValid() {
          return false
        }
      },
      PxCapsuleClimbingModeEnum: { eCONSTRAINED: 0 },
      destroy() {},
    }
    const warn = console.warn
    console.warn = () => {}
    try {
      const server = {
        network: { isServer: true },
        physics: { defaultMaterial: {} },
        stage: { scene: new THREE.Scene() },
      }
      const onServer = new Controller({ visible: true })
      onServer.ctx = { world: server, entity: {} }
      onServer.mount()
      assert.equal(onServer.mesh, undefined)
      assert.deepEqual(server.stage.scene.children, [])
      onServer.unmount()

      const client = {
        network: { isServer: false },
        physics: { defaultMaterial: {} },
        stage: { scene: new THREE.Scene() },
        // (as the client's graphics system: it has no scene of its own)
        graphics: {},
      }
      const node = new Controller({ visible: true })
      node.ctx = { world: client, entity: {} }
      node.mount()
      assert.ok(node.mesh)
      assert.deepEqual(client.stage.scene.children, [node.mesh])
      node.unmount()
      assert.equal(node.mesh, null)
      assert.deepEqual(client.stage.scene.children, [])

      const hidden = new Controller()
      hidden.ctx = { world: client, entity: {} }
      hidden.mount()
      assert.equal(hidden.mesh, undefined)
      assert.deepEqual(client.stage.scene.children, [])
    } finally {
      console.warn = warn
    }
  }))

test('Anchor: two anchors of one id (a clone) do not take each other out', () =>
  runProbe(bundle, ({ Anchor, Anchors }) => {
    const world = {}
    world.anchors = new Anchors(world)
    const ctx = { world, entity: { data: { id: 'app1' } } }
    const mount = node => {
      node.ctx = ctx
      node.mount()
    }
    const copyOf = node => node.clone().matrixWorld
    for (const order of ['first', 'last']) {
      const seat = new Anchor({ id: 'seat' })
      const copy = seat.clone()
      mount(seat)
      mount(copy)
      assert.equal(seat.anchorId, 'app1:seat')
      assert.equal(copy.anchorId, 'app1:seat')
      // the one mounted last is the id's anchor, as before
      assert.equal(world.anchors.get('app1:seat'), copy.matrixWorld)
      const [leaves, stays] = order === 'first' ? [seat, copy] : [copy, seat]
      leaves.unmount()
      assert.equal(world.anchors.get('app1:seat'), stays.matrixWorld, `the ${order} mounted leaves`)
      assert.equal(world.anchors.matrices.size, 1)
      // an unmount said twice takes nothing more
      leaves.unmount()
      assert.equal(world.anchors.get('app1:seat'), stays.matrixWorld)
      stays.unmount()
      assert.equal(world.anchors.get('app1:seat'), undefined)
      assert.equal(world.anchors.matrices.size, 0)
    }
    // one anchor mounted again and again holds one place
    const seat = new Anchor({ id: 'seat' })
    mount(seat)
    seat.unmount()
    mount(seat)
    assert.equal(world.anchors.get('app1:seat'), seat.matrixWorld)
    seat.unmount()
    assert.equal(world.anchors.matrices.size, 0)
    world.anchors.remove('nothing', seat.matrixWorld)
    // the system itself: one matrix added twice holds one place, and a matrix that is not there takes none away
    world.anchors.add('x', seat.matrixWorld)
    world.anchors.add('x', seat.matrixWorld)
    world.anchors.remove('x', copyOf(seat))
    assert.equal(world.anchors.get('x'), seat.matrixWorld)
    world.anchors.remove('x', seat.matrixWorld)
    assert.equal(world.anchors.get('x'), undefined)
    assert.equal(world.anchors.matrices.size, 0)
  }))

test('Audio: another src plays from its start, and the file that was still loading is not the one that plays', () =>
  runProbe(bundle, async ({ Audio }) => {
    const started = []
    const pending = new Map()
    const context = {
      currentTime: 0,
      createBufferSource: () => ({
        connect() {},
        start(when, offset) {
          started.push([this.buffer.name, offset])
        },
        stop() {},
      }),
      createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    }
    const world = {
      stage: { dirtyNodes: new Set() },
      audio: { ctx: context, groupGains: { music: {}, sfx: {} }, lastDelta: 0, ready: fn => fn() },
      loader: {
        get: (type, src) => (src.startsWith('slow') ? null : { name: src }),
        load: (type, src) =>
          new Promise((resolve, reject) =>
            pending.set(src, failure => (failure ? reject(failure) : resolve({ name: src })))
          ),
      },
    }
    const frame = node => {
      if (world.stage.dirtyNodes.delete(node)) {
        node.isDirty = false
        node.commit(false)
      }
    }
    const node = new Audio({ src: 'a.mp3', spatial: false })
    node.ctx = { world, entity: {} }
    node.mounted = true
    await node.play()
    assert.deepEqual(started, [['a.mp3', 0]])
    // five seconds in, a setting that rebuilds the source keeps the place
    context.currentTime = 5
    node.loop = true
    frame(node)
    assert.deepEqual(started.at(-1), ['a.mp3', 5])
    // another file starts at its start (it started five seconds in)
    context.currentTime = 9
    node.src = 'b.mp3'
    frame(node)
    assert.deepEqual(started.at(-1), ['b.mp3', 0])
    assert.equal(started.length, 3)
    assert.equal(node.isPlaying, true)
    // the same src again changes nothing about where it plays
    context.currentTime = 12
    node.src = 'b.mp3'
    frame(node)
    assert.deepEqual(started.at(-1), ['b.mp3', 3])
    // paused, then given another file: that one starts at its start too
    context.currentTime = 20
    node.pause()
    assert.equal(node.currentTime, 11)
    node.src = 'c.mp3'
    frame(node)
    assert.equal(node.isPlaying, false)
    assert.equal(node.currentTime, 0)
    await node.play()
    assert.deepEqual(started.at(-1), ['c.mp3', 0])
    // no src: silence, and a later src starts at its start
    context.currentTime = 30
    node.src = null
    frame(node)
    assert.equal(node.isPlaying, false)
    assert.equal(node.currentTime, 0)

    // a file still loading when the src changes is not played: the new src is
    started.length = 0
    node.src = 'slow-1.mp3'
    frame(node)
    const playing = node.play()
    assert.ok(pending.has('slow-1.mp3'))
    node.src = 'd.mp3'
    frame(node)
    pending.get('slow-1.mp3')()
    await playing
    assert.deepEqual(started, [['d.mp3', 0]])
    assert.equal(node.source.buffer.name, 'd.mp3')
    // and a src taken away while its file loads plays nothing
    node.stop()
    started.length = 0
    node.src = 'slow-2.mp3'
    frame(node)
    const silent = node.play()
    node.src = null
    frame(node)
    pending.get('slow-2.mp3')()
    await silent
    assert.deepEqual(started, [])
    assert.equal(node.isPlaying, false)
    // nor does the old file's failure keep the new src from playing; a failure of the src itself plays nothing
    const error = console.error
    const errors = []
    console.error = err => errors.push(err.message)
    try {
      node.src = 'slow-3.mp3'
      frame(node)
      const failing = node.play()
      node.src = 'e.mp3'
      frame(node)
      pending.get('slow-3.mp3')(new Error('no such file'))
      await failing
      assert.deepEqual(started, [['e.mp3', 0]])
      node.stop()
      node.src = 'slow-4.mp3'
      frame(node)
      const failed = node.play()
      pending.get('slow-4.mp3')(new Error('refused'))
      await failed
      assert.deepEqual(started, [['e.mp3', 0]])
      assert.equal(node.isPlaying, false)
      assert.deepEqual(errors, ['no such file', 'refused'])
    } finally {
      console.error = error
    }
    // a script that wants the place kept across a change of src reads it before and sets it after
    node.src = 'f.mp3'
    frame(node)
    await node.play()
    context.currentTime += 7
    let time = node.currentTime
    assert.equal(time, 7)
    node.src = 'g.mp3'
    node.currentTime = time
    frame(node)
    assert.deepEqual(started.at(-1), ['g.mp3', 7])
    context.currentTime += 2
    time = node.currentTime
    node.src = 'slow-5.mp3'
    node.currentTime = time
    frame(node)
    pending.get('slow-5.mp3')()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(started.at(-1), ['slow-5.mp3', 9])
  }))

test('Audio: paused right after another src is set, it stays paused when the file arrives; a play then plays it', () =>
  runProbe(bundle, async ({ Audio }) => {
    const started = []
    const loads = new Map()
    const resolvers = new Map()
    const context = {
      currentTime: 0,
      createBufferSource: () => ({
        connect() {},
        start(when, offset) {
          started.push([this.buffer.name, offset])
        },
        stop() {},
      }),
      createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    }
    const world = {
      stage: { dirtyNodes: new Set() },
      audio: { ctx: context, groupGains: { music: {}, sfx: {} }, lastDelta: 0, ready: fn => fn() },
      loader: {
        get: (type, src) => (src.startsWith('slow') ? null : { name: src }),
        // (one request per file, as the loader's: another load of a file on its way waits for the same one)
        load: (type, src) => {
          if (!loads.has(src)) loads.set(src, new Promise(resolve => resolvers.set(src, () => resolve({ name: src }))))
          return loads.get(src)
        },
      },
    }
    const settle = () => new Promise(resolve => setTimeout(resolve, 0))
    const node = new Audio({ src: 'a.mp3', spatial: false })
    node.ctx = { world, entity: {} }
    node.mounted = true
    await node.play()
    context.currentTime = 4
    // `audio.src = 'slow-b.mp3'; audio.pause()` while a.mp3 plays (was: b started when it arrived)
    node.src = 'slow-b.mp3'
    node.pause()
    resolvers.get('slow-b.mp3')()
    await settle()
    assert.deepEqual(started, [['a.mp3', 0]])
    assert.equal(node.isPlaying, false)
    assert.equal(node.currentTime, 0)
    await node.play()
    assert.deepEqual(started.at(-1), ['slow-b.mp3', 0])
    // a play called while the file is still on its way starts it once, when it arrives
    node.src = 'slow-c.mp3'
    node.pause()
    const playing = node.play()
    assert.equal(started.length, 2)
    resolvers.get('slow-c.mp3')()
    await playing
    await settle()
    assert.deepEqual(started.slice(2), [['slow-c.mp3', 0]])
    assert.equal(node.isPlaying, true)
    // a stop in place of the pause holds too (it did)
    node.src = 'slow-d.mp3'
    node.stop()
    resolvers.get('slow-d.mp3')()
    await settle()
    assert.equal(started.length, 3)
    assert.equal(node.isPlaying, false)
  }))

test('UI: a child drawn outside its parent is hit where it is drawn', () =>
  runProbe(
    bundle,
    ({ UI }) => {
      const box = (left, top, width, height) => ({ left, top, width, height })
      const view = (name, at, children = []) => ({ name, box: at, _display: 'flex', children })
      const ui = new UI()
      // not drawn yet: nothing to hit
      assert.equal(ui.findNodeAt(1, 1), null)
      ui.box = box(0, 0, 200, 200)
      // a menu (absolute) hangs below its 20 px bar, over the panel that is drawn before the bar
      const menu = view('menu', box(10, 20, 80, 60))
      const bar = view('bar', box(0, 0, 200, 20), [menu])
      const item = view('item', box(0, 100, 50, 50))
      const panel = view('panel', box(0, 20, 200, 180), [item])
      ui.children.push(panel, bar)
      const at = (x, y) => ui.findNodeAt(x, y)?.name ?? null
      assert.equal(at(5, 5), 'bar')
      // outside the bar's box, inside its child's (was: the panel behind it)
      assert.equal(at(20, 40), 'menu')
      assert.equal(at(150, 40), 'panel')
      assert.equal(at(10, 110), 'item')
      // what is drawn later is in front: a panel drawn after the bar covers the bar's menu
      ui.children.reverse()
      assert.equal(at(20, 40), 'panel')
      assert.equal(at(5, 5), 'bar')
      ui.children.reverse()
      // a hidden parent hides its children, wherever their boxes were
      bar._display = 'none'
      assert.equal(at(20, 40), 'panel')
      assert.equal(at(5, 5), 'ui')
      bar._display = 'flex'
      // a hidden child, and one that was never drawn
      menu._display = 'none'
      assert.equal(at(20, 40), 'panel')
      menu._display = 'flex'
      menu.box = null
      assert.equal(at(20, 40), 'panel')
      menu.box = box(10, 20, 80, 60)
      // nothing is drawn outside the canvas: a point there hits nothing, also where a child's box reaches
      const outside = view('outside', box(180, 180, 100, 100))
      panel.children.push(outside)
      assert.equal(at(190, 190), 'outside')
      assert.equal(at(250, 250), null)
      assert.equal(at(-1, 5), null)
    },
    { browser: true }
  ))

test('Node: each transform says its own name when a script tries to replace it', () =>
  runProbe(bundle, ({ Node }) => {
    const proxy = new Node().getProxy()
    for (const name of ['position', 'quaternion', 'rotation', 'scale']) {
      assert.throws(
        () => {
          proxy[name] = null
        },
        { message: `Cannot replace node ${name}` }
      )
    }
  }))
