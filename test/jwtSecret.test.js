import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkJwtSecret } from '../src/server/jwtSecret.js'

test('checkJwtSecret: a missing secret or the public template value stops the server', () => {
  for (const secret of [undefined, '']) {
    assert.throws(() => checkJwtSecret(secret, { warn: () => {} }), /JWT_SECRET not set: generate one/)
  }
  assert.throws(() => checkJwtSecret('hyper', { warn: () => {} }), /public template value/)
})

test('checkJwtSecret: a short secret warns once and still starts; a long one is quiet', () => {
  const warnings = []
  const warn = message => warnings.push(message)
  checkJwtSecret('e2e', { warn })
  assert.deepEqual(warnings, ['[envs] JWT_SECRET is shorter than 32 characters: generate one with `openssl rand -hex 32`'])
  warnings.length = 0
  checkJwtSecret('a'.repeat(64), { warn })
  assert.deepEqual(warnings, [])
})
