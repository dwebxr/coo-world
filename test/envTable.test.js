// The environment variable names the source reads, each with a class (test/lib/envTable.mjs): a name that is read
// and has no class fails, and so does a class for a name nothing reads any more. What the scan can see, and what
// it cannot, is said in test/lib/envScan.mjs; this is a check of names, not of what becomes of a value.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PUBLIC_ENV_NAMES, SERVER_PUBLIC_ENV_NAMES } from '../src/core/extras/publicEnv.js'
import { NOT_NAMES, scanEnvSource, scanEnvText } from './lib/envScan.mjs'
import { stripComments } from './lib/sourceScan.mjs'
import { ENV_CLASSES, ENV_TABLE, checkEnvTable, envEntry, envNamesOf } from './lib/envTable.mjs'

const scan = scanEnvSource()

test('every name the source reads has a class, and every name with a class is read', () => {
  assert.ok(scan.names.size > 80, `the scan found the names (${scan.names.size})`)
  assert.deepEqual(checkEnvTable(scan), [])
})

test('the readers the scan has to see through are seen', () => {
  const where = name => scan.names.get(name) ?? []
  // a table of defaults read by key (uploadLimits.js, connectionLimits.js)
  assert.ok(where('UPLOAD_MIN_FREE_MB').includes('src/server/uploadLimits.js'))
  assert.ok(where('WS_CONNECT_CONCURRENT_PER_48').includes('src/server/connectionLimits.js'))
  // names handed to a local reader as strings (aiBudget.js, Storage.js), and a list of [name, length] (index.js)
  assert.ok(where('AI_MAX_SECONDS').includes('src/server/aiBudget.js'))
  assert.ok(where('STORAGE_MAX_VALUE_BYTES').includes('src/server/Storage.js'))
  assert.ok(where('AI_EFFORT').includes('src/server/index.js'))
  // a name with the chain id in it (evmRpc.js), and one read through optional chaining (ServerLoader.js)
  assert.deepEqual(scan.stems.get('EVM_RPC_URL_'), ['src/server/evmRpc.js'])
  assert.ok(where('OUTBOUND_TRUSTED_ORIGINS').includes('src/core/systems/ServerLoader.js'))
  // a reader that is given the environment as an argument (adminCode.js), and a script outside src (agent.mjs)
  assert.ok(where('ADMIN_ATTEMPT_WAIT_SCALE').includes('src/server/adminCode.js'))
  assert.ok(where('AGENT_ID').includes('agent.mjs'))
  assert.deepEqual(scan.blind, [])
  assert.deepEqual(NOT_NAMES, [], 'a string taken for a name by mistake is listed with a reason; none is needed today')
})

test('the scan: each shape of a read', () => {
  const names = text => [...scanEnvText(text).names].sort()
  const stems = text => [...scanEnvText(text).stems].sort()
  assert.deepEqual(names('f(process.env.PLAIN_NAME, process.env.WORLD)'), ['PLAIN_NAME', 'WORLD'])
  assert.deepEqual(
    names('f(process?.env?.OPTIONAL_ONE, process?.env.OPTIONAL_TWO, globalThis.process?.env?.OPTIONAL_THREE)'),
    ['OPTIONAL_ONE', 'OPTIONAL_THREE', 'OPTIONAL_TWO']
  )
  assert.deepEqual(names('export const read = env => env.FROM_ARGUMENT || globalThis.env?.FROM_PAGE'), [
    'FROM_ARGUMENT',
    'FROM_PAGE',
  ])
  assert.deepEqual(names(`f(process.env['QUOTED_ONE'], env?.["QUOTED_TWO"])`), ['QUOTED_ONE', 'QUOTED_TWO'])
  assert.deepEqual(
    names('const { TAKEN_ONE, TAKEN_TWO: alias, TAKEN_THREE = "x" } = process.env\nf(TAKEN_ONE, alias)'),
    ['TAKEN_ONE', 'TAKEN_THREE', 'TAKEN_TWO']
  )
  assert.deepEqual(names('function f(env) { const { FROM_PARAMETER } = env; return FROM_PARAMETER }'), [
    'FROM_PARAMETER',
  ])
  assert.deepEqual(stems('for (const id of ids) f(env[`RPC_URL_${id}`], process.env?.[`OTHER_${id}_URL`])'), [
    'OTHER_',
    'RPC_URL_',
  ])
  // a table read: the names come from the file the read stands in
  const table = scanEnvText(`
    const DEFAULTS = { TABLE_KEY_ONE: 1, TABLE_KEY_TWO: 2 }
    const read = key => env[key] ?? DEFAULTS[key]
    read('GIVEN_AS_STRING'); read(\`TEMPLATED_\${suffix}\`)
    throw new Error(\`[envs] NOT_AT_THE_START_\${suffix} of a template\`)
  `)
  assert.deepEqual([...table.names].sort(), ['GIVEN_AS_STRING', 'TABLE_KEY_ONE', 'TABLE_KEY_TWO'])
  assert.deepEqual([...table.stems], ['TEMPLATED_'])
  assert.equal(table.computed, 1)
  // without a computed read, a string or a key is just that
  assert.deepEqual(names('const DEFAULTS = { NOT_READ_ONE: 1 }; f("NOT_READ_TWO")'), [])
  // comments are not code
  assert.deepEqual(names('// process.env.IN_A_COMMENT\nf(/* process.env.IN_A_BLOCK */ process.env.REAL_ONE)'), [
    'REAL_ONE',
  ])
  // a computed read with nothing to go by is reported, not passed over
  const blind = scanEnvText('export const read = (env, key) => env[key]')
  assert.equal(blind.computed, 1)
  assert.equal(blind.fed, 0)
  const files = {
    'reader.js': 'export const read = (env, key) => env[key]',
    'table.js': 'const read = key => process.env[key]; read("NAMED_HERE")',
    'plain.js': 'f(process.env.BY_NAME)',
  }
  const whole = scanEnvSource(Object.keys(files), file => stripComments(files[file]))
  assert.deepEqual(whole.blind, ['reader.js'])
  assert.deepEqual([...whole.names.keys()].sort(), ['BY_NAME', 'NAMED_HERE'])
  assert.deepEqual(whole.names.get('NAMED_HERE'), ['table.js'])
})

test('the check: a name without a class, a class without a name, and a read the scan cannot name all fail', () => {
  const found = (names, stems = [], blind = []) => ({
    names: new Map(names.map(name => [name, ['a.js']])),
    stems: new Map(stems.map(stem => [stem, ['a.js']])),
    blind,
  })
  const table = {
    KNOWN_ONE: { class: 'secret', why: 'x' },
    'PER_CHAIN_*': { class: 'secret', why: 'x' },
  }
  assert.deepEqual(checkEnvTable(found(['KNOWN_ONE'], ['PER_CHAIN_']), table), [])
  assert.deepEqual(checkEnvTable(found(['KNOWN_ONE', 'NEW_ONE'], ['PER_CHAIN_']), table), [
    'NEW_ONE is read (a.js) and has no class',
  ])
  assert.deepEqual(checkEnvTable(found([], ['PER_CHAIN_']), table), ['KNOWN_ONE has a class and nothing reads it'])
  assert.deepEqual(checkEnvTable(found(['KNOWN_ONE']), table), ['PER_CHAIN_* has a class and nothing reads it'])
  assert.deepEqual(checkEnvTable(found(['KNOWN_ONE'], ['PER_CHAIN_', 'OTHER_']), table), [
    'OTHER_<…> is read (a.js) and has no class',
  ])
  // a stem whose names are spelled out beside it needs no entry of its own
  assert.deepEqual(
    checkEnvTable(found(['KNOWN_ONE', 'OTHER_56'], ['PER_CHAIN_', 'OTHER_']), {
      ...table,
      OTHER_56: { class: 'operator', why: 'x' },
    }),
    []
  )
  assert.deepEqual(checkEnvTable(found(['KNOWN_ONE'], ['PER_CHAIN_'], ['b.js']), table), [
    'b.js reads the environment by a computed name and the scan found no name for it',
  ])
  // a name under a stem takes the stem's class; the bare stem is not a name
  assert.equal(envEntry('PER_CHAIN_137', table).class, 'secret')
  assert.equal(envEntry('PER_CHAIN_', table), null)
  assert.equal(envEntry('toString', table), null)
  const bad = { A: { class: 'private', why: 'x' }, B: { class: 'public', why: 'x' }, C: { class: 'operator' } }
  assert.deepEqual(checkEnvTable(found(['A', 'B', 'C']), bad), [
    'A: class "private" is not one',
    'B: public, and not said where it is served',
    'C: no reason given',
  ])
})

test('the classes agree with what the page is handed', () => {
  assert.deepEqual(ENV_CLASSES, ['secret', 'public', 'operator', 'internal', 'platform'])
  // every name served in /env.js is classed public, and says so
  for (const name of PUBLIC_ENV_NAMES) {
    assert.equal(ENV_TABLE[name]?.class, 'public', name)
    assert.match(ENV_TABLE[name].served, /^\/env\.js/, name)
  }
  // and no other name claims to be served there
  const claimed = Object.keys(ENV_TABLE).filter(name => /\/env\.js/.test(ENV_TABLE[name].served ?? ''))
  assert.deepEqual(claimed.sort(), [...PUBLIC_ENV_NAMES].sort())
  // the PUBLIC_ names the server keeps to itself have a class too
  for (const name of SERVER_PUBLIC_ENV_NAMES) assert.ok(ENV_TABLE[name], name)
  assert.equal(ENV_TABLE.PUBLIC_RPC_URL.class, 'secret')
  // no secret is on the list of what /env.js serves, by its own name or under a stem
  const secrets = envNamesOf('secret')
  assert.deepEqual(secrets, [
    'JWT_SECRET',
    'JWT_SECRET_PREVIOUS',
    'ADMIN_CODE',
    'AI_API_KEY',
    'LIVEKIT_API_SECRET',
    'DB_URI',
    'ASSETS_S3_URI',
    'SOLANA_RPC_URL',
    'PUBLIC_RPC_URL',
    'EVM_RPC_URL_*',
  ])
  for (const name of PUBLIC_ENV_NAMES) assert.notEqual(envEntry(name).class, 'secret', name)
  assert.equal(envEntry('EVM_RPC_URL_137').class, 'secret')
})
