import { TextureLoader } from 'three'

// On an iPhone or iPad, three's GLTFLoader decodes a model's images into ImageBitmaps when the browser's user
// agent carries a Safari version (Safari, Brave), and into <img> elements when it does not (Chrome). WebKit can
// drop an <img>'s decoded pixels when memory runs low; it cannot drop an ImageBitmap's. A world's textures held
// as ImageBitmaps are enough for iOS to close the page ("A problem repeatedly occurred"), most often while the
// player is away in a wallet app. Every iOS browser runs WebKit, so all of them get the <img> path that iPhone
// Chrome already takes.

export function isAppleMobile(nav = globalThis.navigator) {
  const userAgent = typeof nav?.userAgent === 'string' ? nav.userAgent : ''
  if (/iPhone|iPad|iPod/.test(userAgent)) return true
  // iPadOS asks for desktop pages with a Mac user agent: only its touch screen tells it apart
  return /Macintosh/.test(userAgent) && Number(nav?.maxTouchPoints) > 1
}

// a GLTFLoader plugin: GLTFLoader.parse calls it right after building the parser, before anything loads
export function imageElementsPlugin(parser) {
  const loader = new TextureLoader(parser.options.manager)
  loader.setCrossOrigin(parser.options.crossOrigin)
  loader.setRequestHeader(parser.options.requestHeader)
  parser.textureLoader = loader
  return { name: 'coo_image_elements' }
}
