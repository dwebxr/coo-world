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
// armed on the first update (the node is mounted by app.add): a frame-counted delay would scale with
// the renderer's speed and make a slow headless browser look like a missing crash
let armed = false
app.on('update', () => {
  if (armed) return
  armed = true
  node.position.x = {
    valueOf() {
      throw new Error('P1_STAGE_BOOM')
    },
  }
})
