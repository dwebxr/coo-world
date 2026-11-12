// A server that could not start ends with exit code 1 (src/server/startupExit.js). The rules are tested against a
// stand-in process, and then in child processes against the real lockdown, whose error trapping is what made a
// failed start-up exit with 0 or stay up without listening.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installStartupExit } from '../src/server/startupExit.js'

function fakeProcess() {
  const proc = new EventEmitter()
  proc.exitCode = undefined
  proc.exits = []
  proc.exit = code => proc.exits.push(code)
  return proc
}

test('start-up exit: until the server listens the exit code is 1, and an uncaught exception ends the process', () => {
  const proc = fakeProcess()
  const lines = []
  const startup = installStartupExit({ proc, log: { error: line => lines.push(line) } })
  assert.equal(proc.exitCode, 1, 'a process that ends by itself during start-up says so')
  assert.equal(startup.phase, 'config')
  // a refused setting thrown at the top of the entry module, a module that throws while it loads, a callback
  for (const origin of ['unhandledRejection', 'uncaughtException']) {
    proc.emit('uncaughtException', new Error('[envs] WORLD not set'), origin)
  }
  assert.deepEqual(proc.exits, [1, 1])
  assert.deepEqual(lines, Array(2).fill('[server] start-up failed; exiting with code 1'))
})

test('start-up exit: while the world loads, only the failure of the start-up itself ends the process', () => {
  const proc = fakeProcess()
  const lines = []
  const startup = installStartupExit({ proc, log: { error: line => lines.push(line) } })
  startup.scriptsStart()
  assert.equal(startup.phase, 'scripts')
  assert.equal(proc.exitCode, 1)
  // thrown from a callback while app scripts start: printed by SES and survived, as in a running server
  proc.emit('uncaughtException', new Error('from a timer'), 'uncaughtException')
  assert.deepEqual(proc.exits, [])
  assert.deepEqual(lines, [])
  // the entry module threw, or a promise it awaited rejected (world.init)
  proc.emit('uncaughtException', new Error('world.init failed'), 'unhandledRejection')
  assert.deepEqual(proc.exits, [1])
  assert.equal(lines.length, 1)
})

test('start-up exit: once the server listens nothing acts any more and the exit code is clean', () => {
  const proc = fakeProcess()
  const startup = installStartupExit({ proc, log: { error: () => assert.fail('nothing is said') } })
  startup.scriptsStart()
  startup.listening()
  assert.equal(startup.phase, 'listening')
  assert.equal(proc.exitCode, 0)
  assert.equal(proc.listenerCount('uncaughtException'), 0)
  proc.emit('uncaughtException', new Error('later'), 'unhandledRejection')
  proc.emit('uncaughtException', new Error('later'), 'uncaughtException')
  assert.deepEqual(proc.exits, [])
  // the phases go one way
  startup.scriptsStart()
  assert.equal(startup.phase, 'listening')
})

// a child with the real SES lockdown, as index.js starts: ses, lockdown, then the start-up exit
const root = fileURLToPath(new URL('../', import.meta.url))
const url = file => JSON.stringify(pathToFileURL(root + file).href)
function child(body, { withStartupExit = true } = {}) {
  const source = `
    import 'ses'
    import ${url('src/core/lockdown.js')}
    ${withStartupExit ? `import { installStartupExit } from ${url('src/server/startupExit.js')}\nconst startup = installStartupExit()` : ''}
    ${body}
  `
  return new Promise(resolve => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root })
    let out = ''
    proc.stdout.on('data', data => (out += data))
    proc.stderr.on('data', data => (out += data))
    // a start-up that stays up without listening is the other defect: it is ended here and reported as 'hung'
    const timer = setTimeout(() => proc.kill('SIGKILL'), 8000)
    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: signal === 'SIGKILL' ? 'hung' : code, out })
    })
  })
}

test('start-up exit, real lockdown: what a failed start-up did before (exit 0, or up without listening)', async () => {
  const thrown = await child(`throw new Error('[envs] WORLD not set')`, { withStartupExit: false })
  assert.equal(thrown.code, 0)
  assert.match(thrown.out, /SES_UNCAUGHT_EXCEPTION/)
  const stuck = await child(`setInterval(() => {}, 1000)\nawait Promise.reject(new Error('database unreadable'))`, {
    withStartupExit: false,
  })
  assert.equal(stuck.code, 'hung')
})

test('start-up exit, real lockdown: a refused setting and a rejected start-up step end the process with 1', async () => {
  const thrown = await child(`throw new Error('[envs] WORLD not set')`)
  assert.equal(thrown.code, 1)
  // the error itself is still printed (by SES), then the reason for the exit
  assert.match(
    thrown.out,
    /SES_UNCAUGHT_EXCEPTION[^]*\[envs\] WORLD not set[^]*\[server\] start-up failed; exiting with code 1/
  )
  // something already keeps the process alive (a database connection): it does not stay up
  const rejected = await child(`setInterval(() => {}, 1000)\nawait Promise.reject(new Error('database unreadable'))`)
  assert.equal(rejected.code, 1)
  // after the world began to load: the start-up's own failure still ends it
  const loading = await child(
    `startup.scriptsStart()\nsetInterval(() => {}, 1000)\nawait Promise.reject(new Error('world.init failed'))`
  )
  assert.equal(loading.code, 1)
  assert.match(loading.out, /start-up failed/)
})

test('start-up exit, real lockdown: what happens in the world while it loads does not end the start-up', async () => {
  // an exception from a callback and a promise nobody handles, both while app scripts start: printed, survived
  const survived = await child(`
    startup.scriptsStart()
    setTimeout(() => { throw new Error('from a timer') }, 10)
    Promise.reject(new Error('nobody handles this'))
    await new Promise(resolve => setTimeout(resolve, 300))
    console.log('still starting')
    startup.listening()
    console.log('listening')
  `)
  assert.match(survived.out, /SES_UNCAUGHT_EXCEPTION[^]*from a timer/)
  assert.match(survived.out, /SES_UNHANDLED_REJECTION[^]*nobody handles this/)
  assert.match(survived.out, /still starting\nlistening/)
  assert.doesNotMatch(survived.out, /start-up failed/)
  assert.equal(survived.code, 0, 'a server that listened and then ended by itself did not fail to start')
  // a promise nobody handles before the world loads does not end it either (SES takes it)
  const stray = await child(`
    Promise.reject(new Error('stray'))
    await new Promise(resolve => setTimeout(resolve, 200))
    startup.scriptsStart()
    startup.listening()
  `)
  assert.equal(stray.code, 0)
  assert.doesNotMatch(stray.out, /start-up failed/)
})

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
