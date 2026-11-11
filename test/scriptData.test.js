// What a script hands the engine to send is read by readScriptData before a packer sees it (scriptData.js says
// why: the packer cannot be entered twice, and reading a script's value runs the script's code). Two claims:
// the copy packs to the bytes the value itself packed to, for what scripts send; and packing the copy runs no
// script code, whatever the value was.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_VALUES, readScriptData, TOO_MANY_VALUES } from '../src/core/extras/scriptData.js'
import { readPacket, writeClientPacket, writePacket } from '../src/core/packets.js'

const WRITERS = [
  ['server', data => writePacket('entityEvent', ['app', 0, 'probe', data])],
  ['client', data => writeClientPacket('entityEvent', ['app', 0, 'probe', data])],
]
const bytes = packet => Buffer.from(packet).toString('hex')
const attempt = fn => {
  try {
    return { bytes: bytes(fn()) }
  } catch (err) {
    return { error: `${err.constructor.name}: ${err.message}` }
  }
}

class Point {
  constructor(x, y) {
    this.x = x
    this.y = y
  }
  length() {
    return Math.hypot(this.x, this.y)
  }
}
class Money {
  constructor(amount) {
    this.amount = amount
  }
  toJSON() {
    return { yen: this.amount }
  }
}
function shared() {
  const part = { n: 1, list: [1, 2] }
  return { a: part, b: part, c: [part, part] }
}
function circular() {
  const root = { name: 'root', children: [] }
  root.children.push({ parent: root }, root)
  root.self = root
  return root
}
function nullProto() {
  const object = Object.create(null)
  object.a = 1
  object.nested = Object.create(null)
  object.nested.b = [true]
  return object
}
function withFunctionToJSON() {
  const fn = () => 1
  fn.toJSON = () => ({ was: 'a function' })
  return { fn }
}
function inherited() {
  const object = Object.create({ fromProto: 1 })
  object.own = 2
  return object
}

// each entry makes a new value (nothing in them has side effects, so the value itself can be packed for comparison)
const CORPUS = {
  'plain object': () => ({ a: 1, b: 'two', c: [3, { d: null }], e: true, f: undefined }),
  'empty object and array': () => ({ o: {}, a: [] }),
  numbers: () => [
    0,
    -0,
    1,
    -1,
    1.5,
    255,
    256,
    65535,
    65536,
    2 ** 31,
    2 ** 32,
    2 ** 53,
    -(2 ** 31) - 1,
    NaN,
    Infinity,
    -Infinity,
  ],
  bigints: () => [0n, 1n, -1n, 2n ** 62n, -(2n ** 62n)],
  strings: () => [
    '',
    'a',
    'x'.repeat(31),
    'x'.repeat(32),
    'x'.repeat(300),
    'x'.repeat(70000),
    '日本語',
    '😀',
    '\u0000',
  ],
  'null and undefined': () => [null, undefined, { n: null, u: undefined }],
  'nested arrays': () => [[1, [2, [3, [4, [5]]]]], [[]], [[[]]]],
  'sparse array': () => {
    const list = [1, , 3] // eslint-disable-line no-sparse-arrays
    list.length = 5
    return list
  },
  'array with extra properties': () => Object.assign([1, 2], { note: 'x' }),
  'the same shape many times': () => Array.from({ length: 40 }, (_, i) => ({ id: i, name: `n${i}`, at: [i, i] })),
  'many shapes': () => Array.from({ length: 80 }, (_, i) => ({ [`k${i}`]: i, common: 1 })),
  'class instance': () => ({ p: new Point(1, 2), list: [new Point(3, 4)] }),
  'class instance with toJSON': () => ({ price: new Money(5), list: [new Money(6)] }),
  'plain object with a toJSON (not used: it is a plain object)': () => ({ toJSON: () => 'no', a: 1 }),
  'function values': () => ({ fn() {}, arrow: () => 1, list: [() => 1, 2] }),
  'function with toJSON': withFunctionToJSON,
  'inherited enumerable properties are not sent': inherited,
  'object without a prototype': nullProto,
  'keys that mean something to an object': () => ({
    constructor: 'x',
    hasOwnProperty: 1,
    then: 2,
    length: 3,
    valueOf: 4,
  }),
  'a __proto__ key': () => JSON.parse('{"__proto__": {"a": 1}, "b": 2}'),
  'numeric keys': () => ({ 2: 'b', 1: 'a', x: 'c' }),
  date: () => ({ at: new Date(1_700_000_000_123), list: [new Date(0), new Date(8.64e15)] }),
  'invalid date': () => new Date(NaN),
  map: () =>
    new Map([
      ['a', 1],
      [2, { b: [3] }],
      [{ key: 'object' }, new Map([['inner', true]])],
    ]),
  set: () => new Set([1, 'two', { three: 3 }, [4]]),
  'byte arrays': () => ({
    u8: new Uint8Array([1, 2, 3]),
    empty: new Uint8Array(0),
    big: new Uint8Array(70000).fill(7),
  }),
  'typed arrays': () => ({
    u8: new Uint8Array([1, 2, 3]),
    i8: new Int8Array([-1, 2]),
    c8: new Uint8ClampedArray([255, 0]),
    i16: new Int16Array([-2, 3]),
    u16: new Uint16Array([65535]),
    i32: new Int32Array([-5]),
    u32: new Uint32Array([4_000_000_000]),
    f32: new Float32Array([1.5, -2.25]),
    f64: new Float64Array([Math.PI]),
    empty: new Uint8Array(0),
  }),
  '64-bit typed arrays': () => [new BigInt64Array([-(2n ** 60n)]), new BigUint64Array([2n ** 63n])],
  'a view of part of a buffer': () => new Uint8Array(new Uint8Array([9, 8, 7, 6, 5, 4]).buffer, 2, 3),
  'a 16-bit view at an offset': () => new Uint16Array(new Uint16Array([1, 2, 3, 4]).buffer, 2, 2),
  'array buffer': () => ({ buffer: new Uint8Array([1, 2, 3, 4]).buffer, empty: new ArrayBuffer(0) }),
  'data view': () => new DataView(new ArrayBuffer(4)),
  error: () => ({ e: new Error('boom'), t: new TypeError('type', { cause: { code: 7 } }) }),
  regexp: () => [/a+b/gi, /(?:)/, new RegExp('\\d+', 'u')],
  'boxed primitives': () => [new String('ab'), new Number(5), new Boolean(false)],
  'shared references': shared,
  'a Node Buffer': () => ({ b: Buffer.from([1, 2]), part: Buffer.from([9, 8, 7, 6]).subarray(1, 3) }),
  'an object without a prototype, with a toJSON (used: its constructor is not Object)': () =>
    Object.assign(Object.create(null), { a: 1, toJSON: () => 'json' }),
  'an inherited toJSON on an object whose constructor is Object (not used)': () =>
    Object.assign(Object.create({ toJSON: () => 'json' }), { a: 1 }),
  'a toJSON whose result holds its owner': () => {
    class Owner {
      toJSON() {
        return { self: this, n: 1 }
      }
    }
    return [new Owner()]
  },
  'deep nesting': () => {
    let value = { leaf: true }
    for (let i = 0; i < 200; i++) value = i % 2 ? [value] : { value }
    return value
  },
}

// A client's packer (msgpackr without its extra types) writes a typed array that is not a byte array as that many
// BYTES of it: one byte per element, then whatever its buffer held before. Those trailing bytes differ from one pack
// to the next, with or without the copy, so there is nothing to compare (and nothing a server could use: noted for
// the correctness phase).
const NOT_COMPARABLE_ON_A_CLIENT = ['typed arrays', 'a 16-bit view at an offset']

test('the copy packs to the bytes the value itself packs to, on the server and on a client', () => {
  const refused = []
  for (const [name, make] of Object.entries(CORPUS)) {
    for (const [side, write] of WRITERS) {
      if (side === 'client' && NOT_COMPARABLE_ON_A_CLIENT.includes(name)) continue
      const direct = attempt(() => write(make()))
      const copied = attempt(() => write(readScriptData(make())))
      assert.deepEqual(copied, direct, `${name} (${side})`)
      if (direct.error) refused.push(`${name} (${side}): ${direct.error}`)
    }
  }
  // (what the packer cannot pack, it cannot pack after the copy either, with the same error; nothing else fails)
  assert.deepEqual(refused, [
    '64-bit typed arrays (client): TypeError: Cannot mix BigInt and other types, use explicit conversions',
    // (a circle cannot be packed by a client's packer, which keeps no references)
    'a toJSON whose result holds its owner (client): RangeError: Maximum call stack size exceeded',
  ])
})

test('what a packer refuses is refused the same after the copy; circular data is kept for the server', () => {
  for (const [name, make] of [
    ['a symbol', () => ({ s: Symbol('x') })],
    ['a symbol alone', () => Symbol('x')],
  ]) {
    for (const [side, write] of WRITERS) {
      const direct = attempt(() => write(make()))
      assert.match(direct.error, /Unknown type: symbol/, `${name} (${side})`)
      assert.deepEqual(
        attempt(() => write(readScriptData(make()))),
        direct,
        `${name} (${side})`
      )
    }
  }
  // the server's packer keeps references: the copy has the value's shape, and reads back with it
  const [, data] = readPacket(writePacket('entityEvent', ['app', 0, 'probe', readScriptData(circular())]))
  const root = data[3]
  assert.equal(root.self, root)
  assert.equal(root.children[0].parent, root)
  assert.equal(root.children[1], root)
  assert.deepEqual(
    bytes(writePacket('snapshot', readScriptData(circular()))),
    bytes(writePacket('snapshot', circular()))
  )
  const twice = readScriptData(shared())
  assert.equal(twice.a, twice.b)
  assert.equal(twice.c[0], twice.a)
  // a client's packer does not: circular data cannot be packed there, with or without the copy
  assert.throws(() => writeClientPacket('entityEvent', ['app', 0, 'probe', circular()]), RangeError)
  assert.throws(() => writeClientPacket('entityEvent', ['app', 0, 'probe', readScriptData(circular())]), RangeError)
})

test("the copy is the engine's: new objects of its own classes, no accessors, nothing shared with the value", () => {
  const bytesIn = new Uint8Array([1, 2, 3])
  const value = {
    get computed() {
      return [1, { two: 2 }]
    },
    point: new Point(1, 2),
    bytes: bytesIn,
    when: new Date(5),
    map: new Map([['k', { v: 1 }]]),
    set: new Set([{ v: 2 }]),
    error: new RangeError('r'),
  }
  const copy = readScriptData(value)
  assert.deepEqual(Object.getOwnPropertyDescriptor(copy, 'computed'), {
    value: [1, { two: 2 }],
    writable: true,
    enumerable: true,
    configurable: true,
  })
  assert.equal(Object.getPrototypeOf(copy.point), Object.prototype)
  assert.deepEqual(copy.point, { x: 1, y: 2 })
  assert.notEqual(copy.bytes, bytesIn)
  assert.notEqual(copy.bytes.buffer, bytesIn.buffer)
  bytesIn[0] = 99
  assert.deepEqual([...copy.bytes], [1, 2, 3])
  assert.notEqual(copy.when, value.when)
  assert.equal(copy.when.getTime(), 5)
  assert.notEqual(copy.map, value.map)
  assert.notEqual(copy.map.get('k'), value.map.get('k'))
  assert.deepEqual(copy.map.get('k'), { v: 1 })
  assert.notEqual([...copy.set][0], [...value.set][0])
  assert.equal(copy.error.constructor, Error)
  assert.equal(copy.error.name, 'RangeError')
  assert.equal(copy.error.message, 'r')
  // a key named __proto__ is a property of the copy, not its prototype
  const odd = readScriptData(JSON.parse('{"__proto__": {"polluted": true}}'))
  assert.equal(Object.getPrototypeOf(odd), Object.prototype)
  assert.equal({}.polluted, undefined)
  assert.deepEqual(Object.keys(odd), ['__proto__'])
})

// where the copy's bytes differ from the value's (scriptData.js lists the three cases): the receiver reads the same,
// but for a Set on a client and a subclass of a built-in
test("where the bytes of the copy differ from the value's: what the receiver reads", () => {
  const sent = (data, write) =>
    readPacket(Uint8Array.prototype.slice.call(write('entityEvent', ['app', 0, 'p', data])))[1][3]
  const plain = value =>
    value instanceof Map
      ? [...value].map(([key, entry]) => [plain(key), plain(entry)])
      : value instanceof Set
        ? [...value]
        : value
  class Seven {
    toJSON() {
      return 7
    }
  }
  const cases = {
    'an instance whose toJSON is a primitive, twice': () => {
      const seven = new Seven()
      return [seven, seven, { again: seven }]
    },
    'a function, twice': () => {
      const fn = () => {}
      return [fn, fn, 1]
    },
    'a Set of two functions': () => new Set([() => {}, () => {}, 3]),
    'a Map with two functions as keys': () => new Map([[() => {}, 1], [() => {}, 2], ['k', 3]]), // prettier-ignore
    'a Set of two instances with the same toJSON result': () => new Set([new Seven(), new Seven()]),
  }
  for (const [name, make] of Object.entries(cases)) {
    for (const [side, write] of [
      ['server', writePacket],
      ['client', writeClientPacket],
    ]) {
      // (a client's packer writes a Set as an array: see below)
      if (side === 'client' && name.startsWith('a Set')) continue
      assert.deepEqual(plain(sent(readScriptData(make()), write)), plain(sent(make(), write)), `${name} (${side})`)
    }
  }
  // a client's packer has no Set: it writes one as an array, so there the entries that became equal are one
  // element where they were several
  assert.deepEqual(sent(cases['a Set of two functions'](), writeClientPacket), [undefined, undefined, 3])
  assert.deepEqual(sent(readScriptData(cases['a Set of two functions']()), writeClientPacket), [undefined, 3])
  // a subclass of a built-in is copied as the built-in, with its contents
  class Rows extends Map {}
  class Bytes extends Uint8Array {}
  const copy = readScriptData({ rows: new Rows([['a', 1]]), bytes: new Bytes([1, 2]) })
  assert.equal(copy.rows.constructor, Map)
  assert.deepEqual([...copy.rows], [['a', 1]])
  assert.equal(copy.bytes.constructor, Uint8Array)
  assert.deepEqual([...copy.bytes], [1, 2])
})

test('a value met twice is read once, also a function with a toJSON and an owner inside its own toJSON result', () => {
  let calls = 0
  const fn = () => {}
  fn.toJSON = () => ({ n: ++calls })
  const copy = readScriptData([fn, fn, { fn }])
  assert.equal(calls, 1)
  assert.deepEqual(copy[0], { n: 1 })
  assert.equal(copy[1], copy[0])
  assert.equal(copy[2].fn, copy[0])
  class Owner {
    constructor() {
      this.reads = 0
    }
    toJSON() {
      this.reads++
      return { self: this, list: [this] }
    }
  }
  const owner = new Owner()
  const circle = readScriptData({ owner, again: owner })
  assert.equal(owner.reads, 1)
  assert.equal(circle.owner.self, circle.owner)
  assert.equal(circle.owner.list[0], circle.owner)
  assert.equal(circle.again, circle.owner)
  // owners whose toJSON results are each other, and nothing else: an empty object, as the server's packer had them
  class Other {
    toJSON() {
      return this.other
    }
  }
  const a = new Other()
  const b = new Other()
  a.other = b
  b.other = a
  assert.deepEqual(readScriptData(a), {})
  assert.deepEqual(readPacket(writePacket('snapshot', a))[1], {})
  assert.deepEqual(readPacket(writePacket('snapshot', readScriptData([a, b])))[1], [{}, {}])
  // a toJSON result stands for its owner wherever the owner is met: two owners of one result that holds them both
  class Shared {
    toJSON() {
      return this.result
    }
  }
  const first = new Shared()
  const second = new Shared()
  first.result = second.result = { first, second }
  const both = readScriptData(first)
  assert.equal(both.first, both)
  assert.equal(both.second, both)
  // a Proxy of an error says it is an ordinary object: it is still the error it stands for, as the packer took it
  const proxied = readScriptData(new Proxy(new TypeError('boom', { cause: 7 }), {}))
  assert.ok(proxied instanceof Error)
  assert.deepEqual([proxied.name, proxied.message, proxied.cause], ['TypeError', 'boom', 7])
  for (const [, write] of WRITERS) {
    assert.equal(bytes(write(proxied)), bytes(write(new Proxy(new TypeError('boom', { cause: 7 }), {}))))
  }
})

test('the values of a message are counted: an array that says any length is refused before it is read', () => {
  // a Proxy's answer
  let reads = 0
  const endless = new Proxy([], {
    get(target, key, receiver) {
      if (key === 'length') return Number.MAX_SAFE_INTEGER
      reads++
      return Reflect.get(target, key, receiver)
    },
  })
  assert.throws(() => readScriptData({ endless }), { name: 'RangeError', message: TOO_MANY_VALUES })
  assert.ok(reads < 10, `${reads} reads`)
  // a real array of the largest length (all holes)
  const sparse = []
  sparse.length = 2 ** 32 - 1
  assert.throws(() => readScriptData(sparse), { name: 'RangeError', message: TOO_MANY_VALUES })
  // the count is of values, wherever they are: MAX_VALUES values pass, one more does not
  const most = new Array(MAX_VALUES - 1).fill(0)
  assert.equal(readScriptData(most).length, MAX_VALUES - 1)
  assert.throws(() => readScriptData([most, 0]), { message: TOO_MANY_VALUES })
  const nested = Array.from({ length: 1024 }, () => new Array(MAX_VALUES / 1024).fill(0))
  assert.throws(() => readScriptData(nested), { message: TOO_MANY_VALUES })
  assert.throws(() => readScriptData(new Map(most.map((_, i) => [i, i]))), { message: TOO_MANY_VALUES })
  assert.throws(() => readScriptData(new Set(most.concat([1]).map((_, i) => i))), { message: TOO_MANY_VALUES })
  // an owner and its toJSON result are one value (Codex: 262,144 instances whose toJSON is 0 pack to 262,159
  // bytes, under the largest packet, and were counted twice and refused)
  class Zero {
    toJSON() {
      return 0
    }
  }
  const zeros = Array.from({ length: MAX_VALUES - 1 }, () => new Zero())
  assert.equal(readScriptData(zeros).length, MAX_VALUES - 1)
  assert.ok(writePacket('entityEvent', ['app', 0, 'probe', readScriptData(zeros)]).length <= MAX_VALUES + 32)
  const one = new Zero()
  assert.equal(readScriptData(new Array(MAX_VALUES - 1).fill(one)).length, MAX_VALUES - 1)
  class Self {
    toJSON() {
      return { owners: new Array(MAX_VALUES - 3).fill(this) }
    }
  }
  assert.equal(readScriptData(new Self()).owners.length, MAX_VALUES - 3)
  // and such a message could not have been sent: it is over the largest packet
  assert.ok(writePacket('entityEvent', ['app', 0, 'probe', most]).length > MAX_VALUES)
})

// Every way a value can carry code: each piece of it logs when it runs. The value is read (the code runs: it is
// counted), then the copy is packed and read back by both packers: nothing more may run.
function hostile(log) {
  const note = what => {
    log.push(what)
  }
  const trapped = target =>
    new Proxy(target, {
      get(object, key, receiver) {
        note(`proxy get ${String(key)}`)
        return Reflect.get(object, key, receiver)
      },
      has(object, key) {
        note('proxy has')
        return Reflect.has(object, key)
      },
      ownKeys(object) {
        note('proxy ownKeys')
        return Reflect.ownKeys(object)
      },
      getOwnPropertyDescriptor(object, key) {
        note('proxy descriptor')
        return Reflect.getOwnPropertyDescriptor(object, key)
      },
      getPrototypeOf(object) {
        note('proxy prototype')
        return Reflect.getPrototypeOf(object)
      },
    })
  class Species extends Uint8Array {
    static get [Symbol.species]() {
      note('species')
      return Uint8Array
    }
  }
  class Loud {
    constructor() {
      this.kept = 1
    }
    toJSON() {
      note('toJSON')
      return {
        from: 'toJSON',
        get late() {
          note('getter in toJSON result')
          return 1
        },
      }
    }
  }
  Object.defineProperty(Loud.prototype, 'constructor', {
    get() {
      note('constructor getter')
      return Loud
    },
  })
  const species = new Species([1, 2, 3])
  Object.defineProperty(species, 'constructor', {
    get() {
      note('typed array constructor getter')
      return Species
    },
  })
  const map = new Map([[{ get k() { note('map key getter'); return 1 } }, { get v() { note('map value getter'); return 2 } }]]) // prettier-ignore
  map.forEach = () => note('own forEach')
  map[Symbol.iterator] = () => {
    note('own iterator')
    return [][Symbol.iterator]()
  }
  const date = new Date(7)
  date.getTime = () => note('own getTime')
  date.toJSON = () => note('date toJSON')
  const error = new Error('e')
  Object.defineProperty(error, 'message', { get: () => (note('message getter'), 'm') })
  const regexp = /x/g
  Object.defineProperty(regexp, 'flags', { get: () => (note('own flags getter'), 'g') })
  const fn = () => {}
  Object.defineProperty(fn, 'toJSON', { get: () => (note('function toJSON getter'), undefined) })
  return {
    get getter() {
      note('getter')
      return { get inner() { note('inner getter'); return 1 } } // prettier-ignore
    },
    proxy: trapped({ a: 1, b: { c: 2 } }),
    proxiedArray: trapped([1, 2, 3]),
    loud: new Loud(),
    species,
    map,
    set: new Set([trapped({ in: 'set' })]),
    date,
    error,
    regexp,
    fn,
    own: {
      hasOwnProperty() {
        note('own hasOwnProperty')
        return true
      },
      [Symbol.toPrimitive]() {
        note('toPrimitive')
        return 1
      },
      valueOf() {
        note('valueOf')
        return 1
      },
      toString() {
        note('toString')
        return 's'
      },
      get then() {
        note('then getter')
        return undefined
      },
      get [Symbol.toStringTag]() {
        note('toStringTag')
        return 'Map'
      },
    },
  }
}

test('packing the copy runs no script code, whatever the value carried', () => {
  const log = []
  const copy = readScriptData(hostile(log))
  assert.ok(log.length > 20, 'the value was read')
  for (const once of [
    'getter',
    'inner getter',
    'toJSON',
    'getter in toJSON result',
    'map key getter',
    'map value getter',
  ]) {
    assert.equal(log.filter(entry => entry === once).length, 1, `${once} ran once`)
  }
  // the built-ins were read with the built-ins' own methods
  for (const never of [
    'species',
    'own forEach',
    'own iterator',
    'own getTime',
    'own hasOwnProperty',
    'toPrimitive',
    'valueOf',
    'toString',
  ]) {
    assert.ok(!log.includes(never), `${never} was not used`)
  }
  const read = log.length
  for (const [side, write] of WRITERS) {
    const packet = write(copy)
    readPacket(packet)
    assert.deepEqual(log.slice(read), [], `packing the copy on the ${side} ran script code`)
  }
  assert.deepEqual(copy.proxy, { a: 1, b: { c: 2 } })
  assert.deepEqual(copy.proxiedArray, [1, 2, 3])
  assert.deepEqual(copy.loud, { from: 'toJSON', late: 1 })
  assert.equal(copy.species.constructor, Uint8Array)
  assert.deepEqual([...copy.species], [1, 2, 3])
  assert.deepEqual([...copy.map], [[{ k: 1 }, { v: 2 }]])
  assert.equal(copy.date.getTime(), 7)
  assert.equal(copy.error.message, 'm')
  assert.equal(copy.regexp.source, 'x')
  assert.equal(copy.fn, undefined)
  // and reading the same value again runs the same code, in the same order
  const second = []
  readScriptData(hostile(second))
  assert.deepEqual(second, log.slice(0, read))
})

// the reason for all this: code in the value that sends. Both messages are whole, at any write position of the
// packer's buffer and with data on both sides of its size (entering msgpackr twice near the end of its buffer made
// the outer pack write outside it, and the next message of anyone throw)
test('a getter that sends while its message is read: both messages are whole, and so is the next', () => {
  const sizes = [60, 2500, 9000, 40_000]
  for (let step = 0; step < 400; step++) {
    writePacket('chatAdded', 'f'.repeat(1 + ((step * 37) % 1900))) // moves the write position on
    for (const client of [false, true]) {
      const big = sizes[step % sizes.length]
      const innerSize = sizes[(step + 1) % sizes.length]
      const inner = []
      const data = {
        first: { body: 'x'.repeat((step * 53) % 2100) },
        get nested() {
          // (the shape of a part the outer message has already written)
          inner.push(Uint8Array.prototype.slice.call(writePacket('chatAdded', { body: 'i'.repeat(innerSize) })))
          inner.push(readScriptData({ body: 'j'.repeat(innerSize) }))
          return 1
        },
        after: 'z'.repeat(big),
        last: { deep: 'q'.repeat(big) },
      }
      const copy = readScriptData(data)
      const write = client ? writeClientPacket : writePacket
      const sent = readPacket(Uint8Array.prototype.slice.call(write('entityEvent', ['app', 0, 'probe', copy])))[1][3]
      const outer = sent instanceof Map ? Object.fromEntries(sent) : sent
      for (const key of ['first', 'last']) if (outer[key] instanceof Map) outer[key] = Object.fromEntries(outer[key])
      assert.deepEqual(outer, {
        first: { body: 'x'.repeat((step * 53) % 2100) },
        nested: 1,
        after: 'z'.repeat(big),
        last: { deep: 'q'.repeat(big) },
      })
      assert.equal(inner.length, 2)
      assert.deepEqual(readPacket(inner[0]), ['onChatAdded', { body: 'i'.repeat(innerSize) }])
      assert.equal(inner[1].body, 'j'.repeat(innerSize))
      assert.equal(copy.nested, 1)
      assert.equal(copy.after.length, big)
      assert.equal(copy.last.deep.length, big)
      const next = Uint8Array.prototype.slice.call(writePacket('chatAdded', { body: 'later', id: 'x' }))
      assert.deepEqual(readPacket(next), ['onChatAdded', { body: 'later', id: 'x' }], `step ${step}`)
    }
  }
})
