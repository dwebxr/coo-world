// The size of an image from its first bytes, before anything decodes it. Pure (no DOM, no three.js), so the model
// checks (gltfLimits.js), the client loader and the server can share it.

// the pixels one image may have: an image this large is about 150 MB decoded (RGBA) before mipmaps; an 8192 x 4096
// sky fits. The client loader and the model checks both use this
export const MAX_IMAGE_PIXELS = 36_000_000

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const ascii = (bytes, at, text) => {
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false
  return true
}

// 'png', 'jpeg' or 'webp' from the signature (not from a declared type), or null for anything else
export function imageType(bytes) {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, i) => bytes[i] === value)) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp'
  return null
}

// { type, width, height } of a PNG, JPEG or WebP; null for any other format, or when the size is not within the
// bytes given. A Uint8Array (or an ArrayBuffer)
export function readImageHeader(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const type = imageType(bytes)
  if (type === 'png') return readPNG(bytes)
  if (type === 'jpeg') return readJPEG(bytes)
  if (type === 'webp') return readWebP(bytes)
  return null
}

// the first chunk is IHDR: width and height, big-endian, at 16 and 20
function readPNG(bytes) {
  if (bytes.length < 24 || !ascii(bytes, 12, 'IHDR')) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { type: 'png', width: view.getUint32(16), height: view.getUint32(20) }
}

// The segments after SOI, skipped by their length (APPn, EXIF first or not, DQT, DHT, ...) until a start-of-frame
// marker: SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC), so baseline, progressive and the rest. Start of scan
// or the end before any SOF is no size.
function readJPEG(bytes) {
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    // fill bytes before a marker
    let marker = bytes[at + 1]
    while (marker === 0xff && at + 2 < bytes.length) {
      at++
      marker = bytes[at + 1]
    }
    at += 2
    // markers without a length
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (marker === 0xd9 || marker === 0xda) return null
    if (at + 2 > bytes.length) return null
    const length = (bytes[at] << 8) | bytes[at + 1]
    if (length < 2) return null
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (sof) {
      if (at + 7 > bytes.length) return null
      return { type: 'jpeg', width: (bytes[at + 5] << 8) | bytes[at + 6], height: (bytes[at + 3] << 8) | bytes[at + 4] }
    }
    at += length
  }
  return null
}

// RIFF....WEBP and the first chunk: VP8 (lossy: 14-bit sizes after the start code), VP8L (lossless: 14-bit sizes
// minus one, packed) or VP8X (extended: 24-bit canvas sizes minus one)
function readWebP(bytes) {
  if (bytes.length < 30) {
    // VP8L fits in 25 bytes
    if (!(bytes.length >= 25 && ascii(bytes, 12, 'VP8L'))) return null
  }
  if (ascii(bytes, 12, 'VP8 ')) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return {
      type: 'webp',
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    }
  }
  if (ascii(bytes, 12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return null
    const b = bytes.subarray(21, 25)
    return {
      type: 'webp',
      width: 1 + (b[0] | ((b[1] & 0x3f) << 8)),
      height: 1 + ((b[1] >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10)),
    }
  }
  if (ascii(bytes, 12, 'VP8X')) {
    return {
      type: 'webp',
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    }
  }
  return null
}
