// A `docker` for test/imageCheck.test.js: scripts/image-check.mjs finds it on PATH (through a one-line `docker`
// wrapper the test writes) and runs its real code against it: the spawns, the output it keeps, the files it writes,
// its signal handling. It answers like the library's simulatedDocker (every step goes well), keeps what has to last
// from one command to the next in FAKE_DOCKER_DIR/state.json, and appends each command to FAKE_DOCKER_DIR/calls.jsonl.
// FAKE_DOCKER_MODEL is the model the answers are those of ('current' or 'nonroot'; simulatedDocker's `model`).
// FAKE_DOCKER_MODE changes one thing:
//   killed      the first container does not end on SIGTERM: exit code 137, no line of the final save, and
//               Docker's events say SIGTERM, then SIGKILL 10 s later, and the die with 137
//   hang-build  `docker build` never returns (until it is signalled)
//   hang-stop   `docker stop` never returns and ignores SIGTERM (an unresponsive daemon): it writes its pid to
//               stop.pid and each SIGTERM it gets to stop.signals. With FAKE_DOCKER_HOLD_RM set, `docker rm` waits
//               until the file `release` exists (at most 1.5 s), and writes rm.done when it has waited.
import fs from 'node:fs'
import path from 'node:path'
import { simulatedDocker, simulatedStopEvents } from '../../scripts/lib/imageCheck.mjs'

const dir = process.env.FAKE_DOCKER_DIR
const mode = process.env.FAKE_DOCKER_MODE || 'ok'
const args = process.argv.slice(2)
const stateFile = path.join(dir, 'state.json')
const saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { stopped: [] }

fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify(args)}\n`)

if (args[0] === 'build') {
  saved.commitHash = args.find(arg => arg.startsWith('COMMIT_HASH='))?.slice('COMMIT_HASH='.length)
  process.stderr.write('#1 [internal] load build definition from Dockerfile\n')
  if (mode === 'hang-build') await new Promise(() => setInterval(() => {}, 1000))
}
if (args[0] === 'stop' && mode === 'hang-stop') {
  process.on('SIGTERM', () => fs.appendFileSync(path.join(dir, 'stop.signals'), 'SIGTERM\n'))
  fs.writeFileSync(path.join(dir, 'stop.pid'), String(process.pid))
  await new Promise(() => setInterval(() => {}, 1000))
}
if (args[0] === 'rm' && process.env.FAKE_DOCKER_HOLD_RM) {
  const until = Date.now() + 1500
  while (!fs.existsSync(path.join(dir, 'release')) && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  fs.writeFileSync(path.join(dir, 'rm.done'), '')
}

const stopped = new Map(saved.stopped)
const name = args[args.length - 1]
const docker = simulatedDocker({
  commitHash: saved.commitHash,
  model: process.env.FAKE_DOCKER_MODEL || 'current',
  stopped,
  respond(command) {
    const target = command[0] === 'events' ? command.find(arg => arg.startsWith('container='))?.slice(10) : name
    if (mode !== 'killed' || stopped.get(target) !== 'SIGTERM') return undefined
    if (command[0] === 'events') {
      const killAtMs = Number(command[command.indexOf('--since') + 1]) * 1000 + 1000
      const killed = { killAtMs, exitAfterMs: 10_080, exitCode: 137, killedAfterMs: 10_000 }
      return { stdout: simulatedStopEvents({ name: target, signal: 'SIGTERM', ...killed }) }
    }
    if (command[0] === 'container') {
      return {
        stdout: JSON.stringify({ Status: 'exited', Running: false, ExitCode: 137, Health: { Status: 'healthy' } }),
      }
    }
    if (command[0] === 'logs') return { stdout: '', stderr: 'server listening on port 3000' }
    return undefined
  },
})
const result = await docker(args)
fs.writeFileSync(stateFile, JSON.stringify({ ...saved, stopped: [...stopped] }))
process.stdout.write(result.stdout ? `${result.stdout}\n` : '')
process.stderr.write(result.stderr ? `${result.stderr}\n` : '')
process.exitCode = result.code
