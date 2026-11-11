// Handles on the engine for the browser's console: window.world, window.THREE, window.app, window.prims,
// window.preview. A convenience for whoever debugs a world, set on a page served from the machine itself
// (localhost) or when the operator asks for them (PUBLIC_DEBUG=true).
//
// This is not a protection. Code that runs in the page can reach the world without these names (through React's own
// bookkeeping on the DOM, for one), and so can anything that can inject script. What goes on a deployed site is a
// stable, documented-looking name for one-line console snippets and for other scripts on the page to count on.
export function debugGlobalsEnabled(env = globalThis.env, location = globalThis.location) {
  if (env?.PUBLIC_DEBUG === 'true') return true
  const host = location?.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

export function setDebugGlobal(name, value) {
  if (typeof window !== 'undefined' && debugGlobalsEnabled()) window[name] = value
}
