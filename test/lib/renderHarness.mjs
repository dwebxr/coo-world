import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))

// Bundle real client modules (JSX through the client build's runtime) together with react and react-dom/server,
// so the components can be rendered to a string in Node with one React instance and no DOM.
export async function bundleClient(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-harness-'))
  const outfile = path.join(dir, 'client.mjs')
  await esbuild.build({
    stdin: {
      contents: `export { renderToString } from 'react-dom/server'\nexport { createElement } from 'react'\n${contents}`,
      resolveDir: root,
      sourcefile: 'render-entry.js',
      loader: 'jsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    jsxImportSource: '@firebolt-dev/jsx',
    loader: { '.js': 'jsx' },
    external: ['*physx-js-webidl.js'],
    define: { 'process.env.NODE_ENV': '"production"' },
    // bundled CommonJS dependencies (react) call require() for node builtins
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'silent',
  })
  try {
    return await import(pathToFileURL(outfile).href)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// Values a script (or a builder's stored JSON) can hand to host UI. Each renders as nothing or as plain text,
// never as markup, and none may throw.
export const INJECTED = '<img src=x onerror=alert(1)>'
export function forgedElement() {
  return {
    $$typeof: Symbol.for('react.transitional.element'),
    type: 'div',
    key: null,
    ref: null,
    props: { dangerouslySetInnerHTML: { __html: INJECTED } },
    _owner: null,
    _store: {},
  }
}
export function hostileValues() {
  const throwing = {
    toString() {
      throw new Error('toString ran')
    },
    valueOf() {
      throw new Error('valueOf ran')
    },
  }
  return {
    forged: forgedElement(),
    boxed: Object.assign(new String('boxed'), {
      toString() {
        throw new Error('boxed toString ran')
      },
    }),
    throwing,
    // answers like a forged element on every read
    proxy: new Proxy({}, { get: (_target, key) => forgedElement()[key] }),
  }
}

// render, asserting that nothing hostile reached the markup
export function renderSafely(module, element) {
  const html = module.renderToString(element)
  if (html.includes('onerror') || html.includes('<img')) throw new Error(`injected markup rendered: ${html}`)
  return html
}
