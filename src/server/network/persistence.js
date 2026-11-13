// The persistence of the world: what loads it at start (hydrate: the spawn, the blueprints, the apps, the settings
// and the user ids, and the join state's accounting of them) and writes it back (the dirty marks of blueprints and
// apps, the save queue and its timer, the rows written one at a time, the final save at shutdown under its deadline,
// and the config rows of the spawn and the settings). Moved here as written from src/core/systems/ServerNetwork.js
// (P16): it is a part of that class's file, not a module of its own design. Each function's `this` is the network
// (ServerNetwork declares every one as a member of the kind it had and calls it with itself), and they call one
// another through it, and the class's own members as well (admin, stopForFatal, userRows). The state is where it
// was, on the network: the dirty maps, the revision, the save and config promises, the loaded and dirty config, the
// expired flag and the save timer, made by its constructor.
import moment from 'moment'
import { appPersistenceData, persistenceRecord } from '../../core/extras/persistenceRecord.js'
import { sanitizePersistedApp, sanitizeSpawn } from '../../core/extras/entityModifyPolicy'
import { sanitizeBlueprintAdd, WORLD_BLUEPRINT_BYTES } from '../../core/extras/blueprintPolicy'
import { previewValue } from '../../core/extras/assetURL'
import { SNAPSHOT_CAP } from '../../core/extras/writeLedger'
import { joinStateReport, settingsBytes } from '../../core/extras/joinBudget'
import { briefError } from '../../core/extras/logOnce'

const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL || '60') // seconds
const defaultSpawn = '{ "position": [0, 0, 0], "quaternion": [0, 0, 0, 1] }'

export async function hydrate() {
  // get spawn
  const spawnRow = await this.db('config').where('key', 'spawn').first()
  this.spawn = null
  try {
    this.spawn = sanitizeSpawn(JSON.parse(spawnRow ? spawnRow.value : defaultSpawn))
  } catch (err) {
    // invalid stored JSON uses the same fallback as an invalid pose
  }
  if (!this.spawn) {
    this.spawn = JSON.parse(defaultSpawn)
    this.logOnce(this, 'spawn-invalid', '[network] invalid stored spawn; using default spawn')
  }
  this.loadedConfig.set('spawn', JSON.stringify(this.spawn))
  // hydrate blueprints
  const skippedBlueprints = []
  const skippedApps = []
  const repairedApps = []
  const blueprints = await this.db('blueprints')
  for (const blueprint of blueprints) {
    try {
      // persisted: a stored model/script is kept whatever it holds; the loader decides what it reads (below)
      const result = sanitizeBlueprintAdd(JSON.parse(blueprint.data), { persisted: true })
      if (!result.ok || result.value.id !== blueprint.id) throw new Error('invalid blueprint')
      this.world.blueprints.add(result.value)
    } catch {
      skippedBlueprints.push(blueprint.id)
    }
  }
  // a stored model/script the loader now refuses (a local path, asset:// traversal, another scheme) is reported
  // once per blueprint and left as it is: the app shows the crash block on the server until a builder replaces it.
  // (only test worlds lack the loader)
  if (typeof this.world.loader?.refusedSources === 'function') {
    for (const item of this.world.blueprints.items.values()) {
      const refused = this.world.loader.refusedSources(item)
      if (!refused.length) continue
      const id = previewValue(item.id, 16)
      console.warn(`[network] blueprint ${id} keeps a source the server no longer loads; ${refused.join('; ')}`)
    }
  }
  if (this.world.blueprints.bytes > WORLD_BLUEPRINT_BYTES) {
    console.warn(
      `[network] world blueprint budget exceeded at startup: bytes=${this.world.blueprints.bytes} cap=${WORLD_BLUEPRINT_BYTES}`
    )
  }
  // hydrate entities
  const entities = await this.db('entities')
  for (const entity of entities) {
    try {
      const result = sanitizePersistedApp(JSON.parse(entity.data), {
        blueprintExists: id => !!this.world.blueprints.get(id),
      })
      if (!result || result.data.id !== entity.id) throw new Error('invalid app')
      this.world.entities.add(result.data, true)
      if (result.repaired.length) repairedApps.push({ id: entity.id, fields: result.repaired })
    } catch {
      skippedApps.push(entity.id)
    }
  }
  console.log(
    `[network] hydration: blueprints=${blueprints.length - skippedBlueprints.length} apps=${entities.length - skippedApps.length} repaired=${repairedApps.length} skipped=${skippedBlueprints.length + skippedApps.length} skippedBlueprints=${JSON.stringify(skippedBlueprints)} skippedApps=${JSON.stringify(skippedApps)} repairedApps=${JSON.stringify(repairedApps)}`
  )
  // hydrate settings
  const settingsRow = await this.db('config').where('key', 'settings').first()
  // Before the stored settings are read: a settings row that cannot be parsed left this unset, and unset means
  // "no code, so everyone is admin" (Settings.effectiveRank), with a code configured.
  this.world.settings.setHasAdminCode(this.admin().mode !== 'open')
  try {
    const settings = JSON.parse(settingsRow?.value || '{}')
    this.world.settings.deserialize(settings)
    this.loadedConfig.set('settings', JSON.stringify(this.world.settings.serialize()))
  } catch (err) {
    console.error(err)
  }
  // the user ids, so that no new app takes one: an app holding the id of a user who is away would otherwise make
  // that user's next join collide with it (ids only, about 60 bytes each in memory)
  try {
    for (const row of await this.db('users').select('id')) this.userIds.add(row.id)
  } catch (err) {
    console.error(
      `[network] user ids could not be read (${briefError(err)}); an app that takes one is moved to a new id when that user joins`
    )
  }
  // the join snapshot's world state (joinBudget.js): a world stored over the budget loads whole, is reported,
  // and only shrinks from here. Collections are the operator's files and do not change while the server runs
  this.settingsBytes = settingsBytes(this.world.settings.serialize())
  this.collectionsBytes = settingsBytes(this.world.collections?.serialize() ?? [])
  const joinReport = joinStateReport(this.world, { snapshotCap: SNAPSHOT_CAP })
  if (joinReport) console.warn(joinReport)
  // watch settings changes
  this.world.settings.on('change', this.saveSettings)
  // queue first save
  if (SAVE_INTERVAL && !this.stopping) {
    this.saveTimerId = setTimeout(this.save, SAVE_INTERVAL * 1000)
  }
}

export function markBlueprintDirty(data) {
  const record = persistenceRecord(data)
  this.dirtyBlueprints.set(data.id, { revision: ++this.persistenceRevision, record })
}

export function markAppDirty(data, change) {
  const settled = appPersistenceData(data, change)
  if (settled.mover || settled.uploader) return
  const record = persistenceRecord(settled)
  this.dirtyApps.set(settled.id, { ...this.replacementOf(settled.id), revision: ++this.persistenceRevision, record })
}

export function markAppDeleted(id) {
  this.dirtyApps.set(id, { ...this.replacementOf(id), revision: ++this.persistenceRevision, record: null })
}

// a later change to a re-keyed app (rekeyApp) keeps the old row's removal with it until it is written
export function replacementOf(id) {
  const replaces = this.dirtyApps.get(id)?.replaces
  return replaces === undefined ? {} : { replaces }
}

export function save() {
  clearTimeout(this.saveTimerId)
  const promise = (this.savePromise || Promise.resolve())
    .then(() => this.saveDirty())
    .finally(() => {
      if (this.savePromise !== promise) return
      this.savePromise = null
      if (!this.stopping) this.saveTimerId = setTimeout(this.save, SAVE_INTERVAL * 1000)
    })
  this.savePromise = promise
  return promise
}

// past the final save's deadline (flushBeforeExit): no further row is started
export function saveExpired() {
  if (!this.flushExpired && this.flushDeadline && Date.now() >= this.flushDeadline) this.flushExpired = true
  return this.flushExpired
}

// Each row is its own write, as before: a row that fails stays dirty and the others are still saved. They are
// not grouped in transactions, because on Postgres one failing statement aborts the whole transaction (the rows
// after it would fail with it). better-sqlite3 runs each statement synchronously and knex settles it in a
// microtask, so the loop yields a turn of the event loop after every row: the deadline timer, other timers and a
// second signal run between rows, and the deadline is also checked by the clock before each one. On Postgres the
// queries are asynchronous anyway; a statement already sent finishes or is cut off by the exit.
// The one exception is a row that replaces another (rekeyApp): its insert and the old row's removal are one
// transaction where the database has them, and otherwise the insert comes first, so the app is never lost.
// The server's database is always knex (db.js, SQLite or Postgres), which has transactions: the path without one
// is for stand-in databases only (tests). An interrupted re-key there can leave the app under both ids, and
// nothing at start-up merges the two.
export async function saveDirty() {
  const counts = { blueprints: 0, apps: 0, deleted: 0 }
  const now = moment().toISOString()
  for (const [table, dirty] of [
    ['blueprints', this.dirtyBlueprints],
    ['entities', this.dirtyApps],
  ]) {
    for (const [id, { revision, record, replaces }] of [...dirty]) {
      if (this.saveExpired()) return
      await new Promise(resolve => setImmediate(resolve))
      if (this.saveExpired()) return
      try {
        const upsert = db =>
          db(table)
            .insert({ ...record, createdAt: now, updatedAt: now })
            .onConflict('id')
            .merge({ ...record, updatedAt: now })
        if (record === null) {
          await this.db(table).where('id', id).delete()
          if (replaces !== undefined) await this.db(table).where('id', replaces).delete()
          counts.deleted++
        } else if (replaces !== undefined && typeof this.db.transaction === 'function') {
          await this.db.transaction(async trx => {
            await upsert(trx)
            await trx(table).where('id', replaces).delete()
          })
          counts.apps++
        } else {
          await upsert(this.db)
          if (replaces !== undefined) await this.db(table).where('id', replaces).delete()
          counts[table === 'blueprints' ? 'blueprints' : 'apps']++
        }
        if (dirty.get(id)?.revision === revision) dirty.delete(id)
      } catch (err) {
        console.error(`[network] error saving ${table} ${id}: ${briefError(err)}`)
      }
    }
  }
  if (counts.blueprints || counts.apps || counts.deleted) {
    console.log(`world saved (${counts.blueprints} blueprints, ${counts.apps} apps, ${counts.deleted} apps removed)`)
  }
}

export async function flushBeforeExit(deadlineMs) {
  this.stopForFatal()
  this.flushDeadline = Date.now() + deadlineMs
  const config = new Set()
  for (const [key, saved] of this.loadedConfig) {
    const data = key === 'settings' ? this.world.settings.serialize() : this.spawn
    if (this.dirtyConfig.has(key) || JSON.stringify(data) !== saved) config.add(key)
  }
  // the script storage file (world.set) is written by its own queue, alongside the database writes. Its flush
  // refuses every later world.set, and it counts as saved only if, at the very end, nothing it accepted is unwritten
  const storage = typeof this.world.storage?.flush === 'function' ? this.world.storage : null
  let storageSaved = !storage
  let timer
  const flush = async () => {
    await Promise.all([this.savePromise, this.configPromise])
    if (this.flushExpired) return
    await Promise.all([
      this.save(),
      (async () => {
        // Settings may have broadcast without another preFixedUpdate to emit change.
        if (config.has('settings') && (await this.saveSettings())) config.delete('settings')
        if (config.has('spawn') && (await this.saveConfig('spawn', this.spawn))) config.delete('spawn')
      })(),
    ])
  }
  const flushStorage = async () => {
    if (storage) await storage.flush()
  }
  const incomplete = () => {
    if (storage) storageSaved = storage.saved()
    return (
      this.dirtyBlueprints.size || this.dirtyApps.size || config.size || !storageSaved || this.userRows().unstored()
    )
  }
  try {
    await Promise.race([
      // the users' rows, alongside: the writes under way are waited for, and what a failed one left unstored is
      // tried once more (userRows.js flush). What the database still has not taken at the end is counted (users=)
      Promise.all([flush(), flushStorage(), this.userRows().flush()]),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          this.flushExpired = true
          reject(new Error('save deadline exceeded'))
        }, deadlineMs)
      }),
    ])
    if (incomplete()) {
      throw new Error('final save incomplete')
    }
    console.log('[network] final save complete')
  } finally {
    clearTimeout(timer)
    if (incomplete()) {
      console.error(
        `[network] not persisted: blueprints=${JSON.stringify([...this.dirtyBlueprints.keys()])} apps=${JSON.stringify([...this.dirtyApps.keys()])} config=${JSON.stringify([...config])} users=${this.userRows().unstored()} storage=${storageSaved ? 'saved' : 'unsaved'}`
      )
    }
  }
}

export function saveConfig(key, data) {
  if (!this.loadedConfig.has(key)) {
    // the stored row was never read (or failed to parse); keep it untouched for inspection
    this.logOnce(this, `config-unloaded:${key}`, `[network] ${key} was not loaded; changes will not be saved`)
    return Promise.resolve(false)
  }
  const value = JSON.stringify(data)
  this.dirtyConfig.set(key, value)
  // past the final save's deadline (saveExpired)
  const expired = () => this.flushExpired || Date.now() >= (this.flushDeadline ?? Infinity)
  const promise = (this.configPromise || Promise.resolve())
    .then(async () => {
      if (expired()) return false
      // a turn of the event loop between queued writes, as in saveDirty: a synchronous database would otherwise
      // run the whole queue before a timer or a signal is seen
      await new Promise(resolve => setImmediate(resolve))
      if (expired()) return false
      try {
        if (this.loadedConfig.get(key) !== value) {
          await this.db('config').insert({ key, value }).onConflict('key').merge({ value })
          this.loadedConfig.set(key, value)
        }
        if (this.dirtyConfig.get(key) === value) this.dirtyConfig.delete(key)
        return true
      } catch (err) {
        this.logOnce(this, `config:${key}`, `[network] error saving ${key}: ${briefError(err)}`)
        return false
      }
    })
    .finally(() => {
      if (this.configPromise === promise) this.configPromise = null
    })
  this.configPromise = promise
  return promise
}

export function saveSettings() {
  return this.saveConfig('settings', this.world.settings.serialize())
}
