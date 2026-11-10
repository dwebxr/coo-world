import fs from 'node:fs/promises'
import path from 'node:path'
import { assets } from './assets'
import { collections } from './collections'
import { isPlainObject } from '../core/extras/entityModifyPolicy.js'
import { sanitizeBlueprintAdd } from '../core/extras/blueprintPolicy.js'
import { isAbsoluteHttpURL, previewValue, scriptSource } from '../core/extras/assetURL.js'

// The start-up clean-up (CLEAN=true, or dryrun to only log): orphan blueprints, and the uploaded assets nothing names.
//
// THE CONTRACT. It keeps every store file whose name appears as a literal in the persisted world data or in the
// source of a store script reachable from that data, and it deletes nothing when it cannot read something it must
// read. The code it follows is exactly: (i) the store file a blueprint's script names, whatever its extension, and
// (ii) any .js store file named as a literal in the corpus. It cannot see, so such a file IS deleted:
// - a name computed at run time (`'abc' + 'def.glb'`, a template, a hash) or written with JavaScript escapes in a
//   script's source (`'\x61bc.glb'`);
// - code built at run time: code a script fetches or assembles and evaluates itself (fetch + Function), wherever it
//   is hosted, the store included, and whatever that code names (no engine API runs another script: world.load
//   takes models and avatars only, and an app's script is its blueprint's);
// - references inside binary assets (a model's external image or buffer URI): the loaders give models, avatars and
//   emotes their embedded data only, so such a reference is not loaded either.
// A world that relies on any of these must run with CLEAN=false.
//
// What keeps a file is its name, not a URL: no reference is resolved to decide it. The corpus (every persisted
// entity; every kept blueprint and collection blueprint, both as stored and as hydration sanitises it; settings; user
// avatars; script storage, parsed so JSON escapes are decoded, and its unreadable copies as text; the source of every
// store script followed) is cut into tokens at each character a store name cannot hold, and every store file whose
// name equals a token, ignoring case, is kept: also percent-decoded (a run of up to PERCENT_RUN_MAX characters, at
// most PERCENT_PASSES times), without dots, `_` or `-` at its ends, and with tabs, CR and LF inside it dropped (which
// the URL parser drops from a URL). Keeping is the safe direction, so case is ignored on purpose (a case-insensitive
// file system loads asset://<NAME> from <name>), and a file named like a common word is kept whenever that word
// appears. The code followed (above) is read to a fixed point, each file at most `readLimit` bytes.
//
// Nothing is deleted, the reason logged once, when discovery cannot be complete. In these configurations cleaning
// never runs, at the cost of disk that keeps growing:
// - a persisted row or storage.json does not parse as JSON, or a row has the wrong shape;
// - storage.json, a storage.json.corrupt-* copy or a script that must be read cannot be read: a store script that is
//   missing (in every configuration: a CDN or cache in front of the store may still serve it), one that cannot be
//   opened or is larger than `readLimit`, and an S3 object with a content encoding other than gzip or deflate or one
//   that expands past `readLimit` (the log names the blueprint);
// - a text holds a percent-encoded run longer than PERCENT_RUN_MAX characters, or one still encoded after
//   PERCENT_PASSES decodings (it cannot be read with certainty, and decoding it further would cost too much);
// - ASSETS_BASE_URL is not an absolute http(s) URL (a relative or protocol-relative base);
// - a kept blueprint or collection blueprint's script is not a store file for certain (assetURL.js scriptSource):
//   one hosted outside ASSETS_BASE_URL, a page path (/assets/x.js, blob/../assets/x.js), a URL the runtime rewrites or
//   with a query, fragment, `%`, backslash or dot segment, or anything else the server cannot read as the code that
//   runs;
// - a listed .js file has a name no store name has.
//
// With ASSETS=local the files are not unlinked but moved to <world>/assets-trash/<UTC date>/ (AssetsLocal) and
// removed for good after CLEAN_TRASH_DAYS (0: deleted at once), counted by folder date. A trashed file named again on
// a later start is put back (not when ASSETS_BASE_URL is not absolute: then nothing is scanned). With ASSETS=s3 they
// are deleted: keep bucket versioning on to be able to recover one.

// 0-9 A-Z a-z . _ -: the characters of a store name (assetURL.js ASSET_NAME)
const isNameCode = c =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 45
const PERCENT = 37
const isEdgeCode = c => c === 46 || c === 95 || c === 45
// tab, LF, CR: what the URL parser drops from a URL
const isControlCode = c => c === 9 || c === 10 || c === 13
const STORE_NAME = /^[A-Za-z0-9._-]+$/
const PERCENT_BYTE = /%([0-9A-Fa-f]{2})/g
const PERCENT_ENCODED = /%[0-9A-Fa-f]{2}/
const URL_CONTROL = /[\t\r\n]/
const URL_CONTROLS = /[\t\r\n]/g
const SCRIPT = /\.js$/i
// The longest run with `%` that is decoded, and the most decodings. A store URL written out is at most 1,153
// characters (ASSETS_BASE_URL is at most 1,024, index.js; a name at most 128), so even percent-encoded once as a
// whole (every character at most 3: a URL passed in a query parameter) it is at most 3,459, under the cap. Longer
// runs, or ones still changing after the last pass (a name encoded more than PERCENT_PASSES times), are not decoded
// further, which would cost time that grows with the square of their length: the text cannot be read with certainty
// and nothing is deleted.
const PERCENT_RUN_MAX = 4096
const PERCENT_PASSES = 8
// the largest file the clean-up reads (a script, storage.json) when index.js gives no limit: 16 MiB, above the
// default upload limit (PUBLIC_MAX_UPLOAD_SIZE=12) and the default storage limit (4 MiB)
const DEFAULT_READ_LIMIT = 16 * 1024 * 1024
// how many assets a dry run names
const DRY_RUN_LISTED = 50
const say = line => console.log(line)

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
  const keepKey = key => {
    const found = byName.get(key)
    if (!found) return
    for (const file of found) {
      if (kept.has(file)) continue
      kept.add(file)
      onKeep(file)
    }
  }
  const look = (text, from, to) => {
    if (lengths.has(to - from)) keepKey(text.slice(from, to).toLowerCase())
  }
  // where the text being scanned comes from (for the log), and the places that held a run it could not decide
  let source = ''
  const undecidable = []
  const cannotDecide = () => {
    if (!undecidable.includes(source)) undecidable.push(source)
  }
  const run = (text, from, to, percent) => {
    if (percent) {
      // ASCII bytes only (store names are ASCII), up to PERCENT_PASSES times, so a name encoded more than once is
      // found; what is left of `%` then cannot be part of a name, so the decoded text is scanned with `%` as a
      // separator. A run too long to decode, or still changing after the last pass, cannot be decided.
      if (to - from > PERCENT_RUN_MAX) return cannotDecide()
      let decoded = text.slice(from, to)
      let settled = false
      for (let pass = 0; pass < PERCENT_PASSES; pass++) {
        const next = decoded.replace(PERCENT_BYTE, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        if (next === decoded) {
          settled = true
          break
        }
        decoded = next
      }
      if (!settled && PERCENT_ENCODED.test(decoded)) return cannotDecide()
      runs(decoded, false)
      return
    }
    look(text, from, to)
    let a = from
    let b = to
    while (a < b && isEdgeCode(text.charCodeAt(a))) a++
    while (b > a && isEdgeCode(text.charCodeAt(b - 1))) b--
    if ((a !== from || b !== to) && a < b) look(text, a, b)
  }
  // `glue`: tabs, CR and LF join runs instead of ending them (the URL parser drops them from a URL, so a name a URL
  // holds with one inside still loads), and only a run that held one is looked at (the others were, without glue)
  const runs = (text, allowPercent, glue = false) => {
    let start = -1
    let percent = false
    let glued = false
    for (let i = 0; i <= text.length; i++) {
      const c = i < text.length ? text.charCodeAt(i) : -1
      if (c !== -1 && (isNameCode(c) || (allowPercent && c === PERCENT) || (glue && isControlCode(c)))) {
        if (start < 0) {
          start = i
          percent = false
          glued = false
        }
        if (c === PERCENT) percent = true
        if (glue && isControlCode(c)) glued = true
        continue
      }
      if (start >= 0 && !glue) run(text, start, i, percent)
      else if (start >= 0 && glued) {
        const token = text.slice(start, i).replace(URL_CONTROLS, '')
        if (token) run(token, 0, token.length, percent)
      }
      start = -1
    }
  }
  const scan = text => {
    if (typeof text !== 'string') return
    runs(text, true)
    if (URL_CONTROL.test(text)) runs(text, true, true)
  }
  return {
    kept,
    scan,
    undecidable,
    from: label => {
      source = label
    },
  }
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

const listed = names =>
  `${JSON.stringify(names.slice(0, DRY_RUN_LISTED))}${names.length > DRY_RUN_LISTED ? ` and ${names.length - DRY_RUN_LISTED} more` : ''}`

class Cleaner {
  // storageFile: the script storage file (storage.json), read here without changing it; Storage opens it later.
  // assetsUrl: where clients read the asset store (ASSETS_BASE_URL). localStore: the store is the assets directory
  // (ASSETS=local), so unreferenced files go to its trash, kept for trashDays (CLEAN_TRASH_DAYS; 0: deleted at once).
  // now: the clock, for the trash. readLimit: the largest file read (a script, storage.json), and the most an S3
  // object may expand to (index.js: the larger of the upload and storage limits)
  async init({
    db,
    storageFile,
    assetsUrl,
    localStore = false,
    trashDays = 0,
    now = Date.now,
    readLimit = DEFAULT_READ_LIMIT,
  }) {
    const clean = process.env.CLEAN === 'true' || process.env.CLEAN === 'dryrun'
    if (!clean) return say('[clean] skipped')
    const dryrun = process.env.CLEAN === 'dryrun'
    say(dryrun ? '[clean] dry run' : '[clean] running')
    if (!isAbsoluteHttpURL(assetsUrl)) {
      return console.warn(
        `[clean] skipped all deletion: the assets URL is not an absolute http(s) URL (${previewValue(assetsUrl, 48)}), so where scripts come from cannot be told`
      )
    }
    const allAssets = await assets.list() // hash-only assets
    // the trash (ASSETS=local): what it holds is a candidate too, so a file named again comes back
    const trashing = localStore && typeof assets.trashed === 'function'
    const trashed = trashing ? await assets.trashed() : new Map()
    const trashOnly = new Set([...trashed.keys()].filter(name => !allAssets.has(name)))
    const malformed = []
    const unreadable = []
    // kept blueprints whose script is not a store file for certain
    const uncertain = []
    // store scripts whose source joins the corpus, each read once (the list grows while it is read), and the
    // blueprint that names one, for the log
    const scripts = []
    const queued = new Set()
    const namedBy = new Map()
    const readScript = name => {
      if (queued.has(name)) return
      queued.add(name)
      scripts.push(name)
    }
    // A listed file whose name has a character no store name has cannot be matched by a token: it is kept, and if it
    // is a script, its source cannot be read by name either, so nothing is deleted.
    const named = []
    const oddlyNamed = new Set()
    for (const file of [...allAssets, ...trashOnly]) {
      if (STORE_NAME.test(file)) named.push(file)
      else {
        oddlyNamed.add(file)
        if (SCRIPT.test(file)) unreadable.push(`script ${previewValue(file, 80)} (a name the clean-up cannot read)`)
      }
    }
    const { kept, scan, undecidable, from } = createNameScan(named, file => {
      if (SCRIPT.test(file)) readScript(file)
    })
    // a file's text, held to readLimit (storage.json and its copies; the stores hold scripts to it themselves)
    const readLimited = async file => {
      const { size } = await fs.stat(file)
      if (size > readLimit) throw Object.assign(new Error(`larger than ${readLimit} bytes`), { code: 'TOO_LARGE' })
      return fs.readFile(file, 'utf8')
    }
    const inspect = (table, id, fn) => {
      try {
        fn()
      } catch {
        malformed.push({ table, id })
      }
    }
    // the script that runs (hydration's sanitised value): a store file for certain is read whatever its extension
    // (its name is in the text scanned, so it is kept as well); anything else that is a script stops all deletion
    const keepScript = (id, value) => {
      const script = scriptSource(value, assetsUrl)
      if (script.source === 'store') {
        if (!namedBy.has(script.name)) namedBy.set(script.name, String(id).slice(0, 24))
        readScript(script.name)
      } else if (script.source === 'unknown') {
        uncertain.push(String(id).slice(0, 24))
      }
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
        from(`entity ${previewValue(row.id)}`)
        scanValue(data, scan)
      })
    }
    const blueprintsToDelete = []
    const blueprintRows = await db('blueprints')
    for (const row of blueprintRows) {
      inspect('blueprints', row.id, () => {
        const data = JSON.parse(row.data)
        // persisted: the shape is checked, not the model/script reference rule for new values; the value is what
        // hydration loads (its model and script cut at 2,048 characters)
        const result = sanitizeBlueprintAdd(data, { persisted: true })
        if (!result.ok || result.value.id !== row.id) throw new Error('invalid blueprint')
        // an orphan is deleted with what only it names; a kept one joins the corpus as stored and as loaded
        if (blueprintIds.has(row.id)) {
          from(`blueprint ${previewValue(row.id)}`)
          scanValue(data, scan)
          scanValue(result.value, scan)
          keepScript(row.id, result.value.script)
        } else {
          blueprintsToDelete.push(row.id)
        }
      })
    }
    for (const blueprint of collections.blueprints) {
      inspect('collections', blueprint?.id, () => {
        const result = sanitizeBlueprintAdd(blueprint, { persisted: true })
        if (!result.ok) throw new Error('invalid blueprint')
        from(`collection blueprint ${previewValue(blueprint.id)}`)
        scanValue(blueprint, scan)
        scanValue(result.value, scan)
        keepScript(blueprint.id, result.value.script)
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
      from('settings')
      scanValue(settings, scan)
    })
    const userRows = await db('users').select('id', 'avatar')
    for (const user of userRows) {
      inspect('users', user.id, () => {
        if (user.avatar != null && typeof user.avatar !== 'string') throw new Error('invalid user avatar')
        from(`user ${previewValue(user.id)}`)
        scan(user.avatar)
      })
    }
    // script storage (world.set), parsed; a copy set aside as unreadable (storage.json.corrupt-*) as text, so an
    // operator who restores it finds its assets still there. A file larger than readLimit is not read: before, a
    // multi-GB one was read whole (the read then failed only past Node's string or file-size limits, after the
    // memory was taken)
    if (storageFile) {
      try {
        const text = await readLimited(storageFile)
        try {
          from('storage.json')
          scanValue(JSON.parse(text), scan)
        } catch {
          unreadable.push('storage.json does not parse as JSON')
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
            const text = await readLimited(path.join(dir, name))
            from(name)
            scan(text)
          } catch (err) {
            unreadable.push(`${name} (${err?.code || 'read failed'})`)
          }
        }
      } catch (err) {
        unreadable.push(`world directory (${err?.code || 'read failed'})`)
      }
    }
    // The fixed point: each store script read joins the corpus, and a .js file it keeps is read in turn. A trashed
    // one is read where it lies. A script that is missing stops all deletion wherever the store is: a CDN or a cache
    // in front of it may still serve it, and stopping is the safe direction.
    for (let i = 0; i < scripts.length; i++) {
      const name = scripts[i]
      const owner = namedBy.has(name) ? ` named by blueprint ${JSON.stringify(namedBy.get(name))}` : ''
      try {
        let text = await assets.readText(name, { limit: readLimit })
        if (text === null && trashed.has(name)) {
          text = await assets.readTrashedText(name, trashed.get(name), { limit: readLimit })
        }
        if (text === null) {
          unreadable.push(`script ${name}${owner} is missing (a CDN or cache may still serve it; remove or replace it)`)
          continue
        }
        from(`script ${name}`)
        scan(text)
      } catch (err) {
        unreadable.push(`script ${name}${owner} (${err?.code || err?.message || 'read failed'})`)
      }
    }
    // a trashed file named again comes back, whatever else happens below (bringing a file back is always safe)
    const restore = [...kept].filter(name => trashOnly.has(name)).sort()
    // a named file none of whose trashed copies could come back: the trash is not purged this run, so whatever copy
    // of it is left stays
    let keepTrash = false
    if (restore.length) {
      if (dryrun) {
        console.warn(`[clean] dry run: ${restore.length} assets would come back from the trash: ${listed(restore)}`)
      } else {
        const { restored, failed, lost } = await assets.restoreFromTrash(restore, trashed)
        if (restored.length) {
          console.warn(`[clean] ${restored.length} assets named again came back from the trash: ${listed(restored)}`)
        }
        if (lost.length) {
          keepTrash = true
          console.warn(
            `[clean] ${lost.length} assets named again could not come back: their trashed copies were gone (${listed(lost)}); the trash is not purged this run`
          )
        }
        if (failed.length) {
          unreadable.push(
            `trash (${failed.length} assets could not come back: ${listed(failed.map(item => item.name))})`
          )
        }
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
    // a percent-encoded run too long or too deep to decide: the scan cannot be read with certainty
    if (undecidable.length) {
      console.warn(
        `[clean] skipped all deletion: ${listed(undecidable)} hold a percent-encoded run the clean-up cannot read with certainty (longer than ${PERCENT_RUN_MAX} characters, or still encoded after ${PERCENT_PASSES} decodings)`
      )
      return
    }
    // a script from elsewhere may world.load assets no record names, and the clean-up does not fetch code at
    // start-up: discovery is incomplete, so nothing is deleted
    if (uncertain.length) {
      console.warn(
        `[clean] skipped all deletion: kept blueprints run a script that is not a store file for certain ${JSON.stringify(uncertain)}; give them an asset:// script (upload it as an asset) so the clean-up can read it`
      )
      return
    }
    // Discovery is complete, within the contract (above). The trash folders past their days go first (after what
    // was named again came back).
    if (trashing && !keepTrash && typeof assets.purgeTrash === 'function') {
      const purge = await assets.purgeTrash(trashDays, now(), { dryrun })
      if (purge.days.length) {
        say(
          `[clean] ${dryrun ? 'dry run: would remove' : 'removed'} ${purge.days.length} trash folders at least ${trashDays} days old (${purge.files} files): ${listed(purge.days)}`
        )
      }
    }
    if (blueprintsToDelete.length) {
      say(`[clean] ${blueprintsToDelete.length} blueprints can be deleted`)
      if (!dryrun) {
        for (const id of blueprintsToDelete) {
          await db('blueprints').where('id', id).delete()
        }
        say(`[clean] ${blueprintsToDelete.length} blueprints deleted`)
      }
    }
    const assetsToDelete = new Set([...allAssets].filter(asset => !kept.has(asset) && !oddlyNamed.has(asset)))
    if (!assetsToDelete.size) return say('[clean] complete')
    const toTrash = trashing && trashDays > 0 && typeof assets.moveToTrash === 'function'
    // a dry run names them
    const names = dryrun ? [...assetsToDelete].sort() : []
    say(
      `[clean] ${assetsToDelete.size} assets can be ${toTrash ? 'moved to the trash' : 'deleted'}${dryrun ? `: ${listed(names)}` : ''}`
    )
    if (dryrun) return say('[clean] complete')
    if (toTrash) {
      const { moved, failed, dir } = await assets.moveToTrash(assetsToDelete, now())
      say(`[clean] ${moved.length} assets moved to ${dir} (removed for good after ${trashDays} days)`)
      if (failed.length) {
        console.warn(
          `[clean] ${failed.length} assets could not be moved and stay: ${JSON.stringify(failed.slice(0, 10).map(item => `${String(item.name).slice(0, 80)} (${item.code})`))}`
        )
      }
      return say('[clean] complete')
    }
    // S3 answers per key: one it could not delete is still there
    const failed = (await assets.delete(assetsToDelete))?.failed ?? []
    say(`[clean] ${assetsToDelete.size - failed.length} assets deleted`)
    if (failed.length) {
      console.warn(
        `[clean] ${failed.length} assets could not be deleted: ${JSON.stringify(failed.slice(0, 10).map(item => `${String(item.name).slice(0, 80)} (${item.code})`))}`
      )
    }
    say('[clean] complete')
  }
}

export const cleaner = new Cleaner()
