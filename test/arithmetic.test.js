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
// hooks keep their slots, and the tree that comes back is plain objects whose handlers the test calls.
function mountField(name, props) {
  const source = fs.readFileSync(new URL('../src/client/components/Fields.js', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '').replace(/^export /gm, ''), {
    loader: 'jsx',
    jsxFactory: 'element',
    jsxFragment: 'fragment',
  }).code
  const slots = []
  let cursor = 0
  const context = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => (slots[index] = value)]
    },
    useEffect() {},
    useMemo: fn => fn(),
    useRef: current => ({ current }),
    useHintProps: () => ({}),
    css: () => '',
    fragment: 'fragment',
    element: (type, elementProps, ...children) => ({ type, props: elementProps || {}, children: children.flat(9) }),
    readNumberField,
    toNumber,
    toText,
  }
  const Field = new Function(...Object.keys(context), `${code}\nreturn ${name}`)(...Object.values(context))
  const inputs = () => {
    cursor = 0
    const found = []
    const walk = node => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'input') found.push(node.props)
      for (const child of node.children || []) walk(child)
    }
    walk(Field(props))
    return found
  }
  // types `text` into input `index` and leaves it
  const type = (index, text) => {
    inputs()[index].onChange({ target: { value: text } })
    inputs()[index].onBlur({})
  }
  const press = (index, code, keys = {}) => inputs()[index].onKeyDown({ code, preventDefault() {}, ...keys })
  return { inputs, type, press, shown: () => inputs().map(input => input.value) }
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
  assert.deepEqual(field.shown(), ['5.00'], 'the value the field was given')
  field.type(0, '1000')
  assert.deepEqual(field.shown(), ['5.00'], 'out of its range')
  assert.deepEqual(changes, [2.5], 'nothing was written for either')
  assert.deepEqual(said, [
    '[field] the entry is not taken: "g" at 1 is not read',
    '[field] the entry is not taken: above 100',
  ])
  field.press(0, 'ArrowUp')
  field.press(0, 'ArrowDown', { shiftKey: true })
  assert.deepEqual(changes, [2.5, 6, 3])
  // a step out of the range changes nothing either, and that is not worth a line
  const edge = mountField('FieldNumber', { value: 99.5, dp: 1, min: 0, max: 100, onChange: v => changes.push(v) })
  edge.press(0, 'ArrowUp')
  assert.deepEqual(edge.shown(), ['99.5'])
  assert.deepEqual(changes, [2.5, 6, 3])
  assert.equal(said.length, 2)
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
  assert.deepEqual(field.shown(), ['-4.0', '2.0', '3.0'])
  field.press(2, 'ArrowUp', { shiftKey: true })
  field.press(0, 'ArrowDown', { altKey: true })
  assert.deepEqual(changes, [
    [1, 6.3, 3],
    [-4, 2, 3],
    [1, 2, 5],
    [0.9, 2, 3],
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
  small.type(0, 'oops')
  small.press(1, 'ArrowDown')
  small.press(2, 'ArrowUp')
  assert.deepEqual(small.shown(), ['0.0', '-10.0', '10.0'])
  assert.deepEqual(fine, [])
  assert.equal(said.length, 3, 'one more line, for what was typed; none for the two steps')
})
