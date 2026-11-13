import { cloneDeep } from 'lodash-es'
import { hashFile } from '../utils-client.js'

export async function exportApp(blueprint, resolveFile) {
  blueprint = cloneDeep(blueprint)

  // get all asset urls
  const assets = []
  if (blueprint.model) {
    assets.push({
      type: blueprint.model.endsWith('.vrm') ? 'avatar' : 'model',
      url: blueprint.model,
      file: await resolveFile(blueprint.model),
    })
  }
  if (blueprint.script) {
    assets.push({
      type: 'script',
      url: blueprint.script,
      file: await resolveFile(blueprint.script),
    })
  }
  if (blueprint.image) {
    assets.push({
      type: 'texture',
      url: blueprint.image.url,
      file: await resolveFile(blueprint.image.url),
    })
  }
  for (const key in blueprint.props) {
    const value = blueprint.props[key]
    if (value?.url) {
      assets.push({
        type: value.type,
        url: value.url,
        file: await resolveFile(value.url),
      })
    }
  }

  if (blueprint.locked) {
    blueprint.frozen = true
  }
  if (blueprint.disabled) {
    blueprint.disabled = false
  }

  const filename = `${blueprint.name || 'app'}.hyp`

  // create header
  const header = {
    blueprint,
    assets: assets.map(asset => {
      return {
        type: asset.type,
        url: asset.url,
        size: asset.file.size,
        mime: asset.file.type,
      }
    }),
  }

  // convert header to Uint8Array
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))

  // create header size prefix (4 bytes)
  const headerSize = new Uint8Array(4)
  new DataView(headerSize.buffer).setUint32(0, headerBytes.length, true)

  // combine all file data
  const fileBlobs = await Promise.all(assets.map(asset => asset.file.arrayBuffer()))

  // create final blob with header size + header + files
  const file = new File([headerSize, headerBytes, ...fileBlobs], filename, {
    type: 'application/octet-stream',
  })

  return file
}

// Reads a .hyp file: a 4 byte header size, a JSON header ({ blueprint, assets: [{ type, url, size, mime }] }) and the
// assets' bytes one after another. The file can come from anywhere (a builder drops one on the world), and the header
// was taken as it came: a `size` that was negative, not a number or longer than the file gave assets cut from the
// wrong bytes, each one possibly a copy of the whole file, and a header without a blueprint or with assets that are
// not a list failed later, somewhere else. Now a file whose header is not of that shape, or whose assets do not lie
// one after another within the file, is refused with a reason (an error with the code INVALID_HYP; the server leaves
// such a file out of its collection, see collections.js). What the blueprint says is not looked at here: it goes
// through the blueprint policy where it is used (ClientBuilder.addApp, the server's collections).
//
// Each asset comes back marked `contentAddressed`: whether its url is the address an upload of its bytes is stored
// under (CONTENT_ADDRESS). A url in that form whose hash is not the hash of the asset's bytes refuses the whole file:
// it can only be a file that puts other bytes under the address of a stored asset, or a damaged one. Any other url (a
// built-in name such as asset://ai.glb, an http(s) URL, another spelling of a store address) is kept as it is and
// marked false: nothing ties its bytes to that url, so the builder neither puts it in its loader nor uploads it
// (takeAsset), and the reference loads from its own address. Each asset in that form is hashed once, with the hash
// uploads use (WebCrypto: browsers and Node).
export const INVALID_HYP = 'INVALID_HYP'

// The address an upload of some bytes is stored under, and nothing else: asset://<sha256 of the bytes, 64 lower-case
// hex digits>.<ext>. The server names a stored upload `${sha256}.${extensionOf(name)}` (src/server/assetFilename.js),
// where extensionOf takes what follows the last dot, lower-cased, and /api/upload accepts only an extension of
// lower-case letters and digits (uploadPolicy.js isAllowedExtension); up to 63 of them keep the name a valid asset name
// (assetURL.js: at most 128 characters). No query, fragment or other form of the address: the loader files
// `asset://x.js?v=2` and `<assets URL>/x.js` under the same key as asset://x.js, so they are other spellings of it.
const CONTENT_ADDRESS = /^asset:\/\/([0-9a-f]{64})\.[a-z0-9]{1,63}$/

// The loader kinds a blueprint's assets are loaded as: its model as `model` (or `avatar` for a .vrm: App.build), its
// script as `script`, its image as `texture` (exportApp), and a file prop as its field's kind (Fields.js fileKinds:
// avatar, emote, model, texture, image, video, hdr, audio). The same kinds ClientLoader.decode reads.
export const APP_ASSET_TYPES = new Set([
  'model',
  'avatar',
  'emote',
  'script',
  'texture',
  'image',
  'video',
  'hdr',
  'audio',
])

// whether a client takes an imported asset into its loader and uploads it (ClientBuilder.addApp): one stored under the
// hash of its own bytes, of a kind a blueprint loads
export function takeAsset(asset) {
  return asset.contentAddressed === true && APP_ASSET_TYPES.has(asset.type)
}

export async function importApp(file) {
  const invalid = why => Object.assign(new Error(`not a valid .hyp file: ${why}`), { code: INVALID_HYP })
  const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

  // read as ArrayBuffer
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength < 4) throw invalid('it is too short')
  const view = new DataView(buffer)

  // read header size (first 4 bytes)
  const headerSize = view.getUint32(0, true)
  if (headerSize > buffer.byteLength - 4) throw invalid('its header is longer than the file')

  // read header
  const bytes = new Uint8Array(buffer.slice(4, 4 + headerSize))
  let header
  try {
    header = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw invalid('its header cannot be read')
  }
  if (!isRecord(header?.blueprint)) throw invalid('it has no blueprint')
  if (!Array.isArray(header.assets)) throw invalid('it has no list of assets')

  // extract files
  let position = 4 + headerSize
  const assets = []

  for (const [index, assetInfo] of header.assets.entries()) {
    if (!isRecord(assetInfo) || typeof assetInfo.url !== 'string') throw invalid('an asset has no url')
    const size = assetInfo.size
    if (!Number.isSafeInteger(size) || size < 0) throw invalid('an asset has no size')
    if (size > buffer.byteLength - position) throw invalid('an asset is longer than the file')
    const data = buffer.slice(position, position + size)
    const file = new File([data], assetInfo.url.split('/').pop(), {
      type: typeof assetInfo.mime === 'string' ? assetInfo.mime : '',
    })
    const claimed = CONTENT_ADDRESS.exec(assetInfo.url)
    if (claimed && (await hashFile(file)) !== claimed[1]) {
      throw invalid(`asset ${index + 1} (${assetInfo.url}) is not the file its address names`)
    }
    assets.push({
      type: assetInfo.type,
      url: assetInfo.url,
      file,
      contentAddressed: !!claimed,
    })
    position += size
  }

  return {
    blueprint: header.blueprint,
    assets,
  }
}
