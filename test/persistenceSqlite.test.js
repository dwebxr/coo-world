// The save's statements on a real SQLite database (better-sqlite3 through knex, as db.js opens it), where what a test
// asks is what the statement does in the database itself. The table is made as db.js's migration makes it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Knex from 'knex'
import { loadNetwork } from './lib/network.mjs'
import { fixture } from './lib/persistenceFixture.mjs'

// (against the REAL_PHYSX_SOURCE_ROOT checkout when it is set, as the other persistence tests)
const net = await loadNetwork({ sourceRoot: process.env.REAL_PHYSX_SOURCE_ROOT })

async function sqlite(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-sqlite-'))
  const db = Knex({
    client: 'better-sqlite3',
    connection: { filename: path.join(dir, 'db.sqlite') },
    useNullAsDefault: true,
  })
  t.after(async () => {
    await db.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await db.schema.createTable('entities', table => {
    table.string('id').primary()
    table.text('data').notNullable()
    table.timestamp('createdAt').notNullable()
    table.timestamp('updatedAt').notNullable()
  })
  return db
}

// (S17)
test('persistence: an app row written again keeps the time it was created (SQLite)', async t => {
  t.mock.method(console, 'log', () => {})
  const db = await sqlite(t)
  const { network, entity } = fixture(t, { net, db })
  network.markAppDirty(entity.data)
  await network.save()
  // the row as an earlier day made it
  const created = '2020-01-01T00:00:00.000Z'
  await db('entities').where('id', 'app').update({ createdAt: created, updatedAt: created })
  network.markAppDirty({ ...entity.data, position: [1, 2, 3] })
  await network.save()
  const saved = await db('entities').where('id', 'app').first()
  assert.deepEqual(JSON.parse(saved.data).position, [1, 2, 3])
  assert.equal(saved.createdAt, created)
  assert.notEqual(saved.updatedAt, created)
})
