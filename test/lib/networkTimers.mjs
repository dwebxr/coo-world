// The timers of ServerNetwork.js in the bundle network.mjs makes: its own calls of setTimeout, clearTimeout,
// setInterval and clearInterval come here (serverBundle.mjs `prepend`), and go to the object makeNetwork's `timers`
// gave for the test that holds the helper, where that object has the name, and to the global function otherwise,
// read at the call (so node:test's mock timers apply too). The rest of the bundle calls the globals.
// One table for the process: every bundle's copy of this module reads it, as the stand-ins read theirs.
const table = (globalThis[Symbol.for('test/lib/network.mjs: timers')] ??= { current: null })
const timer = name => {
  const given = table.current
  return given && name in given ? given[name] : globalThis[name]
}

export const setTimeout = (...args) => timer('setTimeout')(...args)
export const clearTimeout = (...args) => timer('clearTimeout')(...args)
export const setInterval = (...args) => timer('setInterval')(...args)
export const clearInterval = (...args) => timer('clearInterval')(...args)
