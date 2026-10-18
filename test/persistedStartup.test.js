import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { before, after, test } from 'node:test'
import * as esbuild from 'esbuild'
import { bundleRealPhysx, runRealPhysx } from './lib/realPhysx.mjs'

let bundle
before(async () => {
  bundle = await bundleRealPhysx()
})
after(() => bundle?.destroy())

test('persisted startup: CLEAN=true survives malformed SQLite rows, serves repairs and never saves quarantined rows', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persisted-startup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  for (const name of ['physx-js-webidl.js', 'physx-js-webidl.wasm']) {
    fs.copyFileSync(path.join(root, 'src/core', name), path.join(dir, name))
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const sourceRoot = process.env.REAL_PHYSX_SOURCE_ROOT
  const outfile = path.join(dir, 'server.mjs')
  await esbuild.build({
    stdin: {
      contents: `
        export { World } from './src/core/World.js'
        export { Server } from './src/core/systems/Server.js'
        export { ServerNetwork } from './src/core/systems/ServerNetwork.js'
        export { Node } from './src/core/nodes/Node.js'
        export { readPacket } from './src/core/packets.js'
        export { getDB } from './src/server/db.js'
        export { assets } from './src/server/assets.js'
        export { cleaner } from './src/server/cleaner.js'
      `,
      resolveDir: root,
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    external: ['*physx-js-webidl.js'],
    define: {
      'process.env.CLIENT': 'false',
      'process.env.SERVER': 'true',
      'process.env.DB_URI': '""',
      'process.env.ASSETS': '"local"',
      'process.env.JWT_SECRET': '"persisted-startup-test-only"',
      __dirname: JSON.stringify(path.join(root, 'build')),
    },
    logLevel: 'silent',
    plugins: sourceRoot
      ? [
          {
            name: 'baseline-sources',
            setup(build) {
              build.onLoad({ filter: /\/src\/(core|server)\/.*\.js$/ }, args => {
                const baseline = path.join(sourceRoot, path.relative(root, args.path))
                if (fs.existsSync(baseline)) return { contents: fs.readFileSync(baseline, 'utf8'), loader: 'js' }
              })
            },
          },
        ]
      : [],
  })
  await runRealPhysx(
    bundle,
    async (_, { url, dir }) => {
      const S = await import(url)
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const { EventEmitter } = await import('node:events')
      process.env.CLEAN = 'true'
      S.assets.dir = path.join(dir, 'assets')
      await fs.mkdir(S.assets.dir)
      const db = await S.getDB({ worldDir: dir })
      const world = new S.World()
      world.register('network', S.ServerNetwork)
      world.register('server', S.Server)
      const log = console.log
      const warn = console.warn
      const logs = []
      console.log = line => logs.push(line)
      console.warn = line => logs.push(line)
      try {
        const now = new Date().toISOString()
        const row = (id, data) => ({
          id,
          data: typeof data === 'string' ? data : JSON.stringify(data),
          createdAt: now,
          updatedAt: now,
        })
        await db('blueprints').insert([
          row('bp', {
            id: 'bp',
            version: 0,
            model: 'asset://cached.glb',
            preload: true,
            props: {},
            unknown: 'strip me',
          }),
          row('bad-bp', { id: 'bad-bp', version: 0, model: 123, preload: true, props: {} }),
          row('orphan', { id: 'orphan', version: 0 }),
        ])
        const app = (id, extra = {}) => ({
          id,
          type: 'app',
          blueprint: 'bp',
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
          mover: null,
          uploader: null,
          pinned: false,
          state: null,
          ...extra,
        })
        await db('entities').insert([
          row('bad-json', '{'),
          row('wrong-type', app('wrong-type', { type: 'wrong' })),
          row('huge', app('huge', { position: [1e30, -1e30, 3] })),
          row('quaternion', app('quaternion', { quaternion: [0, 0, 0, 2] })),
          row('scale', app('scale', { scale: [0, 1, 1] })),
          row('missing', app('missing', { blueprint: 'bad-bp' })),
        ])
        const unused = `${'a'.repeat(64)}.glb`
        await fs.writeFile(path.join(S.assets.dir, unused), 'unused asset retained on malformed discovery')
        const beforeAssets = (await fs.readdir(S.assets.dir)).sort()
        const beforeBlueprints = await db('blueprints').orderBy('id')
        const beforeEntities = await db('entities').orderBy('id')
        await assert.doesNotReject(S.cleaner.init({ db }))
        assert.deepEqual((await fs.readdir(S.assets.dir)).sort(), beforeAssets)
        assert.deepEqual(await db('blueprints').orderBy('id'), beforeBlueprints)
        assert.ok(logs.some(line => line.startsWith('[clean] skipped all deletion:')))
        world.loader = { get: () => ({ toNodes: () => new S.Node() }), load: () => new Promise(() => {}) }
        world.livekit = { serialize: async () => null }
        world.ai = { serialize: () => null }
        world.network.init({ db })
        await world.physics.init()
        world.stage.init({})
        await assert.doesNotReject(world.network.start())
        world.server.start()
        assert.ok(world.frame > 0, 'real server tick starts after hydration')
        assert.equal(world.blueprints.get('bad-bp'), undefined)
        assert.equal(world.blueprints.get('bp').unknown, undefined)
        assert.equal(world.network.dirtyApps.size, 0)
        assert.equal(world.network.dirtyBlueprints.size, 0)
        const summaries = logs.filter(line => line.startsWith('[network] hydration:'))
        assert.equal(summaries.length, 1)
        assert.match(summaries[0], /repaired=3 skipped=4/)
        for (const id of ['bad-bp', 'bad-json', 'wrong-type', 'missing', 'huge', 'quaternion', 'scale']) {
          assert.ok(summaries[0].includes(`"${id}"`))
        }
        // Exercise the real connection/snapshot writer without opening a TCP listener.
        const ws = new EventEmitter()
        ws.readyState = 1
        ws.send = (packet, callback) => {
          ws.packets.push(packet)
          callback?.()
        }
        ws.packets = []
        ws.close = () => assert.fail('snapshot connection unexpectedly closed')
        await world.network.onConnection(ws, {})
        const decoded = ws.packets.map(S.readPacket)
        const snapshot = decoded.find(([method]) => method === 'onSnapshot')?.[1]
        assert.ok(snapshot, 'real onConnection served a snapshot')
        const apps = new Map(snapshot.entities.filter(data => data.type === 'app').map(data => [data.id, data]))
        assert.deepEqual(apps.get('huge').position, [1e6, -1e6, 3])
        assert.deepEqual(apps.get('quaternion').quaternion, [0, 0, 0, 1])
        assert.deepEqual(apps.get('scale').scale, [1, 1, 1])
        for (const id of ['bad-json', 'wrong-type', 'missing']) assert.equal(apps.has(id), false)
        assert.ok(!snapshot.blueprints.some(data => data.id === 'bad-bp'))
        await world.network.save()
        assert.deepEqual(await db('entities').orderBy('id'), beforeEntities)
        assert.deepEqual(await db('blueprints').orderBy('id'), beforeBlueprints)
        const builder = { id: 'builder', player: { isBuilder: () => true }, send() {} }
        await world.network.onEntityModified(builder, { id: 'huge', pinned: true })
        await world.network.save()
        const edited = JSON.parse((await db('entities').where('id', 'huge').first()).data)
        assert.deepEqual(edited.position, [1e6, -1e6, 3])
        assert.equal(edited.pinned, true)
        assert.deepEqual(
          await db('entities').whereNot('id', 'huge').orderBy('id'),
          beforeEntities.filter(row => row.id !== 'huge')
        )
        assert.deepEqual((await fs.readdir(S.assets.dir)).sort(), beforeAssets)
      } finally {
        console.log = log
        console.warn = warn
        world.network.stopForFatal()
        world.server.destroy()
        await db.destroy()
      }
    },
    { url: pathToFileURL(outfile).href, dir },
    { deadline: 30000 }
  )
})
