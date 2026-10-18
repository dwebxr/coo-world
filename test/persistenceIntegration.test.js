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

test('persistence: real static rigidbody proxy in discarded state cannot invoke native getters', async () => {
  await runRealPhysx(
    bundle,
    async ({ body }, { harness }) => {
      const { database, fixture } = await import(harness)
      const cleanups = []
      const { db, tables } = database()
      const { network, entity, socket } = fixture({ after: fn => cleanups.push(fn) }, db)
      try {
        const proxy = body('RigidBody', { type: 'static' }).getProxy()
        assert.throws(() => proxy.sleeping, /isSleeping/)
        entity.data.state.body = proxy
        await network.onEntityModified(socket, { id: 'app', pinned: true })
        await network.save()
        assert.equal(JSON.parse(tables.entities.get('app')?.data || '{}').state, null)
      } finally {
        for (const cleanup of cleanups) cleanup()
      }
    },
    { harness: new URL('./lib/persistenceHarness.mjs', import.meta.url).href }
  )
})

test('persistence: real server SQLite and PhysX world recover a just-acknowledged edit after fatal', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-world-'))
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
        export { getDB } from './src/server/db.js'
        export { assets } from './src/server/assets.js'
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
  // The worker also initializes real wasm and SES using the shared production harness.
  await runRealPhysx(
    bundle,
    async (_, { url, dir }) => {
      const S = await import(url)
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      S.assets.dir = path.join(dir, 'assets')
      await fs.mkdir(S.assets.dir)
      let db = await S.getDB({ worldDir: dir })
      const knex = (await import(pathToKnex(url))).default
      function pathToKnex(url) {
        return new URL('./node_modules/knex/knex.js', url).href
      }
      const worlds = []
      const boot = async () => {
        const world = new S.World()
        worlds.push(world)
        world.register('network', S.ServerNetwork)
        world.register('server', S.Server)
        world.loader = { get: () => ({ toNodes: () => new S.Node() }) }
        world.network.init({ db })
        await world.physics.init()
        world.stage.init({})
        await world.network.start()
        world.server.start()
        assert.ok(world.frame > 0)
        return world
      }
      const originalExit = process.exit
      const exits = []
      try {
        const world = await boot()
        const entity = [...world.entities.items.values()][0]
        assert.ok(entity?.isApp)
        const socket = { id: 'builder', player: { isBuilder: () => true }, send() {} }
        process.exit = code => exits.push(code)
        // The server's broadcast is the acknowledgement boundary, before native-capable modify.
        world.network.send = name => {
          assert.equal(name, 'entityModified')
          world.fatal('test')
        }
        await world.network.onEntityModified(socket, { id: entity.data.id, position: [12, 3, 4] })
        await world.fatalPromise
        assert.deepEqual(exits, [1])
        // Close and reopen the actual sqlite file, then hydrate a fresh world.
        await db.destroy()
        db = knex({
          client: 'better-sqlite3',
          connection: { filename: path.join(dir, 'db.sqlite') },
          useNullAsDefault: true,
        })
        const restarted = await boot()
        assert.deepEqual(restarted.entities.get(entity.data.id).data.position, [12, 3, 4])
      } finally {
        process.exit = originalExit
        for (const world of worlds) {
          world.network.stopForFatal()
          world.server.destroy()
        }
        await db.destroy()
      }
    },
    { url: pathToFileURL(outfile).href, dir },
    { deadline: 30000 }
  )
})
