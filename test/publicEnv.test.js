import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPublicEnv,
  buildPublicEnvDefines,
  isPublicEnvKey,
  PUBLIC_ENV_DENYLIST,
} from '../src/core/extras/publicEnv.js'

const env = {
  PUBLIC_RPC_URL: 'https://sentinel.invalid/?api-key=T1_SENTINEL',
  SOLANA_RPC_URL: 'https://server.invalid/?api-key=SERVER_SECRET',
  PUBLIC_TOKEN_MINT: '1'.repeat(32),
  PUBLIC_EMPTY: '',
  PUBLIC_LABEL: 'a "quoted" label\nnext line',
  PRIVATE_KEY: 'private',
}

test('publicEnv: allows PUBLIC_ keys except the explicit denylist', () => {
  assert.deepEqual(PUBLIC_ENV_DENYLIST, ['PUBLIC_RPC_URL'])
  for (const key of ['PUBLIC_TOKEN_MINT', 'PUBLIC_REQUIRED_TOKEN_AMOUNT', 'PUBLIC_', 'PUBLIC_RPC_URL_EXTRA']) {
    assert.equal(isPublicEnvKey(key), true, key)
  }
  for (const key of [
    'PUBLIC_RPC_URL',
    'SOLANA_RPC_URL',
    'PRIVATE_KEY',
    'PUBLIC',
    'public_RPC_URL',
    'X_PUBLIC_KEY',
    '',
  ]) {
    assert.equal(isPublicEnvKey(key), false, key)
  }
})

test('/env.js env object excludes RPC URLs while preserving other public values', () => {
  const publicEnv = buildPublicEnv(env)
  assert.deepEqual(publicEnv, {
    PUBLIC_TOKEN_MINT: env.PUBLIC_TOKEN_MINT,
    PUBLIC_EMPTY: '',
    PUBLIC_LABEL: env.PUBLIC_LABEL,
  })
  const serialized = JSON.stringify(publicEnv)
  for (const excluded of ['PUBLIC_RPC_URL', 'T1_SENTINEL', 'SOLANA_RPC_URL', 'SERVER_SECRET', 'PRIVATE_KEY']) {
    assert.equal(serialized.includes(excluded), false, excluded)
  }
  assert.ok(env.PUBLIC_RPC_URL, 'filtering does not remove the server fallback from its input')
})

test('build.mjs defines exclude RPC URLs and JSON-encode other public values', () => {
  const defines = buildPublicEnvDefines(env)
  assert.deepEqual(defines, {
    'process.env.PUBLIC_TOKEN_MINT': JSON.stringify(env.PUBLIC_TOKEN_MINT),
    'process.env.PUBLIC_EMPTY': '""',
    'process.env.PUBLIC_LABEL': JSON.stringify(env.PUBLIC_LABEL),
  })
  assert.equal(JSON.stringify(defines).includes('T1_SENTINEL'), false)
  assert.equal(JSON.parse(defines['process.env.PUBLIC_LABEL']), env.PUBLIC_LABEL)
})

test('/env.js and build.mjs both use the shared filter', async () => {
  const { readFile } = await import('node:fs/promises')
  for (const [file, name] of [
    ['src/server/index.js', 'buildPublicEnv'],
    ['scripts/build.mjs', 'buildPublicEnvDefines'],
  ]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(source, new RegExp(`import \\{ ${name} \\} from '[./]+(src/)?core/extras/publicEnv(\\.js)?'`), file)
    assert.equal(source.includes("startsWith('PUBLIC_')"), false, file)
  }
})
