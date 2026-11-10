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
  await storage.write()
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
  assert.equal(await storage.flush(), true, 'a second final save writes what the first could not')
  assert.deepEqual(onDisk(file), { old: false, new: 1 })
})

test('storage: a directory fsync that fails for real fails the write and keeps the store dirty', async t => {
  const lines = quiet(t)
  const { file } = tempWorld(t)
  let code = 'EIO'
  const dirSync = {
    ...fs.promises,
    open: async (target, flags) => {
      const handle = await fs.promises.open(target, flags)
      if (flags !== 'r') return handle
      handle.sync = async () => {
        throw Object.assign(new Error('directory fsync'), { code })
      }
      return handle
    },
  }
  const storage = new Storage(file, { fs: dirSync, intervalMs: 0 })
  storage.set('k', 1)
  await storage.write()
  assert.equal(storage.dirty, true, 'not known to be durable: written again')
  assert.equal(storage.saved(), false)
  assert.ok(lines.error.some(line => /failed to save storage\.json \(EIO\)/.test(line)))
  // a filesystem that cannot fsync a directory at all: the write counts
  for (code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR']) {
    storage.set('k', code)
    await storage.write()
    assert.equal(storage.saved(), true, code)
  }
  assert.deepEqual(onDisk(file), { k: 'EISDIR' })
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

test('storage: a read that fails once (EIO) is retried and the store loads; nothing is moved', t => {
  const lines = quiet(t)
  const { dir, file } = tempWorld(t)
  fs.writeFileSync(file, JSON.stringify({ kept: 1 }))
  let reads = 0
  const flaky = (target, encoding) => {
    if (++reads === 1) throw Object.assign(new Error('i/o error'), { code: 'EIO' })
    return fs.readFileSync(target, encoding)
  }
  const storage = new Storage(file, { intervalMs: 0, readFile: flaky, readPauseMs: 1 })
  assert.equal(reads, 2)
  assert.equal(storage.get('kept'), 1)
  assert.equal(storage.unavailable, null)
  assert.deepEqual(fs.readdirSync(dir), ['storage.json'])
  assert.deepEqual(lines.error, [])
})

for (const code of ['EIO', 'EACCES', 'EMFILE', 'EBUSY', 'EISDIR']) {
  test(`storage: a file that keeps failing to read (${code}) is left as it is and the store is off for the run`, async t => {
    const lines = quiet(t)
    const { dir, file } = tempWorld(t)
    fs.writeFileSync(file, JSON.stringify({ precious: true }))
    let reads = 0
    const failing = () => {
      reads++
      throw Object.assign(new Error('cannot read'), { code })
    }
    const storage = new Storage(file, { intervalMs: 0, readFile: failing, readPauseMs: 1 })
    assert.equal(reads, 5, 'read again four times')
    assert.match(storage.unavailable, new RegExp(`could not be read \\(${code}\\)`))
    assert.equal(lines.error.length, 1)
    assert.match(
      lines.error[0],
      new RegExp(`could not be read \\(${code}\\) after 5 attempts.*the file is left as it is`)
    )
    assert.throws(() => storage.set('k', 1), /world\.set: storage is unavailable/)
    assert.throws(() => storage.set('precious', undefined), /storage is unavailable/)
    assert.equal(storage.get('precious'), undefined)
    assert.equal(await storage.flush(), true, 'nothing was accepted, so nothing is unsaved')
    assert.deepEqual(fs.readdirSync(dir), ['storage.json'], 'not renamed, no temp file')
    assert.deepEqual(onDisk(file), { precious: true })
  })
}

test('storage: once the final save starts, world.set is refused and only what was accepted counts', async t => {
  quiet(t)
  const { file } = tempWorld(t)
  const storage = new Storage(file, { intervalMs: 0 })
  const world = scriptWorld(storage)
  world.set('k', 1)
  const flushing = storage.flush()
  assert.throws(() => world.set('k', 2), /the server is stopping; the value was not stored/)
  assert.throws(() => world.set('other', undefined), /the server is stopping/)
  assert.equal(await flushing, true)
  assert.throws(() => world.set('k', 3), /the server is stopping/)
  assert.deepEqual(onDisk(file), { k: 1 })
  assert.equal(world.get('k'), 1)
  // an accepted change the file does not hold makes the store unsaved, whatever the last write said
  storage.revision++
  assert.equal(storage.saved(), false)
})

test("storage: a value's toJSON that calls world.set again cannot unbalance the accounting", t => {
  quiet(t)
  const { file } = tempWorld(t)
  const storage = new Storage(file, { intervalMs: 0, limits: { maxBytes: 300 } })
  const world = scriptWorld(storage)
  world.set('k', 'v'.repeat(100))
  world.set('other', 'o'.repeat(50))
  world.set('k', {
    toJSON() {
      world.set('k', undefined)
      world.set('third', 't'.repeat(40))
      return 1
    },
  })
  assert.equal(storage.bytes, Buffer.byteLength(storage.serialize()), 'tracked size is the file size')
  assert.equal(storage.bytes, storage.measure())
  assert.deepEqual(JSON.parse(storage.serialize()), { other: 'o'.repeat(50), third: 't'.repeat(40), k: 1 })
  // and the total limit still holds against what is really there
  assert.throws(() => world.set('big', 'b'.repeat(200)), /storage would be \d+ bytes; the limit is 300/)
})

test('storage: a key stored before the key rule can be deleted and overwritten, but not made larger', async t => {
  quiet(t)
  const { file } = tempWorld(t)
  const long = 'k'.repeat(129)
  fs.writeFileSync(file, JSON.stringify({ [long]: 'x'.repeat(50), '': 'empty key' }))
  const storage = new Storage(file, { intervalMs: 0, limits: { maxValueBytes: 20 } })
  assert.equal(storage.get(long), 'x'.repeat(50))
  storage.set(long, 'y'.repeat(50))
  assert.throws(() => storage.set(long, 'z'.repeat(51)), /the value is 53 bytes/)
  storage.set(long, 'short')
  assert.equal(storage.get(long), 'short')
  storage.set('', undefined)
  assert.throws(() => storage.set('', 1), /key must be a string of 1 to 128 characters/, 'a new key follows the rule')
  assert.throws(() => storage.set('n'.repeat(129), 1), /key must be a string/)
  storage.set(long, undefined)
  assert.ok(await storage.flush())
  assert.deepEqual(onDisk(file), {})
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
  await storage.write()
  for (let i = 0; i < 5; i++) storage.set('score', { a: 1 })
  assert.equal(storage.dirty, false)
  storage.set('score', undefined)
  await storage.flush()
  assert.equal(writes, 2)
  assert.deepEqual(onDisk(file), {})
  assert.ok(isEqual(storage.get('score'), undefined))
})
