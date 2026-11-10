// The size of an image from its first bytes, before anything decodes it. Pure (no DOM, no three.js), so the model
// checks (gltfLimits.js), the client loader and the server can share it.
//
// readImageHeader(bytes) has four outcomes:
// - { type, width, height }: a PNG, JPEG or WebP and its size;
// - { type, malformed }: one of those, but inconsistent (a second IHDR, a second JPEG frame header, a WebP frame
//   that does not match its canvas, ...). It is refused everywhere: decoders disagree about such files, so the size
//   read here would not bound what one of them decodes;
// - { type, incomplete: true }: one of those, but its size is not settled within the bytes given (a caller with only
//   the first bytes of a file reads the rest; with the whole file it is malformed);
// - null: not a format this reader knows.

// the pixels one image may have: an image this large is about 150 MB decoded (RGBA) before mipmaps; an 8192 x 4096
// sky fits. The client loader and the model checks both use this
export const MAX_IMAGE_PIXELS = 36_000_000

// the first bytes of an image read for its header; the whole image only when its size is not settled within them
// (the client loader's stand-alone images, and the data: images inside a model)
export const IMAGE_HEADER_BYTES = 256 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const ascii = (bytes, at, text) => {
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false
  return true
}
const fourcc = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
const u32be = (bytes, at) => ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]
const u32le = (bytes, at) => bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16) + ((bytes[at + 3] << 24) >>> 0)
const u24le = (bytes, at) => bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16)

// 'png', 'jpeg' or 'webp' from the signature (not from a declared type), or null for anything else
export function imageType(bytes) {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, i) => bytes[i] === value)) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp'
  return null
}

export function readImageHeader(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const type = imageType(bytes)
  if (type === 'png') return readPNG(bytes)
  if (type === 'jpeg') return readJPEG(bytes)
  if (type === 'webp') return readWebP(bytes)
  return null
}

const malformed = (type, reason) => ({ type, malformed: reason })
const incomplete = type => ({ type, incomplete: true })

// The chunks up to the first IDAT: IHDR first (13 bytes) and only once; an APNG frame (fcTL) before the image data
// must lie inside the IHDR size
function readPNG(bytes) {
  let at = 8
  let size = null
  for (;;) {
    if (at + 8 > bytes.length) return incomplete('png')
    const length = u32be(bytes, at)
    const name = fourcc(bytes, at + 4)
    if (length > 0x7fffffff) return malformed('png', 'a chunk length over 2^31')
    const data = at + 8
    if (size === null && name !== 'IHDR') return malformed('png', 'the first chunk is not IHDR')
    if (name === 'IHDR') {
      if (size !== null) return malformed('png', 'a second IHDR')
      if (length !== 13) return malformed('png', 'an IHDR that is not 13 bytes')
      if (data + 8 > bytes.length) return incomplete('png')
      size = { type: 'png', width: u32be(bytes, data), height: u32be(bytes, data + 4) }
    } else if (name === 'fcTL') {
      if (data + 20 > bytes.length) return incomplete('png')
      const [w, h, x, y] = [
        u32be(bytes, data + 4),
        u32be(bytes, data + 8),
        u32be(bytes, data + 12),
        u32be(bytes, data + 16),
      ]
      if (w === 0 || h === 0 || x + w > size.width || y + h > size.height) {
        return malformed('png', 'an APNG frame outside the image')
      }
    } else if (name === 'IDAT') {
      return size
    } else if (name === 'IEND') {
      return malformed('png', 'no image data')
    }
    at = data + length + 4
  }
}

// The segments up to the first start of scan, skipped by their length: exactly one frame header (SOF0-SOF15 but
// DHT, JPG and DAC; and DHP) must come before it. A second one, or none, is malformed.
function readJPEG(bytes) {
  let at = 2
  let frame = null
  for (;;) {
    if (at + 2 > bytes.length) return incomplete('jpeg')
    if (bytes[at] !== 0xff) return malformed('jpeg', 'a segment without a marker')
    // fill bytes before a marker
    let marker = bytes[at + 1]
    while (marker === 0xff) {
      at++
      if (at + 2 > bytes.length) return incomplete('jpeg')
      marker = bytes[at + 1]
    }
    at += 2
    // markers without a length
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd8) return malformed('jpeg', 'a second start of image')
    if (marker === 0xd9) return malformed('jpeg', 'the end before any scan')
    if (marker === 0xda) return frame || malformed('jpeg', 'a scan before any frame header')
    if (at + 2 > bytes.length) return incomplete('jpeg')
    const length = (bytes[at] << 8) | bytes[at + 1]
    if (length < 2) return malformed('jpeg', 'a segment length under 2')
    const isFrame =
      (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) || marker === 0xde
    if (isFrame) {
      if (frame) return malformed('jpeg', 'more than one frame header')
      if (at + 7 > bytes.length) return incomplete('jpeg')
      frame = {
        type: 'jpeg',
        width: (bytes[at + 5] << 8) | bytes[at + 6],
        height: (bytes[at + 3] << 8) | bytes[at + 4],
      }
    }
    at += length
  }
}

// RIFF....WEBP and its chunks. A simple file is one VP8 (lossy) or VP8L (lossless) chunk. An extended one (VP8X)
// gives the canvas; its still image (VP8/VP8L) must be the canvas's size, and every animation frame (ANMF) must lie
// inside it.
function readWebP(bytes) {
  const riffEnd = 8 + u32le(bytes, 4)
  const end = Math.min(bytes.length, riffEnd)
  let at = 12
  let canvas = null
  for (;;) {
    if (at + 8 > end) {
      // the bytes stop before the file does: later chunks (frames) are not seen yet
      if (end < riffEnd) return incomplete('webp')
      return canvas && canvas.frames > 0 ? canvas.size : malformed('webp', 'no image in the file')
    }
    const name = fourcc(bytes, at)
    const length = u32le(bytes, at + 4)
    const data = at + 8
    const image = name === 'VP8 ' ? vp8(bytes, data) : name === 'VP8L' ? vp8l(bytes, data) : undefined
    if (image === null) {
      return data + 10 > bytes.length ? incomplete('webp') : malformed('webp', 'an image chunk without its size')
    }
    if (image) {
      if (!canvas) return { type: 'webp', ...image }
      if (image.width !== canvas.size.width || image.height !== canvas.size.height) {
        return malformed('webp', 'an image that is not the canvas size')
      }
      return canvas.size
    }
    if (name === 'VP8X') {
      if (canvas) return malformed('webp', 'a second VP8X')
      if (at !== 12) return malformed('webp', 'VP8X that is not the first chunk')
      if (data + 10 > bytes.length) return incomplete('webp')
      canvas = {
        size: { type: 'webp', width: 1 + u24le(bytes, data + 4), height: 1 + u24le(bytes, data + 7) },
        frames: 0,
      }
    } else if (!canvas) {
      return malformed('webp', `the first chunk is ${JSON.stringify(name)}`)
    } else if (name === 'ANMF') {
      if (data + 16 > bytes.length) return incomplete('webp')
      const x = 2 * u24le(bytes, data)
      const y = 2 * u24le(bytes, data + 3)
      const w = 1 + u24le(bytes, data + 6)
      const h = 1 + u24le(bytes, data + 9)
      if (x + w > canvas.size.width || y + h > canvas.size.height) {
        return malformed('webp', 'an animation frame outside the canvas')
      }
      canvas.frames++
    }
    at = data + length + (length % 2)
  }
}

// the size in a VP8 (lossy) key frame: after the 3-byte frame tag and the start code, 14 bits each; null if cut
// short or without the start code
function vp8(bytes, at) {
  if (at + 10 > bytes.length || bytes[at + 3] !== 0x9d || bytes[at + 4] !== 0x01 || bytes[at + 5] !== 0x2a) return null
  return {
    width: (bytes[at + 6] | (bytes[at + 7] << 8)) & 0x3fff,
    height: (bytes[at + 8] | (bytes[at + 9] << 8)) & 0x3fff,
  }
}

// the size in a VP8L (lossless) header: the signature 0x2f, then 14 bits each, minus one
function vp8l(bytes, at) {
  if (at + 5 > bytes.length || bytes[at] !== 0x2f) return null
  const b = bytes.subarray(at + 1, at + 5)
  return { width: 1 + (b[0] | ((b[1] & 0x3f) << 8)), height: 1 + ((b[1] >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10)) }
}
