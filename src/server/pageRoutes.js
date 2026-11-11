import fs from 'node:fs'
import path from 'node:path'
import statics from '@fastify/static'

import { escapeHtml } from './escapeHtml.js'

// The pages this server serves and the headers that go with them.
//
// What the headers do, and no more:
// - every response: `X-Content-Type-Options: nosniff` (a browser takes a response for what its Content-Type says).
// - every HTML response (the world page and the static pages): a Content-Security-Policy of four directives that
//   nothing on these pages uses. No other site can put the page in a frame (`frame-ancestors`, with
//   `X-Frame-Options` for browsers that do not read it): the world page asks for wallet signatures and sends tips,
//   and a framed copy under someone else's page can be clicked through. Markup that got into the page cannot change
//   where relative URLs load from (`base-uri`), embed a plugin (`object-src`) or post a form to another site
//   (`form-action`). And a Permissions-Policy: the page and what it frames can never ask for the camera, the
//   location, a payment or a USB device.
// - it is NOT a policy on scripts, styles or connections: markup that got into the page could still run a script.
//   (A full policy needs the script host's `eval` for app scripts, and has to be tried against real wallets first.)
// - `Strict-Transport-Security` only when HSTS_MAX_AGE is set: whether every host of the domain is served over
//   https for that long is the operator's to know.

export const PAGE_CSP = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
export const PAGE_PERMISSIONS = 'camera=(), geolocation=(), payment=(), usb=()'

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

// Registered on the root instance, so the hook sees every response: pages, statics, assets, the API, errors.
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
    // function replacers insert the escaped text literally (no `$` pattern expansion)
    html = html.replaceAll('{url}', () => escapeHtml(url))
    html = html.replaceAll('{title}', () => escapeHtml(title))
    html = html.replaceAll('{desc}', () => escapeHtml(desc))
    html = html.replaceAll('{image}', () => escapeHtml(image))
    // returned, not sent: registered here these routes are compressed (the page used to be declared before the
    // compression plugin had loaded, and so was not), and an async handler that sends and then returns nothing
    // leaves a compressed response empty
    reply.type('text/html')
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
    setHeaders: reply => {
      reply.header('Pragma', 'no-cache')
      reply.header('Expires', '0')
    },
  })
}
