// scripts/coo-entrypoint.sh, the Docker image's entry point, run as it is: the real file, with `sh` and `dash`, the
// real `node` running the real scripts/coo-world-folder.mjs (the decision on the world folder), the real `mkdir`,
// `printf`, `chmod` and `find` traversal. What a test that is not root cannot do is stood in for
// (test/lib/entrypointStub.mjs): `id -u` says what the test wants (0 for the root branch); the command is only
// recorded, and so is `su-exec` but for its `test` checks, which run as the test user; `chown -h 1001:1001` is
// recorded and done as `chgrp -h` to the test's own group; and `find` is the real find with 1001 meaning the test's
// own uid and gid. So "not 1001:1001's" is here "in another group of the test user", and the uid side of the test is
// never "not theirs". `node` is the real node, with the image's path /app/scripts/coo-world-folder.mjs mapped to this
// checkout's.
//
// The script reaches folders outside /app through `..` in WORLD (path.join('/app/', '../tmp/x') is /tmp/x), so it
// needs no switch for tests, and nothing here touches /app: the refused folders are refused before anything is
// looked at, and the branches that would touch /app/world are the ones that do not (empty WORLD, not root). The temp
// folders are named by their real path (on macOS /var is a link to /private/var, and /var is a system tree).
//
// NOT covered here (only the image run in CI shows them, scripts/image-check.mjs --model=nonroot): BusyBox ash and
// BusyBox find, chown, chmod, test and su-exec themselves; a real change of owner; a uid that is not the test user's;
// -xdev on a real mount point (making one needs root). test/worldFolder.test.js has the decision's own cases.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = path.join(root, 'scripts/coo-entrypoint.sh')
const stub = path.join(root, 'test/lib/entrypointStub.mjs')
const cli = path.join(root, 'scripts/coo-world-folder.mjs')
const STUBS = ['id', 'su-exec', 'chown', 'chmod', 'find', 'coo-test-command']
const SYSTEM_TREES = ['/bin', '/sbin', '/lib', '/lib64', '/usr', '/etc', '/dev', '/proc', '/sys', '/run', '/root']
const underSystemTree = folder =>
  [...SYSTEM_TREES, '/home', '/boot', '/var', '/opt'].some(tree => folder === tree || folder.startsWith(`${tree}/`))
// the command the entrypoint is given, with words a shell would split, expand or take for options
const COMMAND = ['coo-test-command', 'build/index.js', 'two words', '', '-x', "it's", '*', '$HOME', 'line\nbreak', '--']

// a skip on a platform that cannot run these; in CI (Linux) nothing may be skipped
function skipReason() {
  if (process.platform === 'win32') return 'needs a POSIX shell'
  if (process.getuid() === 0) return 'runs as root: the stand-ins assume a user that cannot change owners'
  return null
}
function skipOrFail(t, reason) {
  if (process.env.CI) assert.fail(reason)
  t.skip(reason)
}

const available = shell => spawnSync(shell, ['-c', 'exit 0']).status === 0
const SHELLS = ['sh', 'dash']

// A temp folder, by its real path, with the stand-ins on a PATH of their own, before the real node and the system's
// tools.
function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coo-entrypoint-')))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  for (const name of STUBS) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${stub}" ${name} "$@"\n`, {
      mode: 0o755,
    })
  }
  fs.writeFileSync(
    path.join(bin, 'node'),
    [
      '#!/bin/sh',
      'if [ "$1" = /app/scripts/coo-world-folder.mjs ]; then',
      '  shift',
      `  set -- "${cli}" "$@"`,
      'fi',
      `exec "${process.execPath}" "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 }
  )
  const calls = () => {
    const file = path.join(dir, 'calls.jsonl')
    if (!fs.existsSync(file)) return []
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
  }
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter)
  // `world` set to undefined leaves WORLD out of the environment
  const run = (shell, { world, uid = 0, chown = 'apply', chmod = 'real', args = COMMAND } = {}) => {
    fs.rmSync(path.join(dir, 'calls.jsonl'), { force: true })
    const env = { PATH, STUB_DIR: dir, STUB_UID: String(uid), STUB_CHOWN: chown, STUB_CHMOD: chmod, HOME: dir }
    if (world !== undefined) env.WORLD = world
    const out = spawnSync(shell, [script, ...args], { encoding: 'utf8', env, timeout: 30_000 })
    return { status: out.status, stdout: out.stdout, stderr: out.stderr, calls: calls() }
  }
  return { dir, run, remove: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

// WORLD for a folder outside /app, the way the server would reach it: path.join('/app/', '..' + absolute)
const worldFor = folder => `..${folder}`

// Two groups of the test user: its own (standing for 1001) and another one it may give its files (standing for
// "not 1001's"). null when the user is in one group only.
function groups(probeDir) {
  const own = process.getgid()
  const probe = path.join(probeDir, 'probe')
  fs.writeFileSync(probe, '')
  try {
    for (const gid of process.getgroups()) {
      if (gid === own) continue
      if (spawnSync('chgrp', [String(gid), probe]).status === 0) return { own, other: gid }
    }
    return null
  } finally {
    fs.rmSync(probe)
  }
}
const groupOf = file => fs.lstatSync(file).gid
const setGroup = (file, gid) => assert.equal(spawnSync('chgrp', ['-h', String(gid), file]).status, 0, file)

// A world folder with entries in both groups, a link out of it to a file and one to a folder, and a name with a line
// break; the folder's own name has a space and begins with a dash.
function makeWorld(base, { own, other }) {
  const world = path.join(base, '-my world')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(world, 'assets'), { recursive: true })
  fs.mkdirSync(outside)
  const entries = {
    world,
    db: path.join(world, 'db.sqlite'),
    assets: path.join(world, 'assets'),
    theirs: path.join(world, 'assets', 'theirs.glb'),
    notTheirs: path.join(world, 'assets', 'root-wrote-this.glb'),
    newline: path.join(world, 'two\nlines'),
    linkToFile: path.join(world, 'link-out'),
    linkToFolder: path.join(world, 'folder-out'),
    secret: path.join(outside, 'secret'),
    inner: path.join(outside, 'inner'),
  }
  for (const file of [entries.db, entries.theirs, entries.notTheirs, entries.newline, entries.secret, entries.inner]) {
    fs.writeFileSync(file, 'x')
  }
  fs.symlinkSync(entries.secret, entries.linkToFile)
  fs.symlinkSync(outside, entries.linkToFolder)
  for (const file of [base, world, entries.assets, entries.theirs, entries.linkToFolder]) setGroup(file, own)
  for (const file of [entries.db, entries.notTheirs, entries.newline, entries.linkToFile, outside]) {
    setGroup(file, other)
  }
  setGroup(entries.secret, other)
  setGroup(entries.inner, other)
  return entries
}

const names = (calls, stand) => calls.filter(call => call[0] === stand).map(call => call.slice(1))
// the two lines the root branch prints, and the checks it makes as 1001:1001 before it runs the command
const lines = (dir, given, modes) =>
  `[entrypoint] entries given to 1001:1001 under ${dir}: ${given}\n` +
  `[entrypoint] entries given u+rw (files) or u+rwx (folders) under ${dir}: ${modes}\n`
const checks = (dir, db = null) => [
  ['1001:1001', 'test', '-w', dir],
  ['1001:1001', 'test', '-x', dir],
  ...(db
    ? [
        ['1001:1001', 'test', '-r', db],
        ['1001:1001', 'test', '-w', db],
      ]
    : []),
]
const modeOf = file => fs.statSync(file).mode & 0o7777
// a sandbox whose temp folder is not under a system tree (where every world would be refused), or a reason
function usableBox() {
  const box = sandbox()
  if (underSystemTree(box.dir)) {
    box.remove()
    return { reason: `the temp folder ${box.dir} is under a system tree: set TMPDIR elsewhere` }
  }
  return { box }
}

test('the entrypoint: POSIX sh syntax, with sh and dash', t => {
  const reason = skipReason()
  if (reason) return skipOrFail(t, reason)
  assert.match(fs.readFileSync(script, 'utf8'), /^#!\/bin\/sh\n/)
  for (const shell of SHELLS) {
    if (!available(shell)) return skipOrFail(t, `${shell} is not installed`)
    const out = spawnSync(shell, ['-n', script], { encoding: 'utf8' })
    assert.equal(out.status, 0, `${shell} -n: ${out.stderr}`)
  }
})

for (const shell of SHELLS) {
  test(`the entrypoint (${shell}): an empty or missing WORLD runs the command at once, untouched`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const box = sandbox()
    try {
      for (const world of [undefined, '']) {
        const out = box.run(shell, { world })
        assert.equal(out.status, 0, out.stderr)
        // nothing is asked or changed: the command itself is what runs, with its arguments as they were
        assert.deepEqual(out.calls, [COMMAND])
        assert.equal(out.stdout, '')
        assert.equal(out.stderr, '')
      }
      const none = box.run(shell, { world: 'world', args: [] })
      assert.equal(none.status, 1)
      assert.equal(none.stderr, '[entrypoint] no command to run\n')
      assert.deepEqual(none.calls, [])
    } finally {
      box.remove()
    }
  })

  test(`the entrypoint (${shell}): /, /app, the image's code and the system trees are refused, whoever starts it`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const { box, reason: tmp } = usableBox()
    if (tmp) return skipOrFail(t, tmp)
    try {
      // a link on the way into a system tree (the decision is made on the resolved folder)
      const viaLink = path.join(box.dir, 'world')
      fs.mkdirSync(viaLink)
      fs.symlinkSync('/usr/local', path.join(viaLink, 'link'))
      const real = folder => (fs.existsSync(folder) ? fs.realpathSync(folder) : folder)
      const refused = [
        ['..', '/'],
        ['../..', '/'],
        ['.', '/app'],
        ['./', '/app'],
        ['world/..', '/app'],
        ['build', '/app/build'],
        ['build/', '/app/build'],
        ['/build', '/app/build'],
        ['world/../build/world', '/app/build/world'],
        ['node_modules', '/app/node_modules'],
        ['node_modules/.cache/world', '/app/node_modules/.cache/world'],
        ['src', '/app/src'],
        ['src/world', '/app/src/world'],
        ['scripts', '/app/scripts'],
        ['scripts/lib', '/app/scripts/lib'],
        ['../app/build', '/app/build'],
        // (refused by their place as written, before anything is looked at: the folder named is the written one)
        ['../usr/local/bin', '/usr/local/bin'],
        ['../etc', '/etc'],
        ['../var/lib/world', '/var/lib/world'],
        ['../home/world', '/home/world'],
        ['../tmp', '/tmp'],
        // (refused by where a link leads: the folder named is the resolved one)
        [`..${viaLink}/link/bin`, real('/usr/local/bin')],
      ]
      for (const [world, dir] of refused) {
        for (const uid of [0, 2000]) {
          const out = box.run(shell, { world, uid })
          assert.equal(out.status, 1, `${world}: ${out.stderr}`)
          const said = `[entrypoint] refused: WORLD=${JSON.stringify(world)} resolves to ${dir ?? ''}`
          assert.ok(out.stderr.startsWith(said), `${world}: ${out.stderr}`)
          assert.match(
            out.stderr,
            /\n\[entrypoint\] not starting: WORLD names no folder that may be given to 1001:1001 \(why: above\)\n$/
          )
          // refused before anything is asked, made or run
          assert.deepEqual(out.calls, [], world)
          assert.equal(out.stdout, '')
        }
      }
      // what is next to them is not refused (started as another user, so nothing is touched)
      for (const [world, dir] of [
        ['world', '/app/world'],
        ['buildx', '/app/buildx'],
        ['build-cache', '/app/build-cache'],
        ['srcs', '/app/srcs'],
        ['app', '/app/app'],
        ['-rf', '/app/-rf'],
        ['/usr', '/app/usr'],
        ['../data', '/data'],
        ['../application', '/application'],
        ['../mnt/world', `${real('/mnt')}/world`],
      ]) {
        const out = box.run(shell, { world, uid: 2000 })
        assert.equal(out.status, 0, `${world}: ${out.stderr}`)
        assert.equal(
          out.stdout,
          `[entrypoint] started as uid 2000, not as root: nothing under ${dir} changes owner, and the command runs as that user\n`
        )
        assert.deepEqual(out.calls, [['id', '-u'], COMMAND], world)
      }
    } finally {
      box.remove()
    }
  })

  test(`the entrypoint (${shell}): started as root, it gives what is not 1001's to 1001, with read and write, and runs the command through su-exec`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const { box, reason: tmp } = usableBox()
    if (tmp) return skipOrFail(t, tmp)
    try {
      const ids = groups(box.dir)
      if (!ids) return skipOrFail(t, 'the test user is in one group only: no entry can be made "not theirs"')
      const base = path.join(box.dir, 'base')
      fs.mkdirSync(base)
      const world = makeWorld(base, ids)
      // modes root could live with: a database the owner may only read, a folder it may not write
      fs.chmodSync(world.db, 0o400)
      fs.chmodSync(world.assets, 0o500)
      // (path.join on the server's side: /app/ joined to `..<folder>`)
      const out = box.run(shell, { world: worldFor(world.world) })
      assert.equal(out.status, 0, out.stderr)
      assert.equal(out.stderr, '')
      assert.equal(out.stdout, lines(world.world, 4, 2))

      // find: from the world folder, on its own file system
      const finds = names(out.calls, 'find')
      const owners = ['-xdev', '(', '!', '-user', '1001', '-o', '!', '-group', '1001', ')']
      const modes = ['-xdev', '(', '-type', 'f', '!', '-perm', '-600', '-o', '-type', 'd', '!', '-perm', '-700', ')']
      const count = ['-exec', 'printf', '.%.0s', '{}', '+']
      assert.deepEqual(finds, [
        // owners: counted, changed, counted again
        [world.world, ...owners, ...count],
        [world.world, ...owners, '-exec', 'chown', '-h', '1001:1001', '{}', '+'],
        [world.world, ...owners, ...count],
        // modes: counted, files, folders, counted again
        [world.world, ...modes, ...count],
        [world.world, '-xdev', '-type', 'f', '!', '-perm', '-600', '-exec', 'chmod', 'u+rw', '{}', '+'],
        [world.world, '-xdev', '-type', 'd', '!', '-perm', '-700', '-exec', 'chmod', 'u+rwx', '{}', '+'],
        [world.world, ...modes, ...count],
      ])

      // chown: always -h, always 1001:1001, and only for what was not theirs: the links themselves, nothing they
      // point to, and nothing in a folder a link points to
      const chowns = names(out.calls, 'chown')
      for (const args of chowns) assert.deepEqual(args.slice(0, 2), ['-h', '1001:1001'])
      assert.deepEqual(
        chowns.flatMap(args => args.slice(2)).sort(),
        [world.db, world.notTheirs, world.linkToFile, world.newline].sort()
      )
      // chmod: only the file and the folder that lacked it, never a link
      assert.deepEqual(names(out.calls, 'chmod'), [
        ['u+rw', world.db],
        ['u+rwx', world.assets],
      ])
      assert.equal(modeOf(world.db), 0o600)
      assert.equal(modeOf(world.assets), 0o700)

      // what that did, as the stand-in does it: everything in the world is "1001's", outside nothing changed
      for (const file of [world.world, world.db, world.assets, world.theirs, world.notTheirs, world.newline]) {
        assert.equal(groupOf(file), ids.own, file)
      }
      assert.equal(groupOf(world.linkToFile), ids.own)
      assert.equal(groupOf(world.secret), ids.other, 'the file a link points to is not changed')
      assert.equal(groupOf(world.inner), ids.other, 'a folder a link points to is not entered')
      assert.equal(groupOf(path.dirname(world.secret)), ids.other)

      // then, as 1001:1001: the folder and db.sqlite; then the command, with its arguments as they were
      assert.deepEqual(names(out.calls, 'su-exec'), [...checks(world.world, world.db), ['1001:1001', ...COMMAND]])
      assert.equal(names(out.calls, 'coo-test-command').length, 0, 'nothing runs it before su-exec')
      assert.deepEqual(out.calls[0], ['id', '-u'])

      // a second start: nothing left to give, and it says 0 twice
      const again = box.run(shell, { world: worldFor(world.world) })
      assert.equal(again.status, 0, again.stderr)
      assert.equal(again.stdout, lines(world.world, 0, 0))
      assert.deepEqual(names(again.calls, 'chown'), [])
      assert.deepEqual(names(again.calls, 'chmod'), [])
      assert.equal(names(again.calls, 'find').length, 2, 'counted once each')
      assert.deepEqual(again.calls.at(-1), ['su-exec', '1001:1001', ...COMMAND])

      // one file root wrote later under a folder that is already theirs is found on the next start
      setGroup(world.theirs, ids.other)
      const mixed = box.run(shell, { world: worldFor(world.world) })
      assert.equal(mixed.stdout, lines(world.world, 1, 0))
      assert.deepEqual(names(mixed.calls, 'chown'), [['-h', '1001:1001', world.theirs]])
      assert.equal(groupOf(world.theirs), ids.own)
    } finally {
      box.remove()
    }
  })

  test(`the entrypoint (${shell}): a world that is a link is taken as the folder it leads to`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const { box, reason: tmp } = usableBox()
    if (tmp) return skipOrFail(t, tmp)
    try {
      const ids = groups(box.dir)
      if (!ids) return skipOrFail(t, 'the test user is in one group only: no entry can be made "not theirs"')
      const data = path.join(box.dir, 'data')
      fs.mkdirSync(data)
      fs.writeFileSync(path.join(data, 'db.sqlite'), 'x')
      setGroup(data, ids.other)
      setGroup(path.join(data, 'db.sqlite'), ids.other)
      const link = path.join(box.dir, 'world-link')
      fs.symlinkSync(data, link)
      setGroup(link, ids.own)
      const out = box.run(shell, { world: worldFor(link) })
      assert.equal(out.status, 0, out.stderr)
      // the data folder is what is given away and checked; the link is left as it is
      assert.equal(out.stdout, lines(data, 2, 0))
      assert.deepEqual(names(out.calls, 'chown'), [['-h', '1001:1001', data, path.join(data, 'db.sqlite')]])
      assert.equal(groupOf(data), ids.own)
      assert.deepEqual(names(out.calls, 'su-exec'), [
        ...checks(data, path.join(data, 'db.sqlite')),
        ['1001:1001', ...COMMAND],
      ])
      // and a world that does not exist yet below such a link is made in the data folder
      const nested = box.run(shell, { world: worldFor(path.join(link, 'new', 'world')) })
      assert.equal(nested.status, 0, nested.stderr)
      assert.ok(fs.statSync(path.join(data, 'new', 'world')).isDirectory())
      assert.match(nested.stdout, new RegExp(`under ${data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/new/world: `))
    } finally {
      box.remove()
    }
  })

  test(`the entrypoint (${shell}): a server that could not read and write its database is not started`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const { box, reason: tmp } = usableBox()
    if (tmp) return skipOrFail(t, tmp)
    try {
      // db.sqlite is a link to a read-only file outside the world: neither owner nor mode is changed there
      const world = path.join(box.dir, 'world')
      fs.mkdirSync(world)
      const elsewhere = path.join(box.dir, 'elsewhere.sqlite')
      fs.writeFileSync(elsewhere, 'x')
      fs.chmodSync(elsewhere, 0o400)
      fs.symlinkSync(elsewhere, path.join(world, 'db.sqlite'))
      const out = box.run(shell, { world: worldFor(world) })
      assert.equal(out.status, 1)
      assert.ok(
        out.stderr.endsWith(`[entrypoint] 1001:1001 cannot read and write ${world}/db.sqlite; not starting\n`),
        out.stderr
      )
      assert.deepEqual(names(out.calls, 'su-exec'), checks(world, path.join(world, 'db.sqlite')).slice(0, 4))
      assert.equal(modeOf(elsewhere), 0o400)
    } finally {
      box.remove()
    }
  })

  test(`the entrypoint (${shell}): a missing world folder is made; one that cannot be made stops the start`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const { box, reason: tmp } = usableBox()
    if (tmp) return skipOrFail(t, tmp)
    try {
      const fresh = path.join(box.dir, 'new', 'world')
      const made = box.run(shell, { world: worldFor(fresh) })
      assert.equal(made.status, 0, made.stderr)
      assert.ok(fs.statSync(fresh).isDirectory())
      assert.match(made.stdout, /^\[entrypoint\] entries given to 1001:1001 under .*\/new\/world: \d+\n/)
      assert.deepEqual(names(made.calls, 'su-exec'), [...checks(fresh), ['1001:1001', ...COMMAND]])

      // a file where a folder of the path should be: refused by the decision, before anything is made
      const blocker = path.join(box.dir, 'a-file')
      fs.writeFileSync(blocker, '')
      const blocked = box.run(shell, { world: worldFor(path.join(blocker, 'world')) })
      assert.equal(blocked.status, 1)
      assert.ok(
        blocked.stderr.startsWith(
          `[entrypoint] refused: WORLD=${JSON.stringify(worldFor(path.join(blocker, 'world')))} resolves to ${blocker}/world: ${blocker} is not a folder\n`
        ),
        blocked.stderr
      )
      assert.deepEqual(blocked.calls, [])
    } finally {
      box.remove()
    }
  })

  test(`the entrypoint (${shell}): a chown or chmod that fails, or that leaves entries behind, never runs the command`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const { box, reason: tmp } = usableBox()
    if (tmp) return skipOrFail(t, tmp)
    try {
      const ids = groups(box.dir)
      if (!ids) return skipOrFail(t, 'the test user is in one group only: no entry can be made "not theirs"')
      const base = path.join(box.dir, 'base')
      fs.mkdirSync(base)
      const world = makeWorld(base, ids)

      // the chown fails (a read-only volume): find passes the failure on, and the script stops
      const failed = box.run(shell, { world: worldFor(world.world), chown: 'fail' })
      assert.equal(failed.status, 1)
      assert.ok(failed.stderr.includes(`[entrypoint] could not give ${world.world} to 1001:1001`), failed.stderr)
      assert.match(failed.stderr, /not starting as root\n$/)
      assert.equal(failed.stdout, '')
      assert.deepEqual(names(failed.calls, 'su-exec'), [])
      assert.deepEqual(names(failed.calls, 'coo-test-command'), [])
      assert.equal(groupOf(world.db), ids.other)

      // a chown that says it worked and changed nothing: the count after it is what decides
      const silent = box.run(shell, { world: worldFor(world.world), chown: 'noop' })
      assert.equal(silent.status, 1)
      assert.ok(
        silent.stderr.endsWith(
          `[entrypoint] could not give ${world.world} to 1001:1001: 4 of 4 entries are still not theirs after the chown; not starting as root\n`
        ),
        silent.stderr
      )
      assert.equal(names(silent.calls, 'find').length, 3)
      assert.deepEqual(names(silent.calls, 'su-exec'), [])
      assert.deepEqual(names(silent.calls, 'coo-test-command'), [])

      // the owners given, a mode the owner lacks: a chmod that fails, and one that changes nothing
      fs.chmodSync(world.db, 0o400)
      const chmodFailed = box.run(shell, { world: worldFor(world.world), chmod: 'fail' })
      assert.equal(chmodFailed.status, 1)
      assert.ok(
        chmodFailed.stderr.endsWith(
          `[entrypoint] could not give the owner read and write under ${world.world} (a read-only volume?); not starting\n`
        ),
        chmodFailed.stderr
      )
      assert.deepEqual(names(chmodFailed.calls, 'su-exec'), [])
      const chmodSilent = box.run(shell, { world: worldFor(world.world), chmod: 'noop' })
      assert.equal(chmodSilent.status, 1)
      assert.ok(
        chmodSilent.stderr.endsWith(
          `[entrypoint] could not give the owner read and write under ${world.world}: 1 of 1 entries still lack it after the chmod; not starting\n`
        ),
        chmodSilent.stderr
      )
      assert.deepEqual(names(chmodSilent.calls, 'su-exec'), [])
      assert.equal(modeOf(world.db), 0o400)
    } finally {
      box.remove()
    }
  })

  test(`the entrypoint (${shell}): started as another user, it changes nothing and runs the command as that user`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const { box, reason: tmp } = usableBox()
    if (tmp) return skipOrFail(t, tmp)
    try {
      const ids = groups(box.dir)
      if (!ids) return skipOrFail(t, 'the test user is in one group only: no entry can be made "not theirs"')
      const base = path.join(box.dir, 'base')
      fs.mkdirSync(base)
      const world = makeWorld(base, ids)
      const missing = path.join(box.dir, 'missing')
      for (const folder of [world.world, missing]) {
        const out = box.run(shell, { world: worldFor(folder), uid: 1001 })
        assert.equal(out.status, 0, out.stderr)
        assert.equal(
          out.stdout,
          `[entrypoint] started as uid 1001, not as root: nothing under ${folder} changes owner, and the command runs as that user\n`
        )
        assert.deepEqual(out.calls, [['id', '-u'], COMMAND])
      }
      assert.equal(groupOf(world.db), ids.other)
      assert.equal(fs.existsSync(missing), false, 'not made: the server makes it, or says why it cannot')
    } finally {
      box.remove()
    }
  })
}

test('the Dockerfile runs this script as its entrypoint, as root, and the server through it', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')
  const production = dockerfile.slice(dockerfile.indexOf('AS production'))
  assert.match(dockerfile, /\nRUN npm ci\n/)
  assert.ok(!/npm install/.test(dockerfile))
  assert.match(production, /apk add --no-cache --upgrade curl 'brotli-libs>=1\.2\.1' su-exec && \\\n/)
  assert.match(production, / {4}addgroup -S -g 1001 nodeuser && \\\n {4}adduser -S -u 1001 -G nodeuser nodeuser\n/)
  assert.match(production, /\nCOPY scripts\/coo-entrypoint\.sh \/usr\/local\/bin\/coo-entrypoint\.sh\n/)
  assert.match(production, /\nRUN chmod 755 \/usr\/local\/bin\/coo-entrypoint\.sh\n/)
  assert.ok(!/^COPY .*--chmod/m.test(dockerfile), 'the mode is set by RUN: COPY --chmod needs BuildKit')
  assert.match(
    production,
    /\nENTRYPOINT \["\/usr\/local\/bin\/coo-entrypoint\.sh"\]\nCMD \["node", "build\/index\.js"\]\n/
  )
  assert.match(production, /\n {2}CMD curl -fsS "http:\/\/127\.0\.0\.1:\$\{PORT:-3000\}\/health" \|\| exit 1\n/)
  // the entrypoint gives the rights up itself, after the chown: no USER, and no VOLUME
  assert.ok(!/^USER /m.test(dockerfile))
  assert.ok(!/^VOLUME /m.test(dockerfile))
  // the build context holds the script (.dockerignore keeps out *.md, world, .env, … but not scripts/)
  const ignored = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split('\n')
  assert.ok(!ignored.some(line => /^(scripts|\*\.sh|scripts\/.*|\*\.mjs)$/.test(line.trim())))
  // the decision it runs is in the image at the path it names: scripts/ is copied to /app/scripts
  assert.match(production, /\nCOPY --from=builder \/app\/scripts \.\/scripts\n/)
  assert.ok(fs.readFileSync(script, 'utf8').includes('node /app/scripts/coo-world-folder.mjs'))
  assert.ok(fs.existsSync(path.join(root, 'scripts/coo-world-folder.mjs')))
})
