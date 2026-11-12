// A server that could not start ends with exit code 1 (src/server/startupExit.js). The rules are tested against a
// stand-in process, and then in child processes against the real lockdown, whose error trapping is what made a
// failed start-up exit with 0 or stay up without listening.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EXIT_FLUSH_MS, installStartupExit } from '../src/server/startupExit.js'

// a process whose streams hand over a write only when the test says so
function fixture() {
  const proc = new EventEmitter()
  proc.exitCode = undefined
  proc.exits = []
  proc.exit = code => proc.exits.push(code)
  const stream = () => {
    const s = { written: [], pending: [] }
    s.write = (text, done) => {
      s.written.push(text)
      s.pending.push(done)
      return true
    }
    s.flush = () => s.pending.splice(0).forEach(done => done())
    return s
  }
  proc.stderr = stream()
  proc.stdout = stream()
  const immediates = []
  const timers = []
  const startup = installStartupExit({
    proc,
    setImmediate: fn => immediates.push(fn),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  })
  const turn = () => immediates.splice(0).forEach(fn => fn())
  return { proc, startup, turn, timers }
}
const uncaught = (proc, err, origin = 'uncaughtException') => proc.emit('uncaughtException', err, origin)

test('start-up exit: until the server listens the exit code is 1, and an uncaught exception ends the process', () => {
  const { proc, startup, turn, timers } = fixture()
  assert.equal(proc.exitCode, 1, 'a process that ends by itself during start-up says so')
  assert.equal(startup.phase, 'config')
  const error = new Error('[envs] WORLD not set')
  uncaught(proc, error, 'unhandledRejection')
  // nothing is written in the turn of the event: the listeners after this one (SES) write their report first
  assert.deepEqual(proc.stderr.written, [])
  assert.deepEqual(proc.exits, [])
  assert.deepEqual(
    timers.map(timer => timer.ms),
    [EXIT_FLUSH_MS]
  )
  turn()
  assert.deepEqual(proc.stderr.written, [`[server] start-up failed; exiting with code 1: ${error.stack}\n`])
  // the exit waits for both streams to hand over what was written
  assert.deepEqual(proc.exits, [])
  proc.stderr.flush()
  assert.deepEqual(proc.exits, [])
  proc.stdout.flush()
  assert.deepEqual(proc.exits, [1])
  // a second failure while the first is ending says and does nothing more
  uncaught(proc, new Error('another'))
  turn()
  assert.equal(proc.stderr.written.length, 1)
  assert.equal(timers.length, 1)
})

test('start-up exit: streams that never hand over do not keep the process: it ends when the wait is over', () => {
  const { proc, turn, timers } = fixture()
  uncaught(proc, new Error('database unreadable'))
  turn()
  assert.deepEqual(proc.exits, [])
  timers[0].fn()
  assert.deepEqual(proc.exits, [1])
  assert.equal(EXIT_FLUSH_MS, 2000)
})

test('start-up exit: what cannot be shown as an error still ends the process, with what there is', () => {
  for (const [thrown, shown] of [
    ['a string', 'a string'],
    [undefined, 'undefined'],
    [{ stack: '' }, '[object Object]'],
    [
      {
        get stack() {
          throw new Error('no')
        },
      },
      'an error that cannot be shown',
    ],
  ]) {
    const { proc, turn } = fixture()
    uncaught(proc, thrown)
    turn()
    assert.deepEqual(proc.stderr.written, [`[server] start-up failed; exiting with code 1: ${shown}\n`])
    proc.stderr.flush()
    proc.stdout.flush()
    assert.deepEqual(proc.exits, [1])
  }
})

test('start-up exit: while the world loads, uncaught exceptions are left alone, whatever their origin', () => {
  const { proc, startup, turn, timers } = fixture()
  startup.scriptsStart()
  assert.equal(startup.phase, 'scripts')
  assert.equal(proc.exitCode, 1)
  // from a callback of an app script, or a rejection nobody handles under --unhandled-rejections=strict, which
  // arrives here with the same origin as a failure of the entry module would
  uncaught(proc, new Error('from a timer'), 'uncaughtException')
  uncaught(proc, new Error('a stray rejection'), 'unhandledRejection')
  turn()
  assert.deepEqual(proc.exits, [])
  assert.deepEqual(proc.stderr.written, [])
  assert.equal(timers.length, 0)
})

test('start-up exit: a step gives its value, and one that fails ends the process and never returns', async () => {
  for (const loading of [false, true]) {
    const { proc, startup, turn } = fixture()
    if (loading) startup.scriptsStart()
    assert.equal(await startup.step(() => 7), 7)
    assert.equal(await startup.step(async () => 'db'), 'db')
    assert.deepEqual(proc.exits, [])
    const error = new Error('world.init failed')
    let returned = false
    const step = startup
      .step(() => {
        throw error
      })
      .then(() => (returned = true))
    void step
    const rejected = startup.step(() => Promise.reject(new Error('second')))
    void rejected
    await new Promise(resolve => setImmediate(resolve))
    turn()
    assert.deepEqual(proc.stderr.written, [`[server] start-up failed; exiting with code 1: ${error.stack}\n`])
    proc.stderr.flush()
    proc.stdout.flush()
    assert.deepEqual(proc.exits, [1], loading ? 'while the world loads' : 'before the world loads')
    assert.equal(returned, false, 'the start-up does not go on with a step missing')
  }
})

test('start-up exit: once the server listens nothing acts any more and the exit code is clean', () => {
  const { proc, startup, turn } = fixture()
  startup.scriptsStart()
  startup.listening()
  assert.equal(startup.phase, 'listening')
  assert.equal(proc.exitCode, 0)
  assert.equal(proc.listenerCount('uncaughtException'), 0)
  uncaught(proc, new Error('later'), 'unhandledRejection')
  turn()
  assert.deepEqual(proc.exits, [])
  // the phases go one way
  startup.scriptsStart()
  assert.equal(startup.phase, 'listening')
  // a server that listens without the world having been marked as loading still stops acting
  const direct = fixture()
  direct.startup.listening()
  uncaught(direct.proc, new Error('later'))
  direct.turn()
  assert.deepEqual(direct.proc.exits, [])
  // and a start-up that is already ending is not declared a success
  const failed = fixture()
  uncaught(failed.proc, new Error('failed'))
  failed.startup.listening()
  assert.equal(failed.proc.exitCode, 1)
  assert.equal(failed.startup.phase, 'config')
})

// a child that starts as index.js does: the start-up exit first, then SES and lockdown
const root = fileURLToPath(new URL('../', import.meta.url))
const url = file => JSON.stringify(pathToFileURL(root + file).href)
function child(body, { guard = true, lockdown = true, nodeArgs = [], readAfterMs = 0 } = {}) {
  const source = `
    ${guard ? `const { installStartupExit } = await import(${url('src/server/startupExit.js')})\nconst startup = installStartupExit()` : ''}
    await import('ses')
    ${lockdown ? `await import(${url('src/core/lockdown.js')})` : ''}
    ${body}
  `
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [...nodeArgs, '--input-type=module', '-e', source], { cwd: root })
    let out = ''
    const read = () => {
      proc.stdout.on('data', data => (out += data))
      proc.stderr.on('data', data => (out += data))
    }
    if (readAfterMs) setTimeout(read, readAfterMs)
    else read()
    // a start-up that stays up without listening is the other defect: it is ended here and reported as 'hung'
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10000)
    // 'close': the streams have ended too, so `out` is all there was
    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: signal === 'SIGKILL' ? 'hung' : code, out })
    })
  })
}
const STUCK = `setInterval(() => {}, 1000)\nawait Promise.reject(new Error('database unreadable'))`

test('start-up exit, real lockdown: what a failed start-up did before (exit 0, or up without listening)', async () => {
  const thrown = await child(`throw new Error('[envs] WORLD not set')`, { guard: false })
  assert.equal(thrown.code, 0)
  assert.match(thrown.out, /SES_UNCAUGHT_EXCEPTION/)
  const stuck = await child(STUCK, { guard: false })
  assert.equal(stuck.code, 'hung')
})

test('start-up exit, real lockdown: a refused setting and a rejected start-up step end the process with 1', async () => {
  const thrown = await child(`throw new Error('[envs] WORLD not set')`)
  assert.equal(thrown.code, 1)
  // SES's report first, then the reason for the exit with the error
  assert.match(
    thrown.out,
    /SES_UNCAUGHT_EXCEPTION[^]*\[server\] start-up failed; exiting with code 1: Error: \[envs\] WORLD not set/
  )
  // something already keeps the process alive (a database connection): it does not stay up
  const rejected = await child(STUCK)
  assert.equal(rejected.code, 1)
  // a step that fails, before and after the world began to load
  for (const loading of ['', 'startup.scriptsStart()']) {
    const step = await child(`
      ${loading}
      setInterval(() => {}, 1000)
      await startup.step(() => Promise.reject(new Error('world.init failed')))
      console.log('went on')
    `)
    assert.equal(step.code, 1, loading)
    assert.match(step.out, /start-up failed; exiting with code 1: Error: world\.init failed/)
    assert.doesNotMatch(step.out, /went on/)
  }
})

test('start-up exit, real lockdown: lockdown itself failing ends the process with 1', async () => {
  // something lockdown refuses to work with (here an intrinsic it cannot clean up)
  const broken = `
    Object.defineProperty(Array.prototype, 'planted', { value: 1, configurable: false })
    await import(${url('src/core/lockdown.js')})
    console.log('locked down')
  `
  const before = await child(broken, { guard: false, lockdown: false })
  assert.doesNotMatch(before.out, /locked down/)
  assert.equal(before.code, 0, 'this is what it did: the failure was printed and the exit code was 0')
  const now = await child(broken, { lockdown: false })
  assert.doesNotMatch(now.out, /locked down/)
  assert.equal(now.code, 1)
  assert.match(now.out, /start-up failed; exiting with code 1/)
})

test('start-up exit, real lockdown: a long report is not cut short by the exit', async () => {
  // a megabyte on a pipe nobody reads yet, then the failure: an exit at once left most of it unwritten
  const big = await child(
    `process.stderr.write('x'.repeat(1 << 20) + '\\n')\nthrow new Error('[envs] after a long report')`,
    {
      readAfterMs: 400,
    }
  )
  assert.equal(big.code, 1)
  assert.ok(big.out.includes('x'.repeat(1 << 20)), `${big.out.length} bytes arrived`)
  assert.match(big.out, /start-up failed; exiting with code 1: Error: \[envs\] after a long report/)
})

for (const mode of ['default', 'strict']) {
  test(`start-up exit, real lockdown: what happens in the world while it loads does not end the start-up (unhandled rejections: ${mode})`, async () => {
    // an exception from a callback and a promise nobody handles, both while app scripts start: printed, survived.
    // Under --unhandled-rejections=strict the rejection arrives as an uncaught exception, with the origin a failed
    // entry module has
    const survived = await child(
      `
      startup.scriptsStart()
      setTimeout(() => { throw new Error('from a timer') }, 10)
      Promise.reject(new Error('nobody handles this'))
      new Compartment().evaluate("Promise.reject(new Error('from a compartment'))")
      await new Promise(resolve => setTimeout(resolve, 300))
      console.log('still starting')
      startup.listening()
      console.log('listening')
    `,
      { nodeArgs: mode === 'strict' ? ['--unhandled-rejections=strict'] : [] }
    )
    assert.match(survived.out, /from a timer/)
    assert.match(survived.out, /nobody handles this/)
    assert.match(survived.out, /from a compartment/)
    assert.match(survived.out, /still starting\nlistening/)
    assert.doesNotMatch(survived.out, /start-up failed/)
    assert.equal(survived.code, 0, 'a server that listened and then ended by itself did not fail to start')
  })
}

test('start-up exit, real lockdown: after listening an uncaught exception is survived, as before', async () => {
  const running = await child(`
    startup.scriptsStart()
    startup.listening()
    setTimeout(() => { throw new Error('in a running server') }, 10)
    await new Promise(resolve => setTimeout(resolve, 200))
    console.log('still running')
  `)
  assert.match(running.out, /still running/)
  assert.equal(running.code, 0)
})
