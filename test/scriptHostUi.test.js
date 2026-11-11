import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { bundleClient, forgedElement, hostileValues, INJECTED, renderSafely } from './lib/renderHarness.mjs'
import { toText, toNumber, jsonCopy } from '../src/core/extras/scriptText.js'
import { copyFields, fieldValues, FIELD_LIMIT } from '../src/core/extras/appFields.js'

// The real HUD, sidebar field and chat components and the real ClientControls/Apps entry points, rendered to a
// string with the repo's react-dom/server. A script value that reaches host UI must render as plain text or not at
// all: React treats any object with the element $$typeof as markup (Symbol.for works inside SES compartments).
let ui
before(async () => {
  ui = await bundleClient(`
    export { Actions, Message } from './src/client/components/CoreUI'
    export { AppFields } from './src/client/components/Sidebar'
    export * as Fields from './src/client/components/Fields'
    export { HintProvider } from './src/client/components/Hint'
    export { ClientControls } from './src/core/systems/ClientControls'
    export { Apps } from './src/core/systems/Apps'
  `)
})

const h = (...args) => ui.createElement(...args)
const withHints = child => h(ui.HintProvider, null, child)

function controlsWorld() {
  const world = new EventEmitter()
  world.ui = { suppressReticle: () => () => {} }
  world.controls = new ui.ClientControls(world)
  return world
}

function appsWorld() {
  const world = new EventEmitter()
  world.network = { isServer: false, isClient: true, id: 'me', send: () => true }
  world.events = { emit() {}, on() {}, off() {} }
  return world
}

test('toText/toNumber: only primitives become host text or numbers; no script code runs', () => {
  const hostile = hostileValues()
  for (const value of Object.values(hostile)) {
    assert.equal(toText(value), '')
    assert.equal(toNumber(value, 7), 7)
  }
  assert.equal(toText('abc'), 'abc')
  assert.equal(toText(12.5), '12.5')
  assert.equal(toText(undefined), '')
  assert.equal(toText(true), '')
  assert.equal(toText('x'.repeat(1000), 10).length, 10)
  assert.equal(toNumber(new Number(3), 0), 0)
  assert.equal(toNumber(NaN, 1), 1)
  assert.equal(toNumber(Infinity, 1), 1)
  assert.equal(toNumber(-Infinity, 1, true), -Infinity)
  // JSON copies drop symbols, so a forged element is inert data afterwards
  assert.equal(jsonCopy(forgedElement()).$$typeof, undefined)
  assert.equal(
    jsonCopy({
      toJSON() {
        throw new Error('no')
      },
    }),
    undefined
  )
})

test('control.setActions: the HUD gets host copies; script objects are neither kept nor written to', () => {
  const world = controlsWorld()
  const control = world.controls.bind({ priority: 1, object: {} })
  const hostile = hostileValues()
  let reads = 0
  const changing = {
    type: 'custom',
    get label() {
      // a getter that answers differently on a later read cannot slip a second value in
      return reads++ === 0 ? 'Open' : forgedElement()
    },
    btn: 'E',
  }
  const actions = [
    { type: 'custom', label: hostile.forged, btn: hostile.forged },
    { type: hostile.proxy, label: hostile.boxed, btn: hostile.throwing },
    hostile.proxy,
    changing,
    { type: 'keyF', label: 'Push' },
    null,
    'not an action',
  ]
  control.setActions(actions)
  assert.equal(reads, 1)
  const shown = world.controls.actions
  assert.equal(shown.length, 5)
  for (const action of shown) {
    assert.deepEqual(Object.keys(action).sort(), ['btn', 'id', 'label', 'type'])
    for (const key of ['type', 'label', 'btn']) assert.equal(typeof action[key], 'string')
    assert.equal(typeof action.id, 'number')
  }
  assert.deepEqual(
    shown.map(({ type, label, btn }) => [type, label, btn]),
    [
      ['custom', '', ''],
      ['', '', ''],
      // a Proxy's answer is kept only when it is a string
      ['div', '', ''],
      ['custom', 'Open', 'E'],
      ['keyF', 'Push', ''],
    ]
  )
  assert.equal(Object.hasOwn(actions[0], 'id'), false, 'no id is written onto the script object')
  assert.equal(Object.hasOwn(changing, 'id'), false)
  // later changes to the script's array or objects do not reach the HUD
  actions[4].label = forgedElement()
  actions.push({ type: 'keyX', label: 'late' })
  assert.equal(world.controls.actions.length, 5)
  assert.equal(world.controls.actions[4].label, 'Push')
  const html = renderSafely(ui, h(ui.Actions, { world }))
  assert.ok(html.includes('Open') && html.includes('Push'))
  assert.ok(!html.includes('boxed'))
  // null clears, anything else still throws as before
  control.setActions(null)
  assert.deepEqual(world.controls.actions, [])
  assert.throws(() => control.setActions({ length: 1, 0: {} }), /actions must be null or array/)
})

test('control.setActions: the list is capped', () => {
  const world = controlsWorld()
  const control = world.controls.bind({ priority: 1, object: {} })
  control.setActions(Array.from({ length: 1000 }, (_, i) => ({ type: 'custom', label: `a${i}`, btn: '1' })))
  assert.equal(world.controls.actions.length, 64)
})

test('app.configure: fields reach the sidebar as schema copies; hostile values render as text', () => {
  const world = appsWorld()
  const apps = new ui.Apps(world)
  const hostile = hostileValues()
  const warnings = []
  const original = console.warn
  console.warn = line => warnings.push(String(line))
  const clicks = []
  const onClick = () => clicks.push('clicked')
  const fields = [
    { type: 'section', label: hostile.forged },
    { type: 'text', key: 'name', label: hostile.forged, hint: hostile.proxy, placeholder: hostile.boxed, extra: 1 },
    { type: 'textarea', key: 'desc', label: hostile.throwing, initial: forgedElement() },
    { type: 'number', key: 'count', label: 'Count', dp: 500, min: hostile.throwing, max: 10, step: '1', initial: 2 },
    { type: 'range', key: 'size', label: 'Size', min: 0, max: Infinity, step: 0.5 },
    { type: 'switch', key: 'mode', label: 'Mode', options: [{ label: hostile.forged, value: forgedElement() }] },
    { type: 'dropdown', key: 'old', options: hostile.proxy },
    { type: 'toggle', key: 'on', label: 'On', trueLabel: hostile.forged, falseLabel: 'Off', initial: true },
    { type: 'texture', key: 'tex', label: 'Texture', initial: { name: forgedElement(), url: 'asset://a.png' } },
    { type: 'curve', key: 'curve', label: 'Curve', yMin: hostile.boxed, yMax: 1 },
    { type: 'color', key: 'color', label: 'Color', initial: forgedElement() },
    { type: 'button', key: 'go', label: hostile.forged, onClick },
    { type: 'text', key: '__proto__', label: 'Proto' },
    { type: 'text', key: 'constructor', label: 'Ctor' },
    { type: 'text', key: 'k'.repeat(65), label: 'Long' },
    { type: 'text', label: 'No key' },
    hostile.proxy,
    { type: 'text', key: 'shown', label: 'Shown', when: [{ op: 'eq', key: 'on', value: true }] },
    { type: 'text', key: 'hidden', label: 'Hidden', when: [{ op: 'eq', key: 'on', value: false }] },
  ]
  const entity = { props: {}, onFields: null, data: { id: 'app' }, blueprint: { id: 'bp', props: {} } }
  try {
    apps.appMethods.configure(entity, fields)
  } finally {
    console.warn = original
  }
  // the key rule drops five fields (the four bad keys and the proxy); it is said once per app
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /key must be a string of 1-64 characters/)
  const keys = entity.fields.map(field => field.key)
  assert.deepEqual(keys, [
    undefined,
    'name',
    'desc',
    'count',
    'size',
    'mode',
    'old',
    'on',
    'tex',
    'curve',
    'color',
    'go',
    'shown',
    'hidden',
  ])
  const byKey = Object.fromEntries(entity.fields.filter(field => field.key).map(field => [field.key, field]))
  assert.deepEqual(byKey.name, { type: 'text', key: 'name', label: '', hint: '', placeholder: '' })
  assert.deepEqual(byKey.count, { type: 'number', key: 'count', label: 'Count', initial: 2, max: 10 })
  assert.deepEqual(byKey.size, { type: 'range', key: 'size', label: 'Size', min: 0, step: 0.5 })
  assert.deepEqual(byKey.mode.options, [{ label: '', value: jsonCopy(forgedElement()) }])
  assert.deepEqual(byKey.old.options, [])
  assert.equal(byKey.tex.type, 'file')
  assert.equal(byKey.tex.kind, 'texture')
  assert.equal(byKey.go.onClick, onClick, 'a button keeps its callback, as a function')
  assert.equal(Object.hasOwn(byKey.name, 'extra'), false, 'unknown properties are dropped')
  // initial values are JSON copies applied to the app's own props
  assert.deepEqual(entity.props, {
    desc: jsonCopy(forgedElement()),
    count: 2,
    on: true,
    tex: { name: jsonCopy(forgedElement()), url: 'asset://a.png' },
    color: jsonCopy(forgedElement()),
  })
  assert.notEqual(entity.props.tex, byKey.tex.initial, 'the props copy does not share objects with the fields')
  fields[1].label = 'changed later'
  assert.equal(byKey.name.label, '')

  const blueprint = { id: 'bp', version: 1, props: { name: forgedElement(), count: 'not a number', curve: 42 } }
  const app = { fields: entity.fields, onFields: null }
  const sidebarWorld = { blueprints: { get: () => blueprint, preflight: () => true, modify() {} } }
  const html = renderSafely(ui, withHints(h(ui.AppFields, { world: sidebarWorld, app, blueprint })))
  assert.ok(html.includes('Count') && html.includes('Shown'))
  assert.ok(!html.includes('Hidden'), 'a when rule sees the initial value of an unset prop')
  // the number field shows the stored non-number as its default, the fallback "0"
  assert.ok(html.includes('value="0"'))
  // the stored forged element is not rendered as markup (and an empty text field shows nothing)
  assert.ok(!html.includes(INJECTED))
})

test('app.configure: function form, non-arrays and the field cap', () => {
  const world = appsWorld()
  const apps = new ui.Apps(world)
  const entity = { props: {}, data: { id: 'app' } }
  apps.appMethods.configure(entity, () => [{ type: 'text', key: 'a', label: 'A', initial: 'x' }])
  assert.deepEqual(entity.fields, [{ type: 'text', key: 'a', label: 'A', initial: 'x' }])
  assert.deepEqual(entity.props, { a: 'x' })
  apps.appMethods.configure(entity, { 0: { key: 'a' }, length: 1 })
  assert.deepEqual(entity.fields, [])
  const original = console.warn
  console.warn = () => {}
  try {
    apps.appMethods.configure(
      entity,
      Array.from({ length: 1000 }, (_, i) => ({ type: 'text', key: `k${i}` }))
    )
  } finally {
    console.warn = original
  }
  assert.equal(entity.fields.length, FIELD_LIMIT)
})

test('copyFields: each script property is read once', () => {
  const reads = new Map()
  const field = new Proxy(
    { type: 'number', key: 'n', label: 'N', min: 1, max: 2, initial: 1 },
    {
      get(target, key) {
        reads.set(key, (reads.get(key) || 0) + 1)
        return target[key]
      },
    }
  )
  copyFields([field])
  for (const [key, count] of reads) assert.equal(count, 1, String(key))
})

test('field components: mistyped stored values render without throwing and without markup', () => {
  const { Fields } = ui
  const hostile = hostileValues()
  const world = { emit() {}, loader: {} }
  const values = [...Object.values(hostile), 'text', 12, { a: 1 }, [1, 2], null, undefined, true]
  for (const value of values) {
    for (const element of [
      h(Fields.FieldText, { label: 'T', value, onChange() {} }),
      h(Fields.FieldTextarea, { label: 'T', value, onChange() {} }),
      h(Fields.FieldNumber, { label: 'N', value, dp: 2, onChange() {} }),
      h(Fields.FieldNumber, { label: 'N', value, dp: 500, onChange() {} }),
      h(Fields.FieldRange, { label: 'R', value, onChange() {} }),
      h(Fields.FieldVec3, { label: 'V', value: [value, value, value], onChange() {} }),
      h(Fields.FieldSwitch, { label: 'S', value, options: value, onChange() {} }),
      h(Fields.FieldSwitch, { label: 'S', value, options: [{ label: value, value }], onChange() {} }),
      h(Fields.FieldToggle, { label: 'B', value, trueLabel: value, falseLabel: value, onChange() {} }),
      h(Fields.FieldFile, { label: 'F', kind: 'texture', value: { name: value, url: value }, world, onChange() {} }),
      h(Fields.FieldFile, { label: 'F', kind: '__proto__', value, world, onChange() {} }),
      h(Fields.FieldCurve, { label: 'C', value, onChange() {} }),
      h(Fields.FieldColor, { label: 'C', value, onChange() {} }),
      h(Fields.FieldBtn, { label: value, note: value, onClick() {} }),
    ]) {
      renderSafely(ui, withHints(element))
    }
  }
  const html = renderSafely(ui, withHints(h(Fields.FieldNumber, { label: 'N', value: '5', dp: 1, onChange() {} })))
  assert.ok(html.includes('value="0.0"'))
})

test('fieldValues: unset props show the initial value; set ones, including null, are kept', () => {
  const fields = [
    { type: 'text', key: 'a', initial: 'A' },
    { type: 'file', key: 'f', initial: { url: 'asset://x.png' } },
    { type: 'text', key: 'toString', initial: 'own' },
    { type: 'section' },
  ]
  const props = { f: null, b: 1 }
  const values = fieldValues(fields, props)
  assert.deepEqual(values, { f: null, b: 1, a: 'A', toString: 'own' })
  assert.deepEqual(props, { f: null, b: 1 }, 'the blueprint props are not changed')
  assert.deepEqual(fieldValues(fields, null), { a: 'A', f: { url: 'asset://x.png' }, toString: 'own' })
})
