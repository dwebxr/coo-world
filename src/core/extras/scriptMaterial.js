import { assertScriptActive, stoppedError } from './physicsFailure.js'
import { hardenForScripts } from './scriptHardening.js'

// A material as a script sees it (a Mesh's or a Video's `material`). The host's facade can be shared: a linked
// material hands the same one to every app whose meshes use it. A script gets a wrapper made for one app run, the run
// of the app the node is mounted for: frozen, with frozen accessor functions, the same object for the same material
// within that run. Reads always answer; a write acts only while that run lasts (its own destroy event included), so
// a material kept past its app's teardown (a late promise, a retained reference) changes nothing any app renders.
const wrappers = new WeakMap() // app run (its dead hook) -> WeakMap(facade -> wrapper)

export function materialForScript(node, facade) {
  if (facade === null || typeof facade !== 'object') return facade
  const run = node.ctx?.run
  const entity = node.ctx?.entity
  // not mounted for an app run (only the host mounts such nodes): there is no run to bind to
  if (!run || !entity) return facade
  let facades = wrappers.get(run)
  if (!facades) wrappers.set(run, (facades = new WeakMap()))
  let wrapper = facades.get(facade)
  if (!wrapper) facades.set(facade, (wrapper = wrapMaterial(facade, run, entity)))
  return wrapper
}

function wrapMaterial(facade, run, entity) {
  const assertRun = () => {
    if (run !== entity.deadHook) throw stoppedError(entity)
    assertScriptActive(entity, entity.world, true)
  }
  const wrapper = {}
  for (const key of Reflect.ownKeys(facade)) {
    const desc = Reflect.getOwnPropertyDescriptor(facade, key)
    const { get, set } = desc
    if (!get && !set) {
      Object.defineProperty(wrapper, key, { value: desc.value, enumerable: desc.enumerable })
      continue
    }
    Object.defineProperty(wrapper, key, {
      enumerable: desc.enumerable,
      get: get && (() => Reflect.apply(get, facade, [])),
      set:
        set &&
        (value => {
          assertRun()
          Reflect.apply(set, facade, [value])
        }),
    })
  }
  return hardenForScripts(Object.freeze(wrapper))
}
