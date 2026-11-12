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
    export { createNode } from './src/core/extras/createNode'
  `)
  m = await import(bundle.url)
})
after(() => bundle?.destroy())

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// an avatar node as the player uses it: its heights come from its instance, which it has only once it is mounted
function avatarNode(url) {
  return {
    url,
    visible: true, // the Avatar node's default
    deactivated: false,
    mounted: false,
    instance: null,
    deactivate() {
      this.deactivated = true
      this.mounted = false
      this.instance = null
    },
    getHeadToHeight() {
      return this.instance?.headToHeight || null
    },
    disableRateCheck() {},
    get height() {
      return this.instance?.height || null
    },
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
    base: {
      children: [],
      // a node added is mounted at once, as an Avatar from the loader's toNodes() is (it carries its factory)
      add(node) {
        node.parent = this
        this.children.push(node)
        node.mounted = true
        node.instance = { headToHeight: 1.6, height: 1.8 }
        p.installed = node
      },
      remove(node) {
        const index = this.children.indexOf(node)
        if (index === -1) return
        node.deactivate()
        node.parent = null
        this.children.splice(index, 1)
      },
    },
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
  // the heights are read from the avatar once it is mounted (before that it has none)
  assert.equal(shown.p.nametag.position.y, 1.6 + 0.2)
  assert.equal(shown.p.bubble.position.y, 1.6 + 0.2)
  if (Cls === m.PlayerLocal) assert.equal(shown.p.camHeight, 1.8 * 0.9)
  return shown
}

// The engine's own nodes: the player's base is a real group node, mounted in a minimal world as the player's init
// mounts it
function realPlayer(Cls) {
  const shown = player(Cls, 'https://example.com/a.vrm')
  const world = shown.p.world
  world.stage = { dirtyNodes: new Set() }
  world.hot = new Set()
  world.setHot = (item, hot) => (hot ? world.hot.add(item) : world.hot.delete(item))
  world.avatars = new Set()
  world.avatars.remove = world.avatars.delete
  shown.p.base = m.createNode('group')
  shown.p.base.activate({ world, entity: shown.p })
  shown.world = world
  // the avatars mounted under the player
  shown.mounted = () => shown.p.base.children.filter(node => node.name === 'avatar' && node.mounted)
  return shown
}

// an avatar file as the client loader gives it (buildAvatarResult): one real Avatar node that carries its factory,
// cloned by toNodes(); `made` lists the avatar nodes it handed out. `fails`: the factory's create throws; `instance`:
// properties of the instance create returns, over a working one with these heights.
function avatarFile({ fails = false, headToHeight = 1.5, height = 1.7, instance = {} } = {}) {
  const factory = {
    create() {
      if (fails) throw new Error('this avatar cannot be made')
      return Object.defineProperties(
        {
          height,
          headToHeight,
          destroyed: false,
          setEmote() {},
          setVisible(visible) {
            this.visible = visible
          },
          disableRateCheck() {
            this.rateCheck = false
          },
          move() {},
          destroy() {
            this.destroyed = true
          },
        },
        Object.getOwnPropertyDescriptors(instance)
      )
    },
  }
  const root = m.createNode('group', { id: '$root' })
  root.add(m.createNode('avatar', { id: 'avatar', factory, hooks: {} }))
  const file = {
    made: [],
    toNodes() {
      const clone = root.clone(true)
      file.made.push(clone.get('avatar'))
      return clone
    },
  }
  return file
}

// nothing may be left unhandled (a mount's rejection is one: Node.activate does not keep the promise)
function noUnhandled(t) {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  return unhandled
}

// a real player who shows avatar A, a real Avatar node
async function showingReal(Cls) {
  const shown = realPlayer(Cls)
  const file = avatarFile()
  shown.p.applyAvatar()
  shown.loads['https://example.com/a.vrm'].with(file)
  await tick()
  shown.a = file.made[0]
  assert.equal(shown.p.avatar, shown.a)
  assert.ok(shown.a.instance, 'A is mounted, with an instance')
  assert.deepEqual(shown.mounted(), [shown.a])
  assert.deepEqual([...shown.world.avatars], [shown.a.instance])
  // the heights are read from the mounted avatar
  assert.equal(shown.p.nametag.position.y, 1.5 + 0.2)
  assert.equal(shown.p.bubble.position.y, 1.5 + 0.2)
  if (Cls === m.PlayerLocal) assert.equal(shown.p.camHeight, 1.7 * 0.9)
  return shown
}

// what a real player who shows A must still have after a new avatar failed
function assertStillShowingA(shown, candidate, label) {
  const { p, a, loads, world } = shown
  const instance = a.instance
  assert.equal(p.avatar, a, `${label}: A is still the player's avatar`)
  assert.equal(p.avatarUrl, 'https://example.com/a.vrm', label)
  assert.equal(a.mounted, true, `${label}: and still mounted`)
  assert.ok(instance && !instance.destroyed, label)
  assert.deepEqual(shown.mounted(), [a], `${label}: the only avatar mounted`)
  assert.equal(candidate.mounted, false, `${label}: the new one is not mounted`)
  assert.equal(p.base.children.includes(candidate), false, `${label}: nor under the player`)
  assert.deepEqual([...world.avatars], [instance], `${label}: only A's instance is in the world`)
  assert.deepEqual([...world.hot], [instance], label)
  assert.equal(p.nametag.position.y, 1.5 + 0.2, `${label}: the name stays where A puts it`)
  assert.equal(p.bubble.position.y, 1.5 + 0.2, label)
  if (p instanceof m.PlayerLocal) assert.equal(p.camHeight, 1.7 * 0.9, label)
  assert.equal(p.avatarFallback, null, `${label}: no fallback over it`)
  assert.equal(loads[m.BUILTIN_AVATAR_URL], undefined, label)
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

  if (name === 'PlayerLocal') {
    // the server tells the player's own client every session avatar it takes, the ones that client set included
    // (ServerNetwork onEntityModified): the value the client already has is no change
    test('PlayerLocal: the session avatar it already has, told back, changes nothing', async () => {
      const { p, loads } = player(m[name], 'asset://mine.vrm')
      const started = []
      const load = p.world.loader.load
      p.world.loader.load = (type, url) => (started.push(url), load(type, url))
      p.world.network = { send() {} }
      // a load in progress keeps going and is the one installed
      p.setSessionAvatar('https://example.com/s.vrm')
      const first = loads['https://example.com/s.vrm']
      p.modify({ sessionAvatar: 'https://example.com/s.vrm' })
      first.finish()
      await tick()
      assert.equal(p.installed?.url, 'https://example.com/s.vrm')
      // after a failure on the built-in avatar, the failing avatar gets no new try
      p.fallBackToDefaultAvatar()
      loads[m.BUILTIN_AVATAR_URL].finish()
      await tick()
      assert.equal(p.avatarFallback, 'ready')
      p.modify({ sessionAvatar: 'https://example.com/s.vrm' })
      assert.equal(p.avatarFallback, 'ready')
      assert.equal(p.installed.url, m.BUILTIN_AVATAR_URL)
      assert.deepEqual(started, ['https://example.com/s.vrm', m.BUILTIN_AVATAR_URL])
      // a value it does not have is a change, and no session avatar is the same whichever way it is said
      p.modify({ sessionAvatar: null })
      assert.equal(p.avatarFallback, null)
      assert.deepEqual(started.slice(2), ['asset://mine.vrm'])
      p.modify({ sessionAvatar: '' })
      assert.equal(started.length, 3)
    })
  }

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
    const { p } = player(m[name], 'https://example.com/b.vrm')
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

  test(`${name}, real nodes: an avatar whose mount fails leaves the one showing; one that mounts takes its place`, async t => {
    quiet(t)
    const unhandled = noUnhandled(t)
    const shown = await showingReal(m[name])
    const { p, loads, a } = shown
    const broken = avatarFile({ fails: true })
    p.modify({ avatar: 'https://example.com/b.vrm' })
    loads['https://example.com/b.vrm'].with(broken)
    await tick()
    await tick()
    assert.equal(broken.made.length, 1, 'B was made')
    assertStillShowingA(shown, broken.made[0], 'B failed to mount')
    assert.deepEqual(unhandled, [], 'its rejection is handled')

    // an avatar that mounts: it takes A's place, and A goes
    const working = avatarFile({ headToHeight: 1.2, height: 1.4 })
    const instance = a.instance
    p.modify({ avatar: 'https://example.com/c.vrm' })
    loads['https://example.com/c.vrm'].with(working)
    await tick()
    const c = working.made[0]
    assert.equal(p.avatar, c)
    assert.equal(p.avatarUrl, 'https://example.com/c.vrm')
    assert.deepEqual(shown.mounted(), [c])
    assert.equal(a.mounted, false)
    assert.equal(instance.destroyed, true, "A's instance left the world")
    assert.deepEqual([...shown.world.avatars], [c.instance])
    assert.equal(p.nametag.position.y, 1.2 + 0.2, 'heights from the mounted C')
    assert.equal(p.bubble.position.y, 1.2 + 0.2)
    if (name === 'PlayerLocal') {
      assert.equal(p.camHeight, 1.4 * 0.9)
      assert.equal(c.instance.rateCheck, false, 'the local avatar runs at full rate')
    }
    assert.deepEqual(unhandled, [])
  })

  test(`${name}, real nodes: a failure after the new avatar was placed takes it out again and leaves the player as it was`, async t => {
    quiet(t)
    const unhandled = noUnhandled(t)
    const failures = {
      'its head height cannot be read': () =>
        avatarFile({
          instance: {
            get headToHeight() {
              throw new Error('no head')
            },
          },
        }),
      'the bubble cannot be moved': p => {
        // the name moves first, then the bubble refuses: the name is put back
        const position = p.bubble.position
        const y = position.y
        Object.defineProperty(position, 'y', {
          configurable: true,
          get: () => y,
          set: value => {
            if (value !== y) throw new Error('the bubble cannot move')
          },
        })
        return avatarFile({ headToHeight: 1.1 })
      },
    }
    for (const [label, makeFile] of Object.entries(failures)) {
      const shown = await showingReal(m[name])
      const { p, loads } = shown
      const file = makeFile(p)
      p.modify({ avatar: 'https://example.com/b.vrm' })
      loads['https://example.com/b.vrm'].with(file)
      await tick()
      assert.equal(file.made.length, 1, `${label}: B was made`)
      assert.ok(file.made[0].instance === null, `${label}: and its instance is gone`)
      assertStillShowingA(shown, file.made[0], label)
      assert.deepEqual(unhandled, [], label)
    }
  })
}

test('PlayerLocal: choosing a session avatar is a new choice: a retry for the one before it does nothing', async t => {
  const timers = quiet(t)
  const { p, loads, started } = await showing(m.PlayerLocal)
  p.world.network = { send() {} }
  p.setSessionAvatar('https://example.com/b.vrm')
  loads['https://example.com/b.vrm'].fail(busyError())
  await tick()
  assert.equal(timers.length, 1, 'B is to be asked for again')
  // the same avatar chosen again: its own load, its own chance
  p.setSessionAvatar('https://example.com/b.vrm')
  assert.equal(started['https://example.com/b.vrm'], 2)
  timers.shift()()
  assert.equal(started['https://example.com/b.vrm'], 2, 'the retry of the first choice does nothing')
  loads['https://example.com/b.vrm'].fail(busyError())
  await tick()
  assert.equal(timers.length, 1, 'the second choice has its own retry')
  timers.shift()()
  assert.equal(started['https://example.com/b.vrm'], 3)
})

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
