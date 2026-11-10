// Hand-built image headers for the tests: only as many bytes as a header reader needs (no pixel data).

const u16be = value => [(value >> 8) & 0xff, value & 0xff]
const u16le = value => [value & 0xff, (value >> 8) & 0xff]
const u24le = value => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]
const u32be = value => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const u32le = value => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
const text = value => [...value].map(char => char.charCodeAt(0))

// signature and IHDR chunk (the checksum is not read)
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export function png(width, height) {
  const ihdr = [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]
  return Uint8Array.from([...PNG_SIGNATURE, ...u32be(13), ...text('IHDR'), ...ihdr, 0, 0, 0, 0])
}

// SOI, the segments given ([marker, payload bytes] each), the start of frame `sof` (0xc0 baseline, 0xc2 progressive)
// and the start of scan
export function jpeg(width, height, { sof = 0xc0, before = [] } = {}) {
  const segments = before.flatMap(([marker, size]) => [0xff, marker, ...u16be(size + 2), ...new Array(size).fill(0)])
  const frame = [0xff, sof, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  return Uint8Array.from([0xff, 0xd8, ...segments, ...frame, 0xff, 0xda, ...u16be(12), ...new Array(10).fill(0)])
}

// RIFF....WEBP and its first chunk, in each of the three layouts
export function webp(width, height, layout = 'VP8 ') {
  let chunk
  if (layout === 'VP8 ') {
    chunk = [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width & 0x3fff), ...u16le(height & 0x3fff), 0, 0]
  } else if (layout === 'VP8L') {
    const w = width - 1
    const h = height - 1
    chunk = [0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x03) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f, 0]
  } else {
    chunk = [0x10, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]
  }
  const body = [...text('WEBP'), ...text(layout), ...u32le(chunk.length), ...chunk]
  return Uint8Array.from([...text('RIFF'), ...u32le(body.length), ...body])
}

export const gif = (width, height) => Uint8Array.from([...text('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0])
