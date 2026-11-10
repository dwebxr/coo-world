import fs from 'node:fs/promises'
import path from 'node:path'
import { assets } from './assets'
import { collections } from './collections'
import { isPlainObject } from '../core/extras/entityModifyPolicy.js'
import { sanitizeBlueprintAdd } from '../core/extras/blueprintPolicy.js'
import { isAbsoluteHttpURL, previewValue, scriptSource } from '../core/extras/assetURL.js'

// The start-up clean-up (CLEAN=true or dryrun): orphan blueprints, and the uploaded assets nothing names.
//
// What keeps a file is its name, not a URL: a stored reference can be spelled in more ways than any parser here
// would follow (a host, a port, a path prefix, `..`, a query, case, percent-encoding), so no reference is resolved
// to decide what to keep. Instead the corpus (every persisted entity, kept blueprint, collection blueprint,
// setting, user avatar and script-storage value, keys included, as parsed, so JSON escapes are decoded; the text of
// storage.json.corrupt-* copies; the source of every kept store script) is cut into tokens at each character a
// store name cannot hold, and every store file whose name equals a token, ignoring case, is kept. A token with `%`
// is also matched percent-decoded, and one with dots, `_` or `-` at its ends also without them. Keeping is the safe
// direction, so case is ignored on purpose (a case-insensitive file system loads asset://<NAME> from <name>), and a
// file named like a common word is kept whenever that word appears. The scan runs to a fixed point: a kept .js file
// (the only script extension uploads accept) is read and its source joins the corpus.
//
// What the scan cannot see, so such a file IS deleted: a name assembled at run time (`'abc' + 'def.glb'`, a template,
// a computed hash) or written with JavaScript escapes in a script's source (`'\x61bc.glb'`, `'abc.glb'`).
//
// Nothing is deleted at all, with the reason logged, when discovery cannot be complete:
// - a row, the storage file or a script cannot be read or does not parse;
// - the assets URL is not an absolute http(s) URL (where scripts come from cannot be told);
// - a kept blueprint's script is not a store file for certain (assetURL.js scriptSource: only the canonical
//   asset://<name> or an absolute URL directly under the assets URL is; another origin, a page path or anything
//   else may run code the server cannot read);
// - with ASSETS=s3, a store script is missing from the bucket: a CDN in front of it may still serve it. With
//   ASSETS=local a missing script names nothing: the file system is what both the server's loader and the static
//   route serve, and taking it as incomplete would let any builder switch cleaning off with a made-up script hash.

// 0-9 A-Z a-z . _ -: the characters of a store name (assetURL.js ASSET_NAME)
const isNameCode = c =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 45
const PERCENT = 37
const isEdgeCode = c => c === 46 || c === 95 || c === 45
const STORE_NAME = /^[A-Za-z0-9._-]+$/
const PERCENT_BYTE = /%([0-9A-Fa-f]{2})/g
const SCRIPT = /\.js$/i

// The store's files by lower-cased name, and a scan that keeps each one whose name a text holds as a token. The text
// is walked by character code, so a large corpus is never split into arrays; a run is sliced into a string only
// when its length is that of a stored name.
function createNameScan(files, onKeep) {
  const byName = new Map()
  const lengths = new Set()
  for (const file of files) {
    const key = file.toLowerCase()
    const same = byName.get(key)
    if (same) same.push(file)
    else byName.set(key, [file])
    lengths.add(key.length)
  }
  const kept = new Set()
  const look = (text, from, to) => {
    if (!lengths.has(to - from)) return
    const found = byName.get(text.slice(from, to).toLowerCase())
    if (!found) return
    for (const file of found) {
      if (kept.has(file)) continue
      kept.add(file)
      onKeep(file)
    }
  }
  const run = (text, from, to, percent) => {
    if (percent) {
      // ASCII bytes only (store names are ASCII), up to three times for a name encoded twice; what is left of `%`
      // after that cannot be part of a name, so the decoded text is scanned again with `%` as a separator
      let decoded = text.slice(from, to)
      for (let i = 0; i < 3 && decoded.includes('%'); i++) {
        decoded = decoded.replace(PERCENT_BYTE, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      }
      scan(decoded, false)
      return
    }
    look(text, from, to)
    let a = from
    let b = to
    while (a < b && isEdgeCode(text.charCodeAt(a))) a++
    while (b > a && isEdgeCode(text.charCodeAt(b - 1))) b--
    if ((a !== from || b !== to) && a < b) look(text, a, b)
  }
  const scan = (text, allowPercent = true) => {
    if (typeof text !== 'string') return
    let start = -1
    let percent = false
    for (let i = 0; i <= text.length; i++) {
      const c = i < text.length ? text.charCodeAt(i) : -1
      if (c !== -1 && (isNameCode(c) || (allowPercent && c === PERCENT))) {
        if (start < 0) {
          start = i
          percent = false
        }
        if (c === PERCENT) percent = true
        continue
      }
      if (start >= 0) run(text, start, i, percent)
      start = -1
    }
  }
  return { kept, scan }
}

// every string of a parsed value, keys too
function scanValue(value, scan) {
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') scan(item)
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        scan(key)
        pending.push(child)
      }
    }
  }
}

class Cleaner {
  // storageFile: the script storage file (storage.json), read here without changing it; Storage opens it later.
  // assetsUrl: where clients read the asset store (ASSETS_BASE_URL); localStore: the store is the assets directory
  // (ASSETS=local), not an S3 bucket
  async init({ db, storageFile, assetsUrl, localStore = false }) {
    const clean = process.env.CLEAN === 'true' || process.env.CLEAN === 'dryrun'
    if (!clean) return console.log('[clean] skipped')
    const dryrun = process.env.CLEAN === 'dryrun'
    console.log(dryrun ? '[clean] dry run' : '[clean] running')
    if (!isAbsoluteHttpURL(assetsUrl)) {
      return console.warn(
        `[clean] skipped all deletion: the assets URL is not an absolute http(s) URL (${previewValue(assetsUrl, 48)}), so where scripts come from cannot be told`
      )
    }
    const allAssets = await assets.list() // hash-only assets
    const malformed = []
    const unreadable = []
    // kept blueprints whose script is not a store file for certain
    const uncertain = []
    // store scripts whose source joins the corpus, each read once (the list grows while it is read)
    const scripts = []
    const queued = new Set()
    const readScript = name => {
      if (queued.has(name)) return
      queued.add(name)
      scripts.push(name)
    }
    // A listed file whose name has a character no store name has cannot be matched by a token: it is kept, and if it
    // is a script, its source cannot be read by name either, so nothing is deleted.
    const named = []
    const oddlyNamed = new Set()
    for (const file of allAssets) {
      if (STORE_NAME.test(file)) named.push(file)
      else {
        oddlyNamed.add(file)
        if (SCRIPT.test(file)) unreadable.push(`script ${previewValue(file, 80)} (a name the clean-up cannot read)`)
      }
    }
    const { kept, scan } = createNameScan(named, file => {
      if (SCRIPT.test(file)) readScript(file)
    })
    const inspect = (table, id, fn) => {
      try {
        fn()
      } catch {
        malformed.push({ table, id })
      }
    }
    const keepScript = (id, value) => {
      const script = scriptSource(value, assetsUrl)
      if (script.source === 'store') readScript(script.name)
      else if (script.source === 'unknown') uncertain.push(String(id).slice(0, 24))
    }
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
        scanValue(data, scan)
      })
    }
    const blueprintsToDelete = []
    const blueprintRows = await db('blueprints')
    for (const row of blueprintRows) {
      inspect('blueprints', row.id, () => {
        const data = JSON.parse(row.data)
        // persisted: the shape is checked, not the model/script reference rule for new values
        const result = sanitizeBlueprintAdd(data, { persisted: true })
        if (!result.ok || result.value.id !== row.id) throw new Error('invalid blueprint')
        // an orphan is deleted with what only it names; a kept one joins the corpus
        if (blueprintIds.has(row.id)) {
          scanValue(data, scan)
          keepScript(row.id, data.script)
        } else {
          blueprintsToDelete.push(row.id)
        }
      })
    }
    for (const blueprint of collections.blueprints) {
      inspect('collections', blueprint?.id, () => {
        if (!sanitizeBlueprintAdd(blueprint, { persisted: true }).ok) throw new Error('invalid blueprint')
        scanValue(blueprint, scan)
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
      scanValue(settings, scan)
    })
    const userRows = await db('users').select('id', 'avatar')
    for (const user of userRows) {
      inspect('users', user.id, () => {
        if (user.avatar != null && typeof user.avatar !== 'string') throw new Error('invalid user avatar')
        scan(user.avatar)
      })
    }
    // script storage (world.set), parsed; a copy set aside as unreadable (storage.json.corrupt-*) as text, so an
    // operator who restores it finds its assets still there
    if (storageFile) {
      try {
        const text = await fs.readFile(storageFile, 'utf8')
        try {
          scanValue(JSON.parse(text), scan)
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
            scan(await fs.readFile(path.join(dir, name), 'utf8'))
          } catch (err) {
            unreadable.push(`${name} (${err?.code || 'read failed'})`)
          }
        }
      } catch (err) {
        unreadable.push(`world directory (${err?.code || 'read failed'})`)
      }
    }
    // the fixed point: each store script read joins the corpus, and a .js file it keeps is read in turn
    for (let i = 0; i < scripts.length; i++) {
      const name = scripts[i]
      try {
        const text = await assets.readText(name)
        if (text === null) {
          if (!localStore) unreadable.push(`script ${name} (not in the S3 store; a CDN may still serve it)`)
          continue
        }
        scan(text)
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
    // a script from elsewhere may world.load assets no record names, and the clean-up does not fetch code at
    // start-up: discovery is incomplete, so nothing is deleted. The cost is disk that keeps growing, visibly, never
    // lost data.
    if (uncertain.length) {
      console.warn(
        `[clean] skipped all deletion: kept blueprints run a script that is not a store file for certain ${JSON.stringify(uncertain)}; give them an asset:// script (upload it as an asset) so the clean-up can read it`
      )
      return
    }
    // Discovery is complete, within what the name scan can see (above)
    if (blueprintsToDelete.length) {
      console.log(`[clean] ${blueprintsToDelete.length} blueprints can be deleted`)
      if (!dryrun) {
        for (const id of blueprintsToDelete) {
          await db('blueprints').where('id', id).delete()
        }
        console.log(`[clean] ${blueprintsToDelete.length} blueprints deleted`)
      }
    }
    const assetsToDelete = new Set([...allAssets].filter(asset => !kept.has(asset) && !oddlyNamed.has(asset)))
    if (assetsToDelete.size) {
      // a dry run names them (the first 50)
      const names = dryrun ? [...assetsToDelete].sort() : []
      const listing = dryrun
        ? `: ${JSON.stringify(names.slice(0, 50))}${names.length > 50 ? ` and ${names.length - 50} more` : ''}`
        : ''
      console.log(`[clean] ${assetsToDelete.size} assets can be deleted${listing}`)
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
