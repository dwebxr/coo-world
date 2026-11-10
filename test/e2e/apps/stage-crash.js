// e2e probe: the Stage path for this app's own transform.
// 1. A script can write anything straight into a component of its node's transform (past the setters); the engine
//    reads such a component as NaN and never converts it (Node.guardTransform). The probe plants a Symbol and an
//    object with a throwing valueOf, marks the transform through a setter and reports what the engine left there
//    (app.state.P1_STAGE_GUARDED, and a P1_STAGE_GUARDED chat line on the server): nothing may crash.
// 2. With props.fault, where the e2e hook is preloaded (test/e2e/lib/script-class-hook.js: the server), the probe
//    switches on the hook's compose fault and moves its node past x = 900: the host's composition then throws for
//    this app's node while cleaning node matrices (Stage.clean), outside of any script callback, and only this app may
//    crash. A script cannot cause such a failure itself any more; the hook stands in for one.
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
const report = data => {
  app.state.P1_STAGE_GUARDED = data
  if (world.isServer) world.chat({ id: uuid(), body: 'P1_STAGE_GUARDED ' + JSON.stringify(data) }, true)
}
// counted from the first update (the node is mounted by app.add): a frame-counted delay would scale with the
// renderer's speed, so each step waits for the update after the one that marked the transform
let step = 0
app.on('update', () => {
  step++
  if (step === 1) {
    node.position._x = Symbol('P1_STAGE_SYMBOL')
    node.position._y = {
      valueOf() {
        throw new Error('P1_STAGE_VALUEOF')
      },
    }
    node.position.z = 1
  } else if (step === 3) {
    report({ x: String(node.position._x), y: String(node.position._y) })
    if (props.fault) {
      try {
        new Vector3().__e2eComposeFault(true)
      } catch {
        return // (no hook here)
      }
      node.position.x = 950
    }
  }
})
