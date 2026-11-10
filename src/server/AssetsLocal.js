import fs from 'fs-extra'
import { statfs } from 'node:fs/promises'
import path from 'path'
import { computeAssetFilename, isUploadedAssetFilename } from './assetFilename'
import { createOnce } from './coalesce'
import { isTempName, removeTempFiles, syncDirectoryOf, writeFileAtomic } from './atomicWrite'
import { assetName } from '../core/extras/assetURL'

export class AssetsLocal {
  // `fs`: the promise API the writes use (tests inject a failing one)
  constructor({ fs: fsp } = {}) {
    this.url = process.env.ASSETS_BASE_URL
    this.dir = null
    this.fsp = fsp
    this.writes = new Map() // content filename -> the write in flight for it
    // names whose file was renamed into place but whose directory sync failed: complete, not known to be durable.
    // In memory only: after a restart the file either survived or it did not
    this.unsynced = new Set()
  }

  async init({ rootDir, worldDir }) {
    console.log('[assets] initializing')
    this.dir = path.join(worldDir, '/assets')
    // ensure assets directory exists
    await fs.ensureDir(this.dir)
    // uploads a crash cut off (their temp files); the stored assets never depend on them
    const removed = removeTempFiles(this.dir)
    if (removed) console.warn(`[assets] removed ${removed} unfinished upload${removed === 1 ? '' : 's'}`)
    // copy over built-in assets
    await fs.copy(path.join(rootDir, 'src/world/assets'), this.dir)
  }

  // resolves true when the file was written, false when the same content was already stored.
  // uploads of the same content that overlap write it once; the others are told it was already there.
  // The file appears under its name only once it is complete (temp file, fsync, rename). A stored file of another
  // size than the upload can only be a cut-off write from before that (the name is the hash of the bytes), so it
  // is replaced; one of the right size is taken as the same content without reading it, unless its own write could
  // not sync the directory: then the sync is tried again first, and fails this upload the same way if it fails again.
  async upload(file) {
    const { filename, buffer } = await computeAssetFilename(file)
    const assetPath = path.join(this.dir, filename)
    const options = this.fsOptions()
    return createOnce(this.writes, filename, async () => {
      const stored = await fs.stat(assetPath).catch(err => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (stored?.isFile() && stored.size === buffer.length) {
        await this.repairSync(filename, assetPath)
        return false
      }
      if (stored) {
        console.warn(`[assets] replacing ${filename}: ${stored.size} bytes stored, ${buffer.length} uploaded`)
      }
      try {
        await writeFileAtomic(assetPath, buffer, options)
      } catch (err) {
        if (err?.renamed) this.unsynced.add(filename)
        throw err
      }
      this.unsynced.delete(filename)
      return true
    })
  }

  fsOptions() {
    return this.fsp ? { fs: this.fsp } : undefined
  }

  // a name whose own write could not sync the directory: the sync is tried again (throws when it fails again)
  async repairSync(filename, assetPath) {
    if (!this.unsynced.has(filename)) return
    await syncDirectoryOf(assetPath, this.fsOptions())
    this.unsynced.delete(filename)
  }

  // the text of a stored asset://<name>, or null when there is no such file (cleaner: scripts' asset literals).
  // `limit`: a larger file throws TOO_LARGE before it is read
  async readText(name, { limit = Infinity } = {}) {
    if (assetName(`asset://${name}`) === null) throw new Error('invalid asset name')
    return readTextFile(path.join(this.dir, name), limit, this.fsp)
  }

  // free and total bytes of the volume holding the assets dir
  async freeSpace() {
    const s = await statfs(this.dir)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  }

  // Whether a client may skip uploading `filename` (/api/upload-check): true only for a stored file known to be
  // durable. A write of that name in flight is waited for, and a name whose directory sync failed is synced again
  // first (with the uploads of that name, one at a time); when that fails again the answer is false, as for a
  // failed write, so the client uploads and its upload tries the sync once more.
  async exists(filename) {
    // an upload still being written is not there yet
    if (isTempName(filename)) return false
    const filePath = path.join(this.dir, filename)
    try {
      await this.writes.get(filename)
    } catch {
      // that write failed: what it left (if anything) is judged below
    }
    if (this.unsynced.has(filename)) {
      try {
        await createOnce(this.writes, filename, () => this.repairSync(filename, filePath))
      } catch {
        return false
      }
      // a write of the name that ran instead of the repair may have failed its sync too
      if (this.unsynced.has(filename)) return false
    }
    return fs.exists(filePath)
  }

  async list() {
    const assets = new Set()
    const files = fs.readdirSync(this.dir)
    for (const file of files) {
      const filePath = path.join(this.dir, file)
      const isDirectory = fs.statSync(filePath).isDirectory()
      if (isDirectory) continue
      const relPath = path.relative(this.dir, filePath)
      // HACK: we only want to include uploaded assets (not core/assets/*) so we do a check
      // if its filename is a 64 character hash
      const isAsset = isUploadedAssetFilename(relPath)
      if (!isAsset) continue
      assets.add(relPath)
    }
    return assets
  }

  async delete(assets) {
    for (const asset of assets) {
      const fullPath = path.join(this.dir, asset)
      fs.removeSync(fullPath)
    }
  }

  // The clean-up's trash, beside the assets directory: <world>/assets-trash/<UTC date>/<name>. It is on the same file
  // system, so a move is a rename and the free-space guard (freeSpace, statfs of the assets directory) still measures
  // the disk it fills; nothing serves it (assetRoutes serves the assets directory) or lists it (list reads only the
  // assets directory), and uploads never write to it.
  get trashDir() {
    return path.join(path.dirname(this.dir), 'assets-trash')
  }

  // what the trash holds: name -> the date folders holding a copy, newest first
  async trashed() {
    const found = new Map()
    let days
    try {
      days = await fs.readdir(this.trashDir)
    } catch (err) {
      if (err.code === 'ENOENT') return found
      throw err
    }
    for (const day of days.filter(isTrashDay).sort().reverse()) {
      const dir = path.join(this.trashDir, day)
      if (!(await fs.stat(dir)).isDirectory()) continue
      for (const name of await fs.readdir(dir)) {
        if (!found.has(name)) found.set(name, [])
        found.get(name).push(day)
      }
    }
    return found
  }

  // the text of the newest trashed copy of `name` (`days`: from trashed()), or null when there is none
  async readTrashedText(name, days = [], { limit = Infinity } = {}) {
    if (assetName(`asset://${name}`) === null) throw new Error('invalid asset name')
    for (const day of days) {
      const text = await readTextFile(path.join(this.trashDir, day, name), limit, this.fsp)
      if (text !== null) return text
    }
    return null
  }

  // Moves `names` into the trash folder of `now`'s UTC date, replacing a copy moved there earlier the same day. A
  // name that is gone already is skipped. Resolves { moved, failed: [{ name, code }], dir }.
  async moveToTrash(names, now) {
    const dir = path.join(this.trashDir, trashDay(now))
    await fs.ensureDir(dir)
    const moved = []
    const failed = []
    for (const name of names) {
      try {
        await fs.rename(path.join(this.dir, name), path.join(dir, name))
        moved.push(name)
      } catch (err) {
        if (err.code !== 'ENOENT') failed.push({ name, code: err.code })
      }
    }
    return { moved, failed, dir }
  }

  // Puts a trashed copy of each of `names` back (`trashed`: from trashed()), trying every copy it indexed, newest
  // first, so a copy gone meanwhile leaves the next one to try. A name the store holds again stays as it is: its
  // trashed copies go with their folders. Resolves { restored, failed: [{ name, code }], lost: [name] }: `lost` are
  // the names none of whose copies was there any more.
  async restoreFromTrash(names, trashed) {
    const restored = []
    const failed = []
    const lost = []
    for (const name of names) {
      const target = path.join(this.dir, name)
      if (await fs.pathExists(target)) continue
      let done = false
      for (const day of trashed.get(name) ?? []) {
        try {
          await fs.rename(path.join(this.trashDir, day, name), target)
          restored.push(name)
          done = true
          break
        } catch (err) {
          if (err.code === 'ENOENT') continue
          failed.push({ name, code: err.code })
          done = true
          break
        }
      }
      if (!done) lost.push(name)
    }
    return { restored, failed, lost }
  }

  // The trash folders whose UTC date is at least `days` days before `now`, removed unless `dryrun`; 0 means every
  // folder, one dated after `now` (a clock that ran ahead) included. Retention counts folder dates, so a file can go
  // up to a day sooner than `days` after it was moved. Resolves { days: [<date>], files }.
  async purgeTrash(days, now, { dryrun = false } = {}) {
    const result = { days: [], files: 0 }
    let folders
    try {
      folders = await fs.readdir(this.trashDir)
    } catch (err) {
      if (err.code === 'ENOENT') return result
      throw err
    }
    for (const day of folders.filter(isTrashDay).sort()) {
      if (days > 0 && now - Date.parse(`${day}T00:00:00Z`) < days * DAY_MS) continue
      const dir = path.join(this.trashDir, day)
      result.days.push(day)
      result.files += (await fs.readdir(dir)).length
      if (!dryrun) await fs.remove(dir)
    }
    return result
  }
}

// A file's text, or null when it does not exist. Read through one open handle, counting: more than `limit` bytes
// throws TOO_LARGE as soon as byte limit + 1 is read, so a file that grows or is replaced while it is read is held
// to the limit too. `fsp`: the promise API (tests inject one).
export async function readTextFile(file, limit = Infinity, fsp = fs.promises) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  try {
    const chunks = []
    let total = 0
    const chunk = Buffer.alloc(64 * 1024)
    for (;;) {
      const room = Number.isFinite(limit) ? limit + 1 - total : chunk.length
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, room), null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > limit) throw Object.assign(new Error(`larger than ${limit} bytes`), { code: 'TOO_LARGE' })
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
    }
    return Buffer.concat(chunks, total).toString('utf8')
  } finally {
    await handle.close()
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const trashDay = now => new Date(now).toISOString().slice(0, 10)
const isTrashDay = name => /^\d{4}-\d{2}-\d{2}$/.test(name) && !Number.isNaN(Date.parse(`${name}T00:00:00Z`))
