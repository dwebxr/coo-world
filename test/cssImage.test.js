// src/core/extras/cssImage.js: the CSS value for a background image named by world data.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cssImage } from '../src/core/extras/cssImage.js'
import { resolveReference } from '../src/core/extras/assetURL.js'

const ASSETS = 'https://world.example/assets'
const BASE = 'https://world.example/'
const resolve = url => resolveReference(url, ASSETS)
const image = value => cssImage(resolve, value, BASE)

test('an asset or an http(s) URL becomes a quoted url()', () => {
  assert.equal(image('asset://abc.png'), 'url("https://world.example/assets/abc.png")')
  assert.equal(image('https://cdn.example/a.png?x=1&y=2'), 'url("https://cdn.example/a.png?x=1&y=2")')
  assert.equal(image('http://cdn.example/a.png'), 'url("http://cdn.example/a.png")')
  assert.equal(image('/local.png'), 'url("https://world.example/local.png")')
  assert.equal(image('blob:https://world.example/1b9d'), 'url("blob:https://world.example/1b9d")')
})

test('nothing in a URL ends the string: the value is one url("...") whatever the URL holds', () => {
  const hostile = [
    'https://x.example/a.png);}body{display:none}.x{background:url(https://x.example/b.png',
    'https://x.example/a.png");}body{display:none}/*',
    'https://x.example/a.png\\");}body{display:none}',
    'https://x.example/a.png\n);}body{display:none}',
    "https://x.example/a.png');}body{display:none}",
    'https://x.example/#");}body{display:none}',
    'https://x.example/?q=");}body{display:none}',
    'https://x.example/\u2028");}body{display:none}',
    'blob:https://x.example/");}body{display:none}',
    'x.example/a.png");}body{display:none}',
  ]
  for (const value of hostile) {
    const css = image(value)
    assert.match(css, /^url\("[^"\n\r\f]*"\)$/, `${JSON.stringify(value)} -> ${css}`)
    // inside the quotes a backslash only ever starts an escape of this function's own making
    const inside = css.slice(5, -2)
    assert.equal(inside.replace(/\\[0-9a-f]+ /g, '').includes('\\'), false, css)
  }
})

test('what is not an image URL is none, and nothing throws', () => {
  const none = [
    undefined,
    null,
    '',
    0,
    7,
    {},
    { url: 'x' },
    ['https://x.example/a.png'],
    'javascript:alert(1)',
    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
    'https://',
  ]
  for (const value of none) assert.equal(image(value), 'none', JSON.stringify(value))
  // (the world's resolver reads any other scheme as a host name: an https URL, which is all it can become)
  assert.equal(image('file:///etc/passwd'), 'url("https://file///etc/passwd")')
  // a scheme the resolver passes through is still refused here
  for (const value of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd']) {
    assert.equal(
      cssImage(url => url, value, BASE),
      'none',
      value
    )
  }
  // a resolver that throws (World.resolveURL does for a value that is not a string) is not a failed render
  assert.equal(
    cssImage(
      () => {
        throw new TypeError('url.startsWith is not a function')
      },
      'asset://a.png',
      BASE
    ),
    'none'
  )
  // without a page to read a relative URL against
  assert.equal(cssImage(resolve, '/local.png', undefined), 'none')
  assert.equal(cssImage(resolve, 'https://cdn.example/a.png', undefined), 'url("https://cdn.example/a.png")')
})
