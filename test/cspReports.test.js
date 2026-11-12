import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import compress from '@fastify/compress'
import { compressOptions } from '../src/server/compressOptions.js'
import { errorHandler } from '../src/server/errorHandler.js'
import {
  KINDS_MAX,
  PER_ADDRESS,
  PER_MINUTE,
  REPORT_MAX_BYTES,
  REPORT_PATH,
  blockedKind,
  createCspReports,
  cspReportRoute,
  directiveName,
  readReport,
  sourceKind,
} from '../src/server/cspReports.js'

const report = (fields = {}) =>
  JSON.stringify({
    'csp-report': {
      'document-uri': 'https://w.example/?invite=secret#frag',
      referrer: 'https://from.example/private',
      'effective-directive': 'script-src-elem',
      'violated-directive': 'script-src-elem',
      'original-policy': "default-src 'self'",
      'blocked-uri': 'inline',
      'source-file': 'https://w.example/app-ABC.js?token=secret#x',
      'line-number': 7,
      'script-sample': 'steal(document.cookie)',
      ...fields,
    },
  })

test('the bounds are the ones documented', () => {
  assert.equal(REPORT_PATH, '/csp-report')
  assert.equal(REPORT_MAX_BYTES, 8192)
  assert.equal(PER_ADDRESS, 20)
  assert.equal(PER_MINUTE, 600)
  assert.equal(KINDS_MAX, 100)
})

test('directiveName: a directive name, also from the older whole-directive form; anything else is none', () => {
  assert.equal(directiveName('script-src-elem'), 'script-src-elem')
  assert.equal(directiveName("script-src 'self' https://a.example"), 'script-src')
  assert.equal(directiveName('  Frame-Src  '), 'frame-src')
  for (const bad of [undefined, null, 7, {}, [], '', ' ', '1abc', 'a_b', 'x'.repeat(41), "'self'", 'a;b']) {
    assert.equal(directiveName(bad), null, String(bad))
  }
  // a line break ends the name: what follows it is never part of what is logged
  assert.equal(directiveName('a\nb\n[csp] made up'), 'a')
})

test('blockedKind: an origin, a scheme or the browser word; never a path, a query or an extension id', () => {
  assert.equal(blockedKind('inline'), 'inline')
  assert.equal(blockedKind('eval'), 'eval')
  assert.equal(blockedKind('Wasm-Eval'), 'wasm-eval')
  assert.equal(blockedKind('https://evil.example/a/b.js?q=secret#f'), 'https://evil.example')
  assert.equal(blockedKind('http://user:pass@h.example:8080/x'), 'http://h.example:8080')
  assert.equal(blockedKind('wss://relay.example/socket?auth=secret'), 'wss://relay.example')
  assert.equal(blockedKind('moz-extension://0d7b1a2e-1111-2222-3333-444455556666/inject.js'), 'moz-extension:')
  assert.equal(blockedKind('chrome-extension://abcdefghijklmnop/x.js'), 'chrome-extension:')
  assert.equal(blockedKind('data:text/html,<script>secret</script>'), 'data:')
  assert.equal(blockedKind('blob:https://w.example/0d7b1a2e'), 'blob:')
  assert.equal(blockedKind(''), 'nothing named')
  assert.equal(blockedKind(undefined), 'nothing named')
  assert.equal(blockedKind(null), 'nothing named')
  for (const other of [7, {}, ['inline'], 'not a url at all', '//host/path', 'x'.repeat(5000), 'a b\n[csp] made up']) {
    assert.equal(blockedKind(other), 'other', String(other).slice(0, 30))
  }
  assert.ok(blockedKind(`https://${'a'.repeat(300)}.example/`).length <= 120)
})

test('sourceKind: the path of one of the page own files, the origin of another host, the scheme of the rest', () => {
  const page = 'https://w.example/?invite=secret'
  assert.equal(sourceKind('https://w.example/app-ABC.js?token=secret#x', page), '/app-ABC.js')
  assert.equal(sourceKind('https://w.example/', page), '/')
  assert.equal(sourceKind('https://cdnjs.cloudflare.com/ajax/libs/x/y.js?k=1', page), 'https://cdnjs.cloudflare.com')
  // the same host on another port or scheme is another origin
  assert.equal(sourceKind('http://w.example/app.js', page), 'http://w.example')
  assert.equal(sourceKind('https://w.example:8443/app.js', page), 'https://w.example:8443')
  assert.equal(sourceKind('moz-extension://0d7b1a2e-1111/inject.js', page), 'moz-extension:')
  assert.equal(sourceKind('', page), 'nothing named')
  assert.equal(sourceKind(undefined, page), 'nothing named')
  assert.equal(sourceKind('nonsense', page), 'other')
  assert.equal(sourceKind(7, page), 'other')
  // without a page address to compare with, a network file is named by its origin
  assert.equal(sourceKind('https://w.example/app.js', undefined), 'https://w.example')
  assert.equal(sourceKind('https://w.example/app.js', 'nonsense'), 'https://w.example')
  assert.ok(sourceKind(`https://w.example/${'a'.repeat(500)}.js`, page).length <= 120)
  // a path with a space or a line break in it comes out encoded
  assert.equal(sourceKind('https://w.example/a b\n[csp] made up.js', page), '/a%20b[csp]%20made%20up.js')
})

test('readReport: three fields and nothing else of what was posted', () => {
  assert.deepEqual(readReport(report()), { directive: 'script-src-elem', blocked: 'inline', source: '/app-ABC.js' })
  // the effective directive is preferred; the violated one serves when it is missing or not a name
  assert.equal(
    readReport(report({ 'effective-directive': 'img-src', 'violated-directive': 'x-src' })).directive,
    'img-src'
  )
  assert.equal(
    readReport(report({ 'effective-directive': undefined, 'violated-directive': "frame-src 'self'" })).directive,
    'frame-src'
  )
  assert.equal(
    readReport(report({ 'effective-directive': 7, 'violated-directive': 'style-src' })).directive,
    'style-src'
  )
  const text = JSON.stringify(readReport(report()))
  for (const secret of ['secret', 'from.example', 'steal', 'invite', 'token', 'default-src']) {
    assert.equal(text.includes(secret), false, secret)
  }
  for (const bad of [
    '',
    '{nope',
    'null',
    '7',
    '"csp-report"',
    '[]',
    '{}',
    '{"csp-report":null}',
    '{"csp-report":[]}',
    '{"csp-report":"x"}',
    '{"csp-report":{}}',
    report({ 'effective-directive': undefined, 'violated-directive': undefined }),
    report({ 'effective-directive': '!!', 'violated-directive': {} }),
  ]) {
    assert.equal(readReport(bad), null, bad.slice(0, 40))
  }
})

function reports(start = Date.UTC(2026, 10, 12, 0, 0, 0)) {
  const lines = []
  const clock = { at: start }
  const made = createCspReports({ log: line => lines.push(line), now: () => clock.at })
  return { ...made, lines, clock }
}

test('a kind of report is written when first seen and at 10, 100, 1000 of the same', () => {
  const r = reports()
  for (let i = 0; i < 1000; i++) assert.equal(r.take(report()), true)
  const line = '[csp] report-only: script-src-elem would refuse inline, asked by /app-ABC.js'
  assert.deepEqual(r.lines, [line, `${line} (10 this hour)`, `${line} (100 this hour)`, `${line} (1000 this hour)`])
  // another kind has its own line and its own count
  r.take(report({ 'blocked-uri': 'https://evil.example/x.js' }))
  assert.equal(
    r.lines.at(-1),
    '[csp] report-only: script-src-elem would refuse https://evil.example, asked by /app-ABC.js'
  )
  assert.equal(r.lines.length, 5)
  // what is not a report writes nothing
  assert.equal(r.take('{nope'), false)
  assert.equal(r.take('{}'), false)
  assert.equal(r.lines.length, 5)
})

test('an hour has room for a fixed number of kinds; the rest are counted, and the hour ends in one line', () => {
  const r = reports()
  for (let i = 0; i < KINDS_MAX; i++) r.take(report({ 'blocked-uri': `https://h${i}.example/` }))
  assert.equal(r.lines.length, KINDS_MAX)
  // new kinds past the table: counted, not written
  for (let i = 0; i < 7; i++) assert.equal(r.take(report({ 'blocked-uri': `https://more${i}.example/` })), true)
  assert.equal(r.lines.length, KINDS_MAX)
  // a kind already in the table still counts
  for (let i = 0; i < 9; i++) r.take(report({ 'blocked-uri': 'https://h0.example/' }))
  assert.equal(r.lines.length, KINDS_MAX + 1)
  assert.match(r.lines.at(-1), /would refuse https:\/\/h0\.example, asked by \/app-ABC\.js \(10 this hour\)$/)
  // one millisecond short of the hour: nothing yet
  r.clock.at += 3_600_000 - 1
  assert.equal(r.admit('203.0.113.1'), true)
  assert.equal(r.lines.length, KINDS_MAX + 1)
  // the hour has passed: its line comes with the next post, and the table is empty again
  r.clock.at += 1
  assert.equal(r.admit('203.0.113.1'), true)
  assert.equal(
    r.lines.at(-1),
    `[csp] report-only, the hour to 2026-11-12T01:00:00.000Z: ${KINDS_MAX + 9} reports of ${KINDS_MAX} kinds, ` +
      `7 more of kinds past the first ${KINDS_MAX}`
  )
  r.take(report({ 'blocked-uri': 'https://more0.example/' }))
  assert.match(r.lines.at(-1), /^\[csp\] report-only: script-src-elem would refuse https:\/\/more0\.example,/)
  // an hour with nothing in it writes no line
  const count = r.lines.length
  r.clock.at += 3_600_000
  r.admit('203.0.113.1')
  assert.equal(r.lines.length, count + 1, 'the hour that had one report')
  r.clock.at += 3_600_000
  r.admit('203.0.113.1')
  assert.equal(r.lines.length, count + 1, 'the hour that had none')
})

test('admit: a number of posts a minute from one address, and a number in all', () => {
  const r = reports()
  for (let i = 0; i < PER_ADDRESS; i++) assert.equal(r.admit('203.0.113.1'), true, `post ${i}`)
  assert.equal(r.admit('203.0.113.1'), false)
  assert.equal(r.admit('203.0.113.2'), true, 'another address is not held back by the first')
  // the next minute starts over
  r.clock.at += 59_999
  assert.equal(r.admit('203.0.113.1'), false)
  r.clock.at += 1
  assert.equal(r.admit('203.0.113.1'), true)

  // in all: the first PER_MINUTE posts of a minute, whoever sends them
  const all = reports()
  for (let i = 0; i < PER_MINUTE; i++) assert.equal(all.admit(`198.51.100.${i}`), true, `post ${i}`)
  assert.equal(all.admit('192.0.2.1'), false)
  assert.equal(all.admit('198.51.100.0'), false)
  all.clock.at += 60_000
  assert.equal(all.admit('192.0.2.1'), true)

  // what was refused is in the hour's line
  r.clock.at += 3_600_000
  r.admit('203.0.113.1')
  assert.equal(
    r.lines.at(-1),
    '[csp] report-only, the hour to 2026-11-12T01:00:00.000Z: 0 reports of 0 kinds, 2 posts over the rate'
  )
})

async function app({ header = null, made = reports() } = {}) {
  const server = Fastify()
  const logged = []
  // as the server registers them: compression, the root error handler, then the route
  server.register(compress, compressOptions())
  server.setErrorHandler((err, req, reply) => {
    logged.push(err?.statusCode ?? err?.message)
    return errorHandler(err, req, reply)
  })
  server.register(cspReportRoute, { reports: made, clientIpHeader: header })
  server.post('/other', async req => ({ got: req.body }))
  await server.ready()
  const post = (payload, { type = 'application/csp-report', url = REPORT_PATH, headers = {}, remoteAddress } = {}) =>
    server.inject({
      method: 'POST',
      url,
      payload,
      remoteAddress,
      headers: { 'content-type': type, 'accept-encoding': 'gzip, br', ...headers },
    })
  return { server, post, logged, made }
}

test('POST /csp-report: 204 for a report, 400 for what is not one, and the parser refusals without a log line', async t => {
  const { server, post, logged, made } = await app()
  t.after(() => server.close())
  const errors = t.mock.method(console, 'error', () => {})
  let res = await post(report())
  assert.equal(res.statusCode, 204)
  assert.equal(res.body, '')
  assert.equal(res.headers['content-encoding'], undefined)
  assert.equal((await post(report(), { type: 'application/json' })).statusCode, 204)
  assert.equal((await post(report(), { type: 'application/csp-report; charset=utf-8' })).statusCode, 204)
  assert.equal((await post('{nope')).statusCode, 400)
  assert.equal((await post('{}', { type: 'application/json' })).statusCode, 400)
  assert.equal((await post(report(), { type: 'text/plain' })).statusCode, 415)
  assert.equal((await post(report(), { type: 'application/reports+json' })).statusCode, 415)
  // the longest body read, and one byte more
  const pad = n => report({ 'script-sample': 'x'.repeat(n - report({ 'script-sample': '' }).length) })
  assert.equal(pad(REPORT_MAX_BYTES).length, REPORT_MAX_BYTES)
  assert.equal((await post(pad(REPORT_MAX_BYTES))).statusCode, 204)
  assert.equal((await post(pad(REPORT_MAX_BYTES + 1))).statusCode, 413)
  // none of the refusals reached the root handler or wrote a line
  assert.deepEqual(logged, [])
  assert.equal(errors.mock.callCount(), 0)
  assert.deepEqual(made.lines, ['[csp] report-only: script-src-elem would refuse inline, asked by /app-ABC.js'])
  // the route has no other method
  assert.equal((await server.inject({ method: 'GET', url: REPORT_PATH })).statusCode, 404)
  // the body parsers of other routes are as they were
  res = await post('{"a":1}', { type: 'application/json', url: '/other' })
  assert.deepEqual(res.json(), { got: { a: 1 } })
  assert.equal((await post('{nope', { type: 'application/json', url: '/other' })).statusCode, 400)
  assert.deepEqual(logged, [400])
})

test('POST /csp-report: the rate is kept by address, read where the server reads addresses', async t => {
  // no header named: the connection's address
  const direct = await app()
  t.after(() => direct.server.close())
  for (let i = 0; i < PER_ADDRESS; i++) {
    const res = await direct.post(report(), {
      remoteAddress: '203.0.113.1',
      headers: { 'fly-client-ip': `198.51.100.${i}` },
    })
    assert.equal(res.statusCode, 204, `post ${i}`)
  }
  let res = await direct.post(report(), {
    remoteAddress: '203.0.113.1',
    headers: { 'fly-client-ip': '198.51.100.200' },
  })
  assert.equal(res.statusCode, 429)
  assert.equal(res.body, '')
  assert.equal((await direct.post(report(), { remoteAddress: '203.0.113.2' })).statusCode, 204)
  // a post over the rate is not read as a report
  assert.equal(direct.made.lines.length, 2, direct.made.lines.join('\n'))
  assert.match(direct.made.lines[1], /\(10 this hour\)$/)

  // a header named: the address the proxy wrote there; an IPv6 address counts with its /64
  const proxied = await app({ header: 'fly-client-ip' })
  t.after(() => proxied.server.close())
  for (let i = 0; i < PER_ADDRESS; i++) {
    res = await proxied.post(report(), {
      remoteAddress: '203.0.113.1',
      headers: { 'fly-client-ip': `2001:db8:1:2::${i}` },
    })
    assert.equal(res.statusCode, 204, `post ${i}`)
  }
  res = await proxied.post(report(), {
    remoteAddress: '203.0.113.9',
    headers: { 'fly-client-ip': '2001:db8:1:2:ffff::1' },
  })
  assert.equal(res.statusCode, 429)
  res = await proxied.post(report(), { remoteAddress: '203.0.113.1', headers: { 'fly-client-ip': '2001:db8:1:3::1' } })
  assert.equal(res.statusCode, 204)
})

test('POST /csp-report: a fault of the server itself still reaches the root handler', async t => {
  const { server, post, logged } = await app({
    made: {
      admit: () => true,
      take() {
        throw new Error('disk on fire')
      },
    },
  })
  t.after(() => server.close())
  t.mock.method(console, 'error', () => {})
  assert.equal((await post(report())).statusCode, 500)
  assert.deepEqual(logged, ['disk on fire'])
})
