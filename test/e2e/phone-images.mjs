// iPhone and iPad pages load model images as <img> elements, not ImageBitmaps (WebKit can drop an <img>'s
// decoded pixels when memory runs low, not an ImageBitmap's). A Mac page with the same Safari version keeps
// three's default, ImageBitmaps, which also shows the probe can see them.
// usage: node test/e2e/phone-images.mjs --engine=chromium|webkit|firefox [--port=3131]
import path from 'node:path'

import { TIMEOUT_SCALE, arg, createResults, ensureOut, ok, waitUntil } from './lib/common.mjs'
import { launchBrowser, saveArtifacts } from './lib/browser.mjs'
import { startServer } from './lib/server.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3131))
const OUT = ensureOut()
const { record, step, finish } = createResults(`phone-images ${ENGINE}`)

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'

let server
let browser
const pages = []

// the kinds of image behind the scene's model textures (GLTFLoader marks each with the image's mime type),
// counted once per texture source
function imageKinds(page) {
  return page.evaluate(() => {
    const sources = new Map()
    window.world.stage.scene.traverse(object => {
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (!value?.isTexture || !value.userData?.mimeType || !value.source) continue
          if (!sources.has(value.source.uuid)) sources.set(value.source.uuid, value.image)
        }
      }
    })
    const kinds = { bitmaps: 0, elements: 0 }
    for (const image of sources.values()) {
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) kinds.bitmaps++
      else if (image instanceof HTMLImageElement) kinds.elements++
    }
    return kinds
  })
}

// one page at a time (several rendering pages starve each other on a slow runner): load the world, read the
// model images' kinds, save the logs and close it
async function visit(label, options, initScript) {
  const context = await browser.newContext(options)
  if (initScript) await context.addInitScript(initScript)
  const page = await context.newPage()
  const entry = { label, page, consoleLines: [], pageErrors: [] }
  pages.push(entry)
  page.on('console', m => entry.consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => entry.pageErrors.push(String(e)))
  try {
    await page.goto(server.url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.world?.ui?.state?.active === true, null, {
      timeout: 180000 * TIMEOUT_SCALE,
    })
    // the local avatar (a VRM with embedded images) is in the scene once its textures are
    let kinds
    await waitUntil(
      async () => {
        kinds = await imageKinds(page)
        return kinds.bitmaps + kinds.elements > 0
      },
      { timeout: 60000 * TIMEOUT_SCALE, message: `${label}: model images in the scene` }
    )
    const supported = await page.evaluate(() => typeof createImageBitmap === 'function')
    return { kinds, supported }
  } finally {
    await saveArtifacts({ ...entry, prefix: path.join(OUT, `phone-images-${ENGINE}-${label}`) })
    await context.close().catch(() => {})
  }
}

try {
  server = await startServer({ port: PORT, logPath: path.join(OUT, `phone-images-${ENGINE}-server.log`) })
  browser = await launchBrowser(ENGINE)
  record(true, 'server booted, browser launched')

  await step('an iPhone page (Safari user agent, touch) loads model images as <img> elements', async () => {
    const { kinds } = await visit('iphone', {
      viewport: { width: 390, height: 844 },
      userAgent: IPHONE_SAFARI,
      hasTouch: true,
    })
    ok(kinds.bitmaps === 0, `no ImageBitmaps (${JSON.stringify(kinds)})`)
    ok(kinds.elements > 0, `images present (${JSON.stringify(kinds)})`)
    return JSON.stringify(kinds)
  })

  // iPadOS asks for desktop pages with the Mac user agent; its touch points tell it apart
  await step('an iPad page in desktop mode (Mac user agent, 5 touch points) loads <img> elements too', async () => {
    const { kinds } = await visit(
      'ipad',
      { viewport: { width: 1024, height: 768 }, userAgent: MAC_SAFARI, hasTouch: true },
      () => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 })
    )
    ok(kinds.bitmaps === 0, `no ImageBitmaps (${JSON.stringify(kinds)})`)
    ok(kinds.elements > 0, `images present (${JSON.stringify(kinds)})`)
    return JSON.stringify(kinds)
  })

  await step('a Mac page with the same Safari version keeps ImageBitmaps', async () => {
    const { kinds, supported } = await visit('mac', { viewport: { width: 1280, height: 800 }, userAgent: MAC_SAFARI })
    if (!supported) return `no createImageBitmap in this engine: ${JSON.stringify(kinds)}`
    ok(kinds.bitmaps > 0, `ImageBitmaps present (${JSON.stringify(kinds)})`)
    return JSON.stringify(kinds)
  })

  await step('no page errors', async () => {
    const errors = pages.flatMap(entry => entry.pageErrors.map(error => `${entry.label}: ${error}`))
    ok(errors.length === 0, errors.slice(0, 3).join(' | '))
  })
} catch (err) {
  record(false, 'aborted', err?.stack || String(err))
} finally {
  await browser?.close().catch(() => {})
  await server?.stop()
  process.exit(finish() ? 1 : 0)
}
