// The e2e memory probe (test/e2e/lib/memory-probe.js) is what the full-stack suite's flood step trusts to
// tell "the server kept the flood" from "the flood is garbage not yet collected". This checks the probe
// itself against a process that holds memory, drops it, and makes garbage.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROBE = fileURLToPath(new URL('./e2e/lib/memory-probe.js', import.meta.url))
const MB = 1024 * 1024

// a process that does what stdin says: one word per line, answered with "done <word>"
const CHILD = `
  const held = []
  const steps = {
    buffers: () => { for (let i = 0; i < 48; i++) held.push(Buffer.alloc(${MB}, 1)) },
    strings: () => { for (let i = 0; i < 48; i++) held.push(Buffer.alloc(${MB}, 97 + (i % 26)).toString('latin1')) },
    garbage: () => { for (let i = 0; i < 48; i++) Buffer.alloc(${MB}, 1).toString('latin1') },
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
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8').on('data', text => (out += text))
  child.stderr.setEncoding('utf8').on('data', text => (err += text))
  const lines = () => out.split('\n').slice(0, -1)
  const until = async find => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const value = find(lines())
      if (value !== undefined) return value
      if (child.exitCode !== null) throw new Error(`the child exited (${child.exitCode}): ${err.slice(-500)}`)
      if (Date.now() > deadline) throw new Error(`no answer from the child: ${out.slice(-500)}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const count = (all, prefix) => all.filter(line => line.startsWith(prefix)).length
  return {
    child,
    stderr: () => err,
    async step(word) {
      const seen = count(lines(), `done ${word}`)
      child.stdin.write(`${word}\n`)
      await until(all => (count(all, `done ${word}`) > seen ? true : undefined))
    },
    ready: () => until(all => (all.includes('done start') ? true : undefined)),
    // what server.retainedMB() computes from the probe's line
    async retainedMB() {
      const seen = count(lines(), 'E2E_MEMORY ')
      child.kill('SIGUSR2')
      const line = await until(all => {
        const reports = all.filter(l => l.startsWith('E2E_MEMORY '))
        return reports.length > seen ? reports.at(-1) : undefined
      })
      const report = JSON.parse(line.slice('E2E_MEMORY '.length))
      assert.equal(report.n, seen + 1)
      return (report.heapUsed + report.external) / MB
    },
  }
}

test('the probe reports what a process holds, not what it has thrown away', async t => {
  const probe = start(['--expose-gc', '--import', pathToFileURL(PROBE).href])
  t.after(() => probe.child.kill('SIGKILL'))
  await probe.ready()
  const baseline = await probe.retainedMB()

  // garbage does not count, however much was made
  await probe.step('garbage')
  const afterGarbage = await probe.retainedMB()
  assert.ok(Math.abs(afterGarbage - baseline) < 8, `garbage: ${baseline} -> ${afterGarbage} MB`)

  // held buffers count (memory outside the heap)
  await probe.step('buffers')
  const withBuffers = await probe.retainedMB()
  assert.ok(withBuffers - baseline > 40, `48 MB of buffers held: ${baseline} -> ${withBuffers} MB`)

  // held strings count (memory in the heap)
  await probe.step('strings')
  const withStrings = await probe.retainedMB()
  assert.ok(withStrings - withBuffers > 40, `48 MB of strings held: ${withBuffers} -> ${withStrings} MB`)

  // and what is let go is no longer reported
  await probe.step('drop')
  const afterDrop = await probe.retainedMB()
  assert.ok(Math.abs(afterDrop - baseline) < 8, `dropped: ${baseline} -> ${afterDrop} MB`)
})

test('the probe refuses to load without --expose-gc instead of reporting uncollected memory', async () => {
  const probe = start(['--import', pathToFileURL(PROBE).href])
  const [code] = await once(probe.child, 'exit')
  assert.notEqual(code, 0)
  assert.match(probe.stderr(), /memory-probe\.js needs node --expose-gc/)
})
