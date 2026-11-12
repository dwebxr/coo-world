// The builder's number fields read what is typed as arithmetic (src/core/extras/arithmetic.js). They used to hand
// it to `eval`: these tests are of what is read, of what is refused, and that nothing typed is run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { transformSync } from 'esbuild'
import { ARITHMETIC_MAX_LENGTH, evaluateArithmetic, readNumberField } from '../src/core/extras/arithmetic.js'
import { toNumber, toText } from '../src/core/extras/scriptText.js'

test('arithmetic: what a builder types into a number field is computed', () => {
  const cases = [
    ['1', 1],
    ['  42  ', 42],
    ['1.5', 1.5],
    ['.5', 0.5],
    ['5.', 5],
    ['1e3', 1000],
    ['2.5E-1', 0.25],
    ['1+2', 3],
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 4 - 3', 3],
    ['100 / 10 / 5', 2],
    ['7 % 4', 3],
    ['-3', -3],
    ['+3', 3],
    ['--3', 3],
    ['2 * -3', -6],
    ['4 - -1', 5],
    ['2 ** 10', 1024],
    ['2 ** 3 ** 2', 512],
    ['-2 ** 2', -4],
    ['2 ** -1', 0.5],
    ['(2) ** 2 * 3', 12],
    ['90 / 4', 22.5],
    ['PI', Math.PI],
    ['pi * 2', Math.PI * 2],
    ['Math.PI / 2', Math.PI / 2],
    ['E', Math.E],
    ['Math.E', Math.E],
    ['sqrt(16)', 4],
    ['Math.sqrt(2) * Math.sqrt(2)', Math.SQRT2 * Math.SQRT2],
    ['abs(-2.5)', 2.5],
    ['floor(2.7) + ceil(2.2) + round(2.5)', 8],
    ['min(3, 1, 2)', 1],
    ['max(3, 1 + 9, 2)', 10],
    ['pow(2, 8)', 256],
    ['sin(0) + cos(0) + tan(0)', 1],
    ['((((1))))', 1],
    // any white space between the parts, also a line break pasted with it
    ['1\n+\t1', 2],
    ['1\u2028+\u00a01', 2],
  ]
  for (const [text, expected] of cases) assert.equal(evaluateArithmetic(text), expected, text)
})

test('arithmetic: anything that is not arithmetic is refused, and nothing typed is run', () => {
  globalThis.__arithmeticRan = 0
  const refused = [
    '',
    '   ',
    'abc',
    '1 +',
    '* 2',
    '(1 + 2',
    '1 + 2)',
    '1 2',
    '2pi',
    '1,2',
    '0x10',
    '1_000',
    '1..2',
    '1e',
    'sqrt',
    'sqrt 4',
    'sqrt()',
    'sqrt(4',
    'Math',
    'Math.',
    'Math.random()',
    'e',
    'Pi',
    'Infinity',
    'NaN',
    '1 / 0',
    '0 / 0',
    '2 ** 99999',
    'sqrt(-1)',
    // what `eval` ran, or read from the page
    'globalThis.__arithmeticRan = 1',
    '(globalThis.__arithmeticRan = 1, 5)',
    '__arithmeticRan++',
    'alert(1)',
    'fetch("https://example.invalid")',
    'document.cookie',
    'localStorage.getItem("x")',
    '(() => 1)()',
    '`${1}`',
    '"1"',
    "'1'",
    '[1][0]',
    '({}).constructor',
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty(1)',
    // (names every object has, in forms that would come out as a number if they were looked up)
    'hasOwnProperty(1) + 1',
    'constructor(1) + 1',
    'toString ** 0',
    'constructor ** 0',
    // (functions of Math that are not on the list)
    'random(1)',
    'Math.log(1) + 1',
    'trunc(1.5)',
    'imul(2, 3)',
    'Math.atan2(1, 1)',
    'Math.constructor("return 1")()',
    'min.constructor("return 1")()',
    'new Number(1)',
    'this',
    '1; 2',
    '1 // 2',
    '1 /* 2 */',
    '１',
    '1n',
    'true',
    'null',
    'void 0',
    'typeof 1',
    '!0',
    '~1',
    '1 < 2',
    '1 == 1',
    '1 ? 2 : 3',
    'x = 1',
  ]
  for (const text of refused) assert.throws(() => evaluateArithmetic(text), Error, JSON.stringify(text))
  assert.equal(globalThis.__arithmeticRan, 0)
  delete globalThis.__arithmeticRan
  for (const value of [undefined, null, 5, {}, ['1'], { toString: () => '1' }]) {
    assert.throws(() => evaluateArithmetic(value), /not a text/)
  }
})

test('arithmetic: a text beyond the length a field holds is not read, however simple', () => {
  const longest = '1+'.repeat((ARITHMETIC_MAX_LENGTH - 1) / 2) + '1'
  assert.equal(longest.length, ARITHMETIC_MAX_LENGTH - 1)
  assert.equal(evaluateArithmetic(longest), 100)
  assert.equal(evaluateArithmetic(longest + ' '), 100)
  assert.throws(() => evaluateArithmetic(longest + '  '), /too long/)
  // as deep as the length allows: read, without running out of stack
  const deep = '('.repeat(99) + '1' + ')'.repeat(99)
  assert.equal(evaluateArithmetic(deep), 1)
  assert.equal(evaluateArithmetic('-'.repeat(198) + '1'), 1)
  assert.throws(() => evaluateArithmetic('1'.repeat(1_000_000)), /too long/)
})

test('number field: a number is taken as it is, text as arithmetic, and anything else is refused with its reason', () => {
  const read = (input, options) => readNumberField(input, options)
  assert.deepEqual(read('1 + 2'), { value: 3 })
  assert.deepEqual(read(4.5), { value: 4.5 }, 'the arrow keys hand in a number')
  assert.deepEqual(read(0), { value: 0 })
  assert.deepEqual(read('0'), { value: 0 })
  assert.deepEqual(read('nonsense'), { refused: '"n" at 1 is not read' })
  assert.deepEqual(read('1 +'), { refused: 'it ends too early' })
  assert.deepEqual(read('1 / 0'), { refused: 'not a finite number' })
  assert.deepEqual(read(Infinity), { refused: 'not a finite number' })
  assert.deepEqual(read(NaN), { refused: 'not a finite number' })
  for (const input of [undefined, null, { valueOf: () => 1 }, ['1']]) {
    assert.deepEqual(read(input), { refused: 'not a text' })
  }
  // the range of the field, both ends included
  const range = { min: 0, max: 10 }
  assert.deepEqual(read('5', range), { value: 5 })
  assert.deepEqual(read('0', range), { value: 0 })
  assert.deepEqual(read('10', range), { value: 10 })
  assert.deepEqual(read('10.001', range), { refused: 'above 10' })
  assert.deepEqual(read('-0.001', range), { refused: 'below 0' })
  assert.deepEqual(read(11, range), { refused: 'above 10' })
  assert.deepEqual(read(-1, range), { refused: 'below 0' })
})

// --- the fields themselves ---

// The component source of Fields.js, run without a DOM (as tipForm.test.js and clientLifecycle.test.js run theirs):
// hooks keep their slots across renders, an effect runs after a render in which its dependencies changed, and the
// tree that comes back is plain objects whose handlers the test calls.
function mountField(name, initial) {
  const source = fs.readFileSync(new URL('../src/client/components/Fields.js', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '').replace(/^export /gm, ''), {
    loader: 'jsx',
    jsxFactory: 'element',
    jsxFragment: 'fragment',
  }).code
  // (the parent takes what the field hands it: the next render has that value, as a pane's state would)
  let props = {
    ...initial,
    onChange(value) {
      initial.onChange(value)
      props = { ...props, value }
    },
  }
  const slots = []
  const effects = []
  let cursor = 0
  const context = {
    useState(first) {
      const index = cursor++
      if (!(index in slots)) slots[index] = first
      return [slots[index], value => (slots[index] = value)]
    },
    useRef(first) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: first }
      return slots[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous && deps.every((dep, i) => dep === previous[i])) return
      slots[index] = deps
      effects.push(effect)
    },
    useMemo: fn => fn(),
    useHintProps: () => ({}),
    css: () => '',
    fragment: 'fragment',
    element: (type, elementProps, ...children) => ({ type, props: elementProps || {}, children: children.flat(9) }),
    readNumberField,
    toNumber,
    toText,
  }
  const Field = new Function(...Object.keys(context), `${code}\nreturn ${name}`)(...Object.values(context))
  const render = () => {
    cursor = 0
    let tree = Field(props)
    while (effects.length) {
      for (const effect of effects.splice(0)) effect()
      cursor = 0
      tree = Field(props)
    }
    return tree
  }
  const inputs = () => {
    const found = []
    const walk = node => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'input') found.push(node.props)
      for (const child of node.children || []) walk(child)
    }
    walk(render())
    return found
  }
  const focus = index => inputs()[index].onFocus({ target: { select() {} } })
  const leave = index => inputs()[index].onBlur({})
  // puts `text` into input `index`, as typing does, without leaving it
  const write = (index, text) => inputs()[index].onChange({ target: { value: text } })
  // types `text` into input `index` and leaves it
  const type = (index, text) => {
    focus(index)
    write(index, text)
    leave(index)
  }
  // (Enter leaves the field: the handler blurs its target)
  const press = (index, code, keys = {}) =>
    inputs()[index].onKeyDown({ code, preventDefault() {}, target: { blur: () => leave(index) }, ...keys })
  // the parent renders the field again with other props
  const set = next => {
    props = { ...props, ...next }
  }
  return { inputs, focus, leave, write, type, press, set, shown: () => inputs().map(input => input.value) }
}

// what the fields say on the console while `fn` runs (they warn when a typed entry is not taken)
function warnings(t) {
  const said = []
  t.mock.method(console, 'warn', line => said.push(line))
  return said
}

test('number field: what is typed is computed; an entry that is not taken changes nothing and is said', t => {
  const said = warnings(t)
  const changes = []
  // (a value with more digits than the field shows: putting it "back" must not write the rounded one)
  const field = mountField('FieldNumber', { value: 5.004, dp: 2, min: 0, max: 100, onChange: v => changes.push(v) })
  assert.deepEqual(field.shown(), ['5.00'])
  field.type(0, '10 / 4')
  assert.deepEqual(field.shown(), ['2.50'])
  assert.deepEqual(changes, [2.5])
  field.type(0, 'globalThis.__fieldRan = 1')
  assert.equal(globalThis.__fieldRan, undefined)
  assert.deepEqual(field.shown(), ['2.50'], 'the value the field has')
  field.type(0, '1000')
  assert.deepEqual(field.shown(), ['2.50'], 'out of its range')
  assert.deepEqual(changes, [2.5], 'nothing was written for either')
  assert.deepEqual(said, [
    '[field] the entry is not taken: "g" at 1 is not read',
    '[field] the entry is not taken: above 100',
  ])
  field.press(0, 'ArrowUp')
  field.press(0, 'ArrowDown', { shiftKey: true })
  assert.deepEqual(changes, [2.5, 3.5, 1.5])
  // a step out of the range changes nothing either, and that is not worth a line
  const edge = mountField('FieldNumber', { value: 99.5, dp: 1, min: 0, max: 100, onChange: v => changes.push(v) })
  edge.press(0, 'ArrowUp')
  assert.deepEqual(edge.shown(), ['99.5'])
  // (nor does it leave a half-typed text standing: the field shows its value again at once)
  edge.focus(0)
  edge.write(0, '50')
  edge.press(0, 'ArrowUp')
  assert.deepEqual(edge.shown(), ['99.5'])
  edge.leave(0)
  assert.deepEqual(changes, [2.5, 3.5, 1.5])
  assert.equal(said.length, 2)
  // Leaving a field in which nothing was typed writes nothing: untouched, after a refused step, and after a refused
  // entry. (The text shown was read back, and the rounded value written: 0.004 shown as "0.00" became 0.)
  const fine = []
  const small = mountField('FieldNumber', { value: 0.004, dp: 2, min: 0, max: 10, onChange: v => fine.push(v) })
  assert.deepEqual(small.shown(), ['0.00'])
  small.focus(0)
  small.leave(0)
  small.press(0, 'ArrowDown')
  small.leave(0)
  small.press(0, 'ArrowDown', { shiftKey: true })
  small.press(0, 'Enter')
  small.type(0, 'oops')
  small.leave(0)
  small.type(0, '')
  small.leave(0)
  assert.deepEqual(fine, [])
  assert.deepEqual(small.shown(), ['0.00'])
  // ... also when the field's digits or its value change while it has the focus
  small.focus(0)
  small.set({ dp: 3 })
  small.leave(0)
  small.focus(0)
  small.set({ dp: 2, value: 2.004 })
  small.leave(0)
  assert.deepEqual(fine, [])
  assert.deepEqual(small.shown(), ['2.00'], 'and it shows the new value')
  // What IS typed is written, also when it is the very text the field shows, or shows by then
  small.type(0, '2.00')
  assert.deepEqual(fine, [2])
  small.focus(0)
  small.write(0, '3.00')
  small.set({ value: 3.004 })
  small.press(0, 'Enter')
  assert.deepEqual(fine, [2, 3])
  // typed text is given up for a step: the step is from the value, and the text is not read afterwards
  small.set({ value: 5 })
  small.focus(0)
  small.write(0, '9')
  small.press(0, 'ArrowUp')
  small.leave(0)
  assert.deepEqual(fine, [2, 3, 6])
})

test('vector field: an axis whose entry is not taken keeps its value (it threw: the whole vector was put there)', t => {
  const said = warnings(t)
  const changes = []
  const props = { value: [1, 2, 3], dp: 1, min: -10, max: 10, onChange: v => changes.push(v) }
  const field = mountField('FieldVec3', props)
  assert.deepEqual(field.shown(), ['1.0', '2.0', '3.0'])
  field.type(1, 'PI * 2')
  field.type(1, 'nonsense')
  field.type(2, '99')
  field.type(0, '(1 + 1) * -2')
  assert.deepEqual(field.shown(), ['-4.0', '6.3', '3.0'])
  field.press(2, 'ArrowUp', { shiftKey: true })
  field.press(0, 'ArrowDown', { altKey: true })
  assert.deepEqual(changes, [
    [1, 6.3, 3],
    [-4, 6.3, 3],
    [-4, 6.3, 5],
    [-4.1, 6.3, 5],
  ])
  assert.deepEqual(said, [
    '[field] the entry is not taken: "n" at 1 is not read',
    '[field] the entry is not taken: above 10',
  ])
  // a value with more digits than the field shows (a scale of 0.004 in a field of two digits): an entry that is
  // not taken, or a step out of the range, must not write the rounded value, which here would be zero
  const fine = []
  const small = mountField('FieldVec3', {
    value: [0.004, -9.96, 9.96],
    dp: 1,
    min: -10,
    max: 10,
    onChange: v => fine.push(v),
  })
  assert.deepEqual(small.shown(), ['0.0', '-10.0', '10.0'])
  small.focus(0)
  small.leave(0)
  small.type(0, 'oops')
  small.leave(0)
  small.type(0, '')
  small.press(1, 'ArrowDown')
  small.leave(1)
  small.press(2, 'ArrowUp', { altKey: true })
  small.press(2, 'ArrowUp')
  small.press(2, 'Enter')
  small.leave(2)
  assert.deepEqual(small.shown(), ['0.0', '-10.0', '10.0'])
  assert.deepEqual(fine, [])
  // ... also when the digits or the value change while an axis has the focus
  small.focus(0)
  small.set({ dp: 3 })
  small.leave(0)
  small.focus(1)
  small.set({ dp: 1, value: [0.004, 2.04, 9.96] })
  small.leave(1)
  assert.deepEqual(fine, [])
  assert.deepEqual(small.shown(), ['0.0', '2.0', '10.0'])
  // what is typed into an axis is written, also when it is the text shown; the other axes keep all their digits
  small.type(1, '2.0')
  small.focus(2)
  small.write(2, '7')
  small.set({ value: [0.004, 2, 7.04] })
  small.press(2, 'Enter')
  assert.deepEqual(fine, [
    [0.004, 2, 9.96],
    [0.004, 2, 7],
  ])
  // typed text is given up for a step, and is not read afterwards
  small.focus(1)
  small.write(1, '9')
  small.press(1, 'ArrowUp')
  small.leave(1)
  assert.deepEqual(fine.slice(2), [[0.004, 3, 7]])
  // a refused step shows the axis' value again at once, over a half-typed text, and says nothing
  small.focus(2)
  small.write(2, '1')
  small.press(2, 'ArrowUp', { shiftKey: true })
  small.press(2, 'ArrowUp', { shiftKey: true })
  assert.deepEqual(small.shown(), ['0.0', '3.0', '9.0'])
  small.write(2, '1')
  small.press(2, 'ArrowUp', { shiftKey: true })
  assert.deepEqual(small.shown(), ['0.0', '3.0', '9.0'])
  small.leave(2)
  assert.equal(said.length, 3, 'one line for each typed entry that was not taken, none for a step')
})
