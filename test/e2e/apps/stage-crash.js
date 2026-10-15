// e2e probe: a non-number in this app's own transform. The host notices it while cleaning node matrices
// (Stage.clean), outside of any script callback; only this app may crash.
// With props.destroyThrows the script also leaves a pending timer and a destroy listener that throws:
// the teardown must still complete (timers cleared, crash block shown, no unhandled rejection).
const node = app.create('group')
app.add(node)
if (props.destroyThrows) {
  setTimeout(() => {}, 600000)
  app.on('destroy', () => {
    throw new Error('P1_DESTROY_BOOM')
  })
}
let elapsed = 0
let armed = false
app.on('update', delta => {
  elapsed += delta
  if (armed || elapsed < 1) return
  armed = true
  node.position.x = {
    valueOf() {
      throw new Error('P1_STAGE_BOOM')
    },
  }
})
