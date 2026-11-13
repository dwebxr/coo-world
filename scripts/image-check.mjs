// `node scripts/image-check.mjs [--model=current] [--summary <file>] [--logs <dir>] [--dry-run]`
//
// Builds the Docker image of this repository and runs it, with the `docker` CLI and nothing published to the host.
// It needs Docker and Node only (it imports nothing from node_modules: the workflow that runs it, image.yml, does
// no `npm ci`). The steps, in scripts/lib/imageCheck.mjs:
//   a. `docker build` of the repository root under a throw-away tag, with a COMMIT_HASH of this run;
//   b. a container the way the image starts by itself (its ENTRYPOINT and CMD, its user), with a named volume at
//      the world's path (/app/world) and the settings the server refuses to start without, all made up;
//   c. a bounded wait for the image's own health check to say `healthy`;
//   d. the process tree (BusyBox `ps`), PID 1 from /proc/1/status and /proc/1/exe, GET /status from inside;
//   e. THE STOP: `docker stop -t 10`. The container has to exit 0 by itself well before the 10 s, and its log has
//      to hold the server's `[server] SIGTERM: saving the world before exit` and `[network] final save complete`
//      and no line saying that something was not saved;
//   f. a second container on the same volume, stopped with `docker stop --signal SIGINT -t 5` (Fly's documented
//      default signal and timeout): the same, with SIGINT in the server's line;
//   g. a third container on the same volume becomes healthy: the world the first two wrote loads;
//   h. always, also after a failure or a SIGINT/SIGTERM to this script: the containers, the volume and the image
//      tag of this run are removed. Their names carry a random id of the run; nothing else is touched.
// A failed stop (e, f) does not end the run: the remaining steps still say what they see, and the exit code is 1.
//
// Asserted: the build; `healthy` three times; a `node build/index.js` process; /status carrying the COMMIT_HASH;
// the two stops as described. Recorded only (in the output and in the --summary file): the image's configuration,
// who PID 1 is and which signals it handles, whether a shell sits between it and the server, the uids, how long
// each step took, what is in the world folder.
//
// `--model` names how the image is expected to start. `current` (the default) is the image as it is today. An
// unknown model is an error, and so is `nonroot` until it is implemented (see MODELS in the library).
// `--dry-run` prints the docker commands of a run in which every step goes well, in order, and runs none.
//
// What this does NOT check: anything Fly does differently from `docker run` (its own init as PID 1, the signal and
// timeout set in fly.toml, who owns a mounted volume, its health checks, which are not the Dockerfile's), another
// architecture than the runner's, a world with content, a client connecting. Nothing is changed in the world
// before the stops: they show that the signal reaches the server and that its final save runs and returns in
// time, not that a changed row is written (test/shutdownSave.test.js and the persistence tests are for that).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  COMMAND_TIMEOUT_MS,
  UsageError,
  containerEnv,
  formatCommand,
  parseArgs,
  runImageCheck,
  runNames,
  simulatedDocker,
} from './lib/imageCheck.mjs'

const USAGE = 'usage: node scripts/image-check.mjs [--model=current] [--summary <file>] [--logs <dir>] [--dry-run]'
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 }
// how long a docker command that ran out of time gets to end on SIGTERM before it is killed
const KILL_AFTER_MS = 5000
// the most of one command's output that is kept
const OUTPUT_LIMIT = 4 * 1024 * 1024

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// (every line of a text that has several, so that each can be told from the build's and from docker's own output)
const say = text => console.log(String(text).replace(/^/gm, '[image-check] '))

const started = Date.now()
const id = crypto.randomBytes(6).toString('hex')
const names = runNames(id)
const commitHash = `image-check-${id}`
// Made up for this run, and named so in the value because the `docker run` lines of the output show it. It signs
// nothing anybody can use: no port is published and the containers are removed.
const env = containerEnv(`made-up-for-this-run-${crypto.randomBytes(16).toString('hex')}`)

let interrupted = null // 'SIGINT' or 'SIGTERM' once one has arrived
let running = null // { child, interruptible } while a docker command runs

function interruption() {
  const err = new Error(`stopped by ${interrupted}`)
  err.interrupted = interrupted
  return err
}

// One docker command: an argument array given to the docker binary, never a shell string. Resolves with its exit
// code and output whatever the code is; rejects when docker cannot be started, when the command ran out of time,
// and (outside the cleanup) once this script was told to stop.
function docker(
  args,
  { timeoutMs = COMMAND_TIMEOUT_MS, inherit = false, interruptible = false, cleanup = false } = {}
) {
  if (interrupted && !cleanup) return Promise.reject(interruption())
  return new Promise((resolve, reject) => {
    const began = Date.now()
    const output = inherit ? 'inherit' : 'pipe'
    const child = spawn('docker', args, { stdio: ['ignore', output, output] })
    const entry = { child, interruptible }
    running = entry
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout?.on('data', data => (stdout = (stdout + data).slice(-OUTPUT_LIMIT)))
    child.stderr?.on('data', data => (stderr = (stderr + data).slice(-OUTPUT_LIMIT)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS).unref()
    }, timeoutMs)
    const done = () => {
      clearTimeout(timer)
      if (running === entry) running = null
    }
    child.once('error', err => {
      done()
      reject(
        new Error(
          err.code === 'ENOENT'
            ? 'the `docker` command was not found: this check needs Docker (it runs in the image.yml workflow)'
            : `docker could not be started: ${err.message}`
        )
      )
    })
    child.once('close', (code, signal) => {
      done()
      if (interrupted && !cleanup) return reject(interruption())
      if (timedOut) {
        return reject(new Error(`\`docker ${formatCommand(args)}\` was not done within ${timeoutMs / 1000} s`))
      }
      resolve({ code: code ?? `signal ${signal}`, stdout, stderr, ms: Date.now() - began })
    })
  })
}

for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    if (interrupted) return // (the cleanup of the first one is running)
    interrupted = signal
    console.error(`[image-check] ${signal}: ending the run and removing what it created`)
    // The build is the one long command: it is told to end. A short one is left to finish, so that what it was
    // creating exists (or does not) by the time the cleanup removes it by name.
    if (running?.interruptible) running.child.kill('SIGTERM')
  })
}

async function dryRun(options) {
  say(`dry run: the docker commands of a run of model ${options.model} in which every step goes well. None is run.`)
  const simulated = simulatedDocker({ commitHash })
  const summary = await runImageCheck({
    docker: simulated,
    model: options.model,
    names,
    repoDir,
    commitHash,
    // (a real run makes up a secret; none is needed to print the commands)
    env: containerEnv('made-up-for-this-run'),
    report: { command: args => console.log(`docker ${formatCommand(args)}`), info: () => {} },
    sleep: async () => {},
  })
  say(`dry run: ${simulated.calls.length} docker commands, none was run`)
  if (options.summary) say(`dry run: ${options.summary} was not written`)
  return summary.ok ? 0 : 1
}

// Resolves with the exit code. The process is left to end by itself (process.exitCode), so that everything written
// to a pipe is out before it does.
async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    console.error(`[image-check] ${err.message}`)
    console.error(USAGE)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.dryRun) return dryRun(options)

  const logFiles = []
  const saveLog = (role, text) => {
    if (!options.logs) return
    fs.mkdirSync(options.logs, { recursive: true })
    const file = path.join(options.logs, `${role}.log`)
    fs.writeFileSync(file, `${text}\n`)
    if (!logFiles.includes(file)) logFiles.push(file)
  }

  let summary
  try {
    summary = await runImageCheck({
      docker,
      model: options.model,
      names,
      repoDir,
      commitHash,
      env,
      report: { command: args => say(`$ docker ${formatCommand(args)}`), info: say },
      saveLog,
    })
  } catch (err) {
    // (runImageCheck reports failed steps itself: this is a mistake in the script)
    const failure = `the check itself failed: ${err?.message ?? err}`
    summary = { model: options.model, ok: false, interrupted, failures: [failure] }
  }

  summary.seconds = Math.round((Date.now() - started) / 1000)
  summary.logFiles = logFiles
  if (options.summary) {
    fs.mkdirSync(path.dirname(path.resolve(options.summary)), { recursive: true })
    fs.writeFileSync(options.summary, `${JSON.stringify(summary, null, 2)}\n`)
    say(`summary written to ${options.summary}`)
  }
  if (logFiles.length) say(`container logs written to ${logFiles.join(', ')}`)

  const signal = summary.interrupted ?? interrupted
  if (signal) {
    console.error(`[image-check] stopped by ${signal} after ${summary.seconds} s`)
    return SIGNAL_EXIT_CODES[signal]
  }
  if (summary.failures.length) {
    console.error(`[image-check] FAILED after ${summary.seconds} s:`)
    for (const failure of summary.failures) console.error(`[image-check]   - ${failure}`)
    return 1
  }
  say(`passed in ${summary.seconds} s (model ${summary.model})`)
  return 0
}

process.exitCode = await main()
