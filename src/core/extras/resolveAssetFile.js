import path from 'path'
import { ASSET_PROTOCOL, assetName, assetRefusal } from './assetURL.js'

// The only way a URL becomes a local file path on the server: `asset://<name>` is <assetsDir>/<name>, and the
// resolved path must sit directly inside the resolved assets directory. Anything else throws (code ASSET_REFUSED)
// before a path exists to read. Node only: the server and the node agent import it, browser bundles do not.
export function resolveAssetFile(url, assetsDir) {
  if (typeof assetsDir !== 'string' || !assetsDir) throw new Error('resolveAssetFile: no assets directory')
  if (typeof url !== 'string') throw assetRefusal('not a string', url)
  if (!url.startsWith(ASSET_PROTOCOL)) throw assetRefusal('not an asset:// URL', url)
  const name = assetName(url)
  if (name === null) throw assetRefusal('invalid asset name', url)
  const dir = path.resolve(assetsDir)
  const file = path.resolve(dir, name)
  if (path.dirname(file) !== dir || path.basename(file) !== name) {
    throw assetRefusal('outside the assets directory', url)
  }
  return file
}
