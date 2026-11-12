// Monaco for the script editor, from the CDN, through the AMD loader that comes with it (monaco-editor 0.49.0).
//
// `createMonacoLoader({ win, doc })` gives `load()`: a promise of `win.monaco`, or of null when it could not be had.
// A success is kept. After a failure the next call tries again from where the failure left off:
// - the loader script did not come (offline, a blocker, a policy): its tag is taken out, and the next try puts in a
//   new one, with `require` set to the configuration the loader reads when it starts.
// - the loader came and the editor's script did not: the loader stays installed. It does not start again over the
//   `define.amd` it set, so `require` is still its function and is configured, not replaced; and it answers a module
//   that failed to load with that same error from then on, without fetching it again (in its source, `_onLoadError`
//   keeps the module as complete with its error, and `_resolve` hands that error to every later request). It has no
//   `undef`; `reset()` forgets every module and the configuration, so the next try resets it, configures it again and
//   asks for the editor, and no second loader script is put in.
// Not covered: the editor's stylesheet and its default strings come through the loader's plugins, which do not pass
// a failure on to the request (the strings plugin only logs it): when one of them fails, that try waits for good, as
// it did before.
export const MONACO_VS = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.49.0/min/vs'
export const EDITOR_UNAVAILABLE = 'The script editor could not be loaded.'

export function createMonacoLoader({
  win,
  doc,
  vs = MONACO_VS,
  prepare = () => {},
  report = err => console.error(err),
}) {
  let promise = null
  const config = () => ({ paths: { vs } })
  // the loader an earlier try fetched, installed on the page
  const installed = () =>
    typeof win.require === 'function' &&
    typeof win.require.config === 'function' &&
    typeof win.require.reset === 'function' &&
    !!win.define?.amd
  const fetchLoader = () =>
    new Promise((resolve, reject) => {
      const script = doc.createElement('script')
      script.src = `${vs}/loader.js`
      script.onload = () => resolve()
      script.onerror = () => {
        script.remove()
        reject(new Error('the script editor could not be loaded: its loader did not come'))
      }
      doc.head.appendChild(script)
    })
  const attempt = async () => {
    if (installed()) {
      win.require.reset()
      win.require.config(config())
    } else {
      win.require = config()
      await fetchLoader()
    }
    await new Promise((resolve, reject) => win.require(['vs/editor/editor.main'], () => resolve(), reject))
    prepare(win.monaco)
    return win.monaco
  }
  return function load() {
    if (!promise) {
      promise = attempt().catch(err => {
        promise = null
        report(err)
        return null
      })
    }
    return promise
  }
}

// What an editor being opened gets: `use(monaco)` is called once Monaco is there, or a toast says that it could
// not be loaded. An editor that was closed meanwhile gets neither: `closed()` is asked in the same turn that `use`
// runs in, so nothing can close the editor between the question and the use (asked earlier, the editor could be
// closed before its continuation ran, which then built an editor on a node that was gone).
export async function monacoFor(load, { closed, toast, use }) {
  const monaco = await load()
  if (closed()) return
  if (!monaco) return toast(EDITOR_UNAVAILABLE)
  use(monaco)
}
