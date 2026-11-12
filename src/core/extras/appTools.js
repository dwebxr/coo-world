import { cloneDeep } from 'lodash-es'

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
// one after another within the file, is refused with a reason. What the blueprint says is not looked at here: it
// goes through the blueprint policy where it is used (ClientBuilder.addApp, the server's collections).
export async function importApp(file) {
  const invalid = why => new Error(`not a valid .hyp file: ${why}`)
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

  for (const assetInfo of header.assets) {
    if (!isRecord(assetInfo) || typeof assetInfo.url !== 'string') throw invalid('an asset has no url')
    const size = assetInfo.size
    if (!Number.isSafeInteger(size) || size < 0) throw invalid('an asset has no size')
    if (size > buffer.byteLength - position) throw invalid('an asset is longer than the file')
    const data = buffer.slice(position, position + size)
    const file = new File([data], assetInfo.url.split('/').pop(), {
      type: typeof assetInfo.mime === 'string' ? assetInfo.mime : '',
    })
    assets.push({
      type: assetInfo.type,
      url: assetInfo.url,
      file,
    })
    position += size
  }

  return {
    blueprint: header.blueprint,
    assets,
  }
}
