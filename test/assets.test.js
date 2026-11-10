import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import Fastify from 'fastify'
import { bundleServer } from './lib/serverBundle.mjs'
import { isTempName, removeTempFiles, writeFileAtomic } from '../src/server/atomicWrite.js'
import { ALLOWED_EXTENSIONS, assetHeaders } from '../src/server/uploadPolicy.js'
import { assetRoutes } from '../src/server/uploadRoutes.js'

let bundle, AssetsLocal, AssetsS3
before(async () => {
  bundle = await bundleServer(`
    export { AssetsLocal } from './src/server/AssetsLocal.js'
    export { AssetsS3 } from './src/server/AssetsS3.js'
  `)
  ;({ AssetsLocal, AssetsS3 } = bundle.module)
})
after(() => bundle?.destroy())

const sha = buffer => createHash('sha256').update(buffer).digest('hex')
const glb = text => Buffer.concat([Buffer.from('glTF'), Buffer.from(text)])

async function localAssets(t, options) {
  const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-world-'))
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-root-'))
  t.after(() => {
    fs.rmSync(worldDir, { recursive: true, force: true })
    fs.rmSync(rootDir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(rootDir, 'src/world/assets'), { recursive: true })
  fs.writeFileSync(path.join(rootDir, 'src/world/assets/builtin.js'), 'builtin')
  const assets = new AssetsLocal(options)
  const init = () => assets.init({ rootDir, worldDir })
  return { assets, init, dir: path.join(worldDir, 'assets') }
}

test('atomic write: a failure before the rename leaves the old file and no temp file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'a.bin')
  fs.writeFileSync(file, 'old')
  const seen = []
  const failing = {
    ...fs.promises,
    open: async (target, flags) => {
      seen.push(path.basename(target))
      return fs.promises.open(target, flags)
    },
    rename: async () => {
      throw Object.assign(new Error('killed'), { code: 'ECRASH' })
    },
  }
  await assert.rejects(writeFileAtomic(file, 'new', { fs: failing }), { code: 'ECRASH' })
  assert.equal(fs.readFileSync(file, 'utf8'), 'old')
  assert.deepEqual(fs.readdirSync(dir), ['a.bin'])
  assert.ok(isTempName(seen[0]) && seen[0].endsWith('-a.bin'), seen[0])
  await writeFileAtomic(file, 'new')
  assert.equal(fs.readFileSync(file, 'utf8'), 'new')
  assert.deepEqual(fs.readdirSync(dir), ['a.bin'])
  // a temp name can never be an asset name, a hash name or an upload-check name
  assert.equal(/^[A-Za-z0-9._-]{1,128}$/.test(seen[0]), false)
  fs.writeFileSync(path.join(dir, seen[0]), 'left by a crash')
  assert.equal(removeTempFiles(dir), 1)
  assert.deepEqual(fs.readdirSync(dir), ['a.bin'])
})

test('local assets: an upload appears under its hash name only when complete; duplicates are not rewritten', async t => {
  const { assets, init, dir } = await localAssets(t)
  await init()
  const bytes = glb('model')
  const name = `${sha(bytes)}.glb`
  assert.equal(await assets.upload({ name: 'a.glb', buffer: bytes }), true)
  assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['builtin.js', name].sort(), 'no temp file left')
  const mtime = fs.statSync(path.join(dir, name)).mtimeMs
  assert.equal(await assets.upload({ name: 'again.glb', buffer: bytes }), false)
  assert.equal(fs.statSync(path.join(dir, name)).mtimeMs, mtime)
  assert.deepEqual([...(await assets.list())], [name])
})

test('local assets: while an upload is being written its final name does not exist, not even in part', async t => {
  let release
  const gate = new Promise(resolve => (release = resolve))
  let writing = null
  const paused = {
    ...fs.promises,
    open: async (target, flags) => {
      const handle = await fs.promises.open(target, flags)
      if (flags !== 'wx') return handle
      const writeFile = handle.writeFile.bind(handle)
      handle.writeFile = async data => {
        // the write waits, its file already open
        writing = path.basename(target)
        await gate
        return writeFile(data)
      }
      return handle
    },
  }
  const { assets, init, dir } = await localAssets(t, { fs: paused })
  await init()
  const bytes = glb('x'.repeat(4096))
  const name = `${sha(bytes)}.glb`
  const upload = assets.upload({ name: 'a.glb', buffer: bytes })
  for (let i = 0; !writing && i < 10000; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(writing, 'the upload went through the injected fs')
  assert.equal(fs.existsSync(path.join(dir, name)), false, 'no final name while the bytes are being written')
  assert.ok(writing.startsWith('~tmp-') && writing.endsWith(name))
  // an upload-check for it waits for the write instead of answering in the middle of it
  let answer = null
  const check = assets.exists(name).then(value => (answer = value))
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(answer, null, 'no answer while the write is in flight')
  assert.equal(await assets.exists(writing), false, 'a temp file is never reported')
  release()
  assert.equal(await upload, true)
  assert.equal(await check, true)
  assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes)
})

test('local assets: an upload-check never says "stored" for a file whose directory sync failed; it syncs it first', async t => {
  let dirSyncs = 0
  let failing = 2
  let gate = null
  let held = false
  const flaky = {
    ...fs.promises,
    open: async (target, flags) => {
      const handle = await fs.promises.open(target, flags)
      if (flags !== 'r') return handle
      handle.sync = async () => {
        if (gate) {
          held = true
          await gate
        }
        dirSyncs++
        if (failing-- > 0) throw Object.assign(new Error('directory fsync'), { code: 'EIO' })
      }
      return handle
    },
  }
  const { assets, init, dir } = await localAssets(t, { fs: flaky })
  await init()
  const bytes = glb('checked')
  const name = `${sha(bytes)}.glb`
  // Codex's probe: the rename landed, the directory sync failed
  await assert.rejects(assets.upload({ name: 'a.glb', buffer: bytes }), { code: 'EIO' })
  assert.ok(fs.existsSync(path.join(dir, name)))
  assert.equal(dirSyncs, 1)
  // the check tries the sync again; it fails again, so the client is told to upload
  assert.equal(await assets.exists(name), false)
  assert.equal(dirSyncs, 2)
  // the next check syncs it, and only then says "stored"; after that nothing is synced again
  assert.equal(await assets.exists(name), true)
  assert.equal(dirSyncs, 3)
  assert.equal(await assets.exists(name), true)
  assert.equal(await assets.upload({ name: 'a.glb', buffer: bytes }), false)
  assert.equal(dirSyncs, 3)
  // a check that arrives while an upload of the name is on its directory sync (renamed, not yet synced) waits for
  // it; that sync fails, so the check repairs it before it answers
  const other = glb('raced')
  const otherName = `${sha(other)}.glb`
  failing = 1
  let release
  gate = new Promise(resolve => (release = resolve))
  const upload = assets.upload({ name: 'b.glb', buffer: other })
  for (let i = 0; !held && i < 10000; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(held, 'the upload reached its directory sync')
  assert.ok(fs.existsSync(path.join(dir, otherName)), 'renamed into place already')
  const check = assets.exists(otherName)
  gate = null
  release()
  await assert.rejects(upload, { code: 'EIO' })
  assert.equal(await check, true)
  assert.equal(dirSyncs, 5)
})

test('local assets: an upload whose directory sync failed syncs again on the next upload before it says "stored"', async t => {
  let dirSyncs = 0
  let failing = 1
  const flaky = {
    ...fs.promises,
    open: async (target, flags) => {
      const handle = await fs.promises.open(target, flags)
      if (flags !== 'r') return handle
      handle.sync = async () => {
        dirSyncs++
        if (failing-- > 0) throw Object.assign(new Error('directory fsync'), { code: 'EIO' })
      }
      return handle
    },
  }
  const { assets, init, dir } = await localAssets(t, { fs: flaky })
  await init()
  const bytes = glb('durable')
  const name = `${sha(bytes)}.glb`
  await assert.rejects(assets.upload({ name: 'a.glb', buffer: bytes }), { code: 'EIO' })
  assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes, 'complete under its name, durability unknown')
  assert.equal(dirSyncs, 1)
  // the retry finds the right size, syncs the directory again, and only then answers "already stored"
  assert.equal(await assets.upload({ name: 'a.glb', buffer: bytes }), false)
  assert.equal(dirSyncs, 2)
  // durable now: a further duplicate does not sync again
  assert.equal(await assets.upload({ name: 'a.glb', buffer: bytes }), false)
  assert.equal(dirSyncs, 2)
  // a retry whose sync fails again fails the same way, and the next one tries again
  const other = glb('again')
  failing = 2
  await assert.rejects(assets.upload({ name: 'b.glb', buffer: other }), { code: 'EIO' })
  await assert.rejects(assets.upload({ name: 'b.glb', buffer: other }), { code: 'EIO' })
  assert.equal(await assets.upload({ name: 'b.glb', buffer: other }), false)
  assert.equal(dirSyncs, 5)
})

test('local assets: a cut-off copy from an earlier write is replaced by the next upload of the same content', async t => {
  const warnings = []
  t.mock.method(console, 'warn', line => warnings.push(line))
  t.mock.method(console, 'log', () => {})
  const { assets, init, dir } = await localAssets(t)
  await init()
  const bytes = glb('x'.repeat(1000))
  const name = `${sha(bytes)}.glb`
  fs.writeFileSync(path.join(dir, name), bytes.subarray(0, 300))
  assert.equal(await assets.exists(name), true, 'the name alone cannot tell')
  assert.equal(await assets.upload({ name: 'a.glb', buffer: bytes }), true)
  assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes)
  assert.deepEqual(warnings, [`[assets] replacing ${name}: 300 bytes stored, 1004 uploaded`])
  assert.equal(await assets.upload({ name: 'a.glb', buffer: bytes }), false)
})

test('local assets: start-up removes unfinished uploads; temp names are never listed, found or served', async t => {
  const logs = []
  t.mock.method(console, 'warn', line => logs.push(line))
  const { assets, init, dir } = await localAssets(t)
  await init()
  const bytes = glb('kept')
  const name = `${sha(bytes)}.glb`
  fs.writeFileSync(path.join(dir, name), bytes)
  const temp = `~tmp-0123456789ab-${name}`
  fs.writeFileSync(path.join(dir, temp), bytes.subarray(0, 2))
  assert.deepEqual([...(await assets.list())], [name])
  assert.equal(await assets.exists(temp), false)
  const app = Fastify()
  await app.register(assetRoutes, { root: dir })
  try {
    assert.equal((await app.inject(`/assets/${name}`)).statusCode, 200)
    for (const url of [
      `/assets/${temp}`,
      `/assets/${encodeURIComponent(temp).replace('~', '%7E')}`,
      '/assets/%7etmp-x',
    ]) {
      assert.equal((await app.inject(url)).statusCode, 404, url)
    }
  } finally {
    await app.close()
  }
  await init()
  assert.ok(logs.includes('[assets] removed 1 unfinished upload'))
  assert.deepEqual(fs.readdirSync(dir).sort(), ['builtin.js', name].sort())
})

test('local assets: readText reads a stored asset by name, null when absent, and refuses other names', async t => {
  const { assets, init, dir } = await localAssets(t)
  await init()
  fs.writeFileSync(path.join(dir, 'app.js'), "world.load('model', 'asset://x.glb')")
  assert.equal(await assets.readText('app.js'), "world.load('model', 'asset://x.glb')")
  assert.equal(await assets.readText('missing.js'), null)
  for (const name of ['../app.js', 'a/b.js', '..', '', '~tmp-x']) {
    await assert.rejects(assets.readText(name), /invalid asset name/, name)
  }
})

function fakeS3() {
  const commands = []
  const objects = new Map()
  const client = {
    send: async command => {
      const name = command.constructor.name
      commands.push({ name, input: command.input })
      if (name === 'GetObjectCommand') {
        if (!objects.has(command.input.Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        // an object is its text, or { body, encoding } as stored with a Content-Encoding
        const object = objects.get(command.input.Key)
        const body = typeof object === 'string' ? Buffer.from(object) : object.body
        return {
          Body: { transformToByteArray: async () => new Uint8Array(body) },
          ContentEncoding: typeof object === 'string' ? undefined : object.encoding,
        }
      }
      if (name === 'HeadObjectCommand') {
        if (!objects.has(command.input.Key)) throw Object.assign(new Error('missing'), { name: 'NotFound' })
        return {}
      }
      if (name === 'PutObjectCommand') objects.set(command.input.Key, command.input.Body)
      // as S3 answers: per key, Deleted or Errors; a key listed in `denied` stays
      if (name === 'DeleteObjectsCommand') {
        const Deleted = []
        const Errors = []
        for (const { Key } of command.input.Delete.Objects) {
          if (denied.has(Key)) {
            Errors.push({ Key, Code: 'AccessDenied', Message: 'Access Denied' })
          } else {
            objects.delete(Key)
            Deleted.push({ Key })
          }
        }
        return Errors.length ? { Deleted, Errors } : { Deleted }
      }
      return {}
    },
  }
  const denied = new Set()
  return { client, commands, objects, denied }
}

function s3(t) {
  const previous = process.env.ASSETS_S3_URI
  process.env.ASSETS_S3_URI = 's3://key:secret@bucket/world'
  t.after(() => {
    if (previous === undefined) delete process.env.ASSETS_S3_URI
    else process.env.ASSETS_S3_URI = previous
  })
  const fake = fakeS3()
  return { ...fake, assets: new AssetsS3({ client: fake.client }) }
}

test('s3 assets: delete takes the Set the cleaner passes (any iterable), in batches of at most 1000 keys', async t => {
  const { assets, commands, objects } = s3(t)
  const names = n => Array.from({ length: n }, (_, i) => `${String(i).padStart(64, '0')}.glb`)
  for (const name of names(1001)) objects.set(`world/${name}`, 'x')
  assert.deepEqual(await assets.delete(new Set()), { failed: [] })
  assert.equal(commands.length, 0)
  assert.deepEqual(await assets.delete(new Set(names(1))), { failed: [] })
  assert.equal(objects.has(`world/${names(1)[0]}`), false, 'the object is gone')
  assert.equal(objects.size, 1000)
  assert.deepEqual(
    commands.map(c => c.input.Delete.Objects.length),
    [1]
  )
  assert.equal(commands[0].input.Delete.Objects[0].Key, `world/${names(1)[0]}`)
  commands.length = 0
  assert.deepEqual(await assets.delete(new Set(names(1001))), { failed: [] })
  assert.deepEqual(
    commands.map(c => [c.name, c.input.Bucket, c.input.Delete.Objects.length]),
    [
      ['DeleteObjectsCommand', 'bucket', 1000],
      ['DeleteObjectsCommand', 'bucket', 1],
    ]
  )
  assert.equal(objects.size, 0, 'all 1,001 are gone')
  commands.length = 0
  await assets.delete(names(2).values())
  assert.deepEqual(
    commands.map(c => c.input.Delete.Objects.length),
    [2]
  )
})

test('s3 assets: keys S3 answers with Errors are reported as not deleted', async t => {
  const { assets, objects, denied } = s3(t)
  const names = ['a'.repeat(64) + '.glb', 'b'.repeat(64) + '.png', 'c'.repeat(64) + '.js']
  for (const name of names) objects.set(`world/${name}`, 'x')
  denied.add(`world/${names[1]}`)
  assert.deepEqual(await assets.delete(new Set(names)), { failed: [{ name: names[1], code: 'AccessDenied' }] })
  assert.deepEqual([...objects.keys()], [`world/${names[1]}`], 'the refused object is still there')
})

test('s3 assets: every extension uploads accept is stored with the type the local route serves', async t => {
  const { assets, commands } = s3(t)
  for (const ext of [...ALLOWED_EXTENSIONS, 'svg', 'html', 'bin']) {
    await assets.uploadBuffer(Buffer.from('x'), `${'a'.repeat(64)}.${ext}`)
  }
  const types = Object.fromEntries(commands.map(c => [c.input.Key.split('.').pop(), c.input.ContentType]))
  for (const ext of ALLOWED_EXTENSIONS) assert.equal(types[ext], assetHeaders(ext)['Content-Type'], ext)
  assert.equal(types.js, 'text/javascript')
  assert.equal(types.vrm, 'model/gltf-binary')
  assert.equal(types.hdr, 'image/vnd.radiance')
  for (const ext of ['svg', 'html', 'bin']) assert.equal(types[ext], 'application/octet-stream', ext)
})

test('s3 assets: readText reads an object, null when it does not exist', async t => {
  const { assets, objects } = s3(t)
  objects.set('world/app.js', 'asset://a.glb')
  assert.equal(await assets.readText('app.js'), 'asset://a.glb')
  assert.equal(await assets.readText('missing.js'), null)
  await assert.rejects(assets.readText('../x'), /invalid asset name/)
})

// Codex: an object stored with Content-Encoding: gzip is decoded by the HTTP path that runs it, but readText gave the
// clean-up the compressed bytes, so the models it names were deleted
test('s3 assets: readText undoes a stored gzip or deflate encoding; any other, or one that does not decode, throws', async t => {
  const { assets, objects } = s3(t)
  const source = "world.load('model', 'asset://zipped.glb')"
  objects.set('world/gz.js', { body: zlib.gzipSync(source), encoding: 'gzip' })
  objects.set('world/df.js', { body: zlib.deflateSync(source), encoding: 'deflate' })
  objects.set('world/raw.js', { body: zlib.deflateRawSync(source), encoding: 'Deflate' })
  objects.set('world/two.js', { body: zlib.gzipSync(zlib.deflateSync(source)), encoding: 'deflate, gzip' })
  objects.set('world/id.js', { body: Buffer.from(source), encoding: 'identity' })
  for (const name of ['gz.js', 'df.js', 'raw.js', 'two.js', 'id.js'])
    assert.equal(await assets.readText(name), source, name)
  objects.set('world/br.js', { body: zlib.brotliCompressSync(source), encoding: 'br' })
  await assert.rejects(assets.readText('br.js'), { code: 'ENCODING' })
  objects.set('world/bad.js', { body: Buffer.from('not gzip'), encoding: 'gzip' })
  await assert.rejects(assets.readText('bad.js'), { code: 'Z_DATA_ERROR' })
})

// Codex: a 32,636-byte gzip object expanded to 33,554,432 bytes with nothing to stop it
test('s3 assets: readText holds the object and every decoding stage to its limit; more than two codings throw', async t => {
  const { assets, objects, client } = s3(t)
  const bomb = zlib.gzipSync(Buffer.alloc(32 * 1024 * 1024))
  assert.ok(bomb.length < 64 * 1024)
  objects.set('world/bomb.js', { body: bomb, encoding: 'gzip' })
  await assert.rejects(assets.readText('bomb.js', { limit: 16 * 1024 * 1024 }), { code: 'ERR_BUFFER_TOO_LARGE' })
  // the same through deflate, and as the inner stage of two
  objects.set('world/dbomb.js', { body: zlib.deflateSync(Buffer.alloc(4096)), encoding: 'deflate' })
  await assert.rejects(assets.readText('dbomb.js', { limit: 1024 }), { code: 'ERR_BUFFER_TOO_LARGE' })
  objects.set('world/two.js', { body: zlib.gzipSync(zlib.deflateSync(Buffer.alloc(4096))), encoding: 'deflate, gzip' })
  await assert.rejects(assets.readText('two.js', { limit: 1024 }), { code: 'ERR_BUFFER_TOO_LARGE' })
  objects.set('world/three.js', {
    body: zlib.gzipSync(zlib.gzipSync(zlib.gzipSync('x'))),
    encoding: 'gzip, gzip, gzip',
  })
  await assert.rejects(assets.readText('three.js'), { code: 'ENCODING' })
  // the object itself: refused by its declared length before it is read, or while it is read
  objects.set('world/big.js', 'y'.repeat(2048))
  await assert.rejects(assets.readText('big.js', { limit: 1024 }), { code: 'TOO_LARGE' })
  let destroyed = 0
  const send = client.send
  client.send = async command =>
    command.constructor.name === 'GetObjectCommand'
      ? {
          ContentLength: 4096,
          Body: { destroy: () => destroyed++, transformToByteArray: async () => assert.fail('read whole') },
        }
      : send(command)
  await assert.rejects(assets.readText('big.js', { limit: 1024 }), { code: 'TOO_LARGE' })
  assert.equal(destroyed, 1)
  client.send = async () => ({
    Body: {
      destroy: () => destroyed++,
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 100; i++) yield Buffer.alloc(512)
      },
    },
  })
  await assert.rejects(assets.readText('big.js', { limit: 1024 }), { code: 'TOO_LARGE' })
  assert.equal(destroyed, 2)
  client.send = send
  // under the limit, as before
  objects.set('world/ok.js', { body: zlib.gzipSync('fine'), encoding: 'gzip' })
  assert.equal(await assets.readText('ok.js', { limit: 1024 }), 'fine')
})

test('local assets: readText and readTrashedText refuse a file larger than the limit before reading it', async t => {
  const { assets, init, dir } = await localAssets(t)
  await init()
  fs.writeFileSync(path.join(dir, 'big.js'), 'z'.repeat(2048))
  await assert.rejects(assets.readText('big.js', { limit: 1024 }), { code: 'TOO_LARGE' })
  assert.equal(await assets.readText('big.js', { limit: 4096 }), 'z'.repeat(2048))
  assert.equal(await assets.readText('none.js', { limit: 1024 }), null)
  fs.mkdirSync(path.join(assets.trashDir, '2026-11-10'), { recursive: true })
  fs.writeFileSync(path.join(assets.trashDir, '2026-11-10', 'big.js'), 'z'.repeat(2048))
  await assert.rejects(assets.readTrashedText('big.js', ['2026-11-10'], { limit: 1024 }), { code: 'TOO_LARGE' })
})

test('s3 assets: only a definite missing key is "no such script"; any other failure is thrown to the cleaner', async t => {
  const { assets, client } = s3(t)
  const failures = [
    Object.assign(new Error('bucket'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }),
    Object.assign(new Error('a 404 without a code'), { name: 'Unknown', $metadata: { httpStatusCode: 404 } }),
    Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    Object.assign(new Error('slow down'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } }),
    Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  ]
  for (const failure of failures) {
    client.send = async () => {
      throw failure
    }
    await assert.rejects(assets.readText('app.js'), failure, failure.name || failure.code)
  }
  client.send = async () => {
    throw Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    })
  }
  assert.equal(await assets.readText('app.js'), null)
})

test('local assets: only ENOENT is "no such script"; other read failures are thrown to the cleaner', async t => {
  const { assets, init, dir } = await localAssets(t)
  await init()
  fs.mkdirSync(path.join(dir, 'folder.js'))
  await assert.rejects(assets.readText('folder.js'), { code: 'EISDIR' })
  assert.equal(await assets.readText('absent.js'), null)
})

test('atomic write: a directory fsync that fails for real rejects; one the filesystem cannot do is skipped', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-dir-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'a.bin')
  const failing = code => ({
    ...fs.promises,
    open: async (target, flags) => {
      const handle = await fs.promises.open(target, flags)
      if (flags === 'r') {
        handle.sync = async () => {
          throw Object.assign(new Error('directory fsync'), { code })
        }
      }
      return handle
    },
  })
  for (const code of ['EIO', 'ENOSPC', 'EACCES', 'EMFILE']) {
    await assert.rejects(writeFileAtomic(file, code, { fs: failing(code) }), { code }, code)
    assert.equal(fs.readFileSync(file, 'utf8'), code, 'the file is in place, but not known to be durable')
  }
  for (const code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR']) {
    await writeFileAtomic(file, code, { fs: failing(code) })
    assert.equal(fs.readFileSync(file, 'utf8'), code)
  }
  // a directory that cannot even be opened (Windows) is skipped the same way
  const unopenable = {
    ...fs.promises,
    open: async (target, flags) => {
      if (flags === 'r') throw Object.assign(new Error('illegal operation on a directory'), { code: 'EISDIR' })
      return fs.promises.open(target, flags)
    },
  }
  await writeFileAtomic(file, 'windows', { fs: unopenable })
  assert.equal(fs.readFileSync(file, 'utf8'), 'windows')
})
