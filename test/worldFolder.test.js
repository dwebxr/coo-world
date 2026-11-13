// scripts/lib/worldFolder.mjs: the folder the image's entrypoint may give to 1001:1001 for a WORLD, decided on the
// path as the file system resolves it. On real temp folders with real links; the app root is a temp folder laid out
// as /app is in the image (build, node_modules, src, scripts, world, package.json). The system trees are the real
// ones, reached from the temp app root with enough `..` (path.join stops at /).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CODE_FOLDERS, SHARED_FOLDERS, SYSTEM_TREES, resolveWorldFolder } from '../scripts/lib/worldFolder.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const posixOnly = { skip: process.platform === 'win32' ? 'needs POSIX paths and links' : false }

// a temp folder by its real path, with an app root in it and a data folder beside it
function layout() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coo-world-folder-')))
  const app = path.join(base, 'app')
  for (const name of [...CODE_FOLDERS, 'world', 'build/public']) fs.mkdirSync(path.join(app, name), { recursive: true })
  fs.writeFileSync(path.join(app, 'package.json'), '{}')
  const data = path.join(base, 'data')
  fs.mkdirSync(data)
  return { base, app, data, remove: () => fs.rmSync(base, { recursive: true, force: true }) }
}
// as many `..` as it takes to reach / from the app root
const toRoot = app => '../'.repeat(app.split('/').length)
const decide = (app, world) => resolveWorldFolder({ world, appRoot: app })
const refusedAs = (app, world) => {
  const result = decide(app, world)
  assert.equal(result.ok, false, `${JSON.stringify(world)} was taken: ${result.folder}`)
  return result.reason
}
const real = folder => (fs.existsSync(folder) ? fs.realpathSync(folder) : folder)

test('world folder: what is taken, joined as the server joins it and resolved', posixOnly, () => {
  const { base, app, data, remove } = layout()
  try {
    const takes = [
      ['world', `${app}/world`],
      ['world/', `${app}/world`],
      ['./world', `${app}/world`],
      ['world/../world', `${app}/world`],
      ['build/../world', `${app}/world`],
      // the server's join keeps an absolute-looking WORLD under the app root
      ['/world', `${app}/world`],
      ['/usr', `${app}/usr`],
      ['new/nested', `${app}/new/nested`],
      ['buildx', `${app}/buildx`],
      ['srcs/world', `${app}/srcs/world`],
      ['-rf', `${app}/-rf`],
      ['two words/and\na line break', `${app}/two words/and\na line break`],
      // out of the app root through `..`: a data folder beside it, whatever it is called
      ['../data', data],
      ['../data/world', `${data}/world`],
      ['../elsewhere/world', `${base}/elsewhere/world`],
    ]
    for (const [world, folder] of takes) {
      const result = decide(app, world)
      assert.deepEqual(result.ok && result.folder, folder, `${JSON.stringify(world)}: ${result.reason}`)
    }
    assert.equal(decide(app, 'world').joined, `${app}/world`)
  } finally {
    remove()
  }
})

test('world folder: /, the app root, its code, and what holds them are refused', posixOnly, () => {
  const { app, remove } = layout()
  try {
    assert.match(refusedAs(app, ''), /^WORLD="" names no folder$/)
    assert.equal(
      refusedAs(app, '.'),
      `WORLD="." resolves to ${app}: that is the app root, which holds the image's code`
    )
    for (const world of ['./', 'world/..', 'build/..']) assert.match(refusedAs(app, world), /that is the app root/)
    for (const world of ['..', '../..', toRoot(app), `${toRoot(app)}..`]) {
      assert.match(refusedAs(app, world), /that is the root of the file system|holds the image's own code/, world)
    }
    // the app root's parent holds its code: refused by the ancestor rule alone
    assert.equal(
      refusedAs(app, '..'),
      `WORLD=".." resolves to ${path.dirname(app)}: that folder holds the image's own code (${app}/build)`
    )
    assert.equal(
      refusedAs(app, toRoot(app)),
      `WORLD=${JSON.stringify(toRoot(app))} resolves to /: that is the root of the file system`
    )
    for (const name of CODE_FOLDERS) {
      for (const world of [name, `${name}/`, `/${name}`, `${name}/world`, `${name}/a/b/c`, `world/../${name}/x`]) {
        assert.match(
          refusedAs(app, world),
          new RegExp(`that is the image's own code \\(at or under ${app}/${name}\\)$`),
          world
        )
      }
    }
    // a file where a folder is wanted
    assert.equal(
      refusedAs(app, 'package.json'),
      `WORLD="package.json" resolves to ${app}/package.json: it is not a folder`
    )
    assert.equal(
      refusedAs(app, 'package.json/world'),
      `WORLD="package.json/world" resolves to ${app}/package.json/world: ${app}/package.json is not a folder`
    )
  } finally {
    remove()
  }
})

test('world folder: the system trees, as written and through a link, and /tmp itself', posixOnly, () => {
  const { app, remove } = layout()
  try {
    const up = toRoot(app)
    for (const tree of SYSTEM_TREES) {
      for (const below of ['', '/world', '/a/b']) {
        const world = `${up}${tree.slice(1)}${below}`
        assert.match(refusedAs(app, world), new RegExp(`that is a system folder \\(at or under ${tree}\\)$`), world)
      }
    }
    // the ones that matter most, by their resolved folder too
    assert.equal(
      refusedAs(app, `${up}usr/local/bin`),
      `WORLD=${JSON.stringify(`${up}usr/local/bin`)} resolves to ${real('/usr/local/bin')}: that is a system folder (at or under /usr)`
    )
    for (const shared of SHARED_FOLDERS) {
      assert.match(refusedAs(app, `${up}${shared.slice(1)}`), /shared by every user of the container/)
      assert.match(refusedAs(app, `${up}${shared.slice(1)}/`), /shared by every user of the container/)
      // a folder below it is not refused
      const below = decide(app, `${up}${shared.slice(1)}/coo-world-test-${process.pid}`)
      assert.equal(below.ok, true, below.reason)
    }
    // the trees left open on purpose: a data volume mounted outside /app
    for (const open of ['data', 'mnt/world', 'media/world', 'srv/world', 'data/world']) {
      const result = decide(app, `${up}${open}`)
      assert.equal(result.ok, true, `${open}: ${result.reason}`)
    }
  } finally {
    remove()
  }
})

test('world folder: links are followed; the decision is on where they lead', posixOnly, () => {
  const { base, app, data, remove } = layout()
  try {
    const world = path.join(app, 'world')
    // a link in a parent component into the code: refused, existing or not below it
    fs.symlinkSync(path.join(app, 'build'), path.join(world, 'link'))
    assert.equal(
      refusedAs(app, 'world/link/public'),
      `WORLD="world/link/public" resolves to ${app}/build/public: that is the image's own code (at or under ${app}/build)`
    )
    assert.match(refusedAs(app, 'world/link/new/deeper'), new RegExp(`resolves to ${app}/build/new/deeper: `))
    assert.match(refusedAs(app, 'world/link'), new RegExp(`resolves to ${app}/build: `))
    // links to the app root, to /, to a system tree
    fs.symlinkSync(app, path.join(world, 'up'))
    assert.match(refusedAs(app, 'world/up'), /that is the app root/)
    fs.symlinkSync('/', path.join(world, 'top'))
    assert.match(refusedAs(app, 'world/top'), /resolves to \/: that is the root of the file system/)
    fs.symlinkSync('/usr/local', path.join(world, 'sys'))
    assert.match(refusedAs(app, 'world/sys/bin'), /that is a system folder \(at or under \/usr\)/)
    // a link that leads nowhere, and a path through it
    fs.symlinkSync(path.join(base, 'nothing-here'), path.join(world, 'dangling'))
    assert.match(refusedAs(app, 'world/dangling'), /is a link that leads nowhere, or through one \(ENOENT\)$/)
    assert.match(refusedAs(app, 'world/dangling/x'), /world\/dangling is a link that leads nowhere/)
    // a world that is a link to a data folder is taken as that data folder, and so is a folder below it that does
    // not exist yet
    fs.symlinkSync(data, path.join(app, 'linked'))
    assert.deepEqual(decide(app, 'linked'), { ok: true, folder: data, joined: `${app}/linked` })
    assert.deepEqual(decide(app, 'linked/').folder, data)
    assert.deepEqual(decide(app, 'linked/new/world').folder, `${data}/new/world`)
    // a link to a link
    fs.symlinkSync(path.join(app, 'linked'), path.join(app, 'linked-twice'))
    assert.equal(decide(app, 'linked-twice').folder, data)
    // a link to a file
    fs.writeFileSync(path.join(data, 'file'), '')
    fs.symlinkSync(path.join(data, 'file'), path.join(app, 'to-a-file'))
    assert.match(refusedAs(app, 'to-a-file'), /resolves to .*\/data\/file: it is not a folder$/)
  } finally {
    remove()
  }
})

test('world folder: what cannot be looked at, and the belt, through a stand-in file system', () => {
  const real = { ...fs }
  const failing = code => ({
    ...real,
    lstatSync: () => {
      throw Object.assign(new Error(code), { code })
    },
  })
  assert.equal(
    resolveWorldFolder({ world: 'world', appRoot: '/app', fs: failing('EACCES') }).reason,
    'WORLD="world" resolves to /app/world: /app/world cannot be looked at (EACCES)'
  )
  // a realpath that does not resolve to itself (it cannot, on a real file system)
  const unstable = {
    lstatSync: () => ({}),
    statSync: () => ({ isDirectory: () => true }),
    realpathSync: (() => {
      let calls = 0
      return folder => (folder === '/data/world' ? (calls++ === 0 ? '/data/world' : '/data/elsewhere') : folder)
    })(),
  }
  assert.equal(
    resolveWorldFolder({ world: '../data/world', appRoot: '/app', fs: unstable }).reason,
    'WORLD="../data/world" resolves to /data/world: /data/world does not resolve to itself'
  )
})

test('world folder: the CLI prints the folder, or the reason with exit 1', posixOnly, () => {
  const cli = path.join(root, 'scripts/coo-world-folder.mjs')
  const run = world =>
    spawnSync(process.execPath, [cli], { encoding: 'utf8', env: { PATH: process.env.PATH, WORLD: world } })
  // (the app root is /app, which this machine does not have: textual from there)
  const taken = run('world')
  assert.equal(taken.status, 0, taken.stderr)
  assert.equal(taken.stdout, '/app/world', 'nothing after the folder, no line break')
  assert.equal(run('a\n').stdout, '/app/a\n', 'a name that ends in a line break keeps it')
  const refused = run('build')
  assert.equal(refused.status, 1)
  assert.equal(refused.stdout, '')
  assert.equal(
    refused.stderr,
    '[entrypoint] refused: WORLD="build" resolves to /app/build: that is the image\'s own code (at or under /app/build)\n'
  )
  assert.match(run('../usr/local/bin').stderr, /^\[entrypoint\] refused: WORLD="\.\.\/usr\/local\/bin" resolves to /)
  const empty = run('')
  assert.equal(empty.status, 1)
  assert.equal(empty.stderr, '[entrypoint] refused: WORLD="" names no folder\n')
  // Node's own modules only: the image runs it without an install
  for (const file of ['scripts/coo-world-folder.mjs', 'scripts/lib/worldFolder.mjs']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    for (const [, name] of source.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(name.startsWith('node:') || name === './lib/worldFolder.mjs', `${file} imports ${name}`)
    }
  }
})
