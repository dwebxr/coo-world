import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImageBitmapLoader, TextureLoader } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { imageElementsPlugin, isAppleMobile } from '../src/core/extras/gltfImageElements.js'

const AGENTS = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  // iPadOS asking for the desktop page, and a Mac: the same user agent
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
}

test('isAppleMobile: every iPhone and iPad browser, including iPadOS desktop mode; not a Mac or Android', () => {
  assert.equal(isAppleMobile({ userAgent: AGENTS.iphoneSafari, maxTouchPoints: 5 }), true, 'Safari and Brave')
  assert.equal(isAppleMobile({ userAgent: AGENTS.iphoneChrome, maxTouchPoints: 5 }), true, 'Chrome')
  assert.equal(isAppleMobile({ userAgent: AGENTS.ipad, maxTouchPoints: 5 }), true)
  assert.equal(isAppleMobile({ userAgent: AGENTS.mac, maxTouchPoints: 5 }), true, 'iPadOS desktop mode')
  assert.equal(isAppleMobile({ userAgent: AGENTS.mac, maxTouchPoints: 0 }), false, 'a Mac')
  // a Mac with a touch-capable display reports 1 at most
  assert.equal(isAppleMobile({ userAgent: AGENTS.mac, maxTouchPoints: 1 }), false)
  assert.equal(isAppleMobile({ userAgent: AGENTS.android, maxTouchPoints: 5 }), false)
  assert.equal(isAppleMobile(undefined), false, 'no navigator')
  assert.equal(isAppleMobile({}), false)
  assert.equal(isAppleMobile({ userAgent: 42, maxTouchPoints: 'x' }), false)
})

// a glTF with nothing to load: enough for GLTFLoader to build its parser and run the plugins
const EMPTY_GLTF = JSON.stringify({ asset: { version: '2.0' } })

// the images themselves need a DOM to load; test/e2e/phone-images.mjs checks the textures a page ends up with
test('imageElementsPlugin: the parser gets an <img> loader where it would otherwise use ImageBitmaps', async () => {
  // GLTFLoader uses ImageBitmaps wherever createImageBitmap exists and the agent is not an old Safari
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'createImageBitmap')
  const saved = globalThis.createImageBitmap
  globalThis.createImageBitmap = async () => {
    throw new Error('not called: nothing is loaded')
  }
  try {
    const seen = []
    const probe = parser => {
      seen.push(parser.textureLoader)
      return { name: 'probe' }
    }
    const parse = loader => new Promise((resolve, reject) => loader.parse(EMPTY_GLTF, '', resolve, reject))

    await parse(new GLTFLoader().register(probe))
    assert.ok(seen[0] instanceof ImageBitmapLoader, 'without the plugin: ImageBitmaps')

    const loader = new GLTFLoader().register(imageElementsPlugin).register(probe)
    loader.setCrossOrigin('use-credentials')
    loader.setRequestHeader({ 'x-probe': '1' })
    await parse(loader)
    const replaced = seen[1]
    assert.ok(replaced instanceof TextureLoader, 'with the plugin: <img> elements')
    assert.equal(replaced.crossOrigin, 'use-credentials', 'keeps the loader options')
    assert.deepEqual(replaced.requestHeader, { 'x-probe': '1' })
  } finally {
    if (had) globalThis.createImageBitmap = saved
    else delete globalThis.createImageBitmap
  }
})
