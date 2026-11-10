import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

async function localAssets(t) {
  const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-world-'))
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-root-'))
  t.after(() => {
    fs.rmSync(worldDir, { recursive: true, force: true })
    fs.rmSync(rootDir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(rootDir, 'src/world/assets'), { recursive: true })
  fs.writeFileSync(path.join(rootDir, 'src/world/assets/builtin.js'), 'builtin')
  const assets = new AssetsLocal()
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
        const text = objects.get(command.input.Key)
        return { Body: { transformToString: async () => text } }
      }
      if (name === 'HeadObjectCommand') {
        if (!objects.has(command.input.Key)) throw Object.assign(new Error('missing'), { name: 'NotFound' })
        return {}
      }
      if (name === 'PutObjectCommand') objects.set(command.input.Key, command.input.Body)
      return {}
    },
  }
  return { client, commands, objects }
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
  const { assets, commands } = s3(t)
  const names = n => Array.from({ length: n }, (_, i) => `${String(i).padStart(64, '0')}.glb`)
  await assets.delete(new Set())
  assert.equal(commands.length, 0)
  await assets.delete(new Set(names(1)))
  assert.deepEqual(
    commands.map(c => c.input.Delete.Objects.length),
    [1]
  )
  assert.equal(commands[0].input.Delete.Objects[0].Key, `world/${names(1)[0]}`)
  commands.length = 0
  await assets.delete(new Set(names(1001)))
  assert.deepEqual(
    commands.map(c => [c.name, c.input.Bucket, c.input.Delete.Objects.length]),
    [
      ['DeleteObjectsCommand', 'bucket', 1000],
      ['DeleteObjectsCommand', 'bucket', 1],
    ]
  )
  commands.length = 0
  await assets.delete(names(2).values())
  assert.deepEqual(
    commands.map(c => c.input.Delete.Objects.length),
    [2]
  )
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
