export function createEntityProxy(entity, { getters, setters, methods, fallbackGet, fallbackSet }) {
  return new Proxy(
    {},
    {
      get: (target, prop) => {
        // getters
        if (prop in getters) {
          return getters[prop](entity)
        }
        // methods
        if (prop in methods) {
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
        if (prop in setters) {
          setters[prop](entity, value)
          return true
        }
        if (fallbackSet) return fallbackSet(prop, value)
        return true
      },
    }
  )
}
