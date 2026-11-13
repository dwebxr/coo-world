// What `scripts/image-check.mjs` is made of. Nothing here starts a process: the `docker` CLI is a function the caller
// passes in (`docker(args, options) -> { code, stdout, stderr, ms }`), so the order of the commands, what is read
// out of their output and what is made of it run in the tests (test/imageCheck.test.js) on canned output, on a
// machine without Docker. Only Node's own modules are used: the workflow runs the script without `npm ci`.
import { serverStartEnv } from './startEnv.mjs'

// `WORLD` is joined to the directory above build/ (src/server/index.js): /app in the image
export const WORLD_NAME = 'world'
export const WORLD_PATH = `/app/${WORLD_NAME}`
// the port the containers listen on. The current image's HEALTHCHECK asks port 3000 whatever PORT is; the nonroot
// image's asks PORT, and one container of that model listens on OTHER_PORT to show it
export const CONTAINER_PORT = 3000
export const OTHER_PORT = 3100

// --model=nonroot: the uid and gid the entrypoint (scripts/coo-entrypoint.sh) gives the world folder to and runs the
// server as; a user of no account in the image, for a container started with `docker run --user`; and a WORLD the
// entrypoint refuses (it names /app/build)
export const SERVICE_ID = 1001
export const OTHER_USER = '2000:2000'
export const REFUSED_WORLD = 'build'
// The lines --model=nonroot looks for, as parts of a line. test/imageCheck.test.js holds each to its source.
export const ENTRYPOINT_LINES = {
  // scripts/coo-entrypoint.sh: say "entries given to 1001:1001 under $dir: ${#before}"
  given: '[entrypoint] entries given to 1001:1001 under ',
  // scripts/coo-entrypoint.sh: say "started as uid $uid, not as root: nothing under $dir changes owner, …"
  notRoot: '[entrypoint] started as uid ',
  // scripts/coo-entrypoint.sh: die "refused: WORLD names $dir. The world folder is given to 1001:1001, …"
  refused: '[entrypoint] refused: WORLD names ',
}
// src/server/startupExit.js: proc.stderr.write(`[server] start-up failed; exiting with code 1: ${describe(err)}\n`, …)
export const STARTUP_FAILED = '[server] start-up failed; exiting with code 1: '

// `docker stop -t 10` is Docker's own default; SIGINT with 5 s is what Fly documents as its defaults (kill_signal,
// kill_timeout)
export const STOPS = {
  sigterm: { signal: 'SIGTERM', timeoutS: 10 },
  sigint: { signal: 'SIGINT', timeoutS: 5 },
}
// a stop counts as "well under" its timeout up to this part of it: 8 s of the 10 s, 4 s of the 5 s. The server's
// own limit for the final save is 3.5 s (SHUTDOWN_DEADLINE_MS in src/server/shutdown.js), after which it exits 1.
// It is judged on Docker's own timestamps (stopTiming): from the kill Docker records when it sends the signal to
// the container's exit. When those cannot be read, the `docker stop` command's own duration is judged instead,
// against the whole timeout: it holds the CLI's start and the runner's scheduling too, but a container killed after
// the timeout still fails it.
const STOP_ELAPSED_PART = 0.8
// `docker events --since` is this much before the `docker stop` is started (the daemon's clock is this machine's)
const EVENTS_SINCE_MARGIN_MS = 1000
// `docker events` with an --until in the past prints what the daemon holds and ends: this is long for that
export const EVENTS_TIMEOUT_MS = 15 * 1000

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
  // The image with scripts/coo-entrypoint.sh as its ENTRYPOINT and `node build/index.js` as its CMD: the entrypoint
  // starts as root, gives the world folder to 1001:1001 and replaces itself with the server through `su-exec`. Must
  // hold: PID 1 is the server itself (`node build/index.js`, its executable node: no npm, no shell between), and its
  // real, effective, saved and file-system uid and gid are all 1001. The further runs of this model (a volume
  // written by root, mixed ownership, a second start, another PORT, another user, a refused WORLD) are in
  // runImageCheck.
  nonroot: {
    name: 'nonroot',
    // readlink /proc/1/exe needs ptrace access to PID 1, and root in a container has no CAP_SYS_PTRACE (not among
    // Docker's default capabilities): PID 1's own user may read it, so it is asked as that user
    pid1User: `${SERVICE_ID}:${SERVICE_ID}`,
    treeProblems({ tree, pid1 }) {
      const problems = []
      if (!tree.server) problems.push('no `node build/index.js` process is running in the container')
      const command = tree.pid1 ? tree.pid1.args.replace(/^\{[^}]*\}\s+/, '') : null
      if (command !== 'node build/index.js') {
        problems.push(
          `PID 1 is not \`node build/index.js\`: ${command === null ? 'no PID 1 in the listing' : `it is \`${command}\``}`
        )
      }
      const exe = pid1?.exe ?? null
      if (exe === null || baseName(exe) !== 'node') problems.push(`PID 1's executable is ${exe ?? 'unknown'}, not node`)
      for (const key of ['uid', 'gid']) {
        const ids = pid1?.status?.[key] ?? null
        if (ids === null) {
          problems.push(`PID 1's ${key} could not be read from /proc/1/status`)
        } else if (Object.values(ids).some(id => id !== SERVICE_ID)) {
          problems.push(
            `PID 1's ${key} is ${Object.values(ids).join(' ')} (real, effective, saved, file system), not ${SERVICE_ID} in all four`
          )
        }
      }
      return problems
    },
  },
}

export function modelFor(name) {
  if (Object.hasOwn(MODELS, name)) return MODELS[name]
  throw new UsageError(`unknown model ${JSON.stringify(name)} (known: ${Object.keys(MODELS).join(', ')})`)
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

// Everything a run creates carries the run's own id: the cleanup removes these names and nothing else. The current
// model uses the first three containers and the first volume; --model=nonroot all of them.
export function runNames(id) {
  const prefix = `image-check-${id}`
  const roles = ['sigterm', 'sigint', 'restart', 'legacy', 'chown', 'port', 'otheruser', 'refused', 'imagefiles']
  return {
    prefix,
    image: `${prefix}:check`,
    volume: `${prefix}-world`,
    freshVolume: `${prefix}-fresh`,
    containers: Object.fromEntries(roles.map(role => [role, `${prefix}-${role}`])),
  }
}

export function containerEnv(jwtSecret) {
  return serverStartEnv({ world: WORLD_NAME, port: CONTAINER_PORT, jwtSecret })
}

/** The same settings for a server on another port: PORT and the three addresses a browser would use. */
export function envOnPort(env, port) {
  return { ...env, ...serverStartEnv({ world: env.WORLD, port, jwtSecret: env.JWT_SECRET }) }
}

// `docker run` the way the image starts by itself: its ENTRYPOINT and CMD, its user, no init added, and no port
// published to the host (the server is reached from inside the container). --model=nonroot also starts it otherwise:
// `user` (--user), `entrypoint` (--entrypoint, which also drops the image's CMD: `command` is then all the
// arguments), without a volume (`volume: null`), and in the foreground (`detach: false`: the command returns when
// the container has ended, with its exit code and output).
export function buildRunArgs({
  name,
  image,
  volume = null,
  worldPath = WORLD_PATH,
  env = {},
  user = null,
  entrypoint = null,
  command = [],
  detach = true,
}) {
  const args = ['run', ...(detach ? ['-d'] : []), '--name', name]
  if (user !== null) args.push('--user', user)
  if (entrypoint !== null) args.push('--entrypoint', entrypoint)
  if (volume !== null) args.push('-v', `${volume}:${worldPath}`)
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
  args.push(image, ...command)
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

// A time for `docker events --since/--until`: Unix seconds with nine digits of fraction, the form the docker CLI
// documents ("seconds[.nanoseconds]") and itself sends to the daemon.
export function unixTimestamp(ms) {
  const whole = Math.floor(ms)
  return `${Math.floor(whole / 1000)}.${String(whole % 1000).padStart(3, '0')}000000`
}

// What Docker recorded of one container between two times: its container events (kill, die, stop, exec_…, …), one
// JSON object per line. With an --until in the past the daemon prints what it holds and ends; it holds the last 256
// events of all containers, and between a stop and this command there are a handful.
export function eventsArgs(name, { sinceMs, untilMs }) {
  return [
    'events',
    '--since',
    unixTimestamp(sinceMs),
    '--until',
    unixTimestamp(untilMs),
    '--filter',
    `container=${name}`,
    '--filter',
    'type=container',
    '--format',
    '{{json .}}',
  ]
}

// A setting whose name says it is secret: SECRET, KEY, TOKEN, PASSWORD or CODE in it, in any case. Its value is not
// printed: the harness should not teach the habit of printing such settings, even though every value it gives is
// made up for the run. (Written in lower case: test/envExample.test.js holds that no code names a bare upper-case
// setting word such as the fourth one.)
const SECRET_NAME = /secret|key|token|password|code/i
export const MASKED = '***'

/** The arguments as they are printed: the value of an `-e NAME=value` (`--env`, `--env=`) with a secret NAME masked. */
export function maskSecrets(args) {
  const masked = setting => {
    const equals = setting.indexOf('=')
    return equals > 0 && SECRET_NAME.test(setting.slice(0, equals))
      ? `${setting.slice(0, equals + 1)}${MASKED}`
      : setting
  }
  return args.map((arg, i) => {
    if (args[i - 1] === '-e' || args[i - 1] === '--env') return masked(arg)
    if (arg.startsWith('--env=')) return `--env=${masked(arg.slice('--env='.length))}`
    return arg
  })
}

// For reading only: the command as one would type it in a shell, secret-named settings masked (maskSecrets). Nothing
// is ever run through a shell, and what docker is given is the arguments as they are.
export function formatCommand(args) {
  return maskSecrets(args)
    .map(arg => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(' ')
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
 * The lines of `docker events --format '{{json .}}'`, each an event as the Engine API describes it (EventMessage):
 * `Action` ('kill', 'die', 'stop', 'exec_die', …), `Actor.Attributes` (strings: `signal` on a kill, `exitCode` on a
 * die), `timeNano` (nanoseconds since the epoch, on the daemon's clock). An event without an Action or a timeNano
 * is not used: it is counted in `unreadable`. (timeNano is above 2^53, so as a JS number it loses a few hundred
 * nanoseconds: nothing that shows in milliseconds.)
 */
export function parseEvents(text) {
  const events = []
  let unreadable = 0
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      event = null
    }
    if (typeof event?.Action !== 'string' || !Number.isFinite(event?.timeNano)) {
      unreadable++
      continue
    }
    const raw = event.Actor?.Attributes
    const attributes = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    events.push({ type: event.Type ?? null, action: event.Action, ms: event.timeNano / 1e6, attributes })
  }
  return { events, unreadable }
}

/** A time as `docker inspect` gives it (RFC 3339 with up to nine digits of fraction), in ms; null for Docker's zero time. */
export function parseDockerTime(text) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(String(text ?? ''))
  if (!match) return null
  const seconds = Date.parse(`${match[1]}${match[3]}`)
  // ("0001-01-01T00:00:00Z": the container has not exited)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return seconds + Number(`0.${match[2] ?? '0'}`) * 1000
}

// a signal as a kill event names it: its number, as text
const SIGNAL_NAMES = { 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' }
const signalName = value => SIGNAL_NAMES[value] ?? (value === undefined ? 'unknown' : String(value))

/**
 * How long a stop took by Docker's own clock, and what Docker did:
 *   source 'events'             from the stop's first `kill` event (Docker sends the stop signal and records it) to
 *                               the container's `die` event after it;
 *   source 'events+FinishedAt'  the same, to the container's State.FinishedAt when no `die` event was read;
 *   source 'cli'                Docker's pair could not be had (`why`): `ms` is then `cliMs`, how long the
 *                               `docker stop` command took in this script, which stopExpectation judges more loosely.
 * Always recorded: `cliMs`, `signals` (every kill of the stop: one, or the signal and then SIGKILL after the timeout)
 * and `dieExitCode` (the exit code the die event carries; null without one).
 */
export function stopTiming({ events = [], finishedAt = null, cliMs, unavailable = null }) {
  const kills = events.filter(event => event.action === 'kill')
  const first = kills[0] ?? null
  // (the events come in the order Docker recorded them)
  const die = first ? (events.slice(events.indexOf(first) + 1).find(event => event.action === 'die') ?? null) : null
  const exitCode = die?.attributes.exitCode
  const record = {
    cliMs,
    signals: kills.map(event => signalName(event.attributes.signal)),
    dieExitCode: /^-?\d+$/.test(exitCode ?? '') ? Number(exitCode) : null,
  }
  const finishedMs = parseDockerTime(finishedAt)
  // (to the microsecond: what is below it is the rounding of timeNano to a double)
  const between = (from, to) => Math.max(0, Math.round((to - from) * 1000) / 1000)
  if (first && die) return { source: 'events', ms: between(first.ms, die.ms), ...record }
  if (first && finishedMs !== null) return { source: 'events+FinishedAt', ms: between(first.ms, finishedMs), ...record }
  const why =
    unavailable ?? (first ? 'no `die` event and no State.FinishedAt after the kill' : 'no `kill` event in the window')
  return { source: 'cli', ms: cliMs, why, ...record }
}

/** One line about a stop's timing, for the output. */
export function describeTiming(timing) {
  const cli = `the \`docker stop\` command took ${(timing.cliMs / 1000).toFixed(1)} s`
  if (timing.source === 'cli') {
    return `Docker's own times not read (${timing.why}): ${cli}, judged against the whole timeout`
  }
  const end =
    timing.source === 'events'
      ? `its die event (exitCode ${timing.dieExitCode ?? 'unknown'})`
      : 'its State.FinishedAt (no die event read)'
  return `by Docker's clock ${timing.signals.join(', then ')} sent, and ${end} ${(timing.ms / 1000).toFixed(3)} s later; ${cli}`
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

/**
 * The entrypoint's lines saying how many entries it gave to 1001:1001 (scripts/coo-entrypoint.sh prints one on each
 * start as root, 0 included): `{ dir, count }` for each, in the order of the log.
 */
export function entrypointCounts(log) {
  const counts = []
  for (const line of String(log ?? '').split('\n')) {
    const at = line.indexOf(ENTRYPOINT_LINES.given)
    if (at === -1) continue
    const match = /^(.*): (\d+)\s*$/.exec(line.slice(at + ENTRYPOINT_LINES.given.length))
    if (match) counts.push({ dir: match[1], count: Number(match[2]) })
  }
  return counts
}

/** The lines of `docker diff` (`C /app`, `A /app/world`, …) that name a path at or under `folder`. */
export function changedUnder(diff, folder) {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`
  return String(diff ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      const match = /^[ACD] (.+)$/.exec(line)
      return match && (match[1] === folder || match[1].startsWith(prefix))
    })
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
 * The lines the server prints when something was not stopped or not saved, as parts of a line: any of them in a
 * stopped container's log fails the stop, whatever the exit code (the handler still exits 0 after a failed
 * stopWorld or close, and a failed write is retried before the final save gives up). Each is quoted from where it
 * is printed. test/imageCheck.test.js holds every part to its source and fails on a log call in installShutdown
 * or on the final save's path in ServerNetwork.js that this list neither forbids nor its own list allows.
 */
export const NOT_STOPPED_OR_SAVED = [
  // src/server/shutdown.js:31   log.error(`[server] ${signal} again: exiting without waiting for the final save`)
  'again: exiting without waiting for the final save',
  // src/server/shutdown.js:36   log.log(`[server] ${signal} during start-up, before the world was loaded: nothing to save; exiting`)
  'during start-up, before the world was loaded',
  // src/server/shutdown.js:41   log.error('[server] the final save did not return in time; exiting')
  '[server] the final save did not return in time',
  // src/server/shutdown.js:49   log.error(`[server] stopping the world failed: ${briefError(err)}`)
  '[server] stopping the world failed',
  // src/server/shutdown.js:59   Promise.resolve(target.closeServer?.()).catch(err => log.error(`[server] close failed: ${briefError(err)}`))
  // src/server/shutdown.js:61   log.error(`[server] close failed: ${briefError(err)}`)
  '[server] close failed',
  // src/server/shutdown.js:68   log.error(`[server] final save failed: ${briefError(err)}`)
  '[server] final save failed',
  // src/core/systems/ServerNetwork.js:773-774 (flushBeforeExit)
  //   console.error(`[network] not persisted: blueprints=${…} apps=${…} config=${…} users=${…} storage=${…}`)
  '[network] not persisted',
  // src/core/systems/ServerNetwork.js:703 (saveDirty, a blueprint or app row)
  //   console.error(`[network] error saving ${table} ${id}: ${briefError(err)}`)
  // src/core/systems/ServerNetwork.js:805 (saveConfig, the settings or the spawn)
  //   this.logOnce(this, `config:${key}`, `[network] error saving ${key}: ${briefError(err)}`)
  '[network] error saving ',
  // src/core/systems/ServerNetwork.js:783 (saveConfig: the row was never read, and nothing of it is saved from here)
  //   this.logOnce(this, `config-unloaded:${key}`, `[network] ${key} was not loaded; changes will not be saved`)
  'was not loaded; changes will not be saved',
  // src/core/systems/ServerNetwork.js:927-928 (userRows' onFailure: a user's row the database refused)
  //   console.error(`[network] ${columns.join(', ')} of user ${…} not stored (kept in memory; written again …`)
  'not stored (kept in memory',
  // src/server/Storage.js:291 (the script storage file, which flushBeforeExit flushes through Storage.flush)
  //   console.error(`[storage] failed to save ${path.basename(this.file)} (${code}); retrying`)
  '[storage] failed to save ',
]

/**
 * What a stop has to show, for a signal and the timeout `docker stop` was given.
 * The two required lines are the server's own (src/server/shutdown.js, ServerNetwork.flushBeforeExit); the forbidden
 * ones are NOT_STOPPED_OR_SAVED.
 */
export function stopExpectation({ signal, timeoutS }) {
  return {
    signal,
    timeoutS,
    maxElapsedMs: Math.round(timeoutS * 1000 * STOP_ELAPSED_PART),
    // the bound on the `docker stop` command's own duration, when Docker's times could not be read
    maxCliMs: timeoutS * 1000,
    required: [`[server] ${signal}: saving the world before exit`, '[network] final save complete'],
    forbidden: [...NOT_STOPPED_OR_SAVED],
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
 * `elapsedFrom`: 'docker' when `elapsedMs` is Docker's own (stopTiming), 'cli' when it is the `docker stop`
 * command's duration, which is held to the whole timeout only.
 */
export function judgeStop({
  signal,
  timeoutS,
  exitCode,
  running = false,
  oomKilled = false,
  elapsedMs,
  elapsedFrom = 'docker',
  log,
}) {
  const expected = stopExpectation({ signal, timeoutS })
  const lines = String(log ?? '').split('\n')
  const reasons = []
  if (running) reasons.push('the container is still running after `docker stop`')
  if (exitCode !== 0) reasons.push(`exit code ${exitCode}, expected 0 (${exitCodeMeaning(exitCode, timeoutS)})`)
  if (oomKilled) reasons.push('Docker reports the container as killed for memory (OOMKilled)')
  const seconds = (elapsedMs / 1000).toFixed(1)
  if (elapsedFrom === 'cli') {
    if (!(elapsedMs < expected.maxCliMs)) {
      reasons.push(
        `the \`docker stop\` command took ${seconds} s (Docker's own times were not read): not under ${timeoutS} s, the timeout itself`
      )
    }
  } else if (!(elapsedMs < expected.maxElapsedMs)) {
    reasons.push(
      `the stop took ${seconds} s by Docker's clock, from its kill to the container's exit: not under ${expected.maxElapsedMs / 1000} s (the timeout is ${timeoutS} s, after which the container is killed)`
    )
  }
  const found = {}
  for (const wanted of expected.required) {
    found[wanted] = lines.some(line => line.includes(wanted))
    if (!found[wanted]) reasons.push(`the log has no \`${wanted}\` line`)
  }
  const unwanted = lines.filter(line => expected.forbidden.some(part => line.includes(part)))
  for (const line of unwanted) reasons.push(`the log says: ${line.trim().slice(0, 300)}`)
  return { ok: reasons.length === 0, reasons, signal, timeoutS, exitCode, elapsedMs, elapsedFrom, found, unwanted }
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

// --model=nonroot: the server is PID 1, as nodeuser
export const SIMULATED_PS_NONROOT = [
  'PID   PPID  USER     COMMAND',
  '    1     0 nodeuser node build/index.js',
  '   40     0 root     ps -o pid,ppid,user,args',
].join('\n')

export const SIMULATED_STATUS_NONROOT = [
  'Name:\tnode',
  'Pid:\t1',
  'PPid:\t0',
  'Uid:\t1001\t1001\t1001\t1001',
  'Gid:\t1001\t1001\t1001\t1001',
  'SigIgn:\t0000000000001000',
  'SigCgt:\t0000000188004a03',
].join('\n')

const SIMULATED_CONFIG = {
  current: { User: '', Entrypoint: ['docker-entrypoint.sh'], Cmd: ['npm', 'run', 'start'] },
  nonroot: {
    User: '',
    Entrypoint: ['/usr/local/bin/coo-entrypoint.sh'],
    Cmd: ['node', 'build/index.js'],
    Healthcheck: { Test: ['CMD-SHELL', 'curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1'] },
  },
}
// --model=nonroot: how many entries the entrypoint of each container gives to 1001:1001, in a run that goes well
const SIMULATED_GIVEN = { sigterm: 23, sigint: 1, restart: 0, port: 1 }

/**
 * The lines `docker events --format '{{json .}}'` prints for a stop, in the shape of the Engine API's EventMessage
 * (with the fields the CLI has long printed beside it: status, id, from): a kill with the signal's number, a second
 * kill with 9 when `killedAfterMs` is given, the die with its exit code, the stop. Times in ms since the epoch.
 */
export function simulatedStopEvents({ name, signal, killAtMs, exitAfterMs, exitCode = 0, killedAfterMs = null }) {
  const id = '4f1c9e0b7a2d'.repeat(5).slice(0, 64)
  const image = 'image-check-simulated:check'
  const event = (action, atMs, extra = {}) =>
    JSON.stringify({
      status: action,
      id,
      from: image,
      Type: 'container',
      Action: action,
      Actor: { ID: id, Attributes: { image, name, ...extra } },
      scope: 'local',
      time: Math.floor(atMs / 1000),
      timeNano: Math.round(atMs) * 1e6,
    })
  const lines = [event('kill', killAtMs, { signal: String(SIGNAL_NUMBERS[signal] ?? signal) })]
  if (killedAfterMs !== null) lines.push(event('kill', killAtMs + killedAfterMs, { signal: '9' }))
  lines.push(event('die', killAtMs + exitAfterMs, { execDuration: '9', exitCode: String(exitCode) }))
  lines.push(event('stop', killAtMs + exitAfterMs + 2))
  return lines.join('\n')
}

export function simulatedDocker({
  commitHash = 'simulated',
  model = 'current',
  respond = () => undefined,
  stopped = new Map(),
} = {}) {
  const calls = []
  // which containers were stopped, and with which signal
  const state = { stopped }
  const nonroot = model === 'nonroot'
  const ok = (stdout = '', ms = 0) => ({ code: 0, stdout, stderr: '', ms })
  // a container's role is the last part of its name (runNames): `image-check-<id>-<role>`
  const roleOf = name => String(name ?? '').slice(String(name ?? '').lastIndexOf('-') + 1)
  // --model=nonroot: the containers that end by themselves, with exit code 1
  const exits = name => nonroot && ['otheruser', 'refused'].includes(roleOf(name))
  const nonrootLog = role => {
    if (role === 'otheruser') {
      return [
        `${ENTRYPOINT_LINES.notRoot}2000, not as root: nothing under ${WORLD_PATH} changes owner, and the command runs as that user`,
        `${STARTUP_FAILED}Error: EACCES: permission denied, mkdir '${WORLD_PATH}/assets'`,
      ]
    }
    if (role === 'refused') {
      return [
        `${ENTRYPOINT_LINES.refused}/app/build. The world folder is given to 1001:1001, so it must not be /, /app, or at or under /app/build, /app/node_modules, /app/src or /app/scripts`,
      ]
    }
    const port = role === 'port' ? OTHER_PORT : CONTAINER_PORT
    if (role === 'legacy') return [`server listening on port ${port}`]
    return [`${ENTRYPOINT_LINES.given}${WORLD_PATH}: ${SIMULATED_GIVEN[role] ?? 0}`, `server listening on port ${port}`]
  }
  const answer = args => {
    const name = args[args.length - 1]
    const [first, second] = args
    if (first === 'version') return ok('simulated simulated')
    if (first === 'image' && second === 'inspect') return ok(JSON.stringify(SIMULATED_CONFIG[model]))
    if (first === 'container' && second === 'inspect') {
      if (exits(name)) {
        return ok(
          JSON.stringify({ Status: 'exited', Running: false, ExitCode: 1, Health: { Status: 'starting', Log: [] } })
        )
      }
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
      // `exec [--user u:g] <name> <command…>`
      const command = args.slice(second === '--user' ? 4 : 2)
      if (command[0] === 'ps') return ok(nonroot ? SIMULATED_PS_NONROOT : SIMULATED_PS)
      if (command[0] === 'cat') return ok(nonroot ? SIMULATED_STATUS_NONROOT : SIMULATED_STATUS)
      if (command[0] === 'readlink') return ok('/usr/local/bin/node')
      if (command[0] === 'curl') return ok(JSON.stringify({ commitHash, connectedUsers: 0 }))
      return ok()
    }
    if (first === 'stop') {
      const at = args.indexOf('--signal')
      state.stopped.set(name, at === -1 ? 'SIGTERM' : args[at + 1])
      return ok(name, 400)
    }
    if (first === 'events') {
      // the stop was sent a second into the window (EVENTS_SINCE_MARGIN_MS); the container exits 0.2 s later
      const container = args.find(arg => arg.startsWith('container='))?.slice('container='.length)
      const signal = state.stopped.get(container)
      if (!signal) return ok()
      const killAtMs = Number(args[args.indexOf('--since') + 1]) * 1000 + EVENTS_SINCE_MARGIN_MS
      return ok(simulatedStopEvents({ name: container, signal, killAtMs, exitAfterMs: 200 }))
    }
    if (first === 'logs') {
      const signal = state.stopped.get(name)
      const lines = nonroot ? nonrootLog(roleOf(name)) : ['server listening on port 3000']
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
 * Builds the image, runs it three times on one volume and stops it (--model=nonroot: the runs of runNonroot below).
 * Resolves with the summary (`ok`, `failures` and what was seen); it does not throw for a failed step. Whatever
 * happens, what it created is removed at the end.
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
    // --model=nonroot: the containers that only run one command in the foreground (chown, find)
    throwaway: [],
    failures: [],
    cleanup: [],
  }
  // 'maybe': the command that creates it was started; 'yes': it succeeded
  const created = { image: null, volumes: new Map(), containers: new Map() }
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
  const look = async (args, options) => {
    const result = await run(args, options)
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

  // `how`: what the output says of a container started otherwise than the image starts, with `runOptions` for
  // buildRunArgs (another user, entry point, volume or settings)
  async function startAndWait(role, { how = null, ...runOptions } = {}) {
    const name = names.containers[role]
    const record = { role, name, healthy: null }
    summary.containers.push(record)
    report.info(
      `${role}: a container of ${names.image} ${how ?? `on the volume ${names.volume}, started as the image starts`}`
    )
    created.containers.set(name, 'maybe')
    await must(buildRunArgs({ name, image: names.image, volume: names.volume, env, ...runOptions }))
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
    const as = model.pid1User ? ['--user', model.pid1User] : []
    const exe = await look(['exec', ...as, name, 'readlink', '/proc/1/exe'])
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
    const sinceMs = now() - EVENTS_SINCE_MARGIN_MS
    const stopped = await must(stopArgs(expectation, name), { timeoutMs: (timeoutS + 30) * 1000 })
    const state = parseState((await must(stateArgs(name))).stdout)
    const log = await collectLog(record, { final: !state.running })
    // What Docker itself recorded of the stop, on its own clock: the kill it sent and the container's exit. A
    // `docker events` that fails, hangs or runs out of time is not a failed step: the stop is then judged on the
    // CLI's time (stopTiming says so). A signal to the script still ends the run.
    let eventLines = null
    let unavailable = null
    try {
      eventLines = await look(eventsArgs(name, { sinceMs, untilMs: now() }), { timeoutMs: EVENTS_TIMEOUT_MS })
      if (eventLines === null) unavailable = '`docker events` failed'
    } catch (err) {
      if (err?.interrupted) throw err
      unavailable = `\`docker events\` failed: ${err?.message ?? err}`
      report.info(`  (${unavailable})`)
    }
    const events = parseEvents(eventLines)
    if (events.unreadable) report.info(`  (${events.unreadable} line(s) of \`docker events\` were not read as events)`)
    const timing = stopTiming({ events: events.events, finishedAt: state.finishedAt, cliMs: stopped.ms, unavailable })
    const verdict = judgeStop({
      signal,
      timeoutS,
      exitCode: state.exitCode,
      running: state.running,
      oomKilled: state.oomKilled,
      elapsedMs: timing.ms,
      elapsedFrom: timing.source === 'cli' ? 'cli' : 'docker',
      log,
    })
    record.stop = { ...verdict, startedAt: state.startedAt, finishedAt: state.finishedAt, timing }
    report.info(
      `  ${describeTiming(timing)}; exit code ${state.exitCode}; ` +
        Object.entries(verdict.found)
          .map(([line, there]) => `\`${line}\`: ${there ? 'in the log' : 'MISSING'}`)
          .join('; ')
    )
    if (verdict.ok) {
      report.info(`  ${signal}: the server's log says it saved, and the container exited 0 by itself`)
      return
    }
    for (const reason of verdict.reasons) fail(`${role} (${signal}, ${timeoutS} s): ${reason}`)
    // (what was read from /proc/1/status in the first container looked at: every container of the image that is
    // started as the image starts does so the same way)
    const caught = summary.containers.find(container => container.pid1)?.pid1?.status?.caught
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
    const allCertain = map => ([...map.values()].every(state => state === 'yes') ? 'yes' : 'maybe')
    const containers = [...created.containers.keys()]
    if (containers.length) await remove('the containers', ['rm', '-f', ...containers], allCertain(created.containers))
    // (one command for every volume: the cleanup's three removals are what SIGNAL_BUDGET counts)
    const volumes = [...created.volumes.keys()]
    const what = volumes.length > 1 ? 'the volumes' : 'the volume'
    if (volumes.length) await remove(what, ['volume', 'rm', ...volumes], allCertain(created.volumes))
    if (created.image) await remove('the image tag', ['image', 'rm', names.image], created.image)
  }

  // A volume of this run (the cleanup removes it)
  async function createVolume(volume) {
    created.volumes.set(volume, 'maybe')
    await must(['volume', 'create', volume])
    created.volumes.set(volume, 'yes')
  }

  // ------------------------------------------------------------------------------------------------------------
  // --model=nonroot
  // ------------------------------------------------------------------------------------------------------------

  // The entrypoint's line in the log of a container started as root: exactly one, about the world folder, and how
  // many entries it gave to 1001:1001. `atLeast` / `exactly` (with `why`) is what this start must say.
  async function entrypointCount(record, { atLeast = null, exactly = null, why = '' } = {}) {
    const counts = entrypointCounts(await collectLog(record))
    record.entrypoint = counts
    if (counts.length !== 1) {
      fail(
        `${record.role}: ${counts.length || 'no'} \`${ENTRYPOINT_LINES.given}…\` line(s) in the log, expected one (the entrypoint prints it on every start as root)`
      )
      return
    }
    const [{ dir, count }] = counts
    report.info(`  the entrypoint gave ${count} entr${count === 1 ? 'y' : 'ies'} under ${dir} to 1001:1001`)
    if (dir !== WORLD_PATH) fail(`${record.role}: the entrypoint looked at ${dir}, not at ${WORLD_PATH}`)
    if (atLeast !== null && !(count >= atLeast)) {
      fail(`${record.role}: the entrypoint gave ${count} entries to 1001:1001, expected at least ${atLeast} (${why})`)
    }
    if (exactly !== null && count !== exactly) {
      fail(`${record.role}: the entrypoint gave ${count} entries to 1001:1001, expected ${exactly} (${why})`)
    }
  }

  // Nothing under the world folder, on its file system, that is not 1001's, as root sees it from inside
  async function ownership(record) {
    record.ownership = {}
    for (const [key, test] of [
      ['user', '-user'],
      ['group', '-group'],
    ]) {
      const args = ['exec', record.name, 'find', WORLD_PATH, '-xdev', '!', test, String(SERVICE_ID)]
      const result = await run(args)
      const listed = result.stdout.trim()
      record.ownership[key] = { code: result.code, listed }
      if (result.code !== 0) {
        fail(`${record.role}: \`docker ${formatCommand(args)}\` exited ${result.code}: ${said(result)}`)
      } else if (listed) {
        fail(
          `${record.role}: under ${WORLD_PATH}, not ${SERVICE_ID}'s (${key}): ${tailOf(listed, 5, 600).replaceAll('\n', ', ')}`
        )
      }
    }
    if (Object.values(record.ownership).every(found => found.code === 0 && !found.listed)) {
      report.info(`  everything under ${WORLD_PATH} is ${SERVICE_ID}:${SERVICE_ID}'s`)
    }
  }

  // A container that only runs one command in the foreground: its exit code and output. It keeps its name, and the
  // cleanup removes it with the others.
  async function throwaway(role, runOptions) {
    const name = names.containers[role]
    created.containers.set(name, 'maybe')
    const result = await run(buildRunArgs({ name, image: names.image, detach: false, ...runOptions }))
    // (125: docker itself failed, and the container may not exist)
    created.containers.set(name, result.code === 125 ? 'maybe' : 'yes')
    summary.throwaway.push({ role, name, code: result.code, stdout: tailOf(result.stdout, 20, 2000) })
    return result
  }

  // A container that has to end by itself during its start-up, with `exitCode` and a log that has, for each entry of
  // `lines`, a line holding all of its parts. Becoming healthy, or still running at the end of the wait, fails it.
  async function startAndExpectExit(role, { how, exitCode, lines, ...runOptions }) {
    const name = names.containers[role]
    const record = { role, name, healthy: null, exit: null }
    summary.containers.push(record)
    report.info(`${role}: a container of ${names.image} ${how}`)
    created.containers.set(name, 'maybe')
    await must(buildRunArgs({ name, image: names.image, env, ...runOptions }))
    created.containers.set(name, 'yes')
    const started = now()
    let state = null
    for (let poll = 0; poll < HEALTH_POLLS; poll++) {
      state = parseState((await must(stateArgs(name), { quiet: poll > 0 })).stdout)
      if (!state.running || state.health === 'healthy') break
      await sleep(HEALTH_INTERVAL_MS)
    }
    const log = await collectLog(record, { final: !state.running })
    if (state.running) {
      const seen = state.health === 'healthy' ? 'became healthy' : `is still running after ${seconds(started)} s`
      fail(`${role}: ${name} ${seen}; expected it to end by itself with exit code ${exitCode}`)
      showTail(record, log)
      return record
    }
    record.exit = { exitCode: state.exitCode, seconds: Number(seconds(started)) }
    report.info(`  it ended by itself after ${seconds(started)} s with exit code ${state.exitCode}`)
    const problems = []
    if (state.exitCode !== exitCode) problems.push(`exit code ${state.exitCode}, expected ${exitCode}`)
    const logLines = log.split('\n')
    for (const parts of lines) {
      const line = logLines.find(candidate => parts.every(part => candidate.includes(part)))
      if (line) report.info(`  ${line.trim().slice(0, 300)}`)
      else problems.push(`the log has no line with ${parts.map(part => `\`${part}\``).join(' and ')}`)
    }
    for (const problem of problems) fail(`${role}: ${problem}`)
    if (problems.length) showTail(record, log)
    return record
  }

  async function runNonroot() {
    // 1. the volume as production has it today: written by the same image run the old way, npm as root
    await createVolume(names.volume)
    const legacy = await startAndWait('legacy', {
      how: `on the volume ${names.volume}, started the old way: \`--user 0 --entrypoint npm … run start\``,
      user: '0',
      entrypoint: 'npm',
      command: ['run', 'start'],
    })
    await must(stopArgs(STOPS.sigterm, legacy.name), { timeoutMs: (STOPS.sigterm.timeoutS + 30) * 1000 })
    const legacyState = parseState((await must(stateArgs(legacy.name))).stdout)
    await collectLog(legacy, { final: !legacyState.running })
    if (legacyState.running) throw new StepFailed(`${legacy.name} is still running after \`docker stop\``)
    legacy.stopped = { exitCode: legacyState.exitCode }
    report.info(`legacy: stopped (exit code ${legacyState.exitCode}); what it wrote on the volume is root's`)

    // 2. the image as it starts, on that volume: it takes the volume over, the server is PID 1 as 1001:1001, and a
    // stop with Docker's defaults saves
    const first = await startAndWait('sigterm')
    await observe(first)
    await entrypointCount(first, { atLeast: 1, why: 'the volume was written by root' })
    await ownership(first)
    await stop(first, STOPS.sigterm)

    // 3. one file root's again (a root shell, a restore), through a container of its own; then the next start gives
    // it back, and a stop the way Fly stops by default saves
    const chown = await throwaway('chown', {
      user: '0',
      entrypoint: 'chown',
      volume: names.volume,
      command: ['0:0', `${WORLD_PATH}/db.sqlite`],
    })
    if (chown.code !== 0) {
      throw new StepFailed(`the chown of ${WORLD_PATH}/db.sqlite to root exited ${chown.code}: ${said(chown)}`)
    }
    const second = await startAndWait('sigint')
    await entrypointCount(second, { atLeast: 1, why: 'db.sqlite was made root’s before this start' })
    await ownership(second)
    await stop(second, STOPS.sigint)

    // 4. a start on a volume that is all 1001's already changes nothing (left running: the cleanup removes it)
    const third = await startAndWait('restart')
    await entrypointCount(third, { exactly: 0, why: 'nothing was written as root since the last start' })
    await ownership(third)

    // 5. another PORT: the image's own health check follows it. No volume: the entrypoint makes the world folder
    const port = await startAndWait('port', {
      how: `with PORT=${OTHER_PORT} (and the three addresses on it), no volume`,
      volume: null,
      env: envOnPort(env, OTHER_PORT),
    })
    report.info(`port: healthy on ${OTHER_PORT} by the image's own health check after ${port.healthy.seconds} s`)
    await entrypointCount(port)

    // 6. started as another user, on a fresh volume (root's): nothing can be given away, and the server's start-up
    // says that it cannot write, and ends with 1
    await createVolume(names.freshVolume)
    await startAndExpectExit('otheruser', {
      how: `started with --user ${OTHER_USER} on the fresh volume ${names.freshVolume}`,
      user: OTHER_USER,
      volume: names.freshVolume,
      exitCode: 1,
      lines: [[`${ENTRYPOINT_LINES.notRoot}2000, not as root`], [STARTUP_FAILED, 'EACCES']],
    })

    // 7. a WORLD the entrypoint refuses: exit 1 before anything changes owner
    const refused = await startAndExpectExit('refused', {
      how: `with WORLD=${REFUSED_WORLD}, no volume`,
      env: { ...env, WORLD: REFUSED_WORLD },
      exitCode: 1,
      lines: [[`${ENTRYPOINT_LINES.refused}/app/${REFUSED_WORLD}. `]],
    })
    // what that container changed in its own file system (a chown shows as `C`): nothing under /app/build
    const diffArgs = ['diff', refused.name]
    const diff = await run(diffArgs)
    refused.diff = tailOf(diff.stdout, 40, 4000)
    if (diff.code !== 0) {
      fail(`refused: \`docker ${formatCommand(diffArgs)}\` exited ${diff.code}: ${said(diff)}`)
    } else {
      const changed = changedUnder(diff.stdout, `/app/${REFUSED_WORLD}`)
      if (changed.length)
        fail(`refused: the container changed /app/${REFUSED_WORLD}: ${changed.slice(0, 5).join(', ')}`)
      else report.info(`  \`docker diff\`: nothing at or under /app/${REFUSED_WORLD} changed`)
    }
    // and in the image itself, as a fresh container of it sees it, everything under /app/build is root's
    const files = await throwaway('imagefiles', {
      user: '0',
      entrypoint: 'find',
      command: [`/app/${REFUSED_WORLD}`, '!', '-user', '0'],
    })
    if (files.code !== 0) fail(`imagefiles: the find exited ${files.code}: ${said(files)}`)
    else if (files.stdout.trim()) {
      fail(`imagefiles: not root's under /app/${REFUSED_WORLD}: ${tailOf(files.stdout, 5, 600).replaceAll('\n', ', ')}`)
    } else report.info(`imagefiles: everything under /app/${REFUSED_WORLD} in the image is root's`)
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

    if (model.name === 'nonroot') {
      await runNonroot()
    } else {
      // b. one volume for the world, kept from container to container
      await createVolume(names.volume)

      // b–e. the first container: healthy, the process tree, a stop with Docker's defaults
      const first = await startAndWait('sigterm')
      await observe(first)
      await stop(first, STOPS.sigterm)

      // f. a fresh container on the same volume, stopped the way Fly stops by default
      const second = await startAndWait('sigint')
      await stop(second, STOPS.sigint)

      // g. a third start on the same volume becomes healthy (nothing was changed in the world: that is all it shows)
      const third = await startAndWait('restart')
      report.info(`restart: healthy after ${third.healthy.seconds} s on the volume of the two stopped runs`)
    }
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
