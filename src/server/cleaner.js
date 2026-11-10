import fs from 'node:fs/promises'
import path from 'node:path'
import { assets } from './assets'
import { collections } from './collections'
import { isPlainObject } from '../core/extras/entityModifyPolicy.js'
import { sanitizeBlueprintAdd } from '../core/extras/blueprintPolicy.js'
import { classifyReference, storeLiteralNames } from '../core/extras/assetURL.js'

// What references are and where they lead is decided only in assetURL.js, the way the runtime resolves them
// (classifyReference, storeLiteralNames); nothing here tests a reference's spelling.

// Inspect the persisted tree, including nested props and fields hydration may strip. Each string that resolves
// into the asset store keeps that file. Anything else keeps nothing: a value that cannot name an asset (a number
// where a url usually is, text in a prop) is skipped, and props accept any JSON, so it must not turn cleaning off
// for the whole world. (A model or image elsewhere loads nothing from the store; only scripts can name more.)
function discoverAssets(data, found, store) {
  const pending = [data]
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string') {
      const reference = classifyReference(value, store)
      if (reference.source === 'store') found.add(reference.name)
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) pending.push(item)
    }
  }
}

// every store file a text names (a stored value, a script's source; assetURL.js storeLiteralNames)
function findAssetNames(text, found, store) {
  for (const name of storeLiteralNames(text, store)) found.add(name)
}

// every string (keys too) of a parsed value
function findAssetNamesIn(value, found, store) {
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') findAssetNames(item, found, store)
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        findAssetNames(key, found, store)
        pending.push(child)
      }
    }
  }
}

class Cleaner {
  // storageFile: the script storage file (storage.json), read here without changing it; Storage opens it later.
  // assetsUrl: where clients read the asset store (ASSETS_BASE_URL); servesStore: this server also serves it at the
  // page's /assets/ (ASSETS=local)
  async init({ db, storageFile, assetsUrl, servesStore = false }) {
    const clean = process.env.CLEAN === 'true' || process.env.CLEAN === 'dryrun'
    if (!clean) return console.log('[clean] skipped')
    const dryrun = process.env.CLEAN === 'dryrun'
    console.log(dryrun ? '[clean] dry run' : '[clean] running')
    // without the assets URL no reference resolves into the store, so every file would look unused
    if (typeof assetsUrl !== 'string' || !assetsUrl) {
      return console.warn('[clean] skipped all deletion: no assets URL to resolve stored references against')
    }
    const store = { assetsUrl, servesStore }
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
        discoverAssets(data, assetsToKeep, store)
      })
    }
    const blueprintsToDelete = []
    // the scripts of the blueprints that stay: their source can name assets no record mentions
    const scripts = new Set()
    // kept blueprints whose script is loaded from outside the asset store, or from where cannot be told
    const remote = []
    // A kept script, as the runtime resolves it (classifyReference): nothing persistent is no script; a store file
    // is read for the assets its source names; any other source stops all deletion (below).
    const keepScript = (id, value) => {
      const reference = classifyReference(value, store)
      if (reference.source === 'store') scripts.add(reference.name)
      else if (reference.source === 'external') remote.push(String(id).slice(0, 24))
    }
    const blueprintRows = await db('blueprints')
    for (const row of blueprintRows) {
      inspect('blueprints', row.id, () => {
        const data = JSON.parse(row.data)
        // persisted: the shape is checked, not the model/script reference rule for new values
        const result = sanitizeBlueprintAdd(data, { persisted: true })
        if (!result.ok || result.value.id !== row.id) throw new Error('invalid blueprint')
        const found = new Set()
        // Even an orphan must be fully inspected before any deletion is allowed.
        discoverAssets(data, found, store)
        if (blueprintIds.has(row.id)) {
          for (const asset of found) assetsToKeep.add(asset)
          keepScript(row.id, data.script)
        } else {
          blueprintsToDelete.push(row.id)
        }
      })
    }
    for (const blueprint of collections.blueprints) {
      inspect('collections', blueprint?.id, () => {
        if (!sanitizeBlueprintAdd(blueprint, { persisted: true }).ok) throw new Error('invalid blueprint')
        discoverAssets(blueprint, assetsToKeep, store)
        keepScript(blueprint.id, blueprint.script)
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
      discoverAssets(settings, assetsToKeep, store)
    })
    const userRows = await db('users').select('id', 'avatar')
    for (const user of userRows) {
      inspect('users', user.id, () => {
        if (user.avatar != null && typeof user.avatar !== 'string') throw new Error('invalid user avatar')
        discoverAssets(user.avatar, assetsToKeep, store)
      })
    }
    // script storage (world.set): any stored string that names a store file (storeLiteralNames). A copy set aside as
    // unreadable (storage.json.corrupt-*) is scanned as text, so an operator who restores it finds its assets there.
    if (storageFile) {
      try {
        const text = await fs.readFile(storageFile, 'utf8')
        try {
          findAssetNamesIn(JSON.parse(text), assetsToKeep, store)
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
            findAssetNames(await fs.readFile(path.join(dir, name), 'utf8'), assetsToKeep, store)
          } catch (err) {
            unreadable.push(`${name} (${err?.code || 'read failed'})`)
          }
        }
      } catch (err) {
        unreadable.push(`world directory (${err?.code || 'read failed'})`)
      }
    }
    // the source of each script that stays: the store files its literals name (configure() initial values,
    // world.load() calls) count as references. A name built at run time cannot be found this way.
    for (const name of scripts) {
      try {
        const text = await assets.readText(name)
        // A script that does not exist (ENOENT locally, NoSuchKey on S3) names nothing: an absent file cannot reference
        // anything at run time, and the app pointing at it is already broken. Taking it as incomplete discovery
        // would let any builder switch cleaning off for the whole world with one blueprint naming a made-up script
        // hash. Every other read failure still stops all deletion (below).
        if (text === null) continue
        findAssetNames(text, assetsToKeep, store)
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
    // A script loaded from elsewhere (keepScript) may world.load assets no record names, and the clean-up does not
    // fetch remote code at start-up. Unlike a missing file (it names nothing), it may name assets the server cannot
    // see, so discovery is incomplete: nothing is deleted. The cost is disk that keeps growing, visibly, never lost
    // data.
    if (remote.length) {
      console.warn(
        `[clean] skipped all deletion: kept blueprints load their script from elsewhere, or from where cannot be told ${JSON.stringify(remote)}; upload those scripts as assets (asset://) so the clean-up can read them`
      )
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
        // S3 answers per key: one it could not delete is still there
        const failed = (await assets.delete(assetsToDelete))?.failed ?? []
        console.log(`[clean] ${assetsToDelete.size - failed.length} assets deleted`)
        if (failed.length) {
          console.warn(
            `[clean] ${failed.length} assets could not be deleted: ${JSON.stringify(failed.slice(0, 10).map(item => `${String(item.name).slice(0, 80)} (${item.code})`))}`
          )
        }
      }
    }
    console.log('[clean] complete')
  }
}

export const cleaner = new Cleaner()
