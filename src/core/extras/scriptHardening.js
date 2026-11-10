// Hardening of host values handed to app scripts.
//
// harden() only exists after lockdown (server, client, node-client). The viewer, the standalone client
// bundle and unit tests run without it, so every call here is a no-op unless the real hardener is present
// (the fake one installed by `__hardenTaming__: 'unsafe'` is flagged with `isFake`).

import { makeOverridable, ownedPrototypes } from './scriptClassPrep.js'

let classesHardened = false

export function canHarden() {
  const harden = globalThis.harden
  return typeof harden === 'function' && !harden.isFake
}

// freezes the value and everything reachable from it; returns the value either way
export function hardenForScripts(value) {
  return canHarden() ? globalThis.harden(value) : value
}

// Freezes the classes app scripts can reach: the ones endowed to them (Vector3, Quaternion, ...) and the ones
// their methods and instances lead to. lockdown() froze only the language's own intrinsics; these classes are
// shared by the engine and by every script, so until they are frozen one script can replace a method that the
// engine and all other scripts then run.
//
// `classes` is a list of [name, constructor]. Runs once per realm; later calls do nothing. Each prototype is
// first made override-friendly (scriptClassPrep.js), because the engine and three assign over prototype
// properties on instances and inside constructors.
//
// A test may set globalThis.__scriptClassTestHook before the engine starts to instrument the classes while
// they can still be changed (the e2e native sentinel does). Whoever can set a global in the start realm
// already controls the page or the process, so this hands out nothing.
export function hardenScriptClasses(classes = []) {
  if (classesHardened || !canHarden()) return false
  classesHardened = true
  const hook = globalThis.__scriptClassTestHook
  if (typeof hook === 'function') hook(classes)
  const values = []
  for (const [, cls] of classes) {
    for (const proto of ownedPrototypes(cls)) values.push(...makeOverridable(proto))
  }
  for (const [, cls] of classes) globalThis.harden(cls)
  // harden() follows properties and accessor functions, not what a getter returns: the methods themselves
  globalThis.harden(values)
  return true
}
