// `node scripts/image-check.mjs` (the image.yml workflow): the parts that need no Docker, on canned output. What
// BusyBox `ps` and /proc/1/status print is read into a tree and classified, a stop is judged from its exit code, its
// duration and the container's log, and the order of the docker commands of a run is asserted against a stand-in
// for the docker CLI (the library's simulatedDocker, and for the script's own process a fake `docker` on PATH).
// No test here runs Docker, so none of them says anything about the image.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  EVENTS_TIMEOUT_MS,
  MODELS,
  NOT_STOPPED_OR_SAVED,
  SIGNAL_BUDGET,
  STOPS,
  UsageError,
  buildRunArgs,
  classifyProcess,
  classifyTree,
  commandKind,
  containerEnv,
  describeTiming,
  describeTree,
  eventsArgs,
  formatCommand,
  judgeStop,
  maskSecrets,
  mergeLogs,
  modelFor,
  parseArgs,
  parseDockerTime,
  parseEvents,
  parseProcStatus,
  parsePs,
  parseState,
  runImageCheck,
  runNames,
  simulatedDocker,
  simulatedStopEvents,
  stopArgs,
  stopExpectation,
  stopTiming,
  unixTimestamp,
} from '../scripts/lib/imageCheck.mjs'
import { serverStartEnv } from '../scripts/lib/startEnv.mjs'
import { installShutdown } from '../src/server/shutdown.js'
import { definitionsIn, findFunction, networkFiles } from './lib/networkSource.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = path.join(root, 'scripts/image-check.mjs')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

// --- the process tree -----------------------------------------------------------------------------------------

// BusyBox `ps -o pid,ppid,user,args`: the columns are padded, the health check and the `ps` itself are in the list
// with a parent outside the container (PPID 0)
const PS_NPM_SHELL_NODE = `PID   PPID  USER     COMMAND
    1     0 root     npm run start
   18     1 root     sh -c node build/index.js
   19    18 root     node build/index.js
   61     0 root     /bin/sh -c curl -f http://localhost:3000/health || exit 1
   67    61 root     curl -f http://localhost:3000/health
   68     0 root     ps -o pid,ppid,user,args
`
const PS_NPM_NODE = `PID   PPID  USER     COMMAND
    1     0 root     npm run start
   18     1 root     node build/index.js
   40     0 root     ps -o pid,ppid,user,args
`
const PS_NODE_PID1 = `PID   PPID  USER     COMMAND
    1     0 nodeuser node build/index.js
   33     0 nodeuser ps -o pid,ppid,user,args
`

test('ps: npm as PID 1, a shell, then the server', () => {
  const rows = parsePs(PS_NPM_SHELL_NODE)
  assert.equal(rows.length, 6, 'the header is not a row')
  assert.deepEqual(rows[1], { pid: 18, ppid: 1, user: 'root', args: 'sh -c node build/index.js' })
  const tree = classifyTree(rows)
  assert.equal(tree.pid1.kind, 'npm')
  assert.equal(tree.server.pid, 19)
  assert.deepEqual(
    tree.chain.map(proc => [proc.pid, proc.kind]),
    [
      [1, 'npm'],
      [18, 'shell'],
      [19, 'server'],
    ]
  )
  assert.equal(tree.serverIsPid1, false)
  assert.equal(tree.serverDepth, 2)
  assert.equal(tree.shellBetween, true)
  assert.equal(tree.underPid1, true)
  assert.equal(tree.servers, 1, '`sh -c node build/index.js` is a shell, not a second server')
  assert.deepEqual(tree.users, ['root'])
  // the health check's shell is not between PID 1 and the server
  assert.deepEqual(
    tree.outside.map(proc => proc.pid),
    [61, 67, 68]
  )
  assert.deepEqual(MODELS.current.treeProblems({ tree }), [])
  const said = describeTree(tree).join('\n')
  assert.match(said, /PID 1 is npm \(`npm run start`, user root\)/)
  assert.match(said, /the server is pid 19 \(user root\), a grandchild of PID 1, below shell pid 18/)
  assert.match(said, /a shell sits between PID 1 and the server/)
})

test('ps: the shell replaced itself with the server (npm, then node)', () => {
  const tree = classifyTree(parsePs(PS_NPM_NODE))
  assert.equal(tree.pid1.kind, 'npm')
  assert.equal(tree.server.pid, 18)
  assert.equal(tree.serverDepth, 1)
  assert.equal(tree.shellBetween, false)
  assert.equal(tree.serverIsPid1, false)
  assert.deepEqual(MODELS.current.treeProblems({ tree }), [])
  assert.match(describeTree(tree).join('\n'), /a child of PID 1, with nothing in between\nno shell sits between/)
})

test('ps: the server is PID 1', () => {
  const tree = classifyTree(parsePs(PS_NODE_PID1))
  assert.equal(tree.pid1.kind, 'server')
  assert.equal(tree.server.pid, 1)
  assert.equal(tree.serverIsPid1, true)
  assert.equal(tree.serverDepth, 0)
  assert.equal(tree.shellBetween, false)
  assert.deepEqual(tree.users, ['nodeuser'])
  assert.deepEqual(MODELS.current.treeProblems({ tree }), [])
  assert.match(describeTree(tree).join('\n'), /the server is PID 1 itself/)
})

test('ps: no server in the listing is the one thing the current model refuses', () => {
  const tree = classifyTree(parsePs('PID   PPID  USER     COMMAND\n    1     0 root     npm run start\n'))
  assert.equal(tree.server, null)
  assert.equal(tree.shellBetween, null)
  assert.deepEqual(tree.users, ['root'])
  assert.deepEqual(MODELS.current.treeProblems({ tree }), [
    'no `node build/index.js` process is running in the container',
  ])
  // nothing at all (the `ps` could not be run)
  const empty = classifyTree(parsePs(null))
  assert.equal(empty.pid1, null)
  assert.equal(MODELS.current.treeProblems({ tree: empty }).length, 1)
  assert.match(describeTree(empty).join('\n'), /no PID 1 in the listing/)
})

test('ps: what a command line is', () => {
  for (const [args, kind] of [
    ['npm run start', 'npm'],
    ['node /usr/local/bin/npm run start', 'npm'],
    ['node /usr/local/lib/node_modules/npm/bin/npm-cli.js run start', 'npm'],
    ['node build/index.js', 'server'],
    ['/usr/local/bin/node build/index.js', 'server'],
    ['node --enable-source-maps /app/build/index.js', 'server'],
    // BusyBox puts the process name in braces when it differs from the first word of the command line
    ['{MainThread} node build/index.js', 'server'],
    ['{node} npm run start', 'npm'],
    ['sh -c node build/index.js', 'shell'],
    ['/bin/sh -c curl -f http://localhost:3000/health || exit 1', 'shell'],
    ['node scripts/backup-world.mjs', 'other'],
    ['curl -f http://localhost:3000/health', 'other'],
    ['[kworker/0:1]', 'other'],
    ['', 'other'],
  ]) {
    assert.equal(classifyProcess(args), kind, args)
  }
})

test('ps: a server that does not descend from PID 1 is said to be so', () => {
  const tree = classifyTree(
    parsePs(
      '    1     0 root     sleep 1000\n   30     0 root     sh -c node build/index.js\n   31    30 root     node build/index.js\n'
    )
  )
  assert.equal(tree.pid1.kind, 'other')
  assert.equal(tree.server.pid, 31)
  assert.equal(tree.underPid1, false)
  assert.match(describeTree(tree).join('\n'), /not a descendant of PID 1/)
})

// --- /proc/<pid>/status ---------------------------------------------------------------------------------------

test('/proc/1/status: the name, the uids and the signals PID 1 handles', () => {
  const root1 = parseProcStatus(
    [
      'Name:\tnpm run start',
      'Umask:\t0022',
      'State:\tS (sleeping)',
      'Tgid:\t1',
      'Pid:\t1',
      'PPid:\t0',
      'Uid:\t0\t0\t0\t0',
      'Gid:\t0\t0\t0\t0',
      'Threads:\t11',
      'SigBlk:\t0000000000000000',
      'SigIgn:\t0000000001001000',
      // bits 1, 2, 10, 12, 15: SIGHUP, SIGINT, SIGUSR1, SIGUSR2, SIGTERM
      'SigCgt:\t0000000000004a03',
    ].join('\n')
  )
  assert.equal(root1.name, 'npm run start')
  assert.equal(root1.pid, 1)
  assert.equal(root1.ppid, 0)
  assert.deepEqual(root1.uid, { real: 0, effective: 0, saved: 0, fs: 0 })
  assert.deepEqual(root1.gid, { real: 0, effective: 0, saved: 0, fs: 0 })
  assert.deepEqual(root1.caught, { SIGINT: true, SIGTERM: true })
  assert.deepEqual(root1.ignored, { SIGINT: false, SIGTERM: false })

  const user = parseProcStatus(
    'Name:\tnode\nPid:\t1\nPPid:\t0\nUid:\t1001\t1001\t1001\t1001\nGid:\t1001\t1001\t1001\t1001\nSigCgt:\t0000000000000000\n'
  )
  assert.equal(user.uid.effective, 1001)
  assert.deepEqual(user.caught, { SIGINT: false, SIGTERM: false }, 'no handler: PID 1 would not get the signal')
  // SIGINT alone is bit 2
  assert.deepEqual(parseProcStatus('SigCgt:\t0000000000000002').caught, { SIGINT: true, SIGTERM: false })

  const nothing = parseProcStatus('')
  assert.deepEqual(nothing, { name: null, pid: null, ppid: null, uid: null, gid: null, caught: null, ignored: null })
  assert.equal(parseProcStatus('Uid:\t0\t0').uid, null, 'four ids or none')
})

// --- docker inspect, docker logs ------------------------------------------------------------------------------

test('docker inspect: the State of a running, a stopped and a health-less container', () => {
  const running = parseState(
    JSON.stringify({
      Status: 'running',
      Running: true,
      ExitCode: 0,
      OOMKilled: false,
      Error: '',
      StartedAt: '2026-11-13T10:00:00.1Z',
      FinishedAt: '0001-01-01T00:00:00Z',
      Health: {
        Status: 'starting',
        FailingStreak: 1,
        Log: [{ ExitCode: 7, Output: 'curl: (7) Failed to connect to localhost port 3000\n' }],
      },
    })
  )
  assert.equal(running.running, true)
  assert.equal(running.health, 'starting')
  assert.deepEqual(running.lastProbe, { exitCode: 7, output: 'curl: (7) Failed to connect to localhost port 3000' })

  const killed = parseState(
    JSON.stringify({ Status: 'exited', Running: false, ExitCode: 137, OOMKilled: true, Error: '' })
  )
  assert.equal(killed.running, false)
  assert.equal(killed.exitCode, 137)
  assert.equal(killed.oomKilled, true)
  assert.equal(killed.health, null, 'an image without HEALTHCHECK has no Health member')
  assert.equal(killed.lastProbe, null)

  assert.throws(() => parseState('Error: No such container'), /did not print a State object/)
  assert.throws(() => parseState('[]'), /did not print a State object/)
})

test('docker logs --timestamps: the two streams are put back in the order of their stamps', () => {
  const stdout = [
    '2026-11-13T10:00:01.000000001Z server listening on port 3000',
    '2026-11-13T10:00:05.000000003Z [server] SIGTERM: saving the world before exit (deadline 3500 ms)',
    '2026-11-13T10:00:05.200000000Z [network] final save complete',
  ].join('\n')
  const stderr = [
    '2026-11-13T10:00:00.500000000Z [envs] ADMIN_CODE is not set',
    '2026-11-13T10:00:05.100000000Z something on stderr',
    '   its second line, without a stamp',
  ].join('\n')
  assert.deepEqual(
    mergeLogs(stdout, stderr)
      .split('\n')
      .map(line => line.replace(/^\S+Z /, '')),
    [
      '[envs] ADMIN_CODE is not set',
      'server listening on port 3000',
      '[server] SIGTERM: saving the world before exit (deadline 3500 ms)',
      'something on stderr',
      '   its second line, without a stamp',
      '[network] final save complete',
    ]
  )
  assert.equal(mergeLogs('', ''), '')
  assert.equal(mergeLogs('no stamp at all\nsecond', undefined), 'no stamp at all\nsecond')
})

// --- the stop -------------------------------------------------------------------------------------------------

const savedLog = signal =>
  [
    'server listening on port 3000',
    `[server] ${signal}: saving the world before exit (deadline 3500 ms)`,
    '[network] final save complete',
  ].join('\n')
const stopOf = (stop, rest) => judgeStop({ ...stop, exitCode: 0, elapsedMs: 600, ...rest })

test('stop: exit 0, well under the timeout, with both lines is a good stop', () => {
  const verdict = stopOf(STOPS.sigterm, { log: savedLog('SIGTERM') })
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.reasons, [])
  assert.deepEqual(verdict.found, {
    '[server] SIGTERM: saving the world before exit': true,
    '[network] final save complete': true,
  })
  // timestamps before the lines (docker logs --timestamps) change nothing
  const stamped = savedLog('SIGTERM').replace(/^/gm, '2026-11-13T10:00:05.000000003Z ')
  assert.equal(stopOf(STOPS.sigterm, { log: stamped }).ok, true)
})

test('stop: exit 137 is a kill, whatever else is there', () => {
  const verdict = stopOf(STOPS.sigterm, { exitCode: 137, elapsedMs: 10_400, log: 'server listening on port 3000' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reasons.length, 4)
  assert.match(verdict.reasons[0], /^exit code 137, expected 0 \(128 \+ 9: killed\. Nothing in the container ended/)
  assert.match(
    verdict.reasons[1],
    /^the stop took 10\.4 s by Docker's clock, from its kill to the container's exit: not under 8 s \(the timeout is 10 s/
  )
  assert.match(verdict.reasons[2], /no `\[server\] SIGTERM: saving the world before exit` line/)
  assert.match(verdict.reasons[3], /no `\[network\] final save complete` line/)
  // 143 and 130: the signal ended the process itself
  assert.match(stopOf(STOPS.sigterm, { exitCode: 143, log: '' }).reasons[0], /^exit code 143, expected 0 \(128 \+ 15/)
  assert.match(stopOf(STOPS.sigint, { exitCode: 130, log: '' }).reasons[0], /^exit code 130, expected 0 \(128 \+ 2/)
  // the lines alone do not make up for the code
  assert.deepEqual(stopOf(STOPS.sigterm, { exitCode: 137, log: savedLog('SIGTERM') }).reasons.length, 1)
})

test('stop: exit 0 without the final-save line is not a good stop', () => {
  const log = 'server listening on port 3000\n[server] SIGTERM: saving the world before exit (deadline 3500 ms)'
  const verdict = stopOf(STOPS.sigterm, { log })
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.reasons, ['the log has no `[network] final save complete` line'])
  assert.equal(verdict.found['[server] SIGTERM: saving the world before exit'], true)
  // and without the server's own line (PID 1 exited 0 and the server never heard of the signal)
  assert.deepEqual(stopOf(STOPS.sigterm, { log: 'server listening on port 3000' }).reasons.length, 2)
})

// The real signal handler (src/server/shutdown.js) with stand-ins for what it stops: what it prints and the exit
// codes it asks for, once it has asked for one (and the rejections it logs are in).
async function shutdownRun({ network, stopWorld, closeServer, deadlineMs = 60_000, twice = false } = {}) {
  const printed = []
  const handlers = {}
  const exits = []
  let exited
  const firstExit = new Promise(resolve => (exited = resolve))
  installShutdown({
    proc: {
      on: (signal, handler) => (handlers[signal] = handler),
      exit: code => {
        exits.push(code)
        exited()
      },
    },
    network,
    stopWorld,
    closeServer,
    deadlineMs,
    log: { log: line => printed.push(line), error: line => printed.push(line) },
  })
  // (the handler's own deadline timer is unref'd: this one keeps the test's process up until the exit)
  const alive = setTimeout(() => {}, 10_000)
  handlers.SIGTERM('SIGTERM')
  if (twice) handlers.SIGINT('SIGINT')
  await firstExit
  await new Promise(resolve => setImmediate(resolve))
  clearTimeout(alive)
  return { printed, exits, log: printed.join('\n') }
}
const savesAndSays = printed => ({
  flushBeforeExit: async () => printed.push('[network] final save complete'),
})
const never = { flushBeforeExit: () => new Promise(() => {}) }
const judged = (run, exitCode = run.exits[0]) => judgeStop({ ...STOPS.sigterm, exitCode, elapsedMs: 100, log: run.log })
// a stand-in for the network that prints what ServerNetwork.flushBeforeExit prints when the save completes
async function savingRun(options) {
  const lines = []
  const run = await shutdownRun({ network: savesAndSays(lines), ...options })
  // (the network's line goes into the same log, after the handler's first)
  return { ...run, log: [run.printed[0], ...lines, ...run.printed.slice(1)].join('\n') }
}

test('stop: `[server] stopping the world failed` (shutdown.js:49) fails a stop that saved and exited 0', async () => {
  const run = await savingRun({
    stopWorld: () => {
      throw new Error('boom')
    },
  })
  assert.deepEqual(run.exits, [0], 'the handler goes on to save and exits 0')
  assert.deepEqual(judged(run).reasons, ['the log says: [server] stopping the world failed: boom'])
})

test('stop: `[server] close failed`, thrown (shutdown.js:61) or rejected (shutdown.js:59), fails it', async () => {
  for (const closeServer of [
    () => {
      throw new Error('not listening')
    },
    async () => {
      throw new Error('not listening')
    },
  ]) {
    const run = await savingRun({ closeServer })
    assert.deepEqual(run.exits, [0])
    assert.deepEqual(judged(run).reasons, ['the log says: [server] close failed: not listening'])
  }
})

test('stop: `[server] final save failed` (shutdown.js:68) fails it', async () => {
  const run = await shutdownRun({ network: { flushBeforeExit: async () => Promise.reject(new Error('disk full')) } })
  assert.deepEqual(run.exits, [1])
  assert.ok(judged(run).reasons.includes('the log says: [server] final save failed: disk full'), run.log)
  // with exit code 0 too: the line alone fails it
  assert.ok(judged(run, 0).reasons.includes('the log says: [server] final save failed: disk full'))
})

test('stop: `[server] the final save did not return in time` (shutdown.js:41) fails it', async () => {
  const run = await shutdownRun({ network: never, deadlineMs: 1 })
  assert.deepEqual(run.exits, [1])
  assert.ok(judged(run, 0).reasons.includes('the log says: [server] the final save did not return in time; exiting'))
})

test('stop: `again: exiting without waiting for the final save` (shutdown.js:31) fails it', async () => {
  const run = await shutdownRun({ network: never, twice: true })
  assert.deepEqual(run.exits, [1])
  assert.ok(
    judged(run, 0).reasons.includes('the log says: [server] SIGINT again: exiting without waiting for the final save')
  )
})

test('stop: `during start-up, before the world was loaded` (shutdown.js:36) fails it, though it exits 0', async () => {
  const run = await shutdownRun({ network: undefined })
  assert.deepEqual(run.exits, [0])
  assert.deepEqual(judged(run).reasons, [
    'the log has no `[server] SIGTERM: saving the world before exit` line',
    'the log has no `[network] final save complete` line',
    'the log says: [server] SIGTERM during start-up, before the world was loaded: nothing to save; exiting',
  ])
})

// What the final save's path in the network and in Storage.js prints, as it prints it (made up: ids, codes): each
// fails a stop that otherwise passed. Each is named by the function that prints it and a part of the call's text;
// where that call is now (the test's name) is found by parsing (test/lib/networkSource.mjs), wherever the function
// is written: for the network's, in the class or in a module of src/server/network/. (Its part of the source is held
// to the source below.)
const STORAGE = ['src/server/Storage.js']
for (const [name, files, part, line] of [
  [
    'flushBeforeExit',
    undefined,
    '[network] not persisted: ',
    '[network] not persisted: blueprints=["a1"] apps=[] config=[] users=0 storage=saved',
  ],
  [
    'saveDirty',
    undefined,
    '[network] error saving ',
    '[network] error saving entities 3f9a: SqliteError: database is locked',
  ],
  [
    'saveConfig',
    undefined,
    '[network] error saving ',
    '[network] error saving settings: SqliteError: database is locked',
  ],
  [
    'saveConfig',
    undefined,
    ' was not loaded; changes will not be saved',
    '[network] settings was not loaded; changes will not be saved',
  ],
  [
    'userRows',
    undefined,
    ' not stored (kept in memory; ',
    "[network] rank of user u1 not stored (kept in memory; written again with that user's next change or at the final save): Error: timeout",
  ],
  ['Storage.write', STORAGE, '[storage] failed to save ', '[storage] failed to save storage.json (ENOSPC); retrying'],
]) {
  const site = logSite(name, part, files)
  const where = site ?? `${name}, which no longer prints it`
  test(`stop: ${JSON.stringify(line.slice(0, 40))}… (${where}) fails a stop that otherwise passed`, () => {
    assert.ok(site, `${name} has no log call with ${JSON.stringify(part)} any more: update this list`)
    const verdict = stopOf(STOPS.sigterm, { log: `${savedLog('SIGTERM')}\n${line}` })
    assert.equal(verdict.ok, false)
    assert.deepEqual(verdict.reasons, [`the log says: ${line}`])
    assert.deepEqual(verdict.unwanted, [line])
    // and with a timestamp before it, as `docker logs --timestamps` gives it
    assert.equal(stopOf(STOPS.sigterm, { log: `2026-11-13T10:00:05.200000000Z ${line}` }).ok, false)
  })
}

test('stop: with SIGINT the server has to name SIGINT, within 4 of the 5 seconds', () => {
  assert.deepEqual(stopExpectation(STOPS.sigint), {
    signal: 'SIGINT',
    timeoutS: 5,
    maxElapsedMs: 4000,
    maxCliMs: 5000,
    required: ['[server] SIGINT: saving the world before exit', '[network] final save complete'],
    forbidden: stopExpectation(STOPS.sigterm).forbidden,
  })
  assert.equal(stopExpectation(STOPS.sigterm).maxElapsedMs, 8000)
  assert.equal(stopOf(STOPS.sigint, { log: savedLog('SIGINT') }).ok, true)
  // a log that names the other signal does not count
  assert.deepEqual(stopOf(STOPS.sigint, { log: savedLog('SIGTERM') }).reasons, [
    'the log has no `[server] SIGINT: saving the world before exit` line',
  ])
  assert.equal(stopOf(STOPS.sigint, { log: savedLog('SIGINT'), elapsedMs: 3999 }).ok, true)
  assert.match(
    stopOf(STOPS.sigint, { log: savedLog('SIGINT'), elapsedMs: 4000 }).reasons[0],
    /^the stop took 4\.0 s by Docker's clock, from its kill to the container's exit: not under 4 s/
  )
  // still running, or killed for memory
  assert.match(stopOf(STOPS.sigint, { log: savedLog('SIGINT'), running: true }).reasons[0], /still running/)
  assert.match(stopOf(STOPS.sigint, { log: savedLog('SIGINT'), oomKilled: true }).reasons[0], /OOMKilled/)
})

test('stop: the lines looked for are the ones the server prints', async () => {
  // the real handler (src/server/shutdown.js) with a save that returns: its line passes for either signal
  for (const stop of [STOPS.sigterm, STOPS.sigint]) {
    const printed = []
    const handlers = {}
    const exits = []
    const shutdown = installShutdown({
      proc: { on: (signal, handler) => (handlers[signal] = handler), exit: code => exits.push(code) },
      network: {
        flushBeforeExit: async () => {
          printed.push('[network] final save complete')
        },
      },
      log: { log: line => printed.push(line), error: line => printed.push(line) },
    })
    assert.ok(shutdown)
    await handlers[stop.signal](stop.signal)
    assert.deepEqual(exits, [0])
    assert.equal(
      judgeStop({ ...stop, exitCode: exits[0], elapsedMs: 100, log: printed.join('\n') }).ok,
      true,
      printed.join(' / ')
    )
  }
  // the texts themselves, where they are written (the network's: in the class or the modules of src/server/network/)
  const network = networkFiles().map(read).join('\n')
  assert.ok(network.includes("console.log('[network] final save complete')"))
  assert.ok(read('src/server/shutdown.js').includes('`[server] ${signal}: saving the world before exit'))
  // every forbidden part is in one of the files it is quoted from: none is left behind by a changed message
  const sources = [read('src/server/shutdown.js'), network, read('src/server/Storage.js')]
  assert.deepEqual(stopExpectation(STOPS.sigterm).forbidden, NOT_STOPPED_OR_SAVED)
  for (const part of NOT_STOPPED_OR_SAVED)
    assert.ok(
      sources.some(source => source.includes(part)),
      part
    )
})

// A SOURCE-TEXT TRIPWIRE. The functions a stop runs through print what they did; the verdict on a stop has to know
// every one of those lines: forbid it (NOT_STOPPED_OR_SAVED), require it (stopExpectation), or let it pass, here,
// with the reason. A log call added to one of these functions later fails this test until it is sorted, so that a
// new "not saved" message cannot slip past the image check unnoticed. Reading the source is right here because what
// is asked is about the source (is every message accounted for), not about behaviour; the behaviour of each line is
// tested above. It is kept to the named functions: the rest of the network logs plenty that has nothing to do with a
// stop. Each is found by parsing (test/lib/networkSource.mjs) wherever it is written; the network's in all of its
// files, the class and the modules of src/server/network/ that parts of it move to, every definition of the name (a
// member of the class that hands its call on to a module's function is one too). Its weak spot, said plainly: a
// message built elsewhere and logged through a variable is not seen.
const STOP_PATH_FUNCTIONS = [
  // the signal handler: stopWorld, closeServer, the final save, its deadline, a second signal
  ['installShutdown', ['src/server/shutdown.js']],
  // the final save, and what it calls that prints: save() -> saveDirty, saveSettings -> saveConfig, the users' rows
  ['flushBeforeExit'],
  ['saveDirty'],
  ['saveConfig'],
  ['userRows'],
]
const STOP_PATH_ALLOWED = [
  // saveDirty: the rows it did write. A row it could not write prints `[network] error saving` (forbidden) and stays
  // dirty, and the final save then says `[network] not persisted` (forbidden)
  { part: 'world saved (', reason: 'what was written, not what was not' },
]
const STOP_PATH_REQUIRED = [': saving the world before exit', '[network] final save complete']

// the logging calls in a function's text, each from `console.error(` (`log.log(`, `this.logOnce(`, …) to its
// closing parenthesis: [{ call, at }] (`at`: where it starts in the text)
function logCallSites(text) {
  const calls = []
  for (const match of text.matchAll(/\b(?:console|log)\.(?:log|warn|error)\(|\blogOnce\(/g)) {
    let depth = 0
    let at = match.index + match[0].length - 1
    for (; at < text.length && at - match.index < 800; at++) {
      if (text[at] === '(') depth++
      if (text[at] === ')' && --depth === 0) break
    }
    calls.push({ call: text.slice(match.index, at + 1), at: match.index })
  }
  return calls
}
const logCallsIn = text => logCallSites(text).map(site => site.call)

// where the function `name` logs a line with `part` in it: `<file name>:<line>, <name>`, or null
function logSite(name, part, files) {
  for (const { file, line, text } of findFunction(name, files)) {
    const site = logCallSites(text).find(({ call }) => call.includes(part))
    if (site) return `${path.basename(file)}:${line + text.slice(0, site.at).split('\n').length - 1}, ${name}`
  }
  return null
}

test('stop: every log line of the stop and save paths is forbidden, required or allowed with a reason', () => {
  const unsorted = []
  const counts = {}
  for (const [name, files] of STOP_PATH_FUNCTIONS) {
    counts[name] = 0
    for (const { file, text } of findFunction(name, files)) {
      const calls = logCallsIn(text)
      counts[name] += calls.length
      for (const call of calls) {
        const known =
          NOT_STOPPED_OR_SAVED.some(part => call.includes(part)) ||
          STOP_PATH_REQUIRED.some(part => call.includes(part)) ||
          STOP_PATH_ALLOWED.some(({ part }) => call.includes(part))
        if (!known) unsorted.push(`${file} ${name}: ${call.replace(/\s+/g, ' ').slice(0, 200)}`)
      }
    }
  }
  assert.deepEqual(
    unsorted,
    [],
    'a log line on the stop path that the image check does not know: add its part to NOT_STOPPED_OR_SAVED ' +
      '(scripts/lib/imageCheck.mjs) if it says that something was not stopped or not saved, else to STOP_PATH_ALLOWED'
  )
  // the reading itself found what is there today (8 calls in the handler, 7 on the final save's path)
  assert.deepEqual(counts, {
    installShutdown: 8,
    flushBeforeExit: 2,
    saveDirty: 2,
    saveConfig: 2,
    userRows: 1,
  })
  // and it would see a new one, in the class or in a module that a move put the function in
  for (const source of [
    'class ServerNetwork {\n  async saveDirty() {\n    console.warn(`[network] row ${id} skipped (${why})`)\n  }\n}\n',
    'export async function saveDirty() {\n  console.warn(`[network] row ${id} skipped (${why})`)\n}\n',
  ]) {
    const added = definitionsIn(source, 'saveDirty').flatMap(({ text }) => logCallsIn(text))
    assert.deepEqual(added, ['console.warn(`[network] row ${id} skipped (${why})`)'])
    assert.ok(!NOT_STOPPED_OR_SAVED.some(part => added[0].includes(part)))
  }
  for (const { reason } of STOP_PATH_ALLOWED) assert.ok(reason.length > 10)
})

// --- how long a stop took, by Docker's clock ------------------------------------------------------------------

// `docker events --filter container=… --filter type=container --format '{{json .}}'` over a SIGTERM stop that went
// well, written out as the Engine API describes an event (EventMessage: Type, Action, Actor.ID, Actor.Attributes,
// scope, time, timeNano) with the CLI's older status/id/from beside them. The health check's exec events and the
// stop event are in the window too.
const ID64 = '9c4b2f6e1d3a'.repeat(6).slice(0, 64)
const STOP_EVENTS_OK = [
  `{"status":"exec_create: /bin/sh -c curl -f http://localhost:3000/health || exit 1","id":"${ID64}","from":"image-check-0123456789ab:check","Type":"container","Action":"exec_create: /bin/sh -c curl -f http://localhost:3000/health || exit 1","Actor":{"ID":"${ID64}","Attributes":{"execID":"77aa","image":"image-check-0123456789ab:check","name":"image-check-0123456789ab-sigterm"}},"scope":"local","time":1794534188,"timeNano":1794534188910228811}`,
  `{"status":"exec_die","id":"${ID64}","from":"image-check-0123456789ab:check","Type":"container","Action":"exec_die","Actor":{"ID":"${ID64}","Attributes":{"execID":"77aa","exitCode":"0","image":"image-check-0123456789ab:check","name":"image-check-0123456789ab-sigterm"}},"scope":"local","time":1794534189,"timeNano":1794534189003118734}`,
  `{"status":"kill","id":"${ID64}","from":"image-check-0123456789ab:check","Type":"container","Action":"kill","Actor":{"ID":"${ID64}","Attributes":{"image":"image-check-0123456789ab:check","name":"image-check-0123456789ab-sigterm","signal":"15"}},"scope":"local","time":1794534189,"timeNano":1794534189473104512}`,
  `{"status":"die","id":"${ID64}","from":"image-check-0123456789ab:check","Type":"container","Action":"die","Actor":{"ID":"${ID64}","Attributes":{"execDuration":"9","exitCode":"0","image":"image-check-0123456789ab:check","name":"image-check-0123456789ab-sigterm"}},"scope":"local","time":1794534189,"timeNano":1794534189680512991}`,
  `{"status":"stop","id":"${ID64}","from":"image-check-0123456789ab:check","Type":"container","Action":"stop","Actor":{"ID":"${ID64}","Attributes":{"image":"image-check-0123456789ab:check","name":"image-check-0123456789ab-sigterm"}},"scope":"local","time":1794534189,"timeNano":1794534189682240115}`,
].join('\n')

test('docker events: the kill with its signal and the die with its exit code, on Docker’s clock', () => {
  const { events, unreadable } = parseEvents(STOP_EVENTS_OK)
  assert.equal(unreadable, 0)
  assert.deepEqual(
    events.map(event => event.action),
    ['exec_create: /bin/sh -c curl -f http://localhost:3000/health || exit 1', 'exec_die', 'kill', 'die', 'stop']
  )
  assert.equal(events[2].attributes.signal, '15')
  assert.equal(events[3].attributes.exitCode, '0')
  const timing = stopTiming({ events, finishedAt: '2026-11-13T10:23:09.680400000Z', cliMs: 3900 })
  assert.equal(timing.source, 'events')
  // 1794534189.680512991 - 1794534189.473104512 s, to within what a double holds of timeNano
  assert.ok(Math.abs(timing.ms - 207.408) < 0.01, String(timing.ms))
  assert.deepEqual(timing.signals, ['SIGTERM'])
  assert.equal(timing.dieExitCode, 0)
  assert.equal(timing.cliMs, 3900)
  assert.equal(
    describeTiming(timing),
    "by Docker's clock SIGTERM sent, and its die event (exitCode 0) 0.207 s later; the `docker stop` command took 3.9 s"
  )
  // the exec's own exit code is not the container's
  assert.equal(stopTiming({ events: events.filter(event => event.action !== 'die'), cliMs: 1 }).dieExitCode, null)
})

test('docker events: a container killed after the timeout shows both kills, and fails on Docker’s clock', () => {
  const lines = [
    `{"Type":"container","Action":"kill","Actor":{"ID":"${ID64}","Attributes":{"name":"c","signal":"2"}},"scope":"local","time":1794534189,"timeNano":1794534189000000000}`,
    `{"Type":"container","Action":"kill","Actor":{"ID":"${ID64}","Attributes":{"name":"c","signal":"9"}},"scope":"local","time":1794534194,"timeNano":1794534194001000000}`,
    `{"Type":"container","Action":"die","Actor":{"ID":"${ID64}","Attributes":{"name":"c","exitCode":"137"}},"scope":"local","time":1794534194,"timeNano":1794534194052000000}`,
  ].join('\n')
  const timing = stopTiming({ events: parseEvents(lines).events, cliMs: 5300 })
  assert.equal(timing.source, 'events')
  assert.equal(Math.round(timing.ms), 5052)
  assert.deepEqual(timing.signals, ['SIGINT', 'SIGKILL'])
  assert.equal(timing.dieExitCode, 137)
  const verdict = judgeStop({ ...STOPS.sigint, exitCode: 137, elapsedMs: timing.ms, log: savedLog('SIGINT') })
  assert.match(verdict.reasons[1], /^the stop took 5\.1 s by Docker's clock/)
  // what the simulated docker prints for such a stop reads the same
  const simulated = simulatedStopEvents({
    name: 'c',
    signal: 'SIGINT',
    killAtMs: 1_794_534_189_000,
    exitAfterMs: 5052,
    exitCode: 137,
    killedAfterMs: 5001,
  })
  assert.deepEqual(stopTiming({ events: parseEvents(simulated).events, cliMs: 5300 }), timing)
})

test('the stop is judged on Docker’s clock: a 0.2 s stop is good however late the CLI returns', () => {
  // the case this is for: Docker saw 0.2 s, the `docker stop` process ended 4.6 s after it was started
  const timing = stopTiming({ events: parseEvents(STOP_EVENTS_OK).events, cliMs: 4600 })
  const verdict = judgeStop({
    ...STOPS.sigint,
    exitCode: 0,
    elapsedMs: timing.ms,
    elapsedFrom: 'docker',
    log: savedLog('SIGINT'),
  })
  assert.equal(verdict.ok, true, verdict.reasons.join('; '))
  assert.equal(verdict.elapsedFrom, 'docker')
})

test('without Docker’s pair: FinishedAt as the end, else the CLI’s time against the whole timeout', () => {
  const { events } = parseEvents(STOP_EVENTS_OK)
  const kill = events.filter(event => event.action === 'kill')
  // no die event read: the container's FinishedAt is the end
  const finished = stopTiming({ events: kill, finishedAt: '2026-11-13T10:23:09.900104512Z', cliMs: 1200 })
  assert.equal(finished.source, 'events+FinishedAt')
  assert.ok(Math.abs(finished.ms - (parseDockerTime('2026-11-13T10:23:09.900104512Z') - kill[0].ms)) < 0.001)
  assert.match(describeTiming(finished), /its State\.FinishedAt \(no die event read\)/)
  // no kill event: the CLI's own time, said so
  for (const [given, why] of [
    [{ events: [], finishedAt: '2026-11-13T10:23:09.9Z' }, 'no `kill` event in the window'],
    [{ events: kill, finishedAt: '0001-01-01T00:00:00Z' }, 'no `die` event and no State.FinishedAt after the kill'],
    [{ events: [], unavailable: '`docker events` failed' }, '`docker events` failed'],
  ]) {
    const timing = stopTiming({ ...given, cliMs: 4600 })
    assert.equal(timing.source, 'cli', why)
    assert.equal(timing.ms, 4600)
    assert.equal(timing.why, why)
    assert.match(describeTiming(timing), /^Docker's own times not read \(.*\): the `docker stop` command took 4\.6 s/)
  }
  // the CLI's time is held to the timeout itself: 4.6 s of SIGINT's 5 passes, 5 s does not
  const cli = (elapsedMs, rest = {}) =>
    judgeStop({ ...STOPS.sigint, exitCode: 0, elapsedMs, elapsedFrom: 'cli', log: savedLog('SIGINT'), ...rest })
  assert.equal(cli(4600).ok, true)
  assert.deepEqual(cli(5000).reasons, [
    "the `docker stop` command took 5.0 s (Docker's own times were not read): not under 5 s, the timeout itself",
  ])
  // a kill after the timeout still fails it: by the code, and by the time the CLI took
  assert.equal(cli(5300, { exitCode: 137 }).reasons.length, 2)
  // lines that are not events are counted, not used
  const odd = parseEvents('Error response from daemon: oops\n{"Action":"kill"}\n[]\n\n')
  assert.deepEqual(odd, { events: [], unreadable: 3 })
})

test('times for docker events, and from docker inspect', () => {
  assert.equal(unixTimestamp(1_794_534_189_473), '1794534189.473000000')
  assert.equal(unixTimestamp(1_794_534_189_005.7), '1794534189.005000000')
  assert.deepEqual(eventsArgs('c', { sinceMs: 1_794_534_188_000, untilMs: 1_794_534_190_250 }), [
    'events',
    '--since',
    '1794534188.000000000',
    '--until',
    '1794534190.250000000',
    '--filter',
    'container=c',
    '--filter',
    'type=container',
    '--format',
    '{{json .}}',
  ])
  assert.equal(parseDockerTime('2026-11-13T10:23:09.680400000Z'), Date.parse('2026-11-13T10:23:09.680Z') + 0.4)
  assert.equal(parseDockerTime('2026-11-13T10:23:09Z'), Date.parse('2026-11-13T10:23:09Z'))
  assert.equal(parseDockerTime('2026-11-13T19:23:09.5+09:00'), Date.parse('2026-11-13T10:23:09.500Z'))
  assert.equal(parseDockerTime('0001-01-01T00:00:00Z'), null)
  assert.equal(parseDockerTime(null), null)
  assert.equal(parseDockerTime('yesterday'), null)
})

// --- the commands ---------------------------------------------------------------------------------------------

const ID = '0123456789ab'
const NAMES = runNames(ID)
const HASH = `image-check-${ID}`
const ENV = containerEnv('a-made-up-secret')

test('the names of a run all carry its id', () => {
  assert.deepEqual(NAMES, {
    prefix: 'image-check-0123456789ab',
    image: 'image-check-0123456789ab:check',
    volume: 'image-check-0123456789ab-world',
    containers: {
      sigterm: 'image-check-0123456789ab-sigterm',
      sigint: 'image-check-0123456789ab-sigint',
      restart: 'image-check-0123456789ab-restart',
    },
  })
})

test('docker run: the image as it starts by itself, a volume at the world path, nothing published', () => {
  const args = buildRunArgs({ name: NAMES.containers.sigterm, image: NAMES.image, volume: NAMES.volume, env: ENV })
  assert.deepEqual(args.slice(0, 6), [
    'run',
    '-d',
    '--name',
    NAMES.containers.sigterm,
    '-v',
    `${NAMES.volume}:/app/world`,
  ])
  assert.equal(args[args.length - 1], NAMES.image, 'the image is the last word: no command replaces the image\u2019s')
  for (const flag of [
    '-p',
    '-P',
    '--publish',
    '--publish-all',
    '--network',
    '--entrypoint',
    '--user',
    '-u',
    '--init',
    '--rm',
  ]) {
    assert.ok(!args.includes(flag), `no ${flag}`)
  }
  // every setting as `-e NAME=value`, and they are the ones the production smoke test starts the server with
  const settings = args.filter((arg, i) => args[i - 1] === '-e')
  assert.equal(settings.length, args.filter(arg => arg === '-e').length)
  assert.deepEqual(
    settings.map(setting => setting.slice(0, setting.indexOf('='))),
    [
      'WORLD',
      'PORT',
      'JWT_SECRET',
      'SAVE_INTERVAL',
      'PUBLIC_MAX_UPLOAD_SIZE',
      'PUBLIC_WS_URL',
      'PUBLIC_API_URL',
      'ASSETS',
      'ASSETS_BASE_URL',
    ]
  )
  assert.ok(settings.includes('WORLD=world'))
  assert.ok(settings.includes('PORT=3000'), 'the image\u2019s health check asks port 3000')
  assert.ok(settings.includes('ASSETS_BASE_URL=http://127.0.0.1:3000/assets'))
  assert.deepEqual(ENV, serverStartEnv({ world: 'world', port: 3000, jwtSecret: 'a-made-up-secret' }))
  assert.match(read('scripts/prod-smoke.mjs'), /\.\.\.serverStartEnv\(\{ world: 'world-smoke', port, jwtSecret: /)
})

test('the settings given to the container are the ones the server refuses to start without', () => {
  // every `[envs] NAME not set` / `must be set` of the start-up names a setting that is given
  const index = read('src/server/index.js')
  const demanded = [...index.matchAll(/if \(!process\.env\.([A-Z_]+)\) \{\n\s+throw new Error\(/g)].map(
    match => match[1]
  )
  assert.ok(demanded.length >= 7, `found ${demanded.join(', ')}`)
  for (const name of demanded) assert.ok(Object.hasOwn(ENV, name), `${name} is given`)
  assert.ok(Object.hasOwn(ENV, 'JWT_SECRET'))
})

test('docker stop: Docker\u2019s default, and Fly\u2019s documented signal and timeout', () => {
  assert.deepEqual(stopArgs(STOPS.sigterm, 'c'), ['stop', '-t', '10', 'c'])
  assert.deepEqual(stopArgs(STOPS.sigint, 'c'), ['stop', '--signal', 'SIGINT', '-t', '5', 'c'])
})

test('a command is printed as one would type it', () => {
  assert.equal(
    formatCommand(['container', 'inspect', '--format', '{{json .State}}', 'image-check-1-sigterm']),
    "container inspect --format '{{json .State}}' image-check-1-sigterm"
  )
  assert.equal(formatCommand(['exec', 'c', 'ps', '-o', 'pid,ppid,user,args']), 'exec c ps -o pid,ppid,user,args')
  assert.equal(formatCommand(['-e', "A=it's"]), `-e 'A=it'\\''s'`)
})

test('a printed command masks the value of a setting with a secret\u2019s name; docker gets the real one', () => {
  const args = [
    'run',
    '-e',
    'JWT_SECRET=made-up-for-this-run-0123abcd',
    '-e',
    'PORT=3000',
    '-e',
    'ADMIN_CODE=1234',
    '-e',
    'LIVEKIT_API_KEY=k',
    '--env',
    'GITHUB_TOKEN=t',
    '--env=DB_PASSWORD=p',
    '-e',
    'jwt_secret=lower',
    '-e',
    'PUBLIC_API_URL=http://127.0.0.1:3000/api',
    '-e',
    'SECRET_WITHOUT_VALUE',
    '--name',
    'TOKEN=not-a-setting',
    'image',
  ]
  const copy = [...args]
  assert.equal(
    formatCommand(args),
    "run -e 'JWT_SECRET=***' -e PORT=3000 -e 'ADMIN_CODE=***' -e 'LIVEKIT_API_KEY=***' --env 'GITHUB_TOKEN=***' " +
      "'--env=DB_PASSWORD=***' -e 'jwt_secret=***' -e PUBLIC_API_URL=http://127.0.0.1:3000/api -e SECRET_WITHOUT_VALUE " +
      '--name TOKEN=not-a-setting image'
  )
  assert.deepEqual(args, copy, 'the arguments themselves are not changed')
  assert.deepEqual(maskSecrets(['-e', 'JWT_SECRET=x']), ['-e', 'JWT_SECRET=***'])
  // the build argument is not a setting of the container, and its name is no secret's
  assert.equal(
    formatCommand(['build', '--build-arg', 'COMMIT_HASH=image-check-1']),
    'build --build-arg COMMIT_HASH=image-check-1'
  )
})

// a run against the stand-in docker; `respond` changes single answers
async function simulate(respond, options = {}) {
  const docker = simulatedDocker({ commitHash: HASH, respond })
  const commands = []
  const said = []
  const logs = {}
  const summary = await runImageCheck({
    docker,
    names: NAMES,
    repoDir: '/repo',
    commitHash: HASH,
    env: ENV,
    report: { command: args => commands.push(args), info: text => said.push(text) },
    saveLog: (role, text) => (logs[role] = text),
    sleep: async () => {},
    ...options,
  })
  return { summary, commands, said, logs, calls: docker.calls }
}
// a command with the run's names shortened: `run <sigterm>`, `stop -t 10 <sigterm>`
const brief = args =>
  args
    .filter((arg, i) => arg !== '-e' && args[i - 1] !== '-e')
    .join(' ')
    .replaceAll(`${NAMES.prefix}-`, '')
    .replaceAll(NAMES.prefix, 'RUN')
    .replace(/\b\d{10}\.\d{9}\b/g, 'TIME')

test('a run in which everything goes well: the docker commands, in order', async () => {
  const { summary, commands, calls, logs } = await simulate()
  assert.deepEqual(commands, calls, 'every command that is run is printed')
  assert.deepEqual(commands.map(brief), [
    'version --format {{.Client.Version}} {{.Server.Version}}',
    'build --build-arg COMMIT_HASH=RUN -t RUN:check /repo',
    'image inspect --format {{json .Config}} RUN:check',
    'volume create world',
    // the first container: healthy, looked at, stopped with Docker's defaults
    'run -d --name sigterm -v world:/app/world RUN:check',
    'container inspect --format {{json .State}} sigterm',
    'exec sigterm ps -o pid,ppid,user,args',
    'exec sigterm cat /proc/1/status',
    'exec sigterm readlink /proc/1/exe',
    'exec sigterm cat /proc/19/status',
    'exec sigterm curl -fsS --max-time 5 http://127.0.0.1:3000/status',
    'exec sigterm ls -ln /app/world',
    'stop -t 10 sigterm',
    'container inspect --format {{json .State}} sigterm',
    'logs --timestamps sigterm',
    // what Docker recorded of the stop: its kill and the container's die, on its own clock
    'events --since TIME --until TIME --filter container=sigterm --filter type=container --format {{json .}}',
    // a fresh one on the same volume, stopped as Fly stops
    'run -d --name sigint -v world:/app/world RUN:check',
    'container inspect --format {{json .State}} sigint',
    'stop --signal SIGINT -t 5 sigint',
    'container inspect --format {{json .State}} sigint',
    'logs --timestamps sigint',
    'events --since TIME --until TIME --filter container=sigint --filter type=container --format {{json .}}',
    // a third start on the volume
    'run -d --name restart -v world:/app/world RUN:check',
    'container inspect --format {{json .State}} restart',
    // the cleanup: the log of the container that is still running, then everything of this run
    'logs --timestamps restart',
    'rm -f sigterm sigint restart',
    'volume rm world',
    'image rm RUN:check',
  ])
  // the three containers start with the same arguments but for the name; nothing is published
  const runs = commands.filter(args => args[0] === 'run')
  assert.equal(runs.length, 3)
  for (const args of runs) {
    assert.deepEqual(
      args,
      buildRunArgs({ name: args[3], image: NAMES.image, volume: NAMES.volume, env: ENV }),
      'docker run is exactly what buildRunArgs makes'
    )
    assert.ok(!args.some(arg => /^(-p|-P|--publish.*)$/.test(arg)))
  }
  // every argument of the cleanup that names something is a name of this run
  for (const args of commands.slice(-3)) {
    for (const arg of args.filter(arg => !['rm', '-f', 'volume', 'image'].includes(arg))) {
      assert.ok(arg.startsWith(NAMES.prefix), arg)
    }
  }
  assert.equal(summary.ok, true)
  assert.deepEqual(summary.failures, [])
  assert.equal(summary.model, 'current')
  assert.deepEqual(summary.docker, { client: 'simulated', server: 'simulated' })
  assert.deepEqual(summary.image.config.cmd, ['npm', 'run', 'start'])
  assert.deepEqual(
    summary.containers.map(record => [
      record.role,
      record.healthy.wasUnhealthy,
      record.stop?.signal ?? null,
      record.stop?.ok ?? null,
    ]),
    [
      ['sigterm', false, 'SIGTERM', true],
      ['sigint', false, 'SIGINT', true],
      ['restart', false, null, null],
    ]
  )
  // the facts that are only recorded
  const first = summary.containers[0]
  assert.equal(first.tree.pid1.kind, 'npm')
  assert.equal(first.tree.shellBetween, true)
  assert.equal(first.pid1.exe, '/usr/local/bin/node')
  assert.equal(first.pid1.status.uid.effective, 0)
  assert.deepEqual(first.pid1.status.caught, { SIGINT: true, SIGTERM: true })
  assert.equal(first.status.commitHash, HASH)
  assert.deepEqual(
    summary.cleanup.map(step => step.code),
    [0, 0, 0]
  )
  assert.deepEqual(Object.keys(logs), ['sigterm', 'sigint', 'restart'])
  assert.match(logs.sigint, /\[server\] SIGINT: saving the world before exit/)
  // each stop judged on Docker's clock (0.2 s in the simulated events), the CLI's 0.4 s kept beside it
  assert.deepEqual(
    summary.containers.slice(0, 2).map(record => record.stop.timing),
    [
      { source: 'events', ms: 200, cliMs: 400, signals: ['SIGTERM'], dieExitCode: 0 },
      { source: 'events', ms: 200, cliMs: 400, signals: ['SIGINT'], dieExitCode: 0 },
    ]
  )
  assert.equal(summary.containers[0].stop.elapsedFrom, 'docker')
  // nothing of the made-up secret is in the summary
  assert.ok(!JSON.stringify(summary).includes('a-made-up-secret'))
})

test('a container that is killed on SIGTERM fails the run, which still does the rest and cleans up', async () => {
  const killed = name => name === NAMES.containers.sigterm
  const { summary, commands, said } = await simulate((args, state) => {
    if (args[0] === 'events' && args.includes(`container=${NAMES.containers.sigterm}`)) {
      // Docker's record: SIGTERM, SIGKILL after the 10 s, the die with 137
      const killAtMs = Number(args[args.indexOf('--since') + 1]) * 1000 + 1000
      const stop = { killAtMs, exitAfterMs: 10_200, exitCode: 137, killedAfterMs: 10_000 }
      return { stdout: simulatedStopEvents({ name: NAMES.containers.sigterm, signal: 'SIGTERM', ...stop }) }
    }
    const name = args[args.length - 1]
    if (!killed(name)) return undefined
    if (args[0] === 'stop') return { ms: 10_300 }
    if (args[0] === 'container' && state.stopped.has(name)) {
      return {
        stdout: JSON.stringify({ Status: 'exited', Running: false, ExitCode: 137, Health: { Status: 'healthy' } }),
      }
    }
    if (args[0] === 'logs') return { stdout: '2026-11-13T10:00:01.000000001Z server listening on port 3000' }
    return undefined
  })
  assert.equal(summary.ok, false)
  assert.deepEqual(
    summary.failures.map(failure => failure.slice(0, 60)),
    [
      'sigterm (SIGTERM, 10 s): exit code 137, expected 0 (128 + 9: ',
      "sigterm (SIGTERM, 10 s): the stop took 10.2 s by Docker's clock",
      'sigterm (SIGTERM, 10 s): the log has no `[server] SIGTERM: s',
      'sigterm (SIGTERM, 10 s): the log has no `[network] final sav',
    ].map(failure => failure.slice(0, 60))
  )
  assert.equal(summary.containers[0].stop.exitCode, 137)
  assert.deepEqual(summary.containers[0].stop.timing.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(summary.containers[0].stop.timing.dieExitCode, 137)
  assert.equal(summary.containers[0].stop.timing.cliMs, 10_300)
  // the end of the container's log is shown
  assert.ok(said.some(line => line.includes("the end of image-check-0123456789ab-sigterm's log:")))
  assert.ok(said.some(line => line.includes('server listening on port 3000')))
  // the SIGINT stop and the restart were still done, and passed
  assert.equal(summary.containers[1].stop.ok, true)
  assert.equal(summary.containers[2].healthy.wasUnhealthy, false)
  assert.deepEqual(commands.slice(-3).map(brief), [
    'rm -f sigterm sigint restart',
    'volume rm world',
    'image rm RUN:check',
  ])
})

test('when `docker events` fails, the stop is judged on the CLI\u2019s time against the whole timeout', async () => {
  const { summary, said } = await simulate(args =>
    args[0] === 'events' ? { code: 1, stderr: 'Error response from daemon: unsupported' } : undefined
  )
  assert.equal(summary.ok, true, summary.failures.join('; '))
  const timing = summary.containers[0].stop.timing
  assert.deepEqual(timing, {
    source: 'cli',
    ms: 400,
    why: '`docker events` failed',
    cliMs: 400,
    signals: [],
    dieExitCode: null,
  })
  assert.equal(summary.containers[0].stop.elapsedFrom, 'cli')
  assert.ok(said.some(line => line.includes('not available: exited 1: Error response from daemon: unsupported')))
  assert.ok(said.some(line => line.includes("Docker's own times not read (`docker events` failed)")))
  // a `docker events` that throws (it ran out of time) is no failed step either
  const hung = await simulate(args => {
    if (args[0] === 'events') throw new Error('`docker events …` was not done within 15 s')
    return undefined
  })
  assert.equal(hung.summary.ok, true, hung.summary.failures.join('; '))
  assert.equal(
    hung.summary.containers[1].stop.timing.why,
    '`docker events` failed: `docker events …` was not done within 15 s'
  )
  // its time is bounded, well under the one of a command that may take a minute
  assert.ok(EVENTS_TIMEOUT_MS <= 15_000)
  // and a CLI that took 5 s for SIGINT's 5 s timeout fails it
  const slow = await simulate(args => {
    if (args[0] === 'events') return { code: 1, stderr: 'no' }
    if (args[0] === 'stop' && args.includes('SIGINT')) return { ms: 5000 }
    return undefined
  })
  assert.deepEqual(slow.summary.failures, [
    "sigint (SIGINT, 5 s): the `docker stop` command took 5.0 s (Docker's own times were not read): not under 5 s, the timeout itself",
  ])
})

test('a container that never becomes healthy ends the run at once, with its log and the cleanup', async () => {
  let polls = 0
  const { summary, commands, said } = await simulate(args => {
    if (args[0] === 'container') {
      polls++
      const Health = {
        Status: polls > 5 ? 'unhealthy' : 'starting',
        Log: [{ ExitCode: 7, Output: 'curl: (7) refused' }],
      }
      return { stdout: JSON.stringify({ Status: 'running', Running: true, ExitCode: 0, Health }) }
    }
    if (args[0] === 'logs') return { stdout: '', stderr: '[envs] WORLD not set' }
    return undefined
  })
  assert.equal(polls, 120, 'the wait is bounded')
  assert.equal(summary.ok, false)
  assert.equal(summary.failures.length, 1)
  assert.match(
    summary.failures[0],
    /-sigterm was not healthy after .* s \(health unhealthy; the last probe exited 7 saying "curl: \(7\) refused"\)/
  )
  // the inspect command is printed once, however often it is asked
  assert.equal(commands.filter(args => args[0] === 'container').length, 1)
  assert.ok(said.some(line => line.includes('[envs] WORLD not set')))
  assert.ok(said.some(line => /after .* s: running, health unhealthy/.test(line)))
  assert.deepEqual(commands.slice(-3).map(brief), ['rm -f sigterm', 'volume rm world', 'image rm RUN:check'])
  assert.ok(!commands.some(args => args[0] === 'stop'), 'nothing is stopped that never started well')
})

test('a container that exits during start-up fails fast', async () => {
  let polls = 0
  const { summary, commands } = await simulate(args => {
    if (args[0] !== 'container') return undefined
    polls++
    return {
      stdout: JSON.stringify({ Status: 'exited', Running: false, ExitCode: 1, Health: { Status: 'unhealthy' } }),
    }
  })
  assert.equal(polls, 1)
  assert.match(summary.failures[0], /-sigterm stopped by itself before it was healthy \(exit code 1\)/)
  assert.deepEqual(commands.slice(-3).map(brief), ['rm -f sigterm', 'volume rm world', 'image rm RUN:check'])
})

test('an image without a health check, a missing server process and a wrong commit hash are failures', async () => {
  const none = await simulate(args =>
    args[0] === 'container' ? { stdout: JSON.stringify({ Status: 'running', Running: true, ExitCode: 0 }) } : undefined
  )
  assert.match(none.summary.failures[0], /has no health status: the image declares no HEALTHCHECK/)

  const lost = await simulate(args => {
    if (args[2] === 'ps') return { stdout: 'PID   PPID  USER     COMMAND\n    1     0 root     npm run start\n' }
    if (args[2] === 'curl') return { stdout: JSON.stringify({ commitHash: 'local' }) }
    return undefined
  })
  assert.deepEqual(lost.summary.failures, [
    'sigterm: no `node build/index.js` process is running in the container',
    `sigterm: GET /status did not answer with commitHash ${HASH} (got "{\\"commitHash\\":\\"local\\"}")`,
  ])
  // both are noted, and the run still goes on to the stops
  assert.equal(lost.summary.containers[0].stop.ok, true)
  assert.equal(lost.summary.containers.length, 3)
})

test('what is only looked at may fail without failing the run', async () => {
  const { summary, said } = await simulate(args => {
    if (args[0] === 'exec' && ['readlink', 'ls'].includes(args[2]))
      return { code: 1, stderr: 'readlink: /proc/1/exe: Permission denied' }
    if (args[0] === 'image' && args[1] === 'inspect') return { code: 1, stderr: 'no such image' }
    return undefined
  })
  assert.equal(summary.ok, true)
  assert.equal(summary.containers[0].pid1.exe, null)
  assert.equal(summary.containers[0].world, null)
  assert.equal(summary.image.config, null)
  assert.ok(said.some(line => line.includes('not available: exited 1: readlink: /proc/1/exe: Permission denied')))
})

test('a build that fails: nothing is started, and only the tag is removed', async () => {
  const { summary, commands, said } = await simulate(args => (args[0] === 'build' ? { code: 1 } : undefined))
  assert.equal(summary.ok, false)
  assert.match(summary.failures[0], /^`docker build --build-arg COMMIT_HASH=.* exited 1: its output is above$/)
  assert.deepEqual(commands.map(brief), [
    'version --format {{.Client.Version}} {{.Server.Version}}',
    'build --build-arg COMMIT_HASH=RUN -t RUN:check /repo',
    'image rm RUN:check',
  ])
  // had the tag not been made, its removal failing is not one more failure
  const untagged = await simulate(args =>
    args[0] === 'build' || args[0] === 'image' ? { code: 1, stderr: 'No such image' } : undefined
  )
  assert.equal(untagged.summary.failures.length, 1)
  assert.equal(untagged.summary.cleanup[0].code, 1)
  assert.ok(said.length > 0)
})

test('without a docker that answers nothing is created and nothing is removed', async () => {
  const { summary, commands } = await simulate(() => ({ code: 1, stderr: 'Cannot connect to the Docker daemon' }))
  assert.match(summary.failures[0], /^`docker version .* exited 1: Cannot connect to the Docker daemon$/)
  assert.equal(commands.length, 1)
  assert.deepEqual(summary.cleanup, [])
})

test('something this run created that cannot be removed is a failure', async () => {
  const { summary } = await simulate(args =>
    args[0] === 'volume' && args[1] === 'rm' ? { code: 1, stderr: 'volume is in use' } : undefined
  )
  assert.deepEqual(summary.failures, ['cleanup: the volume was not removed (exit 1: volume is in use)'])
})

test('an interruption ends the run without a verdict on the image, and the cleanup goes straight to the removals', async () => {
  // the docker function of the script, in short: after the signal it refuses every command but the removals
  const inner = simulatedDocker({ commitHash: HASH })
  let interrupted = null
  const afterSignal = []
  const docker = async args => {
    if (interrupted && commandKind(args) !== 'remove') {
      throw Object.assign(new Error(`stopped by ${interrupted}`), { interrupted })
    }
    if (interrupted) afterSignal.push(args)
    const result = await inner(args)
    if (args[0] === 'exec' && args[2] === 'ps') interrupted = 'SIGINT'
    return result
  }
  const commands = []
  const said = []
  const summary = await runImageCheck({
    docker,
    names: NAMES,
    repoDir: '/repo',
    commitHash: HASH,
    env: ENV,
    report: { command: args => commands.push(args), info: text => said.push(text) },
    sleep: async () => {},
    interrupted: () => interrupted,
  })
  assert.equal(summary.ok, false)
  assert.equal(summary.interrupted, 'SIGINT')
  assert.deepEqual(summary.failures, [])
  // the running container's log is not taken: the removals come first, and only they are printed after the signal
  assert.deepEqual(afterSignal.map(brief), ['rm -f sigterm', 'volume rm world', 'image rm RUN:check'])
  assert.deepEqual(commands.slice(-4).map(brief), [
    'exec sigterm ps -o pid,ppid,user,args',
    'rm -f sigterm',
    'volume rm world',
    'image rm RUN:check',
  ])
  assert.ok(said.includes(`  (${NAMES.containers.sigterm}'s log is not taken after SIGINT: the removals go first)`))
  assert.deepEqual(
    summary.cleanup.map(step => step.code),
    [0, 0, 0]
  )
})

test('what a signal does to each docker command of a run', async () => {
  const { commands } = await simulate()
  const kinds = commands.map(args => [brief(args).split(' ').slice(0, 2).join(' '), commandKind(args)])
  // the removals are the cleanup's three, last; the creating commands are the volume and the three containers
  assert.deepEqual(
    kinds.filter(([, kind]) => kind === 'remove').map(([command]) => command),
    ['rm -f', 'volume rm', 'image rm']
  )
  assert.deepEqual(
    kinds.filter(([, kind]) => kind === 'create').map(([command]) => command),
    ['volume create', 'run -d', 'run -d', 'run -d']
  )
  // everything else only reads or waits, the build and the stops among them
  const waiting = new Set(kinds.filter(([, kind]) => kind === 'wait').map(([command]) => command.split(' ')[0]))
  assert.deepEqual([...waiting].sort(), ['build', 'container', 'events', 'exec', 'image', 'logs', 'stop', 'version'])
  assert.equal(commandKind(['image', 'inspect', '--format', '{{json .Config}}', 'x']), 'wait')
})

test('the cleanup after a signal fits in GitHub\u2019s cancellation: SIGTERM after 7.5 s, the tree killed at 10 s', () => {
  const budget = SIGNAL_BUDGET
  assert.equal(budget.secondSignalMs, 7500)
  assert.equal(budget.treeKilledMs, 10_000)
  // a creating command's wait and the three removals, one after the other
  assert.equal(budget.createWaitMs + 3 * budget.removeTimeoutMs, budget.cleanupMs)
  assert.ok(budget.cleanupMs <= budget.secondSignalMs)
  // a removal that ran out of time is killed after killAfterMs: still before the tree is
  assert.ok(budget.cleanupMs + budget.killAfterMs < budget.treeKilledMs)
})

test('a docker command that throws (not found, out of time) is a failed step', async () => {
  const docker = async () => {
    throw new Error('the `docker` command was not found')
  }
  const summary = await runImageCheck({
    docker,
    names: NAMES,
    repoDir: '/repo',
    commitHash: HASH,
    env: ENV,
    report: { command: () => {}, info: () => {} },
  })
  assert.deepEqual(summary.failures, ['the `docker` command was not found'])
  assert.equal(summary.interrupted, null)
})

// --- the arguments and the models -----------------------------------------------------------------------------

test('arguments: the model, the summary file, the logs folder, the dry run', () => {
  assert.deepEqual(parseArgs([]), { model: 'current', summary: null, logs: null, dryRun: false, help: false })
  assert.deepEqual(parseArgs(['--model=current', '--summary', 'image-check.json', '--logs=out/logs', '--dry-run']), {
    model: 'current',
    summary: 'image-check.json',
    logs: 'out/logs',
    dryRun: true,
    help: false,
  })
  assert.equal(parseArgs(['--model', 'current']).model, 'current')
  assert.throws(() => parseArgs(['--summary']), UsageError)
  assert.throws(() => parseArgs(['--summary', '--dry-run']), /--summary needs a value/)
  assert.throws(() => parseArgs(['--model=']), /--model needs a value/)
  assert.throws(() => parseArgs(['--push']), /unknown argument "--push"/)
  assert.throws(() => parseArgs(['world']), /unknown argument "world"/)
})

test('models: only `current` exists; `nonroot` and anything else is an error', () => {
  assert.deepEqual(Object.keys(MODELS), ['current'])
  assert.equal(modelFor('current'), MODELS.current)
  assert.throws(
    () => modelFor('nonroot'),
    err => err instanceof UsageError && /--model=nonroot is not implemented yet/.test(err.message)
  )
  assert.throws(() => modelFor('root'), /unknown model "root" \(known: current\)/)
  assert.throws(() => modelFor('toString'), /unknown model "toString"/)
  assert.throws(() => parseArgs(['--model=nonroot']), UsageError)
  assert.throws(() => parseArgs(['--model', 'today']), /unknown model "today"/)
})

// --- the script itself ----------------------------------------------------------------------------------------

// a PATH on which there is no docker: a run that tried to start it would fail
const emptyBin = () => fs.mkdtempSync(path.join(os.tmpdir(), 'image-check-nodocker-'))
const runScript = (args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 })

test('the script imports nothing outside Node and its own two modules', () => {
  // the workflow runs it without `npm ci`
  for (const file of ['scripts/image-check.mjs', 'scripts/lib/imageCheck.mjs', 'scripts/lib/startEnv.mjs']) {
    const imports = [...read(file).matchAll(/^import [^'"]*['"]([^'"]+)['"]|^\} from ['"]([^'"]+)['"]/gm)].map(
      match => match[1] ?? match[2]
    )
    for (const name of imports) {
      assert.ok(
        name.startsWith('node:') || ['./lib/imageCheck.mjs', './startEnv.mjs'].includes(name),
        `${file} imports ${name}`
      )
    }
    assert.ok(!/\bimport\(|\brequire\(/.test(read(file)), `${file} has no dynamic import`)
  }
  assert.ok(read('scripts/image-check.mjs').includes("from './lib/imageCheck.mjs'"))
})

test('--dry-run prints the commands of a run and starts no docker', () => {
  const bin = emptyBin()
  try {
    const out = runScript(['--dry-run', '--model=current', '--summary', path.join(bin, 'summary.json')], { PATH: bin })
    assert.equal(out.status, 0, out.stderr)
    const commands = out.stdout.split('\n').filter(line => line.startsWith('docker '))
    assert.equal(commands.length, 28)
    assert.match(
      commands[1],
      /^docker build --build-arg COMMIT_HASH=image-check-[0-9a-f]{12} -t image-check-[0-9a-f]{12}:check \S+$/
    )
    assert.match(
      commands[5],
      /^docker container inspect --format '\{\{json \.State\}\}' image-check-[0-9a-f]{12}-sigterm$/
    )
    assert.ok(commands.some(line => /^docker stop -t 10 image-check-[0-9a-f]{12}-sigterm$/.test(line)))
    assert.ok(commands.some(line => /^docker stop --signal SIGINT -t 5 image-check-[0-9a-f]{12}-sigint$/.test(line)))
    assert.match(commands[27], /^docker image rm image-check-[0-9a-f]{12}:check$/)
    // Docker's record of each stop, over a window around it
    const events = commands.filter(line => line.startsWith('docker events '))
    assert.equal(events.length, 2)
    for (const [i, role] of ['sigterm', 'sigint'].entries()) {
      assert.match(
        events[i],
        new RegExp(
          `^docker events --since \\d{10}\\.\\d{9} --until \\d{10}\\.\\d{9} --filter container=image-check-[0-9a-f]{12}-${role} --filter type=container --format '\\{\\{json \\.\\}\\}'$`
        )
      )
    }
    assert.ok(!commands.some(line => / (-p|--publish)[ =]/.test(line)))
    assert.match(out.stdout, /dry run: 28 docker commands, none was run/)
    assert.ok(!fs.existsSync(path.join(bin, 'summary.json')), 'a dry run writes no summary')
  } finally {
    fs.rmSync(bin, { recursive: true, force: true })
  }
})

test('an unknown model and an unknown argument end with code 2 before anything is run', () => {
  const bin = emptyBin()
  try {
    for (const [args, message] of [
      [['--model=nonroot'], /--model=nonroot is not implemented yet/],
      [['--model=tini'], /unknown model "tini"/],
      [['--push'], /unknown argument "--push"/],
    ]) {
      const out = runScript(args, { PATH: bin })
      assert.equal(out.status, 2, args.join(' '))
      assert.match(out.stderr, message)
      assert.match(out.stderr, /usage: node scripts\/image-check\.mjs/)
      assert.equal(out.stdout, '')
    }
  } finally {
    fs.rmSync(bin, { recursive: true, force: true })
  }
})

test('without docker the script says so, writes the summary and exits 1', () => {
  const bin = emptyBin()
  try {
    const summaryFile = path.join(bin, 'out', 'summary.json')
    const out = runScript(['--summary', summaryFile, '--logs', path.join(bin, 'logs')], { PATH: bin })
    assert.equal(out.status, 1)
    assert.match(out.stderr, /FAILED after \d+ s:\n\[image-check\] {3}- the `docker` command was not found/)
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    assert.equal(summary.ok, false)
    assert.equal(summary.failures.length, 1)
    assert.deepEqual(summary.cleanup, [])
    assert.deepEqual(summary.logFiles, [])
  } finally {
    fs.rmSync(bin, { recursive: true, force: true })
  }
})

// A `docker` on PATH that is test/lib/fakeDocker.mjs: the script's own spawning, files and signal handling run.
function fakeDockerBin(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-check-fake-'))
  const fake = path.join(root, 'test/lib/fakeDocker.mjs')
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 })
  const env = { PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_DIR: dir, FAKE_DOCKER_MODE: mode }
  const calls = () =>
    fs
      .readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
  return { dir, env, calls }
}
const posixOnly = { skip: process.platform === 'win32' ? 'needs a POSIX shell for the fake docker' : false }

test('the script against a fake docker: it passes, and writes the summary and the three logs', posixOnly, () => {
  const fake = fakeDockerBin('ok')
  try {
    const summaryFile = path.join(fake.dir, 'image-check.json')
    const logs = path.join(fake.dir, 'logs')
    const out = runScript(['--model=current', '--summary', summaryFile, '--logs', logs], fake.env)
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`.slice(-2000))
    assert.match(out.stdout, /\[image-check\] passed in \d+ s \(model current\)/)
    assert.match(out.stdout, /\[image-check\] {3}PID 1 is npm \(`npm run start`, user root\)/)
    assert.match(
      out.stdout,
      /PID 1: executable \/usr\/local\/bin\/node, name "npm run start", uid 0, SIGTERM handled, SIGINT handled/
    )
    assert.match(out.stdout, /SIGINT: the server's log says it saved, and the container exited 0 by itself/)
    assert.match(
      out.stdout,
      /by Docker's clock SIGINT sent, and its die event \(exitCode 0\) 0\.200 s later; the `docker stop` command took \d+\.\d s/
    )
    // the build's own output goes straight to the script's (here: stderr, as BuildKit writes it)
    assert.match(out.stderr, /#1 \[internal\] load build definition from Dockerfile/)
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    assert.equal(summary.ok, true)
    assert.deepEqual(
      summary.logFiles.map(file => path.basename(file)),
      ['sigterm.log', 'sigint.log', 'restart.log']
    )
    assert.match(fs.readFileSync(path.join(logs, 'sigterm.log'), 'utf8'), /\[network\] final save complete/)
    const calls = fake.calls()
    assert.equal(calls.length, 28)
    // every command the output shows was given to docker with these very arguments, but for the masked secret
    const shown = out.stdout.split('\n').filter(line => line.startsWith('[image-check] $ docker '))
    assert.deepEqual(
      shown.map(line => line.slice('[image-check] $ docker '.length)),
      calls.map(formatCommand)
    )
    const secrets = calls
      .filter(args => args[0] === 'run')
      .map(args => args.find(arg => arg.startsWith('JWT_SECRET=')).slice('JWT_SECRET='.length))
    assert.equal(secrets.length, 3)
    assert.match(secrets[0], /^made-up-for-this-run-[0-9a-f]{32}$/, 'docker is given the value itself')
    assert.ok(!`${out.stdout}${out.stderr}`.includes(secrets[0]), 'the value is not in the output')
    assert.equal(shown.filter(line => line.includes(" -e 'JWT_SECRET=***' ")).length, 3)
    assert.deepEqual(calls[calls.length - 1].slice(0, 2), ['image', 'rm'])
  } finally {
    fs.rmSync(fake.dir, { recursive: true, force: true })
  }
})

test(
  'the script against a fake docker whose first container is killed: exit 1, every reason, the cleanup',
  posixOnly,
  () => {
    const fake = fakeDockerBin('killed')
    try {
      const summaryFile = path.join(fake.dir, 'image-check.json')
      const out = runScript(['--summary', summaryFile], fake.env)
      assert.equal(out.status, 1, `${out.stdout}\n${out.stderr}`.slice(-2000))
      assert.match(out.stderr, /FAILED after \d+ s:/)
      assert.match(out.stderr, / {3}- sigterm \(SIGTERM, 10 s\): exit code 137, expected 0/)
      assert.match(out.stderr, / {3}- sigterm \(SIGTERM, 10 s\): the log has no `\[network\] final save complete` line/)
      const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
      assert.equal(summary.ok, false)
      assert.equal(summary.containers[0].stop.exitCode, 137)
      // Docker's own record of it: SIGTERM, SIGKILL at the timeout, the die with 137
      assert.match(out.stderr, / {3}- sigterm \(SIGTERM, 10 s\): the stop took 10\.1 s by Docker's clock/)
      assert.deepEqual(summary.containers[0].stop.timing.signals, ['SIGTERM', 'SIGKILL'])
      assert.equal(summary.containers[0].stop.timing.dieExitCode, 137)
      assert.equal(summary.containers[1].stop.ok, true)
      const calls = fake.calls()
      assert.deepEqual(
        calls.slice(-3).map(args => args.slice(0, 2).join(' ')),
        ['rm -f', 'volume rm', 'image rm']
      )
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true })
    }
  }
)

test('a SIGINT to the script during the build ends the build, cleans up and exits 130', posixOnly, async () => {
  const fake = fakeDockerBin('hang-build')
  try {
    const summaryFile = path.join(fake.dir, 'image-check.json')
    const child = spawn(process.execPath, [script, '--summary', summaryFile], {
      env: { ...process.env, ...fake.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', data => (output += data))
    child.stderr.on('data', data => (output += data))
    const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    // once the fake build has begun (its first line of output), the script is told to stop
    const deadline = Date.now() + 30_000
    while (!output.includes('#1 [internal] load build definition') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.match(output, /#1 \[internal\] load build definition/)
    child.kill('SIGINT')
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    const end = await ended
    clearTimeout(timer)
    assert.deepEqual(end, { code: 130, signal: null }, output.slice(-2000))
    assert.match(output, /\[image-check\] SIGINT: ending the run and removing what it created/)
    assert.match(output, /\[image-check\] stopped by SIGINT after \d+ s/)
    // nothing was started after the build; the tag it may have made is removed
    assert.deepEqual(
      fake.calls().map(args => args.slice(0, 2).join(' ')),
      ['version --format', 'build --build-arg', 'image rm']
    )
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    assert.equal(summary.interrupted, 'SIGINT')
    assert.deepEqual(summary.failures, [])
  } finally {
    fs.rmSync(fake.dir, { recursive: true, force: true })
  }
})

// the script as a process of its own, its output collected as it comes
function spawnScript(args, env) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const run = { child, output: '' }
  child.stdout.on('data', data => (run.output += data))
  child.stderr.on('data', data => (run.output += data))
  run.ended = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })))
  // (a script that never ends would hold the test run: it is killed long after any bound asserted here)
  const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  run.ended.then(() => clearTimeout(killer))
  return run
}
async function waitFor(check, what, ms = 30_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`no ${what} within ${ms} ms`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}
const readIfThere = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
// the commands given to docker after the first `docker stop`, as `stop -t`, `rm -f`, …
const afterStop = fake => {
  const calls = fake.calls().map(args => args.slice(0, 2).join(' '))
  return calls.slice(calls.indexOf('stop -t') + 1)
}

test(
  'a SIGINT while `docker stop` hangs: the stop is killed, the removals run at once and in order, exit 130',
  posixOnly,
  async () => {
    const fake = fakeDockerBin('hang-stop')
    try {
      const summaryFile = path.join(fake.dir, 'image-check.json')
      const run = spawnScript(['--summary', summaryFile], fake.env)
      await waitFor(() => readIfThere(path.join(fake.dir, 'stop.pid')), 'docker stop')
      const stopPid = Number(readIfThere(path.join(fake.dir, 'stop.pid')))
      const signalled = Date.now()
      run.child.kill('SIGINT')
      const end = await run.ended
      assert.deepEqual({ code: end.code, signal: end.signal }, { code: 130, signal: null }, run.output.slice(-2000))
      // the stop was told to end, did not, and was killed
      assert.equal(readIfThere(path.join(fake.dir, 'stop.signals')), 'SIGTERM\n')
      assert.equal(isAlive(stopPid), false, 'the hung `docker stop` is not running any more')
      // after the stop: the three removals, once each, in this order, and nothing else (no log is taken first)
      assert.deepEqual(afterStop(fake), ['rm -f', 'volume rm', 'image rm'])
      // The bound GitHub sets is 10 s. This one is looser, for a loaded machine, and still far below the 40 s a
      // script that waited for the stop's own timeout would take.
      assert.ok(end.at - signalled < 15_000, `${end.at - signalled} ms`)
      assert.match(run.output, /\[image-check\] SIGINT: ending the run and removing what it created/)
      assert.match(run.output, /\[image-check\] stopped by SIGINT after \d+ s/)
      const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
      assert.equal(summary.interrupted, 'SIGINT')
      assert.deepEqual(summary.failures, [])
      assert.deepEqual(
        summary.cleanup.map(step => [step.what, step.code]),
        [
          ['the containers', 0],
          ['the volume', 0],
          ['the image tag', 0],
        ]
      )
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true })
    }
  }
)

test(
  'a second signal during the cleanup does not stop it, and the first signal gives the exit code (143)',
  posixOnly,
  async () => {
    const fake = fakeDockerBin('hang-stop')
    try {
      const summaryFile = path.join(fake.dir, 'image-check.json')
      // `docker rm` waits for the file `release`, so that the second signal surely comes while it runs
      const run = spawnScript(['--summary', summaryFile], { ...fake.env, FAKE_DOCKER_HOLD_RM: '1' })
      await waitFor(() => readIfThere(path.join(fake.dir, 'stop.pid')), 'docker stop')
      run.child.kill('SIGTERM')
      await waitFor(() => fake.calls().some(args => args[0] === 'rm'), 'docker rm')
      run.child.kill('SIGINT')
      await waitFor(() => run.output.includes('SIGINT again'), 'the second signal')
      fs.writeFileSync(path.join(fake.dir, 'release'), '')
      const end = await run.ended
      assert.deepEqual({ code: end.code, signal: end.signal }, { code: 143, signal: null }, run.output.slice(-2000))
      assert.match(run.output, /\[image-check\] SIGINT again: the cleanup goes on \(it is over within 7\.5 s/)
      // the removal in flight ran to its end, and the two after it ran
      assert.ok(fs.existsSync(path.join(fake.dir, 'rm.done')), '`docker rm` was not cut short')
      assert.deepEqual(afterStop(fake), ['rm -f', 'volume rm', 'image rm'])
      const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
      assert.equal(summary.interrupted, 'SIGTERM')
      assert.deepEqual(
        summary.cleanup.map(step => step.code),
        [0, 0, 0]
      )
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true })
    }
  }
)

// --- the workflow ---------------------------------------------------------------------------------------------

test('image.yml: read-only, pinned to the commits ci.yml uses, no Docker action, no install', () => {
  const workflow = read('.github/workflows/image.yml')
  const ci = read('.github/workflows/ci.yml')
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m)
  assert.ok(!/packages:|id-token:|secrets\./.test(workflow), 'no further permission and no secret')
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map(match => match[1])
  assert.equal(uses.length, 3)
  for (const action of uses) {
    assert.match(action, /^actions\/(checkout|setup-node|upload-artifact)@[0-9a-f]{40}$/, action)
    // the same commit as in another workflow of this repository
    const elsewhere = [ci, read('.github/workflows/e2e.yml')].some(text => text.includes(`uses: ${action} `))
    assert.ok(elsewhere, `${action} is pinned as elsewhere`)
  }
  assert.ok(!/uses: docker\//.test(workflow))
  assert.ok(!/^\s+(- )?run: .*npm (ci|install)/m.test(workflow), 'the script needs no install')
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /runs-on: ubuntu-24\.04/)
  assert.match(workflow, /timeout-minutes: \d+/)
  assert.match(workflow, /node-version-file: '\.nvmrc'/)
  // `exec`: Node, not Bash, is the step's process, so a cancel's SIGINT reaches the script and its cleanup runs
  assert.match(
    workflow,
    /\n {8}run: exec node scripts\/image-check\.mjs --model=current --summary image-check\.json --logs image-check-logs\n/
  )
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}\n\s+uses: actions\/upload-artifact@/)
  // what the image is built from, the harness and the workflow itself, for pull requests and for main alike
  const paths = [...workflow.matchAll(/^ {6}- '([^']+)'$/gm)].map(match => match[1])
  const wanted = [
    'Dockerfile',
    '.dockerignore',
    'package.json',
    'package-lock.json',
    '.nvmrc',
    'scripts/build*.mjs',
    'scripts/lib/**',
    'scripts/image-check.mjs',
    'src/server/**',
    // bundled into the server (build/index.js): the final save is in src/core/systems/ServerNetwork.js
    'src/core/**',
    '.github/workflows/image.yml',
  ]
  assert.deepEqual(paths, [...wanted, ...wanted])
  assert.match(workflow, /\n {2}schedule:\n {4}- cron: '/)
  assert.match(workflow, /\n {2}workflow_dispatch:/)
})
