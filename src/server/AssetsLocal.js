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

  // the text of a stored asset://<name>, or null when there is no such file (cleaner: scripts' asset literals)
  async readText(name) {
    if (assetName(`asset://${name}`) === null) throw new Error('invalid asset name')
    try {
      return await fs.readFile(path.join(this.dir, name), 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
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
}
