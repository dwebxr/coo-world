import { test } from 'node:test'
import assert from 'node:assert/strict'

import { wrapText } from '../src/core/extras/wrapText.js'

const ctx = { measureText: text => ({ width: [...text].length * 10 }) }

test('wrapText: keeps English words together and fits exact-width lines', () => {
  assert.deepEqual(wrapText(ctx, 'hello world again', 110), ['hello world', 'again'])
  assert.deepEqual(wrapText(ctx, 'one two three', 60), ['one', 'two', 'three'])
  assert.deepEqual(wrapText(ctx, 'hello world', 200), ['hello world'])
})

test('wrapText: wraps Japanese without spaces', () => {
  assert.deepEqual(wrapText(ctx, '日本語の文章です', 30), ['日本語', 'の文章', 'です'])
})

test('wrapText: wraps a long URL without losing characters', () => {
  const url = 'https://example.com/very/long/path'
  const lines = wrapText(ctx, url, 80)
  assert.deepEqual(lines, ['https://', 'example.', 'com/very', '/long/pa', 'th'])
  assert.equal(lines.join(''), url)
  assert.ok(lines.every(line => ctx.measureText(line).width <= 80))
})

test('wrapText: wraps mixed Japanese and English', () => {
  assert.deepEqual(wrapText(ctx, '挨拶 hello 日本語の文章です', 60), ['挨拶', 'hello', '日本語の文章', 'です'])
})

test('wrapText: splits oversized words and reuses the final line for later words', () => {
  assert.deepEqual(wrapText(ctx, 'ab abcdef x', 50), ['ab', 'abcde', 'f x'])
})

test('wrapText: hangs each prohibited line-start character on the previous line', () => {
  for (const punctuation of '、。，．,.!?！？）」』】〕〉》ーっゃゅょぁぃぅぇぉッャュョァィゥェォ') {
    assert.deepEqual(wrapText(ctx, `あい${punctuation}う`, 20), [`あい${punctuation}`, 'う'])
  }
})

test('wrapText: hangs at most one character past the edge', () => {
  assert.deepEqual(wrapText(ctx, 'あい！？う', 20), ['あい！', '？う'])
  for (const run of ['すご' + 'ー'.repeat(40), 'あ' + 'っ'.repeat(40), 'まじで' + '！'.repeat(40), 'NO' + '!'.repeat(80)]) {
    const lines = wrapText(ctx, run, 100)
    assert.equal(lines.join(''), run)
    assert.ok(lines.every(line => ctx.measureText(line).width <= 110), `${run.slice(0, 4)} stays within one hanging character`)
  }
})

test('wrapText: a word after a space moves whole to the next line, even if it starts with punctuation', () => {
  assert.deepEqual(wrapText(ctx, 'Drop a .hyp or .glb file here', 100), ['Drop a', '.hyp or', '.glb file', 'here'])
  assert.deepEqual(wrapText(ctx, 'あい 、う', 20), ['あい', '、う'])
})

test('wrapText: preserves punctuation at the beginning of the text', () => {
  assert.deepEqual(wrapText(ctx, '！あい', 20), ['！あ', 'い'])
})

test('wrapText: never splits an emoji from its skin-tone modifier', () => {
  assert.deepEqual(wrapText(ctx, 'A👍🏽B', 20), ['A', '👍🏽', 'B'])
})

test('wrapText: keeps an oversized family emoji alone on its line', () => {
  assert.deepEqual(wrapText(ctx, 'A👨‍👩‍👧‍👦B', 20), ['A', '👨‍👩‍👧‍👦', 'B'])
})

test('wrapText: never splits a combining mark from its base character', () => {
  assert.deepEqual(wrapText(ctx, 'ae\u0301b', 20), ['a', 'e\u0301', 'b'])
})

test('wrapText: keeps a single oversized grapheme on each line at narrow widths', () => {
  for (const width of [5, 0, -10]) {
    assert.deepEqual(wrapText(ctx, '日本語', width), ['日', '本', '語'])
  }
})

test('wrapText: returns one empty line for empty text', () => {
  assert.deepEqual(wrapText(ctx, '', 100), [''])
  assert.deepEqual(wrapText(ctx, '', 0), [''])
})

test('wrapText: preserves repeated spaces when they fit and terminates when they do not', () => {
  assert.deepEqual(wrapText(ctx, 'a  b', 40), ['a  b'])
  assert.deepEqual(wrapText(ctx, 'a  b', 20), ['a ', 'b'])
  assert.deepEqual(wrapText(ctx, '   ', 30), ['   '])
  assert.deepEqual(wrapText(ctx, '   ', 10), [' ', ' '])
  assert.deepEqual(wrapText(ctx, '   ', 0), [''])
  assert.deepEqual(wrapText(ctx, 'a  b', 0), ['a', 'b'])
})

test('wrapText: falls back to code points when Intl.Segmenter is unavailable', async () => {
  const original = Intl.Segmenter
  let fallback
  try {
    Intl.Segmenter = undefined
    fallback = await import('../src/core/extras/wrapText.js?fallback')
  } finally {
    Intl.Segmenter = original
  }
  assert.deepEqual(fallback.wrapText(ctx, '日本語', 20), ['日本', '語'])
  assert.deepEqual(fallback.wrapText(ctx, 'A😀B', 10), ['A', '😀', 'B'])
})
