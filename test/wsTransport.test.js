import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runSupervised } from './lib/supervised.mjs'

// Real TCP, real Fastify upgrade lifecycle and ws 8.22.0. Run outside restricted sandboxes if skipped.
const cases = [
  'pin',
  'fragpin',
  '300k-fragments',
  'refused-upgrade',
  'keepalive-upgrade',
  'abort-upgrade',
  'outdated',
  'non-reader',
]
for (const name of cases) {
  test(`transport: supervised ${name}`, async t => {
    const result = await runSupervised(new URL('./lib/wsTransport-child.mjs', import.meta.url), {
      heapMb: 64,
      args: [name],
      timeout: 20_000,
    })
    const verdict = JSON.parse(result.stdout.trim())
    if (verdict.skip) {
      if (process.env.CI) assert.fail(verdict.skip)
      t.skip(verdict.skip)
      return
    }
    assert.equal(verdict.ok, true)
    assert.equal(verdict.name, name)
  })
}
