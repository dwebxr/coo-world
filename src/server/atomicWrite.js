import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

// explicit `.js` imports only: this module is exercised directly by node:test

// A file being written lives under a temp name next to its final name until it is complete. The name starts with
// `~`, which the asset name rule (assetURL.js: ^[A-Za-z0-9._-]{1,128}$) and the uploaded-asset pattern never
// match: it cannot be loaded as asset://, offered by /api/upload-check, listed by the cleaner, and the /assets/
// route refuses it (uploadRoutes.js).
const TEMP_PREFIX = '~tmp-'

export function isTempName(name) {
  return typeof name === 'string' && name.startsWith(TEMP_PREFIX)
}

export function tempPathFor(file) {
  return path.join(path.dirname(file), `${TEMP_PREFIX}${randomBytes(6).toString('hex')}-${path.basename(file)}`)
}

// Writes data so that a crash at any point leaves the old file or the new one under the final name, never a part
// of either: the bytes go to a temp file in the same directory, are flushed to the disk (fsync), and the temp file
// is renamed over the final name. A failure removes the temp file and leaves the final name as it was.
// The directory is fsynced after the rename where the platform allows it, so the rename also survives a power
// loss; a directory that cannot be opened or synced does not fail the write (the data is complete on disk under
// one of the two names either way).
export async function writeFileAtomic(file, data, { fs: fsp = fs.promises } = {}) {
  const temp = tempPathFor(file)
  let handle = null
  try {
    handle = await fsp.open(temp, 'wx')
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null
    await fsp.rename(temp, file)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw err
  }
  await syncDirectory(path.dirname(file), fsp)
}

async function syncDirectory(dir, fsp) {
  let handle = null
  try {
    handle = await fsp.open(dir, 'r')
    await handle.sync()
  } catch {
    // best effort, see writeFileAtomic
  } finally {
    await handle?.close().catch(() => {})
  }
}

// Removes the temp files a crash left in dir (`match` narrows them by name). They are only ever incomplete
// copies: the final files never depend on them. Returns how many were removed.
export function removeTempFiles(dir, { match = () => true } = {}) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!isTempName(name) || !match(name)) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
      removed++
    } catch {
      // left for the next start
    }
  }
  return removed
}
