import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPublicEnv,
  buildPublicEnvDefines,
  isPublicEnvKey,
  PUBLIC_ENV_NAMES,
  SERVER_PUBLIC_ENV_NAMES,
  unlistedPublicEnv,
  unlistedPublicEnvNote,
} from '../src/core/extras/publicEnv.js'
import { browserInputs, codeOf, sourceFiles, stripComments } from './lib/sourceScan.mjs'

const env = {
  PUBLIC_RPC_URL: 'https://sentinel.invalid/?api-key=T1_SENTINEL',
  SOLANA_RPC_URL: 'https://server.invalid/?api-key=SERVER_SECRET',
  PUBLIC_TOKEN_MINT: '1'.repeat(32),
  PUBLIC_DEBUG: '',
  PUBLIC_WALLETCONNECT_PROJECT_ID: 'a "quoted" id\nnext line',
  // names nothing reads: the first two are what the list is for, a secret under a PUBLIC_ name
  PUBLIC_ADMIN_PASSWORD: 'UNLISTED_SECRET_1',
  PUBLIC_EVM_RPC_URL: 'https://rpc.invalid/v2/UNLISTED_SECRET_2',
  PUBLIC_LABEL: 'UNLISTED_VALUE_3',
  PUBLIC_: 'UNLISTED_VALUE_4',
  PUBLIC_API_URL: 'https://world.invalid/api',
  PRIVATE_KEY: 'private',
}

test('publicEnv: a name is handed to the page when it is on the list, whatever its prefix says', () => {
  assert.deepEqual(
    [...PUBLIC_ENV_NAMES].sort(),
    [
      'PUBLIC_DEBUG',
      'PUBLIC_EVM_CHAIN_IDS',
      'PUBLIC_EVM_TIP_TOKENS',
      'PUBLIC_PLAYER_COLLISION',
      'PUBLIC_REQUIRED_TOKEN_AMOUNT',
      'PUBLIC_TOKEN_MINT',
      'PUBLIC_WALLETCONNECT_PROJECT_ID',
      'PUBLIC_WS_URL',
    ],
    'the list changed: CHANGELOG and this test say what /env.js serves'
  )
  for (const key of PUBLIC_ENV_NAMES) assert.equal(isPublicEnvKey(key), true, key)
  for (const key of [
    'PUBLIC_RPC_URL',
    'PUBLIC_RPC_URL_EXTRA',
    'PUBLIC_EVM_RPC_URL',
    'PUBLIC_',
    'PUBLIC_ANYTHING',
    'PUBLIC_API_URL',
    'PUBLIC_MAX_UPLOAD_SIZE',
    'PUBLIC_TOKEN_DECIMALS',
    'PUBLIC_WS_URL_2',
    'public_ws_url',
    'SOLANA_RPC_URL',
    'EVM_RPC_URL_137',
    'PRIVATE_KEY',
    'X_PUBLIC_WS_URL',
    '',
  ]) {
    assert.equal(isPublicEnvKey(key), false, key)
  }
  assert.equal(Object.isFrozen(PUBLIC_ENV_NAMES), true)
  assert.equal(Object.isFrozen(SERVER_PUBLIC_ENV_NAMES), true)
  assert.deepEqual(
    PUBLIC_ENV_NAMES.filter(name => SERVER_PUBLIC_ENV_NAMES.includes(name)),
    [],
    'a name is served or the server keeps it, not both'
  )
})

test('/env.js: the listed names that are set, and no other PUBLIC_ name', () => {
  const publicEnv = buildPublicEnv(env)
  assert.deepEqual(publicEnv, {
    PUBLIC_TOKEN_MINT: env.PUBLIC_TOKEN_MINT,
    PUBLIC_DEBUG: '',
    PUBLIC_WALLETCONNECT_PROJECT_ID: env.PUBLIC_WALLETCONNECT_PROJECT_ID,
  })
  const serialized = JSON.stringify(publicEnv)
  for (const excluded of [
    'PUBLIC_RPC_URL',
    'T1_SENTINEL',
    'SOLANA_RPC_URL',
    'SERVER_SECRET',
    'PRIVATE_KEY',
    'UNLISTED_',
    'PUBLIC_ADMIN_PASSWORD',
    'PUBLIC_API_URL',
    'world.invalid',
  ]) {
    assert.equal(serialized.includes(excluded), false, excluded)
  }
  assert.ok(env.PUBLIC_RPC_URL, 'filtering does not remove the server fallback from its input')
  // a name on Object.prototype is not a variable that is set
  assert.deepEqual(buildPublicEnv({}), {})
  assert.deepEqual(buildPublicEnv(Object.create({ PUBLIC_WS_URL: 'inherited' })), {})
})

test('the build defines: the same names, each value as a JSON string', () => {
  const defines = buildPublicEnvDefines(env)
  assert.deepEqual(defines, {
    'process.env.PUBLIC_TOKEN_MINT': JSON.stringify(env.PUBLIC_TOKEN_MINT),
    'process.env.PUBLIC_DEBUG': '""',
    'process.env.PUBLIC_WALLETCONNECT_PROJECT_ID': JSON.stringify(env.PUBLIC_WALLETCONNECT_PROJECT_ID),
  })
  assert.equal(/T1_SENTINEL|UNLISTED_/.test(JSON.stringify(defines)), false)
  assert.equal(JSON.parse(defines['process.env.PUBLIC_WALLETCONNECT_PROJECT_ID']), env.PUBLIC_WALLETCONNECT_PROJECT_ID)
})

test('a PUBLIC_ name nothing reads is left out and named at start-up: the name, never the value', () => {
  assert.deepEqual(unlistedPublicEnv(env), ['PUBLIC_', 'PUBLIC_ADMIN_PASSWORD', 'PUBLIC_EVM_RPC_URL', 'PUBLIC_LABEL'])
  const note = unlistedPublicEnvNote(env)
  assert.match(note, /^\[envs\] not handed to the page \(\/env\.js\): PUBLIC_, PUBLIC_ADMIN_PASSWORD, /)
  for (const name of unlistedPublicEnv(env)) assert.ok(note.includes(name), name)
  for (const value of Object.values(env)) assert.equal(!!value && note.includes(value), false, 'a value is in the note')
  assert.equal(/UNLISTED_|T1_SENTINEL|SERVER_SECRET/.test(note), false)
  // the names the server reads itself are not news, and neither is an environment without any
  assert.equal(unlistedPublicEnvNote({ PUBLIC_RPC_URL: 'x', PUBLIC_API_URL: 'x', PUBLIC_MAX_UPLOAD_SIZE: '1' }), null)
  assert.equal(unlistedPublicEnvNote({ PUBLIC_TOKEN_DECIMALS: '6', PUBLIC_WS_URL: 'ws://x', WORLD: 'world' }), null)
  assert.equal(unlistedPublicEnvNote({}), null)
})

test('the server says the note once when it starts, through console.error, and starts all the same', () => {
  const code = codeOf('src/server/index.js')
  assert.equal(code.split('unlistedPublicEnvNote(process.env)').length - 1, 1, 'asked once')
  assert.match(
    code,
    /const unlistedPublicEnvs=unlistedPublicEnvNote\(process\.env\);if\(unlistedPublicEnvs\)console\.error\(unlistedPublicEnvs\);/
  )
  // (a throw there would be a new way for a production server to fail its start)
  assert.equal(/unlistedPublicEnvs\)throw|throw[^;]*unlistedPublicEnvs/.test(code), false)
})

// ---- the list against the source ----

const NAME = /\bPUBLIC_[A-Z0-9_]*/g
// names in the source that begin with PUBLIC_ and are not variables of the environment
const NOT_ENV = ['PUBLIC_ENV_NAMES', 'PUBLIC_TEMPLATE_SECRETS']
const namesIn = files => {
  const found = new Set()
  for (const file of files) for (const match of codeOf(file).matchAll(NAME)) found.add(match[0])
  return [...found].filter(name => !NOT_ENV.includes(name)).sort()
}
const LIST = 'src/core/extras/publicEnv.js'

test('the list is exactly the PUBLIC_ names written in the code that is bundled for a browser', async () => {
  const inputs = await browserInputs()
  assert.ok(inputs.length > 150 && inputs.includes('src/client/index.js'), 'the bundles were read')
  assert.equal(inputs.includes(LIST), false, 'the list itself is not shipped')
  assert.equal(
    inputs.some(file => /^src\/server\/|\/Server[A-Z]\w*\.js$/.test(file)),
    false,
    'no server file is in a browser bundle'
  )
  assert.deepEqual(namesIn(inputs), [...PUBLIC_ENV_NAMES].sort())
})

test('every other PUBLIC_ name in the source is one the server keeps to itself', () => {
  const all = namesIn(sourceFiles().filter(file => file !== LIST))
  const expected = [...PUBLIC_ENV_NAMES, ...SERVER_PUBLIC_ENV_NAMES].sort()
  assert.deepEqual(
    all,
    expected,
    'a PUBLIC_ name is read that is on neither list (or one is listed that nothing reads)'
  )
})

test('no code reads the environment by the PUBLIC_ prefix, and a computed read names its variable as a literal', async () => {
  // the prefix on its own (a `startsWith('PUBLIC_')`, a `PUBLIC_${…}`): only where the list itself finds the
  // names it leaves out
  const bare = /\bPUBLIC_(?![A-Z0-9])/
  const byPrefix = sourceFiles().filter(file => bare.test(codeOf(file)))
  assert.deepEqual(byPrefix, [LIST])
  assert.equal(codeOf(LIST).split('PUBLIC_"').length - 1, 1, 'one use of the prefix, in unlistedPublicEnv')

  // In the browser bundles the page's environment is indexed by a variable in two helpers, `resolveEnv(key)`, which
  // are private to their files; every call of them passes a name as a string. Anything else that indexes `env` by
  // something that is not a string fails here, and has to be looked at.
  const helpers = ['src/client/evm-integration.js', 'src/client/solana-integration.js']
  const computed = /\benv\??\.?\[(?!")/g
  for (const file of await browserInputs()) {
    const code = codeOf(file)
    const count = [...code.matchAll(computed)].length
    if (!helpers.includes(file)) {
      assert.equal(count, 0, `${file} reads the environment by a computed name`)
      assert.equal(code.includes('resolveEnv'), false, `${file} uses resolveEnv`)
      continue
    }
    assert.equal(count, 2, `${file}: process.env?.[key] and globalThis.env?.[key] in resolveEnv`)
    assert.match(code, /const resolveEnv=key=>\{/)
    assert.equal(/export[^;]*\bresolveEnv\b/.test(code), false, `${file} exports resolveEnv`)
    const uses = [...code.matchAll(/resolveEnv(.{0,3})/g)].map(match => match[1])
    const calls = [...code.matchAll(/resolveEnv\("(PUBLIC_[A-Z0-9_]+)"\)/g)].map(match => match[1])
    assert.equal(
      uses.length,
      calls.length + 1,
      `${file}: every use of resolveEnv but its definition is a call with a literal`
    )
    for (const name of calls) assert.ok(PUBLIC_ENV_NAMES.includes(name), name)
  }
})

test('the scan sees through comments and quoting', () => {
  const code = stripComments(`
    // PUBLIC_IN_A_LINE_COMMENT
    const a = { /* PUBLIC_IN_A_BLOCK */ b: process.env.PUBLIC_READ, c: env?.['PUBLIC_QUOTED'] }
    f(/* PUBLIC_IN_AN_ARGUMENT */ \`PUBLIC_\${a}\`)
  `)
  assert.deepEqual([...code.matchAll(NAME)].map(match => match[0]).sort(), ['PUBLIC_', 'PUBLIC_QUOTED', 'PUBLIC_READ'])
})

test('/env.js and the build both take the names from the list', () => {
  const server = codeOf('src/server/index.js')
  assert.match(server, /import\{buildPublicEnv,unlistedPublicEnvNote\}from"\.\.\/core\/extras\/publicEnv"/)
  assert.match(server, /const publicEnvs=buildPublicEnv\(process\.env\)/)
  assert.match(server, /globalThis\.env = \$\{JSON\.stringify\(publicEnvs\)\}/)
  const defines = codeOf('scripts/lib/buildDefines.mjs')
  assert.match(defines, /import\{buildPublicEnvDefines\}from"\.\.\/\.\.\/src\/core\/extras\/publicEnv\.js"/)
})
