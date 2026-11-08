import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import fs from 'node:fs'

const sourceUrl = new URL('../src/core/extras/cleanIntrinsics.js', import.meta.url)

// The cleanup in a fresh realm (its own Function.prototype), so this process's built-ins are untouched.
function realm() {
  const source = fs.readFileSync(sourceUrl, 'utf8').replace('export function', 'function')
  const context = vm.createContext({})
  vm.runInContext(source, context)
  return {
    // arrays from the other realm are copied so deepStrictEqual compares them by value
    clean: report => [...vm.runInContext('cleanFunctionPrototype', context)(report)],
    run: code => vm.runInContext(code, context),
  }
}

// errors from the other realm have its own TypeError
const isTypeError = err => err?.name === 'TypeError'

// What iPhone Brave leaves: an undeletable `call` on Function.prototype.apply.
const braveLike = `Object.defineProperty(Function.prototype.apply, 'call', {
  value: Function.prototype.call, configurable: false, writable: false, enumerable: false })`

test('clean intrinsics: nothing changes on an untouched Function.prototype', () => {
  const r = realm()
  const before = r.run('[Function.prototype.apply, Function.prototype.call]')
  const reports = []
  assert.deepEqual(
    r.clean(line => reports.push(line)),
    []
  )
  assert.deepEqual(reports, [])
  const after = r.run('[Function.prototype.apply, Function.prototype.call]')
  assert.equal(after[0], before[0])
  assert.equal(after[1], before[1])
})

test('clean intrinsics: an apply carrying an undeletable addition is replaced by a clean, equivalent one', () => {
  const r = realm()
  r.run(braveLike)
  const original = r.run('Function.prototype.apply')
  const reports = []
  assert.deepEqual(
    r.clean(line => reports.push(line)),
    ['apply (call)']
  )
  assert.equal(reports.length, 1)
  assert.match(reports[0], /apply \(call\)/)
  const apply = r.run('Function.prototype.apply')
  assert.notEqual(apply, original, 'replaced')
  assert.equal(original.call, r.run('Function.prototype.call'), "the browser's copy keeps its addition")
  // the same shape as the built-in: no own prototype, only length and name, length 2, name 'apply'
  assert.deepEqual(Reflect.ownKeys(apply).sort(), ['length', 'name'])
  assert.equal(apply.length, 2)
  assert.equal(apply.name, 'apply')
  const descriptor = r.run("Object.getOwnPropertyDescriptor(Function.prototype, 'apply')")
  assert.equal(descriptor.enumerable, false)
  assert.equal(descriptor.writable, true)
  assert.equal(descriptor.configurable, true)
  // and the same behaviour
  assert.equal(r.run('Math.max.apply(null, [1, 5, 3])'), 5)
  assert.equal(r.run('(function (a, b) { return this.x + a + b }).apply({ x: 1 }, [2, 3])'), 6)
  assert.equal(r.run('(function () { return arguments.length }).apply(null, undefined)'), 0)
  assert.equal(r.run('(function () { return arguments.length }).apply(null, null)'), 0)
  assert.equal(
    r.run("(function () { return [].join.call(arguments, '') }).apply(null, { length: 2, 0: 'a', 1: 'b' })"),
    'ab'
  )
  assert.throws(() => r.run('(function () {}).apply(null, 1)'), isTypeError)
  assert.throws(() => r.run('Function.prototype.apply.call({}, null, [])'), isTypeError)
})

test('clean intrinsics: the same for call; configurable additions are left to lockdown', () => {
  const r = realm()
  r.run(`Object.defineProperty(Function.prototype.call, 'brave', { value: 1, configurable: false })`)
  r.run(`Object.defineProperty(Function.prototype.apply, 'deletable', { value: 1, configurable: true })`)
  assert.deepEqual(
    r.clean(() => {}),
    ['call (brave)']
  )
  const call = r.run('Function.prototype.call')
  assert.equal(call.length, 1)
  assert.equal(call.name, 'call')
  assert.equal(r.run('(function (a, b) { return this.x + a + b }).call({ x: 1 }, 2, 3)'), 6)
  assert.equal(r.run("Object.hasOwn(Function.prototype.apply, 'deletable')"), true, 'apply untouched')
})

test('clean intrinsics: a method locked in place is left for lockdown to report', () => {
  const r = realm()
  r.run(braveLike)
  r.run(`Object.defineProperty(Function.prototype, 'apply', { configurable: false, writable: false })`)
  assert.deepEqual(
    r.clean(() => {}),
    []
  )
})

// The real SES with the real lockdown config, in subprocesses.
function lockdownWith(prelude, { clean = true } = {}) {
  const lockdownUrl = new URL('../src/core/lockdown.js', import.meta.url).href
  const script = `
    ${prelude}
    await import('ses')
    try {
      ${clean ? `await import(${JSON.stringify(lockdownUrl)})` : 'lockdown()'}
      console.log(JSON.stringify({
        ok: true,
        frozen: Object.isFrozen(Function.prototype),
        braveCall: Object.hasOwn(Function.prototype.apply, 'call'),
        max: Math.max.apply(null, [1, 5, 3]),
        sum: (function (a, b) { return this.x + a + b }).call({ x: 1 }, 2, 3),
      }))
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: String(err && err.message) }))
    }
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  return { result: JSON.parse(run.stdout.trim().split('\n').pop()), stderr: run.stderr }
}

test('clean intrinsics: without the cleanup, the Brave addition stops SES lockdown', () => {
  const { result } = lockdownWith(braveLike, { clean: false })
  assert.equal(result.ok, false)
  assert.match(result.error, /delete/i)
})

test('clean intrinsics: with the cleanup, lockdown completes and the intrinsics are frozen and clean', () => {
  const { result, stderr } = lockdownWith(braveLike)
  assert.deepEqual(result, { ok: true, frozen: true, braveCall: false, max: 5, sum: 6 })
  assert.match(stderr, /\[lockdown\] replaced Function\.prototype methods .*apply \(call\)/)
  // a plain environment: no replacement, no message
  const plain = lockdownWith('')
  assert.deepEqual(plain.result, { ok: true, frozen: true, braveCall: false, max: 5, sum: 6 })
  assert.equal(/\[lockdown\] replaced/.test(plain.stderr), false)
})
