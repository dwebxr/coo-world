// Both realms use the same fixtures and assertions. Only --sentinel-only runs on the old base.
const subset = !!props.sentinelOnly
const check = (value, message) => {
  if (!value) throw new Error(message)
}
const near = (a, b, epsilon = 0.02) => Math.abs(a - b) < epsilon
const xyz = v => [v.x, v.y, v.z]
const same = (a, b) => a.every((n, i) => near(n, b[i], 1e-5))
const vector = (x = 0, y = 0, z = 0) => new Vector3(x, y, z)
const stock = (x = 0, y = 0, z = 0) => new Object3D().position.set(x, y, z)
const counts = { prim: { begin: 0, end: 0, points: 0 }, body: { begin: 0, end: 0, points: 0 }, enter: 0, leave: 0 }
let ticks = 0
let elapsed = 0
let platformTime = null
let platform
let controller
let dynamic
let kinematic
let triggerMover
let zeroScaleTick = null
let impulseBody
const joints = []
const intrinsicErrors = []
const failures = []
let recorderCalls = 0
let recorderNatives = 0
const record = (...args) => {
  recorderCalls++
  for (const value of args) if (value && typeof value === 'object' && 'ptr' in value) recorderNatives++
}
function shadow(v) {
  for (const name of ['toPxVec3', 'toPxExtVec3', 'toPxTransform', 'fromPxVec3', 'copy', 'set', 'clone'])
    v[name] = record
  return v
}
function bad(fn, message) {
  let error
  try {
    fn()
  } catch (err) {
    error = err
  }
  check(error && error.message === message, `expected ${message}; got ${error?.message}`)
  check(Object.getPrototypeOf(error) === Error.prototype, `non-intrinsic error: ${message}`)
  intrinsicErrors.push(message)
}
function contact(kind, begin, event) {
  try {
    if (event.tag !== 'boundary-floor') return
    counts[kind][begin ? 'begin' : 'end']++
    if (begin) {
      for (const point of event.contacts) {
        check(
          [...xyz(point.position), ...xyz(point.normal), ...xyz(point.impulse)].every(Number.isFinite),
          'finite contact'
        )
        counts[kind].points++
      }
    }
  } catch (err) {
    failures.push(String(err.message))
  }
}
function body(id, type, position, extra = {}) {
  const node = app.create('rigidbody', { id, type, position, ...extra })
  node.add(app.create('collider', { type: 'box', width: 0.5, height: 0.5, depth: 0.5 }))
  app.add(node)
  return node
}
app.add(
  app.create('prim', {
    id: 'floor',
    type: 'box',
    size: [20, 1, 20],
    position: [30, 1.5, 0],
    physics: 'static',
    tag: 'boundary-floor',
  })
)
const falling = app.create('prim', {
  id: 'falling',
  type: 'sphere',
  size: [0.5],
  position: [25, 6, 0],
  physics: 'dynamic',
  onContactStart: event => contact('prim', true, event),
  onContactEnd: event => contact('prim', false, event),
})
app.add(falling)
body('far', 'static', [0, 100, -150], { tag: 'boundary-far' })
if (!subset) {
  dynamic = body('dynamic', 'dynamic', [28, 6, 0], {
    onContactStart: event => contact('body', true, event),
    onContactEnd: event => contact('body', false, event),
  })
  kinematic = body('kinematic', 'kinematic', [35, 4, 0])
  platform = app.create('prim', {
    id: 'platform',
    type: 'box',
    size: [8, 0.5, 8],
    position: [0, 4, -15],
    physics: 'kinematic',
  })
  app.add(platform)
  const trigger = app.create('rigidbody', {
    type: 'static',
    position: [40, 5, 0],
    onTriggerEnter: e => {
      if (e.tag === 'trigger-mover') counts.enter++
    },
    onTriggerLeave: e => {
      if (e.tag === 'trigger-mover') counts.leave++
    },
  })
  trigger.add(app.create('collider', { type: 'box', width: 3, height: 3, depth: 3, trigger: true }))
  app.add(trigger)
  triggerMover = body('trigger-mover', 'kinematic', [45, 5, 0], { tag: 'trigger-mover' })
  controller = app.create('controller', { id: 'controller' })
  check(controller.isGrounded === false && controller.isCeiling === false, 'controller flags before move')
  controller.teleport(vector(50, 3, 0))
  check(same(xyz(controller.position), [50, 3, 0]), 'controller teleport before mount')
  app.add(controller)
  for (const [i, type] of ['fixed', 'socket', 'hinge', 'distance'].entries()) {
    const a = body(`${type}-a`, 'dynamic', [20 + i * 5, 14, -20])
    const b = body(`${type}-b`, 'dynamic', [21 + i * 5, 14, -20])
    const joint = app.create('joint', { id: `joint-${type}`, type, limitMin: 0.5, limitMax: 1.5 })
    bad(() => {
      joint.body0 = { _ref: { actor: { ptr: 1 } } }
    }, '[joint] body0 must be a rigidbody')
    bad(() => {
      joint.body1 = { _ref: { actor: { ptr: 1 } } }
    }, '[joint] body1 must be a rigidbody')
    joint.body0 = a
    joint.body1 = b
    joint.offset0.x = 0.5
    joint.offset1.x = -0.5
    app.add(joint)
    check(joint.body0 === a && joint.body1 === b, `${type} genuine proxies`)
    a.setLinearVelocity(vector(-2, 0, 0))
    b.setLinearVelocity(vector(2, 0, 0))
    joints.push({ type, a, b })
  }
}
const seat = !subset ? app.create('anchor', { id: 'seat', position: [5, 8, -15], rotation: [0, 0.7, 0] }) : null
if (seat) app.add(seat)

function query(make = vector) {
  const hit = world.raycast(make(0, 100, 0), make(0, 0, -1), subset ? 1000 : null)
  check(hit?.tag === 'boundary-far' && hit.distance > 100, 'far raycast hit (null means infinite)')
  if (subset) return { tag: hit.tag, distance: hit.distance }
  const overlaps = world.overlapSphere(1, make(0, 100, -150))
  check(
    overlaps.some(hit => hit.tag === 'boundary-far'),
    'overlapSphere returns tagged hit'
  )
  check(world.raycast(make(0, 100, 0), make(0, 0, -1), 0) === null, 'zero maxDistance allowed')
  return { tag: hit.tag, distance: hit.distance, overlaps: overlaps.length }
}
function inputs(playerId) {
  for (const value of [new Vector3(), new Object3D().position, new Quaternion(), new Matrix4()]) {
    for (const key of ['toPxVec3', 'toPxExtVec3', 'toPxTransform', 'fromPxVec3'])
      check(value[key] === undefined, `${key} removed`)
  }
  const unmounted = app.create('rigidbody', { type: 'dynamic' })
  check(unmounted.getQuaternion().w === 1, 'unmounted quaternion identity')
  for (const make of [vector, stock, (...args) => shadow(vector(...args)), (...args) => shadow(stock(...args))]) {
    const out = make()
    const q = shadow(new Quaternion())
    dynamic.setPosition(make(28, 6, 0))
    check(dynamic.getPosition(out) === out && same(xyz(out), [28, 6, 0]), 'position round trip')
    dynamic.setQuaternion(q)
    check(dynamic.getQuaternion(q) === q && q.w === 1, 'quaternion round trip')
    dynamic.setLinearVelocity(make(0, 0, 0))
    check(dynamic.getLinearVelocity(out) === out && same(xyz(out), [0, 0, 0]), 'linear velocity round trip')
    dynamic.setAngularVelocity(make(0, 0.5, 0))
    check(dynamic.getAngularVelocity(out) === out && near(out.y, 0.5), 'angular velocity returns vector')
    dynamic.setAngularVelocity(make())
    dynamic.addForce(make(), 'force')
    dynamic.addTorque(make(), 'impulse')
    dynamic.addForceAtPos(make(1, 0, 0), make(28, 6, 0), 'impulse')
    dynamic.addForceAtLocalPos(make(1, 0, 0), make(), 'impulse')
    check(dynamic.getVelocityAtPos(make(28, 6, 0), out) === out, 'velocity at position target')
    check(dynamic.getLocalVelocityAtLocalPos(make(), out) === out, 'local velocity target')
    check(
      dynamic.getVelocityAtPos(make()).isVector3 && dynamic.getLocalVelocityAtLocalPos(make()).isVector3,
      'default targets'
    )
    dynamic.setCenterOfMass(make())
    kinematic.setKinematicTarget(make(35, 4, 0), q)
    check(typeof dynamic.sleeping === 'boolean', 'sleeping readable')
    controller.teleport(make(50, 3, 0))
    controller.move(make(0.5, 0, 0))
    check(controller.position.x > 50.3, 'controller move with both brands')
    query(make)
  }
  dynamic.setLinearVelocity(vector())
  const spoof = { isVector3: true, x: 0, y: 0, z: 0, toPxVec3: record }
  const cases = [
    [() => dynamic.addForce(spoof), '[rigidbody] addForce force must be Vector3'],
    [() => dynamic.addForceAtPos(vector(), spoof), '[rigidbody] addForceAtPos pos must be Vector3'],
    [() => dynamic.addForceAtLocalPos(vector(), spoof), '[rigidbody] addForceAtLocalPos pos must be Vector3'],
    [() => dynamic.addTorque(spoof), '[rigidbody] addTorque torque must be Vector3'],
    [() => dynamic.setPosition(spoof), '[rigidbody] setPosition position must be Vector3'],
    [() => dynamic.setQuaternion({ isQuaternion: true }), '[rigidbody] setQuaternion quaternion must be Quaternion'],
    [() => dynamic.setLinearVelocity(spoof), '[rigidbody] setLinearVelocity velocity must be Vector3'],
    [() => dynamic.setAngularVelocity(spoof), '[rigidbody] setAngularVelocity velocity must be Vector3'],
    [() => dynamic.getVelocityAtPos(spoof), '[rigidbody] getVelocityAtPos pos must be Vector3'],
    [() => dynamic.getLocalVelocityAtLocalPos(spoof), '[rigidbody] getLocalVelocityAtLocalPos pos must be Vector3'],
    [() => dynamic.setCenterOfMass(spoof), '[rigidbody] setCenterOfMass pos must be Vector3'],
    [
      () => kinematic.setKinematicTarget(spoof, new Quaternion()),
      '[rigidbody] setKinematicTarget position must be Vector3',
    ],
    [() => controller.teleport(spoof), '[controller] teleport expected Vector3'],
    [() => controller.move(spoof), '[controller] move expected Vector3'],
    [() => world.raycast(spoof, vector(0, 0, -1)), '[raycast] origin must be Vector3'],
    [() => world.raycast(vector(), spoof), '[raycast] direction must be Vector3'],
    [() => world.overlapSphere(1, spoof), '[overlapSphere] origin must be Vector3'],
  ]
  for (const method of ['getPosition', 'getLinearVelocity', 'getAngularVelocity']) {
    cases.push([() => dynamic[method](spoof), `[rigidbody] ${method} target must be Vector3`])
  }
  cases.push([() => dynamic.getQuaternion(spoof), '[rigidbody] getQuaternion target must be Quaternion'])
  const player = world.getPlayer(playerId)
  check(player, 'player available for boundary probes')
  cases.push([() => player.teleport(spoof), '[player] teleport position must be Vector3'])
  cases.push([() => player.push(spoof), '[player] push force must be Vector3'])
  for (const [fn, message] of cases) bad(fn, message)
  for (const n of [NaN, Infinity, -Infinity, 1e39]) {
    const invalid = vector(n, 0, 0)
    const before = {
      p: xyz(dynamic.getPosition()),
      v: xyz(dynamic.getLinearVelocity()),
      a: xyz(dynamic.getAngularVelocity()),
      q: dynamic.getQuaternion().toArray(),
      c: xyz(controller.position),
    }
    for (const method of [
      'addForce',
      'addTorque',
      'setPosition',
      'setLinearVelocity',
      'setAngularVelocity',
      'setCenterOfMass',
    ])
      dynamic[method](invalid)
    dynamic.addForceAtPos(invalid, vector())
    dynamic.addForceAtPos(vector(1, 0, 0), invalid)
    dynamic.addForceAtLocalPos(invalid, vector())
    dynamic.addForceAtLocalPos(vector(1, 0, 0), invalid)
    dynamic.setQuaternion(new Quaternion(n, 0, 0, 1))
    kinematic.setKinematicTarget(invalid, new Quaternion())
    kinematic.setKinematicTarget(vector(), new Quaternion(n, 0, 0, 1))
    controller.teleport(invalid)
    controller.move(invalid)
    player.teleport(invalid)
    player.push(invalid)
    check(
      same(xyz(dynamic.getPosition()), before.p) && same(xyz(dynamic.getLinearVelocity()), before.v),
      'invalid input preserves pose and velocity'
    )
    check(
      same(xyz(dynamic.getAngularVelocity()), before.a) && same(dynamic.getQuaternion().toArray(), before.q),
      'invalid input preserves rotation'
    )
    check(same(xyz(controller.position), before.c), 'invalid controller no-op')
    for (const method of ['getVelocityAtPos', 'getLocalVelocityAtLocalPos']) {
      check(same(xyz(dynamic[method](invalid)), [0, 0, 0]), 'invalid velocity query default')
      check(same(xyz(dynamic[method](invalid, stock(1, 2, 3))), [0, 0, 0]), 'invalid velocity query target')
    }
    check(world.raycast(invalid, vector(0, 0, -1)) === null, 'invalid ray origin')
    check(world.raycast(vector(), invalid) === null, 'invalid ray direction')
    check(world.overlapSphere(1, invalid).length === 0, 'invalid overlap origin')
  }
  for (const max of [-1, NaN, '1'])
    bad(() => world.raycast(vector(), vector(0, 0, -1), max), '[raycast] maxDistance must be number')
  for (const mask of [NaN, Infinity, 0.5, 4294967296]) {
    bad(() => world.raycast(vector(), vector(0, 0, -1), 1, mask), '[raycast] layerMask must be number')
    bad(() => world.overlapSphere(1, vector(), mask), '[overlapSphere] layerMask must be number')
  }
  for (const radius of [0, -1, NaN, Infinity, 1e39])
    bad(() => world.overlapSphere(radius, vector()), '[overlapSphere] radius must be a positive number')
  check(recorderCalls === 0 && recorderNatives === 0, 'shadowed own methods never called')
  return { brands: 4, recorderCalls, recorderNatives, intrinsicErrors: [...intrinsicErrors] }
}
const commands = {
  status() {
    check(failures.length === 0, failures.join('; '))
    return {
      ticks,
      elapsed,
      counts,
      falling: xyz(falling.position),
      dynamic: dynamic ? xyz(dynamic.position) : null,
      controller: controller ? xyz(controller.position) : null,
      controllerWorld: controller ? controller.matrixWorld.toArray().slice(12, 15) : null,
      kinematic: kinematic ? xyz(kinematic.position) : null,
      platform: platform ? xyz(platform.position) : null,
      platformYaw: platform?.rotation.y,
      zeroScaleTick,
      impulseVelocity: impulseBody ? xyz(impulseBody.getLinearVelocity()) : null,
      joints: joints.map(({ type, a, b }) => ({ type, distance: a.getPosition().distanceTo(b.getPosition()) })),
    }
  },
  query: () => query(),
  impulse: ({ local }) => {
    impulseBody ??= body('impulse', 'dynamic', [55, 15, -20])
    impulseBody.setLinearVelocity(vector())
    if (local) impulseBody.addForceAtLocalPos(shadow(stock(1, 0, 0)), shadow(stock()), 'impulse')
    else
      impulseBody.addForceAtPos(shadow(vector(1, 0, 0)), shadow(vector(...xyz(impulseBody.getPosition()))), 'impulse')
    return { ticks }
  },
  inputs: ({ playerId }) => inputs(playerId),
  lift() {
    falling.position.set(25, 7, 0)
    if (dynamic) {
      dynamic.setPosition(vector(28, 7, 0))
      dynamic.setLinearVelocity(vector())
    }
  },
  trigger: ({ inside }) => {
    triggerMover.position.x = inside ? 40 : 45
  },
  platform: ({ moving }) => {
    platformTime = moving ? elapsed : null
  },
  teleport: ({ playerId, position, stockVector }) => {
    world.getPlayer(playerId).teleport(shadow((stockVector ? stock : vector)(...position)), new Quaternion())
    check(recorderCalls === 0, 'player teleport bypasses own methods')
  },
  push: ({ playerId, stockVector }) => {
    world.getPlayer(playerId).push(shadow((stockVector ? stock : vector)(0, 0, -5)))
    check(recorderCalls === 0, 'player push bypasses own methods')
  },
  anchor: ({ playerId }) => {
    world.getPlayer(playerId).applyEffect({ anchor: seat, duration: 2 })
  },
  zeroScale() {
    let geometry
    app.traverse(node => {
      if (!geometry && node.name === 'mesh') geometry = node.geometry
    })
    check(geometry, 'model geometry fixture available')
    const node = app.create('rigidbody', { type: 'static', position: [60, 3, 0] })
    const collider = app.create('collider', { type: 'geometry', geometry, scale: [0, 1, 1] })
    check(collider.scale.x === 0, 'genuine constructor zero geometry scale')
    node.add(collider)
    app.add(node)
    zeroScaleTick = ticks
    return { zeroScaleTick }
  },
}
app.state = { ready: true }
app.on('probe:command', request => {
  let result
  try {
    check(typeof commands[request.command] === 'function', 'unknown physics command')
    result = { seq: request.seq, ok: true, value: commands[request.command](request) ?? null }
  } catch (err) {
    result = { seq: request.seq, ok: false, error: String(err.message) }
  }
  app.state.last = result
  if (world.isServer) app.send('report', result)
})
app.on('update', delta => {
  ticks++
  elapsed += delta
  if (platformTime !== null) {
    const t = elapsed - platformTime
    platform.position.x = t * 0.4
    platform.rotation.y = t * 0.25
  }
})
