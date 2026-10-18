// Script-only regressions: the same commands run in the server and browser SES compartments.
const check = (value, message) => {
  if (!value) throw new Error(message)
}
const vector = (x = 0, y = 0, z = 0) => new Vector3(x, y, z)
const failures = []
const capture = fn => event => {
  try {
    fn(event)
  } catch (err) {
    if (failures.length < 8) failures.push(String(err.message))
  }
}
let ticks = 0
let steps = 0
let elapsed = 0
let mutation
const removals = []
let hammer

function body(id, type, position, extra = {}, trigger = false) {
  const node = app.create('rigidbody', { id, tag: id, type, position, ...extra })
  node.add(app.create('collider', { type: 'box', width: 2, height: 2, depth: 2, trigger }))
  app.add(node)
  return node
}

function mutateContacts() {
  check(!mutation, 'contact mutation already started')
  const state = { begin: 0, end: 0, observed: 0, target: 128, done: false }
  mutation = state
  state.fixed = body('mutation-fixed', 'static', [-80, 20, 0], {
    onContactStart: capture(event => {
      if (event.tag !== 'mutation-mover') return
      check(event.contacts.length > 0, 'mutation receives contact points')
      check(Number.isFinite(event.contacts[0].position.x), 'fresh contact position before mutation')
      state.begin++
      event.contacts[0].position = {}
      if (!state.retained) {
        state.retained = event
        state.snapshot = JSON.stringify(event)
      }
    }),
    onContactEnd: capture(event => {
      if (event.tag !== 'mutation-mover') return
      check(event.contacts.length === 0, 'contact end has no points')
      state.end++
    }),
  })
  state.mover = body('mutation-mover', 'dynamic', [-70, 20, 0], {
    onContactStart: capture(event => {
      if (event.tag !== 'mutation-fixed') return
      check(event.contacts.length > 0, 'other recipient receives contact points')
      check(
        event.contacts.every(point =>
          [point.position, point.normal, point.impulse].every(v => [v.x, v.y, v.z].every(Number.isFinite))
        ),
        'other recipient retains finite vectors'
      )
      state.observed++
      if (!state.other) {
        state.other = event
        state.otherSnapshot = JSON.stringify(event)
      }
    }),
  })
}

function removeAgain() {
  check(removals.length === 0, 'removal already started')
  for (const kind of ['rigidbody', 'prim', 'controller']) {
    for (const trigger of [false, true]) {
      const id = `removal-${kind}-${trigger ? 'trigger' : 'contact'}`
      const x = -110 - removals.length * 10
      const state = { kind, trigger, entered: 0, left: 0, removed: false, removing: false, done: false }
      removals.push(state)
      if (kind === 'rigidbody') state.a = body(id, 'static', [x, 20, 0])
      else {
        state.a = app.create(kind, {
          id,
          tag: id,
          position: [x, 20, 0],
          ...(kind === 'prim' ? { type: 'box', size: [2, 2, 2], physics: 'static' } : { radius: 0.4, height: 1 }),
        })
        app.add(state.a)
      }
      // This sibling used to be spliced out by nested Node.remove calls.
      state.sibling = app.create('group', { id: `${id}-sibling` })
      app.add(state.sibling)
      state.b = body(
        `${id}-b`,
        'dynamic',
        [x + (kind === 'controller' ? 1 : 1.5), 20, 0],
        {
          [trigger ? 'onTriggerEnter' : 'onContactStart']: capture(event => {
            if (event.tag === id) state.entered++
          }),
          [trigger ? 'onTriggerLeave' : 'onContactEnd']: capture(event => {
            if (event.tag !== id) return
            state.left++
            const duringRemoval = state.removing
            if (state.left === 1) app.remove(state.a)
            check(!duringRemoval && state.removed, `${id}: callback waits for removal to finish`)
            check(state.left === 1, `${id}: exactly one end/leave`)
            if (trigger) check(event.isLocalPlayer === false, `${id}: synthetic leave metadata`)
            else check(event.contacts.length === 0, `${id}: synthetic end has no points`)
            check(!state.a.parent, `${id}: removed parent cleared`)
            check(app.get(state.sibling.id) === state.sibling, `${id}: sibling preserved`)
            check(state.sibling.parent === state.b.parent, `${id}: sibling parent preserved`)
            state.leftAt = steps
          }),
        },
        trigger
      )
    }
  }
}

function hammerStatic() {
  check(!hammer, 'static hammer already started')
  const node = body('static-hammer', 'static', [-190, 20, 0])
  const pos = vector(-190, 20, 0)
  const force = vector(1, 2, 3)
  const out = vector()
  const calls = {}
  const errors = []
  for (const method of ['getVelocityAtPos', 'getLocalVelocityAtLocalPos', 'addForceAtPos', 'addForceAtLocalPos']) {
    calls[method] = 0
    for (let i = 0; i < 2000; i++) {
      calls[method]++
      try {
        if (method.startsWith('get')) {
          out.set(1, 2, 3)
          check(node[method](pos, out) === out, `${method}: returns output target`)
          check(out.x === 0 && out.y === 0 && out.z === 0, `${method}: static velocity is zero`)
        } else node[method](force, pos, 'impulse')
      } catch (err) {
        if (errors.length < 8) errors.push(`${method}: ${err.name}: ${err.message}`)
      }
    }
  }
  check(errors.length === 0, errors.join('; '))
  check(node.getPosition().distanceTo(pos) < 1e-5, 'static forces do not move the body')
  // Positive dimensions can still form an invalid capsule descriptor with the fixed step offset.
  const controller = app.create('controller', { radius: 0.01, height: 0.01, position: [-195, 20, 0] })
  app.add(controller)
  controller.teleport(vector(-195, 21, 0))
  controller.move(vector(1, 0, 0))
  check(
    controller.position.distanceTo(vector(-195, 21, 0)) < 1e-5,
    'disabled controller keeps teleport but ignores move'
  )
  app.remove(controller)
  hammer = { calls, errors, position: node.getPosition().toArray(), invalidController: true }
  return hammer
}

const commands = {
  mutateContacts,
  removeAgain,
  hammerStatic,
  status() {
    check(failures.length === 0, failures.join('; '))
    if (mutation?.retained) {
      check(JSON.stringify(mutation.retained) === mutation.snapshot, 'mutated event is never reused or cleared')
      check(JSON.stringify(mutation.other) === mutation.otherSnapshot, 'other recipient event remains independent')
    }
    return {
      ticks,
      steps,
      elapsed,
      mutation: mutation && {
        begin: mutation.begin,
        end: mutation.end,
        observed: mutation.observed,
        target: mutation.target,
        done: mutation.done,
      },
      removals: removals.map(({ kind, trigger, entered, left, removed, done }) => ({
        kind,
        trigger,
        entered,
        left,
        removed,
        done,
      })),
      hammer,
    }
  },
}
app.state = { ready: true }
app.on('probe:command', request => {
  let result
  try {
    check(typeof commands[request.command] === 'function', 'unknown availability command')
    result = { seq: request.seq, ok: true, value: commands[request.command](request) ?? null }
  } catch (err) {
    result = { seq: request.seq, ok: false, error: String(err.message) }
  }
  app.state.last = result
  if (world.isServer) app.send('report', result)
})
app.on(
  'fixedUpdate',
  capture(() => {
    steps++
    if (mutation && !mutation.done) {
      if (mutation.end === mutation.target) {
        check(
          mutation.begin === mutation.target && mutation.observed === mutation.target,
          'all contact cycles delivered'
        )
        mutation.done = true
        app.remove(mutation.mover)
        app.remove(mutation.fixed)
      } else {
        mutation.mover.setPosition(vector(mutation.begin === mutation.end ? -78.5 : -70, 20, 0))
        mutation.mover.setLinearVelocity(vector())
        mutation.mover.setAngularVelocity(vector())
      }
    }
    for (const state of removals) {
      if (state.entered && !state.removed) {
        state.removing = true
        app.remove(state.a)
        state.removing = false
        check(state.left === 0, 'end/leave was not synchronous')
        state.removed = true
      }
      if (state.left && !state.done && steps > state.leftAt + 5) {
        app.remove(state.b)
        check(app.get(state.sibling.id) === state.sibling, 'sibling survives both removals')
        state.done = true
      }
    }
  })
)
app.on('update', delta => {
  ticks++
  elapsed += delta
})
