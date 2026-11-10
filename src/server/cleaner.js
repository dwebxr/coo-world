import fs from 'node:fs/promises'
import path from 'node:path'
import { assets } from './assets'
import { collections } from './collections'
import { isPlainObject } from '../core/extras/entityModifyPolicy.js'
import { sanitizeBlueprintAdd } from '../core/extras/blueprintPolicy.js'
import { assetName } from '../core/extras/assetURL.js'

// Inspect the persisted tree, including nested props and fields hydration may strip. A value that cannot name an
// asset (a number where a url usually is, an `asset://` with no name) is skipped: it keeps nothing, and props
// accept any JSON, so it must not turn cleaning off for the whole world.
function discoverAssets(data, found) {
  const pending = [data]
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string') {
      if (value.startsWith('asset://')) {
        const filename = value.slice(8).split(/[?#]/)[0]
        if (filename) found.add(filename)
      }
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) pending.push(item)
    }
  }
}

// every asset://<name> inside a text (a stored value, a script's source): keep-more, so a name followed by
// sentence punctuation is kept both with and without its trailing dots
const ASSET_LITERAL = /asset:\/\/([A-Za-z0-9._-]{1,128})/g
function findAssetNames(text, found) {
  for (const [, name] of text.matchAll(ASSET_LITERAL)) {
    found.add(name)
    const trimmed = name.replace(/\.+$/, '')
    if (trimmed) found.add(trimmed)
  }
}

// every string (keys too) of a parsed value
function findAssetNamesIn(value, found) {
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') findAssetNames(item, found)
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        findAssetNames(key, found)
        pending.push(child)
      }
    }
  }
}

class Cleaner {
  // storageFile: the script storage file (storage.json), read here without changing it; Storage opens it later
  async init({ db, storageFile }) {
    const clean = process.env.CLEAN === 'true' || process.env.CLEAN === 'dryrun'
    if (!clean) return console.log('[clean] skipped')
    const dryrun = process.env.CLEAN === 'dryrun'
    console.log(dryrun ? '[clean] dry run' : '[clean] running')
    const allAssets = await assets.list() // hash-only assets
    const malformed = []
    const unreadable = []
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
    // the scripts of the blueprints that stay: their source can name assets no record mentions
    const scripts = new Set()
    const blueprintRows = await db('blueprints')
    for (const row of blueprintRows) {
      inspect('blueprints', row.id, () => {
        const data = JSON.parse(row.data)
        // persisted: the shape is checked, not the model/script reference rule for new values
        const result = sanitizeBlueprintAdd(data, { persisted: true })
        if (!result.ok || result.value.id !== row.id) throw new Error('invalid blueprint')
        const found = new Set()
        // Even an orphan must be fully inspected before any deletion is allowed.
        discoverAssets(data, found)
        if (blueprintIds.has(row.id)) {
          for (const asset of found) assetsToKeep.add(asset)
          if (assetName(data.script)) scripts.add(assetName(data.script))
        } else {
          blueprintsToDelete.push(row.id)
        }
      })
    }
    for (const blueprint of collections.blueprints) {
      inspect('collections', blueprint?.id, () => {
        if (!sanitizeBlueprintAdd(blueprint, { persisted: true }).ok) throw new Error('invalid blueprint')
        discoverAssets(blueprint, assetsToKeep)
        if (assetName(blueprint.script)) scripts.add(assetName(blueprint.script))
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
    // script storage (world.set): any stored string that mentions asset://<name>. A copy set aside as unreadable
    // (storage.json.corrupt-*) is scanned as text, so an operator who restores it finds its assets still there.
    if (storageFile) {
      try {
        const text = await fs.readFile(storageFile, 'utf8')
        try {
          findAssetNamesIn(JSON.parse(text), assetsToKeep)
        } catch {
          unreadable.push('storage.json does not parse')
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') unreadable.push(`storage.json (${err?.code || 'read failed'})`)
      }
      const dir = path.dirname(storageFile)
      const base = path.basename(storageFile)
      try {
        for (const name of await fs.readdir(dir)) {
          if (!name.startsWith(`${base}.corrupt-`)) continue
          try {
            findAssetNames(await fs.readFile(path.join(dir, name), 'utf8'), assetsToKeep)
          } catch (err) {
            unreadable.push(`${name} (${err?.code || 'read failed'})`)
          }
        }
      } catch (err) {
        unreadable.push(`world directory (${err?.code || 'read failed'})`)
      }
    }
    // the source of each script that stays: `asset://<name>` literals there (configure() initial values,
    // world.load() calls) count as references. A name built at run time cannot be found this way.
    for (const name of scripts) {
      try {
        const text = await assets.readText(name)
        if (text === null) continue // no such file: it names nothing
        findAssetNames(text, assetsToKeep)
      } catch (err) {
        unreadable.push(`script ${name} (${err?.code || err?.message || 'read failed'})`)
      }
    }
    if (malformed.length) {
      console.warn(`[clean] skipped all deletion: malformed rows=${JSON.stringify(malformed)}`)
      return
    }
    if (unreadable.length) {
      console.warn(`[clean] skipped all deletion: could not read ${JSON.stringify(unreadable)}`)
      return
    }
    // Discovery is complete. Reachability comes only from persisted rows, collections, storage and scripts.
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
