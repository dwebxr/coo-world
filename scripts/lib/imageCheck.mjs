// What `scripts/image-check.mjs` is made of. Nothing here starts a process: the `docker` CLI is a function the caller
// passes in (`docker(args, options) -> { code, stdout, stderr, ms }`), so the order of the commands, what is read
// out of their output and what is made of it run in the tests (test/imageCheck.test.js) on canned output, on a
// machine without Docker. Only Node's own modules are used: the workflow runs the script without `npm ci`.
import { serverStartEnv } from './startEnv.mjs'

// `WORLD` is joined to the directory above build/ (src/server/index.js): /app in the image
export const WORLD_NAME = 'world'
export const WORLD_PATH = `/app/${WORLD_NAME}`
// the Dockerfile's HEALTHCHECK asks port 3000 whatever PORT is
export const CONTAINER_PORT = 3000

// `docker stop -t 10` is Docker's own default; SIGINT with 5 s is what Fly documents as its defaults (kill_signal,
// kill_timeout)
export const STOPS = {
  sigterm: { signal: 'SIGTERM', timeoutS: 10 },
  sigint: { signal: 'SIGINT', timeoutS: 5 },
}
// a stop counts as "well under" its timeout up to this part of it: 8 s of the 10 s, 4 s of the 5 s. The server's
// own limit for the final save is 3.5 s (SHUTDOWN_DEADLINE_MS in src/server/shutdown.js), after which it exits 1
const STOP_ELAPSED_PART = 0.8

export const HEALTH_POLLS = 120
export const HEALTH_INTERVAL_MS = 1000
export const BUILD_TIMEOUT_MS = 25 * 60 * 1000
export const COMMAND_TIMEOUT_MS = 60 * 1000

// ---------------------------------------------------------------------------------------------------------------
// A SIGINT or SIGTERM to the script (scripts/image-check.mjs). GitHub cancels a run that way (docs.github.com,
// "Workflow cancellation"): SIGINT to the step's entry process (Node, through the `exec` in image.yml); SIGTERM
// 7.5 s later if it is still running; the process tree is killed 2.5 s after that, 10 s after the first signal.
// What the run created has to be removed within that, so on the first signal the docker command in flight is ended
// (unless it creates something, or is one of the removals), the cleanup starts at once, and each of its commands is
// bounded. The worst case, from the first signal:
//   a `docker run -d` or `docker volume create` in flight finishes, or is ended    createWaitMs          1.5 s
//   `docker rm -f` of the containers, `docker volume rm`, `docker image rm`        3 x removeTimeoutMs   6.0 s
//                                                         the cleanup is over by   cleanupMs             7.5 s
// which is when GitHub's SIGTERM comes (a second signal changes nothing: the cleanup goes on). A command that ran
// out of time gets SIGTERM, and SIGKILL killAfterMs later, by 8.5 s; the tree is killed at 10 s.
// ---------------------------------------------------------------------------------------------------------------
export const SIGNAL_BUDGET = {
  // GitHub's: the SIGTERM after the SIGINT, and the kill of the process tree
  secondSignalMs: 7500,
  treeKilledMs: 10_000,
  // a command that only reads or waits, in flight at the signal: SIGTERM at once, SIGKILL this much later. Its end
  // is not waited for: the cleanup starts at once
  killAfterMs: 1000,
  // a command that creates something, in flight at the signal: this long to finish, so that what it makes exists
  // (or not) when the cleanup removes it by name; then it is ended like the others
  createWaitMs: 1500,
  // each of the cleanup's three removals, after a signal (without one: COMMAND_TIMEOUT_MS)
  removeTimeoutMs: 2000,
  // the sum of the two above, by which the cleanup is over
  cleanupMs: 7500,
}

/**
 * What a docker command does, and so what a SIGINT/SIGTERM to the script does to it (scripts/image-check.mjs):
 *   'remove'  the cleanup's `rm -f`, `volume rm`, `image rm`: never interrupted, and run after a signal too, each
 *             within SIGNAL_BUDGET.removeTimeoutMs
 *   'create'  `run -d`, `volume create`: not started after a signal; one in flight gets createWaitMs to finish
 *   'wait'    the rest only reads or waits (`version`, `build`, `image inspect`, `container inspect`, `exec`, `logs`,
 *             `stop`, `events`): not started after a signal, and one in flight is ended at once. `build` makes the
 *             image tag and `stop` stops a container, but the cleanup removes both in whatever state they are left.
 */
export function commandKind(args) {
  const [first, second] = args
  if (first === 'rm' || ((first === 'volume' || first === 'image') && second === 'rm')) return 'remove'
  if (first === 'run' || (first === 'volume' && second === 'create')) return 'create'
  return 'wait'
}

export class UsageError extends Error {}
// a step that did not do what the rest needs: the run goes straight to its cleanup
class StepFailed extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// The models: how the image is expected to start. A model says what MUST hold about the process tree; the rest of
// what is seen (who is PID 1, a shell in between, the uids) is recorded in the output and the summary.
// ---------------------------------------------------------------------------------------------------------------
export const MODELS = {
  // The image as it starts today: `CMD ["npm", "run", "start"]` behind the base image's entrypoint, no USER. Expected
  // and only recorded: PID 1 is npm, the server is its child or grandchild, everything runs as uid 0.
  current: {
    name: 'current',
    treeProblems({ tree }) {
      return tree.server ? [] : ['no `node build/index.js` process is running in the container']
    },
  },
  // ---------------------------------------------------------------------------------------------------------------
  // `--model=nonroot` GOES HERE (the pull request that makes the image start as its own user). Its treeProblems get
  // the same `{ tree, pid1 }` and add what that image must show: PID 1 is the server itself (tree.serverIsPid1, and
  // `pid1.exe` is node), `pid1.status.uid` is 1001 and not 0, no process of the chain runs as root. Its runs on a
  // volume written by root, with mixed ownership, with `--user` and with another PORT are further steps of
  // runImageCheck, added there under the same name. Until then the name is refused (modelFor).
  // ---------------------------------------------------------------------------------------------------------------
}

export function modelFor(name) {
  if (Object.hasOwn(MODELS, name)) return MODELS[name]
  const known = `known: ${Object.keys(MODELS).join(', ')}`
  if (name === 'nonroot') throw new UsageError(`--model=nonroot is not implemented yet (${known})`)
  throw new UsageError(`unknown model ${JSON.stringify(name)} (${known})`)
}

export function parseArgs(argv) {
  const options = { model: 'current', summary: null, logs: null, dryRun: false, help: false }
  const valued = { '--model': 'model', '--summary': 'summary', '--logs': 'logs' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else {
      const equals = arg.indexOf('=')
      const flag = equals === -1 ? arg : arg.slice(0, equals)
      if (!Object.hasOwn(valued, flag)) throw new UsageError(`unknown argument ${JSON.stringify(arg)}`)
      const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
      if (!value || (equals === -1 && value.startsWith('--'))) throw new UsageError(`${flag} needs a value`)
      options[valued[flag]] = value
    }
  }
  modelFor(options.model)
  return options
}

// Everything a run creates carries the run's own id: the cleanup removes these names and nothing else.
export function runNames(id) {
  const prefix = `image-check-${id}`
  return {
    prefix,
    image: `${prefix}:check`,
    volume: `${prefix}-world`,
    containers: { sigterm: `${prefix}-sigterm`, sigint: `${prefix}-sigint`, restart: `${prefix}-restart` },
  }
}

export function containerEnv(jwtSecret) {
  return serverStartEnv({ world: WORLD_NAME, port: CONTAINER_PORT, jwtSecret })
}

// `docker run` the way the image starts by itself: its ENTRYPOINT and CMD, its user, no init added, and no port
// published to the host (the server is reached from inside the container)
export function buildRunArgs({ name, image, volume, worldPath = WORLD_PATH, env }) {
  const args = ['run', '-d', '--name', name, '-v', `${volume}:${worldPath}`]
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
  args.push(image)
  return args
}

export function stopArgs({ signal, timeoutS }, name) {
  // SIGTERM is what `docker stop` sends when the image names no STOPSIGNAL; `--signal` exists since Docker 23
  return signal === 'SIGTERM'
    ? ['stop', '-t', String(timeoutS), name]
    : ['stop', '--signal', signal, '-t', String(timeoutS), name]
}

// (an argv element, not a shell word: the template needs no quotes of its own)
const stateArgs = name => ['container', 'inspect', '--format', '{{json .State}}', name]

// For reading only: the command as one would type it in a shell. Nothing is ever run through a shell.
export function formatCommand(args) {
  return args.map(arg => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(' ')
}

// ---------------------------------------------------------------------------------------------------------------
// Reading what the container says
// ---------------------------------------------------------------------------------------------------------------

/** The rows of BusyBox `ps -o pid,ppid,user,args`: the header and anything else without two leading numbers is skipped. */
export function parsePs(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(line)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), user: match[3], args: match[4] })
  }
  return rows
}

const SHELLS = new Set(['sh', 'ash', 'bash', 'dash'])
const baseName = word => word.slice(word.lastIndexOf('/') + 1)

/**
 * What a command line is: 'npm' (npm itself, under its process title `npm run start` or as `node …/npm-cli.js`),
 * 'server' (`node build/index.js`), 'shell' (`sh -c …`, whatever it was asked to run) or 'other'.
 * BusyBox puts `{name} ` before the command line when the process's name differs from its first word.
 */
export function classifyProcess(args) {
  const words = String(args ?? '')
    .trim()
    .replace(/^\{[^}]*\}\s+/, '')
    .split(/\s+/)
  const first = baseName(words[0] ?? '')
  const second = baseName(words[1] ?? '')
  if (first === 'npm' || (first === 'node' && (second === 'npm' || second === 'npm-cli.js'))) return 'npm'
  const isServer = word => word === 'build/index.js' || word.endsWith('/build/index.js')
  if (first === 'node' && words.slice(1).some(isServer)) return 'server'
  if (SHELLS.has(first)) return 'shell'
  return 'other'
}

/**
 * The tree of a `ps` listing: who is PID 1, where the server is and what is between the two.
 * `chain` runs from the top (PID 1 when the server descends from it) down to the server. Processes outside it are
 * what `docker exec` and the health check started (their parent is outside the container: PPID 0).
 */
export function classifyTree(rows) {
  const byPid = new Map(rows.map(row => [row.pid, { ...row, kind: classifyProcess(row.args) }]))
  const chainOf = proc => {
    const chain = [proc]
    const seen = new Set([proc.pid])
    for (let parent = byPid.get(proc.ppid); parent && !seen.has(parent.pid); parent = byPid.get(parent.ppid)) {
      chain.unshift(parent)
      seen.add(parent.pid)
    }
    return chain
  }
  const pid1 = byPid.get(1) ?? null
  const servers = [...byPid.values()].filter(proc => proc.kind === 'server')
  const chains = servers.map(chainOf)
  const chain = chains.find(candidate => candidate[0].pid === 1) ?? chains[0] ?? null
  const server = chain ? chain[chain.length - 1] : null
  const between = chain ? chain.slice(1, -1) : []
  const inChain = new Set((chain ?? []).map(proc => proc.pid))
  return {
    processes: byPid.size,
    pid1,
    server,
    servers: servers.length,
    chain,
    underPid1: chain ? chain[0].pid === 1 : null,
    serverIsPid1: server ? server.pid === 1 : null,
    // 0: the server is PID 1; 1: its child; 2: its grandchild
    serverDepth: chain ? chain.length - 1 : null,
    shellBetween: chain ? between.some(proc => proc.kind === 'shell') : null,
    users: [...new Set((chain ?? (pid1 ? [pid1] : [])).map(proc => proc.user))],
    outside: [...byPid.values()].filter(proc => !inChain.has(proc.pid) && proc.pid !== 1),
  }
}

/** One or two sentences about a classified tree, for the output. */
export function describeTree(tree) {
  const lines = []
  const { pid1, server } = tree
  lines.push(pid1 ? `PID 1 is ${pid1.kind} (\`${pid1.args}\`, user ${pid1.user})` : 'no PID 1 in the listing')
  if (!server) {
    lines.push('no `node build/index.js` process in the listing')
  } else if (tree.serverIsPid1) {
    lines.push('the server is PID 1 itself: a stop signal goes straight to it')
  } else {
    const steps = ['', 'a child', 'a grandchild'][tree.serverDepth] ?? `${tree.serverDepth} levels below`
    const middle = tree.chain.slice(1, -1).map(proc => `${proc.kind} pid ${proc.pid} \`${proc.args}\``)
    lines.push(
      `the server is pid ${server.pid} (user ${server.user}), ${tree.underPid1 ? `${steps} of PID 1` : 'not a descendant of PID 1'}` +
        (middle.length ? `, below ${middle.join(' and ')}` : ', with nothing in between')
    )
    lines.push(
      tree.shellBetween ? 'a shell sits between PID 1 and the server' : 'no shell sits between PID 1 and the server'
    )
  }
  if (tree.servers > 1) lines.push(`${tree.servers} server processes are in the listing`)
  lines.push(`users along that chain: ${tree.users.join(', ') || 'none'}`)
  return lines
}

// Linux signal numbers (the same on x86-64 and arm64)
const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15 }

/**
 * `/proc/<pid>/status`: the name, the four uids and gids (real, effective, saved, file system) and, from the SigCgt
 * and SigIgn masks, whether the process has a handler for SIGINT and SIGTERM or ignores them. A signal PID 1 has no
 * handler for is not delivered to it at all, so `caught` says whether a `docker stop` can reach it.
 */
export function parseProcStatus(text) {
  const fields = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const match = /^(\w+):\s*(.*?)\s*$/.exec(line)
    if (match) fields.set(match[1], match[2])
  }
  const number = key => (/^\d+$/.test(fields.get(key) ?? '') ? Number(fields.get(key)) : null)
  const ids = key => {
    const parts = (fields.get(key) ?? '').split(/\s+/).filter(Boolean)
    if (parts.length !== 4 || !parts.every(part => /^\d+$/.test(part))) return null
    const [real, effective, saved, fs] = parts.map(Number)
    return { real, effective, saved, fs }
  }
  const signals = key => {
    const hex = fields.get(key)
    if (!/^[0-9a-fA-F]+$/.test(hex ?? '')) return null
    const mask = BigInt(`0x${hex}`)
    return Object.fromEntries(
      Object.entries(SIGNAL_NUMBERS).map(([name, n]) => [name, ((mask >> BigInt(n - 1)) & 1n) === 1n])
    )
  }
  return {
    name: fields.get('Name') ?? null,
    pid: number('Pid'),
    ppid: number('PPid'),
    uid: ids('Uid'),
    gid: ids('Gid'),
    caught: signals('SigCgt'),
    ignored: signals('SigIgn'),
  }
}

/** What `docker container inspect --format '{{json .State}}'` printed, as the few fields this check reads. */
export function parseState(text) {
  let state
  try {
    state = JSON.parse(text)
  } catch {
    state = null
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new StepFailed(`docker inspect did not print a State object: ${JSON.stringify(String(text).slice(0, 200))}`)
  }
  const probes = Array.isArray(state.Health?.Log) ? state.Health.Log : []
  const last = probes[probes.length - 1]
  return {
    status: state.Status ?? null,
    running: state.Running === true,
    exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
    oomKilled: state.OOMKilled === true,
    error: state.Error || null,
    // 'starting', 'healthy' or 'unhealthy'; null when the image has no health check
    health: state.Health?.Status ?? null,
    lastProbe: last
      ? {
          exitCode: last.ExitCode ?? null,
          output: String(last.Output ?? '')
            .trim()
            .slice(-400),
        }
      : null,
    startedAt: state.StartedAt ?? null,
    finishedAt: state.FinishedAt ?? null,
  }
}

/**
 * `docker logs --timestamps` gives the container's stdout and stderr on two streams; this puts their lines back in
 * the order of their timestamps (fixed-width, so they sort as text). A line without one stays behind the line
 * before it.
 */
export function mergeLogs(stdout, stderr) {
  const entries = []
  for (const [stream, text] of [
    ['stdout', stdout],
    ['stderr', stderr],
  ]) {
    let key = ''
    for (const line of String(text ?? '').split('\n')) {
      if (!line) continue
      const stamp = /^\d{4}-\d\d-\d\dT[\d:.]+Z?\S*(?= |$)/.exec(line)
      if (stamp) key = stamp[0]
      entries.push({ key, stream, line })
    }
  }
  // (Array.prototype.sort is stable: lines of one stream with the same stamp keep their order)
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return entries.map(entry => entry.line).join('\n')
}

export function tailOf(text, lines = 40, characters = 6000) {
  return String(text ?? '')
    .trim()
    .split('\n')
    .slice(-lines)
    .join('\n')
    .slice(-characters)
}

/**
 * What a stop has to show, for a signal and the timeout `docker stop` was given.
 * The two required lines are the server's own (src/server/shutdown.js, ServerNetwork.flushBeforeExit); the forbidden
 * ones are what it prints when something was not saved, when the save ran out of time, when a second signal cut it
 * short, or when the signal found no world to save.
 */
export function stopExpectation({ signal, timeoutS }) {
  return {
    signal,
    timeoutS,
    maxElapsedMs: Math.round(timeoutS * 1000 * STOP_ELAPSED_PART),
    required: [`[server] ${signal}: saving the world before exit`, '[network] final save complete'],
    forbidden: [
      '[network] not persisted',
      '[server] the final save did not return in time',
      '[server] final save failed',
      'again: exiting without waiting for the final save',
      'during start-up, before the world was loaded',
    ],
  }
}

function exitCodeMeaning(code, timeoutS) {
  if (code === 137) {
    return `128 + 9: killed. Nothing in the container ended on the signal within the ${timeoutS} s, so Docker sent SIGKILL`
  }
  if (code === 143) return '128 + 15: ended by SIGTERM itself, not by a handler that saved and exited'
  if (code === 130) return '128 + 2: ended by SIGINT itself, not by a handler that saved and exited'
  if (code === 1) {
    return 'the server exits 1 when something was not saved, when the save did not return in time, or on a second signal'
  }
  return 'the exit code is PID 1’s'
}

/**
 * The verdict on one stop: `ok` and, when it is not, every reason. `log` is the container's whole output.
 * A stop is good when the container was gone well before the timeout, PID 1 exited 0, and the server said that it
 * got this signal and that the final save completed, without any of the lines that say otherwise.
 */
export function judgeStop({ signal, timeoutS, exitCode, running = false, oomKilled = false, elapsedMs, log }) {
  const expected = stopExpectation({ signal, timeoutS })
  const lines = String(log ?? '').split('\n')
  const reasons = []
  if (running) reasons.push('the container is still running after `docker stop`')
  if (exitCode !== 0) reasons.push(`exit code ${exitCode}, expected 0 (${exitCodeMeaning(exitCode, timeoutS)})`)
  if (oomKilled) reasons.push('Docker reports the container as killed for memory (OOMKilled)')
  if (!(elapsedMs < expected.maxElapsedMs)) {
    reasons.push(
      `the stop took ${(elapsedMs / 1000).toFixed(1)} s: not under ${expected.maxElapsedMs / 1000} s (the timeout is ${timeoutS} s, after which the container is killed)`
    )
  }
  const found = {}
  for (const wanted of expected.required) {
    found[wanted] = lines.some(line => line.includes(wanted))
    if (!found[wanted]) reasons.push(`the log has no \`${wanted}\` line`)
  }
  const unwanted = lines.filter(line => expected.forbidden.some(part => line.includes(part)))
  for (const line of unwanted) reasons.push(`the log says: ${line.trim().slice(0, 300)}`)
  return { ok: reasons.length === 0, reasons, signal, timeoutS, exitCode, elapsedMs, found, unwanted }
}

// ---------------------------------------------------------------------------------------------------------------
// A stand-in for the docker CLI in which every step goes well: what `--dry-run` runs the check against (to print
// the commands in their order without running one) and what the tests start from. `respond(args, state)` may answer
// a command differently: it returns the parts of a result to change, or nothing.
// ---------------------------------------------------------------------------------------------------------------
export const SIMULATED_PS = [
  'PID   PPID  USER     COMMAND',
  '    1     0 root     npm run start',
  '   18     1 root     sh -c node build/index.js',
  '   19    18 root     node build/index.js',
  '   52     0 root     ps -o pid,ppid,user,args',
].join('\n')

export const SIMULATED_STATUS = [
  'Name:\tnpm run start',
  'Pid:\t1',
  'PPid:\t0',
  'Uid:\t0\t0\t0\t0',
  'Gid:\t0\t0\t0\t0',
  'SigIgn:\t0000000001001000',
  'SigCgt:\t0000000188004a03',
].join('\n')

export function simulatedDocker({ commitHash = 'simulated', respond = () => undefined, stopped = new Map() } = {}) {
  const calls = []
  // which containers were stopped, and with which signal
  const state = { stopped }
  const ok = (stdout = '', ms = 0) => ({ code: 0, stdout, stderr: '', ms })
  const answer = args => {
    const name = args[args.length - 1]
    const [first, second] = args
    if (first === 'version') return ok('simulated simulated')
    if (first === 'image' && second === 'inspect') {
      return ok(JSON.stringify({ User: '', Entrypoint: ['docker-entrypoint.sh'], Cmd: ['npm', 'run', 'start'] }))
    }
    if (first === 'container' && second === 'inspect') {
      const running = !state.stopped.has(name)
      return ok(
        JSON.stringify({
          Status: running ? 'running' : 'exited',
          Running: running,
          ExitCode: 0,
          OOMKilled: false,
          Health: { Status: 'healthy', Log: [] },
        })
      )
    }
    if (first === 'exec') {
      const command = args.slice(2)
      if (command[0] === 'ps') return ok(SIMULATED_PS)
      if (command[0] === 'cat') return ok(SIMULATED_STATUS)
      if (command[0] === 'readlink') return ok('/usr/local/bin/node')
      if (command[0] === 'curl') return ok(JSON.stringify({ commitHash, connectedUsers: 0 }))
      return ok()
    }
    if (first === 'stop') {
      const at = args.indexOf('--signal')
      state.stopped.set(name, at === -1 ? 'SIGTERM' : args[at + 1])
      return ok(name, 400)
    }
    if (first === 'logs') {
      const signal = state.stopped.get(name)
      const lines = ['server listening on port 3000']
      if (signal) {
        lines.push(
          `[server] ${signal}: saving the world before exit (deadline 3500 ms)`,
          '[network] final save complete'
        )
      }
      return ok(lines.join('\n'))
    }
    return ok()
  }
  const docker = async args => {
    calls.push(args)
    const custom = respond(args, state)
    const result = answer(args)
    return custom ? { ...result, ...custom } : result
  }
  docker.calls = calls
  return docker
}

// ---------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------

/**
 * Builds the image, runs it three times on one volume and stops it. Resolves with the summary (`ok`, `failures` and
 * what was seen); it does not throw for a failed step. Whatever happens, what it created is removed at the end.
 *
 *   docker(args, { timeoutMs, inherit }) -> { code, stdout, stderr, ms }
 *     the docker CLI. It may throw: an error with `interrupted` set (the signal's name) ends the run without
 *     counting as a failure of the image; any other error is a failed step. What a signal does to a command is the
 *     caller's to decide, by commandKind(args).
 *   interrupted() -> the signal's name once the script was told to stop, else null: the cleanup then goes straight
 *     to the removals. sleep(ms) may throw such an error too (the wait between health polls).
 *   report.command(args) / report.info(text): the output. saveLog(role, text): a container's whole log.
 */
export async function runImageCheck({
  docker,
  model: modelName = 'current',
  names,
  repoDir,
  commitHash,
  env,
  report,
  saveLog = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  interrupted = () => null,
}) {
  const model = modelFor(modelName)
  const summary = {
    model: model.name,
    ok: false,
    interrupted: null,
    commitHash,
    names,
    docker: null,
    image: null,
    containers: [],
    failures: [],
    cleanup: [],
  }
  // 'maybe': the command that creates it was started; 'yes': it succeeded
  const created = { image: null, volume: null, containers: new Map() }
  const logs = new Map()
  const seconds = since => ((now() - since) / 1000).toFixed(1)
  const fail = reason => {
    summary.failures.push(reason)
    report.info(`FAILED: ${reason}`)
  }
  const run = (args, { quiet = false, ...options } = {}) => {
    // (after a signal only the removals run: another command is not printed, and the docker function refuses it)
    if (!quiet && !(interrupted() && commandKind(args) !== 'remove')) report.command(args)
    return docker(args, options)
  }
  const said = result => tailOf(result.stderr || result.stdout, 6, 1200) || 'no output'
  // a command the rest depends on
  const must = async (args, options) => {
    const result = await run(args, options)
    if (result.code !== 0) {
      const output = options?.inherit ? 'its output is above' : said(result)
      throw new StepFailed(`\`docker ${formatCommand(args)}\` exited ${result.code}: ${output}`)
    }
    return result
  }
  // a command whose answer is only recorded: null (and a line saying so) when it fails
  const look = async args => {
    const result = await run(args)
    if (result.code === 0) return result.stdout.trim()
    report.info(`  (not available: exited ${result.code}: ${said(result)})`)
    return null
  }
  const indented = text => report.info(text.replace(/^/gm, '    '))

  // The container's whole output, kept for the artifact. `final` once the container has stopped.
  const collectLog = async (record, { final = false } = {}) => {
    if (logs.get(record.name)?.final) return logs.get(record.name).text
    const result = await run(['logs', '--timestamps', record.name])
    if (result.code !== 0) {
      report.info(`  (no logs: exited ${result.code}: ${said(result)})`)
      return logs.get(record.name)?.text ?? ''
    }
    const text = mergeLogs(result.stdout, result.stderr)
    logs.set(record.name, { text, final })
    saveLog(record.role, text)
    return text
  }
  const showTail = (record, text) => {
    report.info(`the end of ${record.name}'s log:`)
    indented(tailOf(text) || '(empty)')
  }

  async function startAndWait(role) {
    const name = names.containers[role]
    const record = { role, name, healthy: null }
    summary.containers.push(record)
    report.info(`${role}: a container of ${names.image} on the volume ${names.volume}, started as the image starts`)
    created.containers.set(name, 'maybe')
    await must(buildRunArgs({ name, image: names.image, volume: names.volume, env }))
    created.containers.set(name, 'yes')
    const started = now()
    const inspect = stateArgs(name)
    report.info(`waiting for the health check: every ${HEALTH_INTERVAL_MS / 1000} s, at most ${HEALTH_POLLS} times`)
    let seen = null
    let state = null
    let wasUnhealthy = false
    try {
      for (let poll = 0; poll < HEALTH_POLLS; poll++) {
        state = parseState((await must(inspect, { quiet: poll > 0 })).stdout)
        const current = `${state.running ? 'running' : `not running (${state.status}, exit code ${state.exitCode})`}, health ${state.health ?? 'none'}`
        if (current !== seen) report.info(`  after ${seconds(started)} s: ${current}`)
        seen = current
        if (!state.running) {
          throw new StepFailed(
            `${name} stopped by itself before it was healthy (exit code ${state.exitCode}${state.error ? `, ${state.error}` : ''})`
          )
        }
        if (state.health === null)
          throw new StepFailed(`${name} has no health status: the image declares no HEALTHCHECK`)
        if (state.health === 'healthy') {
          record.healthy = { seconds: Number(seconds(started)), wasUnhealthy }
          return record
        }
        if (state.health === 'unhealthy') wasUnhealthy = true
        await sleep(HEALTH_INTERVAL_MS)
      }
      throw new StepFailed(
        `${name} was not healthy after ${seconds(started)} s (health ${state?.health}; the last probe exited ${state?.lastProbe?.exitCode} saying ${JSON.stringify(state?.lastProbe?.output ?? '')})`
      )
    } catch (err) {
      if (err instanceof StepFailed) showTail(record, await collectLog(record))
      throw err
    }
  }

  // The facts about a running container. Asserted: what the model's treeProblems name, and that the server answers
  // GET /status with the COMMIT_HASH this build was given. Everything else is recorded.
  async function observe(record) {
    const { name, role } = record
    const listing = await look(['exec', name, 'ps', '-o', 'pid,ppid,user,args'])
    record.ps = listing
    if (listing) indented(listing)
    const tree = classifyTree(parsePs(listing))
    record.tree = tree
    for (const line of describeTree(tree)) report.info(`  ${line}`)

    const status = await look(['exec', name, 'cat', '/proc/1/status'])
    const exe = await look(['exec', name, 'readlink', '/proc/1/exe'])
    const pid1 = { exe, status: status ? parseProcStatus(status) : null }
    record.pid1 = pid1
    const handlers = caught =>
      caught
        ? `SIGTERM ${caught.SIGTERM ? 'handled' : 'NOT handled'}, SIGINT ${caught.SIGINT ? 'handled' : 'NOT handled'}`
        : 'handlers unknown'
    report.info(
      `  PID 1: executable ${exe ?? 'unknown'}, name ${JSON.stringify(pid1.status?.name ?? null)}, uid ${pid1.status?.uid?.effective ?? 'unknown'}, ${handlers(pid1.status?.caught)}`
    )
    if (tree.server && tree.server.pid !== 1) {
      const text = await look(['exec', name, 'cat', `/proc/${tree.server.pid}/status`])
      record.server = { pid: tree.server.pid, status: text ? parseProcStatus(text) : null }
      report.info(
        `  the server (pid ${tree.server.pid}): uid ${record.server.status?.uid?.effective ?? 'unknown'}, ${handlers(record.server.status?.caught)}`
      )
    }
    for (const problem of model.treeProblems({ tree, pid1 })) fail(`${role}: ${problem}`)

    const answer = await look([
      'exec',
      name,
      'curl',
      '-fsS',
      '--max-time',
      '5',
      `http://127.0.0.1:${CONTAINER_PORT}/status`,
    ])
    let served = null
    try {
      served = JSON.parse(answer)?.commitHash ?? null
    } catch {
      // (not JSON: reported below)
    }
    record.status = { commitHash: served }
    if (served === commitHash) report.info(`  GET /status: commitHash ${served}, the build argument`)
    else fail(`${role}: GET /status did not answer with commitHash ${commitHash} (got ${JSON.stringify(answer)})`)

    record.world = await look(['exec', name, 'ls', '-ln', WORLD_PATH])
    if (record.world) indented(record.world)
  }

  async function stop(record, expectation) {
    const { name, role } = record
    const { signal, timeoutS } = expectation
    report.info(`${role}: stopping with ${signal}, ${timeoutS} s before the kill`)
    const stopped = await must(stopArgs(expectation, name), { timeoutMs: (timeoutS + 30) * 1000 })
    const state = parseState((await must(stateArgs(name))).stdout)
    const log = await collectLog(record, { final: !state.running })
    const verdict = judgeStop({
      signal,
      timeoutS,
      exitCode: state.exitCode,
      running: state.running,
      oomKilled: state.oomKilled,
      elapsedMs: stopped.ms,
      log,
    })
    record.stop = { ...verdict, startedAt: state.startedAt, finishedAt: state.finishedAt }
    report.info(
      `  \`docker stop\` returned after ${(stopped.ms / 1000).toFixed(1)} s; exit code ${state.exitCode}; ` +
        Object.entries(verdict.found)
          .map(([line, there]) => `\`${line}\`: ${there ? 'in the log' : 'MISSING'}`)
          .join('; ')
    )
    if (verdict.ok) {
      report.info(`  ${signal}: the server saved and the container exited 0 by itself`)
      return
    }
    for (const reason of verdict.reasons) fail(`${role} (${signal}, ${timeoutS} s): ${reason}`)
    // (what was read from /proc/1/status in the first container: every container of the image starts the same way)
    const caught = summary.containers[0]?.pid1?.status?.caught
    if (caught && caught[signal] === false) {
      report.info(
        `  note: PID 1 has no handler for ${signal}, and the kernel delivers no signal to PID 1 that it has no handler for`
      )
    }
    showTail(record, log)
  }

  async function cleanup() {
    const remove = async (what, args, state) => {
      let result
      try {
        result = await run(args)
      } catch (err) {
        result = { code: null, stdout: '', stderr: err.message }
      }
      summary.cleanup.push({ what, command: `docker ${formatCommand(args)}`, code: result.code })
      if (result.code === 0) return
      // (something whose creation did not finish may not be there: only what was created for certain has to go)
      if (state === 'yes') fail(`cleanup: ${what} was not removed (exit ${result.code}: ${said(result)})`)
      else report.info(`  (${what}: exit ${result.code}; its creation had not finished)`)
    }
    for (const record of summary.containers) {
      if (created.containers.get(record.name) !== 'yes' || logs.get(record.name)?.final) continue
      // (after a signal the removals go first: the logs not yet taken are left)
      if (interrupted()) {
        report.info(`  (${record.name}'s log is not taken after ${interrupted()}: the removals go first)`)
        continue
      }
      // (a container that was never stopped here: its log is taken before it goes)
      await collectLog(record).catch(() => {})
    }
    const containers = [...created.containers.keys()]
    const certain = [...created.containers.values()].every(state => state === 'yes') ? 'yes' : 'maybe'
    if (containers.length) await remove('the containers', ['rm', '-f', ...containers], certain)
    if (created.volume) await remove('the volume', ['volume', 'rm', names.volume], created.volume)
    if (created.image) await remove('the image tag', ['image', 'rm', names.image], created.image)
  }

  try {
    const version = await must(['version', '--format', '{{.Client.Version}} {{.Server.Version}}'])
    const [client, server] = version.stdout.trim().split(/\s+/)
    summary.docker = { client: client ?? null, server: server ?? null }
    report.info(`docker client ${client}, server ${server}; model ${model.name}`)

    // a. the image, from the repository root, as `docker build .` makes it
    created.image = 'maybe'
    const built = await must(['build', '--build-arg', `COMMIT_HASH=${commitHash}`, '-t', names.image, repoDir], {
      timeoutMs: BUILD_TIMEOUT_MS,
      inherit: true,
    })
    created.image = 'yes'
    summary.image = { tag: names.image, buildSeconds: Math.round(built.ms / 1000), config: null }
    report.info(`built ${names.image} in ${(built.ms / 1000).toFixed(1)} s`)
    const config = await look(['image', 'inspect', '--format', '{{json .Config}}', names.image])
    try {
      const parsed = JSON.parse(config)
      summary.image.config = {
        user: parsed.User ?? null,
        entrypoint: parsed.Entrypoint ?? null,
        cmd: parsed.Cmd ?? null,
        workingDir: parsed.WorkingDir ?? null,
        healthcheck: parsed.Healthcheck?.Test ?? null,
        stopSignal: parsed.StopSignal ?? null,
        volumes: parsed.Volumes ? Object.keys(parsed.Volumes) : [],
      }
      report.info(`the image's configuration: ${JSON.stringify(summary.image.config)}`)
    } catch {
      report.info('  (the image configuration was not readable as JSON)')
    }

    // b. one volume for the world, kept from container to container
    created.volume = 'maybe'
    await must(['volume', 'create', names.volume])
    created.volume = 'yes'

    // b–e. the first container: healthy, the process tree, a stop with Docker's defaults
    const first = await startAndWait('sigterm')
    await observe(first)
    await stop(first, STOPS.sigterm)

    // f. a fresh container on the same volume, stopped the way Fly stops by default
    const second = await startAndWait('sigint')
    await stop(second, STOPS.sigint)

    // g. the world the two runs wrote loads again
    const third = await startAndWait('restart')
    report.info(`restart: healthy after ${third.healthy.seconds} s on the volume of the two stopped runs`)
  } catch (err) {
    if (err?.interrupted) {
      summary.interrupted = err.interrupted
      report.info(`interrupted by ${err.interrupted}`)
    } else {
      fail(err instanceof Error ? err.message : String(err))
    }
  } finally {
    // h. always
    report.info('cleaning up what this run created')
    await cleanup()
  }
  summary.ok = summary.failures.length === 0 && !summary.interrupted
  return summary
}
