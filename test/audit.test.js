// `npm run audit:prod` (scripts/audit.mjs): the verdict on canned `npm audit --json` outputs. The advisories are
// found by walking each package's `via` chain, counted once per id and judged by their own severity; npm's exit
// code is not an input. Nothing here runs npm or reaches the registry.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { allowlistProblems, collectAdvisories, evaluateAudit, formatVerdict } from '../scripts/audit.mjs'

const TODAY = '2026-11-13'
const advisory = (name, ghsa, severity, title = `${name} does something wrong`) => ({
  source: 1,
  name,
  dependency: name,
  title,
  url: `https://github.com/advisories/${ghsa}`,
  severity,
  range: '<=1.0.0',
})
const pkg = (name, severity, via) => ({ name, severity, isDirect: false, via, effects: [], range: '*', nodes: [] })
const report = vulnerabilities => JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: {} })
const judge = (stdout, allowlist = [], today = TODAY) => evaluateAudit({ stdout, allowlist, today })

const HIGH = 'GHSA-aaaa-bbbb-cccc'
const MODERATE = 'GHSA-dddd-eeee-ffff'
// one high advisory in `leaf`, inherited by `middle` and by `top` through package names only
const chained = {
  top: pkg('top', 'high', ['middle']),
  middle: pkg('middle', 'high', ['leaf']),
  leaf: pkg('leaf', 'high', [advisory('leaf', HIGH, 'high', 'leaf overflows')]),
}
const entry = (id, expires, reason = 'known, the fix is a breaking upgrade') => ({ id, reason, expires })

test('a clean report passes and lists nothing', () => {
  const verdict = judge(report({}))
  assert.deepEqual(verdict, { ok: true, unavailable: null, failures: [], tolerated: [], listed: [] })
  assert.match(formatVerdict(verdict).join('\n'), /no high or critical advisory outside the allowlist/)
})

test('a high advisory reached through a chain of package names fails', () => {
  // `top` names only `middle`, which names only `leaf`: the advisory is two names below `top`
  const { advisories, unexplained } = collectAdvisories({ vulnerabilities: { top: chained.top, ...chained } })
  assert.deepEqual(unexplained, [])
  assert.equal(advisories.length, 1)
  assert.equal(advisories[0].id, HIGH)
  assert.ok(advisories[0].packages.includes('top'))
  const verdict = judge(report(chained))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.failures.length, 1)
  assert.match(verdict.failures[0], new RegExp(`^${HIGH} \\(high\\) leaf <=1\\.0\\.0: leaf overflows`))
  assert.match(verdict.failures[0], /not in audit-allowlist\.json$/)
})

test('the same advisory under three packages is counted once', () => {
  const { advisories } = collectAdvisories(JSON.parse(report(chained)))
  assert.equal(advisories.length, 1)
  assert.deepEqual(advisories[0].packages, ['leaf', 'middle', 'top'])
  const verdict = judge(report(chained))
  assert.equal(verdict.failures.length, 1)
  assert.match(verdict.failures[0], /reported under leaf, middle, top/)
})

test('packages that name each other in `via` do not loop', () => {
  const looped = {
    a: pkg('a', 'high', ['b']),
    b: pkg('b', 'high', ['a', advisory('b', HIGH, 'high')]),
  }
  const { advisories } = collectAdvisories(JSON.parse(report(looped)))
  assert.equal(advisories.length, 1)
  assert.deepEqual(advisories[0].packages, ['a', 'b'])
})

test('an allowlisted advisory does not fail before its date, the date included', () => {
  for (const today of ['2026-11-13', '2027-02-11']) {
    const verdict = judge(report(chained), [entry(HIGH, '2027-02-11')], today)
    assert.equal(verdict.ok, true, today)
    assert.deepEqual(verdict.failures, [])
    assert.equal(verdict.tolerated.length, 1)
    assert.match(verdict.tolerated[0], /allowlisted until 2027-02-11: known, the fix is a breaking upgrade$/)
  }
})

test('an allowlisted advisory fails after its date and the message names it', () => {
  const verdict = judge(report(chained), [entry(HIGH, '2027-02-11')], '2027-02-12')
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.tolerated, [])
  assert.equal(verdict.failures.length, 1)
  assert.match(verdict.failures[0], new RegExp(`^${HIGH} `))
  assert.match(verdict.failures[0], /its allowlist entry expired on 2027-02-11$/)
})

test('an allowlist entry that matches no reported advisory is stale and fails', () => {
  const clean = judge(report({}), [entry(HIGH, '2027-02-11')])
  assert.equal(clean.ok, false)
  assert.deepEqual(clean.failures, [
    `stale allowlist entry ${HIGH}: no reported advisory has this id; remove the entry`,
  ])
  // next to an advisory that is allowlisted and current, the stale one still fails the job
  const other = 'GHSA-1111-2222-3333'
  const mixed = judge(report(chained), [entry(HIGH, '2027-02-11'), entry(other, '2027-02-11')])
  assert.equal(mixed.ok, false)
  assert.equal(mixed.tolerated.length, 1)
  assert.deepEqual(mixed.failures, [
    `stale allowlist entry ${other}: no reported advisory has this id; remove the entry`,
  ])
})

test('an allowlist entry for an advisory that is reported below high is stale too', () => {
  const moderate = { lib: pkg('lib', 'moderate', [advisory('lib', MODERATE, 'moderate')]) }
  const verdict = judge(report(moderate), [entry(MODERATE, '2027-02-11')])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.listed.length, 1)
  assert.match(verdict.failures[0], /^stale allowlist entry GHSA-dddd-eeee-ffff: the advisory is reported as moderate/)
})

test('moderate advisories only: listed, not failing', () => {
  const moderate = {
    lib: pkg('lib', 'moderate', [advisory('lib', MODERATE, 'moderate', 'lib is slow on nested input')]),
    user: pkg('user', 'moderate', ['lib']),
  }
  const verdict = judge(report(moderate))
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.failures, [])
  assert.equal(verdict.listed.length, 1)
  assert.match(verdict.listed[0], /^GHSA-dddd-eeee-ffff \(moderate\) lib <=1\.0\.0: lib is slow on nested input/)
  assert.match(formatVerdict(verdict).join('\n'), /Lower severity \(listed, does not fail\)/)
})

test('a critical advisory fails, and so does a severity word this does not know', () => {
  for (const severity of ['critical', 'catastrophic']) {
    const verdict = judge(report({ lib: pkg('lib', severity, [advisory('lib', HIGH, severity)]) }))
    assert.equal(verdict.ok, false, severity)
    assert.equal(verdict.failures.length, 1)
  }
})

test('a package marked high with no advisory below it fails as unexplained', () => {
  const verdict = judge(report({ top: pkg('top', 'high', ['gone']) }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures[0], /^top is marked high and no advisory of that weight was found/)
})

test('a report with an `error` member is "audit unavailable"', () => {
  // what npm 10 prints when the registry does not answer (its exit code is 1, as for a finding)
  const stdout = JSON.stringify({
    message: 'request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: ECONNREFUSED',
    error: { summary: '', detail: '' },
  })
  const verdict = judge(stdout)
  assert.equal(verdict.ok, false)
  assert.match(verdict.unavailable, /^audit unavailable: npm audit reported an error: request to https:.* failed/)
  assert.deepEqual(formatVerdict(verdict), [verdict.unavailable])
  // also with an allowlist that would otherwise be judged stale: nothing is concluded from no report
  assert.deepEqual(judge(stdout, [entry(HIGH, '2027-02-11')]).failures, [])
})

test('output that is not a report is "audit unavailable"', () => {
  for (const stdout of ['', 'npm error code E503', '{"auditReportVersion":2,"vulnerabil', '[]', 'null', '{}']) {
    const verdict = judge(stdout)
    assert.equal(verdict.ok, false, JSON.stringify(stdout))
    assert.match(verdict.unavailable, /^audit unavailable: /, JSON.stringify(stdout))
  }
  // a report of another format version, or without the member that is read, is not taken for a clean one
  assert.match(judge(JSON.stringify({ auditReportVersion: 3, vulnerabilities: {} })).unavailable, /report version 3/)
  assert.match(judge(JSON.stringify({ auditReportVersion: 2 })).unavailable, /no `vulnerabilities` object/)
})

test('an allowlist that is not { id, reason, expires } entries makes the audit unavailable', () => {
  assert.deepEqual(allowlistProblems([entry(HIGH, '2027-02-11')]), [])
  assert.equal(allowlistProblems({}).length, 1)
  assert.equal(allowlistProblems([entry(HIGH, '2027-02-30')]).length, 1)
  assert.equal(allowlistProblems([entry(HIGH, '11/02/2027')]).length, 1)
  assert.equal(allowlistProblems([{ id: HIGH, expires: '2027-02-11' }]).length, 1)
  assert.equal(allowlistProblems([entry(HIGH, '2027-02-11'), entry(HIGH, '2027-03-01')]).length, 1)
  const verdict = judge(report({}), [{ id: HIGH, reason: ' ', expires: '2027-02-11' }])
  assert.equal(verdict.ok, false)
  assert.match(
    verdict.unavailable,
    /^audit unavailable: audit-allowlist\.json cannot be used: allowlist entry 1 has no `reason`/
  )
})

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8')

// What npm 10.9 printed for this repository on 2026-11-13 while @solana/spl-token was a production dependency
// (test/fixtures/npm-audit-prod-2026-11-13.json): one high advisory, in bigint-buffer, which
// @solana/buffer-layout-utils and @solana/spl-token inherit, and four moderate ones. A record of that day, not of
// what the registry says now; here it is the real report with a high advisory, judged with allowlists of the test.
test('the report of 2026-11-13 with @solana/spl-token in production: its high advisory passes only while allowlisted', () => {
  const stdout = read('./fixtures/npm-audit-prod-2026-11-13.json')
  const allowlist = [entry('GHSA-3gc7-fjrx-p6mg', '2027-02-11')]
  const verdict = judge(stdout, allowlist)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.tolerated.length, 1)
  assert.match(verdict.tolerated[0], /^GHSA-3gc7-fjrx-p6mg \(high\) bigint-buffer <=1\.1\.5: /)
  assert.match(verdict.tolerated[0], /reported under @solana\/buffer-layout-utils, @solana\/spl-token, bigint-buffer;/)
  assert.equal(verdict.listed.length, 4)
  // without the entry the same report fails, once
  const bare = judge(stdout, [])
  assert.equal(bare.ok, false)
  assert.equal(bare.failures.length, 1)
  assert.match(bare.failures[0], /^GHSA-3gc7-fjrx-p6mg \(high\) bigint-buffer .*; not in audit-allowlist\.json$/)
  // and the day after the entry's date it fails again
  const late = judge(stdout, allowlist, '2027-02-12')
  assert.equal(late.ok, false)
  assert.match(late.failures[0], /its allowlist entry expired on 2027-02-11$/)
})

// The same day once @solana/spl-token was a dev dependency (test/fixtures/npm-audit-prod-2026-11-13-no-spl-token.json):
// the four moderate advisories (stream-json, uuid, below @solana/web3.js) and no high one.
test('the report of 2026-11-13 without @solana/spl-token, with the committed allowlist: four listed, nothing failing', () => {
  const stdout = read('./fixtures/npm-audit-prod-2026-11-13-no-spl-token.json')
  const allowlist = JSON.parse(read('../audit-allowlist.json'))
  assert.deepEqual(allowlistProblems(allowlist), [])
  assert.deepEqual(
    allowlist.map(entry => entry.id),
    []
  )
  assert.doesNotMatch(stdout, /bigint-buffer|spl-token|GHSA-3gc7-fjrx-p6mg/)
  const verdict = judge(stdout, allowlist)
  assert.deepEqual(verdict.failures, [])
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.tolerated, [])
  assert.equal(verdict.listed.length, 4)
  assert.ok(verdict.listed.every(line => / \(moderate\) /.test(line)))
  // the entry this file held before would be stale against this report, and fail the job
  const stale = judge(stdout, [entry('GHSA-3gc7-fjrx-p6mg', '2027-02-11')])
  assert.equal(stale.ok, false)
  assert.deepEqual(stale.failures, [
    'stale allowlist entry GHSA-3gc7-fjrx-p6mg: no reported advisory has this id; remove the entry',
  ])
})
