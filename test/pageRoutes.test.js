import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import Fastify from 'fastify'
import compress from '@fastify/compress'
import statics from '@fastify/static'
import { compressOptions } from '../src/server/compressOptions.js'
import {
  CSP_MODES,
  MONACO_SOURCE,
  PAGE_CSP,
  PAGE_PERMISSIONS,
  cspModeNote,
  enforcedPolicy,
  pageRoutes,
  readCspModeEnv,
  readHstsEnv,
  reportOnlyPolicy,
  responseHeaders,
  securityHeaders,
} from '../src/server/pageRoutes.js'
import { MONACO_VS } from '../src/client/components/monacoLoader.js'

const TEMPLATE = `<!doctype html><html><head><title>{title}</title>
<meta property="og:description" content="{desc}" /><meta property="og:image" content="{image}" />
<meta property="og:url" content="{url}" /></head><body></body></html>`

let dir
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'page-routes-'))
  await fs.writeFile(path.join(dir, 'index.html'), TEMPLATE)
  await fs.writeFile(path.join(dir, 'terms.html'), '<!doctype html><title>Terms</title>')
  await fs.writeFile(path.join(dir, 'index.css'), 'body{}')
  await fs.writeFile(path.join(dir, 'app-ABC.js'), 'export {}')
  // other names the statics type as HTML, and one they do not
  for (const name of ['b.htm', 'c.shtml', 'D.HTML']) await fs.writeFile(path.join(dir, name), '<p>page</p>')
  await fs.writeFile(path.join(dir, 'notes.txt'), 'notes')
})
after(() => fs.rm(dir, { recursive: true, force: true }))

// `cspMode` left out: the plugin's own default. `htmlReplies`: routes of the server's own that answer in HTML (a page,
// an error page, a not-found page), which are not the world page
async function server({
  hstsMaxAge = null,
  page,
  envsCode = 'globalThis.env = {}',
  publicDir = dir,
  cspMode,
  htmlReplies = false,
} = {}) {
  const app = Fastify()
  // as the server registers them: compression first, then the headers, then the pages
  app.register(compress, compressOptions())
  securityHeaders(app, { hstsMaxAge })
  app.register(pageRoutes, {
    publicDir,
    page:
      page ??
      (() => ({ title: 'World', desc: 'A world', image: 'https://cdn.example/i.png', url: 'https://w.example' })),
    envsCode,
    ...(cspMode === undefined ? {} : { cspMode }),
  })
  app.get('/status', async () => ({ ok: true }))
  app.get('/boom', async () => {
    throw new Error('boom')
  })
  if (htmlReplies) {
    app.get('/html-page', async (req, reply) => reply.type('text/html').send('<p>a page</p>'))
    app.get('/html-error', async (req, reply) => reply.code(500).type('text/html; charset=utf-8').send('<p>error</p>'))
    app.setNotFoundHandler((req, reply) => reply.code(404).type('text/html').send('<p>not found</p>'))
  }
  await app.ready()
  return app
}

// each mode as the server is given it, and what it must be taken for: `undefined` is the default
const MODES = [
  [undefined, 'report'],
  ['report', 'report'],
  ['enforce', 'enforce'],
]

const PAGE_ONLY = ['content-security-policy', 'x-frame-options', 'permissions-policy']
const REPORT_ONLY = 'content-security-policy-report-only'
const policyFor = nonce =>
  "default-src 'self'; " +
  `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.49.0/; ` +
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.49.0/; " +
  "font-src 'self' data: https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.49.0/; " +
  'img-src * data: blob:; media-src * data: blob:; ' +
  "connect-src 'self' * ws: wss: data: blob:; worker-src 'self' blob:; child-src 'self' blob:; " +
  'frame-src https://verify.walletconnect.org https://verify.walletconnect.com; ' +
  "object-src 'none'; base-uri 'none'; form-action 'self'; " +
  'report-uri /csp-report'
const enforcedFor = nonce =>
  "default-src 'self'; " +
  `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.49.0/; ` +
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.49.0/; " +
  "font-src 'self' data: https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.49.0/; " +
  'img-src * data: blob:; media-src * data: blob:; ' +
  "connect-src 'self' * ws: wss: data: blob:; worker-src 'self' blob:; child-src 'self' blob:; " +
  'frame-src https://verify.walletconnect.org https://verify.walletconnect.com; ' +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
  'report-uri /csp-report'
const directivesOf = policy => policy.split('; ')

// The world page's policy headers as the mode has them, around the nonce the response carries -> that nonce.
// report: PAGE_CSP enforced and the full policy report-only; enforce: the full policy with frame-ancestors as the one
// Content-Security-Policy, and no report-only header. (Two headers of a name would come here as a list, and fail.)
function worldPolicy(res, mode, label) {
  const NONCE = /'nonce-([A-Za-z0-9+/]{24})'/
  if (mode === 'enforce') {
    const nonce = NONCE.exec(res.headers['content-security-policy'])?.[1]
    assert.equal(res.headers['content-security-policy'], enforcedFor(nonce), label)
    assert.equal(res.headers[REPORT_ONLY], undefined, label)
    return nonce
  }
  const nonce = NONCE.exec(res.headers[REPORT_ONLY])?.[1]
  assert.equal(res.headers['content-security-policy'], PAGE_CSP, label)
  assert.equal(res.headers[REPORT_ONLY], policyFor(nonce), label)
  return nonce
}

test('responseHeaders: nosniff on everything; the page headers on HTML only; HSTS only when asked for', () => {
  assert.deepEqual(responseHeaders(), { 'X-Content-Type-Options': 'nosniff' })
  assert.deepEqual(responseHeaders({ html: true }), {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), geolocation=(), payment=(), usb=()',
  })
  assert.equal(responseHeaders({ hstsMaxAge: 31536000 })['Strict-Transport-Security'], 'max-age=31536000')
  assert.equal(responseHeaders({ html: true, hstsMaxAge: 0 })['Strict-Transport-Security'], 'max-age=0')
  // the policy says nothing about scripts, styles or connections: it must not look like it does
  assert.doesNotMatch(PAGE_CSP, /script-src|default-src|style-src|connect-src/)
  assert.equal(PAGE_PERMISSIONS, 'camera=(), geolocation=(), payment=(), usb=()')
})

test('HSTS_MAX_AGE: unset sends nothing; a whole number of seconds up to two years; a bad value throws', () => {
  assert.equal(readHstsEnv({}), null)
  assert.equal(readHstsEnv({ HSTS_MAX_AGE: '' }), null)
  assert.equal(readHstsEnv({ HSTS_MAX_AGE: '0' }), 0)
  assert.equal(readHstsEnv({ HSTS_MAX_AGE: '31536000' }), 31536000)
  assert.equal(readHstsEnv({ HSTS_MAX_AGE: '63072000' }), 63072000)
  for (const value of ['63072001', '-1', '1.5', ' ', 'a year', '1e3', 'max-age=1']) {
    assert.throws(() => readHstsEnv({ HSTS_MAX_AGE: value }), /HSTS_MAX_AGE must be a whole number/, value)
  }
})

test('CSP_MODE: unset or empty is report; report or enforce as written; any other value throws, naming the two', () => {
  assert.deepEqual(CSP_MODES, ['report', 'enforce'])
  assert.equal(readCspModeEnv({}), 'report')
  assert.equal(readCspModeEnv({ CSP_MODE: '' }), 'report')
  assert.equal(readCspModeEnv({ CSP_MODE: 'report' }), 'report')
  assert.equal(readCspModeEnv({ CSP_MODE: 'enforce' }), 'enforce')
  for (const value of [
    'Enforce',
    'ENFORCE',
    ' enforce',
    'enforce ',
    'enforced',
    'report-only',
    'Report',
    ' ',
    'true',
    '1',
    'on',
    'off',
    'none',
  ]) {
    assert.throws(
      () => readCspModeEnv({ CSP_MODE: value }),
      err => {
        assert.equal(err.message, '[envs] CSP_MODE must be report or enforce (unset or empty: report)', value)
        return true
      },
      value
    )
  }
})

test('the start-up line says the mode in its own words', () => {
  assert.equal(
    cspModeNote('report'),
    "[envs] CSP_MODE=report: the world page's full policy is tried only: nothing is refused (browsers post what it " +
      'would refuse to /csp-report)'
  )
  assert.equal(
    cspModeNote('enforce'),
    "[envs] CSP_MODE=enforce: the world page's full policy is enforced: browsers refuse there a script that is not " +
      "one of the page's own files, the script editor's from cdnjs or an inline script with the page's nonce (inline " +
      "handlers included), a stylesheet or font file from a host other than the page's or the script editor's " +
      "folder, a frame other than WalletConnect's Verify, and a worker not from the page or blob:"
  )
  assert.doesNotMatch(cspModeNote('enforce'), /tried|nothing is refused|report-only|would/)
  assert.doesNotMatch(cspModeNote('report'), /enforced|refuses/)
  // one line each, and not a `[csp]` line: those are the reports' (cspReports.js), which the e2e suites count
  for (const line of CSP_MODES.map(cspModeNote)) assert.doesNotMatch(line, /\n|\[csp\]/)
  for (const mode of [undefined, '', 'Enforce', 'report-only']) assert.throws(() => cspModeNote(mode), /unknown/)
})

test('the world page: by either name, with the page headers, its placeholders filled in and escaped', async () => {
  for (const [cspMode, mode] of MODES) {
    const app = await server({
      cspMode,
      page: () => ({
        title: '</title><script>alert(1)</script>',
        desc: '" onload="alert(1)',
        image: "https://cdn.example/i.png?a=1&b='2'",
        url: 'https://w.example/$&',
      }),
    })
    try {
      const bodies = []
      for (const url of ['/', '/index.html', '/index.html?x=1']) {
        const label = `${url} (${cspMode})`
        const res = await app.inject({ method: 'GET', url })
        assert.equal(res.statusCode, 200, label)
        assert.match(res.headers['content-type'], /^text\/html/, label)
        worldPolicy(res, mode, label)
        assert.equal(res.headers['x-frame-options'], 'DENY', label)
        assert.equal(res.headers['permissions-policy'], PAGE_PERMISSIONS, label)
        assert.equal(res.headers['x-content-type-options'], 'nosniff', label)
        assert.equal(res.headers['strict-transport-security'], undefined, label)
        assert.equal(res.headers['cache-control'], 'no-cache', label)
        bodies.push(res.body)
      }
      // /index.html is the page, not the built file with its placeholders
      assert.equal(bodies[1], bodies[0])
      assert.equal(bodies[2], bodies[0])
      assert.doesNotMatch(bodies[0], /\{title\}|\{desc\}|\{image\}|\{url\}/)
      assert.doesNotMatch(bodies[0], /<script>alert|" onload=/)
      assert.match(bodies[0], /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/)
      assert.match(bodies[0], /content="&quot; onload=&quot;alert\(1\)"/)
      assert.match(bodies[0], /content="https:\/\/cdn\.example\/i\.png\?a=1&amp;b=&#39;2&#39;"/)
      assert.match(bodies[0], /content="https:\/\/w\.example\/\$&amp;"/)
    } finally {
      await app.close()
    }
  }
})

test('the pages and the env script are whole when a browser asks for them compressed', async () => {
  // a page and an env script longer than the size compression starts at (1024 bytes)
  const long = 'x'.repeat(4000)
  const envsCode = `globalThis.env = ${JSON.stringify({ PUBLIC_LONG: 'y'.repeat(4000), PUBLIC_END: 'end' })}`
  for (const [cspMode, mode] of MODES) {
    const app = await server({ cspMode, page: () => ({ title: long, desc: 'd', image: '', url: 'u' }), envsCode })
    try {
      for (const [encoding, decode] of [
        ['br', zlib.brotliDecompressSync],
        ['gzip', zlib.gunzipSync],
      ]) {
        for (const url of ['/', '/index.html']) {
          const label = `${url} over ${encoding} (${cspMode})`
          const res = await app.inject({ method: 'GET', url, headers: { 'accept-encoding': encoding } })
          assert.equal(res.statusCode, 200, label)
          assert.equal(res.headers['content-encoding'], encoding, label)
          const body = decode(res.rawPayload).toString()
          assert.ok(body.includes(`<title>${long}</title>`), `${label}: ${body.length} characters`)
          worldPolicy(res, mode, label)
          assert.equal(res.headers['x-content-type-options'], 'nosniff', label)
        }
        const env = await app.inject({ method: 'GET', url: '/env.js', headers: { 'accept-encoding': encoding } })
        assert.equal(env.statusCode, 200)
        assert.equal(env.headers['content-encoding'], encoding, `/env.js over ${encoding}`)
        assert.match(env.headers['content-type'], /javascript/)
        assert.equal(decode(env.rawPayload).toString(), envsCode, `/env.js over ${encoding}`)
      }
      const plain = await app.inject({ method: 'GET', url: '/env.js', headers: { 'accept-encoding': 'identity' } })
      assert.equal(plain.headers['content-encoding'], undefined)
      assert.equal(plain.body, envsCode)
    } finally {
      await app.close()
    }
  }
})

test('a static page has the page headers on a 304, a HEAD and a range too', async () => {
  // what a browser cached before these headers existed: the same file from the statics alone
  const before = Fastify()
  before.register(statics, { root: dir, prefix: '/' })
  await before.ready()
  try {
    for (const [cspMode] of MODES) {
      const app = await server({ hstsMaxAge: 600, cspMode })
      try {
        const cached = await before.inject({ method: 'GET', url: '/terms.html' })
        assert.equal(cached.statusCode, 200)
        assert.equal(cached.headers['content-security-policy'], undefined)
        const conditions = [
          { 'if-none-match': cached.headers.etag },
          { 'if-modified-since': cached.headers['last-modified'] },
        ]
        const requests = [
          ...conditions.map(headers => ({ method: 'GET', headers, status: 304 })),
          { method: 'HEAD', headers: {}, status: 200 },
          { method: 'GET', headers: { range: 'bytes=0-3' }, status: 206 },
        ]
        for (const { method, headers, status } of requests) {
          const label = `${method} ${JSON.stringify(headers)} (${cspMode})`
          const res = await app.inject({ method, url: '/terms.html', headers })
          assert.equal(res.statusCode, status, label)
          assert.equal(res.headers['content-security-policy'], PAGE_CSP, label)
          assert.equal(res.headers[REPORT_ONLY], undefined, label)
          assert.equal(res.headers['x-frame-options'], 'DENY', label)
          assert.equal(res.headers['permissions-policy'], PAGE_PERMISSIONS, label)
          assert.equal(res.headers['x-content-type-options'], 'nosniff', label)
          assert.equal(res.headers['strict-transport-security'], 'max-age=600', label)
        }
        // a static file is a page exactly when the statics type it text/html, on the 200 and on its 304
        for (const name of ['terms.html', 'b.htm', 'c.shtml', 'D.HTML', 'index.css', 'app-ABC.js', 'notes.txt']) {
          const label = `${name} (${cspMode})`
          const full = await app.inject({ method: 'GET', url: `/${name}` })
          assert.equal(full.statusCode, 200, label)
          const page = /^text\/html/.test(full.headers['content-type'])
          const revalidated = await app.inject({
            method: 'GET',
            url: `/${name}`,
            headers: { 'if-none-match': full.headers.etag },
          })
          assert.equal(revalidated.statusCode, 304, label)
          assert.equal(revalidated.headers['content-type'], undefined, `${label}: a 304 has no type`)
          for (const res of [full, revalidated]) {
            const what = `${label} ${res.statusCode}`
            assert.equal(res.headers['content-security-policy'], page ? PAGE_CSP : undefined, what)
            assert.equal(res.headers[REPORT_ONLY], undefined, what)
            assert.equal(res.headers['x-frame-options'], page ? 'DENY' : undefined, what)
            assert.equal(res.headers['x-content-type-options'], 'nosniff', what)
          }
          assert.equal(page, /\.(html?|shtml)$/i.test(name), `${name} is typed ${full.headers['content-type']}`)
        }
      } finally {
        await app.close()
      }
    }
  } finally {
    await before.close()
  }
})

test('every other response: nosniff, and no page headers on what is not a page', async () => {
  for (const [cspMode] of MODES) {
    const app = await server({ cspMode })
    try {
      const terms = await app.inject({ method: 'GET', url: '/terms.html' })
      assert.equal(terms.statusCode, 200)
      assert.equal(terms.headers['content-security-policy'], PAGE_CSP, 'a static page is a page')
      assert.equal(terms.headers['x-frame-options'], 'DENY')
      assert.equal(terms.headers['x-content-type-options'], 'nosniff')
      for (const [url, status, type] of [
        ['/env.js', 200, /javascript/],
        ['/index.css', 200, /css/],
        ['/app-ABC.js', 200, /javascript/],
        ['/status', 200, /json/],
        ['/no-such-file', 404, /json/],
        ['/boom', 500, /json/],
      ]) {
        const label = `${url} (${cspMode})`
        const res = await app.inject({ method: 'GET', url })
        assert.equal(res.statusCode, status, label)
        assert.match(String(res.headers['content-type']), type, label)
        assert.equal(res.headers['x-content-type-options'], 'nosniff', label)
        for (const name of [...PAGE_ONLY, REPORT_ONLY]) assert.equal(res.headers[name], undefined, `${label}: ${name}`)
      }
      const env = await app.inject({ method: 'GET', url: '/env.js' })
      assert.equal(env.body, 'globalThis.env = {}')
      // what the hook does not see (pageRoutes.js says so): the answer Fastify writes itself for a URL it cannot
      // decode. It is JSON, not a page; this fails when that changes, and then the comment is to be read again.
      const bad = await app.inject({ method: 'GET', url: '/%ZZ' })
      assert.equal(bad.statusCode, 400)
      assert.match(String(bad.headers['content-type']), /^application\/json/)
      assert.equal(bad.headers['x-content-type-options'], undefined)
    } finally {
      await app.close()
    }
  }
})

test('in either mode, an HTML reply that is not the world page has PAGE_CSP, before and after a world page', async () => {
  for (const [cspMode, mode] of MODES) {
    const app = await server({ cspMode, htmlReplies: true, hstsMaxAge: 600 })
    try {
      const others = [
        ['/html-page', 200],
        ['/html-error', 500],
        ['/no-such-page', 404],
        ['/terms.html', 200],
        ['/b.htm', 200],
      ]
      // each one asked before a world page, after one, and after a HEAD of one: nothing of a world reply carries over
      for (const world of [null, 'GET', 'HEAD']) {
        if (world) {
          const res = await app.inject({ method: world, url: '/' })
          worldPolicy(res, mode, `${world} / (${cspMode})`)
        }
        for (const [url, status] of others) {
          const label = `${url} after ${world} (${cspMode})`
          const res = await app.inject({ method: 'GET', url })
          assert.equal(res.statusCode, status, label)
          assert.match(String(res.headers['content-type']), /^text\/html/, label)
          assert.equal(res.headers['content-security-policy'], PAGE_CSP, label)
          assert.equal(res.headers[REPORT_ONLY], undefined, label)
          assert.equal(res.headers['x-frame-options'], 'DENY', label)
          assert.equal(res.headers['permissions-policy'], PAGE_PERMISSIONS, label)
          assert.equal(res.headers['x-content-type-options'], 'nosniff', label)
          assert.equal(res.headers['strict-transport-security'], 'max-age=600', label)
        }
      }
    } finally {
      await app.close()
    }
  }
})

test('HSTS: on every response when HSTS_MAX_AGE is set', async () => {
  for (const [cspMode] of MODES) {
    const app = await server({ hstsMaxAge: 600, cspMode })
    try {
      for (const url of ['/', '/terms.html', '/env.js', '/status', '/no-such-file']) {
        const res = await app.inject({ method: 'GET', url })
        assert.equal(res.headers['strict-transport-security'], 'max-age=600', `${url} (${cspMode})`)
      }
    } finally {
      await app.close()
    }
  }
})

test('reportOnlyPolicy: the policy, word for word, around the nonce it is given', () => {
  assert.equal(reportOnlyPolicy('abc'), policyFor('abc'))
  // the script editor is loaded from inside the one folder the policy names
  assert.ok(MONACO_VS.startsWith(MONACO_SOURCE), MONACO_VS)
  assert.match(MONACO_SOURCE, /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/monaco-editor\/[\d.]+\/$/)
  const directives = Object.fromEntries(
    reportOnlyPolicy('abc')
      .split('; ')
      .map(d => [d.split(' ')[0], d.split(' ').slice(1)])
  )
  // WebKit writes a console error on every load for a frame-ancestors in a report-only policy (it is enforced, in
  // the other header)
  assert.equal('frame-ancestors' in directives, false)
  // what must never be in it: inline scripts without the nonce, a nonce for styles, any host for scripts or frames
  assert.equal(directives['script-src'].includes("'unsafe-inline'"), false)
  assert.equal(directives['script-src'].includes('*'), false)
  assert.equal(directives['script-src'].includes('https:'), false)
  assert.equal(directives['script-src'].includes('data:'), false)
  assert.equal(directives['script-src'].includes('blob:'), false)
  assert.equal(
    directives['style-src'].some(s => s.startsWith("'nonce-")),
    false
  )
  assert.equal(directives['frame-src'].includes('*'), false)
  assert.equal(directives['worker-src'].includes('*'), false)
  assert.equal(directives['worker-src'].includes('data:'), false)
})

test('enforcedPolicy: the tried policy word for word, with frame-ancestors added; all of PAGE_CSP is in it', () => {
  assert.equal(enforcedPolicy('abc'), enforcedFor('abc'))
  const enforced = directivesOf(enforcedPolicy('abc'))
  // the same directives as the tried policy, in the same order, and one more before the report address
  assert.deepEqual(
    enforced.filter(d => d !== "frame-ancestors 'none'"),
    directivesOf(reportOnlyPolicy('abc'))
  )
  assert.equal(enforced.at(-2), "frame-ancestors 'none'")
  assert.equal(enforced.at(-1), 'report-uri /csp-report')
  // it takes PAGE_CSP's place on the world page: none of what PAGE_CSP enforces may be missing from it
  for (const directive of directivesOf(PAGE_CSP)) assert.ok(enforced.includes(directive), directive)
  // one of each directive
  const names = enforced.map(d => d.split(' ')[0])
  assert.equal(new Set(names).size, names.length)
})

test('pageRoutes: a mode that is neither report nor enforce stops the registration', async () => {
  for (const cspMode of ['', 'Enforce', 'report-only', null]) {
    const app = Fastify()
    app.register(pageRoutes, { publicDir: dir, page: () => ({}), envsCode: '', cspMode })
    await assert.rejects(app.ready(), /unknown CSP mode/, String(cspMode))
    await app.close()
  }
})

test('the world page: its policy with a nonce of its own on each response, never reused from a cache unasked', async () => {
  const withScripts = await fs.mkdtemp(path.join(os.tmpdir(), 'page-routes-nonce-'))
  await fs.writeFile(
    path.join(withScripts, 'index.html'),
    '<!doctype html><title>{title}</title><meta name="description" content="{desc}" />' +
      '<script nonce="{nonce}">window.a = 1</script><script nonce="{nonce}">window.b = 2</script>' +
      '<script src="/env.js"></script>' +
      // longer than the size compression starts at (1024 bytes)
      `<!-- ${'padding '.repeat(200)} -->`
  )
  await fs.writeFile(path.join(withScripts, 'terms.html'), '<!doctype html><title>Terms</title>')
  try {
    for (const [cspMode, mode] of MODES) {
      // a world whose own texts spell the placeholder do not get the nonce
      const app = await server({
        cspMode,
        publicDir: withScripts,
        page: () => ({ title: '{nonce}', desc: 'nonce-{nonce}', image: '', url: '' }),
      })
      try {
        const nonces = new Set()
        for (const url of ['/', '/index.html', '/', '/']) {
          const label = `${url} (${cspMode})`
          const res = await app.inject({ method: 'GET', url })
          assert.equal(res.statusCode, 200, label)
          const inPage = [...res.body.matchAll(/<script nonce="([^"]*)">/g)].map(m => m[1])
          assert.equal(inPage.length, 2, label)
          assert.equal(inPage[0], inPage[1], label)
          const nonce = inPage[0]
          assert.match(nonce, /^[A-Za-z0-9+/]{24}$/, label)
          // report: the enforced policy is the same four directives as before, nothing new is enforced, and the
          // full policy is report-only; enforce: the full policy is the one enforced policy
          assert.equal(worldPolicy(res, mode, label), nonce, label)
          assert.equal(res.headers['cache-control'], 'no-cache', label)
          assert.match(res.body, /<title>\{nonce\}<\/title>/, label)
          assert.match(res.body, /content="nonce-\{nonce\}"/, label)
          assert.equal(res.body.split(nonce).length - 1, 2, 'the nonce is in the two script tags and nowhere else')
          nonces.add(nonce)
        }
        assert.equal(nonces.size, 4, 'each response has its own nonce')
        // a HEAD answers with the same headers
        const head = await app.inject({ method: 'HEAD', url: '/' })
        assert.match(worldPolicy(head, mode, `HEAD (${cspMode})`), /^[A-Za-z0-9+/]{24}$/)
        assert.equal(head.headers['cache-control'], 'no-cache')
        // compressed, the header and the page still carry the same nonce
        const zipped = await app.inject({ method: 'GET', url: '/', headers: { 'accept-encoding': 'gzip' } })
        const nonce = worldPolicy(zipped, mode, `gzip (${cspMode})`)
        assert.equal(zipped.headers['content-encoding'], 'gzip')
        assert.equal(zlib.gunzipSync(zipped.rawPayload).toString().split(`nonce="${nonce}"`).length - 1, 2)
        // the other pages and everything else: no report-only policy, and the other page PAGE_CSP alone
        for (const url of ['/terms.html', '/env.js', '/status', '/missing', '/boom']) {
          const res = await app.inject({ method: 'GET', url })
          assert.equal(res.headers[REPORT_ONLY], undefined, `${url} (${cspMode})`)
          assert.equal(
            res.headers['content-security-policy'],
            url === '/terms.html' ? PAGE_CSP : undefined,
            `${url} (${cspMode})`
          )
        }
      } finally {
        await app.close()
      }
    }
  } finally {
    await fs.rm(withScripts, { recursive: true, force: true })
  }
})

test('the server reads CSP_MODE at start-up with the other settings, says it, and hands it to both routes', async () => {
  const source = await fs.readFile(new URL('../src/server/index.js', import.meta.url), 'utf-8')
  const at = source.indexOf('\nconst cspMode = readCspModeEnv(process.env)\nconsole.log(cspModeNote(cspMode))\n')
  assert.ok(at > 0, 'read at the top level, not inside a condition, and said at once')
  assert.ok(at < source.indexOf('installShutdown()'), 'with the other [envs] checks')
  assert.ok(at < source.indexOf('fs.ensureDir(worldDir)'), 'before the world folder')
  assert.equal(source.split('readCspModeEnv(').length - 1, 1)
  const pages = /fastify\.register\(pageRoutes, \{[\s\S]*?\n\}\)/.exec(source)?.[0]
  assert.match(pages, /\n {2}cspMode,\n\}\)$/, 'the world page is sent in the mode read')
  assert.match(
    source,
    /\nfastify\.register\(cspReportRoute, \{ mode: cspMode, clientIpHeader: uploadLimitsConfig\.clientIpHeader \}\)\n/,
    'the report lines are worded in the mode read'
  )
})

test('the page that is shipped: every inline script carries the nonce placeholder', async () => {
  const html = await fs.readFile(new URL('../src/client/public/index.html', import.meta.url), 'utf-8')
  const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map(m => m[1])
  const inline = tags.filter(attrs => !/\bsrc=/.test(attrs))
  assert.equal(inline.length, 2)
  for (const attrs of inline) assert.match(attrs, /^ nonce="\{nonce\}"$/)
  // and nothing in it is an inline handler, which no nonce covers
  assert.doesNotMatch(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), /\son[a-z]+\s*=/i)
})
