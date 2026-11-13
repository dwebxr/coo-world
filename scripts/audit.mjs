// `npm run audit:prod`: the advisories npm reports for the packages a production install holds
// (`npm audit --omit=dev --json`), judged here and not by npm's exit code.
//
// What fails the job:
//   - a high or critical advisory that audit-allowlist.json does not name
//   - an allowlisted advisory whose `expires` date has passed (the entry is good through that day, UTC)
//   - an allowlist entry that matches no reported high or critical advisory any more (stale: the list cannot rot)
//   - a package npm marks high or critical with no such advisory in its `via` chain (unexplained)
//   - no usable report (npm could not be run, its output is not JSON, it carries an `error` member or it is
//     not the report format this reads): a job that cannot audit does not pass
// Lower severities (info, low, moderate) are listed and do not fail.
//
// What this does not do: it reads only what the registry's audit endpoint returns for the lock file, on the
// day it runs. It does not look at dev dependencies, at code in this repository, or at whether a vulnerable
// function is ever called. An allowlist entry is a decision to tolerate a known advisory until a date; it
// changes nothing about the advisory.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LISTED_ONLY = new Set(['info', 'low', 'moderate'])
const RANK = ['info', 'low', 'moderate', 'high', 'critical']
// (a severity word this does not know fails like a critical one)
const fails = severity => !LISTED_ONLY.has(severity)
const rank = severity => (RANK.includes(severity) ? RANK.indexOf(severity) : RANK.length)
const worse = (a, b) => (rank(a) >= rank(b) ? a : b)

export class AuditUnavailable extends Error {}

/** The report object of `npm audit --json`, or an AuditUnavailable that says why there is none. */
export function parseAuditOutput(stdout) {
  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    throw new AuditUnavailable(`npm audit did not print JSON (${String(stdout ?? '').length} characters of output)`)
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new AuditUnavailable('npm audit printed JSON that is not a report object')
  }
  if ('error' in report) {
    const error = report.error
    const said = [report.message, error?.code, error?.summary, error?.detail].filter(s => typeof s === 'string' && s)
    throw new AuditUnavailable(`npm audit reported an error: ${said.join(' / ') || 'no message'}`)
  }
  if (report.auditReportVersion !== 2) {
    throw new AuditUnavailable(
      `unknown audit report version ${JSON.stringify(report.auditReportVersion)} (this reads 2)`
    )
  }
  const { vulnerabilities } = report
  if (!vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) {
    throw new AuditUnavailable('the audit report has no `vulnerabilities` object')
  }
  return report
}

// GHSA-xxxx-xxxx-xxxx from the advisory's URL; an advisory without one keeps its URL (or npm's number) as id
function advisoryId(advisory) {
  const ghsa = /GHSA(-[0-9a-z]{4}){3}/i.exec(String(advisory.url ?? ''))
  if (ghsa) return 'GHSA' + ghsa[0].slice(4).toLowerCase()
  return advisory.url ? String(advisory.url) : `npm:${advisory.source}`
}

/**
 * The root advisories of a report, one per id. A package's `via` holds advisories (objects) and the names of
 * other packages it inherits from (strings); each chain of names is followed down to the advisories.
 * `packages` lists every package the advisory is reported under. `unexplained` lists packages npm marks with
 * a failing severity although no failing advisory is found below them.
 */
export function collectAdvisories(report) {
  const { vulnerabilities } = report
  const byId = new Map()
  const unexplained = []
  for (const name of Object.keys(vulnerabilities)) {
    const seen = new Set()
    const reached = []
    const walk = pkg => {
      if (seen.has(pkg)) return
      seen.add(pkg)
      const via = Object.hasOwn(vulnerabilities, pkg) ? vulnerabilities[pkg]?.via : null
      for (const entry of Array.isArray(via) ? via : []) {
        if (typeof entry === 'string') walk(entry)
        else if (entry && typeof entry === 'object') reached.push(entry)
      }
    }
    walk(name)
    let explained = false
    for (const advisory of reached) {
      const id = advisoryId(advisory)
      const severity = String(advisory.severity ?? 'unknown')
      if (fails(severity)) explained = true
      let item = byId.get(id)
      if (!item) {
        item = { id, severity, title: String(advisory.title ?? ''), url: String(advisory.url ?? ''), packages: [] }
        item.package = String(advisory.name ?? advisory.dependency ?? '')
        item.range = String(advisory.range ?? '')
        byId.set(id, item)
      }
      item.severity = worse(item.severity, severity)
      if (!item.packages.includes(name)) item.packages.push(name)
    }
    const marked = String(vulnerabilities[name]?.severity ?? 'unknown')
    if (fails(marked) && !explained) unexplained.push({ package: name, severity: marked })
  }
  for (const item of byId.values()) item.packages.sort()
  return { advisories: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), unexplained }
}

const validDay = text => {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

/** The problems of an allowlist as sentences; none when every entry is { id, reason, expires: 'YYYY-MM-DD' }. */
export function allowlistProblems(allowlist) {
  if (!Array.isArray(allowlist)) return ['the allowlist is not an array of entries']
  const problems = []
  const ids = new Set()
  allowlist.forEach((entry, index) => {
    const at = `allowlist entry ${index + 1}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return problems.push(`${at} is not an object`)
    if (typeof entry.id !== 'string' || !entry.id) problems.push(`${at} has no \`id\``)
    else if (ids.has(entry.id)) problems.push(`${at} repeats ${entry.id}`)
    else ids.add(entry.id)
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(`${at} has no \`reason\``)
    if (!validDay(entry.expires)) problems.push(`${at} has no \`expires\` date written YYYY-MM-DD`)
  })
  return problems
}

/**
 * The verdict on one `npm audit --json` output.
 * @param {object} input
 * @param {string} input.stdout what npm printed
 * @param {Array<{id: string, reason: string, expires: string}>} input.allowlist
 * @param {string} input.today the day as YYYY-MM-DD (UTC)
 * @returns {{ ok: boolean, unavailable: string|null, failures: string[], tolerated: string[], listed: string[] }}
 *   `failures` is why the job fails (empty when ok), `tolerated` the allowlisted advisories that do not fail it
 *   today, `listed` the advisories of a lower severity.
 */
export function evaluateAudit({ stdout, allowlist, today }) {
  const result = { ok: false, unavailable: null, failures: [], tolerated: [], listed: [] }
  if (!validDay(today)) throw new Error('evaluateAudit needs today as YYYY-MM-DD')
  const problems = allowlistProblems(allowlist)
  if (problems.length) {
    result.unavailable = `audit unavailable: audit-allowlist.json cannot be used: ${problems.join('; ')}`
    return result
  }
  let report
  try {
    report = parseAuditOutput(stdout)
  } catch (err) {
    if (!(err instanceof AuditUnavailable)) throw err
    result.unavailable = `audit unavailable: ${err.message}`
    return result
  }
  const { advisories, unexplained } = collectAdvisories(report)
  const describe = a =>
    `${a.id} (${a.severity}) ${a.package}${a.range ? ' ' + a.range : ''}: ${a.title}; reported under ${a.packages.join(', ')}`
  const allowed = new Map(allowlist.map(entry => [entry.id, entry]))
  const used = new Set()
  for (const advisory of advisories) {
    if (!fails(advisory.severity)) {
      result.listed.push(describe(advisory))
      continue
    }
    const entry = allowed.get(advisory.id)
    if (!entry) {
      result.failures.push(`${describe(advisory)}; not in audit-allowlist.json`)
      continue
    }
    used.add(entry.id)
    // (dates written YYYY-MM-DD compare as text)
    if (today > entry.expires) {
      result.failures.push(`${describe(advisory)}; its allowlist entry expired on ${entry.expires}`)
    } else {
      result.tolerated.push(`${describe(advisory)}; allowlisted until ${entry.expires}: ${entry.reason}`)
    }
  }
  for (const { package: name, severity } of unexplained) {
    result.failures.push(`${name} is marked ${severity} and no advisory of that weight was found in its \`via\` chain`)
  }
  for (const entry of allowlist) {
    if (used.has(entry.id)) continue
    const lower = advisories.find(a => a.id === entry.id)
    result.failures.push(
      lower
        ? `stale allowlist entry ${entry.id}: the advisory is reported as ${lower.severity}, which does not fail; remove the entry`
        : `stale allowlist entry ${entry.id}: no reported advisory has this id; remove the entry`
    )
  }
  result.ok = result.failures.length === 0
  return result
}

/** The lines the job prints for a verdict. */
export function formatVerdict(verdict) {
  if (verdict.unavailable) return [verdict.unavailable]
  const lines = []
  const section = (title, items) => {
    if (!items.length) return
    lines.push(title)
    for (const item of items) lines.push(`  - ${item}`)
  }
  section('Lower severity (listed, does not fail):', verdict.listed)
  section('Tolerated until a date by audit-allowlist.json (known and not fixed):', verdict.tolerated)
  section('FAILING:', verdict.failures)
  lines.push(
    verdict.ok
      ? `audit: no high or critical advisory outside the allowlist (${verdict.tolerated.length} tolerated, ${verdict.listed.length} of lower severity)`
      : `audit: failed (${verdict.failures.length})`
  )
  return lines
}

function main() {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  let allowlist
  try {
    allowlist = JSON.parse(fs.readFileSync(path.join(rootDir, 'audit-allowlist.json'), 'utf8'))
  } catch (err) {
    console.error(`audit unavailable: audit-allowlist.json cannot be read: ${err.message}`)
    return 2
  }
  // npm exits 1 both when it finds something and when the registry does not answer, so only its output is read
  const npm = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  if (npm.error || npm.signal) {
    console.error(`audit unavailable: npm audit could not be run: ${npm.error?.message ?? `stopped by ${npm.signal}`}`)
    return 2
  }
  const verdict = evaluateAudit({ stdout: npm.stdout, allowlist, today: new Date().toISOString().slice(0, 10) })
  for (const line of formatVerdict(verdict)) (verdict.unavailable ? console.error : console.log)(line)
  if (verdict.unavailable) {
    const tail = String(npm.stderr ?? '')
      .trim()
      .split('\n')
      .slice(-5)
      .join('\n')
    if (tail) console.error(tail.slice(0, 1000))
    return 2
  }
  return verdict.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
