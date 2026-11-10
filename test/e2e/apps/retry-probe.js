// e2e probe (server): makes matrix composition fail for any node positioned beyond x > 900 for a few
// seconds. The harness moves a connected player there, so a node the host owns (not an app) keeps failing
// and the retry cap must give up on it once and recover when the fault is lifted.
// A script cannot patch the shared THREE classes (they are frozen), so the fault is switched on the host side
// through the e2e hook the harness preloads into the server (test/e2e/lib/script-class-hook.js).
const TAG = 'P1_RETRY'
const report = data => world.chat({ id: uuid(), body: TAG + ' ' + JSON.stringify(data) }, true)
let armed = false
app.on('update', () => {
  if (armed || !world.isServer) return
  armed = true
  const control = new Vector3()
  control.__e2eComposeFault(true)
  report({ patched: true })
  setTimeout(() => {
    control.__e2eComposeFault(false)
    report({ restored: true })
  }, props.ms || 4000)
})
