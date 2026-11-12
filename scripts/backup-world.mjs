import 'dotenv-flow/config'
import path from 'path'
import { fileURLToPath } from 'url'
import { backupWorld } from './lib/backupWorld.mjs'

// One archive of the world's folder in <world>/backups, the seven newest kept (scripts/lib/backupWorld.mjs).
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../')
try {
  await backupWorld({ rootDir, world: process.env.WORLD || 'world' })
  console.log('Backup process completed!')
} catch (error) {
  console.error(`Error creating backup: ${error?.message || error}`)
  console.error('Make sure tar is installed on your system')
  process.exit(1)
}
