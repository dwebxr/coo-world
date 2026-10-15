// e2e probe (server): console arguments must never put a host function into script hands.
// Node's util.inspect would call a value's custom inspect hook with the host `inspect`; a script could
// use it as a channel to other scripts (inspect.stash) or change process-wide logging options.
const TAG = props.tag || 'P1_CONSOLE'
const hook = Symbol.for('nodejs.util.inspect.custom')
const seen = { called: false, gotFunction: false, stash: 'unset', optionsType: 'unset' }
const value = {
  marker: TAG,
  [hook](depth, options, inspect) {
    seen.called = true
    seen.gotFunction = typeof inspect === 'function'
    if (seen.gotFunction) {
      seen.stash = typeof inspect.stash === 'undefined' ? 'undefined' : String(inspect.stash)
      try {
        inspect.stash = TAG
        inspect.defaultOptions = { depth: 0 }
      } catch (err) {
        seen.writeError = err.name
      }
    }
    seen.optionsType = typeof options
    return 'custom output'
  },
}
console.log('console probe', value, [value], { value })
console.error(value)
console.warn('%o', value)
world.chat({ id: uuid(), body: TAG + ' ' + JSON.stringify(seen) }, true)
