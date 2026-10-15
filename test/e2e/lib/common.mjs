// Shared helpers for the e2e harness: paths relative to the repo, CLI args, result recording.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(E2E_DIR, '..', '..')
export const BUILD_ROOT = process.env.E2E_BUILD_ROOT ? path.resolve(process.env.E2E_BUILD_ROOT) : REPO_ROOT
export const OUT_DIR = process.env.E2E_OUT_DIR ? path.resolve(process.env.E2E_OUT_DIR) : path.join(E2E_DIR, 'out')
export const APPS_DIR = path.join(E2E_DIR, 'apps')

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function arg(name, fallback) {
  const match = process.argv.find(a => a.startsWith(`--${name}=`))
  if (match) return match.slice(name.length + 3)
  if (process.argv.includes(`--${name}`)) return true
  return fallback
}

export function ensureOut() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  return OUT_DIR
}

export function createResults(label) {
  const results = []
  const record = (ok, name, note = '') => {
    results.push({ ok, name, note })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ' -- ' + note : ''}`)
    return ok
  }
  const step = async (name, fn) => {
    try {
      const note = await fn()
      return record(true, name, typeof note === 'string' ? note : '')
    } catch (err) {
      return record(false, name, err?.message || String(err))
    }
  }
  const finish = () => {
    const failed = results.filter(r => !r.ok).length
    console.log(`== ${label}: ${results.length - failed}/${results.length} passed`)
    return failed
  }
  return { results, record, step, finish }
}

export const ok = (value, message) => {
  if (!value) throw new Error(message || 'assertion failed')
}
export const eq = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(`${message || 'mismatch'}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

// every harness wait is scaled for slow machines: E2E_TIMEOUT_SCALE, or 3x on CI runners by default
export const TIMEOUT_SCALE = Number(process.env.E2E_TIMEOUT_SCALE) || (process.env.CI ? 3 : 1)

export async function waitUntil(fn, { timeout = 15000, interval = 200, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout * TIMEOUT_SCALE
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`)
    await sleep(interval)
  }
}
