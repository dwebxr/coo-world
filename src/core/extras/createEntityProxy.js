import { callForScript } from './scriptValues.js'
import { stoppedError } from './physicsFailure.js'

const has = Object.prototype.hasOwnProperty

// the tables are plain objects, so lookups must be own-property checks:
// inherited Object.prototype keys never resolve to a table entry.
// `run` is the app run (its dead hook) the proxy was made for: once the app has started another run, or was
// unbuilt for good, every read, write and call through this proxy throws, so a continuation of an old run cannot
// act on the new one (the run's own destroy event still runs before the hook is replaced)
export function createEntityProxy(
  entity,
  { getters, setters, methods, fallbackGet, fallbackSet, destroyMethods = [], run = null }
) {
  const assertRun = () => {
    if (run && run !== entity.deadHook) throw stoppedError(entity)
  }
  return new Proxy(
    {},
    {
      get: (target, prop) => {
        assertRun()
        // getters
        if (has.call(getters, prop)) {
          return callForScript(getters[prop], entity, [entity], true)
        }
        // methods
        if (has.call(methods, prop)) {
          const method = methods[prop]
          return (...args) => {
            assertRun()
            return callForScript(method, entity, [entity, ...args], destroyMethods.includes(prop))
          }
        }
        if (fallbackGet) return fallbackGet(prop)
        return undefined
      },
      set: (target, prop, value) => {
        assertRun()
        // setters
        if (has.call(setters, prop)) {
          callForScript(setters[prop], entity, [entity, value])
          return true
        }
        if (fallbackSet) return fallbackSet(prop, value)
        return true
      },
    }
  )
}
