import { createLogOnce } from './logOnce.js'

let traps = 0
const logTrap = createLogOnce(message => console.error(message))

export function isPhysicsTrap(err) {
  try {
    return err instanceof WebAssembly.RuntimeError
  } catch {
    return false // revoked proxies and other thrown values are not native traps
  }
}

export function getPhysicsTrapCount() {
  return traps
}

// a crashed app may still clean up from its destroy event (allowDestroy calls only); a removed app's script runs for
// as long as its teardown does (its destroy event, and the callbacks the teardown runs: what each stage releases is
// refused by that stage, runTeardown.js) and is stopped once the teardown is over (a promise or callback that resumes
// later is refused)
export function assertScriptActive(entity, world = entity?.world, allowDestroy = false) {
  if (
    (entity?.crashed && !(allowDestroy && entity.destroying)) ||
    (entity?.destroyed && !entity.destroying && !entity.tearingDown) ||
    world?.fatalError
  ) {
    throw stoppedError(entity)
  }
}

// what a call into a stopped app (or into a run of it that has ended) throws
export function stoppedError(entity) {
  return new Error(
    entity?.nativeFailure ? '[physics] disabled for this app after a native failure' : '[app] this app has stopped'
  )
}

export function handlePhysicsFailure(err, { entity, world = entity?.world, phase, count = 1 } = {}) {
  if (!isPhysicsTrap(err)) return false
  traps += count
  if (world?.physics) world.physics.needsProbe = true
  const subject = entity || world
  if (subject) {
    logTrap(
      subject,
      'trap',
      `[physics] native failure (entity ${entity?.data?.id ?? 'none'}, phase ${phase ?? 'script'})`
    )
  }
  if (entity?.isApp) {
    entity.nativeFailure = true
    entity.physicsFailureVersion = (entity.physicsFailureVersion || 0) + 1
    entity.scriptError = { name: 'RuntimeError', message: 'Native physics failure' }
    entity.crash()
  }
  return true
}
