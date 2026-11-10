// Hand-built image headers for the tests: only as many bytes as a header reader needs (no pixel data).

const u16be = value => [(value >> 8) & 0xff, value & 0xff]
const u16le = value => [value & 0xff, (value >> 8) & 0xff]
const u24le = value => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]
const u32be = value => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const u32le = value => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
const text = value => [...value].map(char => char.charCodeAt(0))

// a PNG chunk (the checksum is not read)
export const pngChunk = (name, data = []) => [...u32be(data.length), ...text(name), ...data, 0, 0, 0, 0]

// signature, IHDR, the chunks given, an empty IDAT and IEND
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export function png(width, height, { before = [] } = {}) {
  const ihdr = pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0])
  return Uint8Array.from([...PNG_SIGNATURE, ...ihdr, ...before.flat(), ...pngChunk('IDAT'), ...pngChunk('IEND')])
}

// an APNG frame control chunk
export const fcTL = (width, height, x = 0, y = 0) =>
  pngChunk('fcTL', [...u32be(0), ...u32be(width), ...u32be(height), ...u32be(x), ...u32be(y), 0, 1, 0, 1, 0, 0])

// SOI, the segments given ([marker, payload bytes] each), the frame headers (`sof` 0xc0 baseline, 0xc2 progressive;
// `frames`: several, for a malformed file) and the start of scan
const JPEG_COMPONENTS = [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
export function jpeg(width, height, { sof = 0xc0, before = [], frames = [[width, height]] } = {}) {
  const segments = before.flatMap(([marker, size]) => [0xff, marker, ...u16be(size + 2), ...new Array(size).fill(0)])
  const headers = frames.flatMap(([w, h]) => [0xff, sof, ...u16be(17), 8, ...u16be(h), ...u16be(w), ...JPEG_COMPONENTS])
  return Uint8Array.from([0xff, 0xd8, ...segments, ...headers, 0xff, 0xda, ...u16be(12), ...new Array(10).fill(0)])
}

const riff = chunks => {
  const body = [...text('WEBP'), ...chunks.flat()]
  return Uint8Array.from([...text('RIFF'), ...u32le(body.length), ...body])
}
const webpChunk = (name, data) => [...text(name), ...u32le(data.length), ...data, ...(data.length % 2 ? [0] : [])]
// a key frame's tag and start code, then the 14-bit sizes
const VP8_START = [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a]
const vp8 = (width, height) => [...VP8_START, ...u16le(width & 0x3fff), ...u16le(height & 0x3fff), 0, 0]
const vp8l = (width, height) => {
  const w = width - 1
  const h = height - 1
  return [0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x03) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f, 0]
}
const vp8x = (width, height, flags = 0) =>
  webpChunk('VP8X', [flags, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)])
// an animation frame: offset (in pixels, even), size, and a VP8L image of that size
export const anmf = (width, height, x = 0, y = 0) => {
  const frame = [...u24le(x / 2), ...u24le(y / 2), ...u24le(width - 1), ...u24le(height - 1), 0, 0, 0, 0]
  return webpChunk('ANMF', [...frame, ...webpChunk('VP8L', vp8l(width, height))])
}

// a WebP in one of its layouts: 'VP8 ', 'VP8L', 'VP8X' (extended, with a still VP8L image of `image` size, by
// default the canvas's) or 'animated' (extended, with the frames given, by default one frame of the canvas)
export function webp(width, height, layout = 'VP8 ', options = {}) {
  const { image = [width, height], frames = [[width, height, 0, 0]] } = options
  if (layout === 'VP8 ') return riff([webpChunk('VP8 ', vp8(width, height))])
  if (layout === 'VP8L') return riff([webpChunk('VP8L', vp8l(width, height))])
  if (layout === 'VP8X') return riff([vp8x(width, height), webpChunk('VP8L', vp8l(...image))])
  const animation = webpChunk('ANIM', [0, 0, 0, 0, 0, 0])
  return riff([vp8x(width, height, 0x02), animation, ...frames.map(frame => anmf(...frame))])
}

export const gif = (width, height) => Uint8Array.from([...text('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0])
