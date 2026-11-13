// What a build writes into a bundle in place of `process.env.<NAME>` (scripts/lib/buildDefines.mjs). A bundle of
// the page is a file anyone downloads: whatever the environment of the build holds, the keys of its define map are
// the build flag and the PUBLIC_ names the client reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { clientDefines, serverDefines } from '../scripts/lib/buildDefines.mjs'
import { PUBLIC_ENV_NAMES } from '../src/core/extras/publicEnv.js'
import { codeOf } from './lib/sourceScan.mjs'

// an environment as a build machine can have it: secrets, PUBLIC_ names nothing reads, and every listed name
const SECRETS = {
  JWT_SECRET: 'DEFINE_SENTINEL_JWT',
  JWT_SECRET_PREVIOUS: 'DEFINE_SENTINEL_JWT_PREVIOUS',
  ADMIN_CODE: 'DEFINE_SENTINEL_ADMIN',
  AI_API_KEY: 'DEFINE_SENTINEL_AI',
  LIVEKIT_API_SECRET: 'DEFINE_SENTINEL_LIVEKIT',
  SOLANA_RPC_URL: 'https://rpc.invalid/DEFINE_SENTINEL_SOLANA',
  EVM_RPC_URL_137: 'https://rpc.invalid/DEFINE_SENTINEL_EVM',
  DB_URI: 'postgres://user:DEFINE_SENTINEL_DB@db.invalid/world',
  ASSETS_S3_URI: 's3://key:DEFINE_SENTINEL_S3@bucket.invalid',
  PUBLIC_RPC_URL: 'https://rpc.invalid/DEFINE_SENTINEL_PUBLIC_RPC',
  PUBLIC_API_KEY: 'DEFINE_SENTINEL_UNLISTED_1',
  PUBLIC_SECRET_TOKEN: 'DEFINE_SENTINEL_UNLISTED_2',
  PUBLIC_API_URL: 'https://world.invalid/DEFINE_SENTINEL_API_URL',
  PUBLIC_: 'DEFINE_SENTINEL_BARE',
  NODE_ENV: 'DEFINE_SENTINEL_NODE_ENV',
  CLIENT: 'DEFINE_SENTINEL_CLIENT',
  PATH: '/usr/bin',
}
const LISTED = Object.fromEntries(PUBLIC_ENV_NAMES.map(name => [name, `listed value of ${name}`]))
const env = { ...SECRETS, ...LISTED }

test('the page bundles: the keys are the build flag and the listed PUBLIC_ names, whatever the environment holds', () => {
  for (const dev of [false, true]) {
    const defines = clientDefines(env, { dev })
    assert.deepEqual(
      Object.keys(defines).sort(),
      ['process.env.NODE_ENV', ...PUBLIC_ENV_NAMES.map(name => `process.env.${name}`)].sort()
    )
    // the flag is the build's own, not the environment's NODE_ENV
    assert.equal(defines['process.env.NODE_ENV'], dev ? '"development"' : '"production"')
    for (const name of PUBLIC_ENV_NAMES) assert.equal(JSON.parse(defines[`process.env.${name}`]), LISTED[name])
    assert.equal(
      JSON.stringify(defines).includes('DEFINE_SENTINEL'),
      false,
      'a value that is not listed is in a define'
    )
  }
  // nothing set: the flag alone, and `dev` off unless asked
  assert.deepEqual(clientDefines({}), { 'process.env.NODE_ENV': '"production"' })
  assert.deepEqual(clientDefines(SECRETS), { 'process.env.NODE_ENV': '"production"' })
})

test('the server bundle: two flags, and nothing of the environment', () => {
  assert.deepEqual(serverDefines(), { 'process.env.CLIENT': 'false', 'process.env.SERVER': 'true' })
  assert.equal(serverDefines.length, 0, 'it is not given the environment')
})

test('a bundle built with these defines holds the listed values and none of the others', async () => {
  // every name of the environment is read in the entry: what the defines do not replace stays a read of
  // `process.env` at run time, and its build-time value is nowhere in the output
  const reads = Object.keys(env)
    .filter(name => /^[A-Z_][A-Z0-9_]*$/.test(name) && name !== 'PUBLIC_')
    .map(name => `process.env.${name}`)
  const result = await esbuild.build({
    stdin: { contents: `export const values = [${reads.join(', ')}]`, loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    define: clientDefines(env),
    logLevel: 'silent',
  })
  const output = result.outputFiles[0].text
  for (const name of PUBLIC_ENV_NAMES) assert.ok(output.includes(LISTED[name]), `${name} is written in`)
  assert.ok(output.includes('"production"'))
  assert.equal(output.includes('DEFINE_SENTINEL'), false, 'a value that is not listed is in the bundle')
  for (const name of Object.keys(SECRETS)) {
    if (name === 'NODE_ENV' || name === 'PUBLIC_') continue
    assert.ok(output.includes(`process.env.${name}`), `${name} stays a read at run time`)
  }
})

test('scripts/build.mjs takes its define maps from these functions and writes no define of its own', () => {
  const code = codeOf('scripts/build.mjs')
  assert.match(code, /import\{clientDefines,serverDefines\}from"\.\/lib\/buildDefines\.mjs"/)
  assert.equal(code.split('define:').length - 1, 2, 'two builds take a define map: the page bundles and the server')
  assert.ok(code.includes('define:clientDefines(process.env,{dev}),'), 'the page bundles')
  assert.ok(code.includes('define:serverDefines(),'), 'the server')
  // the other builds (the client library, the viewer, the node client) define nothing
  for (const file of ['scripts/build-client.mjs', 'scripts/build-viewer.mjs', 'scripts/build-node-client.mjs']) {
    assert.equal(/\bdefine:/.test(codeOf(file)), false, file)
  }
})
