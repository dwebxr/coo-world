import fs from 'fs-extra'
import { statfs } from 'node:fs/promises'
import path from 'path'
import { computeAssetFilename, isUploadedAssetFilename } from './assetFilename'
import { createOnce } from './coalesce'

export class AssetsLocal {
  constructor() {
    this.url = process.env.ASSETS_BASE_URL
    this.dir = null
    this.writes = new Map() // content filename -> the write in flight for it
  }

  async init({ rootDir, worldDir }) {
    console.log('[assets] initializing')
    this.dir = path.join(worldDir, '/assets')
    // ensure assets directory exists
    await fs.ensureDir(this.dir)
    // copy over built-in assets
    await fs.copy(path.join(rootDir, 'src/world/assets'), this.dir)
  }

  // resolves true when the file was written, false when the same content was already stored.
  // uploads of the same content that overlap write it once; the others are told it was already there
  async upload(file) {
    const { filename, buffer } = await computeAssetFilename(file)
    const assetPath = path.join(this.dir, filename)
    return createOnce(this.writes, filename, async () => {
      const exists = await fs.exists(assetPath)
      if (exists) return false
      await fs.writeFile(assetPath, buffer)
      return true
    })
  }

  // free and total bytes of the volume holding the assets dir
  async freeSpace() {
    const s = await statfs(this.dir)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  }

  async exists(filename) {
    const filePath = path.join(this.dir, filename)
    const exists = await fs.exists(filePath)
    return exists
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
