import { assets } from './assets'
import { collections } from './collections'
import { isPlainObject } from '../core/extras/entityModifyPolicy.js'
import { sanitizeBlueprintAdd } from '../core/extras/blueprintPolicy.js'

// Inspect the persisted tree, including nested props and fields hydration may strip.
function discoverAssets(data, found) {
  const pending = [data]
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string') {
      if (value.startsWith('asset://')) {
        const filename = value.slice(8).split(/[?#]/)[0]
        if (!filename) throw new Error('invalid asset reference')
        found.add(filename)
      }
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'url' && item !== null && typeof item !== 'string') throw new Error('invalid asset url')
        pending.push(item)
      }
    }
  }
}

class Cleaner {
  async init({ db }) {
    const clean = process.env.CLEAN === 'true' || process.env.CLEAN === 'dryrun'
    if (!clean) return console.log('[clean] skipped')
    const dryrun = process.env.CLEAN === 'dryrun'
    console.log(dryrun ? '[clean] dry run' : '[clean] running')
    const allAssets = await assets.list() // hash-only assets
    const malformed = []
    const inspect = (table, id, fn) => {
      try {
        fn()
      } catch {
        malformed.push({ table, id })
      }
    }
    const assetsToKeep = new Set()
    const blueprintIds = new Set()
    const entityRows = await db('entities')
    for (const row of entityRows) {
      inspect('entities', row.id, () => {
        const data = JSON.parse(row.data)
        if (
          !isPlainObject(data) ||
          data.id !== row.id ||
          !data.id ||
          data.type !== 'app' ||
          typeof data.blueprint !== 'string' ||
          !data.blueprint
        )
          throw new Error('invalid entity')
        blueprintIds.add(data.blueprint)
        discoverAssets(data, assetsToKeep)
      })
    }
    const blueprintsToDelete = []
    const blueprintRows = await db('blueprints')
    for (const row of blueprintRows) {
      inspect('blueprints', row.id, () => {
        const data = JSON.parse(row.data)
        const result = sanitizeBlueprintAdd(data)
        if (!result.ok || result.value.id !== row.id) throw new Error('invalid blueprint')
        const found = new Set()
        // Even an orphan must be fully inspected before any deletion is allowed.
        discoverAssets(data, found)
        if (blueprintIds.has(row.id)) {
          for (const asset of found) assetsToKeep.add(asset)
        } else {
          blueprintsToDelete.push(row.id)
        }
      })
    }
    for (const blueprint of collections.blueprints) {
      inspect('collections', blueprint?.id, () => {
        if (!sanitizeBlueprintAdd(blueprint).ok) throw new Error('invalid blueprint')
        discoverAssets(blueprint, assetsToKeep)
      })
    }
    const settingsRow = await db('config').where('key', 'settings').first()
    inspect('config', 'settings', () => {
      const settings = JSON.parse(settingsRow?.value ?? '{}')
      if (!isPlainObject(settings)) throw new Error('invalid settings')
      for (const key of ['image', 'avatar']) {
        const value = settings[key]
        if (value != null && (!isPlainObject(value) || typeof value.url !== 'string')) {
          throw new Error('invalid settings asset')
        }
      }
      discoverAssets(settings, assetsToKeep)
    })
    const userRows = await db('users').select('id', 'avatar')
    for (const user of userRows) {
      inspect('users', user.id, () => {
        if (user.avatar != null && typeof user.avatar !== 'string') throw new Error('invalid user avatar')
        discoverAssets(user.avatar, assetsToKeep)
      })
    }
    if (malformed.length) {
      console.warn(`[clean] skipped all deletion: malformed rows=${JSON.stringify(malformed)}`)
      return
    }
    // Discovery is complete. Reachability comes only from persisted rows and collections.
    if (blueprintsToDelete.length) {
      console.log(`[clean] ${blueprintsToDelete.length} blueprints can be deleted`)
      if (!dryrun) {
        for (const id of blueprintsToDelete) {
          await db('blueprints').where('id', id).delete()
        }
        console.log(`[clean] ${blueprintsToDelete.length} blueprints deleted`)
      }
    }
    const assetsToDelete = new Set([...allAssets].filter(asset => !assetsToKeep.has(asset)))
    if (assetsToDelete.size) {
      console.log(`[clean] ${assetsToDelete.size} assets can be deleted`)
      if (!dryrun) {
        await assets.delete(assetsToDelete)
        console.log(`[clean] ${assetsToDelete.size} assets deleted`)
      }
    }
    console.log('[clean] complete')
  }
}

export const cleaner = new Cleaner()
