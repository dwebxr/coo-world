import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { sanitizeBlueprintAdd, sanitizeBlueprintModify } from '../src/core/extras/blueprintPolicy.js'
import { strictDecode } from '../src/core/extras/strictDecode.js'
import { writeClientPacket } from '../src/core/packets.js'

const base = { id: 'bp', version: 0 }
const sanitizers = [sanitizeBlueprintAdd, sanitizeBlueprintModify]
const textLimits = { name: 256, desc: 4096, author: 256, url: 2048, model: 2048, script: 2048 }
const flags = ['preload', 'public', 'locked', 'frozen', 'unique', 'scene', 'disabled']

test('blueprintPolicy: id and version limits, required only on add', () => {
  assert.deepEqual(sanitizeBlueprintAdd(base), { ok: true, value: base, changed: false })
  for (const input of [{}, { id: 'x' }, { version: 0 }, { id: null, version: 0 }, { id: 'x', version: undefined }]) {
    assert.equal(sanitizeBlueprintAdd(input).ok, false)
    assert.equal(sanitizeBlueprintModify(input).ok, true)
  }
  for (const sanitize of sanitizers) {
    for (const id of ['', 'x'.repeat(65), 1, {}, true]) assert.equal(sanitize({ ...base, id }).ok, false)
    for (const version of [-1, 1.2, Infinity, NaN, '0', Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(sanitize({ ...base, version }).ok, false)
    }
    assert.equal(sanitize({ id: 'x'.repeat(64), version: Number.MAX_SAFE_INTEGER }).ok, true)
  }
})

test('blueprintPolicy: every text cap, null and surrogate-safe truncation', () => {
  for (const sanitize of sanitizers) {
    for (const [key, max] of Object.entries(textLimits)) {
      // model and script must also be references (asset:// or http(s)), so their filler is a URL path
      const head = key === 'model' || key === 'script' ? 'https://example.com/' : ''
      const empty = head ? [] : ['']
      for (const item of [null, ...empty, head + 'x'.repeat(max - head.length)]) {
        assert.deepEqual(sanitize({ ...base, [key]: item }), {
          ok: true,
          value: { ...base, [key]: item },
          changed: false,
        })
      }
      const safe = sanitize({ ...base, [key]: head + 'x'.repeat(max - 1 - head.length) + '😀tail' })
      assert.equal(safe.value[key], head + 'x'.repeat(max - 1 - head.length))
      assert.equal(safe.changed, true)
      for (const item of [false, 1, [], {}]) assert.equal(sanitize({ ...base, [key]: item }).ok, false)
    }
  }
})

test('blueprintPolicy: flags are booleans; absent, undefined and non-nullable null never default', () => {
  for (const sanitize of sanitizers) {
    for (const key of flags) {
      for (const item of [true, false]) assert.equal(sanitize({ ...base, [key]: item }).value[key], item)
      for (const item of [0, 1, '', 'true', {}, []]) assert.equal(sanitize({ ...base, [key]: item }).ok, false)
      for (const item of [null, undefined]) assert.deepEqual(sanitize({ ...base, [key]: item }).value, base)
    }
    for (const key of [...Object.keys(textLimits), 'image', 'props']) {
      assert.deepEqual(sanitize({ ...base, [key]: undefined }).value, base)
      assert.equal(sanitize({ ...base, [key]: null }).value[key], null)
    }
    assert.deepEqual(sanitize(base).value, base)
  }
  assert.deepEqual(sanitizeBlueprintModify({ id: null, version: null }).value, {})
})

test('blueprintPolicy: image and props are plain objects or null; nested values are JSON only', () => {
  const bad = [undefined, new Date(), new Map(), new Set(), new Uint8Array(1), () => {}, Symbol('x'), 1n, NaN, Infinity]
  for (const key of ['props', 'image']) {
    for (const value of [[], true, 1, 'text', ...bad.slice(1)]) {
      assert.equal(sanitizeBlueprintAdd({ ...base, [key]: value }).ok, false)
    }
    for (const value of bad.slice(1)) assert.equal(sanitizeBlueprintAdd({ ...base, [key]: { value } }).ok, false)
    const input = { ...base, [key]: { all: [null, false, 2.5, 'text', {}] } }
    const safe = sanitizeBlueprintAdd(input)
    assert.deepEqual(safe.value, input)
    assert.notEqual(safe.value[key], input[key])
    assert.equal(safe.changed, false)
  }
})

test('blueprintPolicy: walk counts every key and value, with a shared 8192-item budget', () => {
  // root + key + array + 8189 values = 8192
  const props = { list: Array(8189).fill(null) }
  assert.equal(sanitizeBlueprintAdd({ ...base, props }).ok, true)
  assert.equal(sanitizeBlueprintAdd({ ...base, props, image: {} }).ok, false)
  props.list.push(null)
  assert.equal(sanitizeBlueprintAdd({ ...base, props }).ok, false)
  assert.equal(sanitizeBlueprintAdd({ ...base, props: { list: Array(8189) } }).ok, true)
  assert.equal(sanitizeBlueprintAdd({ ...base, props: { list: Array(8190) } }).ok, false)
  const pairs = Object.fromEntries(Array.from({ length: 4095 }, (_, i) => [`k${i}`, i]))
  assert.equal(sanitizeBlueprintAdd({ ...base, props: pairs }).ok, true)
  pairs.extra = 1
  assert.equal(sanitizeBlueprintAdd({ ...base, props: pairs }).ok, false)
})

test('blueprintPolicy: depth counts the JSON root, rejects cycles, and never truncates JSON strings', () => {
  let props = { text: '😀'.repeat(70 * 1024) }
  const safe = sanitizeBlueprintAdd({ ...base, props })
  assert.equal(safe.value.props.text, props.text)
  assert.equal(safe.changed, false)
  props = { leaf: null }
  for (let i = 0; i < 14; i++) props = { next: props }
  assert.equal(sanitizeBlueprintAdd({ ...base, props }).ok, true)
  assert.equal(sanitizeBlueprintAdd({ ...base, props: { next: props } }).ok, false)
  const cycle = {}
  cycle.self = cycle
  assert.equal(sanitizeBlueprintAdd({ ...base, props: cycle }).ok, false)
})

test('blueprintPolicy: undefined is absent and special keys cannot pollute prototypes', () => {
  const props = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}')
  props.absent = undefined
  props.array = [1, undefined, 2]
  const safe = sanitizeBlueprintAdd({ ...base, props })
  assert.equal(safe.ok, true)
  assert.equal(safe.changed, true)
  assert.equal(Object.hasOwn(safe.value.props, 'absent'), false)
  assert.deepEqual(safe.value.props.array, [1, null, 2])
  assert.equal(Object.getPrototypeOf(safe.value.props), Object.prototype)
  assert.equal(Object.hasOwn(safe.value.props, '__proto__'), true)
  assert.equal({}.polluted, undefined)
  assert.equal(sanitizeBlueprintAdd({ ...base, props: { [Symbol('bad')]: 1 } }).ok, false)
})

test('blueprintPolicy: unknown-key hook is escaped and bounded without inspecting its value', () => {
  const names = []
  const key = '\n"' + 'x'.repeat(40)
  const data = { ...base }
  Object.defineProperty(data, key, {
    enumerable: true,
    get: () => {
      throw Error('must not read')
    },
  })
  const safe = sanitizeBlueprintAdd(data, { onUnknownKey: name => names.push(name) })
  assert.equal(safe.ok, true)
  assert.deepEqual(safe.value, base)
  assert.equal(safe.changed, true)
  assert.equal(names.length, 1)
  assert.equal(JSON.parse(names[0]).length, 32)
  assert.ok(!names[0].includes('\n'))
})

// the shapes of the five production blueprints (keys, nulls, nesting, prop records) with ids, names and asset hashes replaced
const production = JSON.parse(fs.readFileSync(new URL('./fixtures/blueprint-shapes.json', import.meta.url)))
const collection = fs
  .readdirSync(new URL('../src/world/collections/default/', import.meta.url))
  .filter(n => n.endsWith('.hyp'))
  .map(name => {
    const bytes = fs.readFileSync(new URL(`../src/world/collections/default/${name}`, import.meta.url))
    return JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0))).blueprint
  })

test('blueprintPolicy: five production-shaped blueprints (anonymized) and four collection .hyp blueprints pass unchanged', () => {
  assert.equal(production.length, 5)
  assert.equal(collection.length, 4)
  for (const blueprint of [...production, ...collection]) {
    assert.deepEqual(sanitizeBlueprintAdd(blueprint), { ok: true, value: blueprint, changed: false }, blueprint.name)
  }
})

test('blueprintPolicy: client normalization and the server policy on strict-decoded wire values agree', () => {
  const inputs = [
    ...production,
    ...collection,
    { ...base, name: '😀'.repeat(1000), props: { text: 'x'.repeat(20000) } },
    { ...base, author: null },
    { ...base, props: { list: [1, undefined, ...Array(1), 2], absent: undefined } },
    { ...base, disabled: 'bad' },
  ]
  for (const data of inputs) {
    for (const [name, sanitize] of [
      ['blueprintAdded', sanitizeBlueprintAdd],
      ['blueprintModified', sanitizeBlueprintModify],
    ]) {
      const decoded = strictDecode(writeClientPacket(name, data), { maxNodes: 8192, build: true })
      assert.equal(decoded.ok, true)
      assert.deepEqual(sanitize(decoded.value[1]), sanitize(data))
    }
  }
})

test('blueprintPolicy: the browser and wire e2e fixture producers pass unchanged', async () => {
  const { installApp } = await import('./e2e/lib/browser.mjs')
  const { WireClient } = await import('./e2e/lib/ws.mjs')
  const blueprints = []
  const input = { id: 'e2e-fixture', script: 'asset://event-probe.js', props: { text: 'kept', file: null } }
  WireClient.prototype.installApp.call(
    {
      send: (name, data) => {
        if (name === 'blueprintAdded') blueprints.push(data)
      },
    },
    input
  )
  const previous = globalThis.window
  globalThis.window = { world: { blueprints: { add: data => blueprints.push(data) }, entities: { add() {} } } }
  try {
    await installApp({ evaluate: (fn, data) => fn(data) }, input)
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  assert.equal(blueprints.length, 2)
  for (const blueprint of blueprints) {
    assert.deepEqual(sanitizeBlueprintAdd(blueprint), { ok: true, value: blueprint, changed: false })
  }
})

const hashScript = `asset://${'0123456789abcdef'.repeat(4)}.js`
const refusedReferences = [
  '/etc/passwd',
  '/proc/self/environ',
  'asset://../x',
  'asset://../../../proc/self/environ',
  'asset://a/b.js',
  'asset://%2e%2e/x',
  'asset://',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:text/javascript,1',
  'blob:http://localhost/x',
  'C:\\Windows\\win.ini',
  '../x.js',
  'x.js',
  '',
]

test('blueprintPolicy: model and script are an asset://<name> or an http(s) URL when added or set', () => {
  for (const sanitize of sanitizers) {
    for (const key of ['model', 'script']) {
      for (const item of refusedReferences) {
        assert.equal(sanitize({ ...base, [key]: item }).ok, false, `${sanitize.name} ${key} ${item}`)
      }
      for (const item of [
        hashScript,
        'asset://ai.glb',
        'https://example.com/a.glb',
        'http://localhost:3000/a.js?v=1',
      ]) {
        assert.deepEqual(sanitize({ ...base, [key]: item }), {
          ok: true,
          value: { ...base, [key]: item },
          changed: false,
        })
      }
    }
  }
})

test('blueprintPolicy: image.url follows the same rule; an image without a url is unchanged', () => {
  const image = url => ({ type: 'texture', name: 'i.png', url })
  for (const sanitize of sanitizers) {
    for (const url of [...refusedReferences, 1, {}, ['asset://a.png']]) {
      assert.equal(sanitize({ ...base, image: image(url) }).ok, false, `${sanitize.name} ${url}`)
    }
    for (const url of ['asset://a.png', 'https://example.com/a.png', null]) {
      assert.equal(sanitize({ ...base, image: image(url) }).ok, true, `${sanitize.name} ${url}`)
    }
    assert.equal(sanitize({ ...base, image: {} }).ok, true)
    assert.equal(sanitize({ ...base, image: null }).ok, true)
  }
})

test('blueprintPolicy: only the reference a modify sets is checked; a legacy stored value stays editable', () => {
  const current = {
    id: 'bp',
    version: 3,
    script: '/legacy/odd.js',
    model: 'asset://../legacy.glb',
    image: { url: 'x' },
  }
  // a modify that does not touch script, model or image
  for (const change of [{ name: 'renamed' }, { props: { a: 1 } }, { disabled: true }]) {
    const data = { id: 'bp', version: 4, ...change }
    assert.deepEqual(sanitizeBlueprintModify(data, { current }), { ok: true, value: data, changed: false })
    assert.deepEqual(sanitizeBlueprintModify(data), { ok: true, value: data, changed: false })
  }
  // a modify that repeats the stored values unchanged (a full-blueprint change) sets nothing new
  const repeat = { ...current, version: 4, name: 'renamed', image: { url: 'x' } }
  assert.equal(sanitizeBlueprintModify(repeat, { current }).ok, true)
  assert.equal(sanitizeBlueprintModify(repeat).ok, false, 'without the stored blueprint it is checked')
  // setting a new value is checked, and a different odd value is refused
  assert.equal(sanitizeBlueprintModify({ id: 'bp', version: 4, script: hashScript }, { current }).ok, true)
  assert.equal(sanitizeBlueprintModify({ id: 'bp', version: 4, script: '/etc/passwd' }, { current }).ok, false)
  assert.equal(sanitizeBlueprintModify({ id: 'bp', version: 4, image: { url: 'y' } }, { current }).ok, false)
  // an add never borrows the stored values
  assert.equal(sanitizeBlueprintAdd({ ...current, version: 0 }, { current }).ok, false)
  // a stored record keeps whatever it holds (hydration, cleaner)
  assert.deepEqual(sanitizeBlueprintAdd(current, { persisted: true }), { ok: true, value: current, changed: false })
})
