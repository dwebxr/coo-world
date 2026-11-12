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
  const outside = !inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)
  const name = outside ? path.basename(dir) : inside
  return { root, dir, name }
}

// Lays the world's folder out again under `to`, without reading a file: folders are made, files are hard links to
// the world's files, and a link in the world's folder is a link with the same target text. Where a hard link cannot
// be made (another file system below the world's folder, a file of another user on a system that refuses such
// links) the file is copied, which takes its size in space.
// `skip` names what is left out of the top folder; `backups` is the backups folder itself, left out wherever the
// walk meets it (it holds the working folder: a `backups` that is a link to a folder elsewhere in the world would
// lead the walk into what it is making).
function stage(from, to, { skip, backups, link, own, log }) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip?.(entry.name)) continue
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target)
    } else if (entry.isDirectory()) {
      if (sameFile(fs.statSync(source), backups)) continue
      stage(source, target, { backups, link, own, log })
    } else if (entry.isFile()) {
      try {
        link(source, target)
      } catch (err) {
        if (!NO_LINK.includes(err?.code)) throw err
        fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE)
        const stat = fs.statSync(source)
        own(target, stat)
        fs.utimesSync(target, stat.atime, stat.mtime)
      }
    } else {
      log(`Left out (not a file, a folder or a link): ${source}`)
    }
  }
  // the folder's own owner, permissions and times, except that its owner can always write (the working folder is
  // removed afterwards): a folder its owner could not write to is in the archive as one the owner can
  const stat = fs.statSync(from)
  own(to, stat)
  fs.chmodSync(to, (stat.mode & 0o7777) | 0o700)
  fs.utimesSync(to, stat.atime, stat.mtime)
}
// the errors that say "no hard link here", as opposed to a file that is gone or cannot be read
const NO_LINK = ['EXDEV', 'EPERM', 'EACCES', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

// What this run makes anew (the folders, the copy of the database, a file that could not be linked) belongs to
// whoever runs it. Run by the world's owner, that is the owner it had. Run by root, the owner is given back, so
// that an archive unpacked by root gives the world to the server's user again. Run by anyone else, it cannot be:
// said once, and the archive has that user as the owner of those.
function ownership(log, chown = fs.chownSync) {
  let told = false
  return (target, { uid, gid }) => {
    const mine = fs.statSync(target)
    if (mine.uid === uid && mine.gid === gid) return
    try {
      chown(target, uid, gid)
    } catch (err) {
      if (err?.code !== 'EPERM') throw err
      if (!told)
        log('Folders and the database are archived as owned by the user running this backup, not by their owner')
      told = true
    }
  }
}

// Makes the archive and returns its path.
// - The database (SQLite, `db.sqlite` in the world's folder) goes in as a copy made through SQLite's own backup,
//   which is one consistent state of it also while the server is writing. The file itself, read by tar in the
//   middle of a write and without what is still in a write-ahead log, could be a database that does not open, or
//   one that lacks the last changes. The copy is checked to be there: a database that stays locked for the whole
//   wait (`busyTimeout`) is reported by the library as a backup of nothing, which would be an archive without a
//   database that calls itself a success. The copy is made in steps between which the server may write; each such
//   write makes SQLite begin again, so a large database written without pause might never be done: after
//   `copyTimeout` the run fails. The copy has the permissions and, where it can be given, the owner of the
//   database.
//   With DB_URI (PostgreSQL, `postgres`) the world's database is not in the folder and not in the archive, which is
//   said; a `db.sqlite` left there from before is archived like any, and is not that database.
// - What tar reads is a working folder inside <world>/backups: the world's folder laid out again as hard links
//   (see `stage`), without the database's own files and the backups, plus the copy of the database under the
//   database's name. (Leaving the live database out by --exclude would leave the copy out too: both have the same
//   name in the archive.) It is beside the backups, so it is on the disk the archive goes to and not in the
//   system's temporary folder; it needs room for the copy of the database, uncompressed. A run that is killed
//   leaves it there (`.staging-…`, to be removed by hand); nothing in it is the world's only copy of anything.
// - tar is run with its arguments as a list, not through a shell: the world's name and the paths are not read as
//   shell text (a name with a quote or `$(...)` in it used to be), and a name that begins with `-` is not read as
//   an option. Only -c, -z, -f and -C are used, which BusyBox's tar (the Docker image's) has too.
// - The archive is written under the working folder and gets its name at the end (`publish`): a run that fails, or
//   is killed, leaves no part of an archive under a backup's name. (One that fails after that step, while removing
//   the working folder, leaves a whole one.)
// Not changed: the archive is kept in the world's own folder, so it is on the same disk as what it backs up and is
// lost with it. Copy it elsewhere. The other files (assets, storage.json) are read as they are at that moment; a
// link inside the world's folder is archived as a link, not as what it points to.
// One run at a time: a second run at work on the same world makes links to the files the first is reading, which
// an older GNU tar (before 1.35) reports as files that changed, and fails.
export async function backupWorld({
  rootDir,
  world,
  postgres = false,
  now = new Date(),
  kept = BACKUPS_KEPT,
  log = console.log,
  stdio = 'inherit',
  busyTimeout = 5000,
  copyTimeout = 10 * 60 * 1000,
  link = fs.linkSync,
  chown = fs.chownSync,
}) {
  const { dir, name } = worldFolder(rootDir, world)
  const backupsDir = path.join(dir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const backups = fs.statSync(backupsDir)
  if (sameFile(backups, fs.statSync(dir))) throw new Error(`${backupsDir} is the world's folder itself`)
  const file = path.join(backupsDir, `backup_${stamp(now)}.tar.gz`)
  log(`Creating backup: ${path.basename(file)}`)
  if (postgres)
    log('DB_URI is set: the database is in PostgreSQL and is not in this archive. Back it up by its own means.')
  const own = ownership(log, chown)
  const work = fs.mkdtempSync(path.join(backupsDir, '.staging-'))
  let failed = true
  try {
    const tree = path.join(work, 'tree')
    const staged = path.join(tree, name)
    const skip = entry => entry === 'backups' || DATABASE_FILES.includes(entry)
    stage(dir, staged, { skip, backups, link, own, log })
    const database = path.join(dir, DATABASE)
    if (fs.existsSync(database)) {
      // made beside the laid-out folder and moved into it when SQLite is done: SQLite keeps files of its own next
      // to a database it has open, and next to the links to the world's files is no place for them
      const copy = path.join(work, DATABASE)
      const until = Date.now() + copyTimeout
      const source = new Database(database, { readonly: true, fileMustExist: true, timeout: busyTimeout })
      try {
        await source.backup(copy, {
          progress() {
            if (Date.now() > until)
              throw new Error('The database was written too often to be copied in time. Run the backup again.')
            return 100 // pages a step, the library's own pace
          },
        })
      } finally {
        source.close()
      }
      if (!fs.existsSync(copy) || !fs.statSync(copy).size) {
        throw new Error('The database was locked and was not copied. Run the backup again.')
      }
      const stat = fs.statSync(database)
      own(copy, stat)
      fs.chmodSync(copy, stat.mode & 0o7777)
      fs.renameSync(copy, path.join(staged, DATABASE))
    } else if (!postgres) {
      log(`No ${DATABASE} in the world's folder: this archive holds no database`)
    }
    const archive = path.join(work, 'archive.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', tree, name.startsWith('-') ? `./${name}` : name], {
      stdio: ['ignore', stdio, stdio],
    })
    publish(archive, file, link)
    failed = false
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true })
    } catch (err) {
      // (said, and not thrown in place of what failed the run; by itself it fails the run)
      log(`The working folder could not be removed (${err?.message}): remove ${work} by hand`)
      if (!failed) throw err
    }
  }
  log(`Backup created: ${path.basename(file)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB)`)
  for (const old of oldBackups(backupsDir, kept, path.basename(file))) {
    fs.rmSync(path.join(backupsDir, old), { force: true })
    log(`Deleted old backup: ${old}`)
  }
  return file
}

// Gives the finished archive its name. A hard link fails if the name is there, so two runs within one second do not
// write over each other. Where there are no hard links: a look and a rename. The rename puts a whole archive under
// the name or nothing; between two runs of the same second it can put one whole archive in the place of the other.
function publish(archive, file, link) {
  try {
    link(archive, file)
  } catch (err) {
    if (err?.code === 'EEXIST') throw new Error(`Backup exists already: ${file}`)
    if (!NO_LINK.includes(err?.code)) throw err
    if (fs.existsSync(file)) throw new Error(`Backup exists already: ${file}`)
    fs.renameSync(archive, file)
  }
}

// The archives to remove: those beyond the `kept` newest, by the time in their names (which sorts as text), oldest
// last. `current`, the archive just made, is one of the kept whatever its name says (a clock set back).
export function oldBackups(backupsDir, kept = BACKUPS_KEPT, current = null) {
  const others = fs
    .readdirSync(backupsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/.test(entry.name))
    .map(entry => entry.name)
    .filter(name => name !== current)
    .sort()
    .reverse()
  return others.slice(Math.max(current ? kept - 1 : kept, 0))
}
