import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readImageHeader, imageType } from '../src/core/extras/imageHeader.js'
import { png, jpeg, webp, gif } from './lib/imageBytes.mjs'

// The size of an image from its header bytes: PNG, JPEG and WebP; anything else, or a cut-short header, is null.

test('PNG: the IHDR size; a cut-short header or another first chunk is no size', () => {
  assert.deepEqual(readImageHeader(png(640, 480)), { type: 'png', width: 640, height: 480 })
  assert.deepEqual(readImageHeader(png(100000, 100000)), { type: 'png', width: 100000, height: 100000 })
  assert.deepEqual(readImageHeader(png(0, 7)), { type: 'png', width: 0, height: 7 })
  assert.equal(readImageHeader(png(640, 480).subarray(0, 23)), null)
  const other = png(640, 480)
  other.set([0x49, 0x44, 0x41, 0x54], 12) // IDAT first
  assert.equal(readImageHeader(other), null)
  assert.deepEqual(readImageHeader(png(3, 4).buffer), { type: 'png', width: 3, height: 4 }, 'an ArrayBuffer')
})

test('JPEG: the start of frame after the segments before it, baseline or progressive, EXIF first or not', () => {
  const app0 = [0xe0, 14]
  assert.deepEqual(readImageHeader(jpeg(800, 600, { before: [app0] })), { type: 'jpeg', width: 800, height: 600 })
  assert.deepEqual(readImageHeader(jpeg(800, 600, { sof: 0xc2, before: [app0] })), {
    type: 'jpeg',
    width: 800,
    height: 600,
  })
  // EXIF (APP1) first, then a quantisation and a Huffman table (C4 is not a start of frame)
  const exif = jpeg(4032, 3024, {
    before: [
      [0xe1, 5000],
      [0xdb, 67],
      [0xc4, 30],
    ],
  })
  assert.deepEqual(readImageHeader(exif), { type: 'jpeg', width: 4032, height: 3024 })
  // a start of frame after several large segments (colour profiles span APP2 segments of up to 64 KiB)
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
  assert.deepEqual(readImageHeader(late), { type: 'jpeg', width: 1000, height: 2000 })
  // fill bytes before a marker
  const filled = jpeg(10, 20)
  const withFill = Uint8Array.from([0xff, 0xd8, 0xff, 0xff, ...filled.subarray(2)])
  assert.deepEqual(readImageHeader(withFill), { type: 'jpeg', width: 10, height: 20 })
  // cut short: inside a segment, or before the start of frame's size
  assert.equal(readImageHeader(late.subarray(0, 100000)), null)
  assert.equal(readImageHeader(jpeg(10, 20).subarray(0, 8)), null)
  // a start of scan or the end before any start of frame, and a broken marker
  assert.equal(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0xff, 0xd9])), null)
  assert.equal(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0, 0])), null)
  assert.equal(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x12, 0x34, 0x56, 0x78])), null)
  assert.equal(readImageHeader(Uint8Array.from([0xff, 0xd8, 0x00, 0xe0, 0, 4, 0, 0])), null)
})

test('WebP: VP8, VP8L and VP8X; cut short or another chunk is no size', () => {
  assert.deepEqual(readImageHeader(webp(256, 128, 'VP8 ')), { type: 'webp', width: 256, height: 128 })
  assert.deepEqual(readImageHeader(webp(16383, 16383, 'VP8 ')), { type: 'webp', width: 16383, height: 16383 })
  assert.deepEqual(readImageHeader(webp(1000, 3000, 'VP8L')), { type: 'webp', width: 1000, height: 3000 })
  assert.deepEqual(readImageHeader(webp(16384, 16384, 'VP8L')), { type: 'webp', width: 16384, height: 16384 })
  assert.deepEqual(readImageHeader(webp(100000, 70000, 'VP8X')), { type: 'webp', width: 100000, height: 70000 })
  assert.equal(readImageHeader(webp(256, 128, 'VP8 ').subarray(0, 28)), null)
  assert.equal(readImageHeader(webp(256, 128, 'VP8L').subarray(0, 24)), null)
  assert.equal(readImageHeader(webp(256, 128, 'VP8X').subarray(0, 29)), null)
  const noStartCode = webp(256, 128, 'VP8 ')
  noStartCode[23] = 0
  assert.equal(readImageHeader(noStartCode), null)
  const other = webp(256, 128, 'VP8X')
  other.set([0x41, 0x4c, 0x50, 0x48], 12) // ALPH
  assert.equal(readImageHeader(other), null)
})

test('the signature decides, not a declared type: other formats and broken signatures are no size', () => {
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
