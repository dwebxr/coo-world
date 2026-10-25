import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkJwtSecret } from '../src/server/jwtSecret.js'

test('checkJwtSecret: a missing secret or the public template value stops the server', () => {
  for (const secret of [undefined, '', '   ', ' '.repeat(32), '\t\n']) {
    assert.throws(() => checkJwtSecret(secret, { warn: () => {} }), /JWT_SECRET not set: generate one/)
  }
  // spaces kept inside quotes and a different case are just as guessable
  for (const secret of ['hyper', 'hyper ', ' hyper', 'HYPER', 'Hyper', `hyper${' '.repeat(27)}`]) {
    assert.throws(() => checkJwtSecret(secret, { warn: () => {} }), /public template value/, JSON.stringify(secret))
  }
})

test('checkJwtSecret: a short secret warns once and still starts; a long one is quiet', () => {
  const warnings = []
  const warn = message => warnings.push(message)
  checkJwtSecret('e2e', { warn })
  // padding does not make a short secret long
  checkJwtSecret(`e2e${' '.repeat(40)}`, { warn })
  assert.deepEqual(warnings, [
    '[envs] JWT_SECRET is shorter than 32 characters: generate one with `openssl rand -hex 32`',
    '[envs] JWT_SECRET is shorter than 32 characters: generate one with `openssl rand -hex 32`',
  ])
  warnings.length = 0
  checkJwtSecret('a'.repeat(64), { warn })
  assert.deepEqual(warnings, [])
})
