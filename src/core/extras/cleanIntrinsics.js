// Runs just before SES lockdown (src/core/lockdown.js).
//
// Some browsers add their own properties to built-in functions before the page runs. iPhone Brave puts an
// undeletable `call` on Function.prototype.apply. Lockdown removes every property it does not know, and an
// undeletable one stops it ("Unable to delete property"), so the world never starts.
//
// Tolerating the property would leave the browser's own function reachable from app scripts (other
// builders' code). Instead, the affected method is replaced on Function.prototype with a clean equivalent.
// The browser keeps using the copy it captured; pages, the engine and app scripts get the clean one, and
// lockdown hardens it like any other intrinsic. Nothing changes where no such property exists.

const EXPECTED = new Set(['length', 'name'])

// method shorthand: no own `prototype`; lengths and names match the built-ins (apply 2, call 1)
const CLEAN = {
  apply(thisArg, args) {
    return Reflect.apply(this, thisArg, args === undefined || args === null ? [] : args)
  },
  call(thisArg, ...args) {
    return Reflect.apply(this, thisArg, args)
  },
}

// the own properties of `fn` that lockdown would try to remove and cannot
function undeletable(fn) {
  return Reflect.ownKeys(fn).filter(key => {
    if (EXPECTED.has(key)) return false
    const descriptor = Reflect.getOwnPropertyDescriptor(fn, key)
    return !!descriptor && !descriptor.configurable
  })
}

// Returns what was replaced, eg ['apply (call)']; reports it once through `report`.
export function cleanFunctionPrototype(report = message => console.warn(message)) {
  const replaced = []
  for (const name of ['apply', 'call']) {
    const method = Function.prototype[name]
    if (typeof method !== 'function') continue
    const extra = undeletable(method)
    if (!extra.length) continue
    const descriptor = Reflect.getOwnPropertyDescriptor(Function.prototype, name)
    // a method the browser also locked in place cannot be swapped; lockdown will then report it
    if (!descriptor || (!descriptor.configurable && !descriptor.writable)) continue
    const done = descriptor.configurable
      ? Reflect.defineProperty(Function.prototype, name, { ...descriptor, value: CLEAN[name] })
      : Reflect.set(Function.prototype, name, CLEAN[name])
    if (done && Function.prototype[name] === CLEAN[name]) replaced.push(`${name} (${extra.map(String).join(', ')})`)
  }
  if (replaced.length) {
    report(
      `[lockdown] replaced Function.prototype methods that carried undeletable browser additions: ${replaced.join('; ')}`
    )
  }
  return replaced
}
