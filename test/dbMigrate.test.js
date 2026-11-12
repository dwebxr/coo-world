// Each migration runs in a transaction of its own, together with the version it brings the database to (db.js
// migrate): a step that fails halfway leaves the database as it was before the step. The real migrations run on a
// new database in test/persistenceIntegration.test.js and test/persistedStartup.test.js (through getDB).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import Knex from 'knex'

const root = fileURLToPath(new URL('../', import.meta.url))
let dir
let migrate
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-migrate-bundle-'))
  // the bundle's external packages resolve from here
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const outfile = path.join(dir, 'db.mjs')
  await esbuild.build({
    stdin: { contents: `export { migrate } from './src/server/db.js'`, resolveDir: root },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    define: { __dirname: JSON.stringify(path.join(root, 'build')) },
    logLevel: 'silent',
  })
  ;({ migrate } = await import(pathToFileURL(outfile).href))
})
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const open = t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-migrate-')), 'db.sqlite')
  const db = Knex({ client: 'better-sqlite3', connection: { filename: file }, useNullAsDefault: true })
  t.after(async () => {
    await db.destroy()
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })
  return db
}
const version = async db => (await db('config').where('key', 'version').first()).value
const quiet = t => t.mock.method(console, 'log', () => {})

test('migrate: a step that fails halfway leaves nothing behind, and the next start runs it whole', async t => {
  quiet(t)
  const db = open(t)
  let broken = true
  const list = [
    async trx => {
      await trx.schema.createTable('first', table => table.string('id').primary())
    },
    async trx => {
      await trx.schema.createTable('second', table => table.string('id').primary())
      await trx('first').insert({ id: 'made by the second step' })
      await trx.schema.alterTable('first', table => table.string('added'))
      if (broken) throw new Error('halfway')
    },
    async trx => {
      await trx.schema.createTable('third', table => table.string('id').primary())
    },
  ]
  await assert.rejects(migrate(db, list), /halfway/)
  // the first step stays, with its version; of the second there is no table, no row and no column
  assert.equal(await version(db), '1')
  assert.equal(await db.schema.hasTable('first'), true)
  assert.equal(await db.schema.hasTable('second'), false)
  assert.equal(await db.schema.hasTable('third'), false)
  assert.deepEqual(await db('first'), [])
  assert.equal(await db.schema.hasColumn('first', 'added'), false)
  // the next start: the step runs again on a database that is as it was, where it used to meet its own first half
  broken = false
  await migrate(db, list)
  assert.equal(await version(db), '3')
  assert.deepEqual(await db('first'), [{ id: 'made by the second step', added: null }])
  assert.equal(await db.schema.hasTable('third'), true)
  // and a start with nothing to do changes nothing
  await migrate(db, list)
  assert.equal(await version(db), '3')
})

test('migrate: the version is written with its step, not after it', async t => {
  quiet(t)
  const db = open(t)
  const seen = []
  await migrate(db, [
    async trx => {
      await trx.schema.createTable('a', table => table.string('id').primary())
      // from outside the transaction nothing of the step is visible yet... on SQLite the one connection is the
      // transaction's, so the step asks for the version it runs under instead
      seen.push((await trx('config').where('key', 'version').first()).value)
    },
    async trx => {
      seen.push((await trx('config').where('key', 'version').first()).value)
    },
  ])
  assert.deepEqual(seen, ['0', '1'])
  assert.equal(await version(db), '2')
})
