// `npm run world:backup`: one archive of the world's folder, kept beside it in <world>/backups.
// Apart from the script so that it can be run against a folder of a test's own.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'

export const BACKUPS_KEPT = 7
const DATABASE = 'db.sqlite'
// the database and what SQLite keeps beside it while it is open
const DATABASE_FILES = [DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`, `${DATABASE}-journal`]

const stamp = date => {
  const two = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}_${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`
}

// The world's folder, which must be a folder inside `rootDir` that exists: WORLD is joined to the root as the
// server joins it, and a value that leads out of it (`..`, an absolute path) is refused, as is one that names no
// folder. (The backups folder used to be made first, which made the world folder of a mistyped WORLD.)
export function worldFolder(rootDir, world) {
  if (typeof world !== 'string' || !world) throw new Error('WORLD is not set')
  const root = path.resolve(rootDir)
  const dir = path.resolve(root, world)
  const inside = path.relative(root, dir)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`WORLD must name a folder inside ${root}`)
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`World directory not found: ${dir}`)
  return { root, dir, name: inside }
}

// Makes the archive and returns its path.
// - The database goes in as a copy made through SQLite's own backup, which is one consistent state of it also while
//   the server is writing. The file itself, read by tar in the middle of a write and without what is still in its
//   write-ahead log, could be a database that does not open, or one that lacks the last changes.
// - What tar reads is a folder made for the occasion: the world's name, with a link to each thing in the world's
//   folder except the database's own files and the backups, and the copy of the database under the database's
//   name. tar follows the links (-h), so the archive holds the files, laid out as the world's folder is. (Leaving
//   the live database out by --exclude would leave the copy out too: both have the same name in the archive.)
// - tar is run with its arguments as a list, not through a shell: the world's name and the paths are not read as
//   shell text (a name with a quote or `$(...)` in it used to be).
// Not changed: the archive is kept in the world's own folder, so it is on the same disk as what it backs up and is
// lost with it. Copy it elsewhere. The other files (assets, storage.json) are read as they are at that moment, and
// a link inside the world's folder is archived as what it points to.
export async function backupWorld({
  rootDir,
  world,
  now = new Date(),
  kept = BACKUPS_KEPT,
  log = console.log,
  stdio = 'inherit',
}) {
  const { dir, name } = worldFolder(rootDir, world)
  const backupsDir = path.join(dir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const file = path.join(backupsDir, `backup_${stamp(now)}.tar.gz`)
  // a second run within the same second: the archive that is there is not written over, nor removed if this run fails
  if (fs.existsSync(file)) throw new Error(`Backup exists already: ${file}`)
  log(`Creating backup: ${path.basename(file)}`)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'world-backup-'))
  try {
    const staged = path.join(staging, name)
    fs.mkdirSync(staged, { recursive: true })
    for (const entry of fs.readdirSync(dir)) {
      if (entry === 'backups' || DATABASE_FILES.includes(entry)) continue
      fs.symlinkSync(path.join(dir, entry), path.join(staged, entry))
    }
    const database = path.join(dir, DATABASE)
    if (fs.existsSync(database)) {
      const source = new Database(database, { readonly: true, fileMustExist: true })
      try {
        await source.backup(path.join(staged, DATABASE))
      } finally {
        source.close()
      }
    }
    execFileSync('tar', ['-czhf', file, '-C', staging, name], { stdio: ['ignore', stdio, stdio] })
  } catch (err) {
    // no half-written archive is left to be taken for a backup (tar leaves one when it could not read a file)
    fs.rmSync(file, { force: true })
    throw err
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  log(`Backup created: ${path.basename(file)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB)`)
  for (const old of oldBackups(backupsDir, kept)) {
    fs.rmSync(path.join(backupsDir, old), { force: true })
    log(`Deleted old backup: ${old}`)
  }
  return file
}

// the archives beyond the `kept` newest, by the time in their names (which sorts as text), oldest last
export function oldBackups(backupsDir, kept = BACKUPS_KEPT) {
  return fs
    .readdirSync(backupsDir)
    .filter(name => /^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/.test(name))
    .sort()
    .reverse()
    .slice(kept)
}
