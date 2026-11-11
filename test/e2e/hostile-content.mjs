// What a visitor's page does with values a node must survive (test/e2e/apps/hostile-content.js): sizes without end
// for a UI's canvas and a particle pool, texts of half a million characters, numbers the sky and Web Audio cannot
// take, an image cursor, a particle image that does not exist. The page keeps drawing, the canvases and pools stay
// inside their limits, nothing is requested for the cursor, and no error is left unhandled.
// usage: node test/e2e/hostile-content.mjs --engine=chromium|webkit|firefox [--port=3137]
import path from 'node:path'

import { APPS_DIR, TIMEOUT_SCALE, arg, createResults, ensureOut, eq, ok, sleep, waitUntil } from './lib/common.mjs'
import { appState, becomeAdmin, installApp, launchBrowser, openWorld, saveArtifacts } from './lib/browser.mjs'
import { installAsset, startServer } from './lib/server.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3137))
const OUT = ensureOut()
const PREFIX = path.join(OUT, `hostile-content-${ENGINE}`)
const { record, step, finish } = createResults(`hostile-content/${ENGINE}`)
const CURSOR_PROBE = `http://localhost:${PORT}/cursor-probe.png`

let server
let browser
let opened
const requests = []

// what the app's nodes kept, read from the engine's own nodes in the page
const nodes = page =>
  page.evaluate(() => {
    const found = {}
    window.world.entities.get('hostile').root.traverse(node => {
      found[node.id] = node
    })
    const ui = node => ({
      width: node._width,
      height: node._height,
      res: node._res,
      canvas: node.canvas ? [node.canvas.width, node.canvas.height] : null,
      context: !!node.canvasCtx,
    })
    const emitter = node => {
      let mesh = null
      window.world.stage.scene.traverse(object => {
        if (object._node === node) mesh = object
      })
      return {
        max: node._max,
        rate: node._rate,
        bursts: node._bursts.length,
        pool: mesh?.instanceMatrix.count,
        shown: mesh?.count,
      }
    }
    const fog = window.world.stage.scene.fog
    return {
      bigUI: ui(found['big-ui']),
      nanUI: ui(found['nan-ui']),
      text: { length: found['big-text']._value.length, fontSize: found['big-text']._fontSize },
      hostile: emitter(found['hostile-particles']),
      plain: emitter(found['plain-particles']),
      sky: {
        rotationY: found['hostile-sky']._rotationY,
        sunIntensity: found['hostile-sky']._sunIntensity,
        fogNear: found['hostile-sky']._fogNear,
        fogFar: found['hostile-sky']._fogFar,
        sceneRotation: window.world.stage.scene.environmentRotation.y,
        sceneFog: fog ? [fog.near, fog.far] : null,
      },
      audio: {
        volume: found['hostile-audio']._volume,
        refDistance: found['hostile-audio']._refDistance,
        maxDistance: found['hostile-audio']._maxDistance,
        rolloffFactor: found['hostile-audio']._rolloffFactor,
        coneOuterGain: found['hostile-audio']._coneOuterGain,
      },
      action: found['hostile-action']._label.length,
      cursors: [found['keyword-ui']._cursor, found['image-cursor-ui']._cursor],
    }
  })

const frame = page => page.evaluate(() => window.world.frame)
const bodyCursor = page => page.evaluate(() => document.body.style.cursor)

try {
  server = await startServer({ port: PORT, logPath: `${PREFIX}-server.log` })
  browser = await launchBrowser(ENGINE)
  opened = await openWorld(browser, server.url, {
    onPage: ({ page }) => {
      page.on('request', request => requests.push(request.url()))
    },
  })
  const { page, pageErrors } = opened
  // unhandled rejections, by the page's own event (not every engine reports them as page errors)
  await page.evaluate(() => {
    window.__rejections = []
    window.addEventListener('unhandledrejection', event => {
      window.__rejections.push(String(event.reason?.message || event.reason))
    })
  })
  await becomeAdmin(page)
  record(true, 'server booted, browser player is admin')

  await step('the app builds: no value stops its script', async () => {
    const script = installAsset(server, path.join(APPS_DIR, 'hostile-content.js'))
    await installApp(page, { id: 'hostile', script, props: { cursorProbe: CURSOR_PROBE } })
    let state
    await waitUntil(
      async () => {
        state = await appState(page, 'hostile')
        return state && !state.building && (state.script || state.error)
      },
      { timeout: 30000, message: 'the app to build' }
    )
    eq(state.error, null, 'script error')
    ok(state.script, 'script running')
    // a few seconds of frames with everything mounted: the worker has been asked for many steps by then
    await sleep(3000 * TIMEOUT_SCALE)
  })

  let kept
  await step('ui: an oversized UI has a canvas within the limits, with a drawing context', async () => {
    kept = await nodes(page)
    const { bigUI, nanUI } = kept
    eq(JSON.stringify([bigUI.width, bigUI.height, bigUI.res]), JSON.stringify([16384, 16384, 16]), 'sizes kept')
    ok(bigUI.canvas && bigUI.context, 'canvas and context made')
    const [w, h] = bigUI.canvas
    ok(w > 0 && h > 0 && w <= 4096 && h <= 4096 && w * h <= 8388608, `canvas ${w} x ${h}`)
    // NaN is the default (100, res 2); a height without end is the bound
    eq(JSON.stringify([nanUI.width, nanUI.height, nanUI.res]), JSON.stringify([100, 16384, 2]), 'NaN and Infinity')
    // 200 x 32768 layout units, drawn at an eighth
    eq(JSON.stringify(nanUI.canvas), JSON.stringify([25, 4096]), 'canvas of the tall UI')
    return `big ${w} x ${h}, nan ${nanUI.canvas.join(' x ')}`
  })

  await step('text: a text of 500,000 characters and an action label of 100,000 are cut', async () => {
    eq(kept.text.length, 10000, 'uitext value')
    eq(kept.text.fontSize, 1024, 'font size')
    eq(kept.action, 256, 'action label')
  })

  await step('particles: the pool is bounded and both emitters keep answering', async () => {
    const { hostile } = kept
    eq(JSON.stringify([hostile.max, hostile.rate, hostile.bursts]), JSON.stringify([20000, 100000, 64]), 'kept')
    eq(hostile.pool, 20000, 'instances allocated')
    // The ordinary emitter is served by the same worker: it gets particles only if the hostile emitter's steps
    // return. And those show none: its particles have no life.
    let plain
    await waitUntil(
      async () => {
        plain = (await nodes(page)).plain
        return plain.shown > 0
      },
      { timeout: 20000, message: 'the ordinary emitter to show particles' }
    )
    ok(plain.shown <= 50, `ordinary emitter shows ${plain.shown}`)
    eq((await nodes(page)).hostile.shown, 0, 'hostile emitter shows none')
    const before = plain.shown
    await sleep(1500 * TIMEOUT_SCALE)
    const after = (await nodes(page)).plain.shown
    ok(after >= before, `ordinary emitter still running (${before} -> ${after})`)
    return `ordinary emitter ${before} -> ${after} of 50`
  })

  await step('sky and audio: nothing that is not finite reaches the scene or Web Audio', async () => {
    const { sky, audio } = kept
    eq(
      JSON.stringify([sky.rotationY, sky.sunIntensity, sky.fogNear, sky.fogFar]),
      JSON.stringify([null, 1e9, null, 1e9])
    )
    ok(Number.isFinite(sky.sceneRotation), `scene rotation ${sky.sceneRotation}`)
    ok(sky.sceneFog === null || sky.sceneFog.every(Number.isFinite), `scene fog ${sky.sceneFog}`)
    eq(
      JSON.stringify(audio),
      JSON.stringify({ volume: 100, refDistance: 0, maxDistance: 0.0001, rolloffFactor: 3, coneOuterGain: 1 }),
      'audio'
    )
  })

  await step(
    'cursor: a keyword is shown; of an image cursor only its fallback keyword, and no image is fetched',
    async () => {
      eq(JSON.stringify(kept.cursors), JSON.stringify(['crosshair', 'auto']), 'kept')
      const { width, height } = page.viewportSize()
      // over the UI with the keyword: the pointer system writes it to the page
      await page.mouse.move(width * 0.25, height * 0.5)
      await waitUntil(async () => (await bodyCursor(page)) === 'crosshair', {
        timeout: 10000,
        message: 'the keyword cursor over its UI',
      })
      // over the UI that asked for `url(...), auto`: the keyword alone, so there is no image to fetch
      await page.mouse.move(width * 0.75, height * 0.5)
      await waitUntil(async () => (await bodyCursor(page)) === 'auto', {
        timeout: 10000,
        message: 'the fallback keyword over the image-cursor UI',
      })
      await sleep(1000)
      eq(await bodyCursor(page), 'auto', 'cursor over the image-cursor UI')
      const probes = requests.filter(url => url.includes('cursor-probe'))
      eq(probes.length, 0, `requests for the cursor image: ${probes.join(', ')}`)
    }
  )

  await step('the page keeps drawing', async () => {
    const before = await frame(page)
    await sleep(2000)
    const after = await frame(page)
    ok(after > before, `frames ${before} -> ${after}`)
    return `${after - before} frames in 2 s`
  })

  await step('no page errors and no unhandled rejections (the missing particle image included)', async () => {
    ok(
      requests.some(url => url.includes('no-such-particle-image')),
      'the missing particle image was asked for'
    )
    const rejections = await page.evaluate(() => window.__rejections)
    eq(rejections.length, 0, `unhandled rejections: ${rejections.slice(0, 3).join(' | ')}`)
    eq(pageErrors.length, 0, `page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
  })

  await step('server log: no crashes', async () => {
    const lines = server.lines(/unhandled|SES_UNCAUGHT|TypeError|RangeError|ReferenceError/)
    eq(lines.length, 0, lines.slice(0, 2).join(' | '))
  })
} catch (err) {
  record(false, 'aborted', err?.stack || String(err))
} finally {
  if (opened) await saveArtifacts({ ...opened, prefix: PREFIX }).catch(() => {})
  await browser?.close().catch(() => {})
  await server?.stop()
  process.exit(finish() ? 1 : 0)
}
