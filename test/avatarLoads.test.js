import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundleProbe } from './lib/workerProbe.mjs'

// The real PlayerRemote and PlayerLocal avatar methods (bundled like the server build) with a loader whose loads
// finish when the test says, in any order.
let m
let bundle
before(async () => {
  bundle = await bundleProbe(`
    export { PlayerRemote } from './src/core/entities/PlayerRemote'
    export { PlayerLocal } from './src/core/entities/PlayerLocal'
    export { BUILTIN_AVATAR_URL, LOADER_BUSY, AVATAR_RETRY_MS, avatarLoadFailed } from './src/core/extras/playerAvatarFallback'
  `)
  m = await import(bundle.url)
})
after(() => bundle?.destroy())

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function avatarNode(url) {
  return {
    url,
    visible: true, // the Avatar node's default
    deactivated: false,
    deactivate() {
      this.deactivated = true
    },
    getHeadToHeight: () => 1.6,
    disableRateCheck() {},
    height: 1.8,
  }
}

// a player of the given class with the state applyAvatar uses; loads[url] finishes that load (`with`: as this
// loaded file), started[url] counts the loads asked for
function player(Cls, avatar) {
  const loads = {}
  const started = {}
  const p = Object.create(Cls.prototype)
  Object.assign(p, {
    data: { id: 'p', avatar, sessionAvatar: null },
    world: {
      emit() {},
      loader: {
        load: (_type, url) =>
          new Promise((resolve, reject) => {
            started[url] = (started[url] || 0) + 1
            loads[url] = {
              finish: () => resolve({ toNodes: () => ({ get: () => avatarNode(url) }) }),
              with: resolve,
              fail: reject,
            }
          }),
      },
    },
    base: { add: node => (p.installed = node) },
    nametag: { position: {}, active: false },
    bubble: { position: {}, active: false },
  })
  return { p, loads, started }
}

const busyError = () => Object.assign(new Error('too many downloads'), { code: m.LOADER_BUSY })

// errors the code reports are expected here; `timers` collects the avatar retries
function quiet(t) {
  const original = console.error
  const realSetTimeout = globalThis.setTimeout
  const timers = []
  console.error = () => {}
  globalThis.setTimeout = (fn, ms) => (ms === m.AVATAR_RETRY_MS ? timers.push(fn) : realSetTimeout(fn, ms))
  t.after(() => {
    console.error = original
    globalThis.setTimeout = realSetTimeout
  })
  return timers
}

// a player of the given class who shows avatar A
async function showing(Cls) {
  const shown = player(Cls, 'https://example.com/a.vrm')
  shown.p.applyAvatar()
  shown.loads['https://example.com/a.vrm'].finish()
  await tick()
  shown.a = shown.p.installed
  assert.equal(shown.p.avatar, shown.a)
  return shown
}

for (const name of ['PlayerRemote', 'PlayerLocal']) {
  test(`${name}: a stale avatar load does not replace a newer avatar or the fallback`, async () => {
    const { p, loads } = player(m[name], 'https://example.com/b.vrm')
    p.applyAvatar() // B starts loading
    // B is slow; meanwhile the frame loop asks for the built-in avatar
    assert.equal(p.fallBackToDefaultAvatar(), true)
    assert.equal(p.avatarFallback, 'loading')
    loads[m.BUILTIN_AVATAR_URL].finish()
    await tick()
    assert.equal(p.installed.url, m.BUILTIN_AVATAR_URL)
    assert.equal(p.avatarFallback, 'ready')
    // B finishes last: it is stale
    loads['https://example.com/b.vrm'].finish()
    await tick()
    assert.equal(p.installed.url, m.BUILTIN_AVATAR_URL, 'the built-in avatar stays')
    assert.equal(p.avatarUrl, m.BUILTIN_AVATAR_URL)
    assert.equal(p.avatarFallback, 'ready', 'and "ready" describes the avatar installed')
  })

  test(`${name}: out-of-order loads install only the latest request`, async () => {
    const { p, loads } = player(m[name], 'https://example.com/a.vrm')
    p.applyAvatar()
    p.data.avatar = 'https://example.com/b.vrm'
    p.applyAvatar()
    p.data.avatar = 'https://example.com/c.vrm'
    p.applyAvatar()
    loads['https://example.com/c.vrm'].finish()
    await tick()
    loads['https://example.com/a.vrm'].finish()
    loads['https://example.com/b.vrm'].finish()
    await tick()
    assert.equal(p.installed.url, 'https://example.com/c.vrm')
    assert.equal(p.avatarUrl, 'https://example.com/c.vrm')
    // asking again for the installed avatar cancels a pending one
    p.data.avatar = 'https://example.com/d.vrm'
    p.applyAvatar()
    p.data.avatar = 'https://example.com/c.vrm'
    p.applyAvatar()
    loads['https://example.com/d.vrm'].finish()
    await tick()
    assert.equal(p.installed.url, 'https://example.com/c.vrm')
  })

  test(`${name}: a failed built-in load leaves the fallback with nothing more to try`, async () => {
    const { p, loads } = player(m[name], 'https://example.com/b.vrm')
    const original = console.error
    console.error = () => {}
    try {
      p.applyAvatar()
      p.fallBackToDefaultAvatar()
      loads[m.BUILTIN_AVATAR_URL].fail(new Error('404'))
      await tick()
      assert.equal(p.avatarFallback, 'ready')
      assert.equal(p.fallBackToDefaultAvatar(), false, 'the next failure drops the player')
    } finally {
      console.error = original
    }
  })

  test(`${name}: a player whose avatar cannot be loaded gets the built-in avatar, not nothing`, async () => {
    const { p, loads } = player(m[name], 'https://example.com/b.vrm')
    const original = console.error
    console.error = () => {}
    try {
      p.applyAvatar()
      loads['https://example.com/b.vrm'].fail(new Error('asset refused'))
      await tick()
      assert.equal(p.avatarFallback, 'loading', 'the built-in avatar is asked for')
      assert.ok(loads[m.BUILTIN_AVATAR_URL], 'its load started')
      loads[m.BUILTIN_AVATAR_URL].finish()
      await tick()
      assert.equal(p.installed.url, m.BUILTIN_AVATAR_URL)
      assert.equal(p.avatarFallback, 'ready')
      assert.equal(p.avatarRetried, undefined, 'a refused file is not asked for again')
      // a newly chosen avatar gets its own chance
      p.data.avatar = 'https://example.com/c.vrm'
      p.avatarFallback = null
      p.applyAvatar()
      loads['https://example.com/c.vrm'].finish()
      await tick()
      assert.equal(p.installed.url, 'https://example.com/c.vrm')
    } finally {
      console.error = original
    }
  })

  test(`${name}: an avatar that throws while it is put in place counts as a failed load`, async () => {
    const { p, loads } = player(m[name], 'https://example.com/b.vrm')
    const original = console.error
    const errors = []
    console.error = err => errors.push(err)
    const unhandled = []
    const onUnhandled = reason => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      p.world.loader.load = (_type, url) =>
        url === m.BUILTIN_AVATAR_URL
          ? new Promise(() => {})
          : Promise.resolve({
              toNodes: () => {
                throw new Error('no avatar node')
              },
            })
      p.applyAvatar()
      await tick()
      await tick()
      assert.deepEqual(unhandled, [])
      assert.equal(errors.length, 1)
      assert.equal(p.avatarFallback, 'loading')
    } finally {
      console.error = original
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test(`${name}: a player who has an avatar keeps it when a new one fails; a failed built-in avatar ends there`, async () => {
    const original = console.error
    console.error = () => {}
    try {
      const { p, loads } = player(m[name], 'https://example.com/a.vrm')
      p.applyAvatar()
      loads['https://example.com/a.vrm'].finish()
      await tick()
      p.data.avatar = 'https://example.com/broken.vrm'
      p.applyAvatar()
      loads['https://example.com/broken.vrm'].fail(new Error('asset refused'))
      await tick()
      assert.equal(p.installed.url, 'https://example.com/a.vrm')
      assert.equal(p.avatarFallback, undefined, 'no fallback: the avatar shown stays')
      assert.equal(loads[m.BUILTIN_AVATAR_URL], undefined)

      // a world whose players use the built-in avatar, and it is missing
      const other = player(m[name], null)
      other.p.applyAvatar()
      const first = other.loads[m.BUILTIN_AVATAR_URL]
      delete other.loads[m.BUILTIN_AVATAR_URL]
      first.fail(new Error('404'))
      await tick()
      assert.equal(other.p.avatarFallback, 'ready')
      assert.equal(other.loads[m.BUILTIN_AVATAR_URL], undefined, 'not asked for again')
    } finally {
      console.error = original
    }
  })

  test(`${name}: an avatar turned away because the loader was busy is asked for once more, later`, async () => {
    const original = console.error
    console.error = () => {}
    const realSetTimeout = globalThis.setTimeout
    const timers = []
    try {
      const { p, loads } = player(m[name], 'https://example.com/b.vrm')
      p.applyAvatar()
      globalThis.setTimeout = (fn, ms) => (ms === m.AVATAR_RETRY_MS ? timers.push(fn) : realSetTimeout(fn, ms))
      const busy = Object.assign(new Error('too many downloads'), { code: m.LOADER_BUSY })
      loads['https://example.com/b.vrm'].fail(busy)
      await tick()
      assert.equal(timers.length, 1, 'one retry is scheduled')
      assert.equal(p.avatarFallback, 'loading')
      loads[m.BUILTIN_AVATAR_URL].finish()
      await tick()
      assert.equal(p.installed.url, m.BUILTIN_AVATAR_URL)
      // the retry: the avatar asked for loads this time
      delete loads['https://example.com/b.vrm']
      timers.shift()()
      assert.equal(p.avatarFallback, null)
      loads['https://example.com/b.vrm'].finish()
      await tick()
      assert.equal(p.installed.url, 'https://example.com/b.vrm')

      // busy again on the retry: the built-in avatar stays, and no second retry is scheduled
      const again = player(m[name], 'https://example.com/b.vrm')
      again.p.applyAvatar()
      again.loads['https://example.com/b.vrm'].fail(busy)
      await tick()
      assert.equal(timers.length, 1)
      delete again.loads['https://example.com/b.vrm']
      timers.shift()()
      again.loads['https://example.com/b.vrm'].fail(busy)
      await tick()
      assert.equal(timers.length, 0, 'once only')
      assert.ok(again.p.avatarFallback)

      // a retry that comes after the player chose another avatar, or left, does nothing
      const moved = player(m[name], 'https://example.com/b.vrm')
      moved.p.applyAvatar()
      moved.loads['https://example.com/b.vrm'].fail(busy)
      await tick()
      moved.p.data.avatar = 'https://example.com/other.vrm'
      const before = moved.p.avatarFallback
      timers.shift()()
      assert.equal(moved.p.avatarFallback, before)
      const gone = player(m[name], 'https://example.com/b.vrm')
      gone.p.applyAvatar()
      gone.loads['https://example.com/b.vrm'].fail(busy)
      await tick()
      gone.p.destroyed = true
      timers.shift()()
      assert.ok(gone.p.avatarFallback, 'left as it was')
    } finally {
      globalThis.setTimeout = realSetTimeout
      console.error = original
    }
  })

  test(`${name}: a player who shows an avatar keeps it when the next one is turned away as busy, and it is asked for again`, async t => {
    const timers = quiet(t)
    const { p, loads, a } = await showing(m[name])
    p.modify({ avatar: 'https://example.com/b.vrm' })
    loads['https://example.com/b.vrm'].fail(busyError())
    await tick()
    assert.equal(p.avatar, a, 'A stays meanwhile')
    assert.equal(a.deactivated, false)
    assert.equal(loads[m.BUILTIN_AVATAR_URL], undefined, 'no fallback: an avatar shows')
    assert.equal(timers.length, 1, 'B is asked for again later')
    delete loads['https://example.com/b.vrm']
    timers.shift()()
    loads['https://example.com/b.vrm'].finish()
    await tick()
    assert.equal(p.installed.url, 'https://example.com/b.vrm')
    assert.equal(p.avatar, p.installed)
    assert.equal(a.deactivated, true, 'A goes once B is in place')
  })

  test(`${name}: A, B, then A again, each turned away as busy: only the last choice is asked for again`, async t => {
    const timers = quiet(t)
    const { p, loads, started } = await showing(m[name])
    for (const url of ['https://example.com/c.vrm', 'https://example.com/d.vrm', 'https://example.com/c.vrm']) {
      p.modify({ avatar: url })
      loads[url].fail(busyError())
      await tick()
    }
    assert.equal(timers.length, 3, 'each choice has its retry')
    assert.equal(started['https://example.com/c.vrm'], 2)
    while (timers.length) timers.shift()()
    assert.equal(started['https://example.com/c.vrm'], 3, 'C is asked for once more, not twice')
    assert.equal(started['https://example.com/d.vrm'], 1)
  })

  test(`${name}: a new avatar that cannot be made or put in place leaves the avatar showing in place`, async t => {
    quiet(t)
    const broken = {
      'https://example.com/throws.vrm': {
        toNodes() {
          throw new Error('no avatar node')
        },
      },
      'https://example.com/empty.vrm': { toNodes: () => ({ get: () => undefined }) },
      'https://example.com/unplaceable.vrm': { toNodes: () => ({ get: () => avatarNode('unplaceable') }) },
    }
    for (const [url, src] of Object.entries(broken)) {
      const { p, loads, a } = await showing(m[name])
      if (url.includes('unplaceable')) {
        p.base.add = () => {
          throw new Error('cannot be added')
        }
      }
      p.modify({ avatar: url })
      loads[url].with(src)
      await tick()
      await tick()
      assert.equal(p.avatar, a, `${url}: A is still the player's avatar`)
      assert.equal(a.deactivated, false, `${url}: and still shown`)
      assert.equal(p.avatarUrl, 'https://example.com/a.vrm')
      assert.equal(p.avatarFallback, null, `${url}: no fallback over it`)
      assert.equal(loads[m.BUILTIN_AVATAR_URL], undefined)
    }
  })
}

test('PlayerLocal: an avatar that arrives while the view is in first person is hidden from it', async () => {
  const { p, loads } = player(m.PlayerLocal, 'https://example.com/a.vrm')
  p.firstPerson = true
  p.applyAvatar()
  loads['https://example.com/a.vrm'].finish()
  await tick()
  assert.equal(p.installed.url, 'https://example.com/a.vrm')
  assert.equal(p.installed.visible, false)
  // a later avatar in third person shows
  p.firstPerson = false
  p.modify({ avatar: 'https://example.com/b.vrm' })
  loads['https://example.com/b.vrm'].finish()
  await tick()
  assert.equal(p.installed.visible, true)
})
