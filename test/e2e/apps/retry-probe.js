// e2e probe (server): makes matrix composition fail for any node positioned beyond x > 900 for a few
// seconds. The harness moves a connected player there, so a node the host owns (not an app) keeps failing
// and the retry cap must give up on it once and recover when the patch is lifted.
// NOTE: this patches a shared THREE prototype on purpose; that is closed in a later phase.
const TAG = 'P1_RETRY'
const report = data => world.chat({ id: uuid(), body: TAG + ' ' + JSON.stringify(data) }, true)
const original = Matrix4.prototype.compose
let armed = false
app.on('update', () => {
  if (armed) return
  armed = true
  Matrix4.prototype.compose = function (position, quaternion, scale) {
    if (position && position.x > 900) throw new Error('P1_RETRY_PROBE')
    return original.call(this, position, quaternion, scale)
  }
  report({ patched: true })
  setTimeout(() => {
    Matrix4.prototype.compose = original
    report({ restored: true })
  }, props.ms || 4000)
})
