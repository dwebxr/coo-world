import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isArray, isEqual, isFunction } from 'lodash-es'
import { Storage, STORAGE_DEFAULTS, readStorageLimitsEnv } from '../src/server/Storage.js'
import { createEntityProxy } from '../src/core/extras/createEntityProxy.js'
import { toScriptError } from '../src/core/extras/scriptValues.js'
import { createEventLedger } from '../src/core/extras/appEventQueue.js'
import { loadClient } from './lib/clientHarness.mjs'

function tempWorld(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, file: path.join(dir, 'storage.json') }
}

function quiet(t) {
  const lines = { warn: [], error: [], log: [] }
  for (const level of ['warn', 'error', 'log'])
    t.mock.method(console, level, (...args) => lines[level].push(args.join(' ')))
  return lines
}

const onDisk = file => JSON.parse(fs.readFileSync(file, 'utf8'))

// world.get / world.set as a script calls them: the real Apps world methods behind the entity proxy
function scriptWorld(storage) {
  const Apps = loadClient('core/systems/Apps.js', 'Apps', {
    isArray,
    isEqual,
    isFunction,
    createEventLedger,
    toScriptError,
  })
  const world = { storage, network: { isServer: true } }
  const apps = new Apps(world)
  return createEntityProxy({ world }, { getters: {}, setters: {}, methods: apps.worldMethods })
}

test('storage: limits default to 1,024 keys, 64 KiB values and 4 MiB, read from STORAGE_* envs', () => {
  assert.deepEqual(readStorageLimitsEnv({}), { maxKeys: 1024, maxValueBytes: 65536, maxBytes: 4194304 })
  assert.deepEqual(STORAGE_DEFAULTS, { maxKeys: 1024, maxValueBytes: 65536, maxBytes: 4194304 })
  assert.deepEqual(
    readStorageLimitsEnv({ STORAGE_MAX_KEYS: '10', STORAGE_MAX_VALUE_BYTES: '', STORAGE_MAX_BYTES: '2048' }),
    { maxKeys: 10, maxValueBytes: 65536, maxBytes: 2048 }
  )
  for (const value of ['0', '-1', '1.5', 'x', 'Infinity']) {
    assert.throws(
      () => readStorageLimitsEnv({ STORAGE_MAX_KEYS: value }),
      /STORAGE_MAX_KEYS must be a positive integer/
    )
  }
})

test('storage: each limit refuses the set with a script error and leaves the store and the file as they were', async t => {
  quiet(t)
  const { file } = tempWorld(t)
  const storage = new Storage(file, { limits: { maxKeys: 3, maxValueBytes: 100, maxBytes: 150 }, intervalMs: 0 })
  const world = scriptWorld(storage)
  world.set('a', { n: 1 })
  world.set('b', 'x'.repeat(40))
  await storage.flush()
  const before = fs.readFileSync(file, 'utf8')
  const state = () => [storage.get('a'), storage.get('b'), storage.get('c'), storage.values.size, storage.bytes]
  const kept = state()
  const refusals = [
    [() => world.set('', 1), TypeError, /key must be a string of 1 to 128 characters/],
    [() => world.set('k'.repeat(129), 1), TypeError, /key must be a string/],
    [() => world.set(5, 1), TypeError, /key must be a string/],
    [() => world.set({ toString: () => 'a' }, 1), TypeError, /key must be a string/],
    [() => world.set('c', 'v'.repeat(99)), RangeError, /the value is 101 bytes as JSON; the limit is 100/],
    [() => world.set('c', '€'.repeat(33)), RangeError, /the value is 101 bytes/],
    [() => world.set('c', () => 1), TypeError, /cannot be stored as JSON/],
    [() => world.set('c', 10n), TypeError, /cannot be stored as JSON/],
    [
      () =>
        world.set('c', {
          get x() {
            throw new Error('getter')
          },
        }),
      TypeError,
      /cannot be stored as JSON/,
    ],
  ]
  const cyclic = {}
  cyclic.self = cyclic
  refusals.push([() => world.set('c', cyclic), TypeError, /cannot be stored as JSON/])
  for (const [call, Type, message] of refusals) {
    assert.throws(call, err => err instanceof Type && message.test(err.message))
  }
  // total: a third key whose entry would make the file larger than 150 bytes
  assert.throws(() => world.set('c', 'x'.repeat(98)), /storage would be 166 bytes; the limit is 150/)
  world.set('c', 1)
  // count: a fourth key
  assert.throws(() => world.set('d', 1), /storage holds 3 keys; the limit is 3/)
  assert.deepEqual(storage.get('d'), undefined)
  assert.deepEqual(state().slice(0, 2), kept.slice(0, 2))
  await storage.flush()
  assert.notEqual(fs.readFileSync(file, 'utf8'), before, 'only the accepted set was written')
  assert.deepEqual(onDisk(file), { a: { n: 1 }, b: 'x'.repeat(40), c: 1 })
  assert.equal(Buffer.byteLength(fs.readFileSync(file)), storage.bytes, 'tracked size is the file size')
})

test('storage: a store loaded over its limits is served as it is, reported once, and may shrink but not grow', async t => {
  const lines = quiet(t)
  const { file } = tempWorld(t)
  const big = 'b'.repeat(150)
  const stored = { a: 1, b: 2, c: 3, d: big, e: 'e' }
  fs.writeFileSync(file, JSON.stringify(stored))
  const limits = { maxKeys: 3, maxValueBytes: 100, maxBytes: 150 }
  const storage = new Storage(file, { limits, intervalMs: 0 })
  for (const [key, value] of Object.entries(stored)) assert.deepEqual(storage.get(key), value)
  assert.equal(lines.warn.length, 1)
  assert.match(
    lines.warn[0],
    /over its limits: 5 keys \(limit 3\), 185 bytes \(limit 150\), 1 values over 100 bytes \(largest "d": 152\)/
  )
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(stored), 'loading does not rewrite the file')
  // growth is refused: a new key, a larger value, a larger oversized value
  assert.throws(() => storage.set('f', 1), /storage holds 5 keys; the limit is 3/)
  assert.throws(() => storage.set('a', 'x'.repeat(10)), /storage would be/)
  assert.throws(() => storage.set('d', big + 'b'), /the value is 153 bytes/)
  // overwriting without growing, shrinking and deleting stay possible
  storage.set('a', 9)
  storage.set('d', 'c'.repeat(150))
  storage.set('d', 'small')
  storage.set('e', undefined)
  storage.set('missing', undefined)
  assert.equal(storage.get('e'), undefined)
  assert.throws(() => storage.set('f', 1), /storage holds 4 keys/, 'still over the count')
  storage.set('c', undefined)
  storage.set('b', undefined)
  storage.set('f', 1)
  assert.ok(await storage.flush())
  assert.deepEqual(onDisk(file), { a: 9, d: 'small', f: 1 })
  assert.equal(lines.warn.length, 1)
})

test('storage: world.get hands each caller its own copy', t => {
  quiet(t)
  const { file } = tempWorld(t)
  const storage = new Storage(file, { intervalMs: 0 })
  const world = scriptWorld(storage)
  const value = { list: [1, 2], nested: { n: 1 } }
  world.set('shared', value)
  value.list.push('mutated after set')
  const first = world.get('shared')
  first.list.push('mutated by app A')
  first.nested.n = 99
  const second = world.get('shared')
  assert.deepEqual(second, { list: [1, 2], nested: { n: 1 } })
  assert.notEqual(first, second)
  assert.equal(world.get('absent'), undefined)
  assert.equal(world.get(123), undefined)
})

test('storage: writes never overlap under a slow disk, and the last state wins', async t => {
  quiet(t)
  const { file } = tempWorld(t)
  let inFlight = 0
  let maxInFlight = 0
  let writes = 0
  const gates = []
  const slow = {
    ...fs.promises,
    open: async (target, flags) => {
      const handle = await fs.promises.open(target, flags)
      if (flags !== 'wx') return handle
      inFlight++
      writes++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const writeFile = handle.writeFile.bind(handle)
      handle.writeFile = async data => {
        await new Promise(resolve => gates.push(resolve))
        return writeFile(data)
      }
      const close = handle.close.bind(handle)
      handle.close = async () => {
        inFlight--
        return close()
      }
      return handle
    },
  }
  const storage = new Storage(file, { fs: slow, intervalMs: 5 })
  const release = async () => {
    while (!gates.length) await new Promise(resolve => setTimeout(resolve, 1))
    gates.shift()()
  }
  for (let i = 0; i < 20; i++) {
    storage.set('counter', i)
    storage.set(`key${i % 3}`, i)
    await new Promise(resolve => setTimeout(resolve, 2))
    if (i % 4 === 3) await release()
  }
  let result = null
  const flushed = storage.flush().then(value => (result = value))
  while (result === null) {
    if (gates.length) gates.shift()()
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  await flushed
  assert.equal(result, true)
  assert.equal(maxInFlight, 1, 'one write at a time')
  assert.ok(writes >= 2 && writes < 20, `writes are coalesced (${writes})`)
  assert.deepEqual(onDisk(file), { counter: 19, key0: 18, key1: 19, key2: 17 })
})

test('storage: each write is fsynced and renamed into place; a crash before the rename leaves the old file', async t => {
  const lines = quiet(t)
  const { dir, file } = tempWorld(t)
  fs.writeFileSync(file, JSON.stringify({ old: true }))
  const calls = []
  let crash = true
  const recording = {
    ...fs.promises,
    open: async (target, flags) => {
      const handle = await fs.promises.open(target, flags)
      if (flags !== 'wx') return handle
      for (const method of ['writeFile', 'sync', 'close']) {
        const original = handle[method].bind(handle)
        handle[method] = (...args) => {
          calls.push(method)
          return original(...args)
        }
      }
      return handle
    },
    rename: async (from, to) => {
      calls.push('rename')
      if (crash) throw Object.assign(new Error('killed before rename'), { code: 'ECRASH' })
      return fs.promises.rename(from, to)
    },
  }
  const storage = new Storage(file, { fs: recording, intervalMs: 0 })
  storage.set('old', false)
  storage.set('new', 1)
  assert.equal(await storage.flush(), false, 'the failed write is reported')
  assert.deepEqual(calls, ['writeFile', 'sync', 'close', 'rename'])
  assert.deepEqual(onDisk(file), { old: true }, 'the old file is intact')
  assert.deepEqual(fs.readdirSync(dir), ['storage.json'], 'the temp file is removed')
  assert.equal(lines.error.filter(line => /failed to save storage\.json \(ECRASH\)/.test(line)).length, 1)
  // a real crash leaves the temp file behind: the next start removes it and keeps storage.json
  fs.writeFileSync(path.join(dir, '~tmp-0123456789ab-storage.json'), '{"half":')
  fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}')
  const restarted = new Storage(file, { intervalMs: 0 })
  assert.deepEqual(restarted.get('old'), true)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['storage.json', 'unrelated.json'])
  crash = false
  calls.length = 0
  storage.stopped = false
  assert.equal(await storage.flush(), true)
  assert.deepEqual(onDisk(file), { old: false, new: 1 })
})

for (const [name, text] of [
  ['truncated JSON', '{"score":{"alice":'],
  ['an empty file', ''],
  ['a JSON array', '[1,2]'],
  ['JSON null', 'null'],
]) {
  test(`storage: ${name} is moved aside at start-up, never written over, and the store starts empty`, async t => {
    const lines = quiet(t)
    const { dir, file } = tempWorld(t)
    fs.writeFileSync(file, text)
    const storage = new Storage(file, { intervalMs: 0 })
    assert.equal(storage.get('score'), undefined)
    const corrupt = fs.readdirSync(dir).filter(entry => entry.startsWith('storage.json.corrupt-'))
    assert.equal(corrupt.length, 1)
    assert.match(corrupt[0], /^storage\.json\.corrupt-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/)
    assert.equal(fs.readFileSync(path.join(dir, corrupt[0]), 'utf8'), text)
    assert.equal(fs.existsSync(file), false)
    assert.equal(lines.error.length, 1)
    assert.match(
      lines.error[0],
      /storage\.json could not be parsed .*moved to storage\.json\.corrupt-.*starting with an empty store/
    )
    storage.set('fresh', 1)
    await storage.flush()
    assert.deepEqual(onDisk(file), { fresh: 1 })
    assert.equal(fs.readFileSync(path.join(dir, corrupt[0]), 'utf8'), text, 'the quarantined copy is untouched')
  })
}

test('storage: a file that can be neither read nor moved aside disables world.set instead of writing over it', t => {
  const lines = quiet(t)
  const { dir, file } = tempWorld(t)
  // a directory under the file's name: unreadable as a file; a read-only parent keeps it from being moved
  fs.mkdirSync(file)
  fs.chmodSync(dir, 0o555)
  let storage
  try {
    storage = new Storage(file, { intervalMs: 0 })
  } finally {
    fs.chmodSync(dir, 0o755)
  }
  if (!storage.unavailable) return t.skip('the platform let the directory be renamed (running as root?)')
  assert.match(lines.error[0], /could not be read \(EISDIR\) and could not be moved aside/)
  assert.throws(() => storage.set('k', 1), /world\.set: storage is unavailable/)
  assert.equal(storage.get('k'), undefined)
  assert.ok(fs.statSync(file).isDirectory())
})

test('storage: an unchanged value is not written again; deleting a key writes once', async t => {
  quiet(t)
  const { file } = tempWorld(t)
  let writes = 0
  const counting = {
    ...fs.promises,
    rename: async (from, to) => {
      writes++
      return fs.promises.rename(from, to)
    },
  }
  const storage = new Storage(file, { fs: counting, intervalMs: 0 })
  storage.set('score', { a: 1 })
  await storage.flush()
  storage.stopped = false
  for (let i = 0; i < 5; i++) storage.set('score', { a: 1 })
  assert.equal(storage.dirty, false)
  storage.set('score', undefined)
  await storage.flush()
  assert.equal(writes, 2)
  assert.deepEqual(onDisk(file), {})
  assert.ok(isEqual(storage.get('score'), undefined))
})
