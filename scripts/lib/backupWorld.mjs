// `npm run world:backup`: one archive of the world's folder, kept beside it in <world>/backups.
// Apart from the script so that it can be run against a folder of a test's own.
import fs from 'node:fs'
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

// The world's folder: WORLD joined to the project's folder exactly as the server joins it (src/server/index.js), so
// what is backed up is what the server runs, also for a WORLD beside the project (`../worlds/a`) and for one written
// with a leading slash (which the join keeps inside the project). It must be a folder that exists: the backups
// folder used to be made first, which made the world folder of a mistyped WORLD, and its parents with it.
// `name` is what the folder is called in the archive: its path from the project, or its own name when it is not
// inside the project (the path would start with `..`, which tar does not unpack as written).
export function worldFolder(rootDir, world) {
  if (typeof world !== 'string' || !world) throw new Error('WORLD is not set')
  const root = path.resolve(rootDir)
  const dir = path.join(root, world)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`World directory not found: ${dir}`)
  const inside = path.relative(root, dir)
  const name = !inside || inside.startsWith('..') || path.isAbsolute(inside) ? path.basename(dir) : inside
  return { root, dir, name }
}

// Lays the world's folder out again under `to`, without reading a file: folders are made, files are hard links to
// the world's files, and a link in the world's folder is a link with the same target text. `skip` names what is
// left out of the top folder. Where a hard link cannot be made (another file system below the world's folder, a
// file of another user on a system that refuses such links) the file is copied, which takes its size in space.
function stage(from, to, { skip, link, log }) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip?.(entry.name)) continue
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target)
    } else if (entry.isDirectory()) {
      stage(source, target, { link, log })
    } else if (entry.isFile()) {
      try {
        link(source, target)
      } catch (err) {
        if (!NO_LINK.includes(err?.code)) throw err
        fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE)
        const { atime, mtime } = fs.statSync(source)
        fs.utimesSync(target, atime, mtime)
      }
    } else {
      log(`Left out (not a file, a folder or a link): ${source}`)
    }
  }
  // the folder's own times and permissions, except that its owner can always write (the working folder is removed
  // afterwards): a folder its owner could not write to is in the archive as one the owner can
  const { mode, atime, mtime } = fs.statSync(from)
  fs.chmodSync(to, (mode & 0o7777) | 0o700)
  fs.utimesSync(to, atime, mtime)
}
// the errors that say "no hard link here", as opposed to a file that is gone or cannot be read
const NO_LINK = ['EXDEV', 'EPERM', 'EACCES', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']

// Makes the archive and returns its path.
// - The database (SQLite, `db.sqlite` in the world's folder) goes in as a copy made through SQLite's own backup,
//   which is one consistent state of it also while the server is writing. The file itself, read by tar in the
//   middle of a write and without what is still in a write-ahead log, could be a database that does not open, or
//   one that lacks the last changes. The copy is checked to be there: a database that stays locked for the whole
//   wait (`busyTimeout`) is reported by the library as a backup of nothing, which would be an archive without a
//   database that calls itself a success. The copy is made in steps between which the server may write; each such
//   write makes SQLite begin the copy again, so a database written without pause takes long.
//   With DB_URI (PostgreSQL) there is no `db.sqlite`: the archive then holds no database, and says so.
// - What tar reads is a working folder inside <world>/backups: the world's folder laid out again as hard links
//   (see `stage`), without the database's own files and the backups, plus the copy of the database under the
//   database's name. (Leaving the live database out by --exclude would leave the copy out too: both have the same
//   name in the archive.) It is beside the backups, so it is on the disk the archive goes to and not in the
//   system's temporary folder; it needs room for the copy of the database, uncompressed. A run that is killed
//   leaves it there (`.staging-…`, to be removed by hand); nothing in it is the world's only copy of anything.
// - tar is run with its arguments as a list, not through a shell: the world's name and the paths are not read as
//   shell text (a name with a quote or `$(...)` in it used to be), and a name that begins with `-` is not read as
//   an option. Only -c, -z, -f and -C are used, which BusyBox's tar (the Docker image's) has too.
// - The archive is written under the working folder and gets its name at the end, by a step that fails if the name
//   is taken: two runs within one second do not write over each other, and a run that fails removes only its own.
// Not changed: the archive is kept in the world's own folder, so it is on the same disk as what it backs up and is
// lost with it. Copy it elsewhere. The other files (assets, storage.json) are read as they are at that moment; a
// link inside the world's folder is archived as a link, not as what it points to.
export async function backupWorld({
  rootDir,
  world,
  now = new Date(),
  kept = BACKUPS_KEPT,
  log = console.log,
  stdio = 'inherit',
  busyTimeout = 5000,
  link = fs.linkSync,
}) {
  const { dir, name } = worldFolder(rootDir, world)
  const backupsDir = path.join(dir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const file = path.join(backupsDir, `backup_${stamp(now)}.tar.gz`)
  log(`Creating backup: ${path.basename(file)}`)
  const work = fs.mkdtempSync(path.join(backupsDir, '.staging-'))
  try {
    const tree = path.join(work, 'tree')
    const staged = path.join(tree, name)
    stage(dir, staged, { skip: entry => entry === 'backups' || DATABASE_FILES.includes(entry), link, log })
    const database = path.join(dir, DATABASE)
    if (fs.existsSync(database)) {
      // made beside the laid-out folder and moved into it when SQLite is done: SQLite keeps files of its own next
      // to a database it has open, and next to the links to the world's files is no place for them
      const copy = path.join(work, DATABASE)
      const source = new Database(database, { readonly: true, fileMustExist: true, timeout: busyTimeout })
      try {
        await source.backup(copy)
      } finally {
        source.close()
      }
      if (!fs.existsSync(copy) || !fs.statSync(copy).size) {
        throw new Error('The database was locked and was not copied. Run the backup again.')
      }
      fs.renameSync(copy, path.join(staged, DATABASE))
    } else {
      log(
        `No ${DATABASE} in the world's folder: this archive holds no database (one set by DB_URI is backed up by other means)`
      )
    }
    const archive = path.join(work, 'archive.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', tree, name.startsWith('-') ? `./${name}` : name], {
      stdio: ['ignore', stdio, stdio],
    })
    publish(archive, file, link)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
  log(`Backup created: ${path.basename(file)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB)`)
  for (const old of oldBackups(backupsDir, kept)) {
    // (not the one just made, whatever the clock said when the others were)
    if (old === path.basename(file)) continue
    fs.rmSync(path.join(backupsDir, old), { force: true })
    log(`Deleted old backup: ${old}`)
  }
  return file
}

// Gives the finished archive its name without taking the name from another: a hard link fails if the name is there,
// and so does the copy that stands in where there are no hard links.
function publish(archive, file, link) {
  try {
    link(archive, file)
  } catch (err) {
    if (err?.code === 'EEXIST') throw new Error(`Backup exists already: ${file}`)
    if (!NO_LINK.includes(err?.code)) throw err
    try {
      fs.copyFileSync(archive, file, fs.constants.COPYFILE_EXCL)
    } catch (failed) {
      if (failed?.code === 'EEXIST') throw new Error(`Backup exists already: ${file}`)
      // the name was free and is this run's: no part of an archive is left under it
      fs.rmSync(file, { force: true })
      throw failed
    }
  }
}

// the archives beyond the `kept` newest, by the time in their names (which sorts as text), oldest last
export function oldBackups(backupsDir, kept = BACKUPS_KEPT) {
  return fs
    .readdirSync(backupsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .reverse()
    .slice(kept)
}
