// The e2e memory probe (test/e2e/lib/memory-probe.js) is what the full-stack suite's flood step trusts to
// tell "the server kept the flood" from "the flood is garbage not yet collected". This checks the probe
// itself against a process that holds heap and buffer memory, drops it, and makes garbage; the harness side
// (test/e2e/lib/memory.mjs) against a stand-in process: each request gets the reply with its own id, checked;
// and the flood step's deadline against a controlled clock.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { TIMEOUT_SCALE } from './e2e/lib/common.mjs'
import { MemoryProbeTimeout, memoryReader, waitForMemoryToSettle } from './e2e/lib/memory.mjs'

const PROBE = new URL('./e2e/lib/memory-probe.js', import.meta.url).href
const MiB = 1024 * 1024

// a process that does what stdin says: one word per line, answered with "done <word>". Buffers are memory outside
// the V8 heap (`external`), arrays of numbers are heap (`heapUsed`). Big strings would not test the heap: Node
// keeps large latin1 strings outside it, and Node 24 large ASCII utf8 strings as well
const CHILD = `
  const held = []
  const buffer = i => Buffer.alloc(${MiB}, i)
  const array = i => new Array(${MiB / 8}).fill(i + 0.5)
  const steps = {
    buffers: () => { for (let i = 0; i < 48; i++) held.push(buffer(i)) },
    arrays: () => { for (let i = 0; i < 48; i++) held.push(array(i)) },
    garbage: () => {
      const thrown = []
      for (let i = 0; i < 48; i++) thrown.push(buffer(i), array(i))
    },
    drop: () => { held.length = 0 },
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', text => {
    for (const word of text.split('\\n').filter(Boolean)) {
      steps[word]()
      process.stdout.write('done ' + word + '\\n')
    }
  })
  process.stdout.write('done start\\n')
`

function start(args, code = CHILD) {
  const child = spawn(process.execPath, [...args, '-e', code], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })))
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8').on('data', text => (out += text))
  child.stderr.setEncoding('utf8').on('data', text => (err += text))
  const exited = () => child.exitCode ?? child.signalCode
  const read = memoryReader(child)
  const lines = () => out.split('\n').slice(0, -1)
  const until = async find => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const value = find(lines())
      if (value !== undefined) return value
      if (exited() !== null) throw new Error(`the child exited (${exited()}): ${err.slice(-500)}`)
      if (Date.now() > deadline) throw new Error(`no answer from the child: ${out.slice(-500)}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const count = (all, prefix) => all.filter(line => line.startsWith(prefix)).length
  return {
    child,
    read,
    stderr: () => err,
    async step(word) {
      const seen = count(lines(), `done ${word}`)
      child.stdin.write(`${word}\n`)
      await until(all => (count(all, `done ${word}`) > seen ? true : undefined))
    },
    ready: () => until(all => (all.includes('done start') ? true : undefined)),
    // the two numbers server.retainedMiB() adds up, in MiB
    async memory() {
      const { heapUsed, external } = await read()
      return { heap: heapUsed / MiB, external: external / MiB }
    },
    // resolves with { code, signal } once the child has exited and its output is drained
    async closed(timeout) {
      let timer
      const late = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the child is still running after ${timeout} ms: ${out}`)), timeout)
      })
      try {
        return await Promise.race([closed, late])
      } finally {
        clearTimeout(timer)
      }
    },
    async stop() {
      if (exited() === null) child.kill('SIGKILL')
      await closed
    },
  }
}

const show = ({ heap, external }) => `heap ${heap.toFixed(1)} MiB, external ${external.toFixed(1)} MiB`

test('the probe reports what a process holds in and outside the heap, not what it has thrown away', async t => {
  const probe = start(['--expose-gc', '--import', PROBE])
  t.after(() => probe.stop())
  await probe.ready()
  const baseline = await probe.memory()
  const unchanged = (now, what) => {
    const message = `${what}: ${show(baseline)} -> ${show(now)}`
    assert.ok(Math.abs(now.heap - baseline.heap) < 8, message)
    assert.ok(Math.abs(now.external - baseline.external) < 8, message)
  }

  // garbage does not count, however much was made
  await probe.step('garbage')
  unchanged(await probe.memory(), '96 MiB of garbage')

  // held buffers count as external memory
  await probe.step('buffers')
  const withBuffers = await probe.memory()
  assert.ok(
    withBuffers.external - baseline.external > 40,
    `48 MiB of buffers held: ${show(baseline)} -> ${show(withBuffers)}`
  )

  // held arrays count as heap
  await probe.step('arrays')
  const withArrays = await probe.memory()
  assert.ok(
    withArrays.heap - withBuffers.heap > 40,
    `48 MiB of arrays held: ${show(withBuffers)} -> ${show(withArrays)}`
  )

  // and what is let go is no longer reported
  await probe.step('drop')
  unchanged(await probe.memory(), 'dropped')
})

test('a process that missed requests while stopped answers the next ones once it runs again', async t => {
  const probe = start(['--expose-gc', '--import', PROBE])
  t.after(() => probe.stop())
  await probe.ready()
  probe.child.kill('SIGSTOP')
  try {
    await assert.rejects(probe.read({ timeout: 200 }), MemoryProbeTimeout)
    await assert.rejects(probe.read({ timeout: 200 }), MemoryProbeTimeout)
  } finally {
    probe.child.kill('SIGCONT')
  }
  // the process now answers the two old requests too; their replies must not get in the way
  for (let i = 0; i < 2; i++) {
    const { heapUsed, external, rss } = await probe.read()
    assert.ok(heapUsed > 0 && external > 0 && rss > 0)
  }
})

test('the probe does not keep a process alive that has nothing left to do', async t => {
  const probe = start(['--expose-gc', '--import', PROBE], '')
  t.after(() => probe.stop())
  // the server exits on its own at shutdown; an open IPC channel must not hold it
  const { code } = await probe.closed(20_000)
  assert.equal(code, 0)
})

test('the probe refuses to load without --expose-gc instead of reporting uncollected memory', async t => {
  const probe = start(['--import', PROBE])
  t.after(() => probe.stop())
  // a probe that loaded anyway would leave the child waiting on stdin for ever
  const { code } = await probe.closed(20_000)
  assert.notEqual(code, 0)
  assert.match(probe.stderr(), /memory-probe\.js needs node --expose-gc/)
})

// a stand-in for the server process: the test sees what is sent to it and replies for it
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, connected: true, sent: [] })
  child.send = (message, callback) => {
    child.sent.push(message)
    callback(null)
  }
  child.lastId = () => child.sent.at(-1).id
  child.reply = (fields = {}, id = child.lastId()) =>
    child.emit('message', { type: 'e2e-memory', id, heapUsed: 1, external: 2, rss: 3, ...fields })
  child.read = memoryReader(child)
  return child
}
// lets the reader's promise callbacks run
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
const track = promise => {
  const state = { done: false }
  promise.then(
    value => Object.assign(state, { done: true, value }),
    error => Object.assign(state, { done: true, error })
  )
  return state
}

test('memory requests run one at a time', async () => {
  const child = fakeChild()
  const first = track(child.read())
  const second = track(child.read())
  await tick()
  assert.equal(child.sent.length, 1, 'the second request waits for the first')
  child.reply({ heapUsed: 10 })
  await tick()
  assert.equal(first.value?.heapUsed, 10)
  assert.equal(second.done, false)
  assert.equal(child.sent.length, 2)
  assert.notEqual(child.sent[1].id, child.sent[0].id, 'each request has a fresh id')
  child.reply({ heapUsed: 20 })
  await tick()
  assert.equal(second.value?.heapUsed, 20)
})

test('only the reply with the request id answers it', async () => {
  const child = fakeChild()
  const read = track(child.read())
  await tick()
  const id = child.lastId()
  child.reply({}, id + 1)
  child.reply({}, String(id))
  const fields = { heapUsed: 1, external: 2, rss: 3 }
  for (const other of [{ type: 'e2e-memory', ...fields }, { type: 'other', id, ...fields }, null, 'text', 42, []]) {
    child.emit('message', other)
  }
  await tick()
  assert.equal(read.done, false, 'nothing above answers the request')
  child.reply({ heapUsed: 5, external: 7, rss: 9 })
  await tick()
  assert.deepEqual(read.value, { heapUsed: 5, external: 7, rss: 9 })
})

test('a reply that comes after its request timed out is ignored, also by the next request', async () => {
  const child = fakeChild()
  const started = performance.now()
  await assert.rejects(child.read({ timeout: 100 }), MemoryProbeTimeout)
  // a timer may fire a millisecond before its time on the caller's clock, so the bound has a margin; an unscaled
  // timeout (100 ms where the scale is 3) is still far below it
  const waited = performance.now() - started
  assert.ok(waited >= 100 * TIMEOUT_SCALE * 0.9, `the request timeout is scaled like every harness wait (${waited} ms)`)
  const late = child.lastId()
  const next = track(child.read())
  await tick()
  assert.equal(child.sent.length, 2)
  child.reply({ heapUsed: 666 }, late)
  await tick()
  assert.equal(next.done, false, 'the late reply does not answer the next request')
  child.reply({ heapUsed: 20 })
  await tick()
  assert.equal(next.value?.heapUsed, 20)
})

test('a limit cuts the request timeout', async () => {
  const child = fakeChild()
  const started = performance.now()
  await assert.rejects(child.read({ timeout: 15000, limit: 50 }), MemoryProbeTimeout)
  // far below the 15 s it cuts, with room for a slow runner
  assert.ok(performance.now() - started < 5000)
})

test('a malformed reply rejects its request with the reason, without throwing from the listener', async () => {
  const child = fakeChild()
  const shapes = [
    [{ heapUsed: '5' }, /heapUsed is "5"/],
    [{ heapUsed: -1 }, /heapUsed is -1/],
    [{ external: undefined }, /external is undefined/],
    [{ external: null }, /external is null/],
    [{ rss: NaN }, /rss is NaN/],
    [{ rss: Infinity }, /rss is Infinity/],
    [{ heapUsed: { bytes: 1 } }, /heapUsed is \{"bytes":1\}/],
  ]
  for (const [fields, reason] of shapes) {
    const read = child.read()
    await tick()
    child.reply(fields)
    await assert.rejects(read, err => !(err instanceof MemoryProbeTimeout) && reason.test(err.message))
  }
  const read = child.read()
  await tick()
  const hostile = { type: 'e2e-memory', id: child.lastId() }
  Object.defineProperty(hostile, 'heapUsed', {
    get() {
      throw new Error('boom')
    },
  })
  child.emit('message', hostile)
  await assert.rejects(read, /unreadable memory reply: boom/)
})

test('a request fails at once when the process exits or the channel closes, not as a timeout', async () => {
  const quick = async (child, act, reason) => {
    const started = performance.now()
    const read = child.read()
    await tick()
    act(child)
    await assert.rejects(read, err => !(err instanceof MemoryProbeTimeout) && reason.test(err.message))
    // far below the request's 15 s timeout, with room for a slow runner
    assert.ok(performance.now() - started < 5000)
  }
  const exits = fakeChild()
  await quick(
    exits,
    child => {
      child.exitCode = 1
      child.emit('exit', 1, null)
    },
    /server exited \(1\) before reporting its memory/
  )
  // and a request to a process that has exited is not sent at all
  await assert.rejects(exits.read(), /server exited \(1\)/)
  assert.equal(exits.sent.length, 1)
  await quick(
    fakeChild(),
    child => {
      child.connected = false
      child.emit('disconnect')
    },
    /IPC channel to the server closed/
  )
  const refuses = fakeChild()
  refuses.send = (message, callback) => callback(new Error('channel closed'))
  await assert.rejects(memoryReader(refuses)(), /could not ask the server for its memory: channel closed/)
})

// A12's deadline against a controlled clock: `steps` script what each request does, how long it takes and
// what it returns: { ms, value }, { ms, timeout: true } (cut to the request's limit, like memoryReader) or
// { ms, error }
function scripted(steps) {
  const clock = {
    t: 0,
    sleeps: [],
    now: () => clock.t,
    sleep: async ms => {
      clock.sleeps.push(ms)
      clock.t += ms
    },
  }
  const calls = []
  const read = async ({ limit }) => {
    const step = steps[calls.length]
    calls.push({ at: clock.t, limit })
    if (!step) {
      // and past every deadline, so that a wait that swallowed this error still ends
      clock.t = Infinity
      throw new Error('read more often than scripted')
    }
    if (step.timeout) {
      const ms = Math.min(step.ms, limit ?? Infinity)
      clock.t += ms
      throw new MemoryProbeTimeout(`no memory reply within ${ms} ms`)
    }
    clock.t += step.ms
    if (step.error) throw step.error
    return step.value
  }
  return { clock, calls, read }
}
const DEADLINE = 60000 * TIMEOUT_SCALE
const settle = ({ clock, read }) => waitForMemoryToSettle(read, { baseline: 100, bound: 48, timeout: 60000, clock })

test('the flood step settles on the first reading under the bound, through timed-out requests', async () => {
  const run = scripted([
    { ms: 100, value: 300 },
    { ms: 15000, timeout: true },
    { ms: 100, value: 200 },
    { ms: 100, value: 140 },
  ])
  assert.equal(await settle(run), 140)
  assert.equal(run.calls.length, 4)
})

test('the flood step fails on a reading that comes after its deadline, however low', async () => {
  const run = scripted([
    { ms: 100, value: 300 },
    { ms: DEADLINE, value: 100 },
  ])
  await assert.rejects(settle(run), /a reading of 100 MiB came after the deadline \(last reading: 300 MiB;/)
})

test('the flood step starts no request after its deadline and gives each one the time left', async () => {
  const run = scripted(Array.from({ length: 20 }, () => ({ ms: 25000 * TIMEOUT_SCALE, timeout: true })))
  await assert.rejects(settle(run), /out of time/)
  assert.equal(run.calls.length, 3)
  for (const { at, limit } of run.calls) {
    assert.ok(at < DEADLINE, `a request started at ${at} ms`)
    assert.equal(limit, DEADLINE - at)
  }
})

test('the flood step reports the last reading and the last request error apart', async () => {
  const run = scripted([
    { ms: 100, value: 300 },
    ...Array.from({ length: 10 }, () => ({ ms: 20000 * TIMEOUT_SCALE, timeout: true })),
  ])
  await assert.rejects(
    settle(run),
    /out of time \(last reading: 300 MiB; last request error: no memory reply within \d+ ms\)/
  )
})

test('the flood step ends at once on an error other than a timeout', async () => {
  const exited = new Error('server exited (1) before reporting its memory')
  const run = scripted([
    { ms: 100, value: 300 },
    { ms: 10, error: exited },
  ])
  await assert.rejects(settle(run), error => error === exited)
  assert.equal(run.calls.length, 2)
})

test('the flood step sleeps only the time left before its deadline, and asks no more after it', async () => {
  const run = scripted([{ ms: DEADLINE - 1, value: 300 }])
  await assert.rejects(settle(run), /out of time \(last reading: 300 MiB;/)
  assert.deepEqual(run.clock.sleeps, [1])
  assert.equal(run.calls.length, 1)
})

test('the flood step never reads the wall clock, so setting it does not move the deadline', async () => {
  const wall = Date.now
  Date.now = () => {
    throw new Error('the wall clock was read')
  }
  try {
    // the default clock
    assert.equal(await waitForMemoryToSettle(async () => 120, { baseline: 100, bound: 48, timeout: 60000 }), 120)
    // a given clock is the only one used
    const run = scripted([
      { ms: 100, value: 300 },
      { ms: 15000, timeout: true },
      { ms: 100, value: 140 },
    ])
    assert.equal(await settle(run), 140)
  } finally {
    Date.now = wall
  }
})
