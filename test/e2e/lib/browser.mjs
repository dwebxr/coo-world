// Playwright helpers: launch an engine (chromium | webkit | firefox) headless with software GL, open the
// world, collect console/page errors, and promote the browser player to admin through the chat command.
import * as playwright from 'playwright'

import { sleep } from './common.mjs'

export const ENGINES = ['chromium', 'webkit', 'firefox']

// GPU/network noise that does not indicate an application error in a headless run
const NOISE = /WebGL|GPU|swiftshader|favicon|livekit|ERR_|THREE\.WebGLRenderer|Failed to load resource/i

export async function launchBrowser(engine) {
  if (!ENGINES.includes(engine)) throw new Error(`unknown engine ${engine}`)
  const options = { headless: true }
  if (engine === 'chromium') {
    options.args = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist']
  }
  if (engine === 'firefox') {
    options.firefoxUserPrefs = { 'webgl.force-enabled': true }
  }
  // a local pairing with a different browser build (eg a WebKit from another Playwright version)
  const executable = process.env[`E2E_${engine.toUpperCase()}_EXECUTABLE`]
  if (executable) options.executablePath = executable
  return playwright[engine].launch(options)
}

export async function openWorld(browser, url, { viewport = { width: 1280, height: 800 }, settle = 6000 } = {}) {
  const page = await browser.newPage({ viewport })
  const consoleLines = []
  const pageErrors = []
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.sidebar', { timeout: 180000 })
  await page.waitForFunction(() => window.world?.ui?.state?.active === true, null, { timeout: 60000 })
  await sleep(settle)
  const errorLines = () => consoleLines.filter(l => l.startsWith('[error]') && !NOISE.test(l))
  return { page, consoleLines, pageErrors, errorLines }
}

export async function becomeAdmin(page, code = 'e2e') {
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement?.classList.contains('side-chatbox-input'), null, {
    timeout: 8000,
  })
  await page.keyboard.type(`/admin ${code}`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.world.entities.player?.data?.rank === 2, null, { timeout: 15000 })
  await page.evaluate(() => document.activeElement?.blur?.())
}

// installs a blueprint + app entity from the page (the player must be a builder)
export async function installApp(
  page,
  { id, script, model = 'asset://crash-block.glb', props = {}, position = [0, 0, -3] }
) {
  await page.evaluate(
    ({ id, script, model, props, position }) => {
      const w = window.world
      const bp = {
        id: `${id}-bp`,
        version: 0,
        name: id,
        image: null,
        author: null,
        url: null,
        desc: null,
        model,
        script,
        props,
        preload: false,
        public: false,
        locked: false,
        frozen: false,
        unique: false,
        scene: false,
        disabled: false,
      }
      w.blueprints.add(bp, true)
      w.entities.add(
        {
          id,
          type: 'app',
          blueprint: bp.id,
          position,
          quaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
          mover: null,
          uploader: null,
          pinned: false,
          state: {},
        },
        true
      )
    },
    { id, script, model, props, position }
  )
}

export function appState(page, id) {
  return page.evaluate(id => {
    const e = window.world.entities.get(id)
    if (!e) return null
    // is the app showing the crash block? compare the root's mesh geometries with the crash-block model's
    const crash = window.world.loader.get('model', 'asset://crash-block.glb')
    let rootIsCrashBlock = null
    if (crash && e.root) {
      const ids = new Set()
      crash.toNodes().traverse(n => {
        const geometry = n._geometry || n.geometry
        if (geometry?.uuid) ids.add(geometry.uuid)
      })
      rootIsCrashBlock = false
      e.root.traverse(n => {
        const geometry = n._geometry || n.geometry
        if (geometry?.uuid && ids.has(geometry.uuid)) rootIsCrashBlock = true
      })
    }
    return {
      building: !!e.building,
      script: !!e.script,
      error: e.scriptError?.message || null,
      state: e.data?.state ?? null,
      model: e.blueprint?.model,
      timers: e.timers?.size ?? null,
      rootMounted: !!e.root?.mounted,
      rootIsCrashBlock,
    }
  }, id)
}
