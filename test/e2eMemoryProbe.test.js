// The e2e memory probe (test/e2e/lib/memory-probe.js) is what the full-stack suite's flood step trusts to
// tell "the server kept the flood" from "the flood is garbage not yet collected". This checks the probe
// itself against a process that holds heap and buffer memory, drops it, and makes garbage, and checks that
// the harness's reader (memoryReader in test/e2e/lib/server.mjs) gives each request its own report.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { TIMEOUT_SCALE } from './e2e/lib/common.mjs'
import { MemoryProbeTimeout, memoryReader } from './e2e/lib/server.mjs'

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

function start(args) {
  const child = spawn(process.execPath, [...args, '-e', CHILD], { stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })))
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8').on('data', text => (out += text))
  child.stderr.setEncoding('utf8').on('data', text => (err += text))
  const exited = () => child.exitCode ?? child.signalCode
  const readMemory = memoryReader(child, { exited })
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
  let requests = 0
  return {
    stderr: () => err,
    async step(word) {
      const seen = count(lines(), `done ${word}`)
      child.stdin.write(`${word}\n`)
      await until(all => (count(all, `done ${word}`) > seen ? true : undefined))
    },
    ready: () => until(all => (all.includes('done start') ? true : undefined)),
    // the two numbers server.retainedMiB() adds up, in MiB
    async memory() {
      const report = await readMemory()
      assert.equal(report.n, ++requests, 'the report answers this request')
      return { heap: report.heapUsed / MiB, external: report.external / MiB }
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

test('the probe refuses to load without --expose-gc instead of reporting uncollected memory', async t => {
  const probe = start(['--import', PROBE])
  t.after(() => probe.stop())
  // a probe that loaded anyway would leave the child waiting on stdin for ever
  const { code } = await probe.closed(20_000)
  assert.notEqual(code, 0)
  assert.match(probe.stderr(), /memory-probe\.js needs node --expose-gc/)
})

// a stand-in for the server process: the test writes its output and counts the signals it is sent. Like the probe,
// the tests write a report only after the signal it answers
function fakeChild() {
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter(), signals: 0, exitCode: null }
  child.kill = () => child.signals++
  child.write = (stream, text) => child[stream].emit('data', Buffer.from(text))
  child.report = n => child.write('stdout', `E2E_MEMORY ${JSON.stringify({ n, heapUsed: n, external: 0, rss: 0 })}\n`)
  child.read = memoryReader(child, { exited: () => child.exitCode })
  return child
}
// longer than the reader's 50 ms poll
const settle = () => new Promise(resolve => setTimeout(resolve, 150))
const track = promise => {
  const state = { done: false }
  promise.then(
    value => Object.assign(state, { done: true, value }),
    error => Object.assign(state, { done: true, error })
  )
  return state
}

test('memory requests run one at a time, each answered by the report with its number', async () => {
  const child = fakeChild()
  const first = track(child.read())
  const second = track(child.read())
  await settle()
  assert.equal(child.signals, 1, 'the second request waits for the first')
  child.report(1)
  await settle()
  assert.equal(first.value?.n, 1)
  assert.equal(second.done, false, 'report 1 answers the first request only')
  assert.equal(child.signals, 2)
  child.report(2)
  await settle()
  assert.equal(second.value?.n, 2)
})

test('a report that arrives after its request timed out is not taken for the next request', async () => {
  const child = fakeChild()
  const started = Date.now()
  await assert.rejects(child.read({ timeout: 100 }), MemoryProbeTimeout)
  assert.ok(Date.now() - started >= 100 * TIMEOUT_SCALE, 'the request timeout is scaled like every harness wait')
  const next = track(child.read())
  await settle()
  assert.equal(child.signals, 2)
  // the late answer to signal 1 arrives while the request for signal 2 waits
  child.report(1)
  await settle()
  assert.equal(next.done, false, 'the late report 1 does not answer signal 2')
  child.report(2)
  await settle()
  assert.equal(next.value?.n, 2)
})

test('a report split across chunks is read from stdout alone, whatever stderr gets in between', async () => {
  const child = fakeChild()
  const read = track(child.read())
  await settle()
  assert.equal(child.signals, 1)
  const line = `E2E_MEMORY ${JSON.stringify({ n: 1, heapUsed: 5, external: 7, rss: 9 })}\n`
  child.write('stdout', line.slice(0, 24))
  child.write('stderr', 'a warning\n')
  child.write('stdout', line.slice(24))
  await settle()
  assert.equal(read.error, undefined)
  assert.deepEqual(read.value, { n: 1, heapUsed: 5, external: 7, rss: 9 })
})

test('a request to a process that exits fails at once with that reason, not as a timeout', async () => {
  const child = fakeChild()
  const started = Date.now()
  const read = child.read()
  child.exitCode = 1
  await assert.rejects(read, err => !(err instanceof MemoryProbeTimeout) && /server exited \(1\)/.test(err.message))
  assert.ok(Date.now() - started < 1000)
})
