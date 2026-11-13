// The timers of ServerNetwork.js in the bundle network.mjs makes, and of the network's modules its members moved to
// with a timer call (network.mjs TIMED_FILES: tips.js, persistence.js): their own calls of setTimeout, clearTimeout,
// setInterval and clearInterval come here (serverBundle.mjs `prepend`), and go to the object makeNetwork's `timers`
// gave for the test that holds the helper, where that object has the name, and to the global function otherwise,
// read at the call (so node:test's mock timers apply too). The rest of the bundle calls the globals.
// One table for the process: every bundle's copy of this module reads it, as the stand-ins read theirs.
const table = (globalThis[Symbol.for('test/lib/network.mjs: timers')] ??= { current: null })
// who made a timer: the object given when the class set it (null: the global function). A test may give one object
// for each of two networks; the table then holds the second, and the first network's timers are still the first's.
const made = (table.made ??= new WeakMap())
const isKey = handle => (typeof handle === 'object' && handle !== null) || typeof handle === 'function'
const set =
  name =>
  (...args) => {
    const given = table.current
    const own = !!given && name in given
    const handle = (own ? given[name] : globalThis[name])(...args)
    if (isKey(handle)) made.set(handle, own ? given : null)
    return handle
  }
// (a handle no call here made, or one that is not an object, a number say: the object in the table now)
const clear = name => handle => {
  const maker = isKey(handle) && made.has(handle) ? made.get(handle) : table.current
  return (maker && name in maker ? maker[name] : globalThis[name])(handle)
}

export const setTimeout = set('setTimeout')
export const clearTimeout = clear('clearTimeout')
export const setInterval = set('setInterval')
export const clearInterval = clear('clearInterval')
