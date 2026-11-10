// Preparation of host classes that app scripts can reach, before they are frozen (see scriptHardening.js).
//
// Freezing a prototype makes its data properties read-only, and JavaScript then also refuses an assignment of
// the same name on any object that inherits from it ("override mistake"): a strict-mode TypeError. The math
// classes depend on such assignments:
//   - Quaternion, Euler and our Vector3 implement `_onChange(cb)` as `this._onChangeCallback = cb`, over a
//     method of that name on the prototype (every Object3D and every Node calls it while it is constructed)
//   - three's Vector3, Matrix3 and Matrix4 constructors run `X.prototype.isX = true` on every construction
//
// So each own data property of a prototype is first replaced by an accessor pair, as SES does for the
// intrinsics (its "override taming"):
//   - the getter returns the original value
//   - the setter, called for an instance, defines an own writable property on that instance, which is what the
//     assignment did before the prototype was frozen
//   - the setter, called for the prototype itself, ignores a write of the identical value and refuses any
//     other: the prototype can no longer be changed through it
//
// Accessor properties that already exist (x/y/z and friends) are left as they are; freezing makes them
// non-configurable.

// Returns the original values. They stay reachable through the getters, so the caller has to freeze them as
// well: a method is an object, and a script that could put a property on it (say its own `call`) would again
// reach every other user of that method.
export function makeOverridable(proto) {
  const values = []
  for (const key of Reflect.ownKeys(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, key)
    // accessors need nothing; a non-configurable data property cannot be converted and is already fixed
    if (!('value' in desc) || !desc.configurable) continue
    const value = desc.value
    values.push(value)
    Object.defineProperty(proto, key, {
      get() {
        return value
      },
      set(next) {
        if (this === proto) {
          if (Object.is(next, value)) return
          throw new TypeError(`Cannot assign to read only property '${String(key)}' of a script class prototype`)
        }
        // primitives, frozen and sealed receivers fail here with the engine's own TypeError
        Object.defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true })
      },
      enumerable: desc.enumerable,
      configurable: false,
    })
  }
  return values
}

// every object on the class's prototype chain that it owns: stops at Object.prototype and at anything already
// frozen (the shared intrinsics after lockdown, or a base class prepared earlier)
export function ownedPrototypes(cls) {
  const list = []
  let proto = cls.prototype
  while (proto && proto !== Object.prototype && !Object.isFrozen(proto)) {
    list.push(proto)
    proto = Object.getPrototypeOf(proto)
  }
  return list
}
