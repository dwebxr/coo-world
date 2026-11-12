// The arithmetic a number field of the builder accepts: `1.5 * 2`, `90 / 4`, `(10 + 0.25) * -2`, `2 ** 8`,
// `Math.PI / 2`, `sqrt(2)`.
//
// The fields used to hand what was typed to `eval`: any JavaScript typed or pasted into a number field ran in the
// page, with the page's session and its wallet connections. What is read here is numbers, the operators + - * / %
// and **, parentheses, the constants PI and E, and the functions listed below (each with or without `Math.`).
// Anything else is refused, and nothing typed is ever run.
const FUNCTIONS = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
}
const CONSTANTS = { PI: Math.PI, pi: Math.PI, E: Math.E }

// what is typed into a field is short; a text beyond this is not read at all (a paste of megabytes is not parsed,
// and the parser, which calls itself once for each parenthesis or sign, goes no deeper than this many levels)
export const ARITHMETIC_MAX_LENGTH = 200

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const NAME = /^(?:Math\.)?([A-Za-z]+)/

// The value of `text`, a finite number, or an Error saying what was not read.
export function evaluateArithmetic(text) {
  if (typeof text !== 'string') throw new Error('not a text')
  if (text.length > ARITHMETIC_MAX_LENGTH) throw new Error('too long')
  let at = 0
  const skip = () => {
    while (at < text.length && /\s/.test(text[at])) at++
  }
  const eat = token => {
    skip()
    if (!text.startsWith(token, at)) return false
    at += token.length
    return true
  }
  const fail = () => new Error(at < text.length ? `"${text[at]}" at ${at + 1} is not read` : 'it ends too early')

  // sum := product (('+' | '-') product)*
  const sum = () => {
    let value = product()
    for (;;) {
      if (eat('+')) value += product()
      else if (eat('-')) value -= product()
      else return value
    }
  }
  // product := signed (('*' | '/' | '%') signed)*      (a `**` never gets here: `power` below has taken it)
  const product = () => {
    let value = signed()
    for (;;) {
      if (eat('*')) value *= signed()
      else if (eat('/')) value /= signed()
      else if (eat('%')) value %= signed()
      else return value
    }
  }
  // signed := ('+' | '-') signed | power
  const signed = () => {
    if (eat('-')) return -signed()
    if (eat('+')) return signed()
    return power()
  }
  // power := primary ('**' signed)?      (right to left, and `-2 ** 2` is -(2 ** 2), as it is in arithmetic)
  const power = () => {
    const base = primary()
    if (eat('**')) return base ** signed()
    return base
  }
  // primary := number | '(' sum ')' | constant | function '(' sum (',' sum)* ')'
  const primary = () => {
    skip()
    if (eat('(')) {
      const value = sum()
      if (!eat(')')) throw fail()
      return value
    }
    const number = NUMBER.exec(text.slice(at))
    if (number) {
      at += number[0].length
      return Number(number[0])
    }
    const name = NAME.exec(text.slice(at))
    if (name) {
      const word = name[1]
      if (Object.hasOwn(CONSTANTS, word)) {
        at += name[0].length
        return CONSTANTS[word]
      }
      if (Object.hasOwn(FUNCTIONS, word)) {
        at += name[0].length
        if (!eat('(')) throw fail()
        const args = [sum()]
        while (eat(',')) args.push(sum())
        if (!eat(')')) throw fail()
        return FUNCTIONS[word](...args)
      }
    }
    throw fail()
  }

  const value = sum()
  skip()
  if (at < text.length) throw fail()
  if (!Number.isFinite(value)) throw new Error('not a finite number')
  return value
}

// What a number field takes from its input: `{ value }`, the number itself when it was handed one (the arrow keys
// add a step to the current value) or the value of the arithmetic when it was handed text; or `{ refused }`, with
// the reason, for what is not read, is not finite or lies outside [min, max]. The field then keeps what it had.
export function readNumberField(input, { min = -Infinity, max = Infinity } = {}) {
  let value
  if (typeof input === 'number') {
    value = input
  } else {
    try {
      value = evaluateArithmetic(input)
    } catch (err) {
      return { refused: err.message }
    }
  }
  if (!Number.isFinite(value)) return { refused: 'not a finite number' }
  if (value < min) return { refused: `below ${min}` }
  if (value > max) return { refused: `above ${max}` }
  return { value }
}
