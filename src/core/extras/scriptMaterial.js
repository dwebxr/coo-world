import { assertScriptActive, stoppedError } from './physicsFailure.js'
import { hardenForScripts } from './scriptHardening.js'

// A material as a script sees it (a Mesh's or a Video's `material`). The host's facade can be shared: a linked
// material hands the same one to every app whose meshes use it. A script gets a wrapper made for one app run, the run
// of the app the node is mounted for: frozen, with frozen accessor functions, the same object for the same material
// within that run. Reads always answer; a write acts only while that run lasts (its own destroy event included), so
// a material kept past its app's teardown (a late promise, a retained reference) changes nothing any app renders.
//
// A write of a property the material does not have (`material.opacity = 0.5`) is ignored: nothing is stored, the
// wrapper stays as it is, and the app's console is told once per run and property name (up to a limit, below). Until
// #47 a script's material was a plain object, where such a write made a property nobody read; on the frozen wrapper it
// threw, and a script that did it in its update handler crashed its app. The wrapper's prototype is what ignores it
// (handleProto below): the wrapper's own accessors are found first, as before, and only a property it does not have
// reaches the prototype.
// Everything else stays: the wrapper is frozen (its accessors cannot be replaced, redefined or deleted, its prototype
// cannot be changed), a getter-only property (`id`) still throws on a write, and a setter still refuses once the run
// has ended. An ignored write in a run that has ended throws the stopped error, as a setter does then.
const wrappers = new WeakMap() // app run (its dead hook) -> WeakMap(facade -> wrapper)
const handles = new WeakMap() // wrapper -> { run, assertRun, names }

// The ignored writes of a run are told once per property name, for MATERIAL_REPORT_LIMIT names; the next new name
// gets one line saying that further ones are not told, and from then on an ignored write of that run does nothing more
// (its key is not looked at). What this bounds: the warnings per run (MATERIAL_REPORT_LIMIT + 1); what the host keeps
// for a run (at most MATERIAL_REPORT_LIMIT names, each a copy the host makes of at most NAME_TEXT code units of its key,
// so that a long key the script made is not kept alive through them, and nothing once the line has been said); and the
// work of an ignored write (a lookup of the key itself for a short string, of its first NAME_TEXT code units and its
// length otherwise, and at most NAME_TEXT code units copied when a name is told). It does not bound what the script
// itself keeps or spends: it can hold as much in its own variables, and write as often, while its run lasts.
//
// What tells two names apart: a string and a symbol never count as one. A string of up to NAME_TEXT code units is
// itself; a longer one is its first NAME_TEXT code units and its length, so two long names equal in both count as one.
// A symbol is its description in the same way (two symbols with the same description count as one; one without a
// description is told apart from one whose description is empty).
export const MATERIAL_REPORT_LIMIT = 16
const NAME_TEXT = 64
// app run -> { strings: the short strings told, others: the other names told (as `kind length:start`) }, both null once
// the limit's line has been said
const reported = new WeakMap()

// a new string of the first `count` code units of `text`, which shares nothing with it
function copyStart(text, count) {
  const codes = []
  for (let i = 0; i < count; i++) codes.push(text.charCodeAt(i))
  return String.fromCharCode(...codes)
}

function reportIgnored({ run, names }, key) {
  let state = reported.get(run)
  if (!state) reported.set(run, (state = { strings: new Set(), others: new Set() }))
  if (!state.strings) return
  const symbol = typeof key === 'symbol'
  const text = symbol ? key.description : key
  const length = text === undefined ? 0 : text.length
  const short = !symbol && length <= NAME_TEXT
  const kind = symbol ? (text === undefined ? 'u' : 'y') : 's'
  // (looked up as they are: a short string itself, the start of a longer text only for the lookup)
  const seen = short ? state.strings : state.others
  if (seen.has(short ? key : `${kind}${length}:${length ? text.slice(0, NAME_TEXT) : ''}`)) return
  if (state.strings.size + state.others.size >= MATERIAL_REPORT_LIMIT) {
    state.strings = state.others = null
    console.warn(
      '[material] more properties a material does not have were set in this run: ignored, without a further warning'
    )
    return
  }
  // what is kept and shown is the host's own copy
  const start = copyStart(text ?? '', Math.min(length, NAME_TEXT))
  seen.add(short ? start : `${kind}${length}:${start}`)
  const shown = `${start}${length > NAME_TEXT ? '…' : ''}`
  console.warn(
    `[material] ${symbol ? `Symbol(${shown})` : shown} not set: a material has no such property (it has ${names})`
  )
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
