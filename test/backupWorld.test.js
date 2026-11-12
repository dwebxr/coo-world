// `npm run world:backup` (scripts/lib/backupWorld.mjs): the archive holds one consistent state of the database also
// while it is being written, nothing of the world's name is read by a shell, and a WORLD that names no folder
// makes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { BACKUPS_KEPT, backupWorld, oldBackups, worldFolder } from '../scripts/lib/backupWorld.mjs'

function project(t, world = 'world') {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-root-'))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const dir = path.join(rootDir, world)
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'assets', 'model.glb'), 'glb bytes')
  fs.writeFileSync(path.join(dir, 'storage.json'), '{"k":1}')
  return { rootDir, dir, world }
}
function unpack(t, file) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-out-'))
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  execFileSync('tar', ['-xzf', file, '-C', out])
  return out
}
// every path below `dir`; a link is listed and not entered
const tree = (dir, under = '') =>
  fs
    .readdirSync(path.join(dir, under), { withFileTypes: true })
    .flatMap(entry => {
      const name = path.join(under, entry.name)
      return entry.isDirectory() ? [name, ...tree(dir, name)] : [name]
    })
    .sort()
const quiet = () => {}

test('backup: the archive is the world’s folder, with the database as one consistent state while it is written', async t => {
  const { rootDir, dir, world } = project(t)
  // a database in use: write-ahead logging, with rows that are only in the log so far, and a change not committed
  const live = new Database(path.join(dir, 'db.sqlite'))
  t.after(() => live.close())
  live.pragma('journal_mode = WAL')
  live.pragma('wal_autocheckpoint = 0')
  live.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)')
  const insert = live.prepare('INSERT INTO users VALUES (?, ?)')
  for (let i = 0; i < 200; i++) insert.run(`u${i}`, `name ${i}`)
  assert.ok(fs.statSync(path.join(dir, 'db.sqlite-wal')).size > 0, 'the rows are in the log, not in the file yet')
  live.exec('BEGIN')
  insert.run('uncommitted', 'not yet')
  const file = await backupWorld({ rootDir, world, now: new Date(2026, 10, 13, 9, 5, 7), log: quiet })
  live.exec('ROLLBACK')
  assert.equal(live.prepare('SELECT COUNT(*) AS n FROM users').get().n, 200, 'the live database is as it was')
  assert.equal(path.relative(dir, file), path.join('backups', 'backup_2026-11-13_09-05-07.tar.gz'))
  const out = unpack(t, file)
  // laid out as the world's folder is; the log and the lock file of the live database are not in it, nor backups
  assert.deepEqual(tree(out), [
    'world',
    'world/assets',
    'world/assets/model.glb',
    'world/db.sqlite',
    'world/storage.json',
  ])
  assert.equal(fs.readFileSync(path.join(out, 'world/assets/model.glb'), 'utf8'), 'glb bytes')
  // the copy opens by itself and has every committed row, and not the one that was never committed
  const copy = new Database(path.join(out, 'world/db.sqlite'), { readonly: true })
  t.after(() => copy.close())
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok')
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n, 200)
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'uncommitted'").get().n, 0)
  // the live file alone, as tar used to read it, has none of them: they are still in the log
  const stale = path.join(out, 'stale.sqlite')
  fs.copyFileSync(path.join(dir, 'db.sqlite'), stale)
  const alone = new Database(stale, { readonly: true })
  t.after(() => alone.close())
  assert.throws(() => alone.prepare('SELECT COUNT(*) AS n FROM users').get(), /no such table|malformed|not a database/)
  // a second backup does not pack the first
  const second = await backupWorld({ rootDir, world, now: new Date(2026, 10, 13, 9, 5, 8), log: quiet })
  assert.ok(!tree(unpack(t, second)).some(name => name.includes('backups')))
})

test('backup: a world without a database (another database is used) is archived as it is', async t => {
  const { rootDir, world } = project(t)
  const said = []
  const file = await backupWorld({ rootDir, world, log: line => said.push(line) })
  assert.deepEqual(tree(unpack(t, file)), ['world', 'world/assets', 'world/assets/model.glb', 'world/storage.json'])
  assert.equal(said.filter(line => /holds no database/.test(line)).length, 1, 'and it says that it holds none')
})

test('backup: a database that stays locked is a failed backup, not an archive without it', async t => {
  const { rootDir, dir, world } = project(t)
  // the default journal: a writer that holds the file for itself shuts readers out
  const live = new Database(path.join(dir, 'db.sqlite'))
  t.after(() => live.close())
  live.exec('CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES (1)')
  live.exec('BEGIN EXCLUSIVE')
  await assert.rejects(backupWorld({ rootDir, world, log: quiet, busyTimeout: 50 }), /locked|busy/i)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), [], 'no archive, and no working folder')
  live.exec('COMMIT')
  const said = []
  const file = await backupWorld({ rootDir, world, log: line => said.push(line), busyTimeout: 50 })
  assert.ok(tree(unpack(t, file)).includes('world/db.sqlite'))
  assert.equal(said.filter(line => /holds no database/.test(line)).length, 0)
})

test('backup: a database written without pause fails the run when its time is up', async t => {
  const { rootDir, dir, world } = project(t)
  const live = new Database(path.join(dir, 'db.sqlite'))
  t.after(() => live.close())
  live.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, body BLOB)')
  const insert = live.prepare('INSERT INTO blobs (body) VALUES (?)')
  for (let i = 0; i < 300; i++) insert.run(Buffer.alloc(4096, i))
  // more than one step of the copy, and the time was up before the first
  assert.ok(live.pragma('page_count', { simple: true }) > 200)
  await assert.rejects(backupWorld({ rootDir, world, log: quiet, copyTimeout: -1 }), /in time/)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), [])
  const file = await backupWorld({ rootDir, world, log: quiet })
  const copy = new Database(path.join(unpack(t, file), 'world/db.sqlite'), { readonly: true })
  t.after(() => copy.close())
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM blobs').get().n, 300)
})

test('backup: the copy of the database has the database’s permissions; PostgreSQL’s database is said not to be in it', async t => {
  const { rootDir, dir, world } = project(t)
  const live = new Database(path.join(dir, 'db.sqlite'))
  live.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  live.close()
  for (const mode of [0o600, 0o640]) {
    fs.chmodSync(path.join(dir, 'db.sqlite'), mode)
    const file = await backupWorld({ rootDir, world, log: quiet, now: new Date(2026, 0, 1, 0, 0, mode & 0o77) })
    assert.equal(fs.statSync(path.join(unpack(t, file), 'world/db.sqlite')).mode & 0o777, mode)
  }
  // DB_URI: the file left in the folder is archived like any, and is not the database
  const lines = async options => {
    const said = []
    const file = await backupWorld({ rootDir, world, log: line => said.push(line), ...options })
    return { said: said.filter(line => /DB_URI|holds no database/.test(line)), names: tree(unpack(t, file)) }
  }
  const left = await lines({ postgres: true, now: new Date(2026, 1, 1) })
  assert.deepEqual(left.said, [
    'DB_URI is set: the database is in PostgreSQL and is not in this archive. Back it up by its own means.',
  ])
  assert.ok(left.names.includes('world/db.sqlite'))
  fs.rmSync(path.join(dir, 'db.sqlite'))
  const none = await lines({ postgres: true, now: new Date(2026, 1, 2) })
  assert.equal(none.said.length, 1)
  assert.match(none.said[0], /^DB_URI is set/)
  assert.ok(!none.names.includes('world/db.sqlite'))
})

test('backup: what the run makes anew is given its owner back, or says that it could not be', async t => {
  const { rootDir, dir, world } = project(t)
  const live = new Database(path.join(dir, 'db.sqlite'))
  live.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  live.close()
  // a folder of another group than new folders get here (a user may give a file to a group it is in)
  const group = process.getgroups().find(gid => gid !== fs.statSync(dir).gid)
  if (group === undefined) return t.skip('this user is in one group only')
  fs.chownSync(path.join(dir, 'assets'), process.getuid(), group)
  fs.chownSync(path.join(dir, 'db.sqlite'), process.getuid(), group)
  const given = []
  const chown = (target, uid, gid) => (given.push([path.basename(target), uid, gid]), fs.chownSync(target, uid, gid))
  await backupWorld({ rootDir, world, log: quiet, chown, now: new Date(2026, 0, 1) })
  // those two and no other: the files are the world's own (links), and the rest has the owner it would get anyway
  assert.deepEqual(given.sort(), [
    ['assets', process.getuid(), group],
    ['db.sqlite', process.getuid(), group],
  ])
  // not allowed (the run is neither the owner's nor root's): said once, and the archive is made
  const refused = () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
  }
  const said = []
  const file = await backupWorld({
    rootDir,
    world,
    log: line => said.push(line),
    chown: refused,
    now: new Date(2026, 0, 2),
  })
  assert.equal(said.filter(line => /owned by the user running this backup/.test(line)).length, 1)
  assert.ok(tree(unpack(t, file)).includes('world/db.sqlite'))
  // any other failure fails the run
  const broken = () => {
    throw Object.assign(new Error('EIO'), { code: 'EIO' })
  }
  await assert.rejects(backupWorld({ rootDir, world, log: quiet, chown: broken, now: new Date(2026, 0, 3) }), /EIO/)
})

test('backup: a backups folder that is a link is not walked into, wherever it leads', async t => {
  const { rootDir, dir, world } = project(t)
  // the archives are kept in another folder of the world: the working folder is made there, inside what is walked
  fs.mkdirSync(path.join(dir, 'cache', 'kept'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'cache', 'kept', 'note.txt'), 'x')
  fs.symlinkSync(path.join('cache', 'kept'), path.join(dir, 'backups'))
  const file = await backupWorld({ rootDir, world, log: quiet })
  assert.equal(path.dirname(file), path.join(dir, 'backups'))
  assert.deepEqual(tree(unpack(t, file)), [
    'world',
    'world/assets',
    'world/assets/model.glb',
    'world/cache',
    'world/storage.json',
  ])
  assert.deepEqual(fs.readdirSync(path.join(dir, 'cache', 'kept')).sort(), [path.basename(file), 'note.txt'])
  // and one that is the world's folder itself is refused: everything in the world would be "the backups"
  fs.rmSync(path.join(dir, 'backups'))
  fs.symlinkSync('.', path.join(dir, 'backups'))
  await assert.rejects(backupWorld({ rootDir, world, log: quiet }), /world's folder itself/)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['assets', 'backups', 'cache', 'storage.json'])
})

test('backup: the script fails with what went wrong, and speaks of tar only when tar is missing', t => {
  const script = fileURLToPath(new URL('../scripts/backup-world.mjs', import.meta.url))
  // (run from an empty folder: the script reads the .env of where it is run)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-cwd-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const env = { ...process.env, WORLD: `no-such-world-${process.pid}`, DB_URI: '' }
  // (should the script ever make it again, it is not left in the project)
  t.after(() => fs.rmSync(path.join(path.dirname(script), '..', env.WORLD), { recursive: true, force: true }))
  const run = spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Error creating backup: World directory not found/)
  assert.doesNotMatch(run.stderr, /tar is installed/)
  assert.ok(!fs.existsSync(path.join(path.dirname(script), '..', env.WORLD)), 'and the folder of that name is not made')
  // a world of the test's own, named from the project as WORLD is: the database is PostgreSQL's when DB_URI says so
  const { dir } = project(t)
  const WORLD = path.relative(path.join(path.dirname(script), '..'), dir)
  for (const [DB_URI, said] of [
    ['postgres://user@host/db', true],
    ['postgresql://user@host/db', true],
    ['', false],
    ['mysql://postgres://x', false],
  ]) {
    fs.rmSync(path.join(dir, 'backups'), { recursive: true, force: true })
    const made = spawnSync(process.execPath, [script], {
      cwd,
      env: { ...process.env, WORLD, DB_URI },
      encoding: 'utf8',
    })
    assert.equal(made.status, 0, made.stderr)
    assert.equal(/DB_URI is set/.test(made.stdout), said, DB_URI)
    assert.match(made.stdout, /Backup process completed!/)
    assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1)
  }
})

test('backup: links in the world’s folder stay links, and the files are not copied to be read', async t => {
  const { rootDir, dir, world } = project(t)
  const live = new Database(path.join(dir, 'db.sqlite'))
  t.after(() => live.close())
  live.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  fs.mkdirSync(path.join(dir, 'backups'))
  fs.writeFileSync(path.join(dir, 'backups', 'backup_2020-01-01_00-00-00.tar.gz'), 'an old archive')
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-elsewhere-'))
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }))
  fs.writeFileSync(path.join(elsewhere, 'private.txt'), 'not the world’s')
  // following these would put the live database, the old archives and another folder's files into the archive,
  // and a link to nothing or to its own folder would fail it
  const links = {
    'alias.sqlite': 'db.sqlite',
    history: 'backups',
    outside: elsewhere,
    gone: 'nothing-here',
    'assets/loop': '..',
  }
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(dir, name))
  fs.mkdirSync(path.join(dir, 'collections', 'default'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'collections', 'default', 'manifest.json'), '{}')
  const older = new Date(2021, 2, 3, 4, 5, 6)
  fs.utimesSync(path.join(dir, 'collections', 'default'), older, older)
  fs.chmodSync(path.join(dir, 'collections', 'default'), 0o550)
  fs.chmodSync(path.join(dir, 'collections'), 0o750)
  // and something that is neither a file, a folder nor a link
  execFileSync('mkfifo', [path.join(dir, 'pipe')])
  const said = []
  const linked = []
  const file = await backupWorld({
    rootDir,
    world,
    log: line => said.push(line),
    link: (from, to) => (linked.push(path.relative(dir, from)), fs.linkSync(from, to)),
  }).finally(() => fs.chmodSync(path.join(dir, 'collections', 'default'), 0o750))
  const out = unpack(t, file)
  assert.deepEqual(tree(out), [
    'world',
    'world/alias.sqlite',
    'world/assets',
    'world/assets/loop',
    'world/assets/model.glb',
    'world/collections',
    'world/collections/default',
    'world/collections/default/manifest.json',
    'world/db.sqlite',
    'world/gone',
    'world/history',
    'world/outside',
    'world/storage.json',
  ])
  for (const [name, target] of Object.entries(links)) {
    assert.equal(fs.lstatSync(path.join(out, 'world', name)).isSymbolicLink(), true, name)
    assert.equal(fs.readlinkSync(path.join(out, 'world', name)), target, name)
  }
  assert.equal(fs.statSync(path.join(out, 'world/collections')).mode & 0o777, 0o750, 'a folder keeps its permissions')
  const folder = fs.statSync(path.join(out, 'world/collections/default'))
  assert.equal(folder.mode & 0o777, 0o750, 'except that its owner can write to it')
  assert.equal(folder.mtime.getTime(), older.getTime(), 'and its time')
  assert.deepEqual(
    said.filter(line => /^Left out/.test(line)),
    [`Left out (not a file, a folder or a link): ${path.join(dir, 'pipe')}`]
  )
  // every file of the world was handed to tar as a hard link (the last one is the archive getting its name)
  assert.deepEqual(linked.slice(0, -1).sort(), [
    'assets/model.glb',
    'collections/default/manifest.json',
    'storage.json',
  ])
  assert.ok(linked.at(-1).endsWith('archive.tar.gz'))
  assert.equal(fs.statSync(path.join(dir, 'storage.json')).nlink, 1, 'and the working folder is gone')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).sort(), [
    'backup_2020-01-01_00-00-00.tar.gz',
    path.basename(file),
  ])
})

test('backup: where no hard link can be made the files are copied, and the archive is the same', async t => {
  const { rootDir, dir, world } = project(t)
  const older = new Date(2021, 2, 3, 4, 5, 6)
  fs.utimesSync(path.join(dir, 'assets', 'model.glb'), older, older)
  const refuse = code => () => {
    throw Object.assign(new Error(code), { code })
  }
  for (const [day, code] of ['EXDEV', 'EPERM'].entries()) {
    const now = new Date(2026, 1, 1 + day)
    const file = await backupWorld({ rootDir, world, log: quiet, link: refuse(code), now })
    const out = unpack(t, file)
    assert.deepEqual(tree(out), ['world', 'world/assets', 'world/assets/model.glb', 'world/storage.json'])
    assert.equal(fs.readFileSync(path.join(out, 'world/assets/model.glb'), 'utf8'), 'glb bytes')
    assert.equal(fs.statSync(path.join(out, 'world/assets/model.glb')).mtime.getTime(), older.getTime())
  }
  // any other failure is a failure: a file that went away is not papered over by a copy
  const failing = (from, to) => (from.startsWith(dir + path.sep + 'assets') ? refuse('EIO')() : fs.linkSync(from, to))
  await assert.rejects(backupWorld({ rootDir, world, log: quiet, link: failing }), /EIO/)
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter(name => name.startsWith('.')).length, 0)
})

test('backup: nothing of the world’s name is read by a shell', async t => {
  // as a shell string this name closed the quotes and ran what followed
  const marks = ['a', 'b', 'c'].map(k => `backup-shell-${process.pid}-${k}`)
  const world = `my "world" $(touch ${marks[0]}) \`touch ${marks[1]}\`; touch ${marks[2]}`
  const { rootDir } = project(t, world)
  // (a shell would make them where the script runs; should that ever happen again, they are not left there)
  t.after(() => marks.forEach(mark => fs.rmSync(mark, { force: true })))
  const file = await backupWorld({ rootDir, world, log: quiet })
  assert.deepEqual(
    marks.filter(mark => fs.existsSync(mark)),
    []
  )
  assert.ok(tree(unpack(t, file)).includes(`${world}/storage.json`))
  // nor is a name that begins with a dash read by tar as its options
  fs.mkdirSync(path.join(rootDir, '-world'))
  fs.writeFileSync(path.join(rootDir, '-world', 'storage.json'), '{}')
  for (const dashed of ['-world', './-world']) {
    const archive = await backupWorld({ rootDir, world: dashed, log: quiet, now: new Date(2026, 0, dashed.length) })
    assert.deepEqual(tree(unpack(t, archive)), ['-world', '-world/storage.json'])
  }
})

test('backup: WORLD is read as the server reads it, and one that names no folder makes nothing', async t => {
  const { rootDir, dir } = project(t)
  for (const world of ['', undefined, 'missing', 'missing/deeper', 'world/storage.json']) {
    await assert.rejects(backupWorld({ rootDir, world, log: quiet }), /WORLD|not found/, JSON.stringify(world))
  }
  // the folder of a mistyped name is not made (the backups folder used to be made first, and its parents with it)
  assert.deepEqual(fs.readdirSync(rootDir), ['world'])
  // joined, not resolved: a leading slash stays inside the project, as it does for the server
  assert.equal(worldFolder(rootDir, '/world').dir, dir)
  assert.equal(worldFolder(rootDir, 'world').name, 'world')
  assert.equal(worldFolder(rootDir, './world/').name, 'world')
  // a world in a folder of the project keeps its path in the archive
  fs.mkdirSync(path.join(rootDir, 'worlds', 'a'), { recursive: true })
  fs.writeFileSync(path.join(rootDir, 'worlds', 'a', 'storage.json'), '{}')
  const nested = await backupWorld({ rootDir, world: 'worlds/a', log: quiet })
  assert.deepEqual(tree(unpack(t, nested)), ['worlds', 'worlds/a', 'worlds/a/storage.json'])
  // (a folder whose name begins with two dots is a folder like any)
  fs.mkdirSync(path.join(rootDir, '..hidden', 'a'), { recursive: true })
  fs.writeFileSync(path.join(rootDir, '..hidden', 'a', 'storage.json'), '{}')
  const dotted = await backupWorld({ rootDir, world: '..hidden/a', log: quiet })
  assert.deepEqual(tree(unpack(t, dotted)), ['..hidden', '..hidden/a', '..hidden/a/storage.json'])
  // a world beside the project, which the server runs too, is archived under its own name
  const beside = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-beside-'))
  t.after(() => fs.rmSync(beside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(beside, 'storage.json'), '{}')
  const world = path.relative(rootDir, beside)
  assert.ok(world.startsWith('..'))
  const file = await backupWorld({ rootDir, world, log: quiet })
  assert.equal(path.dirname(file), path.join(beside, 'backups'))
  const name = path.basename(beside)
  assert.deepEqual(tree(unpack(t, file)), [name, `${name}/storage.json`])
})

test('backup: a tar that fails leaves no archive behind; the newest seven are kept', async t => {
  const { rootDir, dir, world } = project(t)
  const backups = path.join(dir, 'backups')
  // tar cannot read one of the files: it says so and fails, having written the rest
  const taken = new Date(2026, 0, 1, 0, 0, 0)
  const locked = path.join(dir, 'assets', 'locked.glb')
  fs.writeFileSync(locked, 'unreadable')
  fs.chmodSync(locked, 0o000)
  let readable = true
  try {
    fs.readFileSync(locked)
  } catch {
    readable = false
  }
  if (!readable) {
    // (as root the file is readable all the same, and there is nothing to fail)
    await assert.rejects(backupWorld({ rootDir, world, now: taken, log: quiet, stdio: 'ignore' }))
    assert.deepEqual(fs.readdirSync(backups), [], 'the archive without that file is not left as a backup')
  }
  fs.rmSync(locked, { force: true })
  // an archive of that second is there already: it is left as it is
  fs.mkdirSync(backups, { recursive: true })
  const first = path.join(backups, 'backup_2026-01-01_00-00-00.tar.gz')
  fs.writeFileSync(first, 'the first of that second')
  await assert.rejects(backupWorld({ rootDir, world, now: taken, log: quiet }), /exists already/)
  assert.equal(fs.readFileSync(first, 'utf8'), 'the first of that second')
  fs.rmSync(first)
  // ... also when it appears while this run is at work (another run of the same second), with or without hard links
  const lateBy = make => (from, to) => {
    if (to === first) fs.writeFileSync(first, 'the other run’s')
    return make(from, to)
  }
  const noLinks = (from, to) => {
    if (to !== first) return fs.linkSync(from, to)
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
  }
  for (const link of [lateBy(fs.linkSync), lateBy(noLinks)]) {
    await assert.rejects(backupWorld({ rootDir, world, now: taken, log: quiet, link }), /exists already/)
    assert.equal(fs.readFileSync(first, 'utf8'), 'the other run’s')
    fs.rmSync(first)
  }
  // without hard links the archive gets its name by a copy
  const copied = await backupWorld({ rootDir, world, now: taken, log: quiet, link: noLinks })
  assert.ok(tree(unpack(t, copied)).includes('world/storage.json'))
  fs.rmSync(copied)
  assert.deepEqual(fs.readdirSync(backups), [], 'and no working folder is left by any of these')
  // the archive just made is not the one removed, whatever the names of the others say
  for (let i = 1; i <= 7; i++) fs.writeFileSync(path.join(backups, `backup_2031-01-0${i}_00-00-00.tar.gz`), 'later')
  const early = await backupWorld({ rootDir, world, now: taken, log: quiet })
  assert.ok(fs.existsSync(early))
  assert.deepEqual(
    fs.readdirSync(backups).sort(),
    [path.basename(early), ...[2, 3, 4, 5, 6, 7].map(i => `backup_2031-01-0${i}_00-00-00.tar.gz`)],
    'and seven are kept with it, not eight'
  )
  for (const name of fs.readdirSync(backups)) fs.rmSync(path.join(backups, name))
  // a folder with an archive's name is not an archive: it neither counts nor is removed
  fs.mkdirSync(path.join(backups, 'backup_2032-01-01_00-00-00.tar.gz'))
  // ten backups, a file that is not one of them, and one whose name only looks like one
  assert.equal(BACKUPS_KEPT, 7)
  fs.writeFileSync(path.join(backups, 'notes.txt'), 'keep me')
  fs.writeFileSync(path.join(backups, 'my_backup_copy.tar.gz'), 'keep me too')
  const deleted = []
  for (let i = 0; i < 10; i++) {
    await backupWorld({
      rootDir,
      world,
      now: new Date(2026, 5, 1 + i, 12, 0, 0),
      log: line => /^Deleted/.test(line) && deleted.push(line),
    })
  }
  assert.deepEqual(fs.readdirSync(backups).sort(), [
    'backup_2026-06-04_12-00-00.tar.gz',
    'backup_2026-06-05_12-00-00.tar.gz',
    'backup_2026-06-06_12-00-00.tar.gz',
    'backup_2026-06-07_12-00-00.tar.gz',
    'backup_2026-06-08_12-00-00.tar.gz',
    'backup_2026-06-09_12-00-00.tar.gz',
    'backup_2026-06-10_12-00-00.tar.gz',
    'backup_2032-01-01_00-00-00.tar.gz',
    'my_backup_copy.tar.gz',
    'notes.txt',
  ])
  assert.equal(deleted.length, 3)
  assert.deepEqual(oldBackups(backups), [])
  assert.deepEqual(oldBackups(backups, 5), ['backup_2026-06-05_12-00-00.tar.gz', 'backup_2026-06-04_12-00-00.tar.gz'])
  // with the archive just made named, it is one of the kept: none of it, and one fewer of the others
  assert.deepEqual(oldBackups(backups, 5, 'backup_2026-06-04_12-00-00.tar.gz'), [
    'backup_2026-06-06_12-00-00.tar.gz',
    'backup_2026-06-05_12-00-00.tar.gz',
  ])
  assert.equal(oldBackups(backups, 0, 'backup_2026-06-04_12-00-00.tar.gz').length, 6)
  assert.equal(oldBackups(backups, -3, 'backup_2026-06-04_12-00-00.tar.gz').length, 6)
})
