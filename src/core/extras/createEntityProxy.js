const has = Object.prototype.hasOwnProperty

// the tables are plain objects, so lookups must be own-property checks:
// inherited Object.prototype keys never resolve to a table entry
export function createEntityProxy(entity, { getters, setters, methods, fallbackGet, fallbackSet }) {
  return new Proxy(
    {},
    {
      get: (target, prop) => {
        // getters
        if (has.call(getters, prop)) {
          return getters[prop](entity)
        }
        // methods
        if (has.call(methods, prop)) {
          const method = methods[prop]
          return (...args) => {
            return method(entity, ...args)
          }
        }
        if (fallbackGet) return fallbackGet(prop)
        return undefined
      },
      set: (target, prop, value) => {
        // setters
        if (has.call(setters, prop)) {
          setters[prop](entity, value)
          return true
        }
        if (fallbackSet) return fallbackSet(prop, value)
        return true
      },
    }
  )
}
