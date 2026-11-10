import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readImageHeader, imageType } from '../src/core/extras/imageHeader.js'
import { png, pngChunk, fcTL, jpeg, webp, anmf, gif } from './lib/imageBytes.mjs'

// The size of an image from its header bytes: PNG, JPEG and WebP. Four outcomes: a size; malformed (refused
// everywhere); incomplete within the bytes given; or not a format the reader knows (null).
const size = (type, width, height) => ({ type, width, height })

test('PNG: the IHDR size; a second IHDR, a bad chunk length or an APNG frame outside the image is malformed', () => {
  assert.deepEqual(readImageHeader(png(640, 480)), size('png', 640, 480))
  assert.deepEqual(readImageHeader(png(100000, 100000)), size('png', 100000, 100000))
  assert.deepEqual(readImageHeader(png(0, 7)), size('png', 0, 7))
  assert.deepEqual(readImageHeader(png(3, 4).buffer), size('png', 3, 4), 'an ArrayBuffer')
  // ancillary chunks before the image data are skipped; an APNG frame inside the image is fine
  assert.deepEqual(
    readImageHeader(png(64, 64, { before: [pngChunk('tEXt', new Array(5000).fill(65)), fcTL(64, 32, 0, 32)] })),
    size('png', 64, 64)
  )
  const second = png(64, 64, { before: [pngChunk('IHDR', [0, 0, 0x10, 0, 0, 0, 0x10, 0, 8, 6, 0, 0, 0])] })
  assert.deepEqual(readImageHeader(second), { type: 'png', malformed: 'a second IHDR' })
  assert.match(readImageHeader(png(64, 64, { before: [fcTL(128, 64)] })).malformed, /APNG frame outside the image/)
  assert.match(readImageHeader(png(64, 64, { before: [fcTL(32, 32, 40, 0)] })).malformed, /APNG frame outside/)
  const huge = png(64, 64)
  huge.set([0x80, 0, 0, 0], 33) // the IDAT length
  assert.match(readImageHeader(huge).malformed, /chunk length over 2\^31/)
  const first = png(64, 64)
  first.set([0x49, 0x44, 0x41, 0x54], 12) // IDAT first
  assert.match(readImageHeader(first).malformed, /first chunk is not IHDR/)
  const shortIHDR = png(64, 64)
  shortIHDR[11] = 12
  assert.match(readImageHeader(shortIHDR).malformed, /not 13 bytes/)
  assert.match(
    readImageHeader(Uint8Array.from([...png(8, 8).subarray(0, 33), ...pngChunk('IEND')])).malformed,
    /no image data/
  )
  // cut short: the reader cannot tell yet
  assert.deepEqual(readImageHeader(png(640, 480).subarray(0, 23)), { type: 'png', incomplete: true })
  assert.deepEqual(
    readImageHeader(png(640, 480, { before: [pngChunk('iCCP', new Array(9000).fill(0))] }).subarray(0, 4000)),
    {
      type: 'png',
      incomplete: true,
    }
  )
})

test('JPEG: the one frame header before the first scan; a second one, or none, is malformed', () => {
  const app0 = [0xe0, 14]
  assert.deepEqual(readImageHeader(jpeg(800, 600, { before: [app0] })), size('jpeg', 800, 600))
  assert.deepEqual(readImageHeader(jpeg(800, 600, { sof: 0xc2, before: [app0] })), size('jpeg', 800, 600))
  // EXIF (APP1) first, then a quantisation and a Huffman table (C4 is not a frame header)
  assert.deepEqual(
    readImageHeader(
      jpeg(4032, 3024, {
        before: [
          [0xe1, 5000],
          [0xdb, 67],
          [0xc4, 30],
        ],
      })
    ),
    size('jpeg', 4032, 3024)
  )
  // a frame header after several large segments (colour profiles span APP2 segments of up to 64 KiB)
  const late = jpeg(1000, 2000, {
    before: [
      [0xe1, 65000],
      [0xe2, 65000],
      [0xe2, 65000],
      [0xe2, 65000],
      [0xe2, 65000],
    ],
  })
  assert.ok(late.length > 256 * 1024)
  assert.deepEqual(readImageHeader(late), size('jpeg', 1000, 2000))
  // fill bytes before a marker
  const withFill = Uint8Array.from([0xff, 0xd8, 0xff, 0xff, ...jpeg(10, 20).subarray(2)])
  assert.deepEqual(readImageHeader(withFill), size('jpeg', 10, 20))
  // a 1 x 1 frame header in front of the real one: decoders disagree about such a file (ImageIO decoded the second)
  assert.deepEqual(
    readImageHeader(
      jpeg(2, 2, {
        frames: [
          [1, 1],
          [2, 2],
        ],
      })
    ),
    { type: 'jpeg', malformed: 'more than one frame header' }
  )
  assert.match(
    readImageHeader(
      jpeg(9000, 9000, {
        frames: [
          [1, 1],
          [9000, 9000],
        ],
      })
    ).malformed,
    /more than one frame header/
  )
  assert.match(
    readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0xff, 0xd9])).malformed,
    /scan before any frame/
  )
  assert.match(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0, 0])).malformed, /end before any scan/)
  assert.match(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0, 0])).malformed, /length under 2/)
  assert.match(
    readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0x00, 0xe1, 0, 4])).malformed,
    /without a marker/
  )
  assert.match(
    readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xd8, 0, 4, 0, 0])).malformed,
    /second start of image/
  )
  // cut short: inside a segment, or before the scan
  assert.deepEqual(readImageHeader(late.subarray(0, 100000)), { type: 'jpeg', incomplete: true })
  assert.deepEqual(readImageHeader(jpeg(10, 20).subarray(0, 8)), { type: 'jpeg', incomplete: true })
  assert.deepEqual(
    readImageHeader(jpeg(10, 20).subarray(0, 21)),
    { type: 'jpeg', incomplete: true },
    'a frame header and no scan yet'
  )
})

test('WebP: VP8, VP8L, VP8X (still and animated); an image or frame that does not match the canvas is malformed', () => {
  assert.deepEqual(readImageHeader(webp(256, 128, 'VP8 ')), size('webp', 256, 128))
  assert.deepEqual(readImageHeader(webp(16383, 16383, 'VP8 ')), size('webp', 16383, 16383))
  assert.deepEqual(readImageHeader(webp(1000, 3000, 'VP8L')), size('webp', 1000, 3000))
  assert.deepEqual(readImageHeader(webp(16384, 16384, 'VP8L')), size('webp', 16384, 16384))
  assert.deepEqual(readImageHeader(webp(4000, 3000, 'VP8X')), size('webp', 4000, 3000))
  assert.deepEqual(
    readImageHeader(webp(100000, 70000, 'animated', { frames: [[16000, 16000, 0, 0]] })),
    size('webp', 100000, 70000)
  )
  assert.deepEqual(
    readImageHeader(
      webp(64, 64, 'animated', {
        frames: [
          [32, 32, 0, 0],
          [32, 32, 32, 32],
        ],
      })
    ),
    size('webp', 64, 64)
  )
  assert.match(readImageHeader(webp(4000, 3000, 'VP8X', { image: [8000, 3000] })).malformed, /not the canvas size/)
  assert.match(
    readImageHeader(
      webp(64, 64, 'animated', {
        frames: [
          [32, 32, 0, 0],
          [64, 32, 32, 0],
        ],
      })
    ).malformed,
    /frame outside the canvas/
  )
  const noStartCode = webp(256, 128, 'VP8 ')
  noStartCode[23] = 0
  assert.match(readImageHeader(noStartCode).malformed, /without its size/)
  const alphaFirst = webp(256, 128, 'VP8 ')
  alphaFirst.set([0x41, 0x4c, 0x50, 0x48], 12) // ALPH
  assert.match(readImageHeader(alphaFirst).malformed, /first chunk is "ALPH"/)
  assert.match(readImageHeader(webp(64, 64, 'animated', { frames: [] })).malformed, /no image in the file/)
  // cut short (an animated file is read to its end: later frames are checked too)
  assert.deepEqual(readImageHeader(webp(256, 128, 'VP8 ').subarray(0, 28)), { type: 'webp', incomplete: true })
  const animated = webp(64, 64, 'animated', {
    frames: [
      [32, 32, 0, 0],
      [32, 32, 32, 32],
    ],
  })
  assert.deepEqual(readImageHeader(animated.subarray(0, animated.length - 10)), { type: 'webp', incomplete: true })
  assert.ok(anmf(2, 2))
})

test('the signature decides, not a declared type: other formats are not known (null)', () => {
  assert.equal(imageType(gif(10, 10)), null)
  assert.equal(readImageHeader(gif(10, 10)), null)
  assert.equal(readImageHeader(new TextEncoder().encode('<svg width="10" height="10"/>')), null)
  assert.equal(readImageHeader(Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0])), null) // BMP
  assert.equal(readImageHeader(new Uint8Array(0)), null)
  const riff = webp(10, 10)
  riff.set([0x41, 0x56, 0x49, 0x20], 8) // RIFF....AVI
  assert.equal(readImageHeader(riff), null)
  const almost = png(10, 10)
  almost[1] = 0x51
  assert.equal(readImageHeader(almost), null)
  assert.equal(imageType(png(1, 1)), 'png')
  assert.equal(imageType(jpeg(1, 1)), 'jpeg')
  assert.equal(imageType(webp(1, 1)), 'webp')
})
