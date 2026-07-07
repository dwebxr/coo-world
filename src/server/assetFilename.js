import { hashFile } from '../core/utils-server'

/**
 *
 * Compute Asset Filename
 *
 * takes an uploaded file, hashes its contents and derives the canonical
 * `${hash}.${ext}` filename used to store it. returns the buffer alongside
 * the filename so callers don't need to re-read the file.
 *
 */
export async function computeAssetFilename(file) {
  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const hash = await hashFile(buffer)
  const ext = file.name.split('.').pop().toLowerCase()
  const filename = `${hash}.${ext}`
  return { filename, buffer }
}

/**
 *
 * Is Uploaded Asset Filename
 *
 * uploaded assets are named as a 64 character sha256 hash + extension.
 * used to distinguish them from built-in assets (src/world/assets/*).
 *
 */
export function isUploadedAssetFilename(name) {
  return name.split('.')[0].length === 64
}
