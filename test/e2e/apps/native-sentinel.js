// Test-only. The instrumentation itself lives on the host side (test/e2e/lib/script-class-hook.js): the engine
// freezes the math classes before any script runs, so a script cannot wrap their methods. The hook, installed
// by the e2e harness before the engine starts, wraps them while that is still possible and leaves a test
// method on Vector3 (`__e2eSentinel`) that this app drives. Never inspect components here.
let selfTest = null
const check = (value, message) => {
  if (!value) throw new Error(message)
}
const sentinel = command => {
  const probe = new Vector3()
  check(typeof probe.__e2eSentinel === 'function', 'sentinel hook not installed in this realm')
  return JSON.parse(probe.__e2eSentinel(command))
}
function behavior() {
  let changes = 0
  const v = new Vector3()
  v._onChange(() => changes++)
  const chaining = v.set(1, 2, 3) === v && v.copy(new Vector3(4, 5, 6)) === v
  v.x = 7
  // THREE's own Vector3 class, as the interpolation classes use it
  const StockVector3 = new LerpVector3(new Vector3(), 0.2).previous.constructor
  const stock = new StockVector3(1, 2, 3)
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
    sentinel('arm')
    const v = new Vector3().copy({ ptr: 1, x: 0, y: 0, z: 0 })
    const { total, descriptors } = sentinel('report')
    check(total === 1, `sentinel copy self-test: expected 1, got ${total}`)
    check(v.x === 0 && v.y === 0 && v.z === 0, 'sentinel changed copy result')
    check(behavior() === before, 'sentinel changed chaining/accessors/iteration/callbacks')
    selfTest = { violations: total, behavior: JSON.parse(before), descriptors }
  } finally {
    sentinel('disarm')
  }
  // Start a fresh count after the positive self-test, before any scenario.
  sentinel('arm')
}
app.state = { ready: true }
app.on('probe:command', ({ seq, command }) => {
  let result
  try {
    if (command === 'arm') start()
    const { armed, total, methods } = sentinel(command === 'disarm' ? 'disarm' : 'report')
    result = { seq, ok: true, armed, total, methods, selfTest }
  } catch (err) {
    try {
      sentinel('disarm')
    } catch {
      // the hook is missing: the error below already says so
    }
    result = { seq, ok: false, error: String(err.message) }
  }
  app.state.last = result
  if (world.isServer) app.send('report', result)
})
app.on('destroy', () => {
  try {
    sentinel('disarm')
  } catch {
    // nothing to disarm
  }
})
