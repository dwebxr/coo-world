import { clientIpKey } from './uploadLimits.js'

// Where browsers post what the world page's report-only policy (pageRoutes.js) would have refused, and what the
// server writes about it.
//
// What this is, and no more:
// - a log for the operator: which directive, what kind of thing it would have refused, and which script asked.
//   Nothing here blocks anything, and nothing reads the log back.
// - anyone can post to it, a browser or not: a line says what was POSTED. Someone can make lines up, and can fill
//   the hour's table of kinds so that a real one is only counted. The bounds below keep what that costs small
//   (bytes read, lines written); they do not make the lines true.
// - what is kept from a report: the directive's name, the origin of what was refused (or its scheme, or the word the
//   browser put there, as `inline` or `eval`), and the path of the asking script when it is the page's own (its
//   origin when it is not). Never a query string, a fragment, the page's address, the referrer, a script sample, or
//   the path of an extension's file (Firefox gives each install its own).
// - the bounds: PER_ADDRESS posts a minute from one address (IPv6: its /64) and PER_MINUTE in all, counted when
//   the request's headers have come and before any of its body is read, whatever becomes of the post; the rest are
//   answered 429 and counted (so the addresses remembered in a minute are PER_MINUTE at most). A body of
//   REPORT_MAX_BYTES at most, as sent: a compressed body is refused (415) before it is read (a browser does not
//   compress a report, and a decompressor reads input that the byte count never sees). A post over the rate, a
//   compressed one and one that is too long each end their connection, so the rest of the body is not read. KINDS_MAX different lines an
//   hour, each written when first seen and again at 10, 100, 1000 … of the same; one line of totals when an hour
//   with posts has passed (written when the next post comes: there is no timer).

export const REPORT_PATH = '/csp-report'
export const REPORT_MAX_BYTES = 8 * 1024
export const PER_ADDRESS = 20
export const PER_MINUTE = 600
export const KINDS_MAX = 100
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

const WORD = /^[a-z][a-z0-9-]{0,39}$/
const NETWORK = new Set(['http:', 'https:', 'ws:', 'wss:'])

const parse = value => {
  if (typeof value !== 'string' || !value || value.length > 4096) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

// a directive's name, or null
export function directiveName(value) {
  if (typeof value !== 'string') return null
  // older engines put the whole directive here ("script-src 'self' …"): its name is the first word
  const name = value.trim().split(/\s+/)[0].toLowerCase()
  return WORD.test(name) ? name : null
}

// what was refused: an origin, a scheme, or the browser's own word
export function blockedKind(value) {
  if (value === undefined || value === null || value === '') return 'nothing named'
  if (typeof value !== 'string') return 'other'
  const word = value.toLowerCase()
  if (WORD.test(word)) return word
  const url = parse(value)
  if (!url) return 'other'
  if (NETWORK.has(url.protocol)) return url.origin.slice(0, 120)
  return url.protocol
}

// the script that asked: its path when it is the page's own, else its origin or scheme
export function sourceKind(value, documentUri) {
  if (value === undefined || value === null || value === '') return 'nothing named'
  const url = parse(value)
  if (!url) return 'other'
  if (!NETWORK.has(url.protocol)) return url.protocol
  const page = parse(documentUri)
  if (page && page.origin === url.origin) return url.pathname.slice(0, 120)
  return url.origin.slice(0, 120)
}

// `{ directive, blocked, source }` from the body of a report (application/csp-report), or null
export function readReport(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  const report = body?.['csp-report']
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null
  const directive = directiveName(report['effective-directive']) || directiveName(report['violated-directive'])
  if (!directive) return null
  return {
    directive,
    blocked: blockedKind(report['blocked-uri']),
    source: sourceKind(report['source-file'], report['document-uri']),
  }
}

const powerOfTen = n => n >= 10 && /^10*$/.test(String(n))

export function createCspReports({ log = line => console.log(line), now = Date.now } = {}) {
  let minute = { start: now(), total: 0, addresses: new Map() }
  let hour = { start: now(), kinds: new Map(), reports: 0, uncounted: 0, refused: 0 }

  const roll = at => {
    if (at - minute.start >= MINUTE_MS) minute = { start: at, total: 0, addresses: new Map() }
    if (at - hour.start < HOUR_MS) return
    if (hour.reports || hour.refused) {
      log(
        `[csp] report-only, the hour to ${new Date(hour.start + HOUR_MS).toISOString()}: ${hour.reports} reports of ` +
          `${hour.kinds.size} kinds` +
          (hour.uncounted ? `, ${hour.uncounted} more of kinds past the first ${KINDS_MAX}` : '') +
          (hour.refused ? `, ${hour.refused} posts over the rate` : '')
      )
    }
    hour = { start: at, kinds: new Map(), reports: 0, uncounted: 0, refused: 0 }
  }

  // may this address post one more this minute?
  const admit = address => {
    const at = now()
    roll(at)
    const seen = minute.addresses.get(address) || 0
    if (minute.total >= PER_MINUTE || seen >= PER_ADDRESS) {
      hour.refused++
      return false
    }
    minute.total++
    minute.addresses.set(address, seen + 1)
    return true
  }

  // counts one report and writes its line when it is due; false when the body is not a report
  const take = text => {
    const report = readReport(text)
    if (!report) return false
    const key = `${report.directive} would refuse ${report.blocked}, asked by ${report.source}`
    const count = hour.kinds.get(key)
    if (count === undefined && hour.kinds.size >= KINDS_MAX) {
      hour.uncounted++
      return true
    }
    const next = (count || 0) + 1
    hour.kinds.set(key, next)
    hour.reports++
    if (next === 1) log(`[csp] report-only: ${key}`)
    else if (powerOfTen(next)) log(`[csp] report-only: ${key} (${next} this hour)`)
    return true
  }

  return { admit, take }
}

// POST /csp-report. Registered as its own plugin: the body parsers below are for this route alone.
export async function cspReportRoute(fastify, { reports = createCspReports(), clientIpHeader = null } = {}) {
  const text = (req, body, done) => done(null, body)
  // read as text and parsed here: a body that is not JSON is a 400 of this route
  fastify.removeContentTypeParser(['application/json', 'text/plain'])
  fastify.addContentTypeParser('application/csp-report', { parseAs: 'string' }, text)
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, text)
  // what the body parser refuses (too long: 413, another type: 415) is answered without the line the root handler
  // writes for a 4xx: nothing a post to this route does writes a line but the reports counted above
  fastify.setErrorHandler((err, req, reply) => {
    const code = err?.statusCode
    if (Number.isInteger(code) && code >= 400 && code < 500) return reply.code(code).send()
    throw err
  })
  // before the body: the rate (a post counts whatever it turns out to be), and no encoding to undo (the
  // compression plugin would decompress the body before the byte count sees it)
  // A post refused here is answered with `Connection: close`: the connection ends with the answer. Left open, the
  // HTTP layer would read the refused body to its end, whatever its length, to get to the next request.
  fastify.addHook('onRequest', async (req, reply) => {
    const address = clientIpKey(clientIpHeader ? req.headers[clientIpHeader] : undefined, req.ip)
    const refuse = code => reply.code(code).header('Connection', 'close').send()
    if (!reports.admit(address)) return refuse(429)
    const encoding = req.headers['content-encoding']
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') return refuse(415)
  })
  fastify.post(REPORT_PATH, { bodyLimit: REPORT_MAX_BYTES }, async (req, reply) => {
    return reply.code(reports.take(req.body) ? 204 : 400).send()
  })
}
