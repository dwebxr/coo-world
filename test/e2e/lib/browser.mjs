// Playwright helpers: launch an engine (chromium | webkit | firefox) headless with software GL, open the
// world, collect console/page errors, and promote the browser player to admin through the chat command.
import fs from 'node:fs'
import * as playwright from 'playwright'

import { sleep, TIMEOUT_SCALE } from './common.mjs'

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
    // headless Firefox on a Linux runner has no GPU: force WebGL on top of software WebRender
    options.firefoxUserPrefs = {
      'webgl.disabled': false,
      'webgl.force-enabled': true,
      'webgl.disable-fail-if-major-performance-caveat': true,
      'gfx.webrender.software': true,
      'gfx.webrender.all': true,
      'layers.acceleration.force-enabled': true,
      'media.autoplay.default': 0,
    }
  }
  // a local pairing with a different browser build (eg a WebKit from another Playwright version)
  const executable = process.env[`E2E_${engine.toUpperCase()}_EXECUTABLE`]
  if (executable) options.executablePath = executable
  return playwright[engine].launch(options)
}

// `onPage` receives the page and its collectors before the world is awaited, so a run that aborts while
// loading can still save them (see saveArtifacts)
export async function openWorld(browser, url, { viewport = { width: 1280, height: 800 }, settle = 6000, onPage } = {}) {
  const page = await browser.newPage({ viewport })
  const consoleLines = []
  const pageErrors = []
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => pageErrors.push(String(e)))
  const errorLines = () => consoleLines.filter(l => l.startsWith('[error]') && !NOISE.test(l))
  onPage?.({ page, consoleLines, pageErrors, errorLines })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.sidebar', { timeout: 180000 })
  await page.waitForFunction(() => window.world?.ui?.state?.active === true, null, { timeout: 60000 })
  await sleep(settle)
  return { page, consoleLines, pageErrors, errorLines }
}

// writes <prefix>-console.log, <prefix>-page-errors.log and <prefix>-final.png; safe to call after an abort
export async function saveArtifacts({ page, consoleLines = [], pageErrors = [], prefix }) {
  try {
    fs.writeFileSync(`${prefix}-console.log`, consoleLines.join('\n'))
    if (pageErrors.length) fs.writeFileSync(`${prefix}-page-errors.log`, pageErrors.join('\n'))
  } catch {
    // nothing to save
  }
  if (!page || page.isClosed()) return
  try {
    const state = await page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 500) ?? null,
      hasSidebar: !!document.querySelector('.sidebar'),
      worldActive: !!window.world?.ui?.state?.active,
      hardenReal: typeof globalThis.harden === 'function' && !globalThis.harden.isFake,
      webgl: (() => {
        try {
          const canvas = document.createElement('canvas')
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
          return gl ? String(gl.getParameter(gl.RENDERER)) : false
        } catch (err) {
          return `error: ${err?.message}`
        }
      })(),
    }))
    fs.appendFileSync(`${prefix}-console.log`, `\n[harness] page state at exit: ${JSON.stringify(state)}\n`)
  } catch (err) {
    fs.appendFileSync(`${prefix}-console.log`, `\n[harness] page state unavailable: ${err?.message}\n`)
  }
  try {
    await page.screenshot({ path: `${prefix}-final.png`, timeout: 15000 })
  } catch {
    // the page may be unresponsive
  }
}

export async function becomeAdmin(page, code = 'e2e') {
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.press('Enter')
  // software-rendered CI browsers process input and packets far slower than real time
  await page.waitForFunction(() => document.activeElement?.classList.contains('side-chatbox-input'), null, {
    timeout: 8000 * TIMEOUT_SCALE,
  })
  await page.keyboard.type(`/admin ${code}`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.world.entities.player?.data?.rank === 2, null, {
    timeout: 15000 * TIMEOUT_SCALE,
  })
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
