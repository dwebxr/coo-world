// `npm run world:backup` (scripts/lib/backupWorld.mjs): the archive holds one consistent state of the database also
// while it is being written, nothing of the world's name is read by a shell, and a WORLD that names no folder
// makes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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
const tree = dir => fs.readdirSync(dir, { recursive: true }).map(String).sort()
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
  assert.equal(fs.lstatSync(path.join(out, 'world/storage.json')).isSymbolicLink(), false, 'files, not links to them')
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
  const file = await backupWorld({ rootDir, world, log: quiet })
  assert.deepEqual(tree(unpack(t, file)), ['world', 'world/assets', 'world/assets/model.glb', 'world/storage.json'])
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
  assert.deepEqual(fs.readdirSync(rootDir), [world])
  assert.ok(tree(unpack(t, file)).includes(`${world}/storage.json`))
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
  assert.deepEqual(
    fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('world-backup-')),
    [],
    'and no working folder'
  )
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
    'my_backup_copy.tar.gz',
    'notes.txt',
  ])
  assert.equal(deleted.length, 3)
  assert.deepEqual(oldBackups(backups), [])
  assert.deepEqual(oldBackups(backups, 5), ['backup_2026-06-05_12-00-00.tar.gz', 'backup_2026-06-04_12-00-00.tar.gz'])
})
