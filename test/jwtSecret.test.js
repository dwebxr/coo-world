import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkJwtSecret, checkPreviousJwtSecret } from '../src/server/jwtSecret.js'

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

test('JWT_SECRET_PREVIOUS: unset is normal; set, it must be a real secret other than the current one', () => {
  const current = 'c'.repeat(40)
  const warned = (previous, now = current) => {
    const lines = []
    checkPreviousJwtSecret(previous, now, { warn: line => lines.push(line) })
    return lines
  }
  assert.deepEqual(warned(undefined), [])
  assert.deepEqual(warned(''), [])
  assert.throws(() => warned('   '), /JWT_SECRET_PREVIOUS is blank/)
  for (const template of ['hyper', ' HYPER ']) {
    assert.throws(() => warned(template), /public template value/)
  }
  assert.match(warned(current)[0], /same as JWT_SECRET/)
  const lines = warned('p'.repeat(40))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /accepted and renewed.*never set it to a secret that leaked/s)
  assert.ok(!lines[0].includes('p'.repeat(40)), 'the secret is not printed')
})
