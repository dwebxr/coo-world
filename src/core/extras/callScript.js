// Invokes script-supplied callbacks from host code.
//
// `callScript` runs a callback with no receiver and only the arguments given. `callEntry` runs
// a callback stored on a script-visible plain object (a control button entry) with that object
// as receiver. Both contain errors so a throwing callback cannot abort host processing, and both
// invoke through Reflect.apply: never through a `call`/`apply` looked up on the function, which a
// script can replace (on its own function, or on a shared one).

export function callScript(fn, ...args) {
  if (typeof fn !== 'function') return undefined
  try {
    return Reflect.apply(fn, undefined, args)
  } catch (err) {
    console.error(err)
  }
}

export function callEntry(entry, name) {
  const fn = entry[name]
  if (typeof fn !== 'function') return undefined
  try {
    return Reflect.apply(fn, entry, [])
  } catch (err) {
    console.error(err)
  }
}
