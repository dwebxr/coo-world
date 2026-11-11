import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createMonacoLoader, EDITOR_UNAVAILABLE, MONACO_VS, monacoFor } from '../src/client/components/monacoLoader.js'

// A stand-in page and CDN. The loader it installs behaves as monaco-editor 0.49.0's min/vs/loader.js does where it
// matters here (read in its source):
// - when its script runs it starts only if there is no `define.amd` yet; starting, it takes a `require` that is not a
//   function as its configuration, and sets `define` (with `amd`) and `require` (with `config` and `reset`);
// - a module that failed to load is kept with its error: a later request for it gets that error at once, and nothing
//   is fetched; `reset()` forgets every module and the configuration; there is no `undef`.
// `cdn.loader` and `cdn.editor` say, one entry per fetch, whether that fetch succeeds.
function fakePage({ loader = [], editor = [] } = {}) {
  const cdn = { loader: [...loader], editor: [...editor] }
  const fetched = { loader: [], editor: [] }
  const counts = { resets: 0 }
  const monaco = { editor: { themes: [] } }
  const win = {}
  const head = {
    children: [],
    appendChild(el) {
      this.children.push(el)
      fetched.loader.push(el.src)
      setImmediate(() => {
        if (cdn.loader.shift() !== 'ok') return el.onerror?.({ type: 'error' })
        runLoaderScript()
        el.onload?.({ type: 'load' })
      })
    },
  }
  const doc = {
    head,
    createElement(tag) {
      const el = {
        tag,
        src: null,
        onload: null,
        onerror: null,
        remove() {
          const i = head.children.indexOf(el)
          if (i >= 0) head.children.splice(i, 1)
        },
      }
      return el
    },
  }
  function runLoaderScript() {
    if (typeof win.define === 'function' && win.define.amd) return
    let config = {}
    let modules = new Map()
    const require = (deps, callback, errorback) => {
      if (!Array.isArray(deps)) throw new Error('Unrecognized require call')
      const [id] = deps
      const known = modules.get(id)
      if (known) return known.error ? errorback?.(known.error) : callback()
      const url = `${config.paths?.vs ?? '.'}/${id.slice('vs/'.length)}.js`
      fetched.editor.push(url)
      setImmediate(() => {
        if (cdn.editor.shift() === 'ok' && url === `${MONACO_VS}/editor/editor.main.js`) {
          modules.set(id, {})
          win.monaco = monaco
          callback()
        } else {
          const error = Object.assign(new Error(`failed to load ${url}`), { phase: 'loading', moduleId: id })
          modules.set(id, { error })
          errorback?.(error)
        }
      })
    }
    require.config = params => {
      config = { ...config, ...params }
    }
    require.reset = () => {
      counts.resets++
      config = {}
      modules = new Map()
    }
    const define = () => {}
    define.amd = { jQuery: true }
    if (typeof win.require !== 'undefined' && typeof win.require !== 'function') require.config(win.require)
    win.define = define
    win.require = require
  }
  return { win, doc, head, cdn, fetched, counts, monaco }
}

function loaderOf(page) {
  const reports = []
  const prepared = []
  const load = createMonacoLoader({
    win: page.win,
    doc: page.doc,
    prepare: monaco => prepared.push(monaco),
    report: err => reports.push(err),
  })
  return { load, reports, prepared }
}

// a rejection nobody handles fails the test that caused it
const unhandled = []
const onUnhandled = reason => unhandled.push(reason)
before(() => process.on('unhandledRejection', onUnhandled))
after(() => process.off('unhandledRejection', onUnhandled))
const settle = () => new Promise(resolve => setImmediate(resolve))
const noUnhandled = async () => {
  await settle()
  assert.deepEqual(unhandled, [])
}

test('the loader script did not come: null and a report, then the next try fetches it again and loads', async () => {
  const page = fakePage({ loader: ['fail', 'ok'], editor: ['ok'] })
  const { load, reports, prepared } = loaderOf(page)
  assert.equal(await load(), null)
  assert.equal(reports.length, 1)
  assert.match(reports[0].message, /could not be loaded/)
  assert.equal(page.head.children.length, 0, 'the failed tag is taken out')
  assert.equal(await load(), page.monaco)
  assert.deepEqual(page.fetched.loader, [`${MONACO_VS}/loader.js`, `${MONACO_VS}/loader.js`])
  assert.equal(page.head.children.length, 1, 'one loader script on the page')
  assert.deepEqual(page.fetched.editor, [`${MONACO_VS}/editor/editor.main.js`])
  assert.deepEqual(prepared, [page.monaco])
  await noUnhandled()
})

test('the loader came and the editor did not: the next try resets and configures the same loader, asks again', async () => {
  const page = fakePage({ loader: ['ok'], editor: ['fail', 'ok'] })
  const { load, reports, prepared } = loaderOf(page)
  assert.equal(await load(), null)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].phase, 'loading')
  const installed = page.win.require
  assert.equal(typeof installed, 'function')
  assert.equal(await load(), page.monaco)
  assert.equal(page.win.require, installed, 'the installed loader is kept')
  assert.equal(page.counts.resets, 1, 'the module that failed is forgotten')
  assert.equal(page.fetched.loader.length, 1, 'no second loader script')
  assert.equal(page.head.children.length, 1)
  assert.deepEqual(page.fetched.editor, [`${MONACO_VS}/editor/editor.main.js`, `${MONACO_VS}/editor/editor.main.js`])
  assert.deepEqual(prepared, [page.monaco])
  await noUnhandled()
})

test('the editor fails twice over one loader, then loads', async () => {
  const page = fakePage({ loader: ['ok'], editor: ['fail', 'fail', 'ok'] })
  const { load, reports } = loaderOf(page)
  assert.equal(await load(), null)
  assert.equal(await load(), null)
  assert.equal(await load(), page.monaco)
  assert.equal(reports.length, 2)
  assert.equal(page.fetched.loader.length, 1)
  assert.equal(page.fetched.editor.length, 3, 'each try fetches the editor again')
  await noUnhandled()
})

test('a success is kept: one load, one preparation, whoever asks', async () => {
  const page = fakePage({ loader: ['ok'], editor: ['ok'] })
  const { load, prepared } = loaderOf(page)
  const [a, b] = await Promise.all([load(), load()])
  assert.equal(a, page.monaco)
  assert.equal(b, page.monaco)
  assert.equal(await load(), page.monaco)
  assert.equal(page.fetched.loader.length, 1)
  assert.equal(page.fetched.editor.length, 1)
  assert.deepEqual(prepared, [page.monaco])
  await noUnhandled()
})

test('a loader that came but did not start, or a preparation that throws: null, not a rejection', async () => {
  // another AMD loader was on the page first: Monaco's does not start, and `require` stays its configuration
  const page = fakePage({ loader: ['ok'], editor: ['ok'] })
  page.win.define = Object.assign(() => {}, { amd: {} })
  const { load, reports } = loaderOf(page)
  assert.equal(await load(), null)
  assert.equal(reports.length, 1)
  const throwing = fakePage({ loader: ['ok'], editor: ['ok'] })
  const failing = createMonacoLoader({
    win: throwing.win,
    doc: throwing.doc,
    prepare: () => {
      throw new Error('no theme')
    },
    report: () => {},
  })
  assert.equal(await failing(), null)
  await noUnhandled()
})

test('an editor being opened: a toast when Monaco cannot be had, nothing once it was closed', async () => {
  const toasts = []
  const toast = text => toasts.push(text)
  const used = []
  const use = monaco => used.push(monaco)
  await monacoFor(async () => null, { closed: () => false, toast, use })
  assert.deepEqual(toasts, [EDITOR_UNAVAILABLE])
  assert.equal(EDITOR_UNAVAILABLE, 'The script editor could not be loaded.')
  await monacoFor(async () => null, { closed: () => true, toast, use })
  const monaco = {}
  await monacoFor(async () => monaco, { closed: () => true, toast, use })
  assert.deepEqual(used, [], 'an editor that was closed meanwhile gets nothing')
  await monacoFor(async () => monaco, { closed: () => false, toast, use })
  assert.deepEqual(used, [monaco])
  assert.equal(toasts.length, 1)
  // The question and the use happen in one turn (Codex: the question was asked a turn before the use; an editor
  // closed in between was built on a node that was gone). Whatever is queued when `closed` is asked runs after `use`.
  {
    const order = []
    await monacoFor(async () => monaco, {
      closed: () => {
        order.push('asked')
        queueMicrotask(() => order.push('a later turn'))
        return false
      },
      toast,
      use: () => order.push('used'),
    })
    assert.deepEqual(order, ['asked', 'used', 'a later turn'])
  }
  // closed just before Monaco arrives: not used
  {
    let dead = false
    let arrive
    const pending = monacoFor(() => new Promise(resolve => (arrive = resolve)), { closed: () => dead, toast, use })
    queueMicrotask(() => (dead = true))
    arrive(monaco)
    await pending
    assert.deepEqual(used, [monaco], 'not used again')
  }
  // through a loader that fails: the toast comes, and nothing is left unhandled
  const page = fakePage({ loader: ['fail'] })
  const { load } = loaderOf(page)
  await monacoFor(load, { closed: () => false, toast, use })
  assert.deepEqual(toasts, [EDITOR_UNAVAILABLE, EDITOR_UNAVAILABLE])
  assert.deepEqual(used, [monaco])
  await noUnhandled()
})
