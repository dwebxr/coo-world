// Test-only instrumentation of the math classes app scripts can reach. No imports or exports: the same file is
// preloaded into the server (`node --import`) and injected into a page before the client bundle runs
// (addInitScript).
//
// The engine freezes these classes when it starts (scriptHardening.js), so a test app can no longer patch
// them from a script. It calls globalThis.__scriptClassTestHook, if a test set one, while the classes can
// still be changed. This hook wraps every method and setter to count PhysX natives (objects with a `ptr`)
// that reach THREE math, and leaves test-only methods on Vector3 for the e2e apps:
//   __e2eSentinel(command)   'arm' | 'disarm' | 'report' -> JSON string of the sentinel state
//   __e2eStock(x, y, z)      a THREE Vector3 of the stock class, which scripts otherwise cannot construct
//   __e2eComposeFault(on)    while on, Matrix4.compose throws for a position with x > 900 (a host-owned node
//                            that keeps failing, for the Stage retry cap)
// The sentinel wrappers cost an argument array per math call, so on the server they are installed only when
// E2E_NATIVE_SENTINEL=1 (physics-boundary.mjs sets it); a page that injects this file always gets them.
;(() => {
  const state = { armed: false, total: 0, methods: {}, descriptors: 0 }
  let composeFault = false
  const sentinel = typeof process === 'undefined' || process.env.E2E_NATIVE_SENTINEL === '1'
  const inspect = (value, method, slot) => {
    try {
      if (value !== null && typeof value === 'object' && 'ptr' in value) {
        state.total++
        const key = `${method}:${slot}`
        state.methods[key] = (state.methods[key] || 0) + 1
      }
    } catch {
      // A hostile Proxy's has trap must not change the original method's behavior.
    }
  }
  const wrap = (fn, method) =>
    function (...args) {
      if (!state.armed) return Reflect.apply(fn, this, args)
      inspect(this, method, 'this')
      for (const arg of args) inspect(arg, method, 'argument')
      const result = Reflect.apply(fn, this, args)
      inspect(result, method, 'return')
      return result
    }
  const report = () => JSON.stringify({ ...state, methods: { ...state.methods } })
  globalThis.__scriptClassTestHook = classes => {
    const byName = Object.fromEntries(classes)
    for (const [name, cls] of sentinel ? classes : []) {
      const proto = cls.prototype
      for (const key of Reflect.ownKeys(proto)) {
        if (key === 'constructor') continue
        const original = Object.getOwnPropertyDescriptor(proto, key)
        const replacement = { ...original }
        const label = `${name}.${String(key)}`
        if (typeof original.value === 'function') replacement.value = wrap(original.value, label)
        // getters are left alone: their receiver is the THREE instance and they return numbers, so they cannot
        // carry a native, and wrapping every component read made software-rendered CI browsers too slow
        else if (original.set) replacement.set = wrap(original.set, `${label}.set`)
        else continue
        Object.defineProperty(proto, key, replacement)
        state.descriptors++
      }
    }
    const define = (key, value) =>
      Object.defineProperty(byName.Vector3.prototype, key, {
        value,
        writable: true,
        enumerable: false,
        configurable: true,
      })
    define('__e2eSentinel', function (command) {
      if (!sentinel) throw new Error('sentinel wrappers are not installed in this realm')
      if (command === 'arm') {
        if (state.armed) throw new Error('sentinel already armed')
        state.total = 0
        state.methods = {}
        state.armed = true
      } else if (command === 'disarm') {
        state.armed = false
      } else if (command !== 'report') {
        throw new Error('unknown sentinel command')
      }
      return report()
    })
    const compose = byName.Matrix4.prototype.compose
    byName.Matrix4.prototype.compose = function (position, quaternion, scale) {
      if (composeFault && position && position.x > 900) throw new Error('P1_RETRY_PROBE')
      return Reflect.apply(compose, this, [position, quaternion, scale])
    }
    define('__e2eComposeFault', function (on) {
      composeFault = on === true
    })
    const Stock = byName.StockVector3
    define('__e2eStock', function (x = 0, y = 0, z = 0) {
      return new Stock(x, y, z)
    })
  }
})()
