import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import Fastify from 'fastify'
import compress from '@fastify/compress'
import { compressOptions } from '../src/server/compressOptions.js'
import {
  PAGE_CSP,
  PAGE_PERMISSIONS,
  pageRoutes,
  readHstsEnv,
  responseHeaders,
  securityHeaders,
} from '../src/server/pageRoutes.js'

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
})
after(() => fs.rm(dir, { recursive: true, force: true }))

async function server({ hstsMaxAge = null, page } = {}) {
  const app = Fastify()
  // as the server registers them: compression first, then the headers, then the pages
  app.register(compress, compressOptions())
  securityHeaders(app, { hstsMaxAge })
  app.register(pageRoutes, {
    publicDir: dir,
    page:
      page ??
      (() => ({ title: 'World', desc: 'A world', image: 'https://cdn.example/i.png', url: 'https://w.example' })),
    envsCode: 'globalThis.env = {}',
  })
  app.get('/status', async () => ({ ok: true }))
  app.get('/boom', async () => {
    throw new Error('boom')
  })
  await app.ready()
  return app
}

const PAGE_ONLY = ['content-security-policy', 'x-frame-options', 'permissions-policy']

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

test('the world page: by either name, with the page headers, its placeholders filled in and escaped', async () => {
  const app = await server({
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
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 200, url)
      assert.match(res.headers['content-type'], /^text\/html/, url)
      assert.equal(res.headers['content-security-policy'], PAGE_CSP, url)
      assert.equal(res.headers['x-frame-options'], 'DENY', url)
      assert.equal(res.headers['permissions-policy'], PAGE_PERMISSIONS, url)
      assert.equal(res.headers['x-content-type-options'], 'nosniff', url)
      assert.equal(res.headers['strict-transport-security'], undefined, url)
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
})

test('the pages are whole when a browser asks for them compressed', async () => {
  // a page longer than the size compression starts at, and an env script as large
  const long = 'x'.repeat(4000)
  const app = await server({ page: () => ({ title: long, desc: 'd', image: '', url: 'u' }) })
  try {
    for (const [encoding, decode] of [
      ['br', zlib.brotliDecompressSync],
      ['gzip', zlib.gunzipSync],
    ]) {
      for (const url of ['/', '/index.html']) {
        const res = await app.inject({ method: 'GET', url, headers: { 'accept-encoding': encoding } })
        assert.equal(res.statusCode, 200, url)
        assert.equal(res.headers['content-encoding'], encoding, url)
        const body = decode(res.rawPayload).toString()
        assert.ok(body.includes(`<title>${long}</title>`), `${url} over ${encoding}: ${body.length} characters`)
        assert.equal(res.headers['content-security-policy'], PAGE_CSP, url)
        assert.equal(res.headers['x-content-type-options'], 'nosniff', url)
      }
    }
  } finally {
    await app.close()
  }
  const big = await server()
  try {
    const plain = await big.inject({ method: 'GET', url: '/env.js', headers: { 'accept-encoding': 'identity' } })
    assert.equal(plain.body, 'globalThis.env = {}')
  } finally {
    await big.close()
  }
})

test('every other response: nosniff, and no page headers on what is not a page', async () => {
  const app = await server()
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
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, status, url)
      assert.match(String(res.headers['content-type']), type, url)
      assert.equal(res.headers['x-content-type-options'], 'nosniff', url)
      for (const name of PAGE_ONLY) assert.equal(res.headers[name], undefined, `${url}: ${name}`)
    }
    const env = await app.inject({ method: 'GET', url: '/env.js' })
    assert.equal(env.body, 'globalThis.env = {}')
  } finally {
    await app.close()
  }
})

test('HSTS: on every response when HSTS_MAX_AGE is set', async () => {
  const app = await server({ hstsMaxAge: 600 })
  try {
    for (const url of ['/', '/terms.html', '/env.js', '/status', '/no-such-file']) {
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.headers['strict-transport-security'], 'max-age=600', url)
    }
  } finally {
    await app.close()
  }
})
