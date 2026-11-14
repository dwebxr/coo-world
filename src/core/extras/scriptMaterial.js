import { assertScriptActive, stoppedError } from './physicsFailure.js'
import { hardenForScripts } from './scriptHardening.js'

// A material as a script sees it (a Mesh's or a Video's `material`). The host's facade can be shared: a linked
// material hands the same one to every app whose meshes use it. A script gets a wrapper made for one app run, the run
// of the app the node is mounted for: frozen, with frozen accessor functions, the same object for the same material
// within that run. Reads always answer; a write acts only while that run lasts (its own destroy event included), so
// a material kept past its app's teardown (a late promise, a retained reference) changes nothing any app renders.
//
// A write of a property the material does not have (`material.opacity = 0.5`) is ignored: nothing is stored, the
// wrapper stays as it is, and the app's console is told once per run and property name. Until #47 a script's material
// was a plain object, where such a write made a property nobody read; on the frozen wrapper it threw, and a script
// that did it in its update handler crashed its app. The wrapper's prototype is what ignores it (handleProto below):
// the wrapper's own accessors are found first, as before, and only a property it does not have reaches the prototype.
// Everything else stays: the wrapper is frozen (its accessors cannot be replaced, redefined or deleted, its prototype
// cannot be changed), a getter-only property (`id`) still throws on a write, and a setter still refuses once the run
// has ended. An ignored write in a run that has ended throws the stopped error, as a setter does then.
const wrappers = new WeakMap() // app run (its dead hook) -> WeakMap(facade -> wrapper)
const handles = new WeakMap() // wrapper -> { run, assertRun, names }

// the distinct property names reported per run: a script that writes a new name every frame says it a bounded number
// of times, then once that it goes on
export const MATERIAL_REPORT_LIMIT = 16
const reported = new WeakMap() // app run -> Set(property names reported)

function reportIgnored({ run, names }, key) {
  let seen = reported.get(run)
  if (!seen) reported.set(run, (seen = new Set()))
  // (String() and not a template: a symbol key converts only that way)
  const name = String(key).slice(0, 64)
  if (seen.has(name) || seen.size > MATERIAL_REPORT_LIMIT) return
  seen.add(name)
  if (seen.size > MATERIAL_REPORT_LIMIT) {
    console.warn(
      '[material] more properties a material does not have were set in this run: ignored, without a further warning'
    )
    return
  }
  console.warn(`[material] ${name} not set: a material has no such property (it has ${names})`)
}

// The prototype of every wrapper: a Proxy of a frozen empty object whose only trap is `set`. A write the wrapper does
// not answer itself reaches it with the wrapper as receiver, and is ignored. A script's own object that inherits from
// a wrapper (`Object.create(material)`) gets its property as an ordinary object does. Everything else (a read, `in`,
// a definition, a deletion, a prototype change on it) goes to the frozen target: nothing is ever stored on it, and it
// holds nothing of an app, so one object serves every app and run.
const handleProto = new Proxy(Object.freeze(Object.create(Object.prototype)), {
  set(target, key, value, receiver) {
    const handle = handles.get(receiver)
    if (!handle) return Reflect.set(target, key, value, receiver)
    // (only reached through Reflect.set on the prototype itself: an own property is the wrapper's to answer)
    if (Object.hasOwn(receiver, key)) return Reflect.set(receiver, key, value)
    handle.assertRun()
    reportIgnored(handle, key)
    return true
  },
})

// whether a value is a material as a script sees it (host code and tests)
export function isMaterialHandle(value) {
  return handles.has(value)
}

export function materialForScript(node, facade) {
  if (facade === null || typeof facade !== 'object') return facade
  const run = node.ctx?.run
  const entity = node.ctx?.entity
  // not mounted for an app run (only the host mounts such nodes): there is no run to bind to, so no material either
  if (!run || !entity) return undefined
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
  const wrapper = Object.create(handleProto)
  const names = []
  for (const key of Reflect.ownKeys(facade)) {
    const desc = Reflect.getOwnPropertyDescriptor(facade, key)
    // (`_ref` is the host's)
    if (typeof key === 'string' && !key.startsWith('_')) names.push(key)
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
  handles.set(wrapper, { run, assertRun, names: names.join(', ') })
  return hardenForScripts(Object.freeze(wrapper))
}
