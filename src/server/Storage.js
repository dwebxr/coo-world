import fs from 'node:fs'
import path from 'node:path'
import { briefError } from '../core/extras/logOnce.js'
import { previewValue } from '../core/extras/assetURL.js'
import { removeTempFiles, writeFileAtomic } from './atomicWrite.js'

// explicit `.js` imports only: this module is exercised directly by node:test

// Script storage (`world.set` / `world.get`, server only): one JSON object in <world>/storage.json.
//
// Limits (STORAGE_* envs, read once at start-up): a key is a string of 1 to 128 characters, a value's JSON is at
// most 64 KiB, at most 1,024 keys, and the whole file at most 4 MiB. They limit growth only: a file that is already
// over a limit when the server starts is loaded and served as it is (and reported once); a set that would make an
// over-limit store larger, or add a key beyond the count, is refused, while overwriting a key with a value that does
// not make it larger, and deleting (`world.set(key, undefined)`), stay possible. A refusal throws to the script.
//
// The key rule is for new keys: a key stored before it existed can still be overwritten (within the value limits)
// and deleted.
//
// Writes: at most one per second, never two at once (the latest state wins), each to a temp file that is fsynced
// and renamed over storage.json (atomicWrite.js). From the final save on (flush, at shutdown) world.set is refused,
// so nothing is accepted that would not be written.
//
// Start-up: a storage.json whose content was read and is not a JSON object is renamed to
// storage.json.corrupt-<time> and the server starts with an empty store. A file that cannot be read at all (EIO,
// EACCES, EMFILE, ...) is read again a few times; if it still fails, the store is unavailable for this run
// (world.set throws, world.get returns undefined) and the file is left exactly as it is.

export const KEY_MAX_LENGTH = 128
export const STORAGE_DEFAULTS = Object.freeze({ maxKeys: 1024, maxValueBytes: 64 * 1024, maxBytes: 4 * 1024 * 1024 })
const WRITE_INTERVAL_MS = 1000
// an unreadable file is read again this many times, this far apart (start-up only, so about a second in all)
const READ_RETRIES = 4
const READ_PAUSE_MS = 250

// blocks the thread (start-up only, before anything else runs)
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function readStorageLimitsEnv(env) {
  const read = (name, fallback) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`[envs] ${name} must be a positive integer`)
    return value
  }
  return {
    maxKeys: read('STORAGE_MAX_KEYS', STORAGE_DEFAULTS.maxKeys),
    maxValueBytes: read('STORAGE_MAX_VALUE_BYTES', STORAGE_DEFAULTS.maxValueBytes),
    maxBytes: read('STORAGE_MAX_BYTES', STORAGE_DEFAULTS.maxBytes),
  }
}

const isPlainObject = value =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

// the bytes a key and its value take in the file: "key":value
const entryBytes = (key, valueBytes) => Buffer.byteLength(JSON.stringify(key)) + 1 + valueBytes

export class Storage {
  // `fs`: the promise API the writes use (tests inject a slow or failing one); `readFile`: the start-up read
  // (node:fs readFileSync; tests inject a failing one)
  constructor(
    file,
    {
      limits = STORAGE_DEFAULTS,
      fs: fsp = fs.promises,
      intervalMs = WRITE_INTERVAL_MS,
      readFile = fs.readFileSync,
      readPauseMs = READ_PAUSE_MS,
    } = {}
  ) {
    this.file = file
    this.limits = { ...STORAGE_DEFAULTS, ...limits }
    this.fsp = fsp
    this.intervalMs = intervalMs
    this.values = new Map() // key -> { json, bytes } (the value's JSON text and its UTF-8 length)
    this.bytes = 0 // the file as it is written: {"k":v,...} plus a newline
    this.unavailable = null // why the store is off for this run (a file that could not be read or moved aside)
    this.dirty = false
    this.revision = 0 // counts accepted changes; savedRevision is the last one a completed write holds
    this.savedRevision = 0
    this.writing = null
    this.timer = null
    this.stopping = false // the final save has started: no set is accepted, no timer is started
    this.lastWriteAt = -Infinity
    this.failure = null // the last write's error code, logged once until a write succeeds
    this.load(readFile, readPauseMs)
  }

  // the file's text, null when there is none; throws the last error when it cannot be read after the retries
  read(readFile, pauseMs) {
    for (let attempt = 0; ; attempt++) {
      try {
        return readFile(this.file, 'utf8')
      } catch (err) {
        if (err?.code === 'ENOENT') return null
        if (attempt >= READ_RETRIES) throw err
        pause(pauseMs)
      }
    }
  }

  load(readFile, pauseMs) {
    const name = path.basename(this.file)
    // a write cut off by a crash leaves its temp file; storage.json itself is the complete old state
    removeTempFiles(path.dirname(this.file), { match: entry => entry.endsWith(`-${name}`) })
    this.bytes = this.measure()
    let text
    try {
      text = this.read(readFile, pauseMs)
    } catch (err) {
      // not a sign the content is bad: the file stays where it is and nothing is written over it this run
      const code = err?.code || briefError(err)
      this.unavailable = `${name} could not be read (${code})`
      console.error(
        `[storage] ${name} could not be read (${code}) after ${READ_RETRIES + 1} attempts: world.set() is refused and world.get() returns nothing for this run; the file is left as it is`
      )
      return
    }
    if (text === null) return
    let data
    try {
      data = JSON.parse(text)
      if (!isPlainObject(data)) throw new Error('not a JSON object')
    } catch (err) {
      this.quarantine(`could not be parsed (${briefError(err)})`)
      return
    }
    for (const key of Object.keys(data)) {
      const json = JSON.stringify(data[key])
      this.values.set(key, { json, bytes: Buffer.byteLength(json) })
    }
    this.bytes = this.measure()
    this.reportOverLimits()
  }

  // moves a file whose content is not a store aside so nothing writes over it; the store starts empty
  quarantine(reason) {
    const name = path.basename(this.file)
    const target = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      fs.renameSync(this.file, target)
      console.error(
        `[storage] ${name} ${reason}: moved to ${path.basename(target)}; starting with an empty store, so world.get() returns nothing until scripts set values again`
      )
    } catch (err) {
      this.unavailable = `${name} ${reason} and could not be moved aside`
      console.error(
        `[storage] ${name} ${reason} and could not be moved aside (${err?.code || briefError(err)}): world.set() is refused for this run so the file is never written over`
      )
    }
  }

  measure() {
    let bytes = 3 // {}\n
    for (const [key, entry] of this.values) bytes += entryBytes(key, entry.bytes)
    return bytes + Math.max(0, this.values.size - 1) // commas
  }

  reportOverLimits() {
    const { maxKeys, maxValueBytes, maxBytes } = this.limits
    const over = []
    if (this.values.size > maxKeys) over.push(`${this.values.size} keys (limit ${maxKeys})`)
    if (this.bytes > maxBytes) over.push(`${this.bytes} bytes (limit ${maxBytes})`)
    let large = 0
    let largest = null
    for (const [key, entry] of this.values) {
      if (entry.bytes <= maxValueBytes) continue
      large++
      if (!largest || entry.bytes > largest.bytes) largest = { key, bytes: entry.bytes }
    }
    if (large) {
      over.push(
        `${large} values over ${maxValueBytes} bytes (largest ${previewValue(largest.key, 32)}: ${largest.bytes})`
      )
    }
    if (over.length) {
      console.warn(
        `[storage] ${path.basename(this.file)} is over its limits: ${over.join(', ')}; it is served as it is, and may shrink but not grow`
      )
    }
  }

  // a copy: what one app gets cannot change what another app reads without world.set
  get(key) {
    if (this.unavailable) return undefined
    // a number reads the key a number was once stored under (keys are strings in the file)
    if (typeof key === 'number') key = String(key)
    if (typeof key !== 'string') return undefined
    const entry = this.values.get(key)
    return entry ? JSON.parse(entry.json) : undefined
  }

  set(key, value) {
    this.assertWritable()
    const keyRule = `world.set: the key must be a string of 1 to ${KEY_MAX_LENGTH} characters`
    if (typeof key !== 'string') throw new TypeError(keyRule)
    const { maxKeys, maxValueBytes, maxBytes } = this.limits
    if (value === undefined) {
      const current = this.values.get(key)
      if (!current) return
      this.values.delete(key)
      this.bytes -= entryBytes(key, current.bytes) + (this.values.size ? 1 : 0)
      return this.changed()
    }
    let json
    try {
      json = JSON.stringify(value)
    } catch {
      json = undefined
    }
    if (typeof json !== 'string') throw new TypeError('world.set: the value cannot be stored as JSON')
    // read only now: the value's own toJSON or getters run script code, which may have called world.set
    this.assertWritable()
    const current = this.values.get(key)
    if (!current && (key.length < 1 || key.length > KEY_MAX_LENGTH)) throw new TypeError(keyRule)
    if (current?.json === json) return
    const valueBytes = Buffer.byteLength(json)
    if (valueBytes > maxValueBytes && (!current || valueBytes > current.bytes)) {
      throw new RangeError(`world.set: the value is ${valueBytes} bytes as JSON; the limit is ${maxValueBytes}`)
    }
    if (!current && this.values.size >= maxKeys) {
      throw new RangeError(
        `world.set: storage holds ${this.values.size} keys; the limit is ${maxKeys} (world.set(key, undefined) deletes one)`
      )
    }
    const next = current
      ? this.bytes + valueBytes - current.bytes
      : this.bytes + entryBytes(key, valueBytes) + (this.values.size ? 1 : 0)
    if (next > maxBytes && next > this.bytes) {
      throw new RangeError(`world.set: storage would be ${next} bytes; the limit is ${maxBytes}`)
    }
    this.values.set(key, { json, bytes: valueBytes })
    this.bytes = next
    this.changed()
  }

  assertWritable() {
    if (this.unavailable) throw new Error(`world.set: storage is unavailable (${this.unavailable})`)
    // script timers and promise continuations can still run while the final save is written
    if (this.stopping) throw new Error('world.set: the server is stopping; the value was not stored')
  }

  changed() {
    this.revision++
    this.dirty = true
    this.schedule()
  }

  // everything accepted so far is in the file
  saved() {
    return !this.dirty && !this.writing && this.savedRevision === this.revision
  }

  schedule() {
    if (this.timer || this.writing || this.stopping) return
    const wait = Math.max(0, this.lastWriteAt + this.intervalMs - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.write()
    }, wait)
    this.timer.unref?.()
  }

  serialize() {
    const parts = []
    for (const [key, entry] of this.values) parts.push(`${JSON.stringify(key)}:${entry.json}`)
    return `{${parts.join(',')}}\n`
  }

  // one write at a time, of the state at its start; a change during it is written by the next one
  write() {
    if (this.writing) return this.writing
    this.dirty = false
    this.lastWriteAt = Date.now()
    const revision = this.revision
    const promise = writeFileAtomic(this.file, this.serialize(), { fs: this.fsp })
      .then(() => {
        if (this.failure) console.log(`[storage] ${path.basename(this.file)} saved again`)
        this.failure = null
        this.savedRevision = Math.max(this.savedRevision, revision)
        return true
      })
      .catch(err => {
        this.dirty = true
        const code = err?.code || briefError(err)
        if (this.failure !== code) {
          console.error(`[storage] failed to save ${path.basename(this.file)} (${code}); retrying`)
        }
        this.failure = code
        return false
      })
      .finally(() => {
        if (this.writing === promise) this.writing = null
        if (this.dirty) this.schedule()
      })
    this.writing = promise
    return promise
  }

  // The final write before the process exits: from here on world.set is refused and no timer is started; waits
  // for a write in progress, then writes what changed since. Resolves true when everything accepted is on disk.
  async flush() {
    this.stopping = true
    clearTimeout(this.timer)
    this.timer = null
    if (this.writing) await this.writing
    if (this.dirty) await this.write()
    return this.saved()
  }
}
