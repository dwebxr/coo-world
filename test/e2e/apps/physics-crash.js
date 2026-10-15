// e2e probe: a throwing change callback on a dynamic body's transform. The host runs it while
// interpolating physics (Physics.preUpdate), outside of any script callback; only this app may crash.
// The body starts high up so it is still falling (awake) when the callback is installed, which happens on
// the first update after one physics step (a frame-counted delay would scale with the renderer's speed).
// With props.destroyThrows the script also leaves a pending timer and a destroy listener that throws:
// the teardown must still complete (timers cleared, crash block shown, no unhandled rejection).
const body = app.create('rigidbody', { type: 'dynamic', position: [0, 30, 0] })
body.add(app.create('collider', { type: 'sphere', radius: 0.25 }))
app.add(body)
if (props.destroyThrows) {
  setTimeout(() => {}, 600000)
  app.on('destroy', () => {
    throw new Error('P1_DESTROY_BOOM')
  })
}
let armed = false
app.on('update', () => {
  if (armed) return
  armed = true
  body.position._onChangeCallback = () => {
    throw new Error('P1_PHYSICS_BOOM')
  }
})
