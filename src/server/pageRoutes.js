import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import statics from '@fastify/static'

import { REPORT_PATH } from './cspReports.js'
import { escapeHtml } from './escapeHtml.js'

// The pages this server serves and the headers that go with them.
//
// What the headers do, and no more:
// - `X-Content-Type-Options: nosniff` (a browser takes a response for what its Content-Type says) on every response
//   sent through a Fastify reply: the pages, the statics, the assets, the API, 404s and errors.
// - on the pages: a Content-Security-Policy of four directives that nothing on these pages uses. No other site can
//   put the page in a frame (`frame-ancestors`, with `X-Frame-Options` for browsers that do not read it): the world
//   page asks for wallet signatures and sends tips, and a framed copy under someone else's page can be clicked
//   through. Markup that got into the page cannot change where relative URLs load from (`base-uri`), embed a plugin
//   (`object-src`) or post a form to another site (`form-action`). And a Permissions-Policy: in browsers that
//   implement it (Firefox does not), the page and what it frames cannot use the camera, the location, the Payment
//   Request API or a USB device. `payment` is that API only: wallet requests go through the wallet's own extension
//   or app, and it does not touch them.
//   A page is a response typed text/html when the hook below runs, and a static file the send library types so,
//   whatever its status (a 304 has no type).
// - not covered: a WebSocket upgrade (the socket plugin takes the connection over and writes its own answer, which
//   no browser shows or runs), the errors the HTTP layer writes itself before any route runs (a 400 for a URL it
//   cannot decode, a 408, a 431: none of them a page), and HTML typed after the hook runs or sent as a native
//   `Response` (no route here does either).
// - it is NOT a policy on scripts, styles or connections: markup that got into the page could still run a script.
// - on the world page only, a second policy as `Content-Security-Policy-Report-Only` (reportOnlyPolicy below): the
//   policy on scripts, styles, frames and workers that is meant to be enforced one day. REPORT-ONLY PROTECTS
//   NOTHING: the browser loads and runs everything as before, and posts what the policy would have refused to
//   /csp-report (cspReports.js), which is how to learn what enforcing it would break for real visitors (a wallet
//   extension that puts a script in the page, a wallet's in-app browser, a frame a wallet library opens) before
//   it breaks. The nonce on the page's two inline scripts is there so that they are not reported; it guards
//   nothing until the policy is enforced. The other static pages (terms.html) do not get this policy.
// - `Strict-Transport-Security` only when HSTS_MAX_AGE is set: whether every host of the domain is served over
//   https for that long is the operator's to know.

export const PAGE_CSP = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
export const PAGE_PERMISSIONS = 'camera=(), geolocation=(), payment=(), usb=()'

// The script editor's files (src/client/components/monacoLoader.js): the loader, the editor, its stylesheet, its icon
// font, and what its workers import.
export const MONACO_SOURCE = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.49.0/'

// The policy the world page is tried against. What each part would do if it were enforced:
// - script-src: a script runs when the page's own origin serves it as a script (a store upload is text/plain, so it
//   is not one), when it carries this response's nonce, or when it comes from the script editor's folder on cdnjs.
//   An inline script without the nonce, an inline handler (`onerror=`) and a script of any other host would not run.
//   `'unsafe-eval'` has to stay: app scripts are evaluated (SES), so text that reaches an `eval` of the page's own
//   code still runs; and whoever controls that cdnjs folder still runs code in a builder's page.
// - style-src keeps `'unsafe-inline'` (the interface writes style elements and attributes): injected CSS is not
//   stopped. img-src, media-src and connect-src allow every host (a world shows images and video from anywhere, and
//   app scripts fetch from anywhere): nothing here stops a page that was got into from sending data out.
// - frame-src: only the two hosts WalletConnect's Verify frame is loaded from. worker-src: the page's own files and
//   blob: (the physics and particle workers, and the script editor's).
// - object-src, base-uri and form-action are as in the enforced policy (PAGE_CSP). `frame-ancestors` is not
//   repeated: it is enforced already, and WebKit writes an error to every visitor's console for one in a report-only
//   policy (it ignores it there).
export function reportOnlyPolicy(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' ${MONACO_SOURCE}`,
    `style-src 'self' 'unsafe-inline' ${MONACO_SOURCE}`,
    `font-src 'self' data: ${MONACO_SOURCE}`,
    'img-src * data: blob:',
    'media-src * data: blob:',
    "connect-src 'self' * ws: wss: data: blob:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    'frame-src https://verify.walletconnect.org https://verify.walletconnect.com',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `report-uri ${REPORT_PATH}`,
  ].join('; ')
}

const HSTS_MAX_SECONDS = 2 * 365 * 24 * 60 * 60

// HSTS_MAX_AGE: a whole number of seconds from 0 to two years; unset or empty sends no header. A bad value throws at
// start-up rather than send a header that says something else than was written.
export function readHstsEnv(env) {
  const raw = env.HSTS_MAX_AGE
  if (raw === undefined || raw === '') return null
  const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isInteger(seconds) || seconds > HSTS_MAX_SECONDS) {
    throw new Error(`[envs] HSTS_MAX_AGE must be a whole number of seconds from 0 to ${HSTS_MAX_SECONDS}`)
  }
  return seconds
}

// the headers of every response, and those of an HTML one
export function responseHeaders({ html = false, hstsMaxAge = null } = {}) {
  const headers = { 'X-Content-Type-Options': 'nosniff' }
  if (hstsMaxAge !== null) headers['Strict-Transport-Security'] = `max-age=${hstsMaxAge}`
  if (html) {
    headers['Content-Security-Policy'] = PAGE_CSP
    headers['X-Frame-Options'] = 'DENY'
    headers['Permissions-Policy'] = PAGE_PERMISSIONS
  }
  return headers
}

const isHtml = type => typeof type === 'string' && /^text\/html\b/i.test(type)
// the names the send library (its `mime` table) types as text/html, in any case
const isHtmlFile = filePath => /\.(?:html?|shtml)$/i.test(filePath)

// Registered on the root instance, so the hook runs for every reply of every plugin: pages, statics, assets, the API,
// 404s and errors (what it does not see is listed at the top).
export function securityHeaders(fastify, { hstsMaxAge = null } = {}) {
  fastify.addHook('onSend', (req, reply, payload, done) => {
    reply.headers(responseHeaders({ html: isHtml(reply.getHeader('content-type')), hstsMaxAge }))
    done(null, payload)
  })
}

// The world page, the public environment script and the static files of `publicDir`.
// `page()` gives what the world page says about the world: { title, desc, image, url }.
export async function pageRoutes(fastify, { publicDir, page, envsCode }) {
  const world = async (req, reply) => {
    const { title, desc, image, url } = page()
    let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8')
    // a new nonce for each response, put in before the world's own texts so that none of them can receive it
    const nonce = randomBytes(18).toString('base64')
    html = html.replaceAll('{nonce}', nonce)
    // function replacers insert the escaped text literally (no `$` pattern expansion)
    html = html.replaceAll('{url}', () => escapeHtml(url))
    html = html.replaceAll('{title}', () => escapeHtml(title))
    html = html.replaceAll('{desc}', () => escapeHtml(desc))
    html = html.replaceAll('{image}', () => escapeHtml(image))
    // returned, not sent: registered here these routes are compressed (the page used to be declared before the
    // compression plugin had loaded, and so was not), and an async handler that sends and then returns nothing
    // leaves a compressed response empty
    reply.type('text/html')
    reply.header('Content-Security-Policy-Report-Only', reportOnlyPolicy(nonce))
    // a cache has to ask the server again before it uses a copy (and the page has nothing to revalidate with, so it
    // gets a new one): a cache that keeps to that does not hand one response, and one nonce, to two visitors
    reply.header('Cache-Control', 'no-cache')
    return html
  }
  fastify.get('/', world)
  // The built file is the same page with its placeholders still in it. The static route below would hand it out as
  // it is; this is the one way the page is served, by either name.
  fastify.get('/index.html', world)
  fastify.get('/env.js', async (req, reply) => {
    reply.type('application/javascript')
    return envsCode
  })
  fastify.register(statics, {
    root: publicDir,
    prefix: '/',
    decorateReply: false,
    // Cache-Control stays @fastify/static's default (public, max-age=0: revalidate by ETag), which is what
    // production has always served: before v10, send overwrote a Cache-Control set here
    // A static page gets the page headers here, where the file is known, on a 200, a 206, a HEAD and a 304 alike: the
    // send library drops the Content-Type of a 304 before the hook runs, so the hook cannot tell it is a page, and a
    // browser that revalidates a copy cached before these headers existed would keep that copy without them.
    setHeaders: (reply, filePath) => {
      reply.header('Pragma', 'no-cache')
      reply.header('Expires', '0')
      if (isHtmlFile(filePath)) reply.headers(responseHeaders({ html: true }))
    },
  })
}
