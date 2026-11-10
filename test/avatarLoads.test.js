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
    export { BUILTIN_AVATAR_URL } from './src/core/extras/playerAvatarFallback'
  `)
  m = await import(bundle.url)
})
after(() => bundle?.destroy())

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function avatarNode(url) {
  return {
    url,
    deactivated: false,
    deactivate() {
      this.deactivated = true
    },
    getHeadToHeight: () => 1.6,
    disableRateCheck() {},
    height: 1.8,
  }
}

// a player of the given class with the state applyAvatar uses; loads[url] finishes that load
function player(Cls, avatar) {
  const loads = {}
  const p = Object.create(Cls.prototype)
  Object.assign(p, {
    data: { id: 'p', avatar, sessionAvatar: null },
    world: {
      loader: {
        load: (_type, url) =>
          new Promise((resolve, reject) => {
            loads[url] = { finish: () => resolve({ toNodes: () => ({ get: () => avatarNode(url) }) }), fail: reject }
          }),
      },
    },
    base: { add: node => (p.installed = node) },
    nametag: { position: {}, active: false },
    bubble: { position: {}, active: false },
  })
  return { p, loads }
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
}
