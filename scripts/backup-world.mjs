import 'dotenv-flow/config'
import path from 'path'
import { fileURLToPath } from 'url'
import { backupWorld } from './lib/backupWorld.mjs'

// One archive of the world's folder in <world>/backups, the seven newest kept (scripts/lib/backupWorld.mjs).
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../')
try {
  // (the database is PostgreSQL's when the server would say so: src/server/db.js)
  const postgres = /^postgres(ql)?:\/\//.test(process.env.DB_URI || '')
  await backupWorld({ rootDir, world: process.env.WORLD || 'world', postgres })
  console.log('Backup process completed!')
} catch (error) {
  console.error(`Error creating backup: ${error?.message || error}`)
  if (error?.code === 'ENOENT' && error?.path === 'tar') console.error('Make sure tar is installed on your system')
  process.exit(1)
}
