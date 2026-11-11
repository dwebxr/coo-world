// The client's own interface against data it cannot use: a player whose avatar cannot be loaded, a pane whose render
// throws, the whole interface throwing once, and a world image whose URL carries CSS. The page keeps its interface (or
// gets it back), says what failed, and no rule of the URL's making reaches the page's styles.
// usage: node test/e2e/interface-faults.mjs --engine=chromium|webkit|firefox [--port=3139]
import path from 'node:path'

import { TIMEOUT_SCALE, arg, createResults, ensureOut, eq, ok, sleep, waitUntil } from './lib/common.mjs'
import { becomeAdmin, launchBrowser, openWorld, saveArtifacts } from './lib/browser.mjs'
import { startServer } from './lib/server.mjs'
import { WireClient } from './lib/ws.mjs'

const ENGINE = arg('engine', 'chromium')
const PORT = Number(arg('port', 3139))
const OUT = ensureOut()
const PREFIX = path.join(OUT, `interface-faults-${ENGINE}`)
const { record, step, finish } = createResults(`interface-faults/${ENGINE}`)

const BUILTIN_AVATAR = 'asset://avatar.vrm'
const MISSING_AVATAR = 'asset://does-not-exist.vrm'
// a URL that parses, and that as an unquoted url(...) ends the declaration and adds rules of its own
const HOSTILE_IMAGE = `http://localhost:${PORT}/no-image.png);}body{display:none}.e2e-injected{color:red}.x{background:url(http://localhost:${PORT}/x.png`

let server
let browser
let opened
let visitor
let second

try {
  server = await startServer({ port: PORT, logPath: `${PREFIX}-server.log` })
  browser = await launchBrowser(ENGINE)

  // a visitor who is there before the page opens, with an avatar that does not exist
  // (a player may choose an avatar as a builder, or in a world that allows custom avatars)
  visitor = await new WireClient(PORT, 'visitor').connect()
  await visitor.becomeAdmin()
  visitor.send('entityModified', { id: visitor.id, avatar: MISSING_AVATAR })
  await waitUntil(
    async () => {
      const probe = await new WireClient(PORT, 'probe').connect()
      const entity = probe.snapshot?.entities?.find(entity => entity.id === visitor.id)
      probe.close()
      return entity?.avatar === MISSING_AVATAR
    },
    { timeout: 15000, message: "the server to hold the visitor's avatar" }
  )

  opened = await openWorld(browser, server.url)
  const { page, consoleLines, pageErrors } = opened
  await page.evaluate(() => {
    window.__rejections = []
    window.addEventListener('unhandledrejection', event => {
      window.__rejections.push(String(event.reason?.message || event.reason))
    })
  })
  await becomeAdmin(page)
  record(true, 'server booted, a visitor is in the world, browser player is admin')

  await step('a player whose avatar cannot be loaded appears with the built-in avatar', async () => {
    const seen = await waitUntil(
      () =>
        page.evaluate(
          ({ id, builtin }) => {
            const player = window.world.entities.get(id)
            if (!player) return null
            const state = {
              asked: player.data.avatar,
              shown: player.avatarUrl ?? null,
              instance: !!player.avatar?.instance,
              fallback: player.avatarFallback ?? null,
            }
            return state.shown === builtin && state.instance ? state : null
          },
          { id: visitor.id, builtin: BUILTIN_AVATAR }
        ),
      { timeout: 60000, message: 'the visitor to appear with the built-in avatar' }
    )
    eq(seen.asked, MISSING_AVATAR, 'the avatar the visitor asked for')
    eq(seen.fallback, 'ready', 'the fallback is in place')
    ok(
      consoleLines.some(line => line.startsWith('[error]') && /asset request failed: HTTP 404/.test(line)),
      'the failed load is reported'
    )
    return JSON.stringify(seen)
  })

  await step(
    'a pane whose render throws shows a message; the rest of the interface stays; Retry brings it back',
    async () => {
      // the preferences pane reads world.prefs.bloom when it renders; nothing else reads it between changes
      await page.evaluate(() => {
        const prefs = window.world.prefs
        window.__bloom = Object.getOwnPropertyDescriptor(prefs, 'bloom')
        Object.defineProperty(prefs, 'bloom', {
          configurable: true,
          get() {
            throw new Error('E2E_PANE_BOOM')
          },
        })
        window.world.ui.togglePane('prefs')
      })
      // the cause is taken away again whatever happens below: left in place, the pane's message would still be on
      // the screen in the next step, which would then fail for this step's reason
      const restore = () =>
        page.evaluate(() => {
          const prefs = window.world.prefs
          if (window.__bloom) Object.defineProperty(prefs, 'bloom', window.__bloom)
          else delete prefs.bloom
          window.__bloom = undefined
        })
      const failures = () => consoleLines.filter(line => /\[ui\] the prefs pane failed to render/.test(line)).length
      const notice = page.locator('.ui-error')
      try {
        await notice.waitFor({ state: 'visible', timeout: 15000 * TIMEOUT_SCALE })
        eq(await notice.locator('.ui-error-text').textContent(), 'This panel hit an error.', 'message')
        ok(await page.locator('.sidebar').isVisible(), 'the sidebar is still there')
        ok((await page.locator('.side-chatbox-input').count()) === 1, 'the chat entry is still there')
        ok(failures() >= 1, 'the failure is reported with the name of the part')
        // A frame drawn after the failure, however long this machine takes for one: a software-rendered browser on a
        // busy CI runner can need more than a second for a frame, and "within one second" failed there with the
        // world drawing all the while.
        const before = await page.evaluate(() => window.world.frame)
        await waitUntil(() => page.evaluate(frame => window.world.frame > frame, before), {
          timeout: 30000,
          message: 'the world to draw a frame after the pane failed',
        })

        // still failing: Retry renders the pane again, it fails again (reported again) and the message is shown
        const reported = failures()
        await notice.locator('.ui-error-retry').click()
        await waitUntil(() => failures() > reported, { timeout: 15000, message: 'the retried pane to fail again' })
        await notice.waitFor({ state: 'visible', timeout: 15000 * TIMEOUT_SCALE })

        // the cause gone: Retry shows the pane
        await restore()
        await notice.locator('.ui-error-retry').click()
        await notice.waitFor({ state: 'detached', timeout: 15000 * TIMEOUT_SCALE })
        ok((await page.locator('.sidebarpane-content').count()) > 0, 'the pane is shown')
      } finally {
        await restore().catch(() => {})
        await page.evaluate(() => window.world.ui.togglePane(null)).catch(() => {})
        // the deliberate error is not a failure of this run
        pageErrors.splice(0, pageErrors.length, ...pageErrors.filter(line => !line.includes('E2E_PANE_BOOM')))
      }
    }
  )

  await step(
    'the whole interface fails once: it comes back by itself with the sidebar and the chat, not the loading screen',
    async () => {
      await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 15000 * TIMEOUT_SCALE })
      const from = consoleLines.length
      await page.evaluate(() => {
        // the loading screen is noted if it is drawn at any moment from here on
        window.__loadingSeen = false
        window.__loadingWatch = new MutationObserver(() => {
          if (document.querySelector('.loading-image')) window.__loadingSeen = true
        })
        window.__loadingWatch.observe(document.body, { childList: true, subtree: true })
        // CoreUI reads ui.reticleSuppressors in its own render and nothing else reads it: one interface state whose
        // value throws makes CoreUI itself throw, which only the boundary around the whole interface catches. The
        // state kept on world.ui is not changed, so the interface made again renders.
        const state = { ...window.world.ui.state }
        Object.defineProperty(state, 'reticleSuppressors', {
          enumerable: true,
          get() {
            throw new Error('E2E_ROOT_BOOM')
          },
        })
        window.world.emit('ui', state)
      })
      await page.locator('.coreui').waitFor({ state: 'detached', timeout: 15000 * TIMEOUT_SCALE })
      ok(
        consoleLines.slice(from).some(line => /\[ui\] the interface failed to render/.test(line)),
        'the failure is reported by the boundary around the whole interface'
      )
      const before = await page.evaluate(() => window.world.frame)
      // tried again after RETRY_DELAY_MS (3 s)
      await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 20000 * TIMEOUT_SCALE })
      await waitUntil(() => page.evaluate(frame => window.world.frame > frame, before), {
        timeout: 30000,
        message: 'the world to draw a frame after the interface failed',
      })
      eq(await page.locator('.mainchat').count(), 1, 'the chat is back')
      eq(await page.locator('.ui-error').count(), 0, 'no Reload message')
      await sleep(500)
      const seen = await page.evaluate(() => {
        window.__loadingWatch.disconnect()
        return window.__loadingSeen || !!document.querySelector('.loading-image')
      })
      ok(!seen, 'the loading screen did not come back')
      ok(await page.locator('.sidebar').isVisible(), 'the sidebar stays')
      pageErrors.splice(0, pageErrors.length, ...pageErrors.filter(line => !line.includes('E2E_ROOT_BOOM')))
    }
  )

  await step('a world image whose URL carries CSS styles nothing but its own element', async () => {
    await page.evaluate(url => {
      window.world.settings.set('image', { type: 'image', name: 'x.png', url }, true)
    }, HOSTILE_IMAGE)
    // the server has it once a new visitor's snapshot does
    await waitUntil(
      async () => {
        const probe = await new WireClient(PORT, 'probe').connect()
        const image = probe.snapshot?.settings?.image
        probe.close()
        return image?.url === HOSTILE_IMAGE
      },
      { timeout: 15000, message: 'the server to hold the image setting' }
    )
    // a new visitor's loading screen shows the image: what the page made of the URL is noted while it is up
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    second = await context.newPage()
    const errors = []
    second.on('pageerror', error => errors.push(String(error)))
    await second.addInitScript(() => {
      // every value the image element's style takes (it is `none` until the world's settings arrive)
      window.__loadingImages = []
      new MutationObserver(() => {
        for (const node of document.querySelectorAll('.loading-image')) {
          const style = node.style.backgroundImage
          if (node.__noted === style) continue
          node.__noted = style
          window.__loadingImages.push({
            style,
            declarations: node.style.length,
            bodyDisplay: getComputedStyle(document.body).display,
          })
        }
      }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    })
    // The loading screen stays until every preloaded file has arrived. Served from this machine they can all arrive,
    // and the screen go, before it has drawn with the world's settings (its updates may be drawn together on a slow
    // renderer). One file every visitor preloads (the idle emote) is held until the page has drawn the image, then
    // let go; a page that never draws it fails after a bound instead of waiting for ever.
    let held = false
    let release
    const released = new Promise(resolve => (release = resolve))
    await second.route(/\/assets\/mp-idle\.glb(\?|$)/, async route => {
      held = true
      await released
      await route.continue().catch(() => {})
    })
    try {
      await second.goto(server.url, { waitUntil: 'domcontentloaded' })
      await waitUntil(() => held, { timeout: 120000, message: 'the idle emote to be asked for (held)' })
      const drawn = await second
        .waitForFunction(() => window.__loadingImages.some(image => image.style !== 'none'), null, {
          timeout: 60000 * TIMEOUT_SCALE,
        })
        .then(
          () => true,
          () => false
        )
      release()
      ok(
        drawn,
        `the loading screen did not draw the world's image while a preloaded file was held: ${JSON.stringify(
          await second.evaluate(() => window.__loadingImages)
        )}`
      )
      // until the loading screen has gone
      await second.waitForFunction(() => !document.querySelector('.loading-image'), null, {
        timeout: 180000 * TIMEOUT_SCALE,
      })
      const state = await second.evaluate(() => {
        const injected = []
        for (const sheet of document.styleSheets) {
          let rules
          try {
            rules = sheet.cssRules
          } catch {
            continue
          }
          for (const rule of rules) {
            if (/e2e-injected/.test(rule.cssText) || /^body\s*\{\s*display:\s*none/.test(rule.cssText)) {
              injected.push(rule.cssText.slice(0, 120))
            }
          }
        }
        return {
          images: window.__loadingImages,
          injected,
          bodyDisplay: getComputedStyle(document.body).display,
        }
      })
      const shown = state.images.filter(image => image.style !== 'none')
      ok(shown.length >= 1, `the loading screen showed the image: ${JSON.stringify(state.images)}`)
      for (const image of state.images) {
        eq(image.declarations, 1, 'one declaration on the element')
        ok(image.bodyDisplay !== 'none', 'the page was not hidden while it loaded')
      }
      for (const image of shown) {
        ok(
          /^url\("http:\/\/localhost:\d+\/no-image\.png[^"]*"\)$/.test(image.style),
          `one quoted url(): ${image.style}`
        )
      }
      eq(state.injected.length, 0, `rules from the URL: ${state.injected.join(' | ')}`)
      ok(state.bodyDisplay !== 'none', 'the page is not hidden')
      eq(errors.length, 0, `page errors: ${errors.slice(0, 2).join(' | ')}`)
      return shown[0].style.slice(0, 90)
    } finally {
      release()
      await context.close().catch(() => {})
    }
  })

  await step('no unexpected page errors or unhandled rejections', async () => {
    const rejections = await page.evaluate(() => window.__rejections)
    eq(rejections.length, 0, `unhandled rejections: ${rejections.slice(0, 3).join(' | ')}`)
    eq(pageErrors.length, 0, `page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
  })
} catch (err) {
  record(false, 'aborted', err?.stack || String(err))
} finally {
  if (opened) await saveArtifacts({ ...opened, prefix: PREFIX }).catch(() => {})
  visitor?.close()
  await browser?.close().catch(() => {})
  await server?.stop()
  process.exit(finish() ? 1 : 0)
}
