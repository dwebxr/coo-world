// scripts/coo-entrypoint.sh, the Docker image's entry point, run as it is: the real file, with `sh` and `dash`, the
// real `node` (it computes the world folder with path.join), the real `mkdir`, `printf` and `find` traversal. What a
// test that is not root cannot do is stood in for (test/lib/entrypointStub.mjs): `id -u` says what the test wants
// (0 for the root branch); `su-exec` and the command are only recorded; `chown -h 1001:1001` is recorded and done as
// `chgrp -h` to the test's own group; and `find` is the real find with 1001 meaning the test's own uid and gid. So
// "not 1001:1001's" is here "in another group of the test user", and the uid side of the test is never "not theirs".
//
// The script reaches folders outside /app through `..` in WORLD (path.join('/app/', '../tmp/x') is /tmp/x), so it
// needs no switch for tests, and nothing here touches /app: the refused folders are refused before anything is
// looked at, and the branches that would touch /app/world are the ones that do not (empty WORLD, not root).
//
// NOT covered here (only the image run in CI shows them, scripts/image-check.mjs --model=nonroot): BusyBox ash and
// BusyBox find, chown and su-exec themselves; a real change of owner; a uid that is not the test user's; -xdev on a
// real mount point (making one needs root).
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
const STUBS = ['id', 'su-exec', 'chown', 'find', 'coo-test-command']
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

// A temp folder with the stand-ins on a PATH of their own, before the real node and the system's tools.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coo-entrypoint-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  for (const name of STUBS) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${stub}" ${name} "$@"\n`, {
      mode: 0o755,
    })
  }
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
  const run = (shell, { world, uid = 0, chown = 'apply', args = COMMAND } = {}) => {
    fs.rmSync(path.join(dir, 'calls.jsonl'), { force: true })
    const env = { PATH, STUB_DIR: dir, STUB_UID: String(uid), STUB_CHOWN: chown, HOME: dir }
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

  test(`the entrypoint (${shell}): /, /app and the image's code folders are refused, whoever starts it`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const box = sandbox()
    try {
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
      ]
      for (const [world, dir] of refused) {
        for (const uid of [0, 2000]) {
          const out = box.run(shell, { world, uid })
          assert.equal(out.status, 1, `${world}: ${out.stderr}`)
          assert.ok(out.stderr.startsWith(`[entrypoint] refused: WORLD names ${dir}. `), `${world}: ${out.stderr}`)
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
        ['../data', '/data'],
        ['../application', '/application'],
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

  test(`the entrypoint (${shell}): started as root, it gives what is not 1001's to 1001 and runs the command through su-exec`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const box = sandbox()
    try {
      const ids = groups(box.dir)
      if (!ids) return skipOrFail(t, 'the test user is in one group only: no entry can be made "not theirs"')
      const base = path.join(box.dir, 'base')
      fs.mkdirSync(base)
      const world = makeWorld(base, ids)
      // (path.join on the server's side: /app/ joined to `..<folder>`)
      const out = box.run(shell, { world: worldFor(world.world) })
      assert.equal(out.status, 0, out.stderr)
      assert.equal(out.stderr, '')
      assert.equal(out.stdout, `[entrypoint] entries given to 1001:1001 under ${world.world}: 4\n`)

      // find: from the world folder, on its own file system, those not 1001's (in uid or gid)
      const finds = names(out.calls, 'find')
      assert.equal(finds.length, 3, 'counted, changed, counted again')
      const predicate = ['-xdev', '(', '!', '-user', '1001', '-o', '!', '-group', '1001', ')', '-exec']
      for (const args of finds) assert.deepEqual(args.slice(0, 12), [world.world, ...predicate])
      assert.deepEqual(finds[0].slice(12), ['printf', '.%.0s', '{}', '+'])
      assert.deepEqual(finds[1].slice(12), ['chown', '-h', '1001:1001', '{}', '+'])

      // chown: always -h, always 1001:1001, and only for what was not theirs: the links themselves, nothing they
      // point to, and nothing in a folder a link points to
      const chowns = names(out.calls, 'chown')
      for (const args of chowns) assert.deepEqual(args.slice(0, 2), ['-h', '1001:1001'])
      assert.deepEqual(
        chowns.flatMap(args => args.slice(2)).sort(),
        [world.db, world.notTheirs, world.linkToFile, world.newline].sort()
      )

      // what that did, as the stand-in does it: everything in the world is "1001's", outside nothing changed
      for (const file of [world.world, world.db, world.assets, world.theirs, world.notTheirs, world.newline]) {
        assert.equal(groupOf(file), ids.own, file)
      }
      assert.equal(groupOf(world.linkToFile), ids.own)
      assert.equal(groupOf(world.secret), ids.other, 'the file a link points to is not changed')
      assert.equal(groupOf(world.inner), ids.other, 'a folder a link points to is not entered')
      assert.equal(groupOf(path.dirname(world.secret)), ids.other)

      // then the command, as 1001:1001, with its arguments as they were; nothing runs it before
      assert.deepEqual(out.calls.at(-1), ['su-exec', '1001:1001', ...COMMAND])
      assert.equal(names(out.calls, 'coo-test-command').length, 0)
      assert.deepEqual(out.calls[0], ['id', '-u'])

      // a second start: nothing left to give, and it says 0
      const again = box.run(shell, { world: worldFor(world.world) })
      assert.equal(again.status, 0, again.stderr)
      assert.equal(again.stdout, `[entrypoint] entries given to 1001:1001 under ${world.world}: 0\n`)
      assert.deepEqual(names(again.calls, 'chown'), [])
      assert.equal(names(again.calls, 'find').length, 1, 'counted once')
      assert.deepEqual(again.calls.at(-1), ['su-exec', '1001:1001', ...COMMAND])

      // one file root wrote later under a folder that is already theirs is found on the next start
      setGroup(world.theirs, ids.other)
      const mixed = box.run(shell, { world: worldFor(world.world) })
      assert.equal(mixed.stdout, `[entrypoint] entries given to 1001:1001 under ${world.world}: 1\n`)
      assert.deepEqual(names(mixed.calls, 'chown'), [['-h', '1001:1001', world.theirs]])
      assert.equal(groupOf(world.theirs), ids.own)
    } finally {
      box.remove()
    }
  })

  test(`the entrypoint (${shell}): a missing world folder is made; one that cannot be made stops the start`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const box = sandbox()
    try {
      const fresh = path.join(box.dir, 'new', 'world')
      const made = box.run(shell, { world: worldFor(fresh) })
      assert.equal(made.status, 0, made.stderr)
      assert.ok(fs.statSync(fresh).isDirectory())
      assert.match(made.stdout, /^\[entrypoint\] entries given to 1001:1001 under .*\/new\/world: \d+\n$/)
      assert.deepEqual(made.calls.at(-1), ['su-exec', '1001:1001', ...COMMAND])

      // a file where a folder of the path should be
      const blocker = path.join(box.dir, 'a-file')
      fs.writeFileSync(blocker, '')
      const blocked = box.run(shell, { world: worldFor(path.join(blocker, 'world')) })
      assert.equal(blocked.status, 1)
      assert.match(blocked.stderr, /\[entrypoint\] could not create .*\/a-file\/world; not starting\n$/)
      assert.deepEqual(
        blocked.calls.map(call => call[0]),
        ['id']
      )
    } finally {
      box.remove()
    }
  })

  test(`the entrypoint (${shell}): a chown that fails, or that leaves entries behind, never runs the command as root`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const box = sandbox()
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
    } finally {
      box.remove()
    }
  })

  test(`the entrypoint (${shell}): started as another user, it changes nothing and runs the command as that user`, t => {
    const reason = skipReason() ?? (available(shell) ? null : `${shell} is not installed`)
    if (reason) return skipOrFail(t, reason)
    const box = sandbox()
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
  assert.ok(!ignored.some(line => /^(scripts|\*\.sh|scripts\/.*)$/.test(line.trim())))
})
