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
// The directory is then fsynced, so the rename itself survives a power loss. Where the platform or filesystem cannot
// fsync a directory at all (UNSYNCABLE_DIRECTORY) that step is skipped; any other failure of it rejects: the new
// file is in place but not known to be durable, so the caller treats the write as failed and writes again.
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

// The errors that mean "a directory cannot be fsynced here", from opening it read-only or from fsync on it:
// - EISDIR: Windows, where fs.open of a directory fails (libuv opens no directory handle without backup semantics);
// - EPERM: Windows FlushFileBuffers on a directory handle (access denied), and FUSE filesystems that refuse it;
// - EINVAL: Linux and BSD filesystems that do not support fsync on a directory (some network and FUSE ones);
// - ENOTSUP / EOPNOTSUPP: filesystems that do not implement it.
// macOS (APFS, HFS+) and Linux ext4/xfs/btrfs (Fly volumes are ext4) open and fsync a directory without error.
// Everything else (EIO, ENOSPC, EDQUOT, EACCES, EMFILE, ...) is a real failure and is passed on.
export const UNSYNCABLE_DIRECTORY = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])

async function syncDirectory(dir, fsp) {
  let handle = null
  try {
    handle = await fsp.open(dir, 'r')
    await handle.sync()
  } catch (err) {
    if (!UNSYNCABLE_DIRECTORY.has(err?.code)) throw err
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
