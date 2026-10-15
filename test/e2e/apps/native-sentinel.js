// Test-only instrumentation of the currently mutable THREE prototypes. Never inspect components here.
const prototypes = [
  ['Vector3', Vector3.prototype],
  ['StockVector3', Object.getPrototypeOf(new Object3D().position)],
  ['Quaternion', Quaternion.prototype],
  ['Euler', Euler.prototype],
  ['Matrix4', Matrix4.prototype],
]
const saved = []
let armed = false
let total = 0
let methods = {}
let selfTest = null
const check = (value, message) => {
  if (!value) throw new Error(message)
}
const inspect = (value, method, slot) => {
  try {
    if (value !== null && typeof value === 'object' && 'ptr' in value) {
      total++
      const key = `${method}:${slot}`
      methods[key] = (methods[key] || 0) + 1
    }
  } catch {
    // A hostile Proxy's has trap must not change the original method's behavior.
  }
}
const wrap = (fn, method) =>
  function (...args) {
    inspect(this, method, 'this')
    for (const arg of args) inspect(arg, method, 'argument')
    const result = Reflect.apply(fn, this, args)
    inspect(result, method, 'return')
    return result
  }
function arm() {
  check(!armed, 'sentinel already armed')
  total = 0
  methods = {}
  armed = true
  try {
    for (const [name, proto] of prototypes) {
      for (const key of Reflect.ownKeys(proto)) {
        if (key === 'constructor') continue
        const original = Object.getOwnPropertyDescriptor(proto, key)
        const replacement = { ...original }
        const label = `${name}.${String(key)}`
        if (typeof original.value === 'function') replacement.value = wrap(original.value, label)
        if (original.get) replacement.get = wrap(original.get, `${label}.get`)
        if (original.set) replacement.set = wrap(original.set, `${label}.set`)
        saved.push({ proto, key, original })
        Object.defineProperty(proto, key, replacement)
      }
    }
  } catch (err) {
    disarm()
    throw err
  }
}
function disarm() {
  let failure
  try {
    for (const { proto, key, original } of saved) {
      try {
        Object.defineProperty(proto, key, original)
        const restored = Object.getOwnPropertyDescriptor(proto, key)
        for (const field of Reflect.ownKeys(original)) {
          check(restored[field] === original[field], `descriptor not restored: ${String(key)}.${field}`)
        }
      } catch (err) {
        failure ??= err
      }
    }
  } finally {
    saved.length = 0
    armed = false
  }
  if (failure) throw failure
}
function behavior() {
  let changes = 0
  const v = new Vector3()
  v._onChange(() => changes++)
  const chaining = v.set(1, 2, 3) === v && v.copy(new Vector3(4, 5, 6)) === v
  v.x = 7
  const stock = new Object3D().position.set(1, 2, 3)
  const q = new Quaternion().set(0, 0, 0, 1)
  q.x = 0.25
  const e = new Euler()
  e.y = 0.5
  return JSON.stringify({
    chaining,
    changes,
    components: [v.x, v.y, v.z],
    iteration: [...v],
    stock: [...stock],
    quaternion: [...q],
    euler: [...e],
    matrix: new Matrix4().identity().toArray(),
  })
}
function start() {
  const before = behavior()
  try {
    arm()
    const v = new Vector3().copy({ ptr: 1, x: 0, y: 0, z: 0 })
    check(total === 1, `sentinel copy self-test: expected 1, got ${total}`)
    check(v.x === 0 && v.y === 0 && v.z === 0, 'sentinel changed copy result')
    check(behavior() === before, 'sentinel changed chaining/accessors/iteration/callbacks')
    selfTest = { violations: total, behavior: JSON.parse(before), descriptors: saved.length }
  } finally {
    disarm()
  }
  // Start a fresh count after the positive self-test, before any scenario.
  arm()
}
app.state = { ready: true }
app.on('probe:command', ({ seq, command }) => {
  let result
  try {
    if (command === 'arm') start()
    if (command === 'disarm') disarm()
    result = { seq, ok: true, armed, total, methods: { ...methods }, selfTest }
  } catch (err) {
    try {
      disarm()
    } finally {
      result = { seq, ok: false, error: String(err.message) }
    }
  }
  app.state.last = result
  if (world.isServer) app.send('report', result)
})
app.on('destroy', disarm)
